import { deflateSync } from "node:zlib";

import { utf16, writeCompoundFile } from "./cfbWriter.js";

/**
 * A PowerPoint 97-2003 writer for fixtures, assembled byte by byte from
 * [MS-PPT] (no .ppt producer is installed on this host; Keynote exports .pptx
 * only). It writes what the reader tests need: the Current User stream, a
 * DocumentContainer with the slide, master and notes lists, slide and notes
 * containers with OfficeArt drawings, the external object list (hyperlinks,
 * OLE objects, an ActiveX control, a linked movie), a VBA project storage, the
 * persist directory and a chain of user edits. Record type numbers are
 * written out here on purpose, not imported from the reader.
 */

export interface PptLinkSpec {
  /** ExHyperlinkId the action refers to. */
  readonly id: number;
  readonly begin: number;
  readonly end: number;
}

export interface PptTextboxSpec {
  readonly text: string;
  /** Write a TextBytesAtom (one byte per character) instead of a TextCharsAtom. */
  readonly bytes?: boolean;
  readonly link?: PptLinkSpec;
}

export interface PptSlideSpec {
  /** Title placeholder text, written as outline text in the slide list (TextHeaderAtom type 0). */
  readonly title?: string;
  /** Body placeholder text, outline text of type 1. */
  readonly body?: string;
  /** A hyperlink on part of the title, anchored in the slide list. */
  readonly titleLink?: PptLinkSpec;
  /** Text boxes written in the drawing's client textboxes (type 4). */
  readonly textboxes?: readonly PptTextboxSpec[];
  /** A text box inside a nested group. */
  readonly grouped?: string;
  readonly hidden?: boolean;
  /** SlideLayoutType. */
  readonly layout?: number;
  readonly notes?: string;
  readonly picture?: boolean;
  /** A shape whose click runs a program (InteractiveInfoAtom action 2) with this file name. */
  readonly runProgram?: string;
  /** A shape whose click follows this hyperlink id (action 4), on the whole shape. */
  readonly shapeLink?: number;
}

export interface PptHyperlinkSpec {
  readonly id: number;
  readonly friendly?: string;
  readonly target?: string;
  readonly location?: string;
}

export interface PptSpec {
  readonly slides: readonly PptSlideSpec[];
  readonly hyperlinks?: readonly PptHyperlinkSpec[];
  /** A VBA project storage, written zlib-compressed. */
  readonly vba?: Uint8Array;
  /** An embedded OLE object storage, written raw (true) or compressed. */
  readonly ole?: {
    readonly bytes: Uint8Array;
    readonly raw?: boolean;
    readonly progId: string;
  };
  /** An ActiveX control storage, compressed. */
  readonly control?: Uint8Array;
  /** A linked movie's file path. */
  readonly moviePath?: string;
  /** A second, incremental save that replaces one slide (and rewrites the document). */
  readonly edit?: { readonly index: number; readonly slide: PptSlideSpec };
  readonly encryptedToken?: boolean;
  readonly encryptSession?: boolean;
}

// --- records ---

const u16 = (value: number): Uint8Array => {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value, true);
  return out;
};

export const u32 = (value: number): Uint8Array => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, true);
  return out;
};

export const join = (parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

/** RecordHeader: recVer (4 bits) and recInstance (12 bits) in one 16-bit word, then recType and recLen. */
export const record = (
  type: number,
  data: Uint8Array,
  options: { instance?: number; version?: number } = {},
): Uint8Array =>
  join([
    u16(((options.instance ?? 0) << 4) | (options.version ?? 0)),
    u16(type),
    u32(data.length),
    data,
  ]);

export const container = (
  type: number,
  children: readonly Uint8Array[],
  instance = 0,
): Uint8Array => record(type, join(children), { instance, version: 0xf });

export const cstring = (instance: number, text: string): Uint8Array =>
  record(0x0fba, utf16(text), { instance });

// --- text ---

export const textHeader = (textType: number): Uint8Array =>
  record(0x0f9f, u32(textType));

export const chars = (text: string, bytes = false): Uint8Array =>
  bytes
    ? record(
        0x0fa8,
        Uint8Array.from(text, (ch) => ch.charCodeAt(0) & 0xff),
      )
    : record(0x0fa0, utf16(text));

/** MouseClickInteractiveInfoContainer: InteractiveInfoAtom (16 bytes) and an optional MacroNameAtom. */
export const interactive = (
  action: number,
  hyperlinkId: number,
  hyperlinkType: number,
  name?: string,
): Uint8Array =>
  container(0x0ff2, [
    record(
      0x0ff3,
      join([
        u32(0),
        u32(hyperlinkId),
        Uint8Array.of(action, 0, 0, 0, hyperlinkType, 0, 0, 0),
      ]),
    ),
    ...(name === undefined ? [] : [cstring(2, name)]),
  ]);

const textLink = (link: PptLinkSpec): Uint8Array[] => [
  interactive(4, link.id, 8),
  record(0x0fdf, join([u32(link.begin), u32(link.end)])),
];

// --- drawing ---

export const fsp = (
  shapeType: number,
  spid: number,
  flags = 0x0a00,
): Uint8Array =>
  record(0xf00a, join([u32(spid), u32(flags)]), {
    instance: shapeType,
    version: 2,
  });

export const shape = (
  spid: number,
  parts: { type?: number; textbox?: Uint8Array[]; data?: Uint8Array[] },
): Uint8Array =>
  container(0xf004, [
    fsp(parts.type ?? 1, spid),
    ...(parts.data === undefined ? [] : [container(0xf011, parts.data)]),
    ...(parts.textbox === undefined ? [] : [container(0xf00d, parts.textbox)]),
  ]);

const outlineRef = (index: number): Uint8Array[] => [
  record(0x0f9e, u32(index)),
];

export const drawing = (shapes: readonly Uint8Array[]): Uint8Array =>
  container(0x040c, [
    container(0xf002, [
      record(0xf008, join([u32(shapes.length + 1), u32(1024)])),
      container(0xf003, [
        // The group's own shape comes first.
        container(0xf004, [
          record(0xf009, new Uint8Array(16), { version: 1 }),
          fsp(0, 1024),
        ]),
        ...shapes,
      ]),
    ]),
  ]);

const slideShapes = (slide: PptSlideSpec): Uint8Array[] => {
  const shapes: Uint8Array[] = [];
  let spid = 1025;
  const next = (): number => (spid += 1);
  let outline = 0;
  if (slide.title !== undefined)
    shapes.push(
      shape(next(), {
        textbox: outlineRef(outline++),
        ...(slide.shapeLink === undefined
          ? {}
          : { data: [interactive(4, slide.shapeLink, 8)] }),
      }),
    );
  if (slide.body !== undefined)
    shapes.push(shape(next(), { textbox: outlineRef(outline++) }));
  for (const box of slide.textboxes ?? [])
    shapes.push(
      shape(next(), {
        type: 202,
        textbox: [
          textHeader(4),
          chars(box.text, box.bytes),
          ...(box.link === undefined ? [] : textLink(box.link)),
        ],
      }),
    );
  if (slide.grouped !== undefined)
    shapes.push(
      container(0xf003, [
        container(0xf004, [
          record(0xf009, new Uint8Array(16), { version: 1 }),
          fsp(0, next()),
        ]),
        shape(next(), {
          type: 202,
          textbox: [textHeader(4), chars(slide.grouped)],
        }),
      ]),
    );
  if (slide.picture === true) shapes.push(shape(next(), { type: 75 }));
  if (slide.runProgram !== undefined)
    shapes.push(
      shape(next(), { data: [interactive(2, 0, 0xff, slide.runProgram)] }),
    );
  return shapes;
};

/** SlideContainer: SlideAtom (geom, placeholders, master, notes, flags), SlideShowSlideInfoAtom, drawing. */
export const slideRecord = (slide: PptSlideSpec, notesId: number): Uint8Array =>
  container(0x03ee, [
    record(
      0x03ef,
      join([
        u32(slide.layout ?? 1),
        new Uint8Array(8),
        u32(0x80000000),
        u32(notesId),
        u16(0x0007),
        u16(0),
      ]),
      { version: 2 },
    ),
    record(
      0x03f9,
      join([
        u32(0),
        u32(0),
        Uint8Array.of(0, 0),
        u16(slide.hidden === true ? 0x0004 : 0),
        u32(0),
      ]),
    ),
    drawing(slideShapes(slide)),
  ]);

const notesRecord = (text: string, slideId: number): Uint8Array =>
  container(0x03f0, [
    record(0x03f1, join([u32(slideId), u16(0), u16(0)]), { version: 1 }),
    drawing([shape(2000, { textbox: [textHeader(2), chars(text)] })]),
  ]);

// --- document ---

const SLIDE_PID = 2;
const slideId = (index: number): number => 256 + index;
const notesId = (index: number): number => 512 + index;

interface Ids {
  readonly slide: (index: number) => number;
  readonly notes: (index: number) => number;
  readonly master: number;
  readonly vba: number;
  readonly ole: number;
  readonly control: number;
}

/** Persist ids: 1 the document, then slides, notes, the master and the storages. */
const assignIds = (spec: PptSpec): Ids => {
  const count = spec.slides.length;
  return {
    slide: (index) => SLIDE_PID + index,
    notes: (index) => SLIDE_PID + count + index,
    master: SLIDE_PID + 2 * count,
    vba: SLIDE_PID + 2 * count + 1,
    ole: SLIDE_PID + 2 * count + 2,
    control: SLIDE_PID + 2 * count + 3,
  };
};

const slideList = (slides: readonly PptSlideSpec[], ids: Ids): Uint8Array =>
  container(
    0x0ff0,
    slides.flatMap((slide, index) => [
      record(
        0x03f3,
        join([
          u32(ids.slide(index)),
          u32(0),
          u32(2),
          u32(slideId(index)),
          u32(0),
        ]),
      ),
      ...(slide.title === undefined
        ? []
        : [
            textHeader(0),
            chars(slide.title),
            ...(slide.titleLink === undefined ? [] : textLink(slide.titleLink)),
          ]),
      ...(slide.body === undefined ? [] : [textHeader(1), chars(slide.body)]),
    ]),
  );

const objectList = (spec: PptSpec, ids: Ids): Uint8Array[] => {
  const children: Uint8Array[] = [];
  for (const link of spec.hyperlinks ?? [])
    children.push(
      container(0x0fd7, [
        record(0x0fd3, u32(link.id)),
        ...(link.friendly === undefined ? [] : [cstring(0, link.friendly)]),
        ...(link.target === undefined ? [] : [cstring(1, link.target)]),
        ...(link.location === undefined ? [] : [cstring(3, link.location)]),
      ]),
    );
  const oleAtom = (type: number, id: number, persistId: number): Uint8Array =>
    record(
      0x0fc3,
      join([u32(1), u32(type), u32(id), u32(0), u32(persistId), u32(0)]),
      { version: 1 },
    );
  if (spec.ole !== undefined)
    children.push(
      container(0x0fcc, [
        record(0x0fcd, join([u32(0), u32(0)])),
        oleAtom(0, 7, ids.ole),
        cstring(2, spec.ole.progId),
      ]),
    );
  if (spec.control !== undefined)
    children.push(
      container(0x0fee, [
        record(0x0ffb, u32(slideId(0))),
        oleAtom(2, 8, ids.control),
        cstring(2, "Forms.CommandButton.1"),
      ]),
    );
  if (spec.moviePath !== undefined)
    children.push(
      container(0x1006, [
        container(0x1005, [
          record(0x1004, join([u32(9), u16(0), u16(0)])),
          cstring(0, spec.moviePath),
        ]),
      ]),
    );
  return children.length === 0
    ? []
    : [container(0x0409, [record(0x040a, u32(10)), ...children])];
};

const documentRecord = (
  spec: PptSpec,
  slides: readonly PptSlideSpec[],
  ids: Ids,
): Uint8Array =>
  container(0x03e8, [
    record(
      0x03e9,
      join([new Uint8Array(24), u32(0), u32(0), u16(1), u16(0), u32(0)]),
      { version: 1 },
    ),
    ...objectList(spec, ids),
    container(
      0x0ff0,
      [
        record(
          0x03f3,
          join([u32(ids.master), u32(0), u32(0), u32(0x80000000), u32(0)]),
        ),
      ],
      1,
    ),
    slideList(slides, ids),
    container(
      0x0ff0,
      slides.flatMap((slide, index) =>
        slide.notes === undefined
          ? []
          : [
              record(
                0x03f3,
                join([
                  u32(ids.notes(index)),
                  u32(0),
                  u32(0),
                  u32(notesId(index)),
                  u32(0),
                ]),
              ),
            ],
      ),
      2,
    ),
    ...(spec.vba === undefined
      ? []
      : [
          container(0x07d0, [
            container(
              0x03ff,
              [
                record(0x0400, join([u32(ids.vba), u32(1), u32(2)]), {
                  version: 2,
                }),
              ],
              1,
            ),
          ]),
        ]),
    record(0x03ea, new Uint8Array(0)),
  ]);

/** ExOleObjStg / VbaProjectStg: instance 1 holds decompressedSize then a zlib stream, instance 0 the raw storage. */
const storageRecord = (bytes: Uint8Array, raw = false): Uint8Array =>
  raw
    ? record(0x1011, bytes)
    : record(0x1011, join([u32(bytes.length), deflateSync(bytes)]), {
        instance: 1,
      });

// --- persist directory, edits, current user ---

/** PersistDirectoryAtom: runs of consecutive ids share one entry (persistId 20 bits, cPersist 12 bits). */
export const persistDirectory = (
  entries: ReadonlyMap<number, number>,
): Uint8Array => {
  const ids = [...entries.keys()].sort((a, b) => a - b);
  const parts: Uint8Array[] = [];
  for (let start = 0; start < ids.length;) {
    let end = start + 1;
    // cPersist has 12 bits, so a run holds at most 4095 offsets.
    while (
      end < ids.length &&
      end - start < 4095 &&
      ids[end] === (ids[end - 1] ?? 0) + 1
    )
      end += 1;
    const first = ids[start] ?? 0;
    parts.push(u32(first | ((end - start) << 20)));
    for (const id of ids.slice(start, end))
      parts.push(u32(entries.get(id) ?? 0));
    start = end;
  }
  return record(0x1772, join(parts));
};

export const userEdit = (
  lastEdit: number,
  directory: number,
  seed: number,
  encryptSession = 0,
): Uint8Array =>
  record(
    0x0ff5,
    join([
      u32(slideId(0)),
      u16(0),
      Uint8Array.of(0, 3),
      u32(lastEdit),
      u32(directory),
      u32(1),
      u32(seed),
      u16(1),
      u16(0),
      ...(encryptSession === 0 ? [] : [u32(encryptSession)]),
    ]),
  );

export const currentUser = (offset: number, encrypted = false): Uint8Array => {
  const name = "Fixture";
  return record(
    0x0ff6,
    join([
      u32(0x14),
      u32(encrypted ? 0xf3d1c4df : 0xe391c05f),
      u32(offset),
      u16(name.length),
      u16(0x03f4),
      Uint8Array.of(3, 0),
      u16(0),
      Uint8Array.from(name, (ch) => ch.charCodeAt(0)),
      u32(8),
      utf16(name),
    ]),
  );
};

/** Lay records out one after another, remembering where each persist object lands. */
class Layout {
  readonly parts: Uint8Array[] = [];
  length = 0;
  put(bytes: Uint8Array): number {
    const at = this.length;
    this.parts.push(bytes);
    this.length += bytes.length;
    return at;
  }
}

export interface BuiltPpt {
  readonly document: Uint8Array;
  readonly currentUser: Uint8Array;
  /** Offsets of the newest UserEditAtom and of each slide container written, in write order. */
  readonly offsets: {
    readonly edit: number;
    readonly slides: readonly number[];
  };
}

export const buildPptStreams = (spec: PptSpec): BuiltPpt => {
  const ids = assignIds(spec);
  const out = new Layout();
  const entries = new Map<number, number>();
  const slides: number[] = [];
  entries.set(1, out.put(documentRecord(spec, spec.slides, ids)));
  spec.slides.forEach((slide, index) => {
    const offset = out.put(
      slideRecord(slide, slide.notes === undefined ? 0 : notesId(index)),
    );
    slides.push(offset);
    entries.set(ids.slide(index), offset);
  });
  spec.slides.forEach((slide, index) => {
    if (slide.notes !== undefined)
      entries.set(
        ids.notes(index),
        out.put(notesRecord(slide.notes, slideId(index))),
      );
  });
  entries.set(
    ids.master,
    out.put(
      container(0x03f8, [record(0x03ef, new Uint8Array(24), { version: 2 })]),
    ),
  );
  if (spec.vba !== undefined)
    entries.set(ids.vba, out.put(storageRecord(spec.vba)));
  if (spec.ole !== undefined)
    entries.set(ids.ole, out.put(storageRecord(spec.ole.bytes, spec.ole.raw)));
  if (spec.control !== undefined)
    entries.set(ids.control, out.put(storageRecord(spec.control)));
  const seed = ids.control;
  const directory = out.put(persistDirectory(entries));
  const session = spec.encryptSession === true ? seed + 1 : 0;
  let edit = out.put(userEdit(0, directory, seed, session));
  if (spec.edit !== undefined) {
    const { index, slide } = spec.edit;
    const replaced = spec.slides.map((old, at) => (at === index ? slide : old));
    const newer = new Map<number, number>();
    newer.set(1, out.put(documentRecord(spec, replaced, ids)));
    const offset = out.put(
      slideRecord(slide, slide.notes === undefined ? 0 : notesId(index)),
    );
    slides.push(offset);
    newer.set(ids.slide(index), offset);
    const second = out.put(persistDirectory(newer));
    edit = out.put(userEdit(edit, second, seed));
  }
  return {
    document: join(out.parts),
    currentUser: currentUser(edit, spec.encryptedToken === true),
    offsets: { edit, slides },
  };
};

/** A slide list with one SlidePersistAtom per persist id and its outline text, inside a minimal document. */
export const documentOf = (
  entries: readonly {
    readonly persistId: number;
    readonly outline?: readonly Uint8Array[];
  }[],
  extra: readonly Uint8Array[] = [],
): Uint8Array =>
  container(0x03e8, [
    record(0x03e9, new Uint8Array(40), { version: 1 }),
    ...extra,
    container(
      0x0ff0,
      entries.flatMap((entry, index) => [
        record(
          0x03f3,
          join([
            u32(entry.persistId),
            u32(0),
            u32(0),
            u32(256 + index),
            u32(0),
          ]),
        ),
        ...(entry.outline ?? []),
      ]),
    ),
    record(0x03ea, new Uint8Array(0)),
  ]);

/** Lay out hand-built persist objects (the document first, id 1), then the directory, one edit and the Current User stream. */
export const assembleStream = (
  objects: readonly { readonly id: number; readonly bytes: Uint8Array }[],
): BuiltPpt & { readonly at: ReadonlyMap<number, number> } => {
  const out = new Layout();
  const entries = new Map<number, number>();
  for (const object of objects) entries.set(object.id, out.put(object.bytes));
  const directory = out.put(persistDirectory(entries));
  const edit = out.put(userEdit(0, directory, Math.max(1, ...entries.keys())));
  return {
    document: join(out.parts),
    currentUser: currentUser(edit),
    offsets: { edit, slides: [] },
    at: entries,
  };
};

/** Wrap the two streams in a compound file. */
export const pptFile = (
  document: Uint8Array,
  user: Uint8Array | null,
  extra: readonly { name: string; data: Uint8Array }[] = [],
): Uint8Array =>
  writeCompoundFile([
    { name: "PowerPoint Document", data: document },
    ...(user === null ? [] : [{ name: "Current User", data: user }]),
    ...extra,
  ]);

export const buildPpt = (spec: PptSpec): Uint8Array => {
  const built = buildPptStreams(spec);
  return pptFile(built.document, built.currentUser);
};
