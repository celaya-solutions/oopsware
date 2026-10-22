/** A structural problem at an exact byte offset of one SquashFS image. */
export class SquashfsFormatError extends Error {
  constructor(
    readonly offset: number,
    message: string,
  ) {
    super(message);
    this.name = "SquashfsFormatError";
  }
}

/** A well-formed image using something this reader does not decode, such as a compressor or an older version. */
export class SquashfsUnsupportedError extends Error {
  constructor(
    readonly feature: string,
    message: string,
  ) {
    super(message);
    this.name = "SquashfsUnsupportedError";
  }
}

/** Positional read of the image: bytes [offset, offset+length) relative to the image start. */
export type SquashfsRead = (
  offset: number,
  length: number,
) => Promise<Uint8Array>;

/** Uncompressed size of every metadata block but a table's last (SQUASHFS_METADATA_SIZE). */
export const METADATA_BYTES = 8192;

/** SquashFS is little-endian from version 4.0 on. */
export const u16 = (bytes: Uint8Array, at: number): number =>
  (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);

export const u32 = (bytes: Uint8Array, at: number): number =>
  ((bytes[at] ?? 0) |
    ((bytes[at + 1] ?? 0) << 8) |
    ((bytes[at + 2] ?? 0) << 16) |
    ((bytes[at + 3] ?? 0) << 24)) >>>
  0;

/** A 64-bit field as a number; values past 2^53 lose precision but stay larger than any image. */
export const u64 = (bytes: Uint8Array, at: number): number =>
  u32(bytes, at) + u32(bytes, at + 4) * 2 ** 32;

/** SQUASHFS_INVALID_BLK: a table or reference that is absent. */
export const isAbsent64 = (bytes: Uint8Array, at: number): boolean =>
  u32(bytes, at) === 0xffff_ffff && u32(bytes, at + 4) === 0xffff_ffff;

export const hex = (bytes: Uint8Array): string =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("hex");

/** Bounds-checked positional reads over the declared image. */
export class ImageSource {
  constructor(
    readonly read: SquashfsRead,
    /** Bytes the superblock says the filesystem uses; nothing past it is read. */
    readonly end: number,
  ) {}

  async bytes(
    offset: number,
    length: number,
    what: string,
  ): Promise<Uint8Array> {
    if (offset < 0 || length < 0 || offset + length > this.end)
      throw new SquashfsFormatError(
        offset,
        `${what} needs bytes ${String(offset)}..${String(offset + length)} but the image ends at ${String(this.end)}.`,
      );
    if (length === 0) return new Uint8Array(0);
    const bytes = await this.read(offset, length);
    if (bytes.length !== length)
      throw new SquashfsFormatError(
        offset,
        `${what} is truncated: ${String(bytes.length)} of ${String(length)} bytes could be read.`,
      );
    return bytes;
  }
}
