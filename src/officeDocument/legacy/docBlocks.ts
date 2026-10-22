import type { OfficeItem } from "../../domain/officeDocument/officeDocument.js";
import { capText, type ReaderCounters } from "../reader.js";
import type { ParagraphRecord } from "./docWalk.js";

/**
 * Turn a story's paragraphs into content items ([MS-DOC] 2.4.3): paragraphs
 * at table depth 0 are paragraph items; paragraphs in a table fill cells that
 * end at a cell mark, and rows end at a table-terminating (TTP) mark. Tables
 * nested in a cell are flattened into the cell's text and counted, as the
 * Open XML reader flattens them.
 */

const MAX_TABLE_ROWS = 200;
const MAX_TABLE_COLUMNS = 50;

export class Blocks {
  readonly #counters: ReaderCounters;
  readonly #location: string;
  readonly #visit: (item: OfficeItem) => void;
  readonly #next: () => number;
  /** Count paragraphs and tables (the body and headers); comments and notes count themselves. */
  readonly #count: boolean;
  #paragraphs = 0;
  #tables = 0;
  #rows: string[][] = [];
  #row: string[] = [];
  #cell: string[] = [];
  #innerRow: string[] = [];
  #innerCell: string[] = [];
  #nested = false;

  constructor(
    counters: ReaderCounters,
    location: string,
    sink: {
      visit: (item: OfficeItem) => void;
      next: () => number;
      count: boolean;
    },
  ) {
    this.#counters = counters;
    this.#location = location;
    this.#visit = sink.visit;
    this.#next = sink.next;
    this.#count = sink.count;
  }

  add(record: ParagraphRecord): void {
    const props = record.props;
    const depth = props?.depth ?? 0;
    if (props === null || depth === 0) {
      this.finish();
      this.#paragraph(record);
      return;
    }
    if (depth > 1) {
      if (!this.#nested) {
        this.#nested = true;
        this.#counters.add("nested_tables");
        this.#counters.omit(
          "nested-table",
          "Tables inside table cells are flattened into the cell's text.",
        );
      }
      if (props.innerTtp) this.#closeInnerRow();
      else if (props.innerCell) {
        this.#innerCell.push(record.text);
        this.#innerRow.push(this.#innerCell.join("\n"));
        this.#innerCell = [];
      } else this.#innerCell.push(record.text);
      return;
    }
    this.#closeNested();
    if (record.mark === "cell" && props.ttp) {
      if (this.#cell.length > 0) this.#closeCell();
      this.#rows.push(this.#row);
      this.#row = [];
    } else if (record.mark === "cell") {
      this.#cell.push(record.text);
      this.#closeCell();
    } else this.#cell.push(record.text);
  }

  /** Close an open table; call at the end of a story. */
  finish(): void {
    this.#closeNested();
    if (this.#cell.length > 0) this.#closeCell();
    if (this.#row.length > 0) {
      this.#rows.push(this.#row);
      this.#row = [];
    }
    if (this.#rows.length === 0) return;
    const grid = this.#rows;
    this.#rows = [];
    this.#tables += 1;
    if (this.#count) this.#counters.add("tables");
    const columns = grid.reduce((most, row) => Math.max(most, row.length), 0);
    this.#visit({
      kind: "table",
      index: this.#next(),
      location: `${this.#location}#tbl${String(this.#tables)}`,
      rows: grid.length,
      columns,
      cells: grid
        .slice(0, MAX_TABLE_ROWS)
        .map((row) =>
          row
            .slice(0, MAX_TABLE_COLUMNS)
            .map((cell) => capText(cell, this.#counters)),
        ),
      truncated: grid.length > MAX_TABLE_ROWS || columns > MAX_TABLE_COLUMNS,
    });
  }

  #paragraph(record: ParagraphRecord): void {
    this.#paragraphs += 1;
    if (this.#count) {
      this.#counters.add("paragraphs");
      if (record.hidden) this.#counters.add("hidden_paragraphs");
    }
    this.#visit({
      kind: "paragraph",
      index: this.#next(),
      location: `${this.#location}#p${String(this.#paragraphs)}`,
      style: record.props?.style ?? null,
      heading_level: record.props?.heading ?? null,
      list_level: record.props?.list ?? null,
      hidden: record.hidden,
      revision: record.revision,
      text: capText(record.text, this.#counters),
      links: record.links,
      fields: record.fields,
    });
  }

  #closeCell(): void {
    this.#row.push(this.#cell.join("\n"));
    this.#cell = [];
  }

  #closeInnerRow(): void {
    if (this.#innerCell.length > 0) {
      this.#innerRow.push(this.#innerCell.join("\n"));
      this.#innerCell = [];
    }
    if (this.#innerRow.length > 0) this.#cell.push(this.#innerRow.join(" | "));
    this.#innerRow = [];
  }

  #closeNested(): void {
    if (!this.#nested) return;
    this.#closeInnerRow();
    this.#nested = false;
  }
}

/** Collect a story's items as plain lines (comments and notes carry text only). */
export const itemText = (item: OfficeItem): string => {
  if (item.kind === "paragraph") return item.text;
  if (item.kind === "table")
    return item.cells.map((row) => row.join(" | ")).join("\n");
  return "";
};
