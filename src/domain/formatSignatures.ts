import type { ArtifactNode } from "./artifactGraph.js";
import { observeMzWindowsHeader, parseDosMzHeader } from "./dosMz.js";
import { hasGodotPckHeader } from "./godotPckFormat.js";
import {
  hasBinaryPlistSignature,
  hasXmlPlistSignature,
} from "./apple/appleArchiveFormat.js";
import {
  classifyFatContainerIdentity,
  readFatContainerHeader,
  readMachoHeaderPrefixFacts,
  type FatSliceHeaderEvidence,
} from "./apple/machoContainer.js";
import { hasZipSignature } from "./zipPackageFormat.js";
import {
  classifyArchiveStreamBytes,
  ISO_SIGNATURE_BYTES,
} from "./archiveStreamFormat.js";

/**
 * Byte-signature owners. Every check reads bytes the caller already holds;
 * nothing here extracts, executes, mounts, fetches, or imports a target.
 */

/** Leading bytes read once for classification and candidate detection. */
export const FORMAT_SIGNATURE_PREFIX_BYTES = ISO_SIGNATURE_BYTES;

/** A UDIF disk image ends in a 512-byte `koly` trailer. */
export const UDIF_TRAILER_BYTES = 512;

/** XAR archives, including Apple installer packages, start with `xar!`. */
export const hasXarSignature = (prefix: Uint8Array): boolean =>
  prefix.length >= 4 &&
  prefix[0] === 0x78 &&
  prefix[1] === 0x61 &&
  prefix[2] === 0x72 &&
  prefix[3] === 0x21;

/** The first four bytes of a UDIF trailer, read at `size - 512`. */
export const hasUdifTrailer = (trailer: Uint8Array): boolean =>
  trailer.length >= 4 &&
  trailer[0] === 0x6b &&
  trailer[1] === 0x6f &&
  trailer[2] === 0x6c &&
  trailer[3] === 0x79;

/**
 * Electron ASAR starts with a size pickle whose payload is one uint32, then
 * a header pickle whose payload begins with a JSON object.
 */
export const hasAsarHeader = (prefix: Buffer): boolean => {
  if (prefix.length < 17 || prefix.readUInt32LE(0) !== 4) return false;
  const headerSize = prefix.readUInt32LE(4);
  const payloadSize = prefix.readUInt32LE(8);
  if (headerSize < 16 || payloadSize !== headerSize - 4) return false;
  const stringLength = prefix.readUInt32LE(12);
  return (
    stringLength >= 2 && stringLength <= payloadSize - 4 && prefix[16] === 0x7b
  );
};

/**
 * 0xCAFEBABE starts both a big-endian universal Mach-O and a JVM class file.
 * A fat header's next word is a small architecture count; a class file's is
 * `minor << 16 | major`, and every major version is at least 45.
 */
export const isJvmClassPrefix = (prefix: Buffer): boolean =>
  prefix.length >= 8 &&
  prefix.readUInt32BE(0) === 0xcafebabe &&
  prefix.readUInt32BE(4) >= 45;

/** Classify storage bytes independently of path names, roles, and permissions. */
export const classifyArtifactBytes = (
  prefix: Buffer,
  fileSize = prefix.length,
  fatSliceHeaders?: FatSliceHeaderEvidence,
): ArtifactNode["format"] => {
  if (hasZipSignature(prefix)) return "zip";
  const archive = classifyArchiveStreamBytes(prefix);
  if (archive !== undefined) return archive;
  if (hasGodotPckHeader(prefix)) return "godot-pck";
  if (hasBinaryPlistSignature(prefix)) return "plist";
  if (hasXmlPlistSignature(prefix)) return "plist";
  // 0xCAFEBABE also starts JVM class files; JVM tools read them, not the graph.
  if (isJvmClassPrefix(prefix)) return "unknown";
  const fatFormat = classifyFatArtifact(prefix, fileSize, fatSliceHeaders);
  if (fatFormat !== null) return fatFormat;
  if (prefix.length >= 4) {
    const magic = prefix.readUInt32BE(0);
    if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magic))
      return "mach-o";
    if (prefix.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])))
      return "elf";
  }
  if (prefix.length >= 2 && prefix[0] === 0x4d && prefix[1] === 0x5a) {
    if (
      !Number.isSafeInteger(fileSize) ||
      fileSize < prefix.length ||
      prefix.length < Math.min(fileSize, 64)
    )
      return "unknown";
    const windowsHeader = observeMzWindowsHeader(prefix, fileSize);
    if (windowsHeader.state === "signature-needed") return "unknown";
    if (windowsHeader.state === "declared") {
      const windowsOffset = windowsHeader.offset;
      if (
        windowsHeader.signature === "PE" &&
        windowsOffset >= 64 &&
        windowsOffset <= prefix.length - 4
      )
        return "pe";
      return "unknown";
    }
    if (parseDosMzHeader(prefix, fileSize).ok) return "dos-mz";
    return "unknown";
  }
  return "file";
};

const classifyFatArtifact = (
  prefix: Buffer,
  fileSize: number,
  fatSliceHeaders?: FatSliceHeaderEvidence,
): ArtifactNode["format"] | null => {
  const fatHeader =
    fatSliceHeaders?.header ?? readFatContainerHeader(prefix, fileSize);
  if (fatHeader.state === "needs-data" || fatHeader.state === "malformed")
    return "unknown";
  if (fatHeader.state === "not-fat") return null;
  const identity = classifyFatContainerIdentity(fatHeader, (offset) => {
    if (fatSliceHeaders?.sliceHeadersByOffset.has(offset) === true)
      return fatSliceHeaders.sliceHeadersByOffset.get(offset)?.magic;
    const slice = fatHeader.slices.find(
      (candidate) => candidate.offset === offset,
    );
    if (slice === undefined || offset >= prefix.length) return undefined;
    const available = Math.max(
      0,
      Math.min(slice.size, prefix.length - offset, 12),
    );
    return readMachoHeaderPrefixFacts(
      prefix.subarray(offset, offset + available),
    ).magic;
  });
  return identity.state === "mach-o" ? "mach-o-universal" : "unknown";
};
