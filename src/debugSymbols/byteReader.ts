/** A read that ran past the bytes it was given, or a value this reader will not decode. */
export class DebugFormatError extends Error {
  readonly _tag = "DebugFormatError";
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = this._tag;
  }
}

const textDecoder = new TextDecoder("utf-8", { fatal: false });

/** Bounded cursor over one byte range; every read checks the range first. */
export class ByteReader {
  pos: number;
  readonly #view: DataView;

  constructor(
    readonly bytes: Uint8Array,
    readonly littleEndian: boolean,
    start = 0,
    readonly end = bytes.length,
  ) {
    if (start < 0 || end > bytes.length || start > end)
      throw new DebugFormatError("Range lies outside the available bytes.");
    this.pos = start;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  }

  get remaining(): number {
    return this.end - this.pos;
  }

  get atEnd(): boolean {
    return this.pos >= this.end;
  }

  #take(width: number): number {
    if (!Number.isInteger(width) || width < 0)
      throw new DebugFormatError(
        `Read width ${width} is not a nonnegative integer.`,
      );
    if (width > this.end - this.pos)
      throw new DebugFormatError(
        `Read of ${width} bytes at offset ${this.pos} passes the end of its range.`,
      );
    const at = this.pos;
    this.pos += width;
    return at;
  }

  u8(): number {
    return this.#view.getUint8(this.#take(1));
  }

  i8(): number {
    return this.#view.getInt8(this.#take(1));
  }

  u16(): number {
    return this.#view.getUint16(this.#take(2), this.littleEndian);
  }

  u32(): number {
    return this.#view.getUint32(this.#take(4), this.littleEndian);
  }

  i32(): number {
    return this.#view.getInt32(this.#take(4), this.littleEndian);
  }

  u24(): number {
    const at = this.#take(3);
    const a = this.#view.getUint8(at);
    const b = this.#view.getUint8(at + 1);
    const c = this.#view.getUint8(at + 2);
    return this.littleEndian
      ? a | (b << 8) | (c << 16)
      : (a << 16) | (b << 8) | c;
  }

  u64(): bigint {
    return this.#view.getBigUint64(this.#take(8), this.littleEndian);
  }

  i64(): bigint {
    return this.#view.getBigInt64(this.#take(8), this.littleEndian);
  }

  /** An unsigned value of 1, 2, 4 or 8 bytes as a bigint (addresses). */
  unsignedBig(width: number): bigint {
    switch (width) {
      case 1:
        return BigInt(this.u8());
      case 2:
        return BigInt(this.u16());
      case 4:
        return BigInt(this.u32());
      case 8:
        return this.u64();
      default:
        throw new DebugFormatError(`Unsupported integer width ${width}.`);
    }
  }

  /** An unsigned offset that must fit a safe integer (8-byte offsets in 64-bit DWARF). */
  offset(width: number): number {
    const value = width === 4 ? this.u32() : this.u64();
    if (typeof value === "bigint") {
      if (value > BigInt(Number.MAX_SAFE_INTEGER))
        throw new DebugFormatError(
          `Offset ${value} exceeds the supported range.`,
        );
      return Number(value);
    }
    return value;
  }

  uleb(): number {
    const value = this.ulebValue();
    if (typeof value === "bigint")
      throw new DebugFormatError(
        `LEB128 value ${value} exceeds the supported range.`,
      );
    return value;
  }

  /** An attribute constant: a number when it is exact, a bigint when it is larger. */
  ulebValue(): number | bigint {
    // Seven bytes carry 49 bits, which a double holds exactly; longer values take the bigint path.
    const start = this.pos;
    let result = 0;
    let scale = 1;
    for (let count = 0; count < 7; count += 1) {
      const byte = this.u8();
      result += (byte & 0x7f) * scale;
      if ((byte & 0x80) === 0) return result;
      scale *= 128;
    }
    this.pos = start;
    const value = this.ulebBig();
    return value > BigInt(Number.MAX_SAFE_INTEGER) ? value : Number(value);
  }

  ulebBig(): bigint {
    let result = 0n;
    let shift = 0n;
    for (let count = 0; count < 10; count += 1) {
      const byte = this.u8();
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
    }
    throw new DebugFormatError("LEB128 value is longer than 10 bytes.");
  }

  slebBig(): bigint {
    let result = 0n;
    let shift = 0n;
    for (let count = 0; count < 10; count += 1) {
      const byte = this.u8();
      result |= BigInt(byte & 0x7f) << shift;
      shift += 7n;
      if ((byte & 0x80) === 0) {
        if ((byte & 0x40) !== 0) result -= 1n << shift;
        return result;
      }
    }
    throw new DebugFormatError("LEB128 value is longer than 10 bytes.");
  }

  sleb(): number {
    const value = this.slebValue();
    if (typeof value === "bigint")
      throw new DebugFormatError(
        `LEB128 value ${value} exceeds the supported range.`,
      );
    return value;
  }

  slebValue(): number | bigint {
    const start = this.pos;
    let result = 0;
    let scale = 1;
    for (let count = 0; count < 7; count += 1) {
      const byte = this.u8();
      result += (byte & 0x7f) * scale;
      scale *= 128;
      if ((byte & 0x80) === 0)
        return (byte & 0x40) !== 0 ? result - scale : result;
    }
    this.pos = start;
    const value = this.slebBig();
    return value > BigInt(Number.MAX_SAFE_INTEGER) ||
      value < BigInt(Number.MIN_SAFE_INTEGER)
      ? value
      : Number(value);
  }

  skip(width: number): void {
    this.#take(width);
  }

  block(width: number): Uint8Array {
    const at = this.#take(width);
    return this.bytes.subarray(at, at + width);
  }

  /** A NUL-terminated string; the terminator must lie inside the range. */
  cString(): string {
    let stop = this.pos;
    while (stop < this.end && this.bytes[stop] !== 0) stop += 1;
    if (stop >= this.end)
      throw new DebugFormatError(
        `String at offset ${this.pos} has no terminator inside its range.`,
      );
    const text = textDecoder.decode(this.bytes.subarray(this.pos, stop));
    this.pos = stop + 1;
    return text;
  }
}

/** A NUL-terminated string at an offset of a string section, or null when it does not fit. */
export const stringAt = (
  section: Uint8Array | undefined,
  offset: number,
): string | null => {
  if (section === undefined || offset < 0 || offset >= section.length)
    return null;
  const stop = section.indexOf(0, offset);
  if (stop < 0) return null;
  return textDecoder.decode(section.subarray(offset, stop));
};

export const hex = (bytes: Uint8Array): string =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).toString("hex");

export const hexAddress = (value: bigint): string => `0x${value.toString(16)}`;

export const optionalHexAddress = (
  value: bigint | null | undefined,
): string | null =>
  value === null || value === undefined ? null : hexAddress(value);
