import type { Problems } from "./bounds.js";
import { codepageDecoder, type CodepageDecoder } from "./codepage.js";

const u16 = (bytes: Uint8Array, at: number): number =>
  (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);

/**
 * The string pool as libmsi and Windows load it: _StringPool is (length,
 * refcount) word pairs; pair 0 holds the code page, with bit 15 of its high
 * word marking 3-byte string references. A string of 64 KiB or more is a
 * (0, refcount) pair followed by a pair holding its length's low and high
 * words; it still takes one string ID. Lengths run through _StringData in
 * order. Strings are decoded from the code page on first lookup.
 */
export class StringPool {
  readonly #offsets: number[] = [];
  readonly #lengths: number[] = [];
  readonly #cache = new Map<number, string>();

  private constructor(
    readonly data: Uint8Array,
    readonly decoder: CodepageDecoder,
    /** Bytes per string reference in tables: 2, or 3 for long references. */
    readonly strref: 2 | 3,
  ) {}

  get codepage(): number {
    return this.decoder.codepage;
  }

  static read(
    pool: Uint8Array,
    data: Uint8Array,
    problems: Problems,
  ): StringPool {
    if (pool.length % 4 !== 0)
      problems.add(
        `_StringPool is ${String(pool.length)} bytes, not a multiple of 4; the tail is ignored.`,
      );
    const word = (index: number): number => u16(pool, index * 2);
    const count = Math.floor(pool.length / 4);
    const codepage = count > 0 ? word(0) | ((word(1) & 0x7fff) << 16) : 0;
    const decoder = codepageDecoder(codepage);
    if (!decoder.exact)
      problems.add(
        `String pool code page ${String(codepage)} has no decoder here; strings are read as windows-1252.`,
      );
    const strings = new StringPool(
      data,
      decoder,
      count > 0 && (word(1) & 0x8000) !== 0 ? 3 : 2,
    );
    let offset = 0;
    let id = 1;
    for (let slot = 1; slot < count; id += 1) {
      const refs = word(slot * 2 + 1);
      let size = word(slot * 2);
      if (size === 0 && refs !== 0) {
        if (slot + 1 >= count) {
          problems.add(
            `String ${String(id)} is a long string whose length is past the end of _StringPool.`,
          );
          break;
        }
        size = word(slot * 2 + 2) + word(slot * 2 + 3) * 0x10000;
        slot += 2;
      } else slot += 1;
      if (offset + size > data.length) {
        problems.add(
          `String ${String(id)} needs ${String(size)} bytes at _StringData offset ${String(offset)}, past its ${String(data.length)} bytes; this and later strings are missing.`,
        );
        break;
      }
      if (size > 0 || refs !== 0) {
        strings.#offsets[id] = offset;
        strings.#lengths[id] = size;
      }
      offset += size;
    }
    if (offset < data.length)
      problems.add(
        `_StringData has ${String(data.length - offset)} bytes no string pool entry covers.`,
      );
    return strings;
  }

  /** The string with this ID, or undefined when the pool has none. */
  lookup(id: number): string | undefined {
    const cached = this.#cache.get(id);
    if (cached !== undefined) return cached;
    const offset = this.#offsets[id];
    const length = this.#lengths[id];
    if (offset === undefined || length === undefined) return undefined;
    const text = this.decoder.decode(
      this.data.subarray(offset, offset + length),
    );
    this.#cache.set(id, text);
    return text;
  }
}
