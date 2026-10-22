import { constants, inflateRawSync } from "node:zlib";

import {
  CabFormatError,
  type CabSource,
  CabUnsupportedError,
  cabChecksum,
  u16,
  u32,
} from "./format.js";
import { type CabFolder, MAX_BLOCK_BYTES } from "./header.js";

/** CFDATA before its optional reserve: csum, cbData, cbUncomp. */
const CFDATA_BYTES = 8;

export interface FolderContext {
  readonly source: CabSource;
  readonly folder: CabFolder;
  /** cbCFData from the header reserve sizes. */
  readonly reserve: number;
  /** The folder is the last one and the cabinet names a next cabinet: its last block may continue there. */
  readonly spansNext: boolean;
}

export interface DataBlock {
  /** Uncompressed offset of the block's first byte within the folder. */
  readonly start: number;
  /** cbUncomp. */
  readonly length: number;
  /** Uncompressed bytes; null when a stored block was skipped without reading it. */
  readonly bytes: Uint8Array | null;
}

/** A CFDATA header read but not yet decoded. */
interface RawBlock {
  readonly position: number;
  readonly what: string;
  readonly header: Uint8Array;
  /** cbData. */
  readonly packed: number;
  /** cbUncomp. */
  readonly length: number;
  readonly data_at: number;
}

const toHex = (value: number): string =>
  `0x${value.toString(16).padStart(8, "0")}`;

/**
 * A non-zero csum must equal the checksum of the data continued over cbData
 * and cbUncomp, as libmspack and Wine's cabinet.dll check it; when a data
 * reserve is present the spec's reading, which also covers the reserve
 * bytes, is accepted too.
 */
const verifyChecksum = (raw: RawBlock, data: Uint8Array): void => {
  const stored = u32(raw.header, 0);
  if (stored === 0) return;
  const seed = cabChecksum(data, 0);
  const computed = cabChecksum(raw.header.subarray(4, CFDATA_BYTES), seed);
  if (computed === stored) return;
  if (
    raw.header.length > CFDATA_BYTES &&
    cabChecksum(raw.header.subarray(4), seed) === stored
  )
    return;
  throw new CabFormatError(
    raw.position,
    `${raw.what} has checksum ${toHex(stored)}; its bytes give ${toHex(computed)}.`,
  );
};

/**
 * Walks one folder's CFDATA blocks in order ([MS-CAB] 2.4). MSZIP blocks
 * ([MS-MCI] 2) are "CK" plus a raw deflate stream whose history is the
 * folder's previous 32 KiB of output, so every block from the folder's start
 * is decoded; stored blocks may be skipped unread.
 */
export class FolderCursor {
  #index = 0;
  #position: number;
  #produced = 0;
  #history: Uint8Array = new Uint8Array(0);
  #last: DataBlock | null = null;

  constructor(readonly context: FolderContext) {
    this.#position = context.folder.data_offset;
  }

  /** Uncompressed bytes of the folder before the next block. */
  get produced(): number {
    return this.#produced;
  }

  /** The block most recently returned, still holding its bytes. */
  get last(): DataBlock | null {
    return this.#last;
  }

  /** The next block, or null after the folder's last one. A stored block ending by `skipBefore` goes unread. */
  async next(skipBefore: number): Promise<DataBlock | null> {
    const { source, folder } = this.context;
    if (this.#index >= folder.blocks) return null;
    const raw = await this.#header();
    const start = this.#produced;
    let bytes: Uint8Array | null = null;
    if (folder.compression !== "none" || start + raw.length > skipBefore) {
      const data = await source.bytes(raw.data_at, raw.packed, raw.what);
      verifyChecksum(raw, data);
      bytes = folder.compression === "none" ? data : this.#inflate(raw, data);
    } else if (raw.data_at + raw.packed > source.end)
      throw new CabFormatError(
        raw.data_at,
        `${raw.what} needs bytes ${String(raw.data_at)}..${String(raw.data_at + raw.packed)} but the cabinet ends at ${String(source.end)}.`,
      );
    this.#index += 1;
    this.#position = raw.data_at + raw.packed;
    this.#produced += raw.length;
    this.#last = { start, length: raw.length, bytes };
    return this.#last;
  }

  /** The next CFDATA header, its sizes checked against the 32 KiB block limit and the method. */
  async #header(): Promise<RawBlock> {
    const { source, folder, reserve, spansNext } = this.context;
    const position = this.#position;
    const what = `CFDATA block ${String(this.#index)} of folder ${String(folder.index)}`;
    const header = await source.bytes(position, CFDATA_BYTES + reserve, what);
    const packed = u16(header, 4);
    const length = u16(header, 6);
    if (length > MAX_BLOCK_BYTES)
      throw new CabFormatError(
        position + 6,
        `${what} declares ${String(length)} uncompressed bytes; a block holds at most ${String(MAX_BLOCK_BYTES)}.`,
      );
    if (length === 0) {
      if (spansNext && this.#index === folder.blocks - 1)
        throw new CabUnsupportedError(
          "cabinet span",
          `${what} continues in the next cabinet; spanned folders are listed, not decoded.`,
        );
      throw new CabFormatError(
        position + 6,
        `${what} declares no uncompressed bytes.`,
      );
    }
    if (folder.compression === "none" && packed !== length)
      throw new CabFormatError(
        position + 4,
        `${what} is stored but holds ${String(packed)} bytes for ${String(length)} uncompressed.`,
      );
    return {
      position,
      what,
      header,
      packed,
      length,
      data_at: position + CFDATA_BYTES + reserve,
    };
  }

  #inflate(raw: RawBlock, data: Uint8Array): Uint8Array {
    if (data[0] !== 0x43 || data[1] !== 0x4b)
      throw new CabFormatError(
        raw.data_at,
        `${raw.what} does not start with the MSZIP signature "CK".`,
      );
    let output: Uint8Array;
    try {
      output = inflateRawSync(data.subarray(2), {
        ...(this.#history.length > 0 ? { dictionary: this.#history } : {}),
        maxOutputLength: MAX_BLOCK_BYTES,
        // Producers end each block's deflate stream; a block flushed without BFINAL still decodes.
        finishFlush: constants.Z_SYNC_FLUSH,
      });
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new CabFormatError(
        raw.data_at,
        `${raw.what} does not inflate within ${String(MAX_BLOCK_BYTES)} bytes: ${reason}`,
      );
    }
    if (output.length !== raw.length)
      throw new CabFormatError(
        raw.data_at,
        `${raw.what} inflates to ${String(output.length)} bytes; cbUncomp says ${String(raw.length)}.`,
      );
    // The next block's dictionary: the folder's last 32 KiB of output (a block is never longer).
    const joined = new Uint8Array(
      Math.min(this.#history.length + output.length, MAX_BLOCK_BYTES),
    );
    const fromHistory = joined.length - output.length;
    joined.set(this.#history.subarray(this.#history.length - fromHistory));
    joined.set(output, fromHistory);
    this.#history = joined;
    return output;
  }
}
