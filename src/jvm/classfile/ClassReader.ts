/** A structural problem at an exact byte offset of one class file. */
export class ClassFormatError extends Error {
  constructor(
    readonly offset: number,
    message: string,
  ) {
    super(message);
    this.name = "ClassFormatError";
  }
}

/** Bounded big-endian cursor over one class file's bytes. */
export class ClassReader {
  #offset: number;

  constructor(
    readonly bytes: Uint8Array,
    offset = 0,
    readonly end = bytes.length,
  ) {
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
      throw new ClassFormatError(
        at,
        `${what} needs ${String(count)} bytes but only ${String(this.end - at)} remain.`,
      );
    this.#offset = at + count;
    return at;
  }

  u1(what = "u1"): number {
    return this.bytes[this.#need(1, what)] ?? 0;
  }

  s1(what = "s1"): number {
    const value = this.u1(what);
    return value > 0x7f ? value - 0x100 : value;
  }

  u2(what = "u2"): number {
    const at = this.#need(2, what);
    return ((this.bytes[at] ?? 0) << 8) | (this.bytes[at + 1] ?? 0);
  }

  s2(what = "s2"): number {
    const value = this.u2(what);
    return value > 0x7fff ? value - 0x10000 : value;
  }

  u4(what = "u4"): number {
    const at = this.#need(4, what);
    return (
      ((this.bytes[at] ?? 0) * 0x1000000 +
        (((this.bytes[at + 1] ?? 0) << 16) |
          ((this.bytes[at + 2] ?? 0) << 8) |
          (this.bytes[at + 3] ?? 0))) >>>
      0
    );
  }

  s4(what = "s4"): number {
    return this.u4(what) | 0;
  }

  take(count: number, what: string): Uint8Array {
    const at = this.#need(count, what);
    return this.bytes.subarray(at, at + count);
  }

  /** A sub-reader over the next `length` bytes; this cursor moves past them. */
  slice(length: number, what: string): ClassReader {
    const at = this.#need(length, what);
    return new ClassReader(this.bytes, at, at + length);
  }

  skipTo(offset: number): void {
    if (offset < this.#offset || offset > this.end)
      throw new ClassFormatError(this.#offset, "Cursor cannot move there.");
    this.#offset = offset;
  }
}

/**
 * Decode the JVM's modified UTF-8 (JVMS 4.4.7): NUL is two bytes and
 * supplementary characters are surrogate pairs. Returns null for byte
 * sequences the format does not allow, so a bad name is reported, not
 * silently repaired.
 */
export const decodeModifiedUtf8 = (bytes: Uint8Array): string | null => {
  const units: number[] = [];
  let index = 0;
  while (index < bytes.length) {
    const first = bytes[index] ?? 0;
    if (first === 0 || first >= 0xf0) return null;
    if (first < 0x80) {
      units.push(first);
      index += 1;
      continue;
    }
    if ((first & 0xe0) === 0xc0) {
      const second = bytes[index + 1];
      if (second === undefined || (second & 0xc0) !== 0x80) return null;
      units.push(((first & 0x1f) << 6) | (second & 0x3f));
      index += 2;
      continue;
    }
    if ((first & 0xf0) === 0xe0) {
      const second = bytes[index + 1];
      const third = bytes[index + 2];
      if (
        second === undefined ||
        third === undefined ||
        (second & 0xc0) !== 0x80 ||
        (third & 0xc0) !== 0x80
      )
        return null;
      units.push(
        ((first & 0x0f) << 12) | ((second & 0x3f) << 6) | (third & 0x3f),
      );
      index += 3;
      continue;
    }
    return null;
  }
  let text = "";
  for (let start = 0; start < units.length; start += 8192)
    text += String.fromCharCode(...units.slice(start, start + 8192));
  return text;
};
