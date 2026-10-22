import type { BytecodeProfile } from "./profiles.js";

/**
 * A bounded reader for CPython's marshal format (versions 4-6) as written
 * into .pyc files. Values become plain data; nothing is evaluated, imported or
 * handed to an interpreter. Every length is checked against the remaining
 * bytes before it is used, nesting and object counts are capped, and a
 * reference to an object that is still being read is refused.
 */

export type PyValue =
  | { readonly t: "none" | "ellipsis" | "stop-iteration" | "null" }
  | { readonly t: "bool"; readonly v: boolean }
  | { readonly t: "int"; readonly v: bigint }
  | { readonly t: "float"; readonly v: number }
  | { readonly t: "complex"; readonly real: number; readonly imag: number }
  | { readonly t: "bytes"; readonly v: Uint8Array }
  | {
      readonly t: "str";
      readonly v: string;
      /**
       * Code points, kept only when the text holds encoded surrogates: a
       * Python string may hold a high and a low surrogate as two code points,
       * which a JavaScript string would read as one character.
       */
      readonly points?: readonly number[];
    }
  | {
      readonly t: "tuple" | "list" | "set" | "frozenset";
      readonly items: PyValue[];
    }
  | {
      readonly t: "dict" | "frozendict";
      readonly entries: [PyValue, PyValue][];
    }
  | {
      readonly t: "slice";
      readonly start: PyValue;
      readonly stop: PyValue;
      readonly step: PyValue;
    }
  | { readonly t: "code"; readonly code: CodeObject };

export interface LocalPlus {
  readonly name: string;
  /** CO_FAST_* bits (3.11+); 3.8-3.10 values are synthesized from the name lists. */
  readonly kind: number;
}

export interface CodeObject {
  readonly argcount: number;
  readonly posonlyargcount: number;
  readonly kwonlyargcount: number;
  readonly nlocals: number;
  readonly stacksize: number;
  readonly flags: number;
  readonly code: Uint8Array;
  readonly consts: PyValue[];
  readonly names: string[];
  readonly varnames: string[];
  readonly cellvars: string[];
  readonly freevars: string[];
  /** The names an instruction's local/cell/free argument indexes. */
  readonly localsplus: LocalPlus[];
  readonly filename: string;
  readonly name: string;
  /** co_qualname from 3.11; null before it existed. */
  readonly qualname: string | null;
  readonly firstlineno: number;
  /** co_lnotab (3.8-3.9), co_linetable (3.10+). */
  readonly linetable: Uint8Array;
  /** Empty before 3.11. */
  readonly exceptiontable: Uint8Array;
  /** Byte offset of this code object's type byte in the marshal data. */
  readonly offset: number;
}

export class MarshalError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(`${message} (marshal byte ${String(offset)})`);
    this.name = "MarshalError";
  }
}

export const CO_FAST_HIDDEN = 0x10;
export const CO_FAST_LOCAL = 0x20;
export const CO_FAST_CELL = 0x40;
export const CO_FAST_FREE = 0x80;

/** CPython's own marshal nesting limit. */
const MAX_DEPTH = 2000;
const FLAG_REF = 0x80;

/** A placeholder for an object whose reference slot is reserved but not yet filled. */
const PENDING: PyValue = { t: "null" };

export interface MarshalLimits {
  /**
   * Most objects one load may create, counting nested ones. A shared object
   * counts each time a reference uses it: callers walk the value as a tree.
   */
  readonly maxObjects: number;
}

// ignoreBOM keeps a leading U+FEFF: it is part of the string, not a marker.
const utf8Strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** True ISO-8859-1 (the WHATWG "latin1" label is windows-1252), as CPython reads 1-byte strings. */
export const latin1 = (bytes: Uint8Array): string => {
  let text = "";
  for (let start = 0; start < bytes.length; start += 8192)
    text += String.fromCharCode(...bytes.subarray(start, start + 8192));
  return text;
};

/**
 * Decode UTF-8 as CPython's "surrogatepass" does: well-formed text, plus
 * encoded surrogates (U+D800-U+DFFF), whose code points are then kept.
 */
const utf8SurrogatePass = (
  bytes: Uint8Array,
  at: number,
): { text: string; points?: number[] } => {
  try {
    return { text: utf8Strict.decode(bytes) };
  } catch {
    // Fall through to the slow path, which also accepts encoded surrogates.
  }
  let text = "";
  const points: number[] = [];
  let index = 0;
  while (index < bytes.length) {
    const first = bytes[index] ?? 0;
    let point: number;
    let size: number;
    if (first < 0x80) {
      point = first;
      size = 1;
    } else if (first >= 0xc2 && first < 0xe0) {
      point = first & 0x1f;
      size = 2;
    } else if (first >= 0xe0 && first < 0xf0) {
      point = first & 0x0f;
      size = 3;
    } else if (first >= 0xf0 && first < 0xf5) {
      point = first & 0x07;
      size = 4;
    } else throw new MarshalError("Invalid UTF-8 in a string", at + index);
    if (index + size > bytes.length)
      throw new MarshalError("Truncated UTF-8 in a string", at + index);
    for (let next = 1; next < size; next += 1) {
      const byte = bytes[index + next] ?? 0;
      if ((byte & 0xc0) !== 0x80)
        throw new MarshalError("Invalid UTF-8 in a string", at + index);
      point = (point << 6) | (byte & 0x3f);
    }
    const minimum = [0, 0, 0x80, 0x800, 0x10000][size] ?? 0;
    if (point < minimum || point > 0x10ffff)
      throw new MarshalError("Overlong or out-of-range UTF-8", at + index);
    text += String.fromCodePoint(point);
    points.push(point);
    index += size;
  }
  return { text, points };
};

export class MarshalReader {
  readonly #bytes: Uint8Array;
  readonly #view: DataView;
  readonly #profile: BytecodeProfile;
  readonly #limits: MarshalLimits;
  readonly #refs: PyValue[] = [];
  /** Objects each reference slot stands for once expanded, parallel to `#refs`. */
  readonly #refWeights: number[] = [];
  #at: number;
  #depth = 0;
  #objects = 0;

  constructor(
    bytes: Uint8Array,
    start: number,
    profile: BytecodeProfile,
    limits: MarshalLimits,
  ) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.#at = start;
    this.#profile = profile;
    this.#limits = limits;
  }

  get offset(): number {
    return this.#at;
  }

  #need(count: number): void {
    if (count < 0 || this.#at + count > this.#bytes.length)
      throw new MarshalError(
        `Needs ${String(count)} more bytes but the data ends`,
        this.#at,
      );
  }

  #u8(): number {
    this.#need(1);
    const value = this.#bytes[this.#at] ?? 0;
    this.#at += 1;
    return value;
  }

  #i32(): number {
    this.#need(4);
    const value = this.#view.getInt32(this.#at, true);
    this.#at += 4;
    return value;
  }

  #f64(): number {
    this.#need(8);
    const value = this.#view.getFloat64(this.#at, true);
    this.#at += 8;
    return value;
  }

  #take(count: number): Uint8Array {
    this.#need(count);
    const slice = this.#bytes.subarray(this.#at, this.#at + count);
    this.#at += count;
    return slice;
  }

  #size(): number {
    const at = this.#at;
    const size = this.#i32();
    if (size < 0) throw new MarshalError("Negative length", at);
    return size;
  }

  /** A count of nested objects; each needs at least one byte, so it is bounded by the data. */
  #count(size: number, at: number): number {
    if (size > this.#bytes.length - this.#at)
      throw new MarshalError(
        `Declares ${String(size)} items, more than the remaining bytes`,
        at,
      );
    return size;
  }

  #textFloat(): number {
    const at = this.#at;
    const length = this.#u8();
    const text = latin1(this.#take(length));
    const value = Number(text);
    if (
      !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$|^[+-]?(?:inf|nan)$/iu.test(
        text,
      )
    )
      throw new MarshalError(
        `Unreadable text float ${JSON.stringify(text)}`,
        at,
      );
    return /inf/iu.test(text)
      ? text.startsWith("-")
        ? -Infinity
        : Infinity
      : /nan/iu.test(text)
        ? Number.NaN
        : value;
  }

  #long(at: number): bigint {
    const declared = this.#i32();
    const digits = Math.abs(declared);
    this.#need(digits * 2);
    let value = 0n;
    for (let index = digits - 1; index >= 0; index -= 1) {
      const digit = this.#view.getUint16(this.#at + index * 2, true);
      if (digit > 0x7fff) throw new MarshalError("Long digit out of range", at);
      value = (value << 15n) | BigInt(digit);
    }
    if (
      digits > 0 &&
      this.#view.getUint16(this.#at + (digits - 1) * 2, true) === 0
    )
      throw new MarshalError("Unnormalized long", at);
    this.#at += digits * 2;
    return declared < 0 ? -value : value;
  }

  #charge(objects: number, at: number): void {
    this.#objects += objects;
    if (this.#objects > this.#limits.maxObjects)
      throw new MarshalError(
        `Objects expand to more than ${String(this.#limits.maxObjects)} (a shared object counts each time it is used)`,
        at,
      );
  }

  /** Read one object; `allowNull` is only true where marshal writes a NULL terminator. */
  read(allowNull = false): PyValue {
    const at = this.#at;
    if (this.#depth >= MAX_DEPTH)
      throw new MarshalError("Nested deeper than CPython's marshal limit", at);
    const before = this.#objects;
    this.#charge(1, at);
    const byte = this.#u8();
    const flag = (byte & FLAG_REF) !== 0;
    const type = String.fromCharCode(byte & ~FLAG_REF);
    let slot = -1;
    const reserve = () => {
      if (flag) {
        slot = this.#refs.length;
        this.#refs.push(PENDING);
        this.#refWeights.push(0);
      }
    };
    const keep = (value: PyValue): PyValue => {
      if (flag) {
        if (slot === -1) {
          slot = this.#refs.length;
          this.#refs.push(value);
          this.#refWeights.push(0);
        } else this.#refs[slot] = value;
        this.#refWeights[slot] = this.#objects - before;
      }
      return value;
    };
    this.#depth += 1;
    try {
      switch (type) {
        case "0":
          if (!allowNull) throw new MarshalError("Unexpected NULL object", at);
          return { t: "null" };
        case "N":
          return keep({ t: "none" });
        case "F":
          return keep({ t: "bool", v: false });
        case "T":
          return keep({ t: "bool", v: true });
        case ".":
          return keep({ t: "ellipsis" });
        case "S":
          return keep({ t: "stop-iteration" });
        case "i":
          return keep({ t: "int", v: BigInt(this.#i32()) });
        case "l":
          return keep({ t: "int", v: this.#long(at) });
        case "g":
          return keep({ t: "float", v: this.#f64() });
        case "f":
          return keep({ t: "float", v: this.#textFloat() });
        case "y": {
          const real = this.#f64();
          return keep({ t: "complex", real, imag: this.#f64() });
        }
        case "x": {
          const real = this.#textFloat();
          return keep({ t: "complex", real, imag: this.#textFloat() });
        }
        case "s":
          return keep({ t: "bytes", v: this.#take(this.#size()).slice() });
        case "t":
        case "u": {
          const start = this.#at + 4;
          const decoded = utf8SurrogatePass(this.#take(this.#size()), start);
          return keep(
            decoded.points === undefined
              ? { t: "str", v: decoded.text }
              : { t: "str", v: decoded.text, points: decoded.points },
          );
        }
        case "a":
        case "A":
          return keep({ t: "str", v: latin1(this.#take(this.#size())) });
        case "z":
        case "Z":
          return keep({ t: "str", v: latin1(this.#take(this.#u8())) });
        case ")":
        case "(":
        case "[":
        case "<":
        case ">": {
          const size = this.#count(
            type === ")" ? this.#u8() : this.#size(),
            at,
          );
          const kind =
            type === "["
              ? "list"
              : type === "<"
                ? "set"
                : type === ">"
                  ? "frozenset"
                  : "tuple";
          // Like CPython, a tuple's or frozenset's slot is reserved before its items.
          if (kind === "tuple" || kind === "frozenset") reserve();
          const items: PyValue[] = [];
          for (let index = 0; index < size; index += 1) items.push(this.read());
          return keep({ t: kind, items });
        }
        case "{":
        case "}": {
          if (type === "}" && this.#profile.data.marshal_version < 6)
            throw new MarshalError("frozendict before marshal version 6", at);
          const entries: [PyValue, PyValue][] = [];
          for (;;) {
            const key = this.read(true);
            if (key.t === "null") break;
            entries.push([key, this.read()]);
          }
          return keep({ t: type === "{" ? "dict" : "frozendict", entries });
        }
        case ":": {
          if (this.#profile.data.marshal_version < 5)
            throw new MarshalError("slice before marshal version 5", at);
          reserve();
          const start = this.read();
          const stop = this.read();
          return keep({ t: "slice", start, stop, step: this.read() });
        }
        case "r": {
          const index = this.#i32();
          const value = this.#refs[index];
          if (index < 0 || value === undefined)
            throw new MarshalError(
              `Reference ${String(index)} is undefined`,
              at,
            );
          if (value === PENDING)
            throw new MarshalError(
              `Reference ${String(index)} names an object still being read`,
              at,
            );
          // The reference stands for everything the shared object holds.
          this.#charge((this.#refWeights[index] ?? 1) - 1, at);
          return value;
        }
        case "c": {
          reserve();
          return keep({ t: "code", code: this.#code(at) });
        }
        default:
          throw new MarshalError(
            `Unknown marshal type 0x${byte.toString(16).padStart(2, "0")}`,
            at,
          );
      }
    } finally {
      this.#depth -= 1;
    }
  }

  #int(): number {
    const at = this.#at;
    const value = this.#i32();
    if (value < 0) throw new MarshalError("Negative code object count", at);
    return value;
  }

  #string(field: string): string {
    const at = this.#at;
    const value = this.read();
    if (value.t !== "str")
      throw new MarshalError(
        `Code object ${field} is a ${value.t}, not str`,
        at,
      );
    return value.v;
  }

  #bytesField(field: string): Uint8Array {
    const at = this.#at;
    const value = this.read();
    if (value.t !== "bytes")
      throw new MarshalError(
        `Code object ${field} is a ${value.t}, not bytes`,
        at,
      );
    return value.v;
  }

  #tuple(field: string): PyValue[] {
    const at = this.#at;
    const value = this.read();
    if (value.t !== "tuple")
      throw new MarshalError(
        `Code object ${field} is a ${value.t}, not tuple`,
        at,
      );
    return value.items;
  }

  #names(field: string): string[] {
    const at = this.#at;
    return this.#tuple(field).map((item) => {
      if (item.t !== "str")
        throw new MarshalError(`Code object ${field} holds a ${item.t}`, at);
      return item.v;
    });
  }

  #code(offset: number): CodeObject {
    if (this.#profile.layout === "3.8-3.10") {
      const argcount = this.#int();
      const posonlyargcount = this.#int();
      const kwonlyargcount = this.#int();
      const nlocals = this.#int();
      const stacksize = this.#int();
      const flags = this.#i32();
      const code = this.#bytesField("co_code");
      const consts = this.#tuple("co_consts");
      const names = this.#names("co_names");
      const varnames = this.#names("co_varnames");
      const freevars = this.#names("co_freevars");
      const cellvars = this.#names("co_cellvars");
      const filename = this.#string("co_filename");
      const name = this.#string("co_name");
      const firstlineno = this.#i32();
      const linetable = this.#bytesField("co_lnotab");
      return {
        argcount,
        posonlyargcount,
        kwonlyargcount,
        nlocals,
        stacksize,
        flags,
        code,
        consts,
        names,
        varnames,
        cellvars,
        freevars,
        localsplus: [
          ...varnames.map((entry) => ({ name: entry, kind: CO_FAST_LOCAL })),
          ...cellvars.map((entry) => ({ name: entry, kind: CO_FAST_CELL })),
          ...freevars.map((entry) => ({ name: entry, kind: CO_FAST_FREE })),
        ],
        filename,
        name,
        qualname: null,
        firstlineno,
        linetable,
        exceptiontable: new Uint8Array(),
        offset,
      };
    }
    const argcount = this.#int();
    const posonlyargcount = this.#int();
    const kwonlyargcount = this.#int();
    const stacksize = this.#int();
    const flags = this.#i32();
    const code = this.#bytesField("co_code");
    const consts = this.#tuple("co_consts");
    const names = this.#names("co_names");
    const plusNames = this.#names("co_localsplusnames");
    const kindsAt = this.#at;
    const kinds = this.#bytesField("co_localspluskinds");
    if (kinds.length !== plusNames.length)
      throw new MarshalError(
        `${String(plusNames.length)} local names but ${String(kinds.length)} kinds`,
        kindsAt,
      );
    const filename = this.#string("co_filename");
    const name = this.#string("co_name");
    const qualname = this.#string("co_qualname");
    const firstlineno = this.#i32();
    const linetable = this.#bytesField("co_linetable");
    const exceptiontable = this.#bytesField("co_exceptiontable");
    const localsplus = plusNames.map((entry, index) => ({
      name: entry,
      kind: kinds[index] ?? 0,
    }));
    const of = (bit: number) =>
      localsplus
        .filter((entry) => (entry.kind & bit) !== 0)
        .map((entry) => entry.name);
    // A name both local and cell (an argument captured by a closure) is in both lists, as in CPython.
    return {
      argcount,
      posonlyargcount,
      kwonlyargcount,
      nlocals: of(CO_FAST_LOCAL).length,
      stacksize,
      flags,
      code,
      consts,
      names,
      varnames: of(CO_FAST_LOCAL),
      cellvars: of(CO_FAST_CELL),
      freevars: of(CO_FAST_FREE),
      localsplus,
      filename,
      name,
      qualname,
      firstlineno,
      linetable,
      exceptiontable,
      offset,
    };
  }
}
