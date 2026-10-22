import type { Decompress } from "./compression.js";
import {
  type ImageSource,
  METADATA_BYTES,
  SquashfsFormatError,
  u16,
  u64,
} from "./format.js";

/** A position inside a metadata table: a block header's absolute offset and a byte within its data. */
export interface MetadataCursor {
  readonly block: number;
  readonly offset: number;
}

/** A lookup table: its u64 block index and the range its metadata blocks occupy. */
export interface LookupTable {
  readonly index: number;
  readonly start: number;
  readonly end: number;
}

export interface MetadataBlock {
  readonly data: Uint8Array;
  /** Absolute offset of the following block's header. */
  readonly next: number;
}

/** Decompressed metadata blocks kept for re-reads (at most 4 MiB). */
const CACHED_BLOCKS = 512;
/** Lookup-table index entries kept for re-reads. */
const CACHED_POINTERS = 4096;

/**
 * Reader for metadata tables: blocks of at most 8 KiB, each behind a u16
 * header whose bit 15 marks it stored uncompressed. Every block must lie
 * inside the table the caller names by its end offset.
 */
export class MetadataReader {
  readonly #cache = new Map<number, MetadataBlock>();
  readonly #pointers = new Map<number, number>();

  constructor(
    readonly source: ImageSource,
    readonly decompress: Decompress,
  ) {}

  /** The metadata block whose header is at `position`, inside a table that ends at `end`. */
  async block(
    position: number,
    end: number,
    what: string,
  ): Promise<MetadataBlock> {
    const cached = this.#cache.get(position);
    if (cached !== undefined) {
      this.#cache.delete(position);
      this.#cache.set(position, cached);
      return cached;
    }
    if (position < 0 || position + 2 > end)
      throw new SquashfsFormatError(
        position,
        `${what} needs a metadata block at ${String(position)}, outside its table (which ends at ${String(end)}).`,
      );
    const header = u16(
      await this.source.bytes(position, 2, `${what} metadata header`),
      0,
    );
    const stored = header & 0x7fff;
    if (stored === 0 || stored > METADATA_BYTES)
      throw new SquashfsFormatError(
        position,
        `The metadata block at ${String(position)} claims ${String(stored)} stored bytes; a metadata block holds 1 to ${String(METADATA_BYTES)}.`,
      );
    if (position + 2 + stored > end)
      throw new SquashfsFormatError(
        position,
        `The metadata block at ${String(position)} needs ${String(stored)} bytes but its table ends at ${String(end)}.`,
      );
    const payload = await this.source.bytes(
      position + 2,
      stored,
      `${what} metadata block`,
    );
    const data =
      (header & 0x8000) === 0
        ? this.decompress(payload, METADATA_BYTES, position)
        : payload;
    if (data.length === 0)
      throw new SquashfsFormatError(
        position,
        `The metadata block at ${String(position)} holds no data.`,
      );
    const block = { data, next: position + 2 + stored };
    this.#cache.set(position, block);
    if (this.#cache.size > CACHED_BLOCKS) {
      const oldest = this.#cache.keys().next();
      if (oldest.done !== true) this.#cache.delete(oldest.value);
    }
    return block;
  }

  /** `length` bytes from `cursor`, continuing into the following blocks of a table that ends at `end`. */
  async read(
    cursor: MetadataCursor,
    length: number,
    end: number,
    what: string,
  ): Promise<{ readonly bytes: Uint8Array; readonly next: MetadataCursor }> {
    let position = cursor.block;
    let offset = cursor.offset;
    let block = await this.block(position, end, what);
    if (offset > block.data.length)
      throw new SquashfsFormatError(
        position,
        `${what} starts at byte ${String(offset)} of a ${String(block.data.length)}-byte metadata block.`,
      );
    if (offset + length <= block.data.length)
      return {
        bytes: block.data.subarray(offset, offset + length),
        next: { block: position, offset: offset + length },
      };
    const bytes = new Uint8Array(length);
    let filled = 0;
    while (filled < length) {
      if (offset === block.data.length) {
        position = block.next;
        offset = 0;
        block = await this.block(position, end, what);
      }
      const take = Math.min(length - filled, block.data.length - offset);
      bytes.set(block.data.subarray(offset, offset + take), filled);
      filled += take;
      offset += take;
    }
    return { bytes, next: { block: position, offset } };
  }

  /**
   * Entry `index` of a lookup table (ids, fragments, export, xattr ids): an
   * uncompressed array of u64 block offsets at `index`, each block holding
   * 8 KiB of fixed-size entries and lying in [`start`, `end`).
   */
  async lookup(
    table: LookupTable,
    entryBytes: number,
    entry: number,
    what: string,
  ): Promise<Uint8Array> {
    const byte = entry * entryBytes;
    const slot = table.index + 8 * Math.floor(byte / METADATA_BYTES);
    let pointer = this.#pointers.get(slot);
    if (pointer === undefined) {
      pointer = u64(await this.source.bytes(slot, 8, `${what} index`), 0);
      if (pointer < table.start || pointer >= table.end)
        throw new SquashfsFormatError(
          slot,
          `The ${what} index points at ${String(pointer)}, outside [${String(table.start)}, ${String(table.end)}).`,
        );
      if (this.#pointers.size >= CACHED_POINTERS) this.#pointers.clear();
      this.#pointers.set(slot, pointer);
    }
    const block = await this.block(pointer, table.end, what);
    const at = byte % METADATA_BYTES;
    if (at + entryBytes > block.data.length)
      throw new SquashfsFormatError(
        pointer,
        `${what} ${String(entry)} lies past the ${String(block.data.length)} bytes of its metadata block.`,
      );
    return block.data.subarray(at, at + entryBytes);
  }
}
