import type { ReaderCounters } from "../reader.js";
import { checkpoint } from "./legacy.js";

/**
 * [MS-PPT] records: the 8-byte RecordHeader (2.3.1), a cursor over the
 * records between two offsets, and the text atoms. Every walk is charged to
 * one step budget per read, because crafted files can make containers and
 * record chains overlap so the same bytes are reached many times; when the
 * budget runs out the read stops with a diagnostic instead of going quadratic.
 * Walks are synchronous; their loops ask `due` and await `pause()` every few
 * thousand steps, so a cancel is seen while a large file is read.
 */

/** Record types used by the reader ([MS-PPT] 2.13.24, OfficeArt types from [MS-ODRAW] 2.2). */
export const RT = {
  document: 0x03e8,
  documentAtom: 0x03e9,
  slide: 0x03ee,
  slideAtom: 0x03ef,
  notes: 0x03f0,
  notesAtom: 0x03f1,
  slidePersistAtom: 0x03f3,
  mainMaster: 0x03f8,
  slideShowSlideInfoAtom: 0x03f9,
  vbaInfo: 0x03ff,
  vbaInfoAtom: 0x0400,
  externalObjectList: 0x0409,
  drawing: 0x040c,
  list: 0x07d0,
  externalObjectRefAtom: 0x0bc1,
  outlineTextRefAtom: 0x0f9e,
  textHeaderAtom: 0x0f9f,
  textCharsAtom: 0x0fa0,
  textBytesAtom: 0x0fa8,
  cString: 0x0fba,
  externalOleObjectAtom: 0x0fc3,
  externalOleEmbed: 0x0fcc,
  externalOleLink: 0x0fce,
  externalHyperlinkAtom: 0x0fd3,
  externalHyperlink: 0x0fd7,
  headersFooters: 0x0fd9,
  textInteractiveInfoAtom: 0x0fdf,
  externalOleControl: 0x0fee,
  slideListWithText: 0x0ff0,
  interactiveInfo: 0x0ff2,
  interactiveInfoAtom: 0x0ff3,
  userEditAtom: 0x0ff5,
  currentUserAtom: 0x0ff6,
  externalVideo: 0x1005,
  externalAviMovie: 0x1006,
  externalMciMovie: 0x1007,
  externalMediaAtom: 0x1004,
  externalMidiAudio: 0x100d,
  externalCdAudio: 0x100e,
  externalWavAudioEmbedded: 0x100f,
  externalWavAudioLink: 0x1010,
  externalOleObjectStg: 0x1011,
  progTags: 0x1388,
  progBinaryTag: 0x138a,
  binaryTagDataBlob: 0x138b,
  persistDirectoryAtom: 0x1772,
  comment10: 0x2ee0,
  dgContainer: 0xf002,
  spgrContainer: 0xf003,
  spContainer: 0xf004,
  fsp: 0xf00a,
  clientTextbox: 0xf00d,
  clientData: 0xf011,
} as const;

const HEADER = 8;
/** Steps between two yields to the event loop. */
const YIELD_EVERY = 16_384;

export interface PptRecord {
  readonly type: number;
  readonly instance: number;
  readonly version: number;
  /** Offset of the header in the stream. */
  readonly offset: number;
  /** Offset of the record data; the data always lies inside the parent or stream. */
  readonly start: number;
  readonly length: number;
}

/** A byte range of the stream: a record's data, or the whole stream. */
export interface Span {
  readonly start: number;
  readonly length: number;
}

/** The read's step budget ran out; the reader stops and says so. */
export class PptStepLimit extends Error {
  constructor() {
    super(
      "The PowerPoint records overlap or repeat more than a real file's do; reading stopped at the step limit.",
    );
    this.name = "PptStepLimit";
  }
}

/** Where a record is, as diagnostics and slide items name it. */
export const at = (offset: number): string =>
  `PowerPoint Document@${String(offset)}`;

const UTF16 = new TextDecoder("utf-16le");

/** One read of the PowerPoint Document stream: its bytes, a view, the cancel signal and the step budget. */
export class PptStream {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  readonly signal: AbortSignal | undefined;
  readonly #limit: number;
  #steps = 0;
  #yielded = 0;

  constructor(bytes: Uint8Array, signal: AbortSignal | undefined) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.signal = signal;
    // A real file visits each record a few times at most; a record is at least 8 bytes.
    this.#limit = 1_000_000 + bytes.length;
  }

  /** Charge work to the budget. */
  tick(cost = 1): void {
    this.#steps += cost;
    if (this.#steps > this.#limit) throw new PptStepLimit();
  }

  /** True once enough work was done since the last yield; the caller then awaits `pause()`. */
  get due(): boolean {
    return this.#steps - this.#yielded >= YIELD_EVERY;
  }

  /** Yield to the event loop and throw if the read was cancelled. */
  async pause(): Promise<void> {
    this.#yielded = this.#steps;
    await checkpoint(this.signal);
  }

  /** The record whose header is at `offset`, when it and its declared data fit before `end`. */
  recordAt(offset: number, end = this.bytes.length): PptRecord | null {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + HEADER > end)
      return null;
    const first = this.view.getUint16(offset, true);
    const length = this.view.getUint32(offset + 4, true);
    if (length > end - offset - HEADER) return null;
    return {
      version: first & 0xf,
      instance: first >>> 4,
      type: this.view.getUint16(offset + 2, true),
      offset,
      start: offset + HEADER,
      length,
    };
  }

  /** The records of a container (or of the stream), in order, one at a time. */
  cursor(parent: Span, location = "PowerPoint Document"): RecordCursor {
    return new RecordCursor(this, parent, location);
  }

  u32(record: PptRecord, offset: number): number | null {
    return offset + 4 <= record.length
      ? this.view.getUint32(record.start + offset, true)
      : null;
  }

  i32(record: PptRecord, offset: number): number | null {
    return offset + 4 <= record.length
      ? this.view.getInt32(record.start + offset, true)
      : null;
  }

  u16(record: PptRecord, offset: number): number | null {
    return offset + 2 <= record.length
      ? this.view.getUint16(record.start + offset, true)
      : null;
  }

  u8(record: PptRecord, offset: number): number | null {
    return offset < record.length
      ? this.view.getUint8(record.start + offset)
      : null;
  }

  /** UTF-16LE characters of a TextCharsAtom or CString, at most `max`; an odd last byte is dropped, lone surrogates become U+FFFD. */
  utf16(record: PptRecord, max = Number.MAX_SAFE_INTEGER): string {
    const bytes = Math.min(record.length & ~1, max * 2);
    this.tick(1 + (bytes >>> 4));
    return UTF16.decode(
      this.bytes.subarray(record.start, record.start + bytes),
    );
  }

  /** TextBytesAtom: each byte is the low byte of a UTF-16 character whose high byte is 0 (2.9.43), so ISO-8859-1. */
  latin1(record: PptRecord): string {
    this.tick(1 + (record.length >>> 4));
    return Buffer.from(
      this.bytes.buffer,
      this.bytes.byteOffset + record.start,
      record.length,
    ).toString("latin1");
  }
}

/** Walks one container's records; `problem` says why it stopped early, `report` diagnoses it. */
export class RecordCursor {
  problem: string | null = null;
  readonly #stream: PptStream;
  readonly #end: number;
  readonly #location: string;
  #at: number;

  constructor(stream: PptStream, parent: Span, location: string) {
    this.#stream = stream;
    this.#at = parent.start;
    this.#end = parent.start + parent.length;
    this.#location = location;
  }

  next(): PptRecord | null {
    if (this.#at >= this.#end) return null;
    this.#stream.tick();
    const record = this.#stream.recordAt(this.#at, this.#end);
    if (record === null) {
      this.problem =
        this.#at + HEADER > this.#end
          ? `${String(this.#end - this.#at)} bytes at offset ${String(this.#at)} are too short for a record header.`
          : `The record at offset ${String(this.#at)} declares ${String(this.#stream.view.getUint32(this.#at + 4, true))} bytes, past the end of its container at offset ${String(this.#end)}.`;
      this.#at = this.#end;
      return null;
    }
    this.#at = record.start + record.length;
    return record;
  }

  report(counters: ReaderCounters): void {
    if (this.problem !== null) counters.diagnose(this.#location, this.problem);
  }
}

/** A growable list of stream offsets, 4 bytes each, so huge record lists stay small in memory. */
export class OffsetList {
  #data = new Uint32Array(16);
  length = 0;

  push(value: number): void {
    if (this.length === this.#data.length) {
      const grown = new Uint32Array(this.#data.length * 2);
      grown.set(this.#data);
      this.#data = grown;
    }
    this.#data[this.length] = value;
    this.length += 1;
  }

  get(index: number): number {
    return this.#data[index] ?? 0;
  }

  set(index: number, value: number): void {
    if (index < this.length) this.#data[index] = value;
  }
}

/** A set of stream offsets as a bitmap, one bit per stream byte. */
export class OffsetSet {
  readonly #bits: Uint8Array;

  constructor(streamLength: number) {
    this.#bits = new Uint8Array((streamLength >>> 3) + 1);
  }

  /** Mark the offset; false when it was already marked. */
  add(offset: number): boolean {
    const index = offset >>> 3;
    const mask = 1 << (offset & 7);
    const byte = this.#bits[index] ?? 0;
    if ((byte & mask) !== 0) return false;
    this.#bits[index] = byte | mask;
    return true;
  }
}

/** The largest persist id: a 20-bit persistId plus up to 4094 more in one entry ([MS-PPT] 2.3.5). */
const MAX_PERSIST_ID = 0xfffff + 4094;

/** Persist id to stream offset, kept in one typed array (persist ids are at most about a million). */
export class PersistDirectory {
  #offsets = new Float64Array(0);

  get(id: number): number | undefined {
    const value = this.#offsets[id] ?? 0;
    return value === 0 ? undefined : value - 1;
  }

  has(id: number): boolean {
    return this.get(id) !== undefined;
  }

  set(id: number, offset: number): void {
    if (id < 0 || id > MAX_PERSIST_ID) return;
    if (id >= this.#offsets.length) {
      const grown = new Float64Array(
        Math.min(
          MAX_PERSIST_ID + 1,
          Math.max(id + 1, this.#offsets.length * 2),
        ),
      );
      grown.set(this.#offsets);
      this.#offsets = grown;
    }
    this.#offsets[id] = offset + 1;
  }
}

/**
 * Ids (hyperlink ids, notes ids) to offsets or persist ids, both 32-bit. Kept
 * in typed arrays and looked up by binary search after one stable radix sort,
 * so millions of entries stay a few bytes each and no crafted key set can
 * slow a lookup. The first entry added for an id wins.
 */
export class IdIndex {
  readonly #ids = new OffsetList();
  readonly #values = new OffsetList();
  #sorted: Uint32Array | null = null;
  #order: Uint32Array | null = null;

  get length(): number {
    return this.#ids.length;
  }

  add(id: number, value: number): void {
    this.#ids.push(id);
    this.#values.push(value);
    this.#sorted = null;
  }

  /** The first value added for this id. */
  get(id: number): number | undefined {
    const position = this.#first(id);
    return position === undefined ? undefined : this.#values.get(position);
  }

  /** Each id once, in the order it was first added. */
  *entries(): Generator<[number, number]> {
    for (let position = 0; position < this.#ids.length; position += 1) {
      const id = this.#ids.get(position);
      if (this.#first(id) === position) yield [id, this.#values.get(position)];
    }
  }

  #first(id: number): number | undefined {
    const { sorted, order } = this.#sort();
    let low = 0;
    let high = sorted.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((sorted[middle] ?? 0) < id) low = middle + 1;
      else high = middle;
    }
    return low < sorted.length && sorted[low] === id ? order[low] : undefined;
  }

  /** Positions ordered by id, ties in insertion order (LSD radix sort, 8 bits a pass). */
  #sort(): { sorted: Uint32Array; order: Uint32Array } {
    if (this.#sorted !== null && this.#order !== null)
      return { sorted: this.#sorted, order: this.#order };
    const count = this.#ids.length;
    const ids = new Uint32Array(count);
    let order = new Uint32Array(count);
    for (let position = 0; position < count; position += 1) {
      ids[position] = this.#ids.get(position);
      order[position] = position;
    }
    let next = new Uint32Array(count);
    const starts = new Uint32Array(256);
    for (let shift = 0; shift < 32; shift += 8) {
      starts.fill(0);
      for (const id of ids)
        starts[(id >>> shift) & 0xff] =
          (starts[(id >>> shift) & 0xff] ?? 0) + 1;
      let total = 0;
      for (let bucket = 0; bucket < 256; bucket += 1) {
        const size = starts[bucket] ?? 0;
        starts[bucket] = total;
        total += size;
      }
      for (const position of order) {
        const bucket = ((ids[position] ?? 0) >>> shift) & 0xff;
        const slot = starts[bucket] ?? 0;
        next[slot] = position;
        starts[bucket] = slot + 1;
      }
      [order, next] = [next, order];
    }
    const sorted = new Uint32Array(count);
    for (let rank = 0; rank < count; rank += 1)
      sorted[rank] = ids[order[rank] ?? 0] ?? 0;
    this.#order = order;
    this.#sorted = sorted;
    return { sorted, order };
  }
}
