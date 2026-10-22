import type { CodeObject } from "./marshal.js";
import type { BytecodeProfile } from "./profiles.js";

/**
 * Source locations from a code object's line table: co_lnotab (3.8-3.9) and
 * the PEP 657 location table (3.11+). Damaged tables stop where they become
 * unreadable; the offsets before that keep their lines.
 */

export interface Position {
  readonly line: number | null;
  readonly endLine: number | null;
  readonly column: number | null;
  readonly endColumn: number | null;
}

export interface LineInfo {
  /** One position per 2-byte code unit. */
  readonly positions: readonly Position[];
  /** Byte offset -> line, as the producing release's dis.findlinestarts reports it. */
  readonly starts: ReadonlyMap<number, number | null>;
  /** Set when the table could not be read to its end. */
  readonly problem: string | null;
}

const NONE: Position = {
  line: null,
  endLine: null,
  column: null,
  endColumn: null,
};

/** dis.findlinestarts for the co_lnotab format (3.8-3.9). */
const lnotab = (code: CodeObject): LineInfo => {
  const table = code.linetable;
  const length = code.code.length;
  const starts = new Map<number, number | null>();
  let problem: string | null = null;
  if (table.length % 2 !== 0) problem = "co_lnotab has an odd length.";
  let lastLine: number | null = null;
  let line = code.firstlineno;
  let address = 0;
  let ended = false;
  for (let index = 0; index + 1 < table.length; index += 2) {
    const byteIncrement = table[index] ?? 0;
    let lineIncrement = table[index + 1] ?? 0;
    if (byteIncrement !== 0) {
      if (line !== lastLine) {
        starts.set(address, line);
        lastLine = line;
      }
      address += byteIncrement;
      if (address >= length) {
        ended = true;
        break;
      }
    }
    if (lineIncrement >= 0x80) lineIncrement -= 0x100;
    line += lineIncrement;
  }
  if (!ended && line !== lastLine) starts.set(address, line);
  const positions: Position[] = [];
  let current: number | null = null;
  for (let unit = 0; unit < length / 2; unit += 1) {
    const start = starts.get(unit * 2);
    if (start !== undefined) current = start;
    positions.push({ ...NONE, line: current });
  }
  return { positions, starts, problem };
};

class TableReader {
  at = 0;
  constructor(readonly bytes: Uint8Array) {}

  byte(): number {
    if (this.at >= this.bytes.length)
      throw new Error("location table ends inside an entry");
    const value = this.bytes[this.at] ?? 0;
    this.at += 1;
    return value;
  }

  /** The location table's varint: 6-bit chunks, least significant first. */
  varint(): number {
    let read = this.byte();
    let value = read & 63;
    let shift = 6;
    while ((read & 64) !== 0) {
      read = this.byte();
      value += (read & 63) * 2 ** shift;
      shift += 6;
      if (shift > 48) throw new Error("location table varint is too long");
    }
    return value;
  }

  /** The exception table's varint: 6-bit chunks, most significant first. */
  bigVarint(): number {
    let read = this.byte();
    let value = read & 63;
    while ((read & 64) !== 0) {
      read = this.byte();
      value = value * 64 + (read & 63);
      if (value > Number.MAX_SAFE_INTEGER / 64)
        throw new Error("exception table varint is too long");
    }
    return value;
  }

  svarint(): number {
    const value = this.varint();
    return value % 2 === 1 ? -Math.floor(value / 2) : Math.floor(value / 2);
  }
}

/** The PEP 657 location table (3.11+): one entry covers 1-8 code units. */
const locationTable = (
  code: CodeObject,
  profile: BytecodeProfile,
): LineInfo => {
  const units = code.code.length / 2;
  const positions: Position[] = [];
  const reader = new TableReader(code.linetable);
  let line = code.firstlineno;
  let problem: string | null = null;
  try {
    while (reader.at < reader.bytes.length && positions.length < units) {
      const first = reader.byte();
      if ((first & 0x80) === 0)
        throw new Error("location table entry lacks its start bit");
      const form = (first >> 3) & 15;
      const length = (first & 7) + 1;
      let position: Position;
      if (form === 15) position = NONE;
      else if (form === 14) {
        line += reader.svarint();
        const endLine = line + reader.varint();
        const column = reader.varint() - 1;
        const endColumn = reader.varint() - 1;
        position = {
          line,
          endLine,
          column: column < 0 ? null : column,
          endColumn: endColumn < 0 ? null : endColumn,
        };
      } else if (form === 13) {
        line += reader.svarint();
        position = { line, endLine: line, column: null, endColumn: null };
      } else if (form >= 10) {
        line += form - 10;
        const column = reader.byte();
        position = {
          line,
          endLine: line,
          column,
          endColumn: reader.byte(),
        };
      } else {
        const second = reader.byte();
        const column = form * 8 + (second >> 4);
        position = {
          line,
          endLine: line,
          column,
          endColumn: column + (second & 15),
        };
      }
      for (let index = 0; index < length; index += 1) positions.push(position);
    }
    if (positions.length > units)
      problem = "The location table covers more code units than the bytecode.";
    else if (reader.at < reader.bytes.length)
      problem = "The location table has bytes past the last code unit.";
  } catch (cause) {
    problem = cause instanceof Error ? cause.message : String(cause);
  }
  if (positions.length < units && problem === null)
    problem = "The location table ends before the bytecode.";
  positions.length = Math.min(positions.length, units);
  while (positions.length < units) positions.push(NONE);
  // dis.findlinestarts: 3.11-3.12 skip lines that are None; 3.13+ report them.
  const reportsNone = !(profile.rules === "3.11" || profile.rules === "3.12");
  const starts = new Map<number, number | null>();
  let last: number | null | undefined = reportsNone ? undefined : null;
  positions.forEach((position, unit) => {
    if (position.line === null && !reportsNone) return;
    if (position.line !== last) {
      starts.set(unit * 2, position.line);
      last = position.line;
    }
  });
  return { positions, starts, problem };
};

export const lineInfo = (
  code: CodeObject,
  profile: BytecodeProfile,
): LineInfo =>
  profile.layout === "3.11+" ? locationTable(code, profile) : lnotab(code);

export interface ExceptionEntry {
  readonly start: number;
  readonly end: number;
  readonly target: number;
  readonly depth: number;
  readonly lasti: boolean;
}

/** dis._parse_exception_table (3.11+): byte offsets of each protected range. */
export const exceptionTable = (
  code: CodeObject,
): { entries: ExceptionEntry[]; problem: string | null } => {
  const reader = new TableReader(code.exceptiontable);
  const entries: ExceptionEntry[] = [];
  try {
    while (reader.at < reader.bytes.length) {
      const start = reader.bigVarint() * 2;
      const end = start + reader.bigVarint() * 2;
      const target = reader.bigVarint() * 2;
      const packed = reader.bigVarint();
      entries.push({
        start,
        end,
        target,
        depth: Math.floor(packed / 2),
        lasti: packed % 2 === 1,
      });
    }
    return { entries, problem: null };
  } catch (cause) {
    return {
      entries,
      problem: `The exception table is damaged after ${String(entries.length)} entries: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
};
