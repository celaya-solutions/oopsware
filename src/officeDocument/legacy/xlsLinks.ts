import { decodeCodepage } from "./codepage.js";
import {
  cellName,
  noCchString,
  shortString,
  xlString,
  type ContinuedReader,
} from "./xlsRecords.js";

/**
 * What a workbook says about the world outside it: supporting links (SupBook,
 * [MS-XLS] 2.4.271) with their external names, and cell hyperlinks (HLink,
 * 2.4.140, with the hyperlink object of [MS-OSHARED] 2.3.7). They are read and
 * listed; nothing is opened, resolved or fetched.
 */

export interface ExternName {
  /** Null for a record that could not be read; it keeps its place so later indexes stay right. */
  readonly name: string | null;
  /** For an external defined name, the one-based sheet it is local to; 0 when workbook-level. */
  readonly sheet: number;
  readonly fOle: boolean;
  readonly fOleLink: boolean;
}

export interface SupBook {
  readonly kind:
    | "self"
    | "addin"
    | "workbook"
    | "link"
    | "unused"
    | "same-sheet"
    | "unreadable";
  /** A readable path for an external workbook; the server and topic of a DDE or OLE link. */
  readonly target: string | null;
  readonly server: string;
  readonly topic: string;
  readonly sheets: readonly string[];
  readonly names: ExternName[];
  /** The one-based number formulas write in brackets ([1]Sheet1!A1), for external links only. */
  number: number | null;
}

/** Longest target listed for a link; longer ones are cut and marked. */
const MAX_TARGET = 2_000;
/** Most parent-folder steps a file moniker may climb before it is not listed. */
const MAX_PARENT_STEPS = 255;

const capTarget = (text: string): string => {
  if (text.length <= MAX_TARGET) return text;
  const code = text.charCodeAt(MAX_TARGET - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? MAX_TARGET - 1 : MAX_TARGET;
  return `${text.slice(0, end)}…`;
};

/**
 * A DDE or OLE link's VirtualPath is `server 0x03 topic` (the ole-link rule of
 * [MS-XLS] 2.5.277). That rule's character set leaves out "/", which DDE topics
 * such as command lines hold, so the shape decides: one 0x03, no volume code,
 * no other control characters, and no sheet names after it.
 */
// eslint-disable-next-line no-control-regex
const OLE_LINK = /^[^\u0000-\u001f]+\u0003[^\u0000-\u001f]+$/u;
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u001f]/gu;

const escapeControls = (text: string): string =>
  text.replace(
    CONTROLS,
    (ch) => `\\x${ch.charCodeAt(0).toString(16).padStart(2, "0")}`,
  );

const FOLDERS: ReadonlyMap<number, string> = new Map([
  [0x06, "(Excel startup folder)\\"],
  [0x07, "(alternate startup folder)\\"],
  [0x08, "(Excel library folder)\\"],
]);

/**
 * A VirtualPath as a readable path: the volume codes become a drive, a UNC
 * prefix or a root, 0x03 separates folders. Codes the grammar does not define
 * stay visible as \xNN.
 */
export const readablePath = (path: string): string => {
  let prefix = "";
  let rest = path;
  if (path.startsWith("\u0001")) {
    const code = path.charCodeAt(1);
    if (code === 0x01 && path[2] === "@")
      [prefix, rest] = ["\\\\", path.slice(3)];
    // A drive letter becomes "C:"; the 0x03 separators, wherever they are, become backslashes.
    else if (code === 0x01 && path.length > 2)
      [prefix, rest] = [`${path[2] ?? ""}:`, path.slice(3)];
    else if (code === 0x02) [prefix, rest] = ["\\", path.slice(2)];
    else if (code === 0x05) rest = path.slice(3);
    else if (FOLDERS.has(code))
      [prefix, rest] = [FOLDERS.get(code) ?? "", path.slice(2)];
    else rest = path.slice(1);
  }
  return escapeControls(`${prefix}${rest.replaceAll("\u0003", "\\")}`);
};

const book = (
  kind: SupBook["kind"],
  rest: Partial<Pick<SupBook, "target" | "server" | "topic" | "sheets">> = {},
): SupBook => ({
  kind,
  target: null,
  server: "",
  topic: "",
  sheets: [],
  names: [],
  number: null,
  ...rest,
});

/** A SupBook record that could not be read: it keeps its index, and nothing resolves through it. */
export const unreadableBook = (): SupBook => book("unreadable");

/** SupBook ([MS-XLS] 2.4.271); at most `limit` external sheet names are kept. */
export const readSupBook = (
  reader: ContinuedReader,
  limit: number,
): SupBook => {
  const ctab = reader.u16();
  const cch = reader.u16();
  if (cch === 0x0401) return book("self");
  if (cch === 0x3a01) return book("addin");
  if (cch < 1 || cch > 0xff)
    throw new RangeError(
      `An unknown supporting link type (cch 0x${cch.toString(16)}).`,
    );
  const path = noCchString(reader, cch);
  if (path === "\u0000") return book("same-sheet");
  if (ctab === 0 && OLE_LINK.test(path)) {
    const [server = "", topic = ""] = path.split("\u0003");
    return book("link", {
      target: capTarget(`${server}|${topic}`),
      server,
      topic,
    });
  }
  const sheets: string[] = [];
  for (let at = 0; at < Math.min(ctab, limit); at += 1)
    sheets.push(xlString(reader));
  return path === " "
    ? book("unused", { sheets })
    : book("workbook", { target: capTarget(readablePath(path)), sheets });
};

/** ExternName ([MS-XLS] 2.4.105): every body form keeps its name 4 bytes in, as a ShortXLUnicodeString. */
export const readExternName = (
  reader: ContinuedReader,
  book: SupBook,
): ExternName => {
  const flags = reader.u16();
  // ExternDocName starts with ixals; AddinUdf and the DDE/OLE bodies start with 4 reserved bytes.
  const docName =
    book.kind !== "addin" && book.kind !== "link" && book.kind !== "unreadable";
  const sheet = docName ? reader.u16() : 0;
  reader.skip(docName ? 2 : 4);
  return {
    name: shortString(reader),
    sheet,
    fOle: (flags & 0x0008) !== 0,
    fOleLink: (flags & 0x0010) !== 0,
  };
};

/** The external-reference kind a DDE or OLE supporting link is listed as. */
export const linkKind = (book: SupBook): string =>
  book.names.some((name) => name.fOleLink)
    ? "ole-link"
    : book.names.some((name) => name.fOle)
      ? "dde-link"
      : "dde-or-ole-link";

const SIMPLE_SHEET = /^[A-Za-z_][A-Za-z0-9_.]*$/u;
const LOOKS_LIKE_CELL =
  /^(?:[A-Za-z]{1,3}[0-9]+|[Rr][0-9]*[Cc]?[0-9]*|[Cc][0-9]*)$/u;

/** A sheet or item name a formula can write without quotes. */
export const isPlainName = (name: string): boolean =>
  SIMPLE_SHEET.test(name) && !LOOKS_LIKE_CELL.test(name);

export const quote = (text: string): string =>
  `'${text.replaceAll("'", "''")}'`;

export interface Hyperlink {
  /** The cell or range the link sits on. */
  readonly ref: string;
  /** Where it points outside the workbook (a URL or file path); null for a link inside it. */
  readonly target: string | null;
  /** A moniker this reader does not decode, named for a diagnostic. */
  readonly unread: string | null;
  /** The file path's ANSI bytes were decoded with an assumed code page. */
  readonly assumedCodepage: boolean;
}

const URL_MONIKER = "e0c9ea79f9bace118c8200aa004ba90b";
const FILE_MONIKER = "0303000000000000c000000000000046";

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

/** UTF-16 text up to its first NUL. */
const utf16 = (bytes: Uint8Array): string => {
  const text = Buffer.from(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength & ~1,
  ).toString("utf16le");
  const nul = text.indexOf("\u0000");
  return nul === -1 ? text : text.slice(0, nul);
};

/** HyperlinkString ([MS-OSHARED] 2.3.7.9): a character count including the NUL, then UTF-16. */
const hyperlinkString = (reader: ContinuedReader): string =>
  capTarget(utf16(reader.raw(reader.u32() * 2)));

/** A HyperlinkString this reader does not list (display and frame names): stepped over, not copied. */
const skipHyperlinkString = (reader: ContinuedReader): void => {
  reader.skip(reader.u32() * 2);
};

interface Moniker {
  readonly target: string | null;
  readonly unread: string | null;
  readonly assumed: boolean;
}

const fileMoniker = (reader: ContinuedReader, codepage: number): Moniker => {
  const up = reader.u16();
  if (up > MAX_PARENT_STEPS)
    return {
      target: null,
      unread: `a file path that climbs ${String(up)} parent folders, more than the ${String(MAX_PARENT_STEPS)} this reader lists`,
      assumed: false,
    };
  const ansi = reader.raw(reader.u32());
  reader.skip(2 + 2 + 16 + 4);
  const unicodeSize = reader.u32();
  let path: string | null = null;
  if (unicodeSize > 0) {
    const bytes = reader.u32();
    reader.skip(2);
    path = utf16(reader.raw(bytes));
  }
  const nul = ansi.indexOf(0);
  const ansiBytes = nul === -1 ? ansi : ansi.subarray(0, nul);
  // An ANSI path has no code page of its own; a Unicode workbook (1200) names none, so Windows-1252 is assumed.
  const assumed =
    path === null && codepage === 1200 && ansiBytes.some((byte) => byte > 0x7f);
  path ??=
    decodeCodepage(codepage === 1200 ? 1252 : codepage, ansiBytes) ??
    decodeCodepage(1252, ansiBytes) ??
    "";
  return {
    target: capTarget(`${"..\\".repeat(up)}${path}`),
    unread: null,
    assumed,
  };
};

const moniker = (reader: ContinuedReader, codepage: number): Moniker => {
  const clsid = hex(reader.raw(16));
  if (clsid === URL_MONIKER)
    return {
      target: capTarget(utf16(reader.raw(reader.u32()))),
      unread: null,
      assumed: false,
    };
  if (clsid === FILE_MONIKER) return fileMoniker(reader, codepage);
  return {
    target: null,
    unread: `a moniker of class ${clsid}`,
    assumed: false,
  };
};

/** HLink ([MS-XLS] 2.4.140): the range, a class id, then the hyperlink object. */
export const readHyperlink = (
  reader: ContinuedReader,
  codepage: number,
): Hyperlink => {
  const rowFirst = reader.u16();
  const rowLast = reader.u16();
  const colFirst = reader.u16();
  const colLast = reader.u16();
  const first = cellName(rowFirst, colFirst & 0xff);
  const last = cellName(rowLast, colLast & 0xff);
  const ref = first === last ? first : `${first}:${last}`;
  reader.skip(16);
  if (reader.u32() !== 2)
    return {
      ref,
      target: null,
      unread: "a hyperlink object of an unknown version",
      assumedCodepage: false,
    };
  const flags = reader.u32();
  if ((flags & 0x10) !== 0) skipHyperlinkString(reader);
  if ((flags & 0x80) !== 0) skipHyperlinkString(reader);
  if ((flags & 0x01) === 0)
    return { ref, target: null, unread: null, assumedCodepage: false };
  if ((flags & 0x100) !== 0)
    return {
      ref,
      target: hyperlinkString(reader),
      unread: null,
      assumedCodepage: false,
    };
  const read = moniker(reader, codepage);
  return {
    ref,
    target: read.target,
    unread: read.unread,
    assumedCodepage: read.assumed,
  };
};
