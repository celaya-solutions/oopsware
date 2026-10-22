import type { ReaderCounters } from "../reader.js";
import {
  applyChar,
  applyPara,
  eachPrl,
  toggle,
  type CharSprms,
  type ParaSprms,
} from "./docProps.js";

/**
 * The Word 97-2003 stylesheet ([MS-DOC] 2.9.271 STSH): style names, built-in
 * identifiers (sti), inheritance (istdBase) and the few properties the reader
 * reports from a style: hidden text, list membership and outline level.
 * Inheritance chains are followed iteratively with a visited set.
 */

const NO_BASE = 0x0fff;
const MAX_STYLES = 0x0ffe;
const HEADING = /^heading\s*([1-9])$/iu;

interface StyleEntry {
  readonly name: string | null;
  readonly sti: number;
  readonly base: number;
  readonly chp: CharSprms;
  readonly pap: ParaSprms;
}

export interface ResolvedStyle {
  /** Primary name; null for the default paragraph style (istd 0) and for styles without a name. */
  readonly name: string | null;
  readonly heading: number | null;
  readonly vanish: boolean;
  readonly ilfo: number | undefined;
  readonly ilvl: number | undefined;
  readonly outLvl: number | undefined;
}

const PLAIN: ResolvedStyle = {
  name: null,
  heading: null,
  vanish: false,
  ilfo: undefined,
  ilvl: undefined,
  outLvl: undefined,
};

const u16 = (bytes: Uint8Array, at: number): number =>
  (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);

/** One STD ([MS-DOC] 2.9.258): StdfBase, the name (Xstz) and the UPXs its type carries. */
const readStd = (std: Uint8Array, stdfSize: number): StyleEntry | string => {
  if (std.length < Math.max(10, stdfSize) + 2)
    return "too short for its header";
  const sti = u16(std, 0) & 0x0fff;
  const stk = u16(std, 2) & 0x000f;
  const base = u16(std, 2) >>> 4;
  const cupx = u16(std, 4) & 0x000f;
  const cch = u16(std, stdfSize);
  const nameEnd = stdfSize + 2 + cch * 2;
  if (nameEnd + 2 > std.length) return "its name runs past the style";
  const name = new TextDecoder("utf-16le").decode(
    std.subarray(stdfSize + 2, nameEnd),
  );
  const chp: CharSprms = {};
  const pap: ParaSprms = {};
  // UPXs in order: table style TAPX, PAPX, CHPX; paragraph PAPX, CHPX; character CHPX; list PAPX.
  const order: readonly ("tapx" | "papx" | "chpx")[] =
    stk === 1
      ? ["papx", "chpx"]
      : stk === 2
        ? ["chpx"]
        : stk === 3
          ? ["tapx", "papx", "chpx"]
          : ["papx"];
  let at = nameEnd + 2;
  for (const kind of order.slice(0, cupx)) {
    if (at + 2 > std.length) return "a property block runs past the style";
    const size = u16(std, at);
    const start = at + 2;
    const end = start + size;
    if (end > std.length) return "a property block runs past the style";
    if (kind === "papx" && size >= 2)
      eachPrl(std, start + 2, end, (sprm, operand) =>
        applyPara(pap, std, sprm, operand),
      );
    else if (kind === "chpx")
      eachPrl(std, start, end, (sprm, operand) =>
        applyChar(chp, std, sprm, operand),
      );
    at = end + (size & 1);
  }
  return { name: name.split(",")[0] ?? name, sti, base, chp, pap };
};

/** Built-in heading styles have sti 1-9; a user style named "heading N" counts too. */
const headingLevel = (style: StyleEntry): number | null => {
  if (style.sti >= 1 && style.sti <= 9) return style.sti;
  const match = HEADING.exec(style.name ?? "");
  return match?.[1] === undefined ? null : Number.parseInt(match[1], 10);
};

export class DocStyles {
  readonly #entries: readonly (StyleEntry | null)[];
  readonly #resolved = new Map<number, ResolvedStyle>();
  readonly #counters: ReaderCounters;
  #cycleReported = false;

  constructor(
    entries: readonly (StyleEntry | null)[],
    counters: ReaderCounters,
  ) {
    this.#entries = entries;
    this.#counters = counters;
  }

  /** The style and its bases, own style first; an istdBase cycle is cut and reported once. */
  #chain(istd: number): StyleEntry[] {
    const chain: StyleEntry[] = [];
    const seen = new Set<number>();
    let current = istd;
    while (current !== NO_BASE) {
      const entry = this.#entries[current];
      if (entry === undefined || entry === null) break;
      if (seen.has(current)) {
        if (!this.#cycleReported)
          this.#counters.diagnose(
            "STSH",
            `Style ${String(current)} inherits from itself through istdBase; the cycle is cut.`,
          );
        this.#cycleReported = true;
        break;
      }
      seen.add(current);
      chain.push(entry);
      current = entry.base;
    }
    return chain;
  }

  /** A style with its inherited properties folded in, base first. */
  resolve(istd: number): ResolvedStyle {
    const known = this.#resolved.get(istd);
    if (known !== undefined) return known;
    const chain = this.#chain(istd);
    let vanish = false;
    let ilfo: number | undefined;
    let ilvl: number | undefined;
    let outLvl: number | undefined;
    for (const entry of chain.toReversed()) {
      vanish = toggle(entry.chp.vanish, vanish);
      ilfo = entry.pap.ilfo ?? ilfo;
      ilvl = entry.pap.ilvl ?? ilvl;
      outLvl = entry.pap.outLvl ?? outLvl;
    }
    const own = chain[0];
    const resolved =
      own === undefined
        ? PLAIN
        : {
            name: istd === 0 ? null : own.name,
            heading: headingLevel(own),
            vanish,
            ilfo,
            ilvl,
            outLvl,
          };
    this.#resolved.set(istd, resolved);
    return resolved;
  }
}

/** Read the STSH at fcStshf; an unreadable stylesheet gives plain styles and a diagnostic. */
export const readStyles = (
  table: Uint8Array,
  entry: { fc: number; lcb: number } | null,
  counters: ReaderCounters,
): DocStyles => {
  const location = "STSH";
  if (entry === null) return new DocStyles([], counters);
  if (entry.fc + entry.lcb > table.length || entry.lcb < 2) {
    counters.diagnose(
      location,
      "The stylesheet lies outside the table stream; style names, headings and hidden styles are not known.",
    );
    return new DocStyles([], counters);
  }
  const stsh = table.subarray(entry.fc, entry.fc + entry.lcb);
  const cbStshi = u16(stsh, 0);
  if (cbStshi < 4 || 2 + cbStshi > stsh.length) {
    counters.diagnose(location, "The stylesheet header is damaged.");
    return new DocStyles([], counters);
  }
  const cstd = Math.min(u16(stsh, 2), MAX_STYLES);
  const stdfSize = u16(stsh, 4);
  if (stdfSize < 10 || stdfSize > 64) {
    counters.diagnose(
      location,
      `The stylesheet declares ${String(stdfSize)}-byte style headers; styles are not read.`,
    );
    return new DocStyles([], counters);
  }
  const entries: (StyleEntry | null)[] = [];
  let at = 2 + cbStshi;
  let damaged = 0;
  for (let istd = 0; istd < cstd && at + 2 <= stsh.length; istd += 1) {
    const cbStd = u16(stsh, at);
    const end = at + 2 + cbStd;
    if (end > stsh.length) {
      damaged += 1;
      break;
    }
    if (cbStd === 0) entries.push(null);
    else {
      const read = readStd(stsh.subarray(at + 2, end), stdfSize);
      if (typeof read === "string") {
        damaged += 1;
        entries.push(null);
      } else entries.push(read);
    }
    // LPStd structures are stored on even-byte boundaries.
    at = end + (cbStd & 1);
  }
  if (damaged > 0)
    counters.diagnose(
      location,
      `${String(damaged)} style definitions could not be read; paragraphs using them show no style name.`,
    );
  return new DocStyles(entries, counters);
};
