/**
 * BIFF8 record access for the legacy Excel reader ([MS-XLS] 2.1.4): a walker
 * that hops record headers without copying, and a reader for one record's data
 * together with the CONTINUE records that follow it. Both stop at the end of
 * the stream; nothing here allocates more than the bytes it returns.
 */

/** Record types this reader reads ([MS-XLS] 2.3). */
export const RT = {
  formula: 0x0006,
  eof: 0x000a,
  externSheet: 0x0017,
  name: 0x0018,
  note: 0x001c,
  date1904: 0x0022,
  externName: 0x0023,
  filePass: 0x002f,
  continue: 0x003c,
  codePage: 0x0042,
  obj: 0x005d,
  wsBool: 0x0081,
  boundSheet: 0x0085,
  mulRk: 0x00bd,
  mulBlank: 0x00be,
  xf: 0x00e0,
  mergeCells: 0x00e5,
  sst: 0x00fc,
  labelSst: 0x00fd,
  supBook: 0x01ae,
  hlink: 0x01b8,
  dv: 0x01be,
  blank: 0x0201,
  number: 0x0203,
  label: 0x0204,
  boolErr: 0x0205,
  string: 0x0207,
  row: 0x0208,
  array: 0x0221,
  table: 0x0236,
  rk: 0x027e,
  format: 0x041e,
  shrFmla: 0x04bc,
  bof: 0x0809,
} as const;

/** BErr error codes ([MS-XLS] 2.5.11) as Excel writes them. */
export const ERRORS: ReadonlyMap<number, string> = new Map([
  [0x00, "#NULL!"],
  [0x07, "#DIV/0!"],
  [0x0f, "#VALUE!"],
  [0x17, "#REF!"],
  [0x1d, "#NAME?"],
  [0x24, "#NUM!"],
  [0x2a, "#N/A"],
  [0x2b, "#GETTING_DATA"],
]);

const u16At = (bytes: Uint8Array, at: number): number =>
  (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);

/** Hops from record to record without copying; `data()` views the current record's data. */
export class RecordWalker {
  readonly #bytes: Uint8Array;
  readonly #end: number;
  #next: number;
  /** The current record's type, header offset, data offset and data length. */
  type = -1;
  offset = 0;
  start = 0;
  length = 0;
  /** A record header or its data ran past the end. */
  truncated = false;

  constructor(bytes: Uint8Array, start: number, end = bytes.length) {
    this.#bytes = bytes;
    this.#end = Math.min(end, bytes.length);
    this.#next = start;
  }

  /** The type of the record after the current one, without moving; undefined when none is whole. */
  peekType(): number | undefined {
    const at = this.#next;
    if (at + 4 > this.#end) return undefined;
    if (at + 4 + u16At(this.#bytes, at + 2) > this.#end) return undefined;
    return u16At(this.#bytes, at);
  }

  /** Move to the next record; false at the end or when the next record is cut off. */
  advance(): boolean {
    const at = this.#next;
    if (at + 4 > this.#end) {
      if (at < this.#end) this.truncated = true;
      return false;
    }
    const length = u16At(this.#bytes, at + 2);
    if (at + 4 + length > this.#end) {
      this.truncated = true;
      return false;
    }
    this.type = u16At(this.#bytes, at);
    this.offset = at;
    this.start = at + 4;
    this.length = length;
    this.#next = at + 4 + length;
    return true;
  }

  data(): Uint8Array {
    return this.#bytes.subarray(this.start, this.start + this.length);
  }

  /** The current record's data and its CONTINUE records, read as one. */
  reader(skip = 0): ContinuedReader {
    return new ContinuedReader(
      this.#bytes,
      this.start + Math.min(skip, this.length),
      this.length - Math.min(skip, this.length),
      this.#end,
    );
  }
}

const text = (bytes: Uint8Array, wide: boolean): string =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
    wide ? "utf16le" : "latin1",
  );

/**
 * One record's data followed by its CONTINUE records ([MS-XLS] 2.4.58). Plain
 * reads cross record boundaries as raw bytes; `chars` reads the characters of
 * a Unicode string, where each boundary inside them starts with a byte that
 * restates fHighByte. Reading past the last record throws a RangeError.
 */
export class ContinuedReader {
  readonly #bytes: Uint8Array;
  readonly #limit: number;
  #pos: number;
  #end: number;
  readonly #scratch = new DataView(new ArrayBuffer(8));

  constructor(bytes: Uint8Array, start: number, length: number, limit: number) {
    this.#bytes = bytes;
    this.#limit = Math.min(limit, bytes.length);
    this.#pos = start;
    this.#end = Math.min(start + length, this.#limit);
  }

  /** Step into the CONTINUE record that follows the current segment. */
  #nextSegment(): boolean {
    const at = this.#end;
    if (at + 4 > this.#limit || u16At(this.#bytes, at) !== RT.continue)
      return false;
    const length = u16At(this.#bytes, at + 2);
    if (at + 4 + length > this.#limit) return false;
    this.#pos = at + 4;
    this.#end = at + 4 + length;
    return true;
  }

  #need(): void {
    while (this.#pos >= this.#end)
      if (!this.#nextSegment())
        throw new RangeError("The record ends before its data does.");
  }

  /** Offset in the underlying bytes of the next byte to read. */
  get position(): number {
    return this.#pos;
  }

  /** True when the current record and its CONTINUE records hold no more bytes. */
  done(): boolean {
    while (this.#pos >= this.#end) if (!this.#nextSegment()) return true;
    return false;
  }

  u8(): number {
    this.#need();
    return this.#bytes[this.#pos++] ?? 0;
  }

  u16(): number {
    return this.u8() | (this.u8() << 8);
  }

  u32(): number {
    return this.u16() + this.u16() * 0x10000;
  }

  f64(): number {
    for (let at = 0; at < 8; at += 1) this.#scratch.setUint8(at, this.u8());
    return this.#scratch.getFloat64(0, true);
  }

  skip(count: number): void {
    let left = count;
    while (left > 0) {
      this.#need();
      const take = Math.min(left, this.#end - this.#pos);
      this.#pos += take;
      left -= take;
    }
  }

  /** Raw bytes across record boundaries, gathered as they are read (never allocated up front). */
  raw(count: number): Uint8Array {
    const parts: Uint8Array[] = [];
    let left = count;
    while (left > 0) {
      this.#need();
      const take = Math.min(left, this.#end - this.#pos);
      parts.push(this.#bytes.subarray(this.#pos, this.#pos + take));
      this.#pos += take;
      left -= take;
    }
    return parts.length === 1
      ? (parts[0] ?? new Uint8Array(0))
      : Buffer.concat(parts);
  }

  /** `count` characters stored one byte (Latin-1) or two bytes (UTF-16LE) each. */
  chars(count: number, wide: boolean): string {
    const parts: string[] = [];
    let left = count;
    let high = wide;
    while (left > 0) {
      if (this.#pos >= this.#end) {
        do {
          if (!this.#nextSegment())
            throw new RangeError("A string runs past the end of its record.");
        } while (this.#pos >= this.#end);
        high = ((this.#bytes[this.#pos++] ?? 0) & 1) === 1;
        continue;
      }
      const room = this.#end - this.#pos;
      const take = Math.min(left, high ? room >> 1 : room);
      if (take === 0)
        throw new RangeError("A two-byte character is split across records.");
      const size = high ? take * 2 : take;
      parts.push(text(this.#bytes.subarray(this.#pos, this.#pos + size), high));
      this.#pos += size;
      left -= take;
    }
    return parts.join("");
  }
}

/** XLUnicodeString: a 2-byte count, fHighByte and the characters ([MS-XLS] 2.5.294). */
export const xlString = (reader: ContinuedReader): string => {
  const count = reader.u16();
  return reader.chars(count, (reader.u8() & 1) === 1);
};

/** ShortXLUnicodeString: a 1-byte count ([MS-XLS] 2.5.240). */
export const shortString = (reader: ContinuedReader): string => {
  const count = reader.u8();
  return reader.chars(count, (reader.u8() & 1) === 1);
};

/** XLUnicodeStringNoCch: the count is given by the record ([MS-XLS] 2.5.296). */
export const noCchString = (reader: ContinuedReader, count: number): string =>
  reader.chars(count, (reader.u8() & 1) === 1);

/** A plain byte array read with the same reader (formula tokens and their extra data). */
export const bytesReader = (bytes: Uint8Array): ContinuedReader =>
  new ContinuedReader(bytes, 0, bytes.length, bytes.length);

/** Column letters for a zero-based column (0 = A). */
export const columnName = (index: number): string => {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26))
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
};

export const cellName = (row: number, col: number): string =>
  `${columnName(col)}${String(row + 1)}`;

/** An RK number ([MS-XLS] 2.5.217): a 30-bit integer or the high 30 bits of a double, optionally divided by 100. */
export const rkValue = (rk: number): number => {
  let value: number;
  if ((rk & 2) !== 0) value = (rk | 0) >> 2;
  else {
    const view = new DataView(new ArrayBuffer(8));
    view.setUint32(4, (rk & 0xfffffffc) >>> 0, true);
    value = view.getFloat64(0, true);
  }
  return (rk & 1) !== 0 ? value / 100 : value;
};
