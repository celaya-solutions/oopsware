import { rpmTagName, type RpmHeader, type RpmValue } from "./header.js";

/** Typed reads over one header; a stored type that does not fit is a problem. */
export class Reader {
  readonly #reported = new Set<number>();

  constructor(
    readonly header: RpmHeader,
    readonly kind: "signature" | "main",
    readonly problems: string[],
    readonly locale: number,
  ) {}

  /** Record a problem about `tag` once, however often the tag is read. */
  #report(tag: number, problem: string): void {
    if (this.#reported.has(tag)) return;
    this.#reported.add(tag);
    this.problems.push(`${rpmTagName(tag, this.kind)} ${problem}`);
  }

  #value(tag: number): RpmValue | undefined {
    if (this.header.undecodable.has(tag))
      this.#report(tag, "is not valid UTF-8 and is reported as missing.");
    return this.header.entries.get(tag);
  }

  #wrong(tag: number, value: RpmValue, wanted: string): null {
    this.#report(tag, `is stored as ${value.type}; ${wanted} was expected.`);
    return null;
  }

  strings(tag: number): readonly string[] | null {
    const value = this.#value(tag);
    if (value === undefined) return null;
    if (
      value.type === "string_array" ||
      value.type === "string" ||
      value.type === "i18nstring"
    )
      return value.values;
    return this.#wrong(tag, value, "a string");
  }

  /** STRING, or the I18NSTRING element for the "C" locale. */
  string(tag: number): string | null {
    const value = this.#value(tag);
    if (value === undefined) return null;
    if (value.type === "string") return value.values[0] ?? null;
    if (value.type === "i18nstring")
      return value.values[this.locale] ?? value.values[0] ?? null;
    if (value.type === "string_array") return value.values[0] ?? null;
    return this.#wrong(tag, value, "a string");
  }

  numbers(tag: number): readonly number[] | null {
    const value = this.#value(tag);
    if (value === undefined) return null;
    if (value.type === "int64") {
      const values = value.values.map(Number);
      if (values.some((number) => !Number.isSafeInteger(number))) {
        this.#report(tag, "exceeds the safe integer range.");
        return null;
      }
      return values;
    }
    if (
      value.type === "int8" ||
      value.type === "char" ||
      value.type === "int16" ||
      value.type === "int32"
    )
      return value.values;
    return this.#wrong(tag, value, "a number");
  }

  number(tag: number): number | null {
    return this.numbers(tag)?.[0] ?? null;
  }

  bytes(tag: number): Uint8Array | null {
    const value = this.#value(tag);
    if (value === undefined) return null;
    if (value.type === "bin") return value.bytes;
    return this.#wrong(tag, value, "binary data");
  }
}

/** Locale index of "C" in HEADERI18NTABLE, which rpm uses for LC_ALL=C. */
export const cLocale = (header: RpmHeader): number => {
  const table = header.entries.get(100);
  if (table === undefined || !("values" in table)) return 0;
  const index = (table.values as readonly unknown[]).indexOf("C");
  return index < 0 ? 0 : index;
};
