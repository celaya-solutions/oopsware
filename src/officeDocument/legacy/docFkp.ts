import type { ReaderCounters } from "../reader.js";
import {
  NO_CHAR,
  applyChar,
  applyPara,
  eachPrl,
  readPlc,
  u16,
  u32,
  type CharSprms,
  type ParaSprms,
} from "./docProps.js";
import { checkpoint } from "./legacy.js";

/**
 * Formatted disk pages ([MS-DOC] 2.9.33 ChpxFkp, 2.9.174 PapxFkp): 512-byte
 * pages in the WordDocument stream that map stream offsets to character and
 * paragraph properties, found through PlcBteChpx and PlcBtePapx. A page is
 * read once however often the PLC names it; runs are kept in stream order
 * with overlaps removed, at most 1 M of them. Paragraph properties too large
 * for a page (sprmPHugePapx) are read from the Data stream.
 */

const MAX_RUNS = 1 << 20;
const PAGE = 512;
const SPRM_HUGE_PAPX = 0x6646;
/** PrcData.cbGrpprl may not exceed 0x3FA2 ([MS-DOC] 2.9.210). */
const MAX_PRC_DATA = 0x3fa2;
const MAX_HUGE_CHAIN = 16;
/** Distinct Data-stream property blocks resolved per document. */
const MAX_HUGE = 1 << 16;

export interface FcRun<T> {
  readonly start: number;
  readonly end: number;
  readonly props: T;
}

type PageParser<T> = (
  page: Uint8Array,
  add: (start: number, end: number, props: T) => void,
) => string | null;

/** A ChpxFkp ([MS-DOC] 2.9.33): crun runs, each pointing at a Chpx in the page or at none. */
export const chpxPage: PageParser<CharSprms> = (page, add) => {
  const crun = page[PAGE - 1] ?? 0;
  if (crun < 1 || crun > 0x65) return `crun ${String(crun)} is out of range`;
  const rgbAt = 4 * (crun + 1);
  let problem: string | null = null;
  for (let i = 0; i < crun; i += 1) {
    const start = u32(page, i * 4);
    const end = u32(page, i * 4 + 4);
    const offset = (page[rgbAt + i] ?? 0) * 2;
    if (end <= start) {
      problem = "run offsets do not increase";
      continue;
    }
    if (offset === 0) {
      add(start, end, NO_CHAR);
      continue;
    }
    const size = page[offset] ?? 0;
    if (offset < rgbAt + crun || offset + 1 + size > PAGE - 1) {
      problem = "a Chpx lies outside the page";
      continue;
    }
    const props: CharSprms = {};
    if (
      !eachPrl(page, offset + 1, offset + 1 + size, (sprm, at) =>
        applyChar(props, page, sprm, at),
      )
    )
      problem = "a Chpx ends inside a property";
    add(start, end, props);
  }
  return problem;
};

/** A PapxFkp ([MS-DOC] 2.9.174): cpara paragraphs, each pointing at a PapxInFkp (istd and grpprl). */
export const papxPage: PageParser<ParaSprms> = (page, add) => {
  const cpara = page[PAGE - 1] ?? 0;
  if (cpara < 1 || cpara > 0x1d)
    return `cpara ${String(cpara)} is out of range`;
  const rgbxAt = 4 * (cpara + 1);
  let problem: string | null = null;
  for (let i = 0; i < cpara; i += 1) {
    const start = u32(page, i * 4);
    const end = u32(page, i * 4 + 4);
    const offset = (page[rgbxAt + i * 13] ?? 0) * 2;
    if (end <= start) {
      problem = "paragraph offsets do not increase";
      continue;
    }
    if (offset === 0) {
      add(start, end, { istd: 0 });
      continue;
    }
    // PapxInFkp: cb, then 2cb-1 bytes; or cb 0, cb', then 2cb' bytes.
    const cb = page[offset] ?? 0;
    const dataAt = cb === 0 ? offset + 2 : offset + 1;
    const size = cb === 0 ? (page[offset + 1] ?? 0) * 2 : cb * 2 - 1;
    if (offset < rgbxAt + cpara * 13 || size < 2 || dataAt + size > PAGE - 1) {
      problem = "a PapxInFkp lies outside the page";
      continue;
    }
    const props: ParaSprms = { istd: u16(page, dataAt) };
    // sprmPHugePapx, when first, replaces the rest of the list ([MS-DOC] 2.6.2).
    if (size >= 8 && u16(page, dataAt + 2) === SPRM_HUGE_PAPX)
      props.huge = u32(page, dataAt + 4);
    else if (
      !eachPrl(page, dataAt + 2, dataAt + size, (sprm, at) =>
        applyPara(props, page, sprm, at),
      )
    )
      problem = "a PapxInFkp ends inside a property";
    add(start, end, props);
  }
  return problem;
};

/**
 * Read the FKPs a PlcBteChpx or PlcBtePapx points at and return their runs in
 * stream order with overlaps removed; null when the PLC itself is unreadable.
 */
export const readFkpRuns = async <T>(
  pages: {
    readonly table: Uint8Array;
    readonly word: Uint8Array;
    readonly counters: ReaderCounters;
    readonly signal: AbortSignal | undefined;
  },
  entry: { fc: number; lcb: number } | null,
  location: string,
  parse: PageParser<T>,
): Promise<FcRun<T>[] | null> => {
  const { table, word, counters, signal } = pages;
  const plc = readPlc(table, entry, 4, location, counters);
  if (plc === null) return null;
  const runs: FcRun<T>[] = [];
  const seen = new Set<number>();
  let badPages = 0;
  let capped = false;
  const problems = new Set<string>();
  for (let i = 0; i < plc.count && !capped; i += 1) {
    if (i % 4096 === 4095) await checkpoint(signal);
    const pn = u32(table, plc.dataAt + i * 4) & 0x3fffff;
    if (seen.has(pn)) continue;
    seen.add(pn);
    if ((pn + 1) * PAGE > word.length) {
      badPages += 1;
      continue;
    }
    const page = word.subarray(pn * PAGE, (pn + 1) * PAGE);
    const problem = parse(page, (start, end, props) => {
      if (runs.length >= MAX_RUNS) capped = true;
      else runs.push({ start, end, props });
    });
    if (problem !== null) problems.add(problem);
  }
  if (badPages > 0)
    counters.diagnose(
      location,
      `${String(badPages)} property pages lie outside the WordDocument stream; their text uses default properties.`,
    );
  for (const problem of problems)
    counters.diagnose(location, `A property page is damaged (${problem}).`);
  if (capped)
    counters.diagnose(
      location,
      `More than ${String(MAX_RUNS)} property runs; text past them uses default properties.`,
    );
  if (runs.some((run, at) => at > 0 && run.start < (runs[at - 1]?.start ?? 0)))
    runs.sort((a, b) => a.start - b.start);
  const kept: FcRun<T>[] = [];
  let overlaps = 0;
  for (const run of runs) {
    const last = kept[kept.length - 1];
    if (last !== undefined && run.start < last.end) overlaps += 1;
    else kept.push(run);
  }
  if (overlaps > 0)
    counters.diagnose(
      location,
      `${String(overlaps)} property runs overlap earlier runs; the earlier runs are used.`,
    );
  return kept;
};

/** Index of the first run that ends after `fc`. */
export const firstRunAfter = <T>(
  runs: readonly FcRun<T>[],
  fc: number,
): number => {
  let low = 0;
  let high = runs.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((runs[middle]?.end ?? 0) <= fc) low = middle + 1;
    else high = middle;
  }
  return low;
};

/** The run that holds stream offset `fc`, if any. */
export const runAt = <T>(
  runs: readonly FcRun<T>[],
  fc: number,
): FcRun<T> | undefined => {
  const run = runs[firstRunAfter(runs, fc)];
  return run !== undefined && run.start <= fc ? run : undefined;
};

/** Reads byte ranges of the Data stream; a result shorter than asked ran past the end. */
export type RangeReader = (
  ranges: readonly { offset: number; length: number }[],
) => Promise<Uint8Array[]>;

/**
 * Replace each paragraph run that names sprmPHugePapx with the properties of
 * the PrcData it points at in the Data stream. Only those PrcData are read
 * (their length first, then their body), a round per chain step, with a
 * visited set per chain. A run whose PrcData cannot be read keeps its istd.
 */
export const expandHugePapx = async (
  runs: readonly FcRun<ParaSprms>[],
  read: RangeReader | null,
  counters: ReaderCounters,
  signal: AbortSignal | undefined,
): Promise<FcRun<ParaSprms>[]> => {
  const resolved = new Map<number, ParaSprms | null>();
  let pending = new Map<number, { at: number; seen: Set<number> }>();
  for (const run of runs) {
    const start = run.props.huge;
    if (start === undefined || resolved.has(start) || pending.has(start))
      continue;
    if (pending.size >= MAX_HUGE) resolved.set(start, null);
    else pending.set(start, { at: start, seen: new Set() });
  }
  for (let round = 0; read !== null && pending.size > 0; round += 1) {
    await checkpoint(signal);
    const chains = [...pending];
    if (round >= MAX_HUGE_CHAIN) break;
    const heads = await read(
      chains.map(([, chain]) => ({ offset: chain.at, length: 2 })),
    );
    const sizes = heads.map((head) =>
      head.length === 2 ? (u16(head, 0) << 16) >> 16 : -1,
    );
    const bodies = await read(
      chains.map(([, chain], at) => ({
        offset: chain.at + 2,
        length: Math.min(MAX_PRC_DATA, Math.max(0, sizes[at] ?? 0)),
      })),
    );
    const next = new Map<number, { at: number; seen: Set<number> }>();
    for (const [at, [start, chain]] of chains.entries()) {
      const size = sizes[at] ?? -1;
      const body = bodies[at] ?? new Uint8Array(0);
      chain.seen.add(chain.at);
      if (size < 0 || size > MAX_PRC_DATA || body.length < size) {
        resolved.set(start, null);
      } else if (size >= 6 && u16(body, 0) === SPRM_HUGE_PAPX) {
        // sprmPHugePapx first in a PrcData: follow it, unless the chain comes back.
        const target = u32(body, 2);
        if (chain.seen.has(target)) resolved.set(start, null);
        else next.set(start, { at: target, seen: chain.seen });
      } else {
        const props: ParaSprms = {};
        eachPrl(body, 0, size, (sprm, operand) =>
          applyPara(props, body, sprm, operand),
        );
        resolved.set(start, props);
      }
    }
    pending = next;
  }
  let failed = 0;
  const out = runs.map((run) => {
    if (run.props.huge === undefined) return run;
    const found = resolved.get(run.props.huge) ?? null;
    if (found === null) failed += 1;
    return {
      ...run,
      props: { ...found, istd: found?.istd ?? run.props.istd ?? 0 },
    };
  });
  if (failed > 0)
    counters.diagnose(
      "PlcfBtePapx",
      `${String(failed)} paragraphs keep their properties in the Data stream, which ${read === null ? "the file does not have" : "does not hold them as declared"}; they are read without those properties.`,
    );
  return out;
};
