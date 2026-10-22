import type {
  OfficeCell,
  OfficeContentPart,
  OfficeRow,
} from "../domain/officeDocument/officeDocument.js";
import { byId, byKind, type OpcPackage, type Relationship } from "./package.js";
import type { DocumentReader, ReaderCounters } from "./reader.js";
import {
  attr,
  child,
  childrenOf,
  decodeXmlBytes,
  DEFAULT_XML_LIMITS,
  STREAM_XML_LIMITS,
  scanXml,
  type XmlElement,
} from "./xml.js";

const S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** Largest shared-string table this reader holds; a bigger one is read up to the cap. */
const MAX_SHARED_STRINGS = 5_000_000;
/** Cells kept per row; the rest are counted. */
const MAX_CELLS_PER_ROW = 2_000;

/** ECMA-376 built-in number formats that are not General. */
export const BUILTIN_FORMATS: Readonly<Record<number, string>> = {
  1: "0",
  2: "0.00",
  3: "#,##0",
  4: "#,##0.00",
  9: "0%",
  10: "0.00%",
  11: "0.00E+00",
  12: "# ?/?",
  13: "# ??/??",
  14: "mm-dd-yy",
  15: "d-mmm-yy",
  16: "d-mmm",
  17: "mmm-yy",
  18: "h:mm AM/PM",
  19: "h:mm:ss AM/PM",
  20: "h:mm",
  21: "h:mm:ss",
  22: "m/d/yy h:mm",
  37: "#,##0 ;(#,##0)",
  38: "#,##0 ;[Red](#,##0)",
  39: "#,##0.00;(#,##0.00)",
  40: "#,##0.00;[Red](#,##0.00)",
  45: "mm:ss",
  46: "[h]:mm:ss",
  47: "mmss.0",
  48: "##0.0E+0",
  49: "@",
};

export const BUILTIN_DATE_IDS: ReadonlySet<number> = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
  45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58,
]);

/** Whether a number format code shows a date or time. */
export const isDateFormat = (code: string): boolean => {
  const stripped = code
    .replace(/"[^"]*"/gu, "")
    .replace(/\\./gu, "")
    .replace(/\[(?!(?:h+|m+|s+)\])[^\]]*\]/giu, "")
    .replace(/[_*].?/gu, "");
  return /[dmyhs]/iu.test(stripped);
};

const pad = (value: number, width = 2): string =>
  String(value).padStart(width, "0");

/**
 * Format a serial date. The 1900 system treats 1900 as a leap year (serial 60 is
 * the day that never existed); the 1904 system counts from 1904-01-01.
 */
export const formatSerial = (
  serial: number,
  date1904: boolean,
): string | null => {
  if (!Number.isFinite(serial) || serial < 0 || serial >= 2_958_466)
    return null;
  let whole = Math.floor(serial);
  let seconds = Math.round((serial - whole) * 86_400);
  // A fraction that rounds up to a whole day belongs to the next day.
  if (seconds >= 86_400) {
    whole += 1;
    seconds = 0;
  }
  if (!date1904 && whole === 60) {
    return seconds === 0
      ? "1900-02-29"
      : `1900-02-29T${pad(Math.floor(seconds / 3600))}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`;
  }
  const epoch = date1904
    ? Date.UTC(1904, 0, 1)
    : Date.UTC(1899, 11, whole < 60 ? 31 : 30);
  const moment = new Date(epoch + whole * 86_400_000 + seconds * 1000);
  const day = `${pad(moment.getUTCFullYear(), 4)}-${pad(moment.getUTCMonth() + 1)}-${pad(moment.getUTCDate())}`;
  const time = `${pad(moment.getUTCHours())}:${pad(moment.getUTCMinutes())}:${pad(moment.getUTCSeconds())}`;
  if (whole === 0 && !date1904) return time;
  return seconds === 0 ? day : `${day}T${time}`;
};

const columnIndex = (ref: string): number => {
  let index = 0;
  for (const ch of ref) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) break;
    index = index * 26 + (code - 64);
  }
  return index;
};

const columnName = (index: number): string => {
  let name = "";
  for (let n = index; n > 0; n = Math.floor((n - 1) / 26))
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
};

interface Workbook {
  readonly date1904: boolean;
  readonly sharedStrings: readonly string[];
  /** Number format code per cell style index; null for General. */
  readonly formats: readonly (string | null)[];
  readonly dateStyles: ReadonlySet<number>;
}

const readSharedStrings = (
  bytes: Uint8Array,
  counters: ReaderCounters,
  location: string,
): string[] => {
  const decoded = decodeXmlBytes(bytes);
  if (!decoded.ok) {
    counters.diagnose(location, decoded.error.message);
    return [];
  }
  const strings: string[] = [];
  const stack: string[] = [];
  let current: string | null = null;
  let phonetic = 0;
  const scanned = scanXml(
    decoded.value,
    {
      start(element) {
        stack.push(element.local);
        if (element.ns === S && element.local === "si") current = "";
        if (element.ns === S && element.local === "rPh") phonetic += 1;
      },
      end(element) {
        stack.pop();
        if (element.ns !== S) return;
        if (element.local === "rPh") phonetic -= 1;
        else if (element.local === "t" && current !== null && phonetic === 0)
          current += element.text;
        else if (element.local === "si" && current !== null) {
          if (strings.length < MAX_SHARED_STRINGS) strings.push(current);
          current = null;
        }
      },
    },
    STREAM_XML_LIMITS,
    false,
  );
  if (!scanned.ok) counters.diagnose(location, scanned.error.message);
  if (strings.length >= MAX_SHARED_STRINGS)
    counters.diagnose(
      location,
      `Only the first ${String(MAX_SHARED_STRINGS)} shared strings are held.`,
    );
  return strings;
};

const readStyles = (
  root: XmlElement | undefined,
): {
  formats: (string | null)[];
  dateStyles: Set<number>;
} => {
  const custom = new Map<number, string>();
  const formats: (string | null)[] = [];
  const dateStyles = new Set<number>();
  if (root === undefined) return { formats, dateStyles };
  const numFmts = child(root, S, "numFmts");
  for (const entry of numFmts === undefined
    ? []
    : childrenOf(numFmts, S, "numFmt")) {
    const id = Number.parseInt(attr(entry, "numFmtId") ?? "", 10);
    const code = attr(entry, "formatCode");
    if (Number.isInteger(id) && code !== undefined) custom.set(id, code);
  }
  const xfs = child(root, S, "cellXfs");
  for (const xf of xfs === undefined ? [] : childrenOf(xfs, S, "xf")) {
    const id = Number.parseInt(attr(xf, "numFmtId") ?? "0", 10);
    const index = formats.length;
    const code = custom.get(id) ?? BUILTIN_FORMATS[id] ?? null;
    formats.push(id === 0 ? null : (code ?? `builtin:${String(id)}`));
    if (
      custom.has(id)
        ? isDateFormat(custom.get(id) ?? "")
        : BUILTIN_DATE_IDS.has(id)
    )
      dateStyles.add(index);
  }
  return { formats, dateStyles };
};

interface SheetEntry {
  readonly part: OfficeContentPart;
  readonly path: string | null;
}

const SHEET_KINDS: ReadonlyMap<string, OfficeContentPart["kind"]> = new Map([
  ["worksheet", "worksheet"],
  ["chartsheet", "chartsheet"],
  ["dialogsheet", "dialog-sheet"],
  ["xlMacrosheet", "macro-sheet"],
  ["xlIntlMacrosheet", "macro-sheet"],
]);

export interface XlsxReaderInput {
  readonly pack: OpcPackage;
  readonly mainPart: string;
  readonly counters: ReaderCounters;
  readonly signal: AbortSignal | undefined;
}

export const openXlsx = async (
  input: XlsxReaderInput,
): Promise<DocumentReader> => {
  const { pack, mainPart, counters, signal } = input;
  const workbookXml = await pack.readXml(mainPart, signal);
  const rels = await pack.relationships(mainPart, signal);
  if (!workbookXml.ok) {
    counters.diagnose(mainPart, workbookXml.reason);
    return emptyReader();
  }
  const root = workbookXml.root;
  const workbookPr = child(root, S, "workbookPr");
  const date1904 = ["1", "true"].includes(
    (workbookPr === undefined
      ? ""
      : (attr(workbookPr, "date1904") ?? "")
    ).toLowerCase(),
  );

  const sheets: SheetEntry[] = [];
  const sheetList = child(root, S, "sheets");
  let order = 0;
  for (const sheet of sheetList === undefined
    ? []
    : childrenOf(sheetList, S, "sheet")) {
    order += 1;
    const relationship: Relationship | undefined = byId(
      rels,
      attr(sheet, "id", R),
    );
    const kind =
      SHEET_KINDS.get(relationship?.kind ?? "worksheet") ?? "worksheet";
    const state = attr(sheet, "state") ?? "visible";
    sheets.push({
      part: {
        id: `sheet:${String(order)}`,
        label: attr(sheet, "name") ?? `Sheet ${String(order)}`,
        kind,
        hidden: state !== "visible",
      },
      path: relationship?.part ?? null,
    });
  }
  counters.set("sheets", sheets.length);
  counters.set(
    "hidden_sheets",
    sheets.filter((entry) => entry.part.hidden).length,
  );
  counters.set(
    "macro_sheets",
    sheets.filter((entry) => entry.part.kind === "macro-sheet").length,
  );
  const names = child(root, S, "definedNames");
  if (names !== undefined)
    counters.set("defined_names", childrenOf(names, S, "definedName").length);
  const external = child(root, S, "externalReferences");
  if (external !== undefined)
    counters.set(
      "external_workbooks",
      childrenOf(external, S, "externalReference").length,
    );

  let loaded: Workbook | undefined;
  const load = async (): Promise<Workbook> => {
    if (loaded !== undefined) return loaded;
    const stringsRel = byKind(rels, "sharedStrings");
    let sharedStrings: string[] = [];
    if (stringsRel?.part != null) {
      try {
        sharedStrings = readSharedStrings(
          await pack.read(stringsRel.part, signal),
          counters,
          stringsRel.part,
        );
      } catch (cause) {
        counters.diagnose(
          stringsRel.part,
          cause instanceof Error ? cause.message : String(cause),
        );
      }
    }
    const stylesRel = byKind(rels, "styles");
    const styles =
      stylesRel?.part == null
        ? undefined
        : await pack.readXml(stylesRel.part, signal);
    if (styles !== undefined && !styles.ok)
      counters.diagnose(stylesRel?.part ?? null, styles.reason);
    const read = readStyles(styles?.ok === true ? styles.root : undefined);
    loaded = {
      date1904,
      sharedStrings,
      formats: read.formats,
      dateStyles: read.dateStyles,
    };
    return loaded;
  };

  return {
    family: "excel",
    contentParts: () => sheets.map((entry) => entry.part),
    defaultPart: () =>
      (sheets.find((entry) => !entry.part.hidden) ?? sheets[0])?.part,
    async forEach(part, visit) {
      const entry = sheets.find((candidate) => candidate.part.id === part.id);
      if (entry === undefined) return;
      if (entry.path === null) {
        counters.diagnose(null, `Sheet ${part.label} has no worksheet part.`);
        return;
      }
      if (entry.part.kind === "chartsheet") {
        counters.omit(
          "chart-sheet",
          "A chart sheet holds a chart, which is not described.",
        );
        return;
      }
      const workbook = await load();
      let bytes: Uint8Array;
      try {
        bytes = await pack.read(entry.path, signal);
      } catch (cause) {
        if (signal?.aborted === true) throw cause;
        counters.diagnose(
          entry.path,
          cause instanceof Error ? cause.message : String(cause),
        );
        return;
      }
      const decoded = decodeXmlBytes(bytes);
      if (!decoded.ok) {
        counters.diagnose(entry.path, decoded.error.message);
        return;
      }
      scanSheet(decoded.value, entry.path, workbook, counters, visit);
    },
  };
};

const emptyReader = (): DocumentReader => ({
  family: "excel",
  contentParts: () => [],
  defaultPart: () => undefined,
  forEach: async () => {},
});

interface CellDraft {
  ref: string;
  style: number | null;
  type: string;
  value: string | null;
  inline: string | null;
  formula: string | null;
  formulaKind: OfficeCell["formula_kind"];
  formulaIndex: string | null;
  hasFormula: boolean;
}

const FORMULA_KINDS: ReadonlyMap<string, OfficeCell["formula_kind"]> = new Map([
  ["shared", "shared"],
  ["array", "array"],
  ["dataTable", "data-table"],
]);

/** Largest worksheet is 1,048,576 rows by 16,384 columns (XFD). */
const MAX_ROW = 1_048_576;
const MAX_COLUMN = 16_384;
const CELL_REF = /^[A-Z]{1,3}[0-9]{1,7}$/u;
/** Longest value or format text one cell lists; longer text is cut and counted. */
const MAX_CELL_TEXT = 4_096;
const MAX_FORMAT_TEXT = 256;

const cellClip = (text: string, counters: ReaderCounters): string => {
  if (text.length <= MAX_CELL_TEXT) return text;
  counters.omit(
    "truncated-text",
    `Cell text longer than ${String(MAX_CELL_TEXT)} characters is cut.`,
  );
  return `${text.slice(0, MAX_CELL_TEXT)}…`;
};

const finishCell = (
  cell: CellDraft,
  workbook: Workbook,
  masters: Map<string, string>,
  counters: ReaderCounters,
): OfficeCell | null => {
  const rawFormat =
    cell.style === null ? null : (workbook.formats[cell.style] ?? null);
  const format =
    rawFormat !== null && rawFormat.length > MAX_FORMAT_TEXT
      ? `${rawFormat.slice(0, MAX_FORMAT_TEXT)}…`
      : rawFormat;
  const isDateStyle =
    cell.style !== null && workbook.dateStyles.has(cell.style);
  let type: OfficeCell["type"] = "number";
  // An empty number, boolean, error or date element carries no value.
  let value =
    cell.value === "" && !["s", "str"].includes(cell.type) ? null : cell.value;
  let keep = false;
  let serial: string | null = null;
  switch (cell.type) {
    case "s": {
      type = "string";
      // A shared-string cell stays listed even when its string cannot be found.
      keep = true;
      const index = Number.parseInt(cell.value ?? "", 10);
      const text = workbook.sharedStrings[index];
      if (text === undefined) {
        counters.diagnose(
          cell.ref,
          `Shared string ${cell.value ?? "?"} does not exist.`,
        );
        value = null;
      } else value = cellClip(text, counters);
      break;
    }
    case "str":
      type = "string";
      value = value === null ? null : cellClip(value, counters);
      break;
    case "inlineStr":
      type = "inline-string";
      value = cell.inline === null ? null : cellClip(cell.inline, counters);
      break;
    case "b":
      type = "boolean";
      value =
        value === "1" || value === "true"
          ? "true"
          : value === null
            ? null
            : "false";
      break;
    case "e":
      type = "error";
      value = value === null ? null : cellClip(value, counters);
      break;
    case "d":
      type = "date";
      value = value === null ? null : cellClip(value, counters);
      break;
    default: {
      if (value === null) type = "blank";
      else if (value.length > 64) value = cellClip(value, counters);
      else if (isDateStyle) {
        const formatted = formatSerial(Number(value), workbook.date1904);
        if (formatted !== null) {
          type = "date";
          serial = value;
          value = formatted;
        }
      }
    }
  }
  const hasValue = value !== null || cell.hasFormula || keep;
  if (!hasValue) return null;
  let formula = cell.formula === null ? null : cellClip(cell.formula, counters);
  let from: string | null = null;
  if (cell.formulaKind === "shared" && cell.formulaIndex !== null) {
    if (formula !== null && formula !== "")
      masters.set(cell.formulaIndex, cell.ref);
    else {
      formula = null;
      from = masters.get(cell.formulaIndex) ?? null;
    }
  }
  return {
    ref: cell.ref,
    type,
    value,
    serial,
    formula: formula === "" ? null : formula,
    formula_kind: cell.hasFormula ? (cell.formulaKind ?? "normal") : null,
    formula_from: from,
    number_format: format,
  };
};

/** Stream one worksheet part, keeping memory flat: only the current row is held. */
const scanSheet = (
  text: string,
  path: string,
  workbook: Workbook,
  counters: ReaderCounters,
  visit: (item: OfficeRow) => void,
): void => {
  let index = 0;
  let rowNumber = 0;
  let rowHidden = false;
  let cells: OfficeCell[] = [];
  let cellsDropped = 0;
  let draft: CellDraft | null = null;
  let previousColumn = 0;
  let inlineDepth = 0;
  let phonetic = 0;
  let formulaElement: XmlElement | null = null;
  const masters = new Map<string, string>();
  const scanned = scanXml(
    text,
    {
      start(element) {
        if (element.ns !== S) return;
        switch (element.local) {
          case "row": {
            const number = Number.parseInt(attr(element, "r") ?? "", 10);
            rowNumber =
              Number.isInteger(number) && number >= 1 && number <= MAX_ROW
                ? number
                : Math.min(rowNumber + 1, MAX_ROW);
            rowHidden = ["1", "true"].includes(
              (attr(element, "hidden") ?? "").toLowerCase(),
            );
            cells = [];
            cellsDropped = 0;
            previousColumn = 0;
            if (rowHidden) counters.add("hidden_rows");
            break;
          }
          case "c": {
            const declared = attr(element, "r");
            const valid =
              declared !== undefined &&
              CELL_REF.test(declared) &&
              columnIndex(declared) <= MAX_COLUMN;
            if (declared !== undefined && !valid)
              counters.diagnose(
                declared.slice(0, 32),
                "A cell reference is outside the worksheet grid; its position is taken from the previous cell.",
              );
            const ref = valid
              ? declared
              : `${columnName(Math.min(previousColumn + 1, MAX_COLUMN))}${String(rowNumber)}`;
            previousColumn = columnIndex(ref) || previousColumn + 1;
            const style = Number.parseInt(attr(element, "s") ?? "", 10);
            draft = {
              ref,
              style: Number.isInteger(style) ? style : null,
              type: attr(element, "t") ?? "n",
              value: null,
              inline: null,
              formula: null,
              formulaKind: null,
              formulaIndex: null,
              hasFormula: false,
            };
            break;
          }
          case "f":
            if (draft !== null) {
              draft.hasFormula = true;
              draft.formulaKind =
                FORMULA_KINDS.get(attr(element, "t") ?? "") ?? "normal";
              draft.formulaIndex = attr(element, "si") ?? null;
              formulaElement = element;
            }
            break;
          case "is":
            inlineDepth += 1;
            if (draft !== null) draft.inline = "";
            break;
          case "rPh":
            phonetic += 1;
            break;
          default:
            break;
        }
      },
      end(element) {
        if (element.ns !== S) return;
        switch (element.local) {
          case "v":
            if (draft !== null) draft.value = element.text;
            break;
          case "f":
            if (draft !== null && formulaElement === element) {
              draft.formula = element.text;
              formulaElement = null;
            }
            break;
          case "t":
            if (draft !== null && inlineDepth > 0 && phonetic === 0)
              draft.inline = (draft.inline ?? "") + element.text;
            break;
          case "rPh":
            phonetic -= 1;
            break;
          case "is":
            inlineDepth -= 1;
            break;
          case "c": {
            if (draft !== null) {
              counters.add("cells_scanned");
              if (draft.hasFormula) counters.add("formulas");
              const cell = finishCell(draft, workbook, masters, counters);
              if (cell === null)
                counters.omit(
                  "blank-cells",
                  "Styled cells without a value or formula are not listed.",
                );
              else if (cells.length >= MAX_CELLS_PER_ROW) cellsDropped += 1;
              else cells.push(cell);
              draft = null;
            }
            break;
          }
          case "row":
            if (cellsDropped > 0)
              counters.omit(
                "cells-past-row-limit",
                `A row lists at most ${String(MAX_CELLS_PER_ROW)} cells; the rest are counted here.`,
                cellsDropped,
              );
            if (cells.length > 0) {
              counters.add("rows_with_values");
              visit({
                kind: "row",
                index: index++,
                row: rowNumber,
                hidden: rowHidden,
                cells,
              });
            }
            cells = [];
            break;
          case "mergeCell":
            counters.add("merged_ranges");
            break;
          case "hyperlink":
            counters.add("hyperlinks");
            break;
          case "dataValidation":
            counters.add("data_validations");
            break;
          case "drawing":
          case "legacyDrawing":
            counters.omit(
              "drawing",
              "Drawings, charts and comments' shapes are not described.",
            );
            break;
          default:
            break;
        }
      },
    },
    STREAM_XML_LIMITS,
    false,
  );
  if (!scanned.ok) counters.diagnose(path, scanned.error.message);
};
