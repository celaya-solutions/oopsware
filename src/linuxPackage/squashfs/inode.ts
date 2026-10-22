import {
  METADATA_BYTES,
  SquashfsFormatError,
  u16,
  u32,
  u64,
} from "./format.js";
import type { MetadataCursor, MetadataReader } from "./metadata.js";

/** A file's tail is not in a fragment (SQUASHFS_INVALID_FRAG). */
const NO_FRAGMENT = 0xffff_ffff;
/** The inode has no xattrs (SQUASHFS_INVALID_XATTR). */
const NO_XATTR = 0xffff_ffff;
/** Linux PATH_MAX; the kernel refuses longer symlink targets. */
const MAXIMUM_SYMLINK_BYTES = 4096;

/** Entry kinds by basic inode type 1..7; extended types 8..14 are the same kinds. */
export const INODE_KINDS = [
  "directory",
  "file",
  "symlink",
  "block-device",
  "char-device",
  "fifo",
  "socket",
] as const;

export type InodeKind = (typeof INODE_KINDS)[number];

/** An inode's place: a metadata block offset relative to the inode table, and a byte in its data. */
export interface InodeReference {
  readonly block: number;
  readonly offset: number;
}

/** Byte range a table's metadata blocks occupy. */
export interface TableRange {
  readonly start: number;
  readonly end: number;
}

interface InodeCommon {
  /** Stored type 1..14. */
  readonly type: number;
  readonly mode: number;
  readonly uid_index: number;
  readonly gid_index: number;
  readonly mtime: number;
  readonly number: number;
  readonly nlink: number;
  readonly xattr: number | null;
  /** Absolute offset of the metadata block that starts the inode. */
  readonly position: number;
}

export interface DirectoryInode extends InodeCommon {
  readonly kind: "directory";
  /** Listing location: block relative to the directory table, byte in its data, bytes of headers and entries. */
  readonly listing: {
    readonly block: number;
    readonly offset: number;
    readonly size: number;
  };
}

export interface FileInode extends InodeCommon {
  readonly kind: "file";
  readonly size: number;
  /** Absolute offset of the first data block. */
  readonly blocks_start: number;
  readonly fragment: number | null;
  readonly fragment_offset: number;
  /** Entries in the block list: whole blocks, plus the partial last block when no fragment holds the tail. */
  readonly block_count: number;
  /** Where the block list (u32 per block) starts in the inode table. */
  readonly block_list: MetadataCursor;
}

export interface SymlinkInode extends InodeCommon {
  readonly kind: "symlink";
  readonly target: Uint8Array;
}

export interface DeviceInode extends InodeCommon {
  readonly kind: "block-device" | "char-device";
  readonly major: number;
  readonly minor: number;
}

export interface IpcInode extends InodeCommon {
  readonly kind: "fifo" | "socket";
}

export type Inode =
  | DirectoryInode
  | FileInode
  | SymlinkInode
  | DeviceInode
  | IpcInode;

/** Fixed bytes after the 16-byte common header, by stored type. */
const FIXED_BYTES: Readonly<Record<number, number>> = {
  1: 16,
  2: 16,
  3: 8,
  4: 8,
  5: 8,
  6: 4,
  7: 4,
  8: 24,
  9: 40,
  10: 8,
  11: 12,
  12: 12,
  13: 8,
  14: 8,
};

const xattrIndex = (value: number): number | null =>
  value === NO_XATTR ? null : value;

const safe64 = (
  bytes: Uint8Array,
  at: number,
  what: string,
  position: number,
): number => {
  const value = u64(bytes, at);
  if (value > Number.MAX_SAFE_INTEGER)
    throw new SquashfsFormatError(
      position,
      `${what} ${String(value)} is beyond any image.`,
    );
  return value;
};

type Common = Omit<InodeCommon, "nlink" | "xattr">;

/** The parts of one inode read so far: common header, fixed body, and where the body ends. */
interface Parts {
  readonly common: Common;
  readonly body: Uint8Array;
  readonly next: MetadataCursor;
  readonly extended: boolean;
}

const directoryInode = ({ common, body, extended }: Parts): DirectoryInode => {
  const fileSize = extended ? u32(body, 4) : u16(body, 8);
  // A directory's file_size counts its listing plus 3 bytes for "." and "..".
  if (fileSize < 3)
    throw new SquashfsFormatError(
      common.position,
      `Directory inode ${String(common.number)} has size ${String(fileSize)}, below 3.`,
    );
  return {
    ...common,
    kind: "directory",
    nlink: extended ? u32(body, 0) : u32(body, 4),
    xattr: extended ? xattrIndex(u32(body, 20)) : null,
    listing: {
      block: extended ? u32(body, 8) : u32(body, 0),
      offset: extended ? u16(body, 18) : u16(body, 10),
      size: fileSize - 3,
    },
  };
};

const fileInode = (
  { common, body, next, extended }: Parts,
  blockSize: number,
): FileInode => {
  const size = extended
    ? safe64(body, 8, "File size", common.position)
    : u32(body, 12);
  const fragmentField = extended ? u32(body, 28) : u32(body, 4);
  const fragment = fragmentField === NO_FRAGMENT ? null : fragmentField;
  return {
    ...common,
    kind: "file",
    nlink: extended ? u32(body, 24) : 1,
    xattr: extended ? xattrIndex(u32(body, 36)) : null,
    size,
    blocks_start: extended
      ? safe64(body, 0, "Data start", common.position)
      : u32(body, 0),
    fragment,
    fragment_offset: extended ? u32(body, 32) : u32(body, 8),
    block_count:
      fragment === null
        ? Math.ceil(size / blockSize)
        : Math.floor(size / blockSize),
    block_list: next,
  };
};

const symlinkInode = async (
  { common, body, next, extended }: Parts,
  metadata: MetadataReader,
  table: TableRange,
): Promise<SymlinkInode> => {
  const length = u32(body, 4);
  if (length > MAXIMUM_SYMLINK_BYTES)
    throw new SquashfsFormatError(
      common.position,
      `Symlink target of ${String(length)} bytes is longer than ${String(MAXIMUM_SYMLINK_BYTES)}.`,
    );
  const target = await metadata.read(next, length, table.end, "symlink target");
  // The extended symlink's xattr index follows the target.
  const xattr = extended
    ? u32((await metadata.read(target.next, 4, table.end, "inode")).bytes, 0)
    : NO_XATTR;
  return {
    ...common,
    kind: "symlink",
    nlink: u32(body, 0),
    xattr: xattrIndex(xattr),
    target: target.bytes.slice(),
  };
};

const deviceInode = ({ common, body, extended }: Parts): DeviceInode => {
  // mksquashfs stores rdev as (major << 8) | (minor & 0xff) | ((minor & ~0xff) << 12), the kernel's new_encode_dev.
  const rdev = u32(body, 4);
  return {
    ...common,
    kind:
      common.type === 4 || common.type === 11 ? "block-device" : "char-device",
    nlink: u32(body, 0),
    xattr: extended ? xattrIndex(u32(body, 8)) : null,
    major: (rdev >>> 8) & 0xfff,
    minor: (rdev & 0xff) | ((rdev >>> 12) & 0xfff00),
  };
};

const ipcInode = ({ common, body, extended }: Parts): IpcInode => ({
  ...common,
  kind: common.type === 6 || common.type === 13 ? "fifo" : "socket",
  nlink: u32(body, 0),
  xattr: extended ? xattrIndex(u32(body, 4)) : null,
});

/** Read the inode at `reference` from the inode table. */
export const readInode = async (
  metadata: MetadataReader,
  table: TableRange,
  reference: InodeReference,
  blockSize: number,
): Promise<Inode> => {
  const position = table.start + reference.block;
  if (reference.offset >= METADATA_BYTES || position >= table.end)
    throw new SquashfsFormatError(
      position,
      `Inode reference ${String(reference.block)}:${String(reference.offset)} is outside the inode table.`,
    );
  const header = await metadata.read(
    { block: position, offset: reference.offset },
    16,
    table.end,
    "inode",
  );
  const type = u16(header.bytes, 0);
  const fixedBytes = FIXED_BYTES[type];
  if (fixedBytes === undefined)
    throw new SquashfsFormatError(
      position,
      `Inode type ${String(type)} is not a SquashFS 4.0 type.`,
    );
  const fixed = await metadata.read(
    header.next,
    fixedBytes,
    table.end,
    "inode",
  );
  const parts: Parts = {
    common: {
      type,
      mode: u16(header.bytes, 2) & 0o7777,
      uid_index: u16(header.bytes, 4),
      gid_index: u16(header.bytes, 6),
      mtime: u32(header.bytes, 8),
      number: u32(header.bytes, 12),
      position,
    },
    body: fixed.bytes,
    next: fixed.next,
    // Types 8..14 extend 1..7 with nlink, sizes past 32 bits and an xattr index.
    extended: type > 7,
  };
  switch (INODE_KINDS[(type - 1) % 7]) {
    case "directory":
      return directoryInode(parts);
    case "file":
      return fileInode(parts, blockSize);
    case "symlink":
      return symlinkInode(parts, metadata, table);
    case "block-device":
    case "char-device":
      return deviceInode(parts);
    default:
      return ipcInode(parts);
  }
};
