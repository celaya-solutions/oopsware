/**
 * A BIFF8 workbook writer for fixtures, written from [MS-XLS] and the hyperlink
 * object of [MS-OSHARED] 2.3.7 (no .xls producer is installed on this host).
 * It writes the records the tests need: workbook globals with BoundSheet8
 * offsets, a shared string table split across CONTINUE records, number
 * formats, supporting links, names, and sheets with every cell record type and
 * formula tokens. It is independent of the reader: tests assert the values put
 * in, worked out from the spec.
 */

import { writeCompoundFile } from "./cfbWriter.js";

export type Bytes = number[];

export const le16 = (value: number): Bytes => [
  value & 0xff,
  (value >>> 8) & 0xff,
];
export const le32 = (value: number): Bytes => [
  ...le16(value & 0xffff),
  ...le16((value >>> 16) & 0xffff),
];
export const f64 = (value: number): Bytes => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, true);
  return [...new Uint8Array(view.buffer)];
};

/** A record: 2-byte type, 2-byte size, data ([MS-XLS] 2.1.4). */
export const record = (type: number, data: Bytes = []): Bytes => [
  ...le16(type),
  ...le16(data.length),
  ...data,
];

const wideNeeded = (text: string): boolean =>
  [...text].some((ch) => (ch.codePointAt(0) ?? 0) > 0xff);

const chars = (text: string, wide: boolean): Bytes =>
  wide
    ? [...Buffer.from(text, "utf16le")]
    : [...text].map((ch) => ch.charCodeAt(0));

/** XLUnicodeString: cch (2), fHighByte, characters. */
export const xlUnicode = (text: string): Bytes => {
  const wide = wideNeeded(text);
  return [...le16(text.length), wide ? 1 : 0, ...chars(text, wide)];
};

/** ShortXLUnicodeString: cch (1), fHighByte, characters. */
export const shortXl = (text: string): Bytes => {
  const wide = wideNeeded(text);
  return [text.length, wide ? 1 : 0, ...chars(text, wide)];
};

/** XLUnicodeStringNoCch: fHighByte, characters. */
export const noCch = (text: string): Bytes => {
  const wide = wideNeeded(text);
  return [wide ? 1 : 0, ...chars(text, wide)];
};

export interface SstEntry {
  readonly text: string;
  /** Formatting runs (4 bytes each) written after the characters. */
  readonly runs?: number;
  /** Phonetic data bytes (ExtRst) written after the runs. */
  readonly phonetic?: number;
}

/**
 * The SST and its CONTINUE records with at most `max` data bytes each. A string
 * header never splits; characters that run on start the next record with a
 * byte restating fHighByte for the characters in that record; runs and
 * phonetic data split as raw bytes.
 */
export const sstRecords = (
  entries: readonly (string | SstEntry)[],
  max = 8224,
): Bytes => {
  const records: Bytes[] = [];
  let current: Bytes = [...le32(entries.length), ...le32(entries.length)];
  let type = 0x00fc;
  const flush = (): void => {
    records.push(record(type, current));
    type = 0x003c;
    current = [];
  };
  const raw = (bytes: Bytes): void => {
    for (const byte of bytes) {
      if (current.length >= max) flush();
      current.push(byte);
    }
  };
  // How many of the next characters fit in `room` bytes, and whether they need two bytes each.
  const fit = (text: string, from: number, room: number): [number, boolean] => {
    const narrow = Math.min(room, text.length - from);
    if (!wideNeeded(text.slice(from, from + narrow))) return [narrow, false];
    return [Math.min(Math.floor(room / 2), text.length - from), true];
  };
  for (const entry of entries) {
    const {
      text,
      runs = 0,
      phonetic = 0,
    } = typeof entry === "string" ? { text: entry } : entry;
    const headerSize = 3 + (runs > 0 ? 2 : 0) + (phonetic > 0 ? 4 : 0);
    // The header and at least one more byte stay in one record.
    if (current.length + headerSize + 1 > max) flush();
    const [, firstWide] = fit(text, 0, max - current.length - headerSize);
    current.push(
      ...le16(text.length),
      (firstWide ? 1 : 0) | (phonetic > 0 ? 4 : 0) | (runs > 0 ? 8 : 0),
    );
    if (runs > 0) current.push(...le16(runs));
    if (phonetic > 0) current.push(...le32(phonetic));
    let at = 0;
    let wide = firstWide;
    for (let first = true; at < text.length; first = false) {
      if (!first) {
        flush();
        [, wide] = fit(text, at, max - 1);
        current.push(wide ? 1 : 0);
      }
      const room = max - current.length;
      const count = Math.min(
        wide ? Math.floor(room / 2) : room,
        text.length - at,
      );
      current.push(...chars(text.slice(at, at + count), wide));
      at += count;
    }
    raw(Array.from({ length: runs * 4 }, (_, i) => i & 0xff));
    raw(Array.from({ length: phonetic }, (_, i) => (i * 3) & 0xff));
  }
  flush();
  return records.flat();
};

/** FormulaValue ([MS-XLS] 2.5.133): a number, or a typed value marked by 0xFFFF in its last two bytes. */
export type Cached =
  | number
  | { readonly string: true }
  | { readonly boolean: boolean }
  | { readonly error: number }
  | { readonly empty: true };

const cachedBytes = (cached: Cached): Bytes => {
  if (typeof cached === "number") return f64(cached);
  if ("string" in cached) return [0, 0, 0, 0, 0, 0, 0xff, 0xff];
  if ("boolean" in cached)
    return [1, 0, cached.boolean ? 1 : 0, 0, 0, 0, 0xff, 0xff];
  if ("error" in cached) return [2, 0, cached.error, 0, 0, 0, 0xff, 0xff];
  return [3, 0, 0, 0, 0, 0, 0xff, 0xff];
};

const at3 = (row: number, col: number, xf: number): Bytes => [
  ...le16(row),
  ...le16(col),
  ...le16(xf),
];

/** Cell and sheet records ([MS-XLS] 2.4). */
export const cells = {
  labelSst: (row: number, col: number, xf: number, index: number): Bytes =>
    record(0x00fd, [...at3(row, col, xf), ...le32(index)]),
  label: (row: number, col: number, xf: number, text: string): Bytes =>
    record(0x0204, [...at3(row, col, xf), ...xlUnicode(text)]),
  number: (row: number, col: number, xf: number, value: number): Bytes =>
    record(0x0203, [...at3(row, col, xf), ...f64(value)]),
  rk: (row: number, col: number, xf: number, rk: number): Bytes =>
    record(0x027e, [...at3(row, col, xf), ...le32(rk)]),
  mulRk: (
    row: number,
    first: number,
    values: readonly [number, number][],
    last?: number,
  ): Bytes =>
    record(0x00bd, [
      ...le16(row),
      ...le16(first),
      ...values.flatMap(([xf, rk]) => [...le16(xf), ...le32(rk)]),
      ...le16(last ?? first + values.length - 1),
    ]),
  blank: (row: number, col: number, xf: number): Bytes =>
    record(0x0201, at3(row, col, xf)),
  mulBlank: (row: number, first: number, xfs: readonly number[]): Bytes =>
    record(0x00be, [
      ...le16(row),
      ...le16(first),
      ...xfs.flatMap(le16),
      ...le16(first + xfs.length - 1),
    ]),
  boolErr: (
    row: number,
    col: number,
    xf: number,
    value: number,
    error: boolean,
  ): Bytes => record(0x0205, [...at3(row, col, xf), value, error ? 1 : 0]),
  /** FORMULA: cell, cached value, flags (fShrFmla = 0x08), chn, cce, rgce, then the extra data. */
  formula: (
    row: number,
    col: number,
    xf: number,
    cached: Cached,
    rgce: Bytes,
    extra: Bytes = [],
    flags = 0,
  ): Bytes =>
    record(0x0006, [
      ...at3(row, col, xf),
      ...cachedBytes(cached),
      ...le16(flags),
      ...le32(0),
      ...le16(rgce.length),
      ...rgce,
      ...extra,
    ]),
  string: (text: string): Bytes => record(0x0207, xlUnicode(text)),
  /** SHRFMLA: RefU (rows 2+2, columns 1+1), reserved, cUse, cce, rgce. */
  shrFmla: (
    rows: [number, number],
    cols: [number, number],
    rgce: Bytes,
  ): Bytes =>
    record(0x04bc, [
      ...le16(rows[0]),
      ...le16(rows[1]),
      cols[0],
      cols[1],
      0,
      (rows[1] - rows[0] + 1) * (cols[1] - cols[0] + 1),
      ...le16(rgce.length),
      ...rgce,
    ]),
  /** ARRAY: RefU, flags, 4 unused bytes, cce, rgce. */
  array: (rows: [number, number], cols: [number, number], rgce: Bytes): Bytes =>
    record(0x0221, [
      ...le16(rows[0]),
      ...le16(rows[1]),
      cols[0],
      cols[1],
      ...le16(0),
      ...le32(0),
      ...le16(rgce.length),
      ...rgce,
    ]),
  /** TABLE: RefU, flags, then the row and column input cells. */
  table: (rows: [number, number], cols: [number, number]): Bytes =>
    record(0x0236, [
      ...le16(rows[0]),
      ...le16(rows[1]),
      cols[0],
      cols[1],
      ...le16(0),
      ...le16(0),
      ...le16(0),
      ...le16(0),
      ...le16(1),
    ]),
  /** ROW: rw, colMic, colMac, miyRw, reserved, unused, then flags with fDyZero (0x20) in byte 12. */
  row: (row: number, hidden: boolean): Bytes =>
    record(0x0208, [
      ...le16(row),
      ...le16(0),
      ...le16(4),
      ...le16(255),
      ...le16(0),
      ...le16(0),
      hidden ? 0x20 : 0,
      0x01,
      ...le16(0x0f),
    ]),
  mergeCells: (count: number): Bytes =>
    record(0x00e5, [
      ...le16(count),
      ...Array.from({ length: count }, (_, i) => [
        ...le16(i),
        ...le16(i),
        ...le16(0),
        ...le16(1),
      ]).flat(),
    ]),
  note: (row: number, col: number): Bytes =>
    record(0x001c, [
      ...le16(row),
      ...le16(col),
      ...le16(0),
      ...le16(1),
      ...xlUnicode("A"),
      0,
    ]),
  obj: (): Bytes =>
    record(0x005d, [...le16(0x15), ...le16(0x12), ...le16(0x0019), ...le16(1)]),
};

/** Column field of a cell reference: the column, bit 14 = relative column, bit 15 = relative row. */
const colField = (col: number, rowRel: boolean, colRel: boolean): Bytes =>
  le16((col & 0x3fff) | (colRel ? 0x4000 : 0) | (rowRel ? 0x8000 : 0));

export interface RefFlags {
  readonly rowRel?: boolean;
  readonly colRel?: boolean;
}

/** Formula tokens ([MS-XLS] 2.5.198); operands are written in their reference (0x20) or value (0x40) class. */
export const ptg = {
  exp: (row: number, col: number): Bytes => [0x01, ...le16(row), ...le16(col)],
  tbl: (row: number, col: number): Bytes => [0x02, ...le16(row), ...le16(col)],
  add: [0x03],
  sub: [0x04],
  mul: [0x05],
  div: [0x06],
  power: [0x07],
  concat: [0x08],
  lt: [0x09],
  gt: [0x0d],
  ne: [0x0e],
  union: [0x10],
  range: [0x11],
  uminus: [0x13],
  percent: [0x14],
  paren: [0x15],
  missArg: [0x16],
  str: (text: string): Bytes => [0x17, ...shortXl(text)],
  attrSemi: [0x19, 0x01, 0, 0],
  attrIf: (skip: number): Bytes => [0x19, 0x02, ...le16(skip)],
  attrChoose: (offsets: readonly number[]): Bytes => [
    0x19,
    0x04,
    ...le16(offsets.length - 1),
    ...offsets.flatMap(le16),
  ],
  attrGoto: (skip: number): Bytes => [0x19, 0x08, ...le16(skip)],
  attrSum: [0x19, 0x10, 0, 0],
  attrSpace: (count: number): Bytes => [0x19, 0x40, 0x00, count],
  attrBaxcel: [0x19, 0x20, 0, 0],
  elfLel: [0x18, 0x01, 0, 0, 0, 0],
  err: (code: number): Bytes => [0x1c, code],
  bool: (value: boolean): Bytes => [0x1d, value ? 1 : 0],
  int: (value: number): Bytes => [0x1e, ...le16(value)],
  num: (value: number): Bytes => [0x1f, ...f64(value)],
  /** PtgArray: 7 unused bytes; the values go in the extra data (arrayExtra). */
  array: [0x60, 0, 0, 0, 0, 0, 0, 0],
  func: (iftab: number): Bytes => [0x41, ...le16(iftab)],
  funcVar: (count: number, tab: number, command = false): Bytes => [
    0x42,
    count,
    ...le16(tab | (command ? 0x8000 : 0)),
  ],
  name: (index: number): Bytes => [0x43, ...le32(index)],
  ref: (row: number, col: number, flags: RefFlags = {}): Bytes => [
    0x24,
    ...le16(row),
    ...colField(col, flags.rowRel ?? true, flags.colRel ?? true),
  ],
  area: (
    rows: [number, number],
    cols: [number, number],
    flags: RefFlags = {},
  ): Bytes => [
    0x25,
    ...le16(rows[0]),
    ...le16(rows[1]),
    ...colField(cols[0], flags.rowRel ?? true, flags.colRel ?? true),
    ...colField(cols[1], flags.rowRel ?? true, flags.colRel ?? true),
  ],
  memFunc: (size: number): Bytes => [0x29, ...le16(size)],
  refErr: [0x2a, 0, 0, 0, 0],
  /** PtgRefN: relative parts are offsets from the formula's cell. */
  refN: (dRow: number, dCol: number): Bytes => [
    0x2c,
    ...le16(dRow & 0xffff),
    ...colField(dCol & 0xff, true, true),
  ],
  nameX: (ixti: number, index: number): Bytes => [
    0x39,
    ...le16(ixti),
    ...le32(index),
  ],
  ref3d: (ixti: number, row: number, col: number): Bytes => [
    0x3a,
    ...le16(ixti),
    ...le16(row),
    ...colField(col, true, true),
  ],
  area3d: (
    ixti: number,
    rows: [number, number],
    cols: [number, number],
  ): Bytes => [
    0x3b,
    ...le16(ixti),
    ...le16(rows[0]),
    ...le16(rows[1]),
    ...colField(cols[0], false, false),
    ...colField(cols[1], false, false),
  ],
};

export type SerValue =
  | number
  | string
  | boolean
  | { readonly error: number }
  | null;

/** PtgExtraArray: columns - 1 (1 byte), rows - 1 (2 bytes), then SerAr values row by row. */
export const arrayExtra = (rows: readonly (readonly SerValue[])[]): Bytes => [
  (rows[0]?.length ?? 1) - 1,
  ...le16(rows.length - 1),
  ...rows.flat().flatMap((value): Bytes => {
    if (value === null) return [0x00, ...Array<number>(8).fill(0)];
    if (typeof value === "number") return [0x01, ...f64(value)];
    if (typeof value === "string") return [0x02, ...xlUnicode(value)];
    if (typeof value === "boolean")
      return [0x04, value ? 1 : 0, ...Array<number>(7).fill(0)];
    return [0x10, value.error, ...Array<number>(7).fill(0)];
  }),
];

/** Records of the workbook globals. */
export const globals = {
  filePass: (method: 0 | 1): Bytes =>
    record(0x002f, [...le16(method), ...Array<number>(52).fill(0x11)]),
  codePage: (codepage: number): Bytes => record(0x0042, le16(codepage)),
  date1904: (): Bytes => record(0x0022, le16(1)),
  format: (id: number, code: string): Bytes =>
    record(0x041e, [...le16(id), ...xlUnicode(code)]),
  /** XF: ifnt, ifmt, then 16 bytes of protection, alignment and borders. */
  xf: (ifmt: number): Bytes =>
    record(0x00e0, [
      ...le16(0),
      ...le16(ifmt),
      ...le16(0x0001),
      ...Array<number>(14).fill(0),
    ]),
  supBookSelf: (sheets: number): Bytes =>
    record(0x01ae, [...le16(sheets), ...le16(0x0401)]),
  supBookAddin: (): Bytes => record(0x01ae, [...le16(1), ...le16(0x3a01)]),
  /** An external workbook or a DDE/OLE link: cch, the VirtualPath and, for a workbook, its sheet names. */
  supBook: (path: string, sheets: readonly string[] = []): Bytes =>
    record(0x01ae, [
      ...le16(sheets.length),
      ...le16(path.length),
      ...noCch(path),
      ...sheets.flatMap(xlUnicode),
    ]),
  /** ExternName: flags, then ixals + reserved (an external defined name) or 4 reserved bytes, the name, a definition. */
  externName: (
    name: string,
    options: {
      readonly flags?: number;
      readonly ixals?: number;
      readonly docName?: boolean;
    } = {},
  ): Bytes =>
    record(0x0023, [
      ...le16(options.flags ?? 0),
      ...(options.docName === true
        ? [...le16(options.ixals ?? 0), 0, 0]
        : [0, 0, 0, 0]),
      ...shortXl(name),
      ...le16(0),
    ]),
  externSheet: (entries: readonly [number, number, number][]): Bytes =>
    record(0x0017, [
      ...le16(entries.length),
      ...entries.flatMap(([book, first, last]) => [
        ...le16(book),
        ...le16(first),
        ...le16(last),
      ]),
    ]),
  /** Lbl: flags (fBuiltin 0x20), chKey, cch, cce, reserved, itab, 4 reserved bytes, the name, rgce. */
  name: (name: string, builtin = false): Bytes =>
    record(0x0018, [
      ...le16(builtin ? 0x20 : 0),
      0,
      name.length,
      ...le16(5),
      ...le16(0),
      ...le16(0),
      0,
      0,
      0,
      0,
      ...noCch(name),
      ...ptg.ref(0, 0),
    ]),
};

const URL_MONIKER = [
  0xe0, 0xc9, 0xea, 0x79, 0xf9, 0xba, 0xce, 0x11, 0x8c, 0x82, 0x00, 0xaa, 0x00,
  0x4b, 0xa9, 0x0b,
];
const FILE_MONIKER = [
  0x03, 0x03, 0, 0, 0, 0, 0, 0, 0xc0, 0, 0, 0, 0, 0, 0, 0x46,
];
const STD_LINK = [
  0xd0, 0xc9, 0xea, 0x79, 0xf9, 0xba, 0xce, 0x11, 0x8c, 0x82, 0x00, 0xaa, 0x00,
  0x4b, 0xa9, 0x0b,
];

/** HyperlinkString: a character count including the NUL, then UTF-16. */
const hyperlinkString = (text: string): Bytes => [
  ...le32(text.length + 1),
  ...Buffer.from(`${text}\u0000`, "utf16le"),
];

export type LinkTarget =
  | { readonly url: string }
  | { readonly file: string; readonly up?: number }
  | { readonly location: string }
  | { readonly saved: string };

/** HLink: Ref8U, the StdLink class id, then a hyperlink object ([MS-OSHARED] 2.3.7.1). */
export const hlink = (row: number, col: number, target: LinkTarget): Bytes => {
  const head = [
    ...le16(row),
    ...le16(row),
    ...le16(col),
    ...le16(col),
    ...STD_LINK,
    ...le32(2),
  ];
  if ("url" in target)
    return record(0x01b8, [
      ...head,
      ...le32(0x03),
      ...URL_MONIKER,
      ...le32((target.url.length + 1) * 2),
      ...Buffer.from(`${target.url}\u0000`, "utf16le"),
    ]);
  if ("file" in target)
    return record(0x01b8, [
      ...head,
      ...le32(0x01),
      ...FILE_MONIKER,
      ...le16(target.up ?? 0),
      ...le32(target.file.length + 1),
      ...[...target.file].map((ch) => ch.charCodeAt(0)),
      0,
      ...le16(0xffff),
      ...le16(0xdead),
      ...Array<number>(20).fill(0),
      ...le32(0),
    ]);
  if ("location" in target)
    return record(0x01b8, [
      ...head,
      ...le32(0x08),
      ...hyperlinkString(target.location),
    ]);
  return record(0x01b8, [
    ...head,
    ...le32(0x101),
    ...hyperlinkString(target.saved),
  ]);
};

export interface XlsSheetSpec {
  readonly name: string;
  readonly kind?: "worksheet" | "dialog" | "macro" | "chart" | "module";
  /** hsState: 0 visible, 1 hidden, 2 very hidden. */
  readonly state?: number;
  readonly records?: readonly Bytes[];
}

export interface XlsSpec {
  readonly sheets: readonly XlsSheetSpec[];
  /** Records right after the globals BOF (FilePass, CodePage, Date1904). */
  readonly preamble?: readonly Bytes[];
  readonly formats?: readonly [number, string][];
  /** The number format of each XF, in XF order. */
  readonly xfs?: readonly number[];
  /** Records after the BoundSheet8 records (SupBook, ExternName, ExternSheet, Lbl). */
  readonly links?: readonly Bytes[];
  readonly strings?: readonly (string | SstEntry)[];
  readonly sstMax?: number;
  readonly version?: number;
}

const SHEET_TYPES = {
  worksheet: [0x00, 0x10],
  dialog: [0x00, 0x10],
  macro: [0x01, 0x40],
  chart: [0x02, 0x20],
  module: [0x06, 0x06],
} as const;

/** BOF: vers, dt, rupBuild, rupYear, flags, verLowestBiff ([MS-XLS] 2.4.21). */
export const bof = (dt: number, version = 0x0600): Bytes =>
  record(0x0809, [
    ...le16(version),
    ...le16(dt),
    ...le16(0x0dbb),
    ...le16(0x07cc),
    ...le32(0x000100c1),
    ...le32(0x00000406),
  ]);
export const eof = (): Bytes => record(0x000a);

/** The Workbook stream: globals with BoundSheet8 offsets pointing at each sheet's BOF, then the sheets. */
export const workbookStream = (spec: XlsSpec): Uint8Array => {
  const head = [
    ...bof(0x0005, spec.version),
    ...(spec.preamble ?? []).flat(),
    ...(spec.formats ?? []).flatMap(([id, code]) => globals.format(id, code)),
    ...(spec.xfs ?? [0]).flatMap((ifmt) => globals.xf(ifmt)),
  ];
  const tail = [
    ...(spec.links ?? []).flat(),
    ...(spec.strings === undefined
      ? []
      : sstRecords(spec.strings, spec.sstMax)),
    ...eof(),
  ];
  const boundSheet = (position: number, sheet: XlsSheetSpec): Bytes =>
    record(0x0085, [
      ...le32(position),
      sheet.state ?? 0,
      SHEET_TYPES[sheet.kind ?? "worksheet"][0],
      ...shortXl(sheet.name),
    ]);
  const bodies = spec.sheets.map((sheet) => [
    ...bof(SHEET_TYPES[sheet.kind ?? "worksheet"][1]),
    ...(sheet.kind === "dialog"
      ? record(0x0081, [0x10, 0x04])
      : record(0x0081, [0x00, 0x04])),
    ...(sheet.records ?? []).flat(),
    ...eof(),
  ]);
  let offset =
    head.length +
    spec.sheets.reduce((sum, sheet) => sum + boundSheet(0, sheet).length, 0) +
    tail.length;
  const positions = bodies.map((body) => {
    const at = offset;
    offset += body.length;
    return at;
  });
  return Uint8Array.from([
    ...head,
    ...spec.sheets.flatMap((sheet, at) =>
      boundSheet(positions[at] ?? 0, sheet),
    ),
    ...tail,
    ...bodies.flat(),
  ]);
};

/** A compound file holding the Workbook stream (and any other streams given). */
export const buildXls = (spec: XlsSpec, streamName = "Workbook"): Uint8Array =>
  writeCompoundFile([{ name: streamName, data: workbookStream(spec) }]);

/** A compound file with a raw Workbook stream, for hostile inputs. */
export const rawXls = (
  stream: Uint8Array | Bytes,
  streamName = "Workbook",
): Uint8Array =>
  writeCompoundFile([{ name: streamName, data: Uint8Array.from(stream) }]);
