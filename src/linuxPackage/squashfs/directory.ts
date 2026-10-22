import { SquashfsFormatError, u16, u32 } from "./format.js";
import type { InodeReference, TableRange } from "./inode.js";
import type { MetadataCursor, MetadataReader } from "./metadata.js";

/** SQUASHFS_DIR_COUNT: entries one directory header may cover. */
const MAXIMUM_HEADER_ENTRIES = 256;
/** SQUASHFS_NAME_LEN: the longest entry name. */
export const MAXIMUM_NAME_BYTES = 256;

/** One stored directory entry, before its name is judged or its inode read. */
export interface RawDirectoryEntry {
  readonly name: Uint8Array;
  readonly inode: InodeReference;
  /** Basic inode type 1..7 as the entry states it. */
  readonly type: number;
  readonly inode_number: number;
  /** Absolute offset of the metadata block holding the entry. */
  readonly position: number;
}

/**
 * Sequential reader of one directory listing: headers (count, inode block,
 * base inode number) each followed by up to 256 entries, consuming exactly
 * the listing size the directory inode states.
 */
export class DirectoryWalker {
  #cursor: MetadataCursor;
  #remaining: number;
  #headerEntries = 0;
  #headerBlock = 0;
  #headerNumber = 0;

  constructor(
    readonly metadata: MetadataReader,
    readonly table: TableRange,
    listing: {
      readonly block: number;
      readonly offset: number;
      readonly size: number;
    },
  ) {
    this.#cursor = {
      block: table.start + listing.block,
      offset: listing.offset,
    };
    this.#remaining = listing.size;
    if (listing.size > 0 && this.#cursor.block >= table.end)
      throw new SquashfsFormatError(
        this.#cursor.block,
        `A directory listing starts at ${String(this.#cursor.block)}, outside the directory table.`,
      );
  }

  async #take(length: number, what: string): Promise<Uint8Array> {
    if (length > this.#remaining)
      throw new SquashfsFormatError(
        this.#cursor.block,
        `A directory ${what} of ${String(length)} bytes runs past the listing's last ${String(this.#remaining)} bytes.`,
      );
    const read = await this.metadata.read(
      this.#cursor,
      length,
      this.table.end,
      `directory ${what}`,
    );
    this.#cursor = read.next;
    this.#remaining -= length;
    return read.bytes;
  }

  /** The next entry, or null once the listing is consumed. */
  async next(): Promise<RawDirectoryEntry | null> {
    if (this.#headerEntries === 0) {
      if (this.#remaining === 0) return null;
      const header = await this.#take(12, "header");
      const count = u32(header, 0) + 1;
      if (count > MAXIMUM_HEADER_ENTRIES)
        throw new SquashfsFormatError(
          this.#cursor.block,
          `A directory header claims ${String(count)} entries; at most ${String(MAXIMUM_HEADER_ENTRIES)} follow one header.`,
        );
      this.#headerEntries = count;
      this.#headerBlock = u32(header, 4);
      this.#headerNumber = u32(header, 8);
    }
    const position = this.#cursor.block;
    const fixed = await this.#take(8, "entry");
    const nameBytes = u16(fixed, 6) + 1;
    if (nameBytes > MAXIMUM_NAME_BYTES)
      throw new SquashfsFormatError(
        position,
        `A directory entry name of ${String(nameBytes)} bytes is longer than ${String(MAXIMUM_NAME_BYTES)}.`,
      );
    const name = (await this.#take(nameBytes, "entry name")).slice();
    this.#headerEntries -= 1;
    const delta = u16(fixed, 2);
    return {
      name,
      inode: { block: this.#headerBlock, offset: u16(fixed, 0) },
      type: u16(fixed, 4),
      // inode_offset is a signed 16-bit difference from the header's base number.
      inode_number:
        (this.#headerNumber + (delta >= 0x8000 ? delta - 0x1_0000 : delta)) >>>
        0,
      position,
    };
  }
}
