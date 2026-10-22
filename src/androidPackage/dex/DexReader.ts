/** A structural problem at an exact byte offset of one DEX file. */
export class DexFormatError extends Error {
  constructor(
    readonly offset: number,
    message: string,
  ) {
    super(message);
    this.name = "DexFormatError";
  }
}

/** Bounded little-endian cursor over one DEX file's bytes (DEX is little-endian as ART reads it). */
export class DexReader {
  #offset: number;

  constructor(
    readonly bytes: Uint8Array,
    offset = 0,
    readonly end = bytes.length,
  ) {
    if (offset < 0 || offset > end || end > bytes.length)
      throw new DexFormatError(
        offset,
        `Offset ${String(offset)} is outside the file.`,
      );
    this.#offset = offset;
  }

  get offset(): number {
    return this.#offset;
  }

  get remaining(): number {
    return this.end - this.#offset;
  }

  #need(count: number, what: string): number {
    const at = this.#offset;
    if (count < 0 || at + count > this.end)
      throw new DexFormatError(
        at,
        `${what} needs ${String(count)} bytes but only ${String(this.end - at)} remain.`,
      );
    this.#offset = at + count;
    return at;
  }

  u1(what = "u1"): number {
    return this.bytes[this.#need(1, what)] ?? 0;
  }

  u2(what = "u2"): number {
    const at = this.#need(2, what);
    return (this.bytes[at] ?? 0) | ((this.bytes[at + 1] ?? 0) << 8);
  }

  u4(what = "u4"): number {
    const at = this.#need(4, what);
    return (
      ((this.bytes[at] ?? 0) |
        ((this.bytes[at + 1] ?? 0) << 8) |
        ((this.bytes[at + 2] ?? 0) << 16) |
        ((this.bytes[at + 3] ?? 0) << 24)) >>>
      0
    );
  }

  take(count: number, what: string): Uint8Array {
    const at = this.#need(count, what);
    return this.bytes.subarray(at, at + count);
  }

  /** Unsigned LEB128 of at most five bytes (a 32-bit value), as the format defines it. */
  uleb128(what = "uleb128"): number {
    let result = 0;
    for (let index = 0; index < 5; index += 1) {
      const byte = this.u1(what);
      if (index === 4 && byte > 0x0f)
        throw new DexFormatError(
          this.#offset - 1,
          `${what} does not fit in 32 bits.`,
        );
      result += (byte & 0x7f) * 2 ** (7 * index);
      if ((byte & 0x80) === 0) return result;
    }
    throw new DexFormatError(
      this.#offset - 5,
      `${what} is longer than five bytes.`,
    );
  }

  /** uleb128p1: the stored value minus one, so 0 encodes "absent" (-1). */
  uleb128p1(what = "uleb128p1"): number {
    return this.uleb128(what) - 1;
  }

  /** Signed LEB128 of at most five bytes. */
  sleb128(what = "sleb128"): number {
    let result = 0;
    let shift = 0;
    let byte = 0;
    for (let index = 0; index < 5; index += 1) {
      byte = this.u1(what);
      result |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) {
        if (shift < 32 && (byte & 0x40) !== 0) result |= -1 << shift;
        return result | 0;
      }
    }
    throw new DexFormatError(
      this.#offset - 5,
      `${what} is longer than five bytes.`,
    );
  }

  seek(offset: number, what: string): void {
    if (offset < 0 || offset > this.end)
      throw new DexFormatError(
        offset,
        `${what} at ${String(offset)} is outside the file.`,
      );
    this.#offset = offset;
  }
}

/** Adler-32 over `bytes`, as the header checksum is defined (everything after the checksum field). */
export const adler32 = (bytes: Uint8Array): number => {
  let a = 1;
  let b = 0;
  // Reduce every 5552 bytes (zlib's NMAX), as the reference implementation does.
  for (let start = 0; start < bytes.length; start += 5552) {
    const end = Math.min(bytes.length, start + 5552);
    for (let index = start; index < end; index += 1) {
      a += bytes[index] ?? 0;
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
};
