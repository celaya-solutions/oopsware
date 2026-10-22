import type { ReaderCounters } from "../reader.js";
import { checkpoint } from "./legacy.js";
import type { FormulaContext } from "./xlsFormula.js";
import type { Workbook } from "./xlsGlobals.js";
import { isPlainName, quote } from "./xlsLinks.js";
import { ContinuedReader } from "./xlsRecords.js";

/** Largest shared-string table this reader holds; a bigger one is read up to the cap. */
const MAX_SHARED_STRINGS = 5_000_000;

/**
 * The shared string table (SST, [MS-XLS] 2.4.265): XLUnicodeRichExtendedString
 * entries that may run on through CONTINUE records. Formatting runs and
 * phonetic data are skipped by their declared sizes.
 */
export const readSharedStrings = async (
  workbook: Workbook,
  counters: ReaderCounters,
  signal: AbortSignal | undefined,
): Promise<string[]> => {
  const strings: string[] = [];
  if (workbook.sst === null) return strings;
  const reader = new ContinuedReader(
    workbook.bytes,
    workbook.sst.start,
    workbook.sst.length,
    workbook.bytes.length,
  );
  let declared = 0;
  try {
    reader.u32();
    declared = reader.u32();
    while (
      strings.length < declared &&
      strings.length < MAX_SHARED_STRINGS &&
      !reader.done()
    ) {
      if ((strings.length & 0xfff) === 0xfff) await checkpoint(signal);
      const count = reader.u16();
      const flags = reader.u8();
      const runs = (flags & 0x08) !== 0 ? reader.u16() : 0;
      const phonetic = (flags & 0x04) !== 0 ? reader.u32() : 0;
      strings.push(reader.chars(count, (flags & 0x01) !== 0));
      reader.skip(runs * 4);
      reader.skip(phonetic);
    }
  } catch (cause) {
    if (!(cause instanceof RangeError)) throw cause;
    counters.diagnose(
      "SST",
      `The shared string table is cut off after ${String(strings.length)} of ${String(declared)} strings: ${cause.message}`,
    );
    return strings;
  }
  if (strings.length >= MAX_SHARED_STRINGS && declared > strings.length)
    counters.diagnose(
      "SST",
      `Only the first ${String(MAX_SHARED_STRINGS)} shared strings are held.`,
    );
  else if (strings.length < declared)
    counters.diagnose(
      "SST",
      `The shared string table declares ${String(declared)} strings but holds ${String(strings.length)}.`,
    );
  return strings;
};

/** The prefix an XTI stands for in a 3-D reference: Sheet2, 'My Sheet', Sheet1:Sheet3 or [1]Prices. */
const sheetPrefix = (
  workbook: Workbook,
  own: readonly (string | undefined)[],
  ixti: number,
): string | undefined => {
  const xti = workbook.xti[ixti];
  const book = xti === undefined ? undefined : workbook.supBooks[xti.book];
  if (xti === undefined || book === undefined) return undefined;
  if (xti.first === -1 || xti.last === -1) return "#REF";
  const names =
    book.kind === "self" ? own : book.kind === "workbook" ? book.sheets : [];
  const first = names[xti.first];
  const last = names[xti.last];
  if (first === undefined || last === undefined) return undefined;
  const body = first === last ? first : `${first}:${last}`;
  const bracket = book.kind === "workbook" ? `[${String(book.number)}]` : "";
  return isPlainName(first) && isPlainName(last)
    ? `${bracket}${body}`
    : quote(`${bracket}${body}`);
};

/** An external name as a formula writes it: an add-in function, a DDE item or [1]!Name. */
const externName = (
  workbook: Workbook,
  ixti: number,
  index: number,
): string | undefined => {
  const xti = workbook.xti[ixti];
  const book = xti === undefined ? undefined : workbook.supBooks[xti.book];
  const entry = book?.names[index - 1];
  const name = entry?.name;
  if (book === undefined || entry === undefined || name == null)
    return undefined;
  switch (book.kind) {
    case "addin":
      return name;
    case "link":
      return `${book.server}|${quote(book.topic)}!${isPlainName(name) ? name : quote(name)}`;
    case "workbook": {
      const bracket = `[${String(book.number)}]`;
      if (entry.sheet === 0) return `${bracket}!${name}`;
      const sheet = book.sheets[entry.sheet - 1];
      if (sheet === undefined) return undefined;
      return `${isPlainName(sheet) ? `${bracket}${sheet}` : quote(`${bracket}${sheet}`)}!${name}`;
    }
    default:
      return undefined;
  }
};

/** External names remembered per workbook; past this they are worked out each time. */
const MAX_REMEMBERED = 65_536;

/**
 * What formulas in this workbook resolve names and sheets against, for a
 * formula in a given cell. Sheet prefixes and external names are built once
 * and shared, so a formula full of 3-D references does not rebuild them.
 */
export const formulaContext = (
  workbook: Workbook,
): ((row: number, col: number) => FormulaContext) => {
  // A BoundSheet8 that could not be read (type -1) keeps its index but names nothing.
  const own = workbook.boundSheets.map((sheet) =>
    sheet.type === -1 ? undefined : sheet.name,
  );
  const prefixes = new Map<number, string | undefined>();
  const externs = new Map<number, string | undefined>();
  const base = {
    name: (index: number) => workbook.names[index - 1] ?? undefined,
    sheets: (ixti: number) => {
      if (!prefixes.has(ixti))
        prefixes.set(ixti, sheetPrefix(workbook, own, ixti));
      return prefixes.get(ixti);
    },
    externName: (ixti: number, index: number) => {
      const key = ixti * 0x1_0000_0000 + index;
      if (externs.has(key)) return externs.get(key);
      const name = externName(workbook, ixti, index);
      if (externs.size < MAX_REMEMBERED) externs.set(key, name);
      return name;
    },
  };
  return (row, col) => ({ ...base, row, col });
};
