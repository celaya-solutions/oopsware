/**
 * General archive containers and compression streams (format expansion F06),
 * Linux packages and the filesystem images AppImages carry (F05) that the
 * artifact graph records from bytes. A compression stream is a storage layer
 * of its own: `.gz` or `.xz` may carry one arbitrary file rather than a tar
 * archive.
 */
export const ARCHIVE_STREAM_FORMATS = [
  "iso",
  "tar",
  "gzip",
  "xz",
  "7z",
  "rar",
  "deb",
  "rpm",
  "squashfs",
  "appimage",
  "msi",
  "oci-image-layout",
  "oci-image-archive",
  "docker-save-archive",
] as const;
export type ArchiveStreamFormat = (typeof ARCHIVE_STREAM_FORMATS)[number];

/** Formats with a streamed member reader; RAR is identified only. */
export const READABLE_ARCHIVE_STREAM_FORMATS = [
  "iso",
  "tar",
  "gzip",
  "xz",
  "7z",
  "deb",
  "rpm",
] as const satisfies readonly ArchiveStreamFormat[];
export type ReadableArchiveStreamFormat =
  (typeof READABLE_ARCHIVE_STREAM_FORMATS)[number];

export const isArchiveStreamFormat = (
  format: string,
): format is ArchiveStreamFormat =>
  (ARCHIVE_STREAM_FORMATS as readonly string[]).includes(format);

/** Containers read by random access rather than as a stream: filesystem images (F05) and Windows Installer databases (F08). */
export const RANDOM_ACCESS_CONTAINER_FORMATS = [
  "squashfs",
  "appimage",
  "msi",
] as const satisfies readonly ArchiveStreamFormat[];
export type RandomAccessContainerFormat =
  (typeof RANDOM_ACCESS_CONTAINER_FORMATS)[number];

export const isRandomAccessContainerFormat = (
  format: string,
): format is RandomAccessContainerFormat =>
  (RANDOM_ACCESS_CONTAINER_FORMATS as readonly string[]).includes(format);

/**
 * Container images (F09): an OCI layout directory, an OCI archive or a Docker
 * save archive. Their graph members are the composed filesystem, not the
 * blobs that carry it.
 */
export const CONTAINER_IMAGE_FORMATS = [
  "oci-image-layout",
  "oci-image-archive",
  "docker-save-archive",
] as const satisfies readonly ArchiveStreamFormat[];
export type ContainerImageFormat = (typeof CONTAINER_IMAGE_FORMATS)[number];

export const isContainerImageFormat = (
  format: string,
): format is ContainerImageFormat =>
  (CONTAINER_IMAGE_FORMATS as readonly string[]).includes(format);

export const isReadableArchiveStreamFormat = (
  format: string,
): format is ReadableArchiveStreamFormat =>
  (READABLE_ARCHIVE_STREAM_FORMATS as readonly string[]).includes(format);

/** Tar header block size; every member header and data run is padded to it. */
export const TAR_BLOCK_BYTES = 512;

const startsWith = (
  bytes: Uint8Array,
  offset: number,
  magic: readonly number[],
) =>
  bytes.length >= offset + magic.length &&
  magic.every((byte, index) => bytes[offset + index] === byte);

/** ISO 9660 volume descriptors start after the 16-sector system area. */
export const ISO_DESCRIPTOR_OFFSET = 16 * 2048;
export const ISO_SIGNATURE_BYTES = ISO_DESCRIPTOR_OFFSET + 7;

/** A volume descriptor header, including boot and supplementary descriptors. */
export const hasIsoSignature = (prefix: Uint8Array): boolean =>
  (prefix[ISO_DESCRIPTOR_OFFSET] ?? 255) <= 3 &&
  startsWith(
    prefix,
    ISO_DESCRIPTOR_OFFSET + 1,
    [0x43, 0x44, 0x30, 0x30, 0x31, 1],
  );

/** 7z signature header `7z\xBC\xAF\x27\x1C`. */
export const has7zSignature = (prefix: Uint8Array): boolean =>
  startsWith(prefix, 0, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);

/** RAR 1.5-4 (`Rar!\x1A\x07\x00`) or RAR 5 (`Rar!\x1A\x07\x01\x00`) marker block. */
export const hasRarSignature = (prefix: Uint8Array): boolean =>
  startsWith(prefix, 0, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]) ||
  startsWith(prefix, 0, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]);

/** XZ stream header magic `\xFD7zXZ\x00`. */
export const hasXzSignature = (prefix: Uint8Array): boolean =>
  startsWith(prefix, 0, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]);

/** Gzip member header with the deflate method, the only method RFC 1952 defines. */
export const hasGzipSignature = (prefix: Uint8Array): boolean =>
  startsWith(prefix, 0, [0x1f, 0x8b, 0x08]);

/** An ar archive whose first member is `debian-binary`, as every Debian binary package starts. */
export const hasDebSignature = (prefix: Uint8Array): boolean =>
  startsWith(prefix, 0, [0x21, 0x3c, 0x61, 0x72, 0x63, 0x68, 0x3e, 0x0a]) &&
  startsWith(prefix, 8, [...Buffer.from("debian-binary", "latin1")]) &&
  [0x20, 0x2f].includes(prefix[21] ?? 0);

/** RPM lead magic `\xED\xAB\xEE\xDB`. */
export const hasRpmLead = (prefix: Uint8Array): boolean =>
  startsWith(prefix, 0, [0xed, 0xab, 0xee, 0xdb]);

/** Little-endian SquashFS superblock magic `hsqs`. */
export const hasSquashfsSuperblock = (prefix: Uint8Array): boolean =>
  startsWith(prefix, 0, [0x68, 0x73, 0x71, 0x73]);

/** An ELF file with the AppImage magic `AI` and a type byte in its identification padding. */
export const hasAppImageSignature = (prefix: Uint8Array): boolean =>
  startsWith(prefix, 0, [0x7f, 0x45, 0x4c, 0x46]) &&
  startsWith(prefix, 8, [0x41, 0x49]) &&
  (prefix[10] === 1 || prefix[10] === 2);

/** OLE compound file (CFB) header signature. */
export const hasCompoundFileSignature = (prefix: Uint8Array): boolean =>
  startsWith(prefix, 0, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

/**
 * File offset of the root directory entry's CLSID: the first directory
 * sector (header offset 48) times the sector size (2^shift at offset 30),
 * after the one-sector header, plus the entry's CLSID field at 80. Null when
 * the header is not a compound file or its fields are out of range.
 */
export const compoundRootClsidOffset = (prefix: Uint8Array): number | null => {
  if (!hasCompoundFileSignature(prefix) || prefix.length < 52) return null;
  const view = new DataView(
    prefix.buffer,
    prefix.byteOffset,
    prefix.byteLength,
  );
  const shift = view.getUint16(30, true);
  if (shift !== 9 && shift !== 12) return null;
  const sector = view.getUint32(48, true);
  if (sector >= 0xfffffffa) return null;
  return (sector + 1) * 2 ** shift + 80;
};

const MSI_CLSIDS: Readonly<Record<string, "msi" | "msp" | "mst">> = {
  // {000C1084-0000-0000-C000-000000000046} package, 1086 patch, 1082 transform; stored little-endian.
  "84100c0000000000c000000000000046": "msi",
  "86100c0000000000c000000000000046": "msp",
  "82100c0000000000c000000000000046": "mst",
};

/** Windows Installer role of a compound file from its root CLSID bytes, read at `offset` of `bytes`. */
export const compoundRootClass = (
  bytes: Uint8Array,
  offset: number | null,
): "msi" | "msp" | "mst" | null => {
  if (offset === null || offset + 16 > bytes.length) return null;
  return (
    MSI_CLSIDS[
      Buffer.from(bytes.subarray(offset, offset + 16)).toString("hex")
    ] ?? null
  );
};

/**
 * Whether a compound file is a Windows Installer package, reading its root
 * CLSID through `readAt` when the directory sector lies past the prefix.
 */
export const isMsiRoot = async (
  prefix: Uint8Array,
  readAt: (offset: number, length: number) => Promise<Uint8Array>,
): Promise<boolean> => {
  const offset = compoundRootClsidOffset(prefix);
  if (offset === null) return false;
  if (offset + 16 <= prefix.length)
    return compoundRootClass(prefix, offset) === "msi";
  return compoundRootClass(await readAt(offset, 16), 0) === "msi";
};

/** Parse a NUL- or space-terminated octal tar number field. */
const octalField = (block: Uint8Array, offset: number, length: number) => {
  let value = 0;
  let digits = 0;
  for (let index = offset; index < offset + length; index += 1) {
    const byte = block[index] ?? 0;
    if (byte === 0x00 || byte === 0x20) {
      if (digits > 0) break;
      continue;
    }
    if (byte < 0x30 || byte > 0x37) return null;
    value = value * 8 + (byte - 0x30);
    digits += 1;
  }
  return digits === 0 ? null : value;
};

/**
 * Whether the header checksum field matches the block's byte sum. POSIX
 * specifies unsigned bytes; some historic writers summed signed bytes, and
 * GNU tar and libarchive accept either.
 */
export const hasValidTarChecksum = (block: Uint8Array): boolean => {
  if (block.length < TAR_BLOCK_BYTES) return false;
  const declared = octalField(block, 148, 8);
  if (declared === null) return false;
  let unsigned = 0;
  let signed = 0;
  for (let index = 0; index < TAR_BLOCK_BYTES; index += 1) {
    const byte = index >= 148 && index < 156 ? 0x20 : (block[index] ?? 0);
    unsigned += byte;
    signed += byte >= 0x80 ? byte - 0x100 : byte;
  }
  return unsigned === declared || signed === declared;
};

/**
 * A POSIX ustar or GNU tar header: magic at offset 257 and a header checksum
 * that matches. Pre-POSIX v7 archives carry no magic and stay unrecognized.
 */
export const hasTarHeader = (prefix: Uint8Array): boolean =>
  (startsWith(prefix, 257, [0x75, 0x73, 0x74, 0x61, 0x72, 0x00]) ||
    startsWith(
      prefix,
      257,
      [0x75, 0x73, 0x74, 0x61, 0x72, 0x20, 0x20, 0x00],
    )) &&
  hasValidTarChecksum(prefix);

/** Classify an archive container or compression stream from leading bytes. */
export const classifyArchiveStreamBytes = (
  prefix: Uint8Array,
): ArchiveStreamFormat | undefined => {
  if (hasIsoSignature(prefix)) return "iso";
  if (hasDebSignature(prefix)) return "deb";
  if (hasRpmLead(prefix)) return "rpm";
  if (hasSquashfsSuperblock(prefix)) return "squashfs";
  if (hasAppImageSignature(prefix)) return "appimage";
  if (compoundRootClass(prefix, compoundRootClsidOffset(prefix)) === "msi")
    return "msi";
  if (has7zSignature(prefix)) return "7z";
  if (hasRarSignature(prefix)) return "rar";
  if (hasXzSignature(prefix)) return "xz";
  if (hasGzipSignature(prefix)) return "gzip";
  if (hasTarHeader(prefix)) return "tar";
  return undefined;
};
