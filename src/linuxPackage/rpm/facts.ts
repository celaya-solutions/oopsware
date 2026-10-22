import { createHash } from "node:crypto";

import type { PositionalRead } from "../deb/ar.js";
import { dependencies } from "./dependencies.js";
import { files } from "./files.js";
import { HASH_ALGORITHMS } from "./flags.js";
import { RPM_HEADER_MAGIC, RpmFormatError, type RpmFile } from "./header.js";
import { scriptlets, triggers } from "./scripts.js";
import { cLocale, Reader } from "./typedReader.js";

export type RpmOperator = "<" | "<=" | "=" | ">=" | ">";

export interface RpmDependency {
  readonly name: string;
  readonly operator: RpmOperator | null;
  readonly version: string | null;
  /** RPMSENSE bits other than the comparison: "pre", "post", "interp", "rpmlib", "meta", … */
  readonly flags: readonly string[];
  readonly rich: boolean;
  /** As `rpm -qp --requires` prints it. */
  readonly text: string;
}

export type RpmScriptletName =
  | "pretrans"
  | "pre"
  | "post"
  | "preun"
  | "postun"
  | "posttrans"
  | "preuntrans"
  | "postuntrans"
  | "verify";

export interface RpmScriptlet {
  readonly name: RpmScriptletName;
  /** The PROG tag as stored: interpreter then its arguments; empty when absent. */
  readonly interpreter: readonly string[];
  readonly body: string | null;
  /** RPMSCRIPT_FLAG bits: "expand", "qformat", "critical". */
  readonly flags: readonly string[];
}

export interface RpmTrigger {
  /** triggerprein/in/un/postun, filetrigger*, transfiletrigger* */
  readonly kind: string;
  readonly conditions: readonly RpmDependency[];
  readonly interpreter: readonly string[];
  readonly body: string | null;
  readonly priority: number | null;
  readonly flags: readonly string[];
}

export interface RpmFileEntry {
  readonly path: string;
  readonly size: number;
  /** Full st_mode, file type bits included. */
  readonly mode: number;
  readonly user: string | null;
  readonly group: string | null;
  readonly mtime: number;
  /** Hex digest in the package's file digest algorithm; null when stored empty (directories, links, ghosts). */
  readonly digest: string | null;
  readonly link_target: string | null;
  /** RPMFILE bits: config, noreplace, missingok, doc, license, readme, ghost, artifact, specfile, pubkey, icon. */
  readonly flags: readonly string[];
  readonly device: number;
  readonly inode: number;
  readonly rdev: number;
  /** Regular non-ghost files sharing device and inode, as rpm counts hard links. */
  readonly links: number;
  readonly lang: string | null;
}

export interface RpmPayloadFacts {
  readonly format: string | null;
  readonly compressor: string | null;
  readonly flags: string | null;
  /** PAYLOADSHA256 (rpm 4.14+ PAYLOADDIGEST): digest of the compressed payload. */
  readonly digest: string | null;
  readonly digest_algorithm: string | null;
  /** PAYLOADSHA256ALT: digest of the uncompressed payload. */
  readonly digest_alt: string | null;
  readonly sha512: string | null;
  readonly sha512_alt: string | null;
  readonly sha3_256: string | null;
  readonly sha3_256_alt: string | null;
  /** PAYLOADSIZE / PAYLOADSIZEALT (rpm 6): compressed and uncompressed bytes. */
  readonly size: number | null;
  readonly size_alt: number | null;
}

export interface RpmDependencies {
  readonly requires: readonly RpmDependency[];
  readonly provides: readonly RpmDependency[];
  readonly conflicts: readonly RpmDependency[];
  readonly obsoletes: readonly RpmDependency[];
  readonly recommends: readonly RpmDependency[];
  readonly suggests: readonly RpmDependency[];
  readonly supplements: readonly RpmDependency[];
  readonly enhances: readonly RpmDependency[];
  readonly order_with_requires: readonly RpmDependency[];
}

export interface RpmSignatureFacts {
  readonly header_sha1: string | null;
  readonly header_sha256: string | null;
  readonly header_sha3_256: string | null;
  readonly md5: string | null;
  readonly size: number | null;
  readonly payload_size: number | null;
  /** Byte lengths of signature blobs present; never verified. */
  readonly rsa: number | null;
  readonly dsa: number | null;
  readonly pgp: number | null;
  readonly gpg: number | null;
  readonly openpgp: readonly number[];
}

export interface RpmPackageFacts {
  readonly name: string | null;
  readonly epoch: number | null;
  readonly version: string | null;
  readonly release: string | null;
  readonly arch: string | null;
  readonly os: string | null;
  readonly summary: string | null;
  readonly description: string | null;
  readonly license: string | null;
  readonly url: string | null;
  readonly bug_url: string | null;
  readonly vendor: string | null;
  readonly packager: string | null;
  readonly group: string | null;
  readonly build_time: number | null;
  readonly build_host: string | null;
  readonly source_rpm: string | null;
  readonly installed_size: number | null;
  /** RPMFORMAT: 6 for rpm 6 packages; null when the header predates the tag. */
  readonly rpm_format: number | null;
  readonly payload: RpmPayloadFacts;
  readonly dependencies: RpmDependencies;
  readonly scriptlets: readonly RpmScriptlet[];
  readonly triggers: readonly RpmTrigger[];
  readonly files: readonly RpmFileEntry[];
  readonly file_digest_algorithm: string | null;
  readonly signatures: RpmSignatureFacts;
  readonly changelog_entries: number;
  readonly problems: readonly string[];
}

const hexOf = (bytes: Uint8Array | null): string | null =>
  bytes === null ? null : Buffer.from(bytes).toString("hex");

const signatures = (reader: Reader): RpmSignatureFacts => {
  const length = (tag: number): number | null =>
    reader.bytes(tag)?.length ?? null;
  const openpgp: number[] = [];
  for (const [index, text] of (reader.strings(278) ?? []).entries()) {
    if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(text) || text.length % 4 !== 0) {
      reader.problems.push(`OPENPGP signature ${String(index)} is not base64.`);
      continue;
    }
    openpgp.push(Buffer.from(text, "base64").length);
  }
  return {
    header_sha1: reader.string(269),
    header_sha256: reader.string(273),
    header_sha3_256: reader.string(279),
    md5: hexOf(reader.bytes(1004)),
    size: reader.number(1000) ?? reader.number(270),
    payload_size: reader.number(1007) ?? reader.number(271),
    rsa: length(268),
    dsa: length(267),
    pgp: length(1002),
    gpg: length(1005),
    openpgp,
  };
};

const payload = (reader: Reader): RpmPayloadFacts => {
  const digest = reader.string(5092);
  const algorithm = reader.number(5093);
  return {
    format: reader.string(1124),
    compressor: reader.string(1125),
    flags: reader.string(1126),
    digest,
    // rpm 6 names the tag PAYLOADSHA256; the ALGO tag only exists in rpm 4.14-4.20 packages.
    digest_algorithm:
      algorithm !== null
        ? (HASH_ALGORITHMS.get(algorithm) ?? `algorithm ${String(algorithm)}`)
        : digest === null
          ? null
          : "sha256",
    digest_alt: reader.string(5097),
    sha512: reader.string(5121),
    sha512_alt: reader.string(5122),
    sha3_256: reader.string(5123),
    sha3_256_alt: reader.string(5124),
    size: reader.number(5112),
    size_alt: reader.number(5113),
  };
};

/**
 * Typed package facts from both headers; every oddity is a problem, not a
 * fix. `problems` holds the lead's problems and those found here; each
 * header keeps its own structural problems.
 */
export const rpmFacts = (file: RpmFile): RpmPackageFacts => {
  const problems: string[] = [...file.problems];
  const main = new Reader(file.header, "main", problems, cLocale(file.header));
  const signature = new Reader(file.signature, "signature", problems, 0);
  const fileDigestAlgorithm = main.number(5011);
  return {
    name: main.string(1000),
    epoch: main.number(1003),
    version: main.string(1001),
    release: main.string(1002),
    arch: main.string(1022),
    os: main.string(1021),
    summary: main.string(1004),
    description: main.string(1005),
    license: main.string(1014),
    url: main.string(1020),
    bug_url: main.string(5012),
    vendor: main.string(1011),
    packager: main.string(1015),
    group: main.string(1016),
    build_time: main.number(1006),
    build_host: main.string(1007),
    source_rpm: main.string(1044),
    installed_size: main.number(5009) ?? main.number(1009),
    rpm_format: main.number(5114),
    payload: payload(main),
    dependencies: dependencies(main),
    scriptlets: scriptlets(main),
    triggers: triggers(main),
    files: files(main),
    // rpm reads a missing FILEDIGESTALGO as MD5, the pre-4.6 file digest.
    file_digest_algorithm:
      fileDigestAlgorithm === null
        ? "md5"
        : (HASH_ALGORITHMS.get(fileDigestAlgorithm) ??
          `algorithm ${String(fileDigestAlgorithm)}`),
    signatures: signatures(signature),
    changelog_entries: main.numbers(1080)?.length ?? 0,
    problems,
  };
};

/** Header digests rpm declares in the signature header, as node:crypto names their hashes. */
const HEADER_DIGESTS: readonly (readonly [number, string, string])[] = [
  [269, "sha1", "sha1"],
  [273, "sha256", "sha256"],
  [279, "sha3-256", "sha3-256"],
];

const CHUNK_BYTES = 1024 * 1024;

/**
 * Recompute the header digests the signature header declares: rpm hashes
 * the 8-byte header magic (reserved bytes as zero) followed by the main
 * header's index count, data size, index and data store, which in a
 * package file is exactly the immutable region.
 */
export const checkHeaderDigests = async (
  file: RpmFile,
  read: PositionalRead,
): Promise<
  readonly {
    readonly algorithm: string;
    readonly declared: string;
    readonly computed: string;
    readonly valid: boolean;
  }[]
> => {
  const declared = HEADER_DIGESTS.flatMap(([tag, algorithm, hash]) => {
    const value = file.signature.entries.get(tag);
    return value !== undefined &&
      value.type === "string" &&
      value.values[0] !== undefined
      ? [{ algorithm, hash, declared: value.values[0] }]
      : [];
  });
  if (declared.length === 0) return [];
  const hashes = declared.map(({ hash }) =>
    createHash(hash).update(RPM_HEADER_MAGIC),
  );
  const start = file.header.offset + 8;
  const end = file.header.offset + file.header.length;
  for (let at = start; at < end; at += CHUNK_BYTES) {
    const length = Math.min(CHUNK_BYTES, end - at);
    const chunk = await read(at, length);
    if (chunk.length < length)
      throw new RpmFormatError(
        at,
        `Main header bytes end at ${String(at + chunk.length)} while computing its digests.`,
      );
    for (const hash of hashes) hash.update(chunk);
  }
  return declared.map(({ algorithm, declared: value }, index) => {
    const computed = hashes[index]?.digest("hex") ?? "";
    return {
      algorithm,
      declared: value,
      computed,
      valid: computed === value.toLowerCase(),
    };
  });
};
