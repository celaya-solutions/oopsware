/**
 * Bounds-checked cursor over WebAssembly binary bytes. Every read either
 * returns a value inside `[offset, end)` or throws {@link WasmDecodeError}
 * naming the exact byte offset, so a malformed length or LEB128 never reads
 * past its section or allocates from an untrusted count.
 */

/** A decoding failure at an exact byte offset of the original module. */
export class WasmDecodeError extends Error {
  constructor(
    readonly offset: number,
    message: string,
    /** Set when the bytes use a proposal this reader does not decode. */
    readonly proposal: string | null = null,
  ) {
    super(message);
    this.name = "WasmDecodeError";
  }
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });

export class ByteReader {
  #offset: number;

  constructor(
    readonly bytes: Uint8Array,
    start: number,
    readonly end: number,
  ) {
    if (start < 0 || end > bytes.length || start > end)
      throw new WasmDecodeError(start, "Range lies outside the module bytes.");
    this.#offset = start;
  }

  get offset(): number {
    return this.#offset;
  }

  get remaining(): number {
    return this.end - this.#offset;
  }

  atEnd(): boolean {
    return this.#offset >= this.end;
  }

  u8(what = "byte"): number {
    if (this.#offset >= this.end)
      throw new WasmDecodeError(
        this.#offset,
        `Unexpected end reading ${what}.`,
      );
    return this.bytes[this.#offset++] as number;
  }

  /** Unsigned LEB128 of at most `bits` bits, rejecting overlong or overflowing encodings. */
  #unsigned(bits: 32 | 64, what: string): bigint {
    const start = this.#offset;
    const maxBytes = Math.ceil(bits / 7);
    let result = 0n;
    for (let index = 0; ; index += 1) {
      if (index >= maxBytes)
        throw new WasmDecodeError(
          start,
          `LEB128 ${what} is longer than ${String(maxBytes)} bytes.`,
        );
      const byte = this.u8(`LEB128 ${what}`);
      const shift = BigInt(index * 7);
      if (index === maxBytes - 1) {
        // The last byte may only carry the bits that fit in the integer.
        const unused = 7 - (bits - index * 7);
        if (byte & 0x80 || byte >> (7 - unused) !== 0)
          throw new WasmDecodeError(
            start,
            `LEB128 ${what} overflows ${String(bits)} bits.`,
          );
      }
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
    }
  }

  /** Signed LEB128 of at most `bits` bits with sign-extension checks on the last byte. */
  #signed(bits: 32 | 33 | 64, what: string): bigint {
    const start = this.#offset;
    const maxBytes = Math.ceil(bits / 7);
    let result = 0n;
    let shift = 0n;
    for (let index = 0; ; index += 1) {
      if (index >= maxBytes)
        throw new WasmDecodeError(
          start,
          `LEB128 ${what} is longer than ${String(maxBytes)} bytes.`,
        );
      const byte = this.u8(`LEB128 ${what}`);
      if (index === maxBytes - 1) {
        if (byte & 0x80)
          throw new WasmDecodeError(
            start,
            `LEB128 ${what} overflows ${String(bits)} bits.`,
          );
        // Bits beyond the integer width must all equal its sign bit.
        const used = bits - index * 7;
        const tail = byte >> (used - 1);
        if (tail !== 0 && tail !== 0x7f >> (used - 1))
          throw new WasmDecodeError(
            start,
            `LEB128 ${what} overflows ${String(bits)} bits.`,
          );
      }
      result |= BigInt(byte & 0x7f) << shift;
      shift += 7n;
      if ((byte & 0x80) === 0) {
        if (byte & 0x40) result -= 1n << shift;
        return result;
      }
    }
  }

  u32(what = "integer"): number {
    return Number(this.#unsigned(32, what));
  }

  u64(what = "integer"): bigint {
    return this.#unsigned(64, what);
  }

  s32(what = "integer"): number {
    return Number(this.#signed(32, what));
  }

  s33(what = "integer"): number {
    return Number(this.#signed(33, what));
  }

  s64(what = "integer"): bigint {
    return this.#signed(64, what);
  }

  /** A vector or byte length that must fit in what is left of this range. */
  count(what: string, minimumBytesEach = 1): number {
    const at = this.#offset;
    const value = this.u32(`${what} count`);
    if (value * minimumBytesEach > this.remaining)
      throw new WasmDecodeError(
        at,
        `${what} count ${String(value)} exceeds the ${String(this.remaining)} bytes left.`,
      );
    return value;
  }

  take(length: number, what = "bytes"): Uint8Array {
    if (length > this.remaining)
      throw new WasmDecodeError(
        this.#offset,
        `${what} length ${String(length)} exceeds the ${String(this.remaining)} bytes left.`,
      );
    const slice = this.bytes.subarray(this.#offset, this.#offset + length);
    this.#offset += length;
    return slice;
  }

  name(what = "name"): string {
    const length = this.count(what);
    const at = this.#offset;
    const raw = this.take(length, what);
    try {
      return UTF8.decode(raw);
    } catch {
      throw new WasmDecodeError(at, `${what} is not valid UTF-8.`);
    }
  }

  skipTo(offset: number): void {
    if (offset < this.#offset || offset > this.end)
      throw new WasmDecodeError(this.#offset, "Skip lies outside the range.");
    this.#offset = offset;
  }
}
