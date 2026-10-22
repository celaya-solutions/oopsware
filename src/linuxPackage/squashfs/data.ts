import type { Decompress } from "./compression.js";
import {
  type ImageSource,
  METADATA_BYTES,
  SquashfsFormatError,
  u32,
  u64,
} from "./format.js";
import type { FileInode, TableRange } from "./inode.js";
import type { LookupTable, MetadataReader } from "./metadata.js";
import { SUPERBLOCK_BYTES } from "./superblock.js";

/** Block-list entries read from the inode table at a time. */
const BLOCK_LIST_BATCH = 2048;
/** Decompressed fragment blocks kept for neighbouring small files. */
const CACHED_FRAGMENTS = 8;
/** Bit 24 of a data or fragment block size: stored uncompressed. */
const UNCOMPRESSED_BLOCK = 1 << 24;

export interface FileDataContext {
  readonly source: ImageSource;
  readonly metadata: MetadataReader;
  readonly decompress: Decompress;
  /** Data and fragment blocks lie between the superblock and the inode table. */
  readonly inodes: TableRange;
  readonly blockSize: number;
  readonly fragments: LookupTable | null;
  readonly fragmentCount: number;
}

/** Regular-file bytes: data blocks named by the inode's block list, then the tail from a fragment block. */
export class FileData {
  readonly #fragmentCache = new Map<number, Uint8Array>();

  constructor(readonly context: FileDataContext) {}

  /** A stored block's bytes: decompressed unless bit 24 marks it stored, never more than one block. */
  async #block(
    word: number,
    position: number,
    what: string,
  ): Promise<Uint8Array> {
    const { source, decompress, inodes, blockSize } = this.context;
    const stored = (word & ~UNCOMPRESSED_BLOCK) >>> 0;
    if (
      stored > blockSize ||
      position < SUPERBLOCK_BYTES ||
      position + stored > inodes.start
    )
      throw new SquashfsFormatError(
        position,
        `${what} (${String(stored)} bytes at ${String(position)}) is outside the data area or larger than a block.`,
      );
    const bytes = await source.bytes(position, stored, what);
    return (word & UNCOMPRESSED_BLOCK) === 0
      ? decompress(bytes, blockSize, position)
      : bytes;
  }

  async *#blocks(
    inode: FileInode,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<Uint8Array> {
    const { metadata, inodes, blockSize } = this.context;
    // Each stored metadata byte (2-byte header, at least 1 byte of data) expands to at most 8 KiB.
    const listCapacity =
      Math.ceil((inodes.end - inode.block_list.block) / 3) * METADATA_BYTES;
    if (inode.block_count * 4 > listCapacity)
      throw new SquashfsFormatError(
        inode.position,
        `A ${String(inode.size)}-byte file needs ${String(inode.block_count)} block sizes, more than the inode table can hold.`,
      );
    let cursor = inode.block_list;
    let position = inode.blocks_start;
    for (let done = 0; done < inode.block_count;) {
      const batch = Math.min(inode.block_count - done, BLOCK_LIST_BATCH);
      const list = await metadata.read(
        cursor,
        batch * 4,
        inodes.end,
        "block list",
      );
      cursor = list.next;
      for (let index = 0; index < batch; index += 1, done += 1) {
        signal?.throwIfAborted();
        const word = u32(list.bytes, index * 4);
        const expected = Math.min(blockSize, inode.size - done * blockSize);
        // A zero size is a sparse block: zeros, nothing stored.
        if ((word & ~UNCOMPRESSED_BLOCK) === 0) {
          yield new Uint8Array(expected);
          continue;
        }
        const data = await this.#block(
          word,
          position,
          `Data block ${String(done)} of inode ${String(inode.number)}`,
        );
        if (data.length !== expected)
          throw new SquashfsFormatError(
            position,
            `Data block ${String(done)} of inode ${String(inode.number)} holds ${String(data.length)} bytes; ${String(expected)} were expected.`,
          );
        position += (word & ~UNCOMPRESSED_BLOCK) >>> 0;
        yield data;
      }
    }
  }

  async #fragment(index: number, inode: FileInode): Promise<Uint8Array> {
    const cached = this.#fragmentCache.get(index);
    if (cached !== undefined) return cached;
    const { metadata, fragments, fragmentCount } = this.context;
    if (fragments === null || index >= fragmentCount)
      throw new SquashfsFormatError(
        inode.position,
        `Inode ${String(inode.number)} names fragment ${String(index)}; the image has ${String(fragmentCount)}.`,
      );
    const record = await metadata.lookup(
      fragments,
      16,
      index,
      "fragment entry",
    );
    const start = u64(record, 0);
    const word = u32(record, 8);
    if ((word & ~UNCOMPRESSED_BLOCK) === 0)
      throw new SquashfsFormatError(
        start,
        `Fragment block ${String(index)} is empty.`,
      );
    const data = await this.#block(
      word,
      start,
      `Fragment block ${String(index)}`,
    );
    if (this.#fragmentCache.size >= CACHED_FRAGMENTS)
      this.#fragmentCache.clear();
    this.#fragmentCache.set(index, data);
    return data;
  }

  /** The file's bytes in order; the caller bounds how much it reads. */
  async *read(
    inode: FileInode,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<Uint8Array> {
    yield* this.#blocks(inode, signal);
    const tail = inode.size - inode.block_count * this.context.blockSize;
    if (inode.fragment === null || tail <= 0) return;
    const fragment = await this.#fragment(inode.fragment, inode);
    if (inode.fragment_offset + tail > fragment.length)
      throw new SquashfsFormatError(
        inode.position,
        `The ${String(tail)}-byte tail of inode ${String(inode.number)} at ${String(inode.fragment_offset)} lies past its ${String(fragment.length)}-byte fragment block.`,
      );
    yield fragment.slice(inode.fragment_offset, inode.fragment_offset + tail);
  }
}
