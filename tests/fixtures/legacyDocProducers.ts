import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  inspectOfficeDocumentInputSchema,
  officeDocumentReportSchema,
  type OfficeDocumentReport,
} from "../../src/domain/officeDocument/officeDocument.js";
import { OfficeDocumentProvider } from "../../src/officeDocument/OfficeDocumentProvider.js";

import { writeCompoundFile, type CfbNode } from "./cfbWriter.js";

/**
 * A Word 97-2003 (.doc) encoder for fixtures, written from [MS-DOC] (2.3 parts,
 * 2.5 FIB, 2.8 PLCs, 2.9 Clx/Pcd/FKP/STSH/ATRD). It writes what the tests need
 * that macOS textutil cannot produce: comments, notes, headers, tracked changes,
 * hidden text, fields, tables with PAPX, styles, several pieces in either
 * encoding and FIB flags. It is not a general writer: one CHPX per run, one
 * PapxInFkp per paragraph, no section properties beyond their CPs.
 */

export const TEXTUTIL = existsSync("/usr/bin/textutil")
  ? "/usr/bin/textutil"
  : null;

/** Sprm codes ([MS-DOC] 2.6) the fixtures use. */
export const SPRM = {
  del: 0x0800,
  ins: 0x0801,
  ole: 0x080a,
  vanish: 0x083c,
  spec: 0x0855,
  charStyle: 0x4a30,
  symbol: 0x6a09,
  inTable: 0x2416,
  ttp: 0x2417,
  ilvl: 0x260a,
  ilfo: 0x460b,
  outLvl: 0x2640,
  itap: 0x6649,
  innerCell: 0x244b,
  innerTtp: 0x244c,
} as const;

/** One Prl: the sprm (little-endian) then its operand bytes. */
export const prl = (sprm: number, ...operand: number[]): number[] => [
  sprm & 0xff,
  sprm >>> 8,
  ...operand,
];

export interface DocRun {
  readonly text: string;
  readonly chp?: readonly number[];
}

export interface DocParagraph {
  readonly runs: readonly (DocRun | string)[];
  /** The mark that ends it; "" for none (the end of a separator story). */
  readonly end?: "\r" | "\u0007" | "\u000c" | "";
  readonly istd?: number;
  readonly pap?: readonly number[];
  readonly markChp?: readonly number[];
  /** Store istd and pap in the Data stream behind sprmPHugePapx ([MS-DOC] 2.6.2). */
  readonly huge?: boolean;
}

export interface DocStyleSpec {
  readonly name: string;
  readonly sti?: number;
  /** 1 paragraph style (default), 2 character style. */
  readonly stk?: 1 | 2;
  readonly base?: number;
  readonly chp?: readonly number[];
  readonly pap?: readonly number[];
}

export interface DocCommentSpec {
  readonly author: string;
  readonly initials: string;
  /** A DTTM value ([MS-DOC] 2.9.65); use `dttm`. */
  readonly date?: number;
  readonly paragraphs: readonly DocParagraph[];
}

export interface DocPieceSpec {
  /** CP where the piece starts; the first piece starts at 0. */
  readonly at: number;
  readonly compressed: boolean;
  readonly prm?: number;
}

export interface DocSpec {
  readonly body: readonly DocParagraph[];
  readonly footnotes?: readonly (readonly DocParagraph[])[];
  readonly endnotes?: readonly (readonly DocParagraph[])[];
  readonly comments?: readonly DocCommentSpec[];
  /** Per section, six stories: even/odd header, even/odd footer, first header, first footer. */
  readonly headers?: readonly (readonly (readonly DocParagraph[])[])[];
  readonly textBoxes?: readonly (readonly DocParagraph[])[];
  /** Text boxes anchored in headers (the header textbox story, PlcfHdrtxbxTxt). */
  readonly headerTextBoxes?: readonly (readonly DocParagraph[])[];
  /** Path written as string 1 of the SttbfAssoc ([MS-DOC] 2.9.276). */
  readonly attachedTemplate?: string;
  /** Bytes the Data stream holds before any PrcData (standing in for pictures). */
  readonly dataPrefix?: number;
  /** Body CPs where a new section starts (after a 0x0C the test puts there). */
  readonly sectionStarts?: readonly number[];
  /** Index = istd; entries after the 15 fixed ones are custom styles. */
  readonly styles?: readonly (DocStyleSpec | null)[];
  readonly pieces?: readonly DocPieceSpec[];
  /** Store later pieces at lower stream offsets. */
  readonly reversePieces?: boolean;
  /** Group property lists (Prc) for Prm1 pieces. */
  readonly prcs?: readonly (readonly number[])[];
  readonly nFib?: number;
  readonly template?: boolean;
  readonly encrypted?: boolean;
  readonly obfuscated?: boolean;
  readonly tableStream?: "0Table" | "1Table";
  /** FibRgFcLcb entries left out (their lcb written as zero). */
  readonly omit?: readonly number[];
}

export interface BuiltDoc {
  readonly bytes: Uint8Array;
  readonly word: Uint8Array;
  readonly table: Uint8Array;
  /** Where each FibRgFcLcb entry was written: index -> {fc, lcb}. */
  readonly entries: ReadonlyMap<number, { fc: number; lcb: number }>;
  /** Byte offset of the FIB's FibRgFcLcb blob in the WordDocument stream. */
  readonly blobAt: number;
  /** The full text in CP order. */
  readonly text: string;
}

/** A DTTM ([MS-DOC] 2.9.65) from its fields. */
export const dttm = (
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number =>
  (minute |
    (hour << 6) |
    (day << 11) |
    (month << 16) |
    ((year - 1900) << 20) |
    (0 << 29)) >>>
  0;

const CB_RG_FC_LCB: ReadonlyMap<number, [number, number]> = new Map([
  [0x00c1, [0x5d, 0]],
  [0x00d9, [0x6c, 2]],
  [0x0101, [0x88, 2]],
  [0x010c, [0xa4, 2]],
  [0x0112, [0xb7, 5]],
]);

/** FibRgFcLcb indexes ([MS-DOC] 2.5.6-2.5.8), written independently of the reader's table. */
export const FCLCB = {
  stshf: 1,
  plcffndRef: 2,
  plcffndTxt: 3,
  plcfandRef: 4,
  plcfandTxt: 5,
  plcfSed: 6,
  plcfHdd: 11,
  plcfBteChpx: 12,
  plcfBtePapx: 13,
  clx: 33,
  grpXstAtnOwners: 36,
  plcfendRef: 46,
  plcfendTxt: 47,
  plcftxbxTxt: 56,
  plcfHdrtxbxTxt: 58,
  sttbfAssoc: 32,
  atrdExtra: 112,
} as const;

/** [MS-DOC] 2.9.73: Unicode characters stored as one of bytes 0x82-0x9F in compressed text. */
const COMPRESSED_FROM: ReadonlyMap<number, number> = new Map([
  [0x201a, 0x82],
  [0x0192, 0x83],
  [0x201e, 0x84],
  [0x2026, 0x85],
  [0x2020, 0x86],
  [0x2021, 0x87],
  [0x02c6, 0x88],
  [0x2030, 0x89],
  [0x0160, 0x8a],
  [0x2039, 0x8b],
  [0x0152, 0x8c],
  [0x2018, 0x91],
  [0x2019, 0x92],
  [0x201c, 0x93],
  [0x201d, 0x94],
  [0x2022, 0x95],
  [0x2013, 0x96],
  [0x2014, 0x97],
  [0x02dc, 0x98],
  [0x2122, 0x99],
  [0x0161, 0x9a],
  [0x203a, 0x9b],
  [0x0153, 0x9c],
  [0x0178, 0x9f],
]);
const SPECIAL_BYTES = new Set(COMPRESSED_FROM.values());

const compressedByte = (code: number): number | null => {
  const mapped = COMPRESSED_FROM.get(code);
  if (mapped !== undefined) return mapped;
  return code < 0x100 && !SPECIAL_BYTES.has(code) ? code : null;
};

class Bytes {
  readonly parts: number[] = [];
  get length(): number {
    return this.parts.length;
  }
  /** Append many bytes without spreading them into one call. */
  append(values: Iterable<number>): this {
    for (const value of values) this.parts.push(value & 0xff);
    return this;
  }
  u8(...values: number[]): this {
    for (const value of values) this.parts.push(value & 0xff);
    return this;
  }
  u16(value: number): this {
    return this.u8(value, value >>> 8);
  }
  u32(value: number): this {
    return this.u8(value, value >>> 8, value >>> 16, value >>> 24);
  }
  pad(to: number): this {
    while (this.parts.length % to !== 0) this.parts.push(0);
    return this;
  }
  bytes(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

interface Char {
  readonly chp: readonly number[] | undefined;
}
interface ParagraphMark {
  readonly start: number;
  readonly mark: number;
  readonly istd: number;
  readonly pap: readonly number[];
  readonly huge: boolean;
}

/** The document's characters in CP order with run properties and paragraph marks. */
class TextModel {
  text = "";
  readonly chars: Char[] = [];
  readonly marks: ParagraphMark[] = [];

  add(text: string, chp?: readonly number[]): void {
    this.text += text;
    for (let at = 0; at < text.length; at += 1) this.chars.push({ chp });
  }

  paragraphs(list: readonly DocParagraph[]): void {
    for (const paragraph of list) {
      const start = this.text.length;
      for (const run of paragraph.runs)
        if (typeof run === "string") this.add(run);
        else this.add(run.text, run.chp);
      const end = paragraph.end ?? "\r";
      if (end === "") continue;
      this.marks.push({
        start,
        mark: this.text.length,
        istd: paragraph.istd ?? 0,
        pap: paragraph.pap ?? [],
        huge: paragraph.huge === true,
      });
      this.add(end, paragraph.markChp);
    }
  }
}

const SPEC = prl(SPRM.spec, 1);
const zeros = (count: number): number[] =>
  Array.from({ length: count }, () => 0);

/** The stories in [MS-DOC] 2.3 order, with each story's text ranges for its PLC. */
const buildText = (spec: DocSpec) => {
  const model = new TextModel();
  model.paragraphs(spec.body);
  const ccpText = model.text.length;
  const notes = (list: readonly (readonly DocParagraph[])[] | undefined) => {
    const start = model.text.length;
    const starts: number[] = [];
    for (const note of list ?? []) {
      starts.push(model.text.length - start);
      model.add("\u0002", SPEC);
      model.paragraphs(note);
    }
    // The story ends with one more paragraph mark outside every note (2.8.20: the second-to-last CP is ccp - 1).
    if (starts.length > 0) model.add("\r");
    return { starts, length: model.text.length - start };
  };
  const footnotes = notes(spec.footnotes);
  const hddStart = model.text.length;
  const hddStarts: number[] = [];
  if ((spec.headers?.length ?? 0) > 0) {
    for (let story = 0; story < 6; story += 1)
      hddStarts.push(model.text.length - hddStart);
    for (const section of spec.headers ?? [])
      for (const story of section) {
        hddStarts.push(model.text.length - hddStart);
        if (story.length === 0) continue;
        model.paragraphs(story);
        model.add("\r");
      }
    model.add("\r");
  }
  const hdd = { starts: hddStarts, length: model.text.length - hddStart };
  const atnStart = model.text.length;
  const atnStarts: number[] = [];
  for (const comment of spec.comments ?? []) {
    atnStarts.push(model.text.length - atnStart);
    model.add("\u0005", SPEC);
    model.paragraphs(comment.paragraphs);
  }
  if (atnStarts.length > 0) model.add("\r");
  const atn = { starts: atnStarts, length: model.text.length - atnStart };
  const endnotes = notes(spec.endnotes);
  const boxes = (list: readonly (readonly DocParagraph[])[] | undefined) => {
    const start = model.text.length;
    const starts: number[] = [];
    for (const box of list ?? []) {
      starts.push(model.text.length - start);
      model.paragraphs(box);
    }
    if (starts.length > 0) {
      // The last FTXBXS is a spare; its range only needs to exist.
      starts.push(model.text.length - start);
      model.add("\r");
    }
    return { starts, length: model.text.length - start };
  };
  const txbx = boxes(spec.textBoxes);
  const hdrTxbx = boxes(spec.headerTextBoxes);
  if (model.text.length > ccpText) model.add("\r");
  return { model, ccpText, footnotes, hdd, atn, endnotes, txbx, hdrTxbx };
};

interface PlacedPiece {
  readonly cp: number;
  readonly end: number;
  readonly byte: number;
  readonly compressed: boolean;
  readonly prm: number;
}

const TEXT_AT = 0x800;

/** Write the pieces' bytes into the WordDocument stream after the FIB. */
const placePieces = (spec: DocSpec, model: TextModel, word: Bytes) => {
  const specs = spec.pieces ?? [
    {
      at: 0,
      compressed: [...model.text].every(
        (ch) => compressedByte(ch.charCodeAt(0)) !== null,
      ),
    },
  ];
  const ranges = specs.map((piece, at) => ({
    ...piece,
    end: specs[at + 1]?.at ?? model.text.length,
  }));
  const order = spec.reversePieces === true ? [...ranges].reverse() : ranges;
  const placed = new Map<number, PlacedPiece>();
  while (word.length < TEXT_AT) word.u8(0);
  for (const piece of order) {
    const byte = word.length;
    for (let cp = piece.at; cp < piece.end; cp += 1) {
      const code = model.text.charCodeAt(cp);
      if (piece.compressed) {
        const value = compressedByte(code);
        if (value === null)
          throw new Error(`U+${code.toString(16)} has no compressed byte.`);
        word.u8(value);
      } else word.u16(code);
    }
    placed.set(piece.at, {
      cp: piece.at,
      end: piece.end,
      byte,
      compressed: piece.compressed,
      prm: piece.prm ?? 0,
    });
  }
  word.pad(512);
  return ranges.map((range) => placed.get(range.at) as PlacedPiece);
};

const fcOf = (pieces: readonly PlacedPiece[], cp: number) => {
  const piece = pieces.find((entry) => cp >= entry.cp && cp < entry.end);
  if (piece === undefined) throw new Error(`CP ${String(cp)} has no piece.`);
  const width = piece.compressed ? 1 : 2;
  return { piece, fc: piece.byte + (cp - piece.cp) * width, width };
};

interface FcEntry {
  readonly start: number;
  readonly end: number;
  readonly data: readonly number[] | null;
}

/** Fill the gaps between stream ranges so FKP offsets partition the text. */
const partition = (entries: FcEntry[]): FcEntry[] => {
  entries.sort((a, b) => a.start - b.start);
  const out: FcEntry[] = [];
  for (const entry of entries) {
    const last = out[out.length - 1];
    if (last !== undefined && entry.start > last.end)
      out.push({ start: last.end, end: entry.start, data: null });
    out.push(entry);
  }
  return out;
};

/** ChpxFkp pages ([MS-DOC] 2.9.33): rgfc, rgb (offset/2), Chpx (cb, grpprl), crun last. */
const chpxPages = (entries: readonly FcEntry[]): Uint8Array[] => {
  const pages: Uint8Array[] = [];
  for (let first = 0; first < entries.length;) {
    const page = new Uint8Array(512);
    const view = new DataView(page.buffer);
    let count = 0;
    let free = 511;
    const offsets: number[] = [];
    while (first + count < entries.length && count < 0x65) {
      const entry = entries[first + count] as FcEntry;
      const size = entry.data === null ? 0 : 1 + entry.data.length;
      const headerEnd = 4 * (count + 2) + count + 1;
      const at = size > 0 ? (free - size) & ~1 : free;
      if (at < headerEnd) break;
      if (size > 0) {
        page[at] = entry.data?.length ?? 0;
        page.set(entry.data ?? [], at + 1);
        free = at;
      }
      offsets.push(size > 0 ? at / 2 : 0);
      count += 1;
    }
    for (let at = 0; at < count; at += 1) {
      const entry = entries[first + at] as FcEntry;
      view.setUint32(at * 4, entry.start, true);
      if (at === count - 1) view.setUint32((at + 1) * 4, entry.end, true);
      page[4 * (count + 1) + at] = offsets[at] ?? 0;
    }
    page[511] = count;
    pages.push(page);
    first += count;
  }
  return pages;
};

/** PapxFkp pages ([MS-DOC] 2.9.174): rgfc, 13-byte BxPap, PapxInFkp (cb or 0 + cb'), cpara last. */
const papxPages = (entries: readonly FcEntry[]): Uint8Array[] => {
  const pages: Uint8Array[] = [];
  for (let first = 0; first < entries.length;) {
    const page = new Uint8Array(512);
    const view = new DataView(page.buffer);
    let count = 0;
    let free = 511;
    const offsets: number[] = [];
    while (first + count < entries.length && count < 0x1d) {
      const entry = entries[first + count] as FcEntry;
      const body = entry.data ?? [0, 0];
      const papx =
        body.length % 2 === 1
          ? [(body.length + 1) / 2, ...body]
          : [0, body.length / 2, ...body];
      const at = (free - papx.length) & ~1;
      if (at < 4 * (count + 2) + 13 * (count + 1)) break;
      page.set(papx, at);
      free = at;
      offsets.push(at / 2);
      count += 1;
    }
    for (let at = 0; at < count; at += 1) {
      const entry = entries[first + at] as FcEntry;
      view.setUint32(at * 4, entry.start, true);
      if (at === count - 1) view.setUint32((at + 1) * 4, entry.end, true);
      page[4 * (count + 1) + at * 13] = offsets[at] ?? 0;
    }
    page[511] = count;
    pages.push(page);
    first += count;
  }
  return pages;
};

/** Append FKP pages to the WordDocument stream and return their PlcBte ([MS-DOC] 2.8.5, 2.8.6). */
const writeFkps = (word: Bytes, pages: readonly Uint8Array[]): Bytes => {
  const plc = new Bytes();
  const pns: number[] = [];
  for (const page of pages) {
    pns.push(word.length / 512);
    word.u8(...page);
  }
  for (const page of pages)
    plc.u32(new DataView(page.buffer).getUint32(0, true));
  const last = pages[pages.length - 1];
  if (last !== undefined) {
    const count = last[511] ?? 0;
    plc.u32(new DataView(last.buffer).getUint32(count * 4, true));
  }
  for (const pn of pns) plc.u32(pn);
  return plc;
};

const charEntries = (
  model: TextModel,
  pieces: readonly PlacedPiece[],
): FcEntry[] => {
  const entries: FcEntry[] = [];
  for (const piece of pieces) {
    const width = piece.compressed ? 1 : 2;
    for (let cp = piece.cp; cp < piece.end;) {
      const chp = model.chars[cp]?.chp;
      let end = cp + 1;
      while (end < piece.end && model.chars[end]?.chp === chp) end += 1;
      entries.push({
        start: piece.byte + (cp - piece.cp) * width,
        end: piece.byte + (end - piece.cp) * width,
        data: chp === undefined ? null : [...chp],
      });
      cp = end;
    }
  }
  return partition(entries);
};

const paragraphEntries = (
  model: TextModel,
  pieces: readonly PlacedPiece[],
  data: Bytes,
): FcEntry[] => {
  const entries = model.marks.map((mark) => {
    const at = fcOf(pieces, mark.mark);
    const from = Math.max(mark.start, at.piece.cp);
    let papx = [mark.istd & 0xff, mark.istd >>> 8, ...mark.pap];
    if (mark.huge) {
      // GrpPrlAndIstd holds istd 0 and one sprmPHugePapx; the Data stream holds a PrcData.
      const offset = data.length;
      const grpprl = [
        ...prl(0x4600, mark.istd & 0xff, mark.istd >>> 8),
        ...mark.pap,
      ];
      // PrcData.cbGrpprl is at least 10; sprmPFKeep off fills it.
      while (grpprl.length < 10) grpprl.push(...prl(0x2405, 0));
      data
        .u16(grpprl.length)
        .u8(...grpprl)
        .pad(2);
      papx = [
        0,
        0,
        ...prl(0x6646, offset, offset >>> 8, offset >>> 16, offset >>> 24),
      ];
    }
    return {
      start: fcOf(pieces, from).fc,
      end: at.fc + at.width,
      data: papx,
    };
  });
  return partition(entries);
};

/** An STSH ([MS-DOC] 2.9.271) with 18-byte Stdf (StdfBase + empty StdfPost2000). */
const stylesheet = (styles: readonly (DocStyleSpec | null)[]): Bytes => {
  const fixedSti = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 65, 105, 107];
  const all: (DocStyleSpec | null)[] = [];
  for (let istd = 0; istd < Math.max(15, styles.length); istd += 1)
    all.push(
      styles[istd] ??
        (istd === 0
          ? { name: "Normal", sti: 0 }
          : istd < 10
            ? { name: `heading ${String(istd)}`, sti: istd }
            : null),
    );
  const out = new Bytes().u16(18);
  out
    .u16(all.length)
    .u16(18)
    .u16(1)
    .u16(0x5b)
    .u16(15)
    .u16(0)
    .u16(0)
    .u16(0)
    .u16(0);
  for (const [istd, style] of all.entries()) {
    if (style === null) {
      out.u16(0);
      continue;
    }
    const std = new Bytes();
    const stk = style.stk ?? 1;
    std.u16(
      (style.sti ?? (istd < 13 ? (fixedSti[istd] ?? 0x0ffe) : 0x0ffe)) & 0x0fff,
    );
    std.u16(stk | ((style.base ?? (istd === 0 ? 0x0fff : 0)) << 4));
    std.u16((stk === 1 ? 2 : 1) | (istd << 4));
    std.u16(0).u16(0).u32(0).u32(0);
    std.u16(style.name.length);
    for (const ch of style.name) std.u16(ch.charCodeAt(0));
    std.u16(0);
    if (stk === 1) {
      const papx = [istd & 0xff, istd >>> 8, ...(style.pap ?? [])];
      std
        .u16(papx.length)
        .u8(...papx)
        .pad(2);
    }
    const chpx = style.chp ?? [];
    std
      .u16(chpx.length)
      .u8(...chpx)
      .pad(2);
    out.u16(std.length).append(std.parts).pad(2);
  }
  return out;
};

const cpPlc = (
  positions: readonly number[],
  data: readonly (readonly number[])[] = [],
): Bytes => {
  const out = new Bytes();
  for (const position of positions) out.u32(position);
  for (const element of data) out.u8(...element);
  return out;
};

/** Text PLCs end with two positions that only close the list ([MS-DOC] 2.8.8, 2.8.17, 2.8.20). */
const textPlc = (starts: readonly number[], length: number): Bytes =>
  cpPlc([...starts, length - 1, length + 1]);

const refPositions = (
  model: TextModel,
  ccpText: number,
  char: string,
): number[] => {
  const out: number[] = [];
  for (let cp = 0; cp < ccpText; cp += 1)
    if (model.text[cp] === char) out.push(cp);
  return out;
};

/** An extended SttbfAssoc ([MS-DOC] 2.9.276) of 18 strings; only string 1 (the template) is set. */
const sttbfAssoc = (template: string): Bytes => {
  const sttb = new Bytes().u16(0xffff).u16(18).u16(0);
  for (let at = 0; at < 18; at += 1) {
    const value = at === 1 ? template : "";
    sttb.u16(value.length);
    for (const ch of value) sttb.u16(ch.charCodeAt(0));
  }
  return sttb;
};

const tablePlcs = (
  spec: DocSpec,
  built: ReturnType<typeof buildText>,
  add: (index: number, bytes: Bytes) => void,
): void => {
  const { model, ccpText } = built;
  const notes = refPositions(model, ccpText, "\u0002");
  const fnCount = spec.footnotes?.length ?? 0;
  if (fnCount > 0) {
    add(
      FCLCB.plcffndRef,
      cpPlc(
        [...notes.slice(0, fnCount), ccpText + 1],
        notes.slice(0, fnCount).map(() => [1, 0]),
      ),
    );
    add(
      FCLCB.plcffndTxt,
      textPlc(built.footnotes.starts, built.footnotes.length),
    );
  }
  const enCount = spec.endnotes?.length ?? 0;
  if (enCount > 0) {
    const refs = notes.slice(fnCount, fnCount + enCount);
    add(
      FCLCB.plcfendRef,
      cpPlc(
        [...refs, ccpText + 1],
        refs.map(() => [1, 0]),
      ),
    );
    add(
      FCLCB.plcfendTxt,
      textPlc(built.endnotes.starts, built.endnotes.length),
    );
  }
  const comments = spec.comments ?? [];
  if (comments.length > 0) {
    const authors = [...new Set(comments.map((comment) => comment.author))];
    const atrd = comments.map((comment) => {
      const entry = new Bytes().u16(comment.initials.length);
      for (const ch of comment.initials.padEnd(9, "\0").slice(0, 9))
        entry.u16(ch.charCodeAt(0));
      return entry
        .u16(authors.indexOf(comment.author))
        .u16(0)
        .u16(0)
        .u32(0xffffffff).parts;
    });
    add(
      FCLCB.plcfandRef,
      cpPlc([...refPositions(model, ccpText, "\u0005"), ccpText + 1], atrd),
    );
    add(FCLCB.plcfandTxt, textPlc(built.atn.starts, built.atn.length));
    const names = new Bytes();
    for (const author of authors) {
      names.u16(author.length);
      for (const ch of author) names.u16(ch.charCodeAt(0));
    }
    add(FCLCB.grpXstAtnOwners, names);
    const extra = new Bytes();
    for (const comment of comments)
      extra
        .u32(comment.date ?? 0)
        .u16(0)
        .u32(0)
        .u32(0)
        .u32(0);
    add(FCLCB.atrdExtra, extra);
  }
  if (built.hdd.length > 0)
    add(
      FCLCB.plcfHdd,
      cpPlc([...built.hdd.starts, built.hdd.length - 1, built.hdd.length + 1]),
    );
  for (const [index, story] of [
    [FCLCB.plcftxbxTxt, built.txbx],
    [FCLCB.plcfHdrtxbxTxt, built.hdrTxbx],
  ] as const) {
    if (story.starts.length === 0) continue;
    const boxes = story.starts.slice(0, -1);
    add(
      index,
      cpPlc(
        [...boxes, story.starts[story.starts.length - 1] ?? 0, story.length],
        [...boxes.map(() => zeros(22)), [...zeros(8), 1, 0, ...zeros(12)]],
      ),
    );
  }
  if (spec.attachedTemplate !== undefined)
    add(FCLCB.sttbfAssoc, sttbfAssoc(spec.attachedTemplate));
  const sections = [0, ...(spec.sectionStarts ?? []), ccpText];
  add(
    FCLCB.plcfSed,
    cpPlc(
      sections,
      sections.slice(1).map(() => zeros(12)),
    ),
  );
};

/** The FIB ([MS-DOC] 2.5): FibBase, FibRgW97, FibRgLw97, FibRgFcLcb blob, FibRgCswNew. */
const writeFib = (
  spec: DocSpec,
  built: ReturnType<typeof buildText>,
  entries: ReadonlyMap<number, { fc: number; lcb: number }>,
): { fib: Bytes; blobAt: number } => {
  const nFib = spec.nFib ?? 0x00c1;
  const [cb, cswNew] = CB_RG_FC_LCB.get(nFib) ?? [0x5d, 0];
  const flags =
    (spec.template === true ? 0x0001 : 0) |
    0x00f0 |
    (spec.encrypted === true ? 0x0100 : 0) |
    ((spec.tableStream ?? "1Table") === "1Table" ? 0x0200 : 0) |
    (spec.obfuscated === true ? 0x8000 : 0);
  const fib = new Bytes();
  fib
    .u16(0xa5ec)
    .u16(Math.min(nFib, 0x00c1))
    .u16(0)
    .u16(0x0409)
    .u16(0)
    .u16(flags);
  fib.u16(0x00bf).u32(0).u8(0, 0).u16(0).u16(0).u32(0).u32(0);
  fib.u16(14);
  for (let at = 0; at < 14; at += 1) fib.u16(0);
  fib.u16(22);
  const ccp = [
    0,
    0,
    0,
    built.ccpText,
    built.footnotes.length,
    built.hdd.length,
    0,
    built.atn.length,
    built.endnotes.length,
    built.txbx.length,
    built.hdrTxbx.length,
  ];
  for (let at = 0; at < 22; at += 1) fib.u32(ccp[at] ?? 0);
  fib.u16(cb);
  const blobAt = fib.length;
  for (let index = 0; index < cb; index += 1) {
    const entry =
      spec.omit?.includes(index) === true ? undefined : entries.get(index);
    fib.u32(entry?.fc ?? 0).u32(entry?.lcb ?? 0);
  }
  fib.u16(cswNew);
  if (cswNew > 0) fib.u16(nFib);
  for (let at = 1; at < cswNew; at += 1) fib.u16(0);
  return { fib, blobAt };
};

/** Encode a document. */
export const buildDoc = (spec: DocSpec): BuiltDoc => {
  const built = buildText(spec);
  const word = new Bytes();
  const pieces = placePieces(spec, built.model, word);
  const chpPlc = writeFkps(word, chpxPages(charEntries(built.model, pieces)));
  const data = new Bytes();
  for (let at = 0; at < (spec.dataPrefix ?? 0); at += 1) data.u8(at);
  const papPlc = writeFkps(
    word,
    papxPages(paragraphEntries(built.model, pieces, data)),
  );

  const table = new Bytes();
  const entries = new Map<number, { fc: number; lcb: number }>();
  const add = (index: number, bytes: Bytes): void => {
    table.pad(2);
    entries.set(index, { fc: table.length, lcb: bytes.length });
    table.append(bytes.parts);
  };
  add(FCLCB.stshf, stylesheet(spec.styles ?? []));
  add(FCLCB.plcfBteChpx, chpPlc);
  add(FCLCB.plcfBtePapx, papPlc);
  tablePlcs(spec, built, add);
  const clx = new Bytes();
  for (const grpprl of spec.prcs ?? [])
    clx
      .u8(0x01)
      .u16(grpprl.length)
      .u8(...grpprl);
  clx.u8(0x02).u32(pieces.length * 12 + 4);
  for (const piece of pieces) clx.u32(piece.cp);
  clx.u32(built.model.text.length);
  for (const piece of pieces)
    clx
      .u16(0)
      .u32(
        piece.compressed ? ((piece.byte * 2) | 0x40000000) >>> 0 : piece.byte,
      )
      .u16(piece.prm);
  add(FCLCB.clx, clx);

  const { fib, blobAt } = writeFib(spec, built, entries);
  const wordBytes = word.bytes();
  wordBytes.set(fib.bytes(), 0);
  const tableBytes = table.bytes();
  return {
    bytes: compound(
      wordBytes,
      tableBytes,
      spec.tableStream ?? "1Table",
      data.length === 0 ? [] : [{ name: "Data", data: data.bytes() }],
    ),
    word: wordBytes,
    table: tableBytes,
    entries,
    blobAt,
    text: built.model.text,
  };
};

/** Wrap WordDocument and table stream bytes (possibly edited) in a compound file. */
export const compound = (
  word: Uint8Array,
  table: Uint8Array,
  tableName: "0Table" | "1Table" = "1Table",
  extra: readonly CfbNode[] = [],
): Uint8Array =>
  writeCompoundFile([
    { name: "WordDocument", data: word },
    { name: tableName, data: table },
    ...extra,
  ]);

/** A real Word 97 file from macOS textutil, and textutil's own plain-text reading of it (the oracle). */
export const textutilDoc = async (
  directory: string,
  name: string,
  source: string,
  extension: "html" | "rtf" | "txt" = "html",
): Promise<{ doc: string; text: string }> => {
  if (TEXTUTIL === null) throw new Error("textutil is not available.");
  await mkdir(directory, { recursive: true });
  const input = join(directory, `${name}.${extension}`);
  const doc = join(directory, `${name}.doc`);
  const text = join(directory, `${name}.txt`);
  await writeFile(input, source);
  execFileSync(TEXTUTIL, ["-convert", "doc", input, "-output", doc]);
  execFileSync(TEXTUTIL, [
    "-convert",
    "txt",
    "-encoding",
    "UTF-8",
    doc,
    "-output",
    text,
  ]);
  return { doc, text: await readFile(text, "utf8") };
};

/** Inspect document bytes through the provider, from a private temporary file removed afterwards. */
export const inspectDoc = async (
  bytes: Uint8Array,
  input: object = {},
  signal?: AbortSignal,
) => {
  const directory = await mkdtemp(join(tmpdir(), "rea-doc-"));
  try {
    const path = join(directory, "fixture.doc");
    await writeFile(path, bytes);
    return await new OfficeDocumentProvider().inspectDocument(
      inspectOfficeDocumentInputSchema.parse({ path, limit: 5000, ...input }),
      signal === undefined ? undefined : { signal },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

/** The validated report, or the inspection's error thrown. */
export const readDoc = async (
  bytes: Uint8Array,
  input: object = { view: "content" },
): Promise<OfficeDocumentReport> => {
  const result = await inspectDoc(bytes, input);
  if (!result.ok) throw result.error;
  return officeDocumentReportSchema.parse(result.value);
};

export const paragraphTexts = (report: OfficeDocumentReport): string[] =>
  report.items.flatMap((item) =>
    item.kind === "paragraph" ? [item.text] : [],
  );

export const diagnosticText = (report: OfficeDocumentReport): string =>
  report.diagnostics
    .map((entry) => `${entry.location ?? ""}: ${entry.message}`)
    .join("\n");
