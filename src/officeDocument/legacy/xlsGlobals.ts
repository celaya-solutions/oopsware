import type { ReaderCounters } from "../reader.js";
import {
  checkpoint,
  LegacyEncryptedError,
  LegacyFormatError,
} from "./legacy.js";
import {
  readExternName,
  readHyperlink,
  readSupBook,
  unreadableBook,
  type Hyperlink,
  type SupBook,
} from "./xlsLinks.js";
import {
  noCchString,
  RecordWalker,
  RT,
  shortString,
  xlString,
} from "./xlsRecords.js";

/**
 * The workbook globals of a BIFF8 Workbook stream ([MS-XLS] 2.1.7.20.3) and an
 * index of the sheet substreams that follow them, built in one pass over the
 * record headers. Cells are not read here; only what the package view needs
 * (sheets, names, links, hyperlinks) and what the cell reader will need.
 */

export const BIFF5 =
  "This is an Excel 5.0/95 workbook (BIFF5). Only Excel 97-2003 workbooks (BIFF8) are read.";

/** Entries kept per list (sheets, styles, names, supporting links, XTIs); BIFF8 indexes them with 16 bits. */
const MAX_LIST = 65_536;
/** Hyperlinks parsed while the workbook is opened; the rest are counted. */
const MAX_HYPERLINKS = 10_000;

export interface BoundSheet {
  readonly name: string;
  /** lbPlyPos: the stream offset of the sheet's BOF record. */
  readonly position: number;
  /** hsState: 0 visible, 1 hidden, 2 very hidden. */
  readonly state: number;
  /** dt: 0 worksheet or dialog, 1 macro sheet, 2 chart, 6 VBA module. */
  readonly type: number;
}

export interface Substream {
  readonly start: number;
  /** The BOF dt: 0x10 worksheet or dialog, 0x20 chart, 0x40 macro sheet. */
  readonly dt: number;
  dialog: boolean;
  /** Offset just past the matching EOF, or the stream end when there is none. */
  end: number;
  complete: boolean;
  readonly hyperlinks: Hyperlink[];
}

export interface Xti {
  readonly book: number;
  readonly first: number;
  readonly last: number;
}

export interface Workbook {
  readonly bytes: Uint8Array;
  readonly date1904: boolean;
  readonly codepage: number;
  readonly boundSheets: readonly BoundSheet[];
  /** The number format id of each XF record, by XF index. */
  readonly xfFormats: readonly number[];
  readonly formats: ReadonlyMap<number, string>;
  /** Defined names (NAME records) in order, null where one could not be read; PtgName counts from 1. */
  readonly names: readonly (string | null)[];
  readonly supBooks: readonly SupBook[];
  readonly xti: readonly Xti[];
  /** Where the shared string table is; it is read when a sheet is walked. */
  readonly sst: { readonly start: number; readonly length: number } | null;
  readonly substreams: ReadonlyMap<number, Substream>;
  readonly hyperlinksDropped: number;
}

const BUILTIN_NAMES = [
  "Consolidate_Area",
  "Auto_Open",
  "Auto_Close",
  "Extract",
  "Database",
  "Criteria",
  "Print_Area",
  "Print_Titles",
  "Recorder",
  "Data_Form",
  "Auto_Activate",
  "Auto_Deactivate",
  "Sheet_Title",
  "_FilterDatabase",
];

const OLDER: ReadonlyMap<number, string> = new Map([
  [0x0409, "an Excel 4.0 file (BIFF4)"],
  [0x0209, "an Excel 3.0 file (BIFF3)"],
  [0x0009, "an Excel 2.x file (BIFF2)"],
]);

const u16At = (bytes: Uint8Array, at: number): number =>
  (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);

const signed16 = (value: number): number => (value << 16) >> 16;

/** The first record must be a BIFF8 BOF that opens the workbook globals. */
const checkBof = (walker: RecordWalker, bytes: Uint8Array): void => {
  if (walker.type === RT.bof && walker.length >= 4) {
    const version = u16At(bytes, walker.start);
    if (version === 0x0500) throw new LegacyFormatError(BIFF5);
    if (version !== 0x0600)
      throw new LegacyFormatError(
        `The Workbook stream starts with a BOF record of BIFF version 0x${version.toString(16)}; only Excel 97-2003 workbooks (BIFF8, version 0x600) are read.`,
      );
    if (u16At(bytes, walker.start + 2) !== 0x0005)
      throw new LegacyFormatError(
        "The Workbook stream does not begin with the workbook globals, so it cannot be read as a BIFF8 workbook.",
      );
    return;
  }
  const older = OLDER.get(walker.type);
  throw new LegacyFormatError(
    older === undefined
      ? "The Workbook stream does not start with a BOF record, so it is not a BIFF8 workbook."
      : `The Workbook stream is ${older}. Only Excel 97-2003 workbooks (BIFF8) are read.`,
  );
};

const encrypted = (bytes: Uint8Array, walker: RecordWalker): never => {
  const type = walker.length >= 2 ? u16At(bytes, walker.start) : -1;
  const method =
    type === 0
      ? "XOR obfuscation"
      : type === 1
        ? "RC4 encryption"
        : "an encryption method";
  throw new LegacyEncryptedError(
    `The workbook is password-protected (a FilePass record declares ${method}). No password is tried and nothing is decrypted.`,
  );
};

interface Globals {
  date1904: boolean;
  codepage: number;
  readonly boundSheets: BoundSheet[];
  readonly xfFormats: number[];
  readonly formats: Map<number, string>;
  readonly names: (string | null)[];
  readonly supBooks: SupBook[];
  readonly xti: Xti[];
  sst: { start: number; length: number } | null;
  /** External sheet names and external names still kept, across every supporting link. */
  externLeft: number;
}

const RECORD_NAMES: ReadonlyMap<number, string> = new Map([
  [RT.boundSheet, "BoundSheet8"],
  [RT.format, "Format"],
  [RT.supBook, "SupBook"],
  [RT.externName, "ExternName"],
  [RT.externSheet, "ExternSheet"],
  [RT.name, "Lbl (NAME)"],
]);

/** What one pass over the Workbook stream reads with. */
interface Pass {
  readonly walker: RecordWalker;
  readonly bytes: Uint8Array;
  readonly counters: ReaderCounters;
  readonly signal: AbortSignal | undefined;
}

const keep = <T>(pass: Pass, list: T[], value: T, what: string): void => {
  if (list.length < MAX_LIST) list.push(value);
  else if (list.length === MAX_LIST)
    pass.counters.diagnose(
      "Workbook",
      `Only the first ${String(MAX_LIST)} ${what} are kept.`,
    );
};

/** Count external sheet names and external names against one budget for the whole workbook. */
const spend = (pass: Pass, state: Globals, count: number): void => {
  if (count === 0 || state.externLeft === 0) return;
  state.externLeft = Math.max(0, state.externLeft - count);
  if (state.externLeft === 0)
    pass.counters.diagnose(
      "Workbook",
      `Only the first ${String(MAX_LIST)} external sheet names and external names are kept.`,
    );
};

/** Lbl ([MS-XLS] 2.4.150): flags, chKey, cch, cce, reserved, itab, 4 reserved bytes, then the name. */
const definedName = (pass: Pass): string => {
  const reader = pass.walker.reader();
  const flags = reader.u16();
  reader.skip(1);
  const length = reader.u8();
  reader.skip(10);
  const name = noCchString(reader, length);
  return (flags & 0x20) !== 0
    ? (BUILTIN_NAMES[name.charCodeAt(0)] ?? name)
    : name;
};

const externSheet = (pass: Pass, state: Globals): void => {
  const reader = pass.walker.reader();
  const count = reader.u16();
  for (let at = 0; at < count; at += 1) {
    const book = reader.u16();
    const first = signed16(reader.u16());
    keep(
      pass,
      state.xti,
      { book, first, last: signed16(reader.u16()) },
      "sheet references",
    );
  }
};

const boundSheet = (pass: Pass): BoundSheet => {
  const reader = pass.walker.reader();
  const position = reader.u32();
  const hidden = reader.u8() & 0x03;
  const type = reader.u8();
  return { position, state: hidden, type, name: shortString(reader) };
};

/** Read one globals record into the collected state. */
const globalRecord = (pass: Pass, state: Globals): void => {
  const { walker, bytes } = pass;
  switch (walker.type) {
    case RT.filePass:
      encrypted(bytes, walker);
      return;
    case RT.codePage:
      if (walker.length >= 2) state.codepage = u16At(bytes, walker.start);
      return;
    case RT.date1904:
      if (walker.length >= 2) state.date1904 = u16At(bytes, walker.start) === 1;
      return;
    case RT.boundSheet:
      keep(pass, state.boundSheets, boundSheet(pass), "sheets");
      return;
    case RT.sst:
      state.sst ??= { start: walker.start, length: walker.length };
      return;
    case RT.xf:
      // A short XF still takes its index, so the cells after it keep the right formats.
      if (walker.length < 4)
        pass.counters.diagnose(
          "Workbook",
          `The XF record at offset ${String(walker.offset)} is shorter than 4 bytes; cells using it get no number format.`,
        );
      keep(
        pass,
        state.xfFormats,
        walker.length < 4 ? -1 : u16At(bytes, walker.start + 2),
        "cell formats",
      );
      return;
    case RT.format: {
      const reader = walker.reader();
      const id = reader.u16();
      if (state.formats.size < MAX_LIST)
        state.formats.set(id, xlString(reader));
      return;
    }
    case RT.supBook: {
      const book = readSupBook(walker.reader(), state.externLeft);
      spend(pass, state, book.sheets.length);
      keep(pass, state.supBooks, book, "supporting links");
      return;
    }
    case RT.externName: {
      const book = state.supBooks.at(-1);
      if (book === undefined)
        pass.counters.diagnose(
          "Workbook",
          "An ExternName record comes before any SupBook record; it is not read.",
        );
      else if (state.externLeft > 0) {
        book.names.push(readExternName(walker.reader(), book));
        spend(pass, state, 1);
      }
      return;
    }
    case RT.externSheet:
      externSheet(pass, state);
      return;
    case RT.name:
      keep(pass, state.names, definedName(pass), "defined names");
      return;
    default:
      return;
  }
};

/**
 * The slot a malformed record would have filled: BoundSheet8, SupBook, Lbl and
 * ExternName records are found by position, so a skipped one would shift every
 * later index onto the wrong record. The placeholder resolves to nothing.
 */
const placeholder = (pass: Pass, state: Globals, type: number): void => {
  switch (type) {
    case RT.boundSheet:
      keep(
        pass,
        state.boundSheets,
        { name: "", position: -1, state: 0, type: -1 },
        "sheets",
      );
      return;
    case RT.supBook:
      keep(pass, state.supBooks, unreadableBook(), "supporting links");
      return;
    case RT.name:
      keep(pass, state.names, null, "defined names");
      return;
    case RT.externName: {
      const book = state.supBooks.at(-1);
      if (book === undefined || state.externLeft === 0) return;
      book.names.push({ name: null, sheet: 0, fOle: false, fOleLink: false });
      spend(pass, state, 1);
      return;
    }
    default:
      return;
  }
};

const readGlobals = async (pass: Pass): Promise<Globals> => {
  const state: Globals = {
    date1904: false,
    codepage: 1200,
    boundSheets: [],
    xfFormats: [],
    formats: new Map(),
    names: [],
    supBooks: [],
    xti: [],
    sst: null,
    externLeft: MAX_LIST,
  };
  const { walker, counters } = pass;
  let seen = 0;
  while (walker.advance()) {
    if ((++seen & 0xfff) === 0) await checkpoint(pass.signal);
    if (walker.type === RT.eof) return state;
    try {
      globalRecord(pass, state);
    } catch (cause) {
      if (!(cause instanceof RangeError)) throw cause;
      counters.diagnose(
        "Workbook",
        `The ${RECORD_NAMES.get(walker.type) ?? "globals"} record at offset ${String(walker.offset)} is cut short or malformed and was skipped: ${cause.message}`,
      );
      placeholder(pass, state, walker.type);
    }
  }
  counters.diagnose(
    "Workbook",
    "The workbook globals end without an EOF record; the stream is cut off.",
  );
  return state;
};

interface LinkBudget {
  readonly codepage: number;
  parsed: number;
  dropped: number;
}

/** A sheet's own records the index keeps: the dialog flag and hyperlinks. */
const sheetRecord = (
  pass: Pass,
  current: Substream,
  links: LinkBudget,
): void => {
  const { walker, bytes } = pass;
  if (walker.type === RT.wsBool && walker.length >= 1) {
    current.dialog ||= ((bytes[walker.start] ?? 0) & 0x10) !== 0;
    return;
  }
  if (walker.type !== RT.hlink) return;
  if (links.parsed >= MAX_HYPERLINKS) {
    links.dropped += 1;
    return;
  }
  links.parsed += 1;
  try {
    current.hyperlinks.push(readHyperlink(walker.reader(), links.codepage));
  } catch (cause) {
    if (!(cause instanceof RangeError)) throw cause;
    pass.counters.diagnose(
      null,
      `A hyperlink record at offset ${String(walker.offset)} is cut short and was skipped.`,
    );
  }
};

/** Index every top-level substream after the globals; a BOF at depth one or more opens an embedded chart. */
const indexSubstreams = async (
  pass: Pass,
  codepage: number,
): Promise<{ substreams: Map<number, Substream>; dropped: number }> => {
  const { walker, bytes } = pass;
  const substreams = new Map<number, Substream>();
  const links: LinkBudget = { codepage, parsed: 0, dropped: 0 };
  let current: Substream | undefined;
  let depth = 0;
  let seen = 0;
  while (walker.advance()) {
    if ((++seen & 0xfff) === 0) await checkpoint(pass.signal);
    if (depth === 0) {
      if (walker.type !== RT.bof) continue;
      current = {
        start: walker.offset,
        dt: walker.length >= 4 ? u16At(bytes, walker.start + 2) : 0,
        dialog: false,
        end: bytes.length,
        complete: false,
        hyperlinks: [],
      };
      // A BoundSheet8 list holds at most MAX_LIST sheets, so more substreams could never be read.
      if (substreams.size < MAX_LIST) substreams.set(current.start, current);
      depth = 1;
    } else if (walker.type === RT.bof) depth += 1;
    else if (walker.type === RT.eof) {
      depth -= 1;
      if (depth === 0 && current !== undefined) {
        current.end = walker.start + walker.length;
        current.complete = true;
      }
    } else if (depth === 1 && current !== undefined)
      sheetRecord(pass, current, links);
  }
  return { substreams, dropped: links.dropped };
};

/** Read the globals of a BIFF8 Workbook stream and index its sheets. */
export const readWorkbook = async (
  bytes: Uint8Array,
  counters: ReaderCounters,
  signal: AbortSignal | undefined,
): Promise<Workbook> => {
  const walker = new RecordWalker(bytes, 0);
  if (!walker.advance())
    throw new LegacyFormatError(
      "The Workbook stream is empty or ends inside its first record.",
    );
  checkBof(walker, bytes);
  const pass: Pass = { walker, bytes, counters, signal };
  const globals = await readGlobals(pass);
  const { substreams, dropped } = await indexSubstreams(pass, globals.codepage);
  if (walker.truncated)
    counters.diagnose(
      "Workbook",
      "The Workbook stream ends inside a record; the records before it are read.",
    );
  let number = 0;
  for (const book of globals.supBooks)
    if (book.kind === "workbook" || book.kind === "link")
      book.number = number += 1;
  return { bytes, ...globals, substreams, hyperlinksDropped: dropped };
};
