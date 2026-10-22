import type { ZipMember } from "../../artifacts/zipMemberView.js";

/**
 * Signature material in an APK or bundle, recorded and never checked: JAR
 * signature files (v1) and the APK Signing Block that sits between the last
 * member and the ZIP central directory (v2, v3 and related blocks).
 */

/** IDs from the APK Signature Scheme documentation and apksigner's source. */
const SIGNING_BLOCK_IDS: Readonly<Record<number, string>> = {
  0x7109871a: "APK Signature Scheme v2",
  0xf05368c0: "APK Signature Scheme v3",
  0x1b93ad61: "APK Signature Scheme v3.1",
  0x42726577: "verity padding",
  0x2b09189e: "source stamp v1",
  0x6dff800d: "source stamp v2",
  0x504b4453: "dependency info",
  0x2146444e: "Google Play metadata",
};

const MAGIC = Buffer.from("APK Sig Block 42", "latin1");
const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;

export interface SigningFacts {
  readonly jar_signers: {
    readonly signature_file: string;
    readonly block_file: string | null;
    readonly block_type: "RSA" | "DSA" | "EC" | null;
  }[];
  readonly jar_manifest: boolean;
  readonly signing_block: {
    readonly offset: number;
    readonly bytes: number;
    readonly blocks: {
      readonly id: string;
      readonly name: string | null;
      readonly bytes: number;
    }[];
  } | null;
  readonly signing_block_error: string | null;
  readonly verified: false;
}

const u32 = (bytes: Uint8Array, at: number): number =>
  ((bytes[at] ?? 0) |
    ((bytes[at + 1] ?? 0) << 8) |
    ((bytes[at + 2] ?? 0) << 16) |
    ((bytes[at + 3] ?? 0) << 24)) >>>
  0;

const u64 = (bytes: Uint8Array, at: number): number => {
  const high = u32(bytes, at + 4);
  // Offsets past 2^53 cannot occur in a file this reader holds in memory.
  return high > 0x1f_ffff ? Number.NaN : high * 2 ** 32 + u32(bytes, at);
};

/** Offset of the central directory from the end-of-central-directory record (ZIP64 aware). */
const centralDirectoryOffset = (bytes: Uint8Array): number | null => {
  const earliest = Math.max(0, bytes.length - 22 - 0xffff);
  for (let at = bytes.length - 22; at >= earliest; at -= 1) {
    if (u32(bytes, at) !== EOCD) continue;
    const offset = u32(bytes, at + 16);
    if (offset !== 0xffff_ffff) return offset;
    const locator = at - 20;
    if (locator < 0 || u32(bytes, locator) !== ZIP64_LOCATOR) return null;
    const record = u64(bytes, locator + 8);
    if (
      !Number.isFinite(record) ||
      record + 56 > bytes.length ||
      u32(bytes, record) !== ZIP64_EOCD
    )
      return null;
    return u64(bytes, record + 48);
  }
  return null;
};

/** Parse the APK Signing Block before the central directory, if there is one. */
const signingBlock = (
  bytes: Uint8Array,
): Pick<SigningFacts, "signing_block" | "signing_block_error"> => {
  const directory = centralDirectoryOffset(bytes);
  if (
    directory === null ||
    !Number.isFinite(directory) ||
    directory > bytes.length
  )
    return {
      signing_block: null,
      signing_block_error:
        "The ZIP end-of-central-directory record could not be read.",
    };
  if (
    directory < 32 ||
    !MAGIC.equals(bytes.subarray(directory - 16, directory))
  )
    return { signing_block: null, signing_block_error: null };
  const size = u64(bytes, directory - 24);
  const start = directory - size - 8;
  if (
    !Number.isFinite(size) ||
    size < 24 ||
    start < 0 ||
    u64(bytes, start) !== size
  )
    return {
      signing_block: null,
      signing_block_error:
        "The APK Signing Block's two size fields disagree or point outside the file.",
    };
  const blocks: { id: string; name: string | null; bytes: number }[] = [];
  let at = start + 8;
  const end = directory - 24;
  while (at < end) {
    if (at + 12 > end)
      return {
        signing_block: { offset: start, bytes: size + 8, blocks },
        signing_block_error: `A pair at ${String(at)} is truncated.`,
      };
    const length = u64(bytes, at);
    if (!Number.isFinite(length) || length < 4 || at + 8 + length > end)
      return {
        signing_block: { offset: start, bytes: size + 8, blocks },
        signing_block_error: `The pair at ${String(at)} declares ${String(length)} bytes, past the block's end.`,
      };
    const id = u32(bytes, at + 8);
    blocks.push({
      id: `0x${id.toString(16).padStart(8, "0")}`,
      name: SIGNING_BLOCK_IDS[id] ?? null,
      bytes: length - 4,
    });
    at += 8 + length;
  }
  return {
    signing_block: { offset: start, bytes: size + 8, blocks },
    signing_block_error: null,
  };
};

/**
 * JAR signers under `prefix` (META-INF/ of an APK) and, for a whole ZIP's
 * bytes, the APK Signing Block. Pass `zipBytes` null for packages that are
 * not themselves APKs.
 */
export const readSigning = (
  members: readonly ZipMember[],
  zipBytes: Uint8Array | null,
): SigningFacts => {
  const names = new Set(members.map((member) => member.path));
  const signers = members
    .map((member) => member.path)
    .filter((path) => /^META-INF\/[^/]+\.SF$/u.test(path))
    .sort()
    .map((signature) => {
      const stem = signature.slice(0, -3);
      const type = (["RSA", "DSA", "EC"] as const).find((kind) =>
        names.has(`${stem}.${kind}`),
      );
      return {
        signature_file: signature,
        block_file: type === undefined ? null : `${stem}.${type}`,
        block_type: type ?? null,
      };
    });
  return {
    jar_signers: signers,
    jar_manifest: names.has("META-INF/MANIFEST.MF"),
    ...(zipBytes === null
      ? { signing_block: null, signing_block_error: null }
      : signingBlock(zipBytes)),
    verified: false,
  };
};
