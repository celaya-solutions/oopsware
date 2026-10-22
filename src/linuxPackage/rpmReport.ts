import { createHash, getHashes } from "node:crypto";

import { ByteSource } from "../artifacts/archives/ByteSource.js";
import type { PayloadCompression } from "../artifacts/archives/LinuxPackagePayload.js";
import type { ArtifactCommand } from "../domain/artifactGraph.js";
import type { LinuxPackageReport } from "../domain/linuxPackage/linuxPackage.js";
import {
  CpioStream,
  rpmStrippedFiles,
  type CpioStrippedLookup,
} from "./cpio.js";
import { decodePayload } from "./decode.js";
import { readRpm } from "./rpm/header.js";
import {
  checkHeaderDigests,
  rpmFacts,
  type RpmDependency,
} from "./rpm/facts.js";
import {
  diagnostic,
  installPath,
  modeFacts,
  positional,
  scriptRecord,
  typeOfMode,
  type FileRecord,
} from "./report.js";

type Report = LinuxPackageReport;

/** The parts of the report an RPM package fills. */
export interface RpmParts {
  readonly identity: Report["identity"];
  readonly dependencies: Report["dependencies"];
  readonly scripts: Report["scripts"];
  readonly triggers: Report["triggers"];
  readonly rpm: NonNullable<Report["rpm"]>;
  readonly files: FileRecord[];
  readonly commands: (ArtifactCommand | null)[];
  readonly diagnostics: Report["diagnostics"];
}

const COMPRESSORS: Readonly<Record<string, PayloadCompression>> = {
  gzip: "gzip",
  zstd: "zstd",
  xz: "xz",
  lzma: "lzma",
  bzip2: "bzip2",
  identity: "none",
};

/** Node digest name for an RPM algorithm name, or null when Node has none. */
const hashName = (algorithm: string | null): string | null => {
  if (algorithm === null) return null;
  const name = algorithm.toLowerCase();
  return getHashes().includes(name) ? name : null;
};

const once = (buffer: Buffer): AsyncIterable<Buffer> =>
  (async function* () {
    yield buffer;
  })();

const dependencyRecord = (
  kind: string,
  dependency: RpmDependency,
): Report["dependencies"][number] => ({
  kind,
  alternatives: [
    {
      name: dependency.name,
      operator: dependency.operator,
      version: dependency.version,
      architecture: null,
      flags: [...dependency.flags],
    },
  ],
  rich: dependency.rich,
  text: dependency.text,
});

/** Digest every regular file of the cpio payload with the header's file digest algorithm, by inode. */
const payloadDigests = async (
  payload: Buffer,
  algorithm: string,
  lookup: CpioStrippedLookup,
): Promise<Map<string, string>> => {
  const byPath = new Map<string, string>();
  const cpio = new CpioStream(new ByteSource(once(payload)), lookup);
  for (;;) {
    const member = await cpio.next();
    if (member === null) return byPath;
    const mode =
      member.mode ??
      (member.fileIndex === null
        ? null
        : (lookup(member.fileIndex)?.mode ?? null));
    const regular = mode !== null && (mode & 0o170000) === 0o100000;
    if (!regular || member.name === null || member.size === 0) {
      for await (const piece of cpio.data()) void piece;
      continue;
    }
    const hash = createHash(algorithm);
    for await (const piece of cpio.data()) hash.update(piece);
    byPath.set(installPath(member.name), hash.digest("hex"));
  }
};

/** Read an RPM: lead, signature and main header, header and payload digests, scriptlets and files. */
export const readRpmPackage = async (
  bytes: Uint8Array,
  limit: number,
  signal?: AbortSignal,
): Promise<RpmParts> => {
  const read = positional(bytes);
  const file = await readRpm(read, bytes.length);
  const facts = rpmFacts(file);
  const diagnostics: Report["diagnostics"] = [
    ...file.signature.problems.map((problem) =>
      diagnostic("signature header", problem),
    ),
    ...file.header.problems.map((problem) => diagnostic("header", problem)),
    ...facts.problems.map((problem) => diagnostic("header", problem)),
  ];
  const commands: (ArtifactCommand | null)[] = [];
  const payloadBytes = bytes.subarray(file.payload_offset);
  const payloadHash = hashName(facts.payload.digest_algorithm);
  const payloadActual =
    payloadHash === null
      ? null
      : createHash(payloadHash).update(payloadBytes).digest("hex");
  const payloadDigest: NonNullable<Report["rpm"]>["payload"]["digest"] =
    facts.payload.digest === null
      ? null
      : {
          algorithm: facts.payload.digest_algorithm ?? "unknown",
          declared: facts.payload.digest,
          computed: payloadActual,
          valid:
            payloadActual === null
              ? null
              : payloadActual === facts.payload.digest,
        };
  if (payloadDigest?.valid === false)
    diagnostics.push(
      diagnostic(
        "payload",
        "The payload digest does not match the payload bytes.",
        file.payload_offset,
      ),
    );
  const fileHash = hashName(facts.file_digest_algorithm);
  let computed = new Map<string, string>();
  const compression = COMPRESSORS[facts.payload.compressor ?? "gzip"];
  if ((facts.payload.format ?? "cpio") !== "cpio" || compression === undefined)
    diagnostics.push(
      diagnostic(
        "payload",
        `The ${facts.payload.format ?? "cpio"} payload compressed with ${facts.payload.compressor ?? "gzip"} is not decoded; file digests are declared only.`,
      ),
    );
  else if (
    fileHash !== null &&
    facts.files.some((entry) => entry.digest !== null && entry.digest !== "")
  ) {
    const decoded = await decodePayload(
      compression,
      payloadBytes,
      limit,
      signal,
    );
    commands.push(decoded.command);
    computed = await payloadDigests(
      decoded.bytes,
      fileHash,
      rpmStrippedFiles(facts.files),
    );
  }
  // A hard link's bytes travel with one of its links; every link shares the inode's digest.
  const byInode = new Map<number, string>();
  for (const entry of facts.files) {
    const digest = computed.get(entry.path);
    if (digest !== undefined) byInode.set(entry.inode, digest);
  }
  const files: FileRecord[] = facts.files.map((entry) => {
    const type = typeOfMode(entry.mode);
    const declared =
      entry.digest === null || entry.digest === "" ? null : entry.digest;
    const actual =
      type === "file" && !entry.flags.includes("ghost")
        ? (computed.get(entry.path) ??
          (entry.links > 1 ? byInode.get(entry.inode) : undefined) ??
          null)
        : null;
    return {
      path: entry.path,
      type,
      ...modeFacts(entry.mode),
      uid: null,
      gid: null,
      user: entry.user,
      group: entry.group,
      size: type === "file" ? entry.size : null,
      mtime: entry.mtime,
      link_target: entry.link_target,
      flags: [...entry.flags],
      digest:
        declared === null
          ? null
          : {
              algorithm: facts.file_digest_algorithm ?? "unknown",
              declared,
              computed: actual,
              valid: actual === null ? null : actual === declared,
            },
    };
  });
  for (const entry of files)
    if (entry.digest?.valid === false)
      diagnostics.push(
        diagnostic(
          entry.path,
          "The file's bytes do not match its declared digest.",
        ),
      );
  const headerDigests = await checkHeaderDigests(file, read);
  for (const entry of headerDigests)
    if (!entry.valid)
      diagnostics.push(
        diagnostic(
          "header",
          `The ${entry.algorithm} header digest does not match the header bytes.`,
        ),
      );
  const dependencies = (
    Object.entries(facts.dependencies) as [string, readonly RpmDependency[]][]
  ).flatMap(([kind, list]) =>
    list.map((entry) => dependencyRecord(kind.replaceAll("_", "-"), entry)),
  );
  const signatures = facts.signatures;
  return {
    identity: {
      name: facts.name,
      version: facts.version,
      release: facts.release,
      epoch: facts.epoch,
      architecture: facts.arch,
      summary: facts.summary,
    },
    dependencies,
    scripts: facts.scriptlets.map((scriptlet) =>
      scriptRecord(
        scriptlet.name,
        Buffer.from(scriptlet.body ?? "", "utf8"),
        scriptlet.interpreter.length === 0
          ? null
          : scriptlet.interpreter.join(" "),
      ),
    ),
    triggers: facts.triggers.map((trigger) => ({
      kind: trigger.kind,
      condition: trigger.conditions
        .map((condition) => condition.text)
        .join(", "),
      interpreter:
        trigger.interpreter.length === 0 ? null : trigger.interpreter.join(" "),
      text: trigger.body,
    })),
    rpm: {
      lead: {
        version: `${String(file.lead.major)}.${String(file.lead.minor)}`,
        type: String(file.lead.type),
        name: file.lead.name,
      },
      license: facts.license,
      url: facts.url,
      vendor: facts.vendor,
      packager: facts.packager,
      group: facts.group,
      build_time: facts.build_time,
      build_host: facts.build_host,
      source_rpm: facts.source_rpm,
      installed_size: facts.installed_size,
      description: facts.description,
      payload: {
        format: facts.payload.format,
        compressor: facts.payload.compressor,
        flags: facts.payload.flags,
        digest: payloadDigest,
      },
      header_digests: headerDigests.map((entry) => ({
        algorithm: entry.algorithm,
        declared: entry.declared,
        computed: entry.computed,
        valid: entry.valid,
      })),
      file_digest_algorithm: facts.file_digest_algorithm,
      signatures: [
        ...(["rsa", "dsa", "pgp", "gpg"] as const).flatMap((tag) => {
          const length = signatures[tag];
          return length === null ? [] : [{ tag, bytes: length }];
        }),
        ...signatures.openpgp.map((length) => ({
          tag: "openpgp",
          bytes: length,
        })),
      ],
      changelog_entries: facts.changelog_entries,
    },
    files,
    commands,
    diagnostics,
  };
};
