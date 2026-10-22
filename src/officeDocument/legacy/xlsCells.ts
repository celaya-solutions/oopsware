import type {
  OfficeCell,
  OfficeRow,
} from "../../domain/officeDocument/officeDocument.js";
import type { ReaderCounters } from "../reader.js";
import {
  BUILTIN_DATE_IDS,
  BUILTIN_FORMATS,
  formatSerial,
  isDateFormat,
} from "../xlsx.js";
import type { Workbook } from "./xlsGlobals.js";

/**
 * Cell values in the same shapes the Open XML reader gives: a number as its
 * text, a date as an ISO date with its serial kept, a Boolean as "true" or
 * "false", an error as its code. Number formats come from the cell's XF.
 */

/** Cells kept per row; the rest are counted (a BIFF8 row has 256 columns, so more means repeats). */
const MAX_CELLS_PER_ROW = 2_000;
/** Longest value or format text one cell lists; longer text is cut and counted. */
const MAX_CELL_TEXT = 4_096;
const MAX_FORMAT_TEXT = 256;

export const cellClip = (text: string, counters: ReaderCounters): string => {
  if (text.length <= MAX_CELL_TEXT) return text;
  counters.omit(
    "truncated-text",
    `Cell text longer than ${String(MAX_CELL_TEXT)} characters is cut.`,
  );
  // Never end on the first half of a surrogate pair.
  const code = text.charCodeAt(MAX_CELL_TEXT - 1);
  const end =
    code >= 0xd800 && code <= 0xdbff ? MAX_CELL_TEXT - 1 : MAX_CELL_TEXT;
  return `${text.slice(0, end)}…`;
};

interface Format {
  readonly code: string | null;
  readonly date: boolean;
}

/** Number formats per XF index, worked out once per sheet walk. */
export class Formats {
  readonly #workbook: Workbook;
  readonly #cache = new Map<number, Format>();

  constructor(workbook: Workbook) {
    this.#workbook = workbook;
  }

  get(xf: number): Format {
    const cached = this.#cache.get(xf);
    if (cached !== undefined) return cached;
    const id = this.#workbook.xfFormats[xf];
    let format: Format = { code: null, date: false };
    // -1 marks an XF record too short to hold a format id.
    if (id !== undefined && id > 0) {
      const custom = this.#workbook.formats.get(id);
      const code = custom ?? BUILTIN_FORMATS[id] ?? `builtin:${String(id)}`;
      format = {
        code:
          code.length > MAX_FORMAT_TEXT
            ? `${code.slice(0, MAX_FORMAT_TEXT)}…`
            : code,
        date:
          custom === undefined
            ? BUILTIN_DATE_IDS.has(id)
            : isDateFormat(custom),
      };
    }
    this.#cache.set(xf, format);
    return format;
  }
}

export type CellValue = Pick<OfficeCell, "type" | "value" | "serial">;

/** A number, or a date when the cell's format shows one and the serial is in range. */
export const numberValue = (
  value: number,
  format: Format,
  date1904: boolean,
): CellValue => {
  const text = String(value);
  if (format.date) {
    const formatted = formatSerial(value, date1904);
    if (formatted !== null)
      return { type: "date", value: formatted, serial: text };
  }
  return { type: "number", value: text, serial: null };
};

/** Collects one row's cells and hands the row on when the next row starts. */
export class Rows {
  readonly #counters: ReaderCounters;
  readonly #visit: (row: OfficeRow) => void;
  readonly #hidden = new Set<number>();
  #row = -1;
  #cells: { col: number; cell: OfficeCell }[] = [];
  #dropped = 0;
  #index = 0;
  #highest = -1;
  #outOfOrder = false;

  constructor(counters: ReaderCounters, visit: (row: OfficeRow) => void) {
    this.#counters = counters;
    this.#visit = visit;
  }

  /** A ROW record that hides its row (fDyZero). */
  hide(row: number): void {
    if (this.#hidden.has(row)) return;
    this.#hidden.add(row);
    this.#counters.add("hidden_rows");
  }

  add(row: number, col: number, cell: OfficeCell): void {
    if (row !== this.#row) {
      this.flush();
      this.#row = row;
    }
    if (this.#cells.length >= MAX_CELLS_PER_ROW) this.#dropped += 1;
    else this.#cells.push({ col, cell });
  }

  flush(): void {
    if (this.#dropped > 0)
      this.#counters.omit(
        "cells-past-row-limit",
        `A row lists at most ${String(MAX_CELLS_PER_ROW)} cells; the rest are counted here.`,
        this.#dropped,
      );
    this.#dropped = 0;
    if (this.#cells.length === 0) return;
    if (this.#row < this.#highest && !this.#outOfOrder) {
      this.#outOfOrder = true;
      this.#counters.diagnose(
        `row ${String(this.#row + 1)}`,
        "Cells are stored out of row order; rows are listed in the order they are stored.",
      );
    }
    this.#highest = Math.max(this.#highest, this.#row);
    const cells = this.#cells
      .sort((a, b) => a.col - b.col)
      .map((entry) => entry.cell);
    this.#cells = [];
    this.#counters.add("rows_with_values");
    this.#visit({
      kind: "row",
      index: this.#index++,
      row: this.#row + 1,
      hidden: this.#hidden.has(this.#row),
      cells,
    });
  }
}
