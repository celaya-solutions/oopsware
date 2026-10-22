import {
  isAbsent64,
  SquashfsFormatError,
  SquashfsUnsupportedError,
  u16,
  u32,
  u64,
} from "./format.js";

/** Bytes of the version 4.0 superblock at offset 0. */
export const SUPERBLOCK_BYTES = 96;

/** "hsqs" read little-endian; "sqsh" is the big-endian magic of versions up to 3.x. */
const MAGIC = 0x7371_7368;
const BIG_ENDIAN_MAGIC = 0x6873_7173;

const COMPRESSORS: Readonly<Record<number, SquashfsCompression>> = {
  1: "gzip",
  2: "lzma",
  3: "lzo",
  4: "xz",
  5: "lz4",
  6: "zstd",
};

/** Superblock flag bits (squashfs_fs.h) and the names reported for them. */
export const SUPERBLOCK_FLAGS = {
  "uncompressed-inodes": 0x0001,
  "uncompressed-data": 0x0002,
  check: 0x0004,
  "uncompressed-fragments": 0x0008,
  "no-fragments": 0x0010,
  "always-fragments": 0x0020,
  duplicates: 0x0040,
  exportable: 0x0080,
  "uncompressed-xattrs": 0x0100,
  "no-xattrs": 0x0200,
  "compressor-options": 0x0400,
  "uncompressed-ids": 0x0800,
} as const;

export type SquashfsCompression =
  | "gzip"
  | "lzma"
  | "lzo"
  | "xz"
  | "lz4"
  | "zstd"
  | `unknown-${number}`;

export interface SquashfsSuperblock {
  readonly version: string;
  readonly compression: SquashfsCompression;
  readonly block_size: number;
  readonly block_log: number;
  readonly inode_count: number;
  readonly fragment_count: number;
  readonly id_count: number;
  readonly mkfs_time: number;
  readonly bytes_used: number;
  /** Names of the set flag bits; an unnamed bit is reported as `flag-0x...`. */
  readonly flags: readonly string[];
  readonly tables: {
    readonly inode: number;
    readonly directory: number;
    readonly fragment: number | null;
    readonly export: number | null;
    readonly id: number;
    readonly xattr: number | null;
  };
}

/** The raw root inode reference, kept beside the reported superblock. */
export interface ParsedSuperblock {
  readonly superblock: SquashfsSuperblock;
  readonly flagBits: number;
  readonly rootInode: { readonly block: number; readonly offset: number };
}

const flagNames = (bits: number): string[] => {
  const names: string[] = [];
  let known = 0;
  for (const [name, bit] of Object.entries(SUPERBLOCK_FLAGS)) {
    known |= bit;
    if ((bits & bit) !== 0) names.push(name);
  }
  for (let bit = 1; bit <= 0x8000; bit <<= 1)
    if ((bits & bit) !== 0 && (known & bit) === 0)
      names.push(`flag-0x${bit.toString(16).padStart(4, "0")}`);
  return names;
};

/** The magic and version; anything but little-endian 4.0 is refused. */
const checkVersion = (bytes: Uint8Array): string => {
  const magic = u32(bytes, 0);
  if (magic === BIG_ENDIAN_MAGIC) {
    const version = `${String(((bytes[28] ?? 0) << 8) | (bytes[29] ?? 0))}.${String(((bytes[30] ?? 0) << 8) | (bytes[31] ?? 0))}`;
    throw new SquashfsUnsupportedError(
      `version ${version}`,
      `Big-endian SquashFS ${version} is not read; only little-endian 4.0 is.`,
    );
  }
  if (magic !== MAGIC)
    throw new SquashfsFormatError(
      0,
      'The image does not start with the SquashFS magic "hsqs".',
    );
  const version = `${String(u16(bytes, 28))}.${String(u16(bytes, 30))}`;
  if (version !== "4.0")
    throw new SquashfsUnsupportedError(
      `version ${version}`,
      `SquashFS ${version} is not read; only 4.0 is.`,
    );
  return version;
};

/** Table offsets, each inside the filesystem; the inode table first, the directory table before every later one. */
const readTableOffsets = (
  bytes: Uint8Array,
  bytesUsed: number,
): SquashfsSuperblock["tables"] => {
  const optional = (at: number, name: string): number | null => {
    if (isAbsent64(bytes, at)) return null;
    const start = u64(bytes, at);
    if (start < SUPERBLOCK_BYTES || start >= bytesUsed)
      throw new SquashfsFormatError(
        at,
        `The ${name} table offset ${String(start)} is outside the filesystem (${String(bytesUsed)} bytes used).`,
      );
    return start;
  };
  const required = (at: number, name: string): number => {
    const start = optional(at, name);
    if (start === null)
      throw new SquashfsFormatError(at, `The ${name} table is absent.`);
    return start;
  };
  const tables = {
    inode: required(64, "inode"),
    directory: required(72, "directory"),
    fragment: optional(80, "fragment"),
    export: optional(88, "export"),
    id: required(48, "id"),
    xattr: optional(56, "xattr id"),
  };
  if (tables.inode >= tables.directory)
    throw new SquashfsFormatError(
      64,
      `The inode table (${String(tables.inode)}) does not start before the directory table (${String(tables.directory)}).`,
    );
  for (const [name, start] of [
    ["fragment", tables.fragment],
    ["export", tables.export],
    ["id", tables.id],
    ["xattr id", tables.xattr],
  ] as const)
    if (start !== null && start < tables.directory)
      throw new SquashfsFormatError(
        start,
        `The ${name} table (${String(start)}) starts inside the directory table (${String(tables.directory)}).`,
      );
  return tables;
};

/**
 * Parse and check a version 4.0 superblock against an image of `size`
 * bytes. Compressor support is not judged here, so a caller can still
 * report the superblock of an image whose compressor is not decoded.
 */
export const parseSquashfsSuperblock = (
  bytes: Uint8Array,
  size: number,
): ParsedSuperblock => {
  if (bytes.length < SUPERBLOCK_BYTES || size < SUPERBLOCK_BYTES)
    throw new SquashfsFormatError(
      0,
      `A SquashFS superblock needs ${String(SUPERBLOCK_BYTES)} bytes; the image has ${String(Math.min(size, bytes.length))}.`,
    );
  const version = checkVersion(bytes);
  const blockSize = u32(bytes, 12);
  const blockLog = u16(bytes, 22);
  if (
    blockSize < 4096 ||
    blockSize > 1024 * 1024 ||
    blockLog > 20 ||
    1 << blockLog !== blockSize
  )
    throw new SquashfsFormatError(
      12,
      `Block size ${String(blockSize)} with log ${String(blockLog)} is not a power of two from 4 KiB to 1 MiB.`,
    );
  const bytesUsed = u64(bytes, 40);
  if (bytesUsed > size || bytesUsed < SUPERBLOCK_BYTES)
    throw new SquashfsFormatError(
      40,
      `The superblock says the filesystem uses ${String(bytesUsed)} bytes, but the image has ${String(size)}.`,
    );
  const flagBits = u16(bytes, 24);
  const compressionId = u16(bytes, 20);
  const rootReference = u64(bytes, 32);
  return {
    superblock: {
      version,
      compression: COMPRESSORS[compressionId] ?? `unknown-${compressionId}`,
      block_size: blockSize,
      block_log: blockLog,
      inode_count: u32(bytes, 4),
      fragment_count: u32(bytes, 16),
      id_count: u16(bytes, 26),
      mkfs_time: u32(bytes, 8),
      bytes_used: bytesUsed,
      flags: flagNames(flagBits),
      tables: readTableOffsets(bytes, bytesUsed),
    },
    flagBits,
    rootInode: {
      block: Math.floor(rootReference / 0x1_0000),
      offset: rootReference % 0x1_0000,
    },
  };
};
