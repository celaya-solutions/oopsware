/**
 * PDF object syntax (ISO 32000-1 section 7.3): one tolerant lexer and object
 * parser shared by the file structure reader and the content stream scanner.
 * Everything is bounded: container depth, nodes per object and string length.
 * Dictionaries are `Map`s so a hostile key can never reach a prototype.
 */

export class PdfSyntaxError extends Error {
  readonly _tag = "PdfSyntaxError";
}

export interface PdfName {
  readonly t: "name";
  readonly v: string;
}
export interface PdfString {
  readonly t: "str";
  readonly bytes: Uint8Array;
}
export interface PdfRef {
  readonly t: "ref";
  readonly num: number;
  readonly gen: number;
}
export interface PdfDict {
  readonly t: "dict";
  readonly map: Map<string, PdfValue>;
}
export interface PdfArray {
  readonly t: "arr";
  readonly items: PdfValue[];
}
/** A stream's dictionary and where its data starts; the length is settled by the file. */
export interface PdfStream {
  readonly t: "stream";
  readonly dict: PdfDict;
  readonly start: number;
  readonly num: number;
  readonly gen: number;
}
export interface PdfKeyword {
  readonly t: "kw";
  readonly v: string;
}
export type PdfValue =
  | null
  | boolean
  | number
  | PdfName
  | PdfString
  | PdfRef
  | PdfDict
  | PdfArray
  | PdfStream;

/** Returned at the end of the input. */
export const END = Symbol("end");

export interface LexerLimits {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxStringBytes: number;
}

export const OBJECT_LIMITS: LexerLimits = {
  maxDepth: 64,
  maxNodes: 2_000_000,
  maxStringBytes: 16 * 1024 ** 2,
};

const WHITESPACE = new Uint8Array(256);
for (const code of [0, 9, 10, 12, 13, 32]) WHITESPACE[code] = 1;
const DELIMITER = new Uint8Array(256);
for (const char of "()<>[]{}/%") DELIMITER[char.charCodeAt(0)] = 1;

export const isSpace = (code: number | undefined): boolean =>
  code !== undefined && WHITESPACE[code] === 1;
const isRegular = (code: number | undefined): boolean =>
  code !== undefined && WHITESPACE[code] === 0 && DELIMITER[code] === 0;
const isDigit = (code: number | undefined): boolean =>
  code !== undefined && code >= 0x30 && code <= 0x39;

// No alternation can match the same digits two ways, so a long digit run cannot backtrack.
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u;
const utf8 = new TextDecoder("utf-8", { fatal: true });

export const name = (v: string): PdfName => ({ t: "name", v });
export const keyword = (v: string): PdfKeyword => ({ t: "kw", v });

const hexValue = (code: number): number =>
  code >= 0x30 && code <= 0x39
    ? code - 0x30
    : code >= 0x41 && code <= 0x46
      ? code - 0x37
      : code >= 0x61 && code <= 0x66
        ? code - 0x57
        : -1;

export class Lexer {
  pos: number;
  /** Where the last value or keyword started, so a caller can push a stray keyword back. */
  tokenStart: number;
  nodes = 0;
  /** A container ran into the end of the input before it closed. */
  truncated = false;

  constructor(
    readonly bytes: Uint8Array,
    pos = 0,
    readonly end = bytes.length,
    readonly limits: LexerLimits = OBJECT_LIMITS,
  ) {
    this.pos = pos;
    this.tokenStart = pos;
  }

  skipSpace(): void {
    const { bytes, end } = this;
    while (this.pos < end) {
      const code = bytes[this.pos] as number;
      if (WHITESPACE[code] === 1) this.pos += 1;
      else if (code === 0x25) {
        while (this.pos < end) {
          const next = bytes[this.pos] as number;
          if (next === 10 || next === 13) break;
          this.pos += 1;
        }
      } else break;
    }
  }

  /** One value, or the keyword that stands where a value should be. */
  readValue(depth = 0): PdfValue | PdfKeyword | typeof END {
    this.skipSpace();
    if (this.pos >= this.end) return END;
    this.nodes += 1;
    if (this.nodes > this.limits.maxNodes)
      throw new PdfSyntaxError(
        `An object has more than ${String(this.limits.maxNodes)} tokens.`,
      );
    this.tokenStart = this.pos;
    const code = this.bytes[this.pos] as number;
    switch (code) {
      case 0x2f:
        return this.#name();
      case 0x28:
        return this.#literal();
      case 0x3c:
        if (this.bytes[this.pos + 1] === 0x3c) {
          this.pos += 2;
          return this.#dict(depth + 1);
        }
        return this.#hex();
      case 0x3e:
        if (this.bytes[this.pos + 1] === 0x3e) {
          this.pos += 2;
          return keyword(">>");
        }
        this.pos += 1;
        return keyword(">");
      case 0x5b:
        this.pos += 1;
        return this.#array(depth + 1);
      case 0x5d:
        this.pos += 1;
        return keyword("]");
      case 0x7b:
      case 0x7d:
      case 0x29:
        this.pos += 1;
        return keyword(String.fromCharCode(code));
      default:
        return this.#word();
    }
  }

  #regularEnd(from: number): number {
    let at = from;
    while (at < this.end && isRegular(this.bytes[at])) at += 1;
    return at;
  }

  #word(): PdfValue | PdfKeyword {
    const start = this.pos;
    const stop = this.#regularEnd(start);
    this.pos = stop;
    const word = latin1(this.bytes, start, stop);
    if (NUMBER.test(word)) {
      const value = Number(word);
      if (/^\d+$/u.test(word)) return this.#reference(value, start);
      return value;
    }
    if (word === "true") return true;
    if (word === "false") return false;
    if (word === "null") return null;
    return keyword(word);
  }

  /** `N G R` after the number N, or the plain number when no generation and R follow. */
  #reference(num: number, start: number): PdfValue {
    const after = this.pos;
    this.skipSpace();
    const genStart = this.pos;
    let at = genStart;
    while (at < this.end && isDigit(this.bytes[at])) at += 1;
    if (at > genStart && at - genStart <= 5 && at < this.end) {
      const gen = Number(latin1(this.bytes, genStart, at));
      this.pos = at;
      this.skipSpace();
      if (
        this.bytes[this.pos] === 0x52 &&
        !isRegular(this.bytes[this.pos + 1]) &&
        this.pos > at
      ) {
        this.pos += 1;
        return { t: "ref", num, gen };
      }
    }
    this.pos = after;
    this.tokenStart = start;
    return num;
  }

  #name(): PdfName {
    let at = this.pos + 1;
    const stop = this.#regularEnd(at);
    const raw: number[] = [];
    while (at < stop) {
      const code = this.bytes[at] as number;
      const high = hexValue(this.bytes[at + 1] ?? 0);
      const low = hexValue(this.bytes[at + 2] ?? 0);
      if (code === 0x23 && high >= 0 && low >= 0) {
        raw.push(high * 16 + low);
        at += 3;
      } else {
        raw.push(code);
        at += 1;
      }
    }
    this.pos = stop;
    const bytes = Uint8Array.from(raw);
    try {
      return name(utf8.decode(bytes));
    } catch {
      return name(latin1(bytes, 0, bytes.length));
    }
  }

  #literal(): PdfString {
    const out: number[] = [];
    let depth = 1;
    let at = this.pos + 1;
    const { bytes, end } = this;
    while (at < end) {
      const code = bytes[at] as number;
      at += 1;
      if (code === 0x5c) {
        const next = bytes[at];
        at += 1;
        if (next === undefined) break;
        if (next === 0x6e) out.push(10);
        else if (next === 0x72) out.push(13);
        else if (next === 0x74) out.push(9);
        else if (next === 0x62) out.push(8);
        else if (next === 0x66) out.push(12);
        else if (next >= 0x30 && next <= 0x37) {
          let value = next - 0x30;
          for (let digits = 1; digits < 3; digits += 1) {
            const more = bytes[at];
            if (more === undefined || more < 0x30 || more > 0x37) break;
            value = value * 8 + (more - 0x30);
            at += 1;
          }
          out.push(value & 0xff);
        } else if (next === 13) {
          if (bytes[at] === 10) at += 1;
        } else if (next !== 10) out.push(next);
      } else if (code === 0x28) {
        depth += 1;
        out.push(code);
      } else if (code === 0x29) {
        depth -= 1;
        if (depth === 0) {
          this.pos = at;
          return { t: "str", bytes: Uint8Array.from(out) };
        }
        out.push(code);
      } else if (code === 13) {
        if (bytes[at] === 10) at += 1;
        out.push(10);
      } else out.push(code);
      if (out.length > this.limits.maxStringBytes)
        throw new PdfSyntaxError(
          `A string is longer than ${String(this.limits.maxStringBytes)} bytes.`,
        );
    }
    this.pos = end;
    this.truncated = true;
    return { t: "str", bytes: Uint8Array.from(out) };
  }

  #hex(): PdfString {
    const out: number[] = [];
    let at = this.pos + 1;
    let high = -1;
    const { bytes, end } = this;
    while (at < end) {
      const code = bytes[at] as number;
      at += 1;
      if (code === 0x3e) break;
      const value = hexValue(code);
      if (value < 0) continue;
      if (high < 0) high = value;
      else {
        out.push(high * 16 + value);
        high = -1;
      }
      if (out.length > this.limits.maxStringBytes)
        throw new PdfSyntaxError(
          `A string is longer than ${String(this.limits.maxStringBytes)} bytes.`,
        );
    }
    if (high >= 0) out.push(high * 16);
    this.pos = at;
    return { t: "str", bytes: Uint8Array.from(out) };
  }

  #array(depth: number): PdfArray {
    if (depth > this.limits.maxDepth)
      throw new PdfSyntaxError("Containers are nested too deeply.");
    const items: PdfValue[] = [];
    for (;;) {
      const value = this.readValue(depth);
      if (value === END) {
        this.truncated = true;
        break;
      }
      if (isKeyword(value)) {
        if (value.v === "]") break;
        if (STRUCTURAL.has(value.v)) {
          this.pos = this.tokenStart;
          this.truncated = true;
          break;
        }
        continue;
      }
      items.push(value);
    }
    return { t: "arr", items };
  }

  #dict(depth: number): PdfDict {
    if (depth > this.limits.maxDepth)
      throw new PdfSyntaxError("Containers are nested too deeply.");
    const map = new Map<string, PdfValue>();
    for (;;) {
      const key = this.readValue(depth);
      if (key === END) {
        this.truncated = true;
        break;
      }
      if (isKeyword(key)) {
        if (key.v === ">>") break;
        if (STRUCTURAL.has(key.v)) {
          this.pos = this.tokenStart;
          this.truncated = true;
          break;
        }
        continue;
      }
      if (typeof key !== "object" || key === null || key.t !== "name") continue;
      const value = this.readValue(depth);
      if (value === END) {
        this.truncated = true;
        break;
      }
      if (isKeyword(value)) {
        if (value.v === ">>") break;
        if (STRUCTURAL.has(value.v)) {
          this.pos = this.tokenStart;
          this.truncated = true;
          break;
        }
        continue;
      }
      map.set(key.v, value);
    }
    return { t: "dict", map };
  }
}

/** Keywords that end an object; meeting one inside a container means the container was never closed. */
const STRUCTURAL = new Set([
  "endobj",
  "stream",
  "endstream",
  "obj",
  "xref",
  "trailer",
  "startxref",
]);

export const isKeyword = (value: unknown): value is PdfKeyword =>
  typeof value === "object" &&
  value !== null &&
  (value as { t?: unknown }).t === "kw";

export const latin1 = (
  bytes: Uint8Array,
  start: number,
  stop: number,
): string => {
  let out = "";
  for (let at = start; at < stop; at += 1)
    out += String.fromCharCode(bytes[at] as number);
  return out;
};

export interface IndirectObject {
  readonly num: number;
  readonly gen: number;
  readonly value: PdfValue;
  /** The object ended without `endobj`, or a container inside it never closed. */
  readonly damaged: boolean;
}

/** `N G obj <value> [stream]` at `offset`, or null when no object starts there. */
export const readIndirectObject = (
  bytes: Uint8Array,
  offset: number,
): IndirectObject | null => {
  const lexer = new Lexer(bytes, offset);
  lexer.skipSpace();
  const first = readInteger(lexer);
  const second = readInteger(lexer);
  if (first === null || second === null) return null;
  lexer.skipSpace();
  const marker = lexer.pos;
  if (
    bytes[marker] !== 0x6f ||
    bytes[marker + 1] !== 0x62 ||
    bytes[marker + 2] !== 0x6a ||
    isRegular(bytes[marker + 3])
  )
    return null;
  lexer.pos = marker + 3;
  const parsed = lexer.readValue();
  if (parsed === END)
    return { num: first, gen: second, value: null, damaged: true };
  let value: PdfValue;
  if (isKeyword(parsed)) {
    value = null;
    if (parsed.v === "endobj")
      return { num: first, gen: second, value, damaged: false };
  } else value = parsed;
  let damaged = lexer.truncated;
  if (typeof value === "object" && value !== null && value.t === "dict") {
    lexer.skipSpace();
    const at = lexer.pos;
    if (
      bytes[at] === 0x73 &&
      latin1(bytes, at, at + 6) === "stream" &&
      !isRegular(bytes[at + 6])
    ) {
      let start = at + 6;
      if (bytes[start] === 13 && bytes[start + 1] === 10) start += 2;
      else if (bytes[start] === 10 || bytes[start] === 13) start += 1;
      return {
        num: first,
        gen: second,
        value: { t: "stream", dict: value, start, num: first, gen: second },
        damaged,
      };
    }
  }
  const tail = lexer.readValue();
  if (!(isKeyword(tail) && tail.v === "endobj")) damaged = true;
  return { num: first, gen: second, value, damaged };
};

const readInteger = (lexer: Lexer): number | null => {
  lexer.skipSpace();
  const start = lexer.pos;
  let at = start;
  while (at < lexer.end && isDigit(lexer.bytes[at])) at += 1;
  if (at === start || at - start > 10 || !isSpace(lexer.bytes[at])) return null;
  lexer.pos = at;
  return Number(latin1(lexer.bytes, start, at));
};

export const asDict = (value: PdfValue | undefined): PdfDict | null =>
  typeof value === "object" && value !== null
    ? value.t === "dict"
      ? value
      : value.t === "stream"
        ? value.dict
        : null
    : null;
export const asArray = (value: PdfValue | undefined): PdfArray | null =>
  typeof value === "object" && value !== null && value.t === "arr"
    ? value
    : null;
export const asName = (value: PdfValue | undefined): string | null =>
  typeof value === "object" && value !== null && value.t === "name"
    ? value.v
    : null;
/** A finite number; a 400-digit token parses to Infinity and is not one. */
export const asNumber = (value: PdfValue | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
/** An integer a report can carry: safe, so it round-trips the output schema. */
export const asInt = (value: PdfValue | undefined): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) ? value : null;
/** A non-negative safe integer: a size, count, generation or object number. */
export const asCount = (value: PdfValue | undefined): number | null => {
  const int = asInt(value);
  return int !== null && int >= 0 ? int : null;
};
export const asString = (value: PdfValue | undefined): PdfString | null =>
  typeof value === "object" && value !== null && value.t === "str"
    ? value
    : null;
export const asStream = (value: PdfValue | undefined): PdfStream | null =>
  typeof value === "object" && value !== null && value.t === "stream"
    ? value
    : null;
export const asRef = (value: PdfValue | undefined): PdfRef | null =>
  typeof value === "object" && value !== null && value.t === "ref"
    ? value
    : null;
