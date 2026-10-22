import type { OfficeRow } from "../../domain/officeDocument/officeDocument.js";
import type { ReaderCounters } from "../reader.js";
import { checkpoint } from "./legacy.js";
import {
  cellClip,
  Formats,
  numberValue,
  Rows,
  type CellValue,
} from "./xlsCells.js";
import { ANCHORS, FormulaCells, type FormulaFields } from "./xlsAnchors.js";
import type { FormulaContext } from "./xlsFormula.js";
import type { Workbook } from "./xlsGlobals.js";
import {
  cellName,
  ERRORS,
  RecordWalker,
  rkValue,
  RT,
  xlString,
} from "./xlsRecords.js";

/**
 * One sheet substream walked record by record ([MS-XLS] 2.1.7.20.5): cell
 * records become rows, formulas are decoded beside their cached values, and
 * embedded chart substreams are stepped over. Only the current row is held.
 */

export interface SheetInput {
  readonly workbook: Workbook;
  readonly strings: readonly string[];
  readonly context: (row: number, col: number) => FormulaContext;
  readonly start: number;
  readonly end: number;
  readonly counters: ReaderCounters;
  readonly signal: AbortSignal | undefined;
  readonly visit: (row: OfficeRow) => void;
}

interface At {
  readonly row: number;
  readonly col: number;
  readonly xf: number;
}

const CELL_RECORDS: ReadonlyMap<number, string> = new Map([
  [RT.formula, "FORMULA"],
  [RT.labelSst, "LABELSST"],
  [RT.label, "LABEL"],
  [RT.number, "NUMBER"],
  [RT.rk, "RK"],
  [RT.mulRk, "MULRK"],
  [RT.blank, "BLANK"],
  [RT.mulBlank, "MULBLANK"],
  [RT.boolErr, "BOOLERR"],
  [RT.row, "ROW"],
  [RT.mergeCells, "MERGEDCELLS"],
]);

const DRAWING = "Drawings, charts and comments' shapes are not described.";

class SheetWalk {
  readonly #input: SheetInput;
  readonly #bytes: Uint8Array;
  readonly #view: DataView;
  readonly #walker: RecordWalker;
  readonly #rows: Rows;
  readonly #formats: Formats;
  readonly #formulas: FormulaCells;

  constructor(input: SheetInput) {
    this.#input = input;
    this.#bytes = input.workbook.bytes;
    this.#view = new DataView(
      this.#bytes.buffer,
      this.#bytes.byteOffset,
      this.#bytes.byteLength,
    );
    this.#walker = new RecordWalker(this.#bytes, input.start, input.end);
    this.#rows = new Rows(input.counters, input.visit);
    this.#formats = new Formats(input.workbook);
    this.#formulas = new FormulaCells(input.counters, input.context);
  }

  #u16(at: number): number {
    if (at + 2 > this.#walker.start + this.#walker.length)
      throw new RangeError("The record is shorter than its fields.");
    return this.#view.getUint16(at, true);
  }

  async run(): Promise<void> {
    const { counters, signal } = this.#input;
    this.#walker.advance();
    let depth = 1;
    let seen = 0;
    while (this.#walker.advance()) {
      if ((++seen & 0xfff) === 0) await checkpoint(signal);
      const type = this.#walker.type;
      if (type === RT.bof) depth += 1;
      else if (type === RT.eof) {
        depth -= 1;
        if (depth === 0) break;
      } else if (depth === 1) {
        try {
          this.#record(type);
        } catch (cause) {
          if (!(cause instanceof RangeError)) throw cause;
          counters.diagnose(
            `offset ${String(this.#walker.offset)}`,
            `A ${CELL_RECORDS.get(type) ?? "sheet"} record is cut short or malformed and was skipped: ${cause.message}`,
          );
        }
      }
    }
    if (this.#walker.truncated)
      counters.diagnose(
        null,
        "The sheet ends inside a record; the records before it are read.",
      );
    this.#rows.flush();
  }

  /** Row, column and XF index: the first six bytes of every cell record ([MS-XLS] 2.5.13 Cell). */
  #at(offset: number): At {
    return {
      row: this.#u16(offset),
      col: this.#u16(offset + 2),
      xf: this.#u16(offset + 4),
    };
  }

  #add(at: At, value: CellValue, formula?: FormulaFields): void {
    this.#input.counters.add("cells_scanned");
    if (at.col > 0xff) {
      this.#input.counters.diagnose(
        `row ${String(at.row + 1)}`,
        `A cell names column ${String(at.col + 1)}, past the last BIFF8 column (IV); it is skipped.`,
      );
      return;
    }
    this.#rows.add(at.row, at.col, {
      ref: cellName(at.row, at.col),
      ...value,
      formula: formula?.formula ?? null,
      formula_kind: formula?.kind ?? null,
      formula_from: formula?.from ?? null,
      number_format: this.#formats.get(at.xf).code,
    });
  }

  #number(xf: number, value: number): CellValue {
    return numberValue(
      value,
      this.#formats.get(xf),
      this.#input.workbook.date1904,
    );
  }

  #blank(count: number): void {
    this.#input.counters.add("cells_scanned", count);
    this.#input.counters.omit(
      "blank-cells",
      "Styled cells without a value or formula are not listed.",
      count,
    );
  }

  #error(code: number, ref: string): CellValue {
    const value = ERRORS.get(code) ?? null;
    if (value === null)
      this.#input.counters.diagnose(
        ref,
        `The cell holds an unknown error code 0x${code.toString(16)}.`,
      );
    return { type: "error", value, serial: null };
  }

  #record(type: number): void {
    if (this.#cell(type)) return;
    const start = this.#walker.start;
    const counters = this.#input.counters;
    switch (type) {
      case RT.formula:
        this.#formula();
        return;
      case RT.row:
        if (
          this.#walker.length >= 13 &&
          ((this.#bytes[start + 12] ?? 0) & 0x20) !== 0
        )
          this.#rows.hide(this.#u16(start));
        return;
      case RT.mergeCells:
        // cmcs, then 8-byte ranges: count no more ranges than the record holds.
        counters.add(
          "merged_ranges",
          Math.min(this.#u16(start), Math.floor((this.#walker.length - 2) / 8)),
        );
        return;
      case RT.hlink:
        counters.add("hyperlinks");
        return;
      case RT.dv:
        counters.add("data_validations");
        return;
      case RT.obj:
        counters.omit("drawing", DRAWING);
        return;
      case RT.note:
        counters.omit(
          "comments",
          "Cell comments are counted; their text is not read.",
        );
        return;
      default:
        return;
    }
  }

  /** Value cell records; false when the record is not one. */
  #cell(type: number): boolean {
    const start = this.#walker.start;
    const length = this.#walker.length;
    const counters = this.#input.counters;
    switch (type) {
      case RT.labelSst: {
        if (length < 10) throw new RangeError("A LABELSST record is short.");
        const at = this.#at(start);
        const index = this.#view.getUint32(start + 6, true);
        const text = this.#input.strings[index];
        if (text === undefined)
          counters.diagnose(
            cellName(at.row, at.col & 0xff),
            `Shared string ${String(index)} does not exist.`,
          );
        this.#add(at, {
          type: "string",
          value: text === undefined ? null : cellClip(text, counters),
          serial: null,
        });
        return true;
      }
      case RT.label: {
        const at = this.#at(start);
        this.#add(at, {
          type: "string",
          value: cellClip(xlString(this.#walker.reader(6)), counters),
          serial: null,
        });
        return true;
      }
      case RT.number:
      case RT.rk: {
        if (length < (type === RT.number ? 14 : 10))
          throw new RangeError("A number record is short.");
        const at = this.#at(start);
        const value =
          type === RT.number
            ? this.#view.getFloat64(start + 6, true)
            : rkValue(this.#view.getUint32(start + 6, true));
        this.#add(at, this.#number(at.xf, value));
        return true;
      }
      case RT.mulRk:
        this.#mulRk();
        return true;
      case RT.blank:
        this.#blank(1);
        return true;
      case RT.mulBlank:
        this.#blank(Math.max(0, Math.floor((length - 6) / 2)));
        return true;
      case RT.boolErr: {
        if (length < 8) throw new RangeError("A BOOLERR record is short.");
        const at = this.#at(start);
        const value = this.#bytes[start + 6] ?? 0;
        this.#add(
          at,
          (this.#bytes[start + 7] ?? 0) !== 0
            ? this.#error(value, cellName(at.row, at.col & 0xff))
            : {
                type: "boolean",
                value: value === 0 ? "false" : "true",
                serial: null,
              },
        );
        return true;
      }
      default:
        return false;
    }
  }

  #mulRk(): void {
    const start = this.#walker.start;
    const length = this.#walker.length;
    if (length < 6) throw new RangeError("A MULRK record is short.");
    const row = this.#u16(start);
    const first = this.#u16(start + 2);
    // rw, colFirst, then 6-byte RkRec values, then colLast.
    const count = Math.floor((length - 6) / 6);
    const last = this.#u16(start + length - 2);
    if (last - first + 1 !== count)
      this.#input.counters.diagnose(
        `row ${String(row + 1)}`,
        `A MULRK record's last column (${String(last + 1)}) does not match its ${String(count)} values; the values are placed from column ${String(first + 1)}.`,
      );
    for (let index = 0; index < count; index += 1) {
      const offset = start + 4 + index * 6;
      const xf = this.#u16(offset);
      this.#add(
        { row, col: first + index, xf },
        this.#number(xf, rkValue(this.#view.getUint32(offset + 2, true))),
      );
    }
  }

  #formula(): void {
    const data = this.#walker.data();
    if (data.length < 22) throw new RangeError("A FORMULA record is short.");
    const start = this.#walker.start;
    const at = this.#at(start);
    const cell = { row: at.row, col: at.col & 0xff, xf: at.xf };
    const ref = cellName(cell.row, cell.col);
    this.#input.counters.add("formulas");
    let value: CellValue | null = null;
    let text = false;
    if (this.#u16(start + 12) === 0xffff) {
      // FormulaValue ([MS-XLS] 2.5.133): byte 0 says string, Boolean, error or empty string.
      const kind = data[6] ?? 0;
      if (kind === 0x00) text = true;
      else if (kind === 0x01)
        value = {
          type: "boolean",
          value: data[8] === 0 ? "false" : "true",
          serial: null,
        };
      else if (kind === 0x02) value = this.#error(data[8] ?? 0, ref);
      else if (kind === 0x03)
        value = { type: "string", value: "", serial: null };
      else
        this.#input.counters.diagnose(
          ref,
          `The formula's cached value has an unknown type 0x${kind.toString(16)}.`,
        );
    } else value = this.#number(at.xf, this.#view.getFloat64(start + 6, true));
    const next = this.#walker.peekType();
    if (next !== undefined && ANCHORS.has(next)) {
      this.#walker.advance();
      this.#formulas.anchor(next, this.#walker.data(), cell.row, cell.col);
    }
    const fields = this.#formulas.resolve(cell.row, cell.col, data);
    if (text) value = this.#cachedString(ref);
    this.#add(
      at,
      value ?? { type: "number", value: null, serial: null },
      fields,
    );
  }

  /** The STRING record after a formula whose cached value is text. */
  #cachedString(ref: string): CellValue {
    if (this.#walker.peekType() !== RT.string) {
      this.#input.counters.diagnose(
        ref,
        "The formula's cached text should follow in a STRING record, but none does.",
      );
      return { type: "string", value: null, serial: null };
    }
    this.#walker.advance();
    return {
      type: "string",
      value: cellClip(xlString(this.#walker.reader()), this.#input.counters),
      serial: null,
    };
  }
}

/** Walk one sheet substream, visiting each row that holds a value. */
export const walkSheet = async (input: SheetInput): Promise<void> => {
  await new SheetWalk(input).run();
};
