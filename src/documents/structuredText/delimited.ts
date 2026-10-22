import { parse, type CsvError } from "csv-parse/sync";

import type { DocumentBuilder } from "./DocumentBuilder.js";

/** Cells a spreadsheet would treat as a formula; plain signed numbers are not. */
const formulaLike = (field: string) =>
  /^[=+\-@\t\r]/u.test(field) && !/^[+-]?\d+(?:\.\d+)?$/u.test(field);

/** Monotonic map from UTF-8 offsets in the re-encoded text to text positions. */
const utf8Cursor = (text: string) => {
  let index = 0;
  let bytes = 0;
  return (target: number): number => {
    while (bytes < target && index < text.length) {
      const code = text.codePointAt(index) ?? 0;
      bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
      index += code > 0xffff ? 2 : 1;
    }
    return index;
  };
};

class StopAtFirstFailure extends Error {}

/**
 * Walk CSV/TSV rows with csv-parse: quoted delimiters and newlines, uneven
 * rows with coordinates, and formula-like cells flagged. After a malformed
 * record the quote state is unknown, so reading stops there and the rows
 * before it are kept.
 */
export const walkDelimited = (
  builder: DocumentBuilder,
  delimiter: string,
): { readonly rows: number; readonly failure: CsvError | null } => {
  builder.unit = "row";
  const { text } = builder.source;
  const state: { failure: CsvError | null } = { failure: null };
  const position = utf8Cursor(text);
  let rows = 0;
  let expected: number | null = null;
  let previousEnd = 0;
  // Each row becomes a node as it is parsed; returning null keeps csv-parse
  // from also collecting every record, so memory follows the page, not the file.
  const emitRow = (record: string[], endBytes: number) => {
    rows += 1;
    const row = rows;
    const start = position(previousEnd);
    previousEnd = endBytes;
    const end = position(endBytes);
    builder.unitStarts.push(start);
    expected ??= record.length;
    const formulas = record.filter(formulaLike).length;
    builder.node({
      depth: 0,
      kind: "row",
      path: `row ${String(row)}`,
      fields: record,
      record: row,
      at: start,
      end,
      details: {
        field_count: record.length,
        formula_like_cells: formulas,
      },
    });
    if (record.length !== expected)
      builder.diagnostic(
        "warning",
        "delimited_uneven_row",
        `Row ${String(row)} has ${String(record.length)} fields; row 1 has ${String(expected)}.`,
        start,
        row,
      );
    if (formulas > 0)
      builder.diagnostic(
        "info",
        "delimited_formula_like_cell",
        `Row ${String(row)} has ${String(formulas)} cell(s) a spreadsheet would run as a formula; they are shown only as text.`,
        start,
        row,
      );
  };
  try {
    parse(Buffer.from(text, "utf8"), {
      delimiter,
      relax_column_count: true,
      skip_empty_lines: false,
      skip_records_with_error: true,
      on_record: (record: string[], context) => {
        emitRow(record, context.bytes);
        return null;
      },
      on_skip: (error) => {
        state.failure = error ?? null;
        throw new StopAtFirstFailure();
      },
    });
  } catch (cause) {
    if (!(cause instanceof StopAtFirstFailure)) {
      if (!(cause instanceof Error) || !("code" in cause)) throw cause;
      state.failure = cause as CsvError;
    }
  }
  const failed = state.failure;
  if (failed !== null)
    builder.diagnostic(
      "error",
      `delimited_${failed.code.toLowerCase()}`,
      `${failed.message} Rows after this point are not listed because the quoting state is unknown.`,
      typeof failed.lines === "number"
        ? builder.source.indexOf(failed.lines, 1)
        : null,
      rows + 1,
    );
  return { rows, failure: failed };
};
