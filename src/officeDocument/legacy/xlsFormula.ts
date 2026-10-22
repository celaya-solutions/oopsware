import {
  bytesReader,
  columnName,
  ERRORS,
  shortString,
  xlString,
  type ContinuedReader,
} from "./xlsRecords.js";
import { COMMANDS, FUNCTIONS } from "./xlsFunctions.js";

/**
 * BIFF8 formula tokens ([MS-XLS] 2.5.198) turned into A1-style formula text.
 * The token stream is reverse Polish, so the text is built on a stack; nothing
 * is evaluated. A token this decoder does not know stops the formula: its text
 * is then not given at all, never guessed.
 */

export interface FormulaContext {
  /** The cell the formula belongs to; PtgRefN and PtgAreaN offsets count from it. */
  readonly row: number;
  readonly col: number;
  /** A defined name by its one-based NAME index. */
  readonly name: (index: number) => string | undefined;
  /** What an XTI index stands for before "!" (quoted where the syntax needs it). */
  readonly sheets: (ixti: number) => string | undefined;
  /** An external name by XTI index and one-based ExternName index, as a formula writes it. */
  readonly externName: (ixti: number, index: number) => string | undefined;
}

export type DecodedFormula =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly ptg: number; readonly reason: string };

const BINARY: ReadonlyMap<number, string> = new Map([
  [0x03, "+"],
  [0x04, "-"],
  [0x05, "*"],
  [0x06, "/"],
  [0x07, "^"],
  [0x08, "&"],
  [0x09, "<"],
  [0x0a, "<="],
  [0x0b, "="],
  [0x0c, ">="],
  [0x0d, ">"],
  [0x0e, "<>"],
  [0x0f, " "],
  [0x10, ","],
  [0x11, ":"],
]);

const quoteString = (text: string): string => `"${text.replaceAll('"', '""')}"`;

/** A number as formula text; Excel writes the exponent with a capital E. */
const numberText = (value: number): string => String(value).toUpperCase();

class Unsupported extends Error {}

/** Excel's own limit is 8,192 characters; text past four times that is not a formula Excel wrote. */
const MAX_FORMULA_TEXT = 32_768;

interface Part {
  readonly col: string;
  readonly row: string;
  readonly rowIndex: number;
  readonly colIndex: number;
}

/**
 * One end of a reference. Bit 15 of the column field marks a relative row and
 * bit 14 a relative column ([MS-XLS] 2.5.51 ColRelU). In PtgRefN/PtgAreaN a
 * relative part is an offset from the formula's cell, wrapped to the grid as
 * the spec says (65,536 rows, 256 columns).
 */
const part = (
  row: number,
  field: number,
  relative: boolean,
  context: FormulaContext,
): Part => {
  const rowRel = (field & 0x8000) !== 0;
  const colRel = (field & 0x4000) !== 0;
  const rowIndex =
    relative && rowRel ? (context.row + row) & 0xffff : row & 0xffff;
  const colIndex =
    relative && colRel ? (context.col + field) & 0xff : field & 0x3fff;
  if (colIndex > 0xff) throw new Unsupported("a column past IV");
  return {
    col: `${colRel ? "" : "$"}${columnName(colIndex)}`,
    row: `${rowRel ? "" : "$"}${String(rowIndex + 1)}`,
    rowIndex,
    colIndex,
  };
};

const areaText = (first: Part, last: Part): string => {
  if (first.rowIndex === 0 && last.rowIndex === 0xffff)
    return `${first.col}:${last.col}`;
  if (first.colIndex === 0 && last.colIndex === 0xff)
    return `${first.row}:${last.row}`;
  return `${first.col}${first.row}:${last.col}${last.row}`;
};

/** One SerAr value of an array constant ([MS-XLS] 2.5.200). */
const arrayValue = (extra: ContinuedReader): string => {
  const kind = extra.u8();
  switch (kind) {
    case 0x00:
      extra.skip(8);
      return "";
    case 0x01: {
      const value = extra.f64();
      if (!Number.isFinite(value)) throw new Unsupported("a non-finite number");
      return numberText(value);
    }
    case 0x02:
      return quoteString(xlString(extra));
    case 0x04: {
      const value = extra.u8();
      extra.skip(7);
      return value === 0 ? "FALSE" : "TRUE";
    }
    case 0x10: {
      const error = ERRORS.get(extra.u8());
      extra.skip(7);
      if (error === undefined) throw new Unsupported("an unknown error code");
      return error;
    }
    default:
      throw new Unsupported(`array value type 0x${kind.toString(16)}`);
  }
};

/** PtgExtraArray: one less than the column and row counts, then the values row by row. */
const arrayConstant = (extra: ContinuedReader): string => {
  const cols = extra.u8() + 1;
  const rows = extra.u16() + 1;
  const lines: string[] = [];
  for (let row = 0; row < rows; row += 1) {
    const values: string[] = [];
    for (let col = 0; col < cols; col += 1) values.push(arrayValue(extra));
    lines.push(values.join(","));
  }
  return `{${lines.join(";")}}`;
};

class Decoder {
  readonly #rgce: Uint8Array;
  readonly #view: DataView;
  readonly #extra: ContinuedReader;
  readonly #context: FormulaContext;
  readonly stack: string[] = [];
  /** Characters held on the stack; capped as a whole, so no mix of tokens can pile up text. */
  #total = 0;
  at = 0;

  constructor(rgce: Uint8Array, extra: Uint8Array, context: FormulaContext) {
    this.#rgce = rgce;
    this.#view = new DataView(rgce.buffer, rgce.byteOffset, rgce.byteLength);
    this.#extra = bytesReader(extra);
    this.#context = context;
  }

  #u8(): number {
    if (this.at >= this.#rgce.length) throw new RangeError("cut off");
    return this.#rgce[this.at++] ?? 0;
  }

  #u16(): number {
    const value = this.#view.getUint16(this.at, true);
    this.at += 2;
    return value;
  }

  #u32(): number {
    const value = this.#view.getUint32(this.at, true);
    this.at += 4;
    return value;
  }

  /** Every value goes through here, so the text on the stack never passes the cap however tokens combine. */
  #push(text: string): void {
    if (this.#total + text.length > MAX_FORMULA_TEXT)
      throw new Unsupported(
        `formula text longer than ${String(MAX_FORMULA_TEXT)} characters`,
      );
    this.#total += text.length;
    this.stack.push(text);
  }

  #pop(): string {
    const value = this.stack.pop();
    if (value === undefined)
      throw new Unsupported("an operator without its operand");
    this.#total -= value.length;
    return value;
  }

  #args(count: number): string[] {
    if (count > this.stack.length)
      throw new Unsupported("a function with more arguments than values");
    const args = this.stack.splice(this.stack.length - count, count);
    for (const arg of args) this.#total -= arg.length;
    return args;
  }

  #ref(relative: boolean): string {
    const row = this.#u16();
    const p = part(row, this.#u16(), relative, this.#context);
    return `${p.col}${p.row}`;
  }

  #area(relative: boolean): string {
    const rowFirst = this.#u16();
    const rowLast = this.#u16();
    const colFirst = this.#u16();
    const colLast = this.#u16();
    return areaText(
      part(rowFirst, colFirst, relative, this.#context),
      part(rowLast, colLast, relative, this.#context),
    );
  }

  #sheet(): string {
    const prefix = this.#context.sheets(this.#u16());
    if (prefix === undefined)
      throw new Unsupported("an unknown sheet reference");
    return prefix;
  }

  /** Tokens below 0x20: operators, constants and attributes. */
  base(ptg: number): void {
    const operator = BINARY.get(ptg);
    if (operator !== undefined) {
      const right = this.#pop();
      this.#push(`${this.#pop()}${operator}${right}`);
      return;
    }
    switch (ptg) {
      case 0x12:
        this.#push(`+${this.#pop()}`);
        return;
      case 0x13:
        this.#push(`-${this.#pop()}`);
        return;
      case 0x14:
        this.#push(`${this.#pop()}%`);
        return;
      case 0x15:
        this.#push(`(${this.#pop()})`);
        return;
      case 0x16:
        this.#push("");
        return;
      case 0x17: {
        const reader = bytesReader(this.#rgce.subarray(this.at));
        this.#push(quoteString(shortString(reader)));
        this.at += reader.position;
        return;
      }
      case 0x19:
        this.#attribute();
        return;
      case 0x1c: {
        const error = ERRORS.get(this.#u8());
        if (error === undefined) throw new Unsupported("an unknown error code");
        this.#push(error);
        return;
      }
      case 0x1d: {
        const value = this.#u8();
        if (value > 1)
          throw new Unsupported("a Boolean that is neither 0 nor 1");
        this.#push(value === 1 ? "TRUE" : "FALSE");
        return;
      }
      case 0x1e:
        this.#push(String(this.#u16()));
        return;
      case 0x1f: {
        const value = this.#view.getFloat64(this.at, true);
        this.at += 8;
        if (!Number.isFinite(value))
          throw new Unsupported("a non-finite number");
        this.#push(numberText(value));
        return;
      }
      default:
        throw new Unsupported("a token this reader does not decode");
    }
  }

  /** PtgAttr*: only SUM changes the text; the others steer evaluation or spacing. */
  #attribute(): void {
    const kind = this.#u8();
    const data = this.#u16();
    switch (kind) {
      case 0x01:
      case 0x02:
      case 0x08:
      case 0x40:
      case 0x41:
        return;
      case 0x04:
        this.at += 2 * (data + 1);
        if (this.at > this.#rgce.length) throw new RangeError("cut off");
        return;
      case 0x10:
        this.#push(`SUM(${this.#pop()})`);
        return;
      default:
        throw new Unsupported(`attribute 0x${kind.toString(16)}`);
    }
  }

  #call(index: number, count: number, command: boolean): void {
    const args = this.#args(count);
    if (!command && index === 0xff) {
      const [name, ...rest] = args;
      if (name === undefined)
        throw new Unsupported("a user-defined call without a name");
      this.#push(`${name}(${rest.join(",")})`);
      return;
    }
    const name = command ? COMMANDS.get(index) : FUNCTIONS.get(index)?.name;
    if (name === undefined) throw new Unsupported("an unknown function");
    this.#push(`${name}(${args.join(",")})`);
  }

  /** Cell and range operands: plain, relative to the formula's cell (N), on other sheets (3d), or deleted (Err). */
  #reference(base: number): boolean {
    switch (base) {
      case 0x24:
        this.#push(this.#ref(false));
        return true;
      case 0x25:
        this.#push(this.#area(false));
        return true;
      case 0x2a:
        this.at += 4;
        this.#push("#REF!");
        return true;
      case 0x2b:
        this.at += 8;
        this.#push("#REF!");
        return true;
      case 0x2c:
        this.#push(this.#ref(true));
        return true;
      case 0x2d:
        this.#push(this.#area(true));
        return true;
      case 0x3a:
        this.#push(`${this.#sheet()}!${this.#ref(false)}`);
        return true;
      case 0x3b:
        this.#push(`${this.#sheet()}!${this.#area(false)}`);
        return true;
      case 0x3c:
      case 0x3d:
        this.#push(`${this.#sheet()}!#REF!`);
        this.at += base === 0x3c ? 4 : 8;
        return true;
      default:
        return false;
    }
  }

  /** Tokens 0x20 to 0x7F: operands and calls, in their reference, value or array class. */
  classified(ptg: number): void {
    const base = (ptg & 0x1f) | 0x20;
    if (this.#reference(base)) return;
    switch (base) {
      case 0x20:
        this.at += 7;
        this.#push(arrayConstant(this.#extra));
        return;
      case 0x21: {
        const fn = FUNCTIONS.get(this.#u16());
        if (fn?.args == null)
          throw new Unsupported("an unknown fixed function");
        this.#push(`${fn.name}(${this.#args(fn.args).join(",")})`);
        return;
      }
      case 0x22: {
        const count = this.#u8();
        const tab = this.#u16();
        this.#call(tab & 0x7fff, count, (tab & 0x8000) !== 0);
        return;
      }
      case 0x23: {
        const name = this.#context.name(this.#u32());
        if (name === undefined)
          throw new Unsupported("an unknown defined name");
        this.#push(name);
        return;
      }
      // PtgMemArea, PtgMemErr, PtgMemNoMem and PtgMemFunc only frame the expression that follows.
      case 0x26:
        this.at += 6;
        this.#extra.skip(this.#extra.u16() * 8);
        return;
      case 0x27:
      case 0x28:
        this.at += 6;
        return;
      case 0x29:
        this.at += 2;
        return;
      case 0x39: {
        const ixti = this.#u16();
        const name = this.#context.externName(ixti, this.#u32());
        if (name === undefined)
          throw new Unsupported("an unknown external name");
        this.#push(name);
        return;
      }
      default:
        throw new Unsupported("a token this reader does not decode");
    }
  }
}

/** Decode a token stream (rgce) with its extra data (RgbExtra) into formula text. */
export const decodeFormula = (
  rgce: Uint8Array,
  extra: Uint8Array,
  context: FormulaContext,
): DecodedFormula => {
  const decoder = new Decoder(rgce, extra, context);
  let ptg = -1;
  try {
    while (decoder.at < rgce.length) {
      ptg = rgce[decoder.at] ?? 0;
      decoder.at += 1;
      if (ptg < 0x20) decoder.base(ptg);
      else if (ptg < 0x80) decoder.classified(ptg);
      else throw new Unsupported("a token this reader does not decode");
    }
    if (decoder.at !== rgce.length)
      return { ok: false, ptg, reason: "the token stream is cut off" };
    const [text] = decoder.stack;
    if (decoder.stack.length !== 1 || text === undefined)
      return {
        ok: false,
        ptg,
        reason: "the tokens do not reduce to one value",
      };
    return { ok: true, text };
  } catch (cause) {
    if (cause instanceof Unsupported)
      return { ok: false, ptg, reason: cause.message };
    if (cause instanceof RangeError)
      return { ok: false, ptg, reason: "the token stream is cut off" };
    throw cause;
  }
};
