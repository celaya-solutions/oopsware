import type { ReaderCounters } from "../reader.js";
import { FC, type DocFib } from "./docFib.js";
import { decodeCodepage } from "./codepage.js";
import { ascending, readPlc, u32 } from "./docProps.js";

/**
 * Where each story's pieces of text begin and end ([MS-DOC] 2.3, 2.8): the
 * sections of the main text, the note and comment ranges with their
 * references, the header and footer stories, and how many text boxes there
 * are. A PLC that does not fit or does not increase is reported and its story
 * is read whole instead.
 */

const HEADER_TYPES = [
  ["even", "header"],
  ["odd", "header"],
  ["even", "footer"],
  ["odd", "footer"],
  ["first", "header"],
  ["first", "footer"],
] as const;
const MAX_AUTHORS = 10_000;
const ATRD_PRE10 = 30;
const ATRD_POST10 = 18;

export interface Range {
  readonly from: number;
  readonly to: number;
  readonly label: string;
}

export interface CommentRange extends Range {
  readonly author: string | null;
  readonly date: string | null;
}

export interface StoryIndex {
  /** First CP of each story after the main text. */
  readonly base: {
    readonly ftn: number;
    readonly hdd: number;
    readonly atn: number;
    readonly edn: number;
  };
  readonly sections: number;
  readonly sectionEnds: ReadonlySet<number>;
  readonly noteRefs: ReadonlyMap<number, string>;
  /** Null when the story's index could not be read; the story is then read whole. */
  readonly footnotes: readonly Range[] | null;
  readonly endnotes: readonly Range[] | null;
  readonly comments: readonly CommentRange[] | null;
  readonly headers: readonly Range[];
  readonly footers: readonly Range[];
  readonly headerFallback: boolean;
  readonly bodyBoxes: number;
  readonly headerBoxes: number;
}

const u16 = (bytes: Uint8Array, at: number): number =>
  (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);

const UTF16 = new TextDecoder("utf-16le");

/** A DTTM ([MS-DOC] 2.9.65) as YYYY-MM-DDTHH:MM local time; null when it says "no date". */
export const dttm = (value: number): string | null => {
  const minute = value & 0x3f;
  const hour = (value >>> 6) & 0x1f;
  const day = (value >>> 11) & 0x1f;
  const month = (value >>> 16) & 0x0f;
  const year = 1900 + ((value >>> 20) & 0x1ff);
  if (day === 0 || month === 0 || month > 12 || hour > 23 || minute > 59)
    return null;
  const two = (n: number): string => String(n).padStart(2, "0");
  return `${String(year)}-${two(month)}-${two(day)}T${two(hour)}:${two(minute)}`;
};

/** An array of Xst strings ([MS-DOC] 2.9.353), as GrpXstAtnOwners stores comment authors. */
const readXsts = (
  table: Uint8Array,
  entry: { fc: number; lcb: number } | null,
): string[] => {
  if (entry === null || entry.fc + entry.lcb > table.length) return [];
  const out: string[] = [];
  const end = entry.fc + entry.lcb;
  let at = entry.fc;
  while (at + 2 <= end && out.length < MAX_AUTHORS) {
    const cch = u16(table, at);
    if (at + 2 + cch * 2 > end) break;
    out.push(UTF16.decode(table.subarray(at + 2, at + 2 + cch * 2)));
    at += 2 + cch * 2;
  }
  return out;
};

interface Input {
  readonly fib: DocFib;
  readonly table: Uint8Array;
  readonly counters: ReaderCounters;
}

/** Ranges from a text PLC whose last two positions only close the list ([MS-DOC] 2.8.8, 2.8.17, 2.8.20). */
const storyRanges = (
  input: Input,
  index: number,
  story: { base: number; length: number },
  location: string,
): { from: number; to: number }[] | null => {
  const { table, fib, counters } = input;
  const plc = readPlc(table, fib.fcLcb(index), 0, location, counters);
  if (plc === null) return null;
  const usable = plc.positions.length - 1;
  if (usable < 1 || !ascending(plc.positions, usable, location, counters))
    return null;
  // The ranges must start at the story's start and end at its last character
  // (or its end), else text would fall outside every range unseen.
  const last = plc.positions[usable - 1] ?? 0;
  if (
    usable < 2 ||
    plc.positions[0] !== 0 ||
    last > story.length ||
    last < story.length - 1
  ) {
    counters.diagnose(
      location,
      "The text ranges do not cover their story; the story is read whole, as paragraphs.",
    );
    return null;
  }
  const ranges: { from: number; to: number }[] = [];
  for (let at = 0; at + 1 < usable; at += 1)
    ranges.push({
      from: story.base + (plc.positions[at] ?? 0),
      to: story.base + (plc.positions[at + 1] ?? 0),
    });
  return ranges;
};

/** Note text ranges and the main-text CPs of their references (PlcffndRef/PlcfendRef). */
const readNotes = (
  input: Input,
  kind: "footnote" | "endnote",
  story: { base: number; length: number },
  noteRefs: Map<number, string>,
): Range[] | null => {
  if (story.length === 0) return null;
  const [refIndex, txtIndex, name, prefix] =
    kind === "footnote"
      ? [FC.plcffndRef, FC.plcffndTxt, "Plcffnd", "fn"]
      : [FC.plcfendRef, FC.plcfendTxt, "Plcfend", "en"];
  const ranges = storyRanges(input, txtIndex, story, `${name}Txt`);
  const refs = readPlc(
    input.table,
    input.fib.fcLcb(refIndex),
    2,
    `${name}Ref`,
    input.counters,
  );
  if (refs !== null) {
    if (ranges !== null && refs.count !== ranges.length)
      input.counters.diagnose(
        `${name}Ref`,
        `${String(refs.count)} references for ${String(ranges.length)} note texts.`,
      );
    for (let at = 0; at < refs.count; at += 1)
      noteRefs.set(refs.positions[at] ?? 0, `[^${prefix}${String(at + 1)}]`);
  }
  const plural = kind === "footnote" ? "footnotes" : "endnotes";
  return (
    ranges?.map((range, at) => ({
      ...range,
      label: `${plural}#${kind}${String(at + 1)}`,
    })) ?? null
  );
};

/** Comment ranges with their author (ATRDPre10 -> GrpXstAtnOwners) and date (AtrdExtra). */
const readComments = (
  input: Input,
  story: { base: number; length: number },
): CommentRange[] | null => {
  if (story.length === 0) return null;
  const { table, fib, counters } = input;
  const ranges = storyRanges(input, FC.plcfandTxt, story, "PlcfandTxt");
  if (ranges === null) return null;
  const refs = readPlc(
    table,
    fib.fcLcb(FC.plcfandRef),
    ATRD_PRE10,
    "PlcfandRef",
    counters,
  );
  if (refs !== null && refs.count !== ranges.length)
    counters.diagnose(
      "PlcfandRef",
      `${String(refs.count)} comment references for ${String(ranges.length)} comment texts.`,
    );
  const authors = readXsts(table, fib.fcLcb(FC.grpXstAtnOwners));
  const extra = fib.fcLcb(FC.atrdExtra);
  return ranges.map((range, at) => {
    const label = `comments#comment${String(at + 1)}`;
    if (refs === null || at >= refs.count)
      return { ...range, label, author: null, date: null };
    const atrd = refs.dataAt + at * ATRD_PRE10;
    const cch = Math.min(9, u16(table, atrd));
    const initials = UTF16.decode(table.subarray(atrd + 2, atrd + 2 + cch * 2));
    const dateAt = extra === null ? -1 : extra.fc + at * ATRD_POST10;
    return {
      ...range,
      label,
      author:
        authors[u16(table, atrd + 20)] ?? (initials === "" ? null : initials),
      date:
        extra !== null &&
        (at + 1) * ATRD_POST10 <= extra.lcb &&
        dateAt + 4 <= table.length
          ? dttm(u32(table, dateAt))
          : null,
    };
  });
};

/** Header and footer stories: six separator stories, then six per section ([MS-DOC] 2.3.3, 2.8.22). */
const readHeaders = (
  input: Input,
  base: number,
): Pick<StoryIndex, "headers" | "footers" | "headerFallback"> => {
  const { table, fib, counters } = input;
  const headers: Range[] = [];
  const footers: Range[] = [];
  if (fib.ccp.hdd === 0) return { headers, footers, headerFallback: false };
  const plc = readPlc(table, fib.fcLcb(FC.plcfHdd), 0, "PlcfHdd", counters);
  const positions = plc?.positions ?? [];
  const usable = positions.length - 1;
  // Empty stories repeat a CP, so positions only need not to decrease.
  const valid =
    usable >= 1 &&
    (positions[usable - 1] ?? 0) <= fib.ccp.hdd &&
    positions
      .slice(0, usable)
      .every((cp, at) => at === 0 || cp >= (positions[at - 1] ?? 0));
  if (!valid) {
    counters.diagnose(
      "PlcfHdd",
      "The header story index cannot be read; headers and footers are read as one story.",
    );
    return { headers, footers, headerFallback: true };
  }
  for (let story = 6; story + 1 < usable; story += 1) {
    const from = positions[story] ?? 0;
    const to = positions[story + 1] ?? 0;
    if (to <= from) continue;
    const [kind, part] = HEADER_TYPES[(story - 6) % 6] ?? ["odd", "header"];
    (part === "header" ? headers : footers).push({
      // The last character of a non-empty story is its guard paragraph mark.
      from: base + from,
      to: base + to - 1,
      label: `${part}:s${String(Math.floor((story - 6) / 6) + 1)}:${kind}`,
    });
  }
  return { headers, footers, headerFallback: false };
};

/** Text boxes are counted, not read ([MS-DOC] 2.8.32: the last FTXBXS is always a spare). */
const countTextBoxes = (
  input: Input,
  index: number,
  length: number,
  location: string,
): number => {
  if (length === 0) return 0;
  const plc = readPlc(
    input.table,
    input.fib.fcLcb(index),
    22,
    location,
    input.counters,
  );
  if (plc === null) return 1;
  let found = 0;
  for (let at = 0; at + 1 < plc.count; at += 1)
    if ((u16(input.table, plc.dataAt + at * 22 + 8) & 1) === 0) found += 1;
  return found;
};

export const readStoryIndex = (
  fib: DocFib,
  table: Uint8Array,
  counters: ReaderCounters,
): StoryIndex => {
  const input: Input = { fib, table, counters };
  const { ccp } = fib;
  const base = {
    ftn: ccp.text,
    hdd: ccp.text + ccp.ftn,
    atn: ccp.text + ccp.ftn + ccp.hdd,
    edn: ccp.text + ccp.ftn + ccp.hdd + ccp.atn,
  };
  // Every section but the last ends with an end-of-section mark (0x0C).
  const sed = readPlc(table, fib.fcLcb(FC.plcfSed), 12, "PlcfSed", counters);
  const sectionEnds = new Set<number>();
  if (
    sed !== null &&
    ascending(sed.positions, sed.positions.length, "PlcfSed", counters)
  )
    for (let at = 1; at < sed.count; at += 1)
      sectionEnds.add((sed.positions[at] ?? 0) - 1);
  const noteRefs = new Map<number, string>();
  return {
    base,
    sections: sed?.count ?? 1,
    sectionEnds,
    noteRefs,
    footnotes: readNotes(
      input,
      "footnote",
      { base: base.ftn, length: ccp.ftn },
      noteRefs,
    ),
    endnotes: readNotes(
      input,
      "endnote",
      { base: base.edn, length: ccp.edn },
      noteRefs,
    ),
    comments: readComments(input, { base: base.atn, length: ccp.atn }),
    ...readHeaders(input, base.hdd),
    bodyBoxes: countTextBoxes(input, FC.plcftxbxTxt, ccp.txbx, "PlcftxbxTxt"),
    headerBoxes: countTextBoxes(
      input,
      FC.plcfHdrtxbxTxt,
      ccp.hdrTxbx,
      "PlcfHdrtxbxTxt",
    ),
  };
};

/**
 * The attached template's path: string 1 of the SttbfAssoc ([MS-DOC] 2.9.276),
 * an STTB of UTF-16 strings when it starts with 0xFFFF, else of 8-bit ones.
 * Null when there is none or the table does not fit.
 */
export const attachedTemplate = (
  table: Uint8Array,
  entry: { fc: number; lcb: number } | null,
): string | null => {
  if (entry === null || entry.fc + entry.lcb > table.length) return null;
  const end = entry.fc + entry.lcb;
  const extended = u16(table, entry.fc) === 0xffff;
  let at = entry.fc + (extended ? 2 : 0);
  const count = u16(table, at);
  const extra = u16(table, at + 2);
  at += 4;
  for (let index = 0; index < Math.min(count, 2); index += 1) {
    const cch = extended ? u16(table, at) : (table[at] ?? 0);
    const start = at + (extended ? 2 : 1);
    const stop = start + cch * (extended ? 2 : 1);
    if (stop + extra > end) return null;
    if (index === 1) {
      const bytes = table.subarray(start, stop);
      const text = extended
        ? UTF16.decode(bytes)
        : (decodeCodepage(1252, bytes) ?? "");
      return text === "" ? null : text;
    }
    at = stop + extra;
  }
  return null;
};
