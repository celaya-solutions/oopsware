import { createHash } from "node:crypto";

import { ByteSource } from "../artifacts/archives/ByteSource.js";
import { TarStream, type TarMember } from "../artifacts/archives/TarStream.js";
import type { ArtifactCommand } from "../domain/artifactGraph.js";
import type { LinuxPackageReport } from "../domain/linuxPackage/linuxPackage.js";
import { debLayout, readArMembers } from "./deb/ar.js";
import {
  parseConffiles,
  parseControl,
  parseMd5sums,
  parseRelations,
  parseTriggers,
  RELATION_FIELDS,
} from "./deb/control.js";
import { decodePayload } from "./decode.js";
import {
  diagnostic,
  installPath,
  modeFacts,
  positional,
  scriptRecord,
  type FileRecord,
} from "./report.js";

type Report = LinuxPackageReport;

/** The parts of the report a Debian package fills. */
export interface DebParts {
  readonly identity: Report["identity"];
  readonly dependencies: Report["dependencies"];
  readonly scripts: Report["scripts"];
  readonly triggers: Report["triggers"];
  readonly deb: NonNullable<Report["deb"]>;
  readonly files: FileRecord[];
  readonly commands: (ArtifactCommand | null)[];
  readonly diagnostics: Report["diagnostics"];
}

const MAINTAINER_SCRIPTS = ["preinst", "postinst", "prerm", "postrm", "config"];
const KNOWN_CONTROL = new Set([
  "control",
  "md5sums",
  "conffiles",
  "triggers",
  ...MAINTAINER_SCRIPTS,
]);

const TAR_TYPES: Readonly<Record<string, FileRecord["type"]>> = {
  "0": "file",
  "7": "file",
  "1": "hardlink",
  "2": "symlink",
  "3": "char-device",
  "4": "block-device",
  "5": "directory",
  "6": "fifo",
};

const once = (buffer: Buffer): AsyncIterable<Buffer> =>
  (async function* () {
    yield buffer;
  })();

const collect = async (pieces: AsyncIterable<Buffer>): Promise<Buffer> => {
  const parts: Buffer[] = [];
  for await (const piece of pieces) parts.push(piece);
  return Buffer.concat(parts);
};

/** Every member of a decoded tar, with `use` reading or skipping its data. */
const eachMember = async (
  tar: Buffer,
  use: (member: TarMember, data: () => AsyncGenerator<Buffer>) => Promise<void>,
): Promise<void> => {
  const stream = new TarStream(new ByteSource(once(tar)));
  for (;;) {
    const member = await stream.next();
    if (member === null) return;
    await use(member, () => stream.data());
  }
};

/** Debian version `[epoch:]upstream[-revision]`. */
const splitVersion = (
  value: string | null,
): Pick<Report["identity"], "version" | "release" | "epoch"> => {
  if (value === null) return { version: null, release: null, epoch: null };
  const colon = value.indexOf(":");
  const epoch =
    colon > 0 && /^\d+$/u.test(value.slice(0, colon))
      ? Number(value.slice(0, colon))
      : null;
  const rest = epoch === null ? value : value.slice(colon + 1);
  const dash = rest.lastIndexOf("-");
  return dash > 0
    ? { version: rest.slice(0, dash), release: rest.slice(dash + 1), epoch }
    : { version: rest, release: null, epoch };
};

/** Read a Debian package: ar layout, control archive, then the data archive with md5sums rechecked. */
export const readDebPackage = async (
  bytes: Uint8Array,
  limit: number,
  signal?: AbortSignal,
): Promise<DebParts> => {
  const read = positional(bytes);
  const { members, trailing_bytes } = await readArMembers(read, bytes.length);
  const first = members[0];
  const binary =
    first?.name === "debian-binary"
      ? await read(first.data_offset, Math.min(first.size, 64))
      : null;
  const layout = debLayout(members, binary);
  const diagnostics: Report["diagnostics"] = layout.problems.map((problem) =>
    diagnostic("ar", problem),
  );
  if (trailing_bytes > 0)
    diagnostics.push(
      diagnostic(
        "ar",
        `${String(trailing_bytes)} bytes follow the last member and were not read.`,
      ),
    );
  const commands: (ArtifactCommand | null)[] = [];
  const controlFiles = new Map<string, Buffer>();
  let budget = limit;
  if (layout.control !== null) {
    const member = layout.control.member;
    const decoded = await decodePayload(
      layout.control.compression,
      bytes.subarray(member.data_offset, member.data_offset + member.size),
      budget,
      signal,
    );
    budget -= decoded.bytes.length;
    commands.push(decoded.command);
    await eachMember(decoded.bytes, async (entry, data) => {
      const name = entry.name?.replace(/^(?:\.\/)+/u, "") ?? null;
      if (
        name === null ||
        name === "" ||
        !(TAR_TYPES[entry.typeflag] === "file")
      ) {
        for await (const piece of data()) void piece;
        return;
      }
      controlFiles.set(name, await collect(data()));
    });
  } else
    diagnostics.push(diagnostic("ar", "The package has no control archive."));
  const text = (name: string): string | null =>
    controlFiles.get(name)?.toString("utf8") ?? null;
  const control = parseControl(text("control") ?? "");
  diagnostics.push(
    ...control.problems.map((problem) => diagnostic("control", problem)),
  );
  const field = (name: string): string | null =>
    control.fields.find(
      (entry) => entry.name.toLowerCase() === name.toLowerCase(),
    )?.value ?? null;
  const dependencies: Report["dependencies"] = [];
  for (const name of RELATION_FIELDS) {
    const value = field(name);
    if (value === null) continue;
    const relations = parseRelations(value);
    diagnostics.push(
      ...relations.problems.map((problem) =>
        diagnostic(`control ${name}`, problem),
      ),
    );
    for (const group of relations.groups)
      dependencies.push({
        kind: name.toLowerCase(),
        alternatives: group.map((relation) => ({
          name: relation.name,
          operator: relation.version?.operator ?? null,
          version: relation.version?.version ?? null,
          architecture: relation.arch_qualifier,
          flags: [
            ...relation.architectures.map((entry) => `arch:${entry}`),
            ...relation.profiles.map((entry) => `profile:${entry}`),
          ],
        })),
        rich: false,
        text: group.map((relation) => relation.text).join(" | "),
      });
  }
  const conffiles = parseConffiles(text("conffiles") ?? "");
  const md5sums = controlFiles.has("md5sums")
    ? parseMd5sums(text("md5sums") ?? "")
    : null;
  const triggers = parseTriggers(text("triggers") ?? "");
  diagnostics.push(
    ...conffiles.problems.map((problem) => diagnostic("conffiles", problem)),
    ...(md5sums?.problems ?? []).map((problem) =>
      diagnostic("md5sums", problem),
    ),
    ...triggers.problems.map((problem) => diagnostic("triggers", problem)),
  );
  const conffileSet = new Set(conffiles.paths.map((entry) => entry.path));
  const declared = new Map(
    (md5sums?.entries ?? []).map((entry) => [
      installPath(entry.path),
      entry.md5,
    ]),
  );
  const files: FileRecord[] = [];
  const seen = new Set<string>();
  /** md5 of each regular file's bytes, for the hard links that point at it. */
  const contents = new Map<string, string>();
  let matched = 0;
  const mismatched: string[] = [];
  let unlisted = 0;
  if (layout.data !== null) {
    const member = layout.data.member;
    const decoded = await decodePayload(
      layout.data.compression,
      bytes.subarray(member.data_offset, member.data_offset + member.size),
      budget,
      signal,
    );
    commands.push(decoded.command);
    await eachMember(decoded.bytes, async (entry, data) => {
      if (entry.name === null) {
        diagnostics.push(
          diagnostic(
            "data",
            `A member name is not valid UTF-8 (bytes ${entry.rawNameHex}); it is not listed.`,
            entry.headerOffset,
          ),
        );
        for await (const piece of data()) void piece;
        return;
      }
      const path = installPath(entry.name);
      const type = TAR_TYPES[entry.typeflag] ?? "unknown";
      let digest: FileRecord["digest"] = null;
      // A tar hard link carries no bytes; its md5sums entry is checked against the file it links to.
      const linked =
        type === "hardlink" && entry.linkName !== null
          ? contents.get(installPath(entry.linkName))
          : undefined;
      if (type === "file" || linked !== undefined) {
        let computed = linked;
        if (computed === undefined) {
          const hash = createHash("md5");
          for await (const piece of data()) hash.update(piece);
          computed = hash.digest("hex");
          contents.set(path, computed);
        } else for await (const piece of data()) void piece;
        seen.add(path);
        const expected = declared.get(path);
        if (expected === undefined) unlisted += 1;
        else {
          digest = {
            algorithm: "md5",
            declared: expected,
            computed,
            valid: expected === computed,
          };
          if (expected === computed) matched += 1;
          else mismatched.push(path);
        }
      } else for await (const piece of data()) void piece;
      if (path === "/" && type === "directory") return;
      files.push({
        path,
        type,
        ...modeFacts(entry.mode),
        uid: entry.uid,
        gid: entry.gid,
        user: entry.uname,
        group: entry.gname,
        size: type === "file" ? entry.size : null,
        mtime: entry.mtime,
        link_target:
          type === "symlink" || type === "hardlink" ? entry.linkName : null,
        flags: conffileSet.has(path) ? ["conffile"] : [],
        digest,
      });
    });
  } else
    diagnostics.push(
      diagnostic(
        "ar",
        "The package has no data archive; it installs no files.",
      ),
    );
  const versioned = splitVersion(field("Version"));
  return {
    identity: {
      name: field("Package"),
      ...versioned,
      architecture: field("Architecture"),
      summary: field("Description")?.split("\n")[0]?.trim() ?? null,
    },
    dependencies,
    scripts: MAINTAINER_SCRIPTS.flatMap((name) => {
      const script = controlFiles.get(name);
      return script === undefined ? [] : [scriptRecord(name, script)];
    }),
    triggers: triggers.triggers.map((entry) => ({
      kind: entry.directive,
      condition: entry.name,
      interpreter: null,
      text: null,
    })),
    deb: {
      format_version: layout.format_version,
      members: members.map((member) => ({
        name: member.name,
        offset: member.header_offset,
        size: member.size,
      })),
      control_compression: layout.control?.compression ?? null,
      data_compression: layout.data?.compression ?? null,
      fields: control.fields.map((entry) => ({
        name: entry.name,
        value: entry.value,
      })),
      conffiles: conffiles.paths.map((entry) => entry.path),
      md5sums:
        md5sums === null
          ? null
          : {
              declared: md5sums.entries.length,
              matched,
              mismatched,
              missing: [...declared.keys()].filter((path) => !seen.has(path)),
              unlisted,
            },
      other_control_files: [...controlFiles.keys()]
        .filter((name) => !KNOWN_CONTROL.has(name))
        .sort(),
      signatures: layout.signatures.map((member) => member.name),
    },
    files,
    commands,
    diagnostics,
  };
};
