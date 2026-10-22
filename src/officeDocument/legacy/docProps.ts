import type { ReaderCounters } from "../reader.js";

/**
 * Word 97-2003 property storage ([MS-DOC] 2.2.5, 2.6, 2.8, 2.9): single
 * property modifiers (Prl), the piece modifiers (Prm) and the PLCs that index
 * the table stream. Only the properties the reader reports are kept; every
 * other Prl is skipped by its declared size. Counts, offsets and sizes are
 * checked against the bytes before they are followed.
 */

/** Most entries one PLC may hold; a larger declaration is not read. */
export const MAX_PLC = 1 << 20;

/** Character properties a run sets directly; toggles keep their raw ToggleOperand. */
export interface CharSprms {
  vanish?: number;
  del?: number;
  ins?: number;
  spec?: number;
  ole?: boolean;
  istd?: number;
  symbol?: boolean;
}

export interface ParaSprms {
  istd?: number;
  inTable?: boolean;
  ttp?: boolean;
  itap?: number;
  dtap?: number;
  innerCell?: boolean;
  innerTtp?: boolean;
  ilvl?: number;
  ilfo?: number;
  outLvl?: number;
  /** sprmPHugePapx: the Data stream offset of the paragraph's real properties. */
  huge?: number;
}

export const NO_CHAR: CharSprms = Object.freeze({});

export const u16 = (bytes: Uint8Array, at: number): number =>
  (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
export const u32 = (bytes: Uint8Array, at: number): number =>
  (u16(bytes, at) | (u16(bytes, at + 2) << 16)) >>> 0;
const i32 = (bytes: Uint8Array, at: number): number => u32(bytes, at) | 0;
const i16 = (bytes: Uint8Array, at: number): number =>
  (u16(bytes, at) << 16) >> 16;

/** ToggleOperand ([MS-DOC] 2.9.327): 0 off, 1 on, 0x80 the style's value, 0x81 its opposite. */
export const toggle = (
  operand: number | undefined,
  style: boolean,
): boolean => {
  switch (operand) {
    case 0:
      return false;
    case 1:
      return true;
    case 0x80:
      return style;
    case 0x81:
      return !style;
    default:
      return style;
  }
};

const SPRM_TDEF_TABLE = 0xd608;
const SPRM_PCHG_TABS = 0xc615;
const FIXED_OPERAND = [1, 1, 2, 4, 2, 2, -1, 3] as const;

/** Operand size of the Prl at `at` ([MS-DOC] 2.2.5.1), or null when it runs past `end`. */
const operandSize = (
  bytes: Uint8Array,
  sprm: number,
  at: number,
  end: number,
): number | null => {
  const fixed = FIXED_OPERAND[sprm >>> 13] ?? -1;
  if (fixed >= 0) return fixed;
  if (at >= end) return null;
  if (sprm === SPRM_TDEF_TABLE) {
    if (at + 2 > end) return null;
    // cb counts the rest of the operand plus one.
    return Math.max(2, u16(bytes, at) + 1);
  }
  const cb = bytes[at] ?? 0;
  if (sprm === SPRM_PCHG_TABS && cb === 255) {
    // PChgTabsDelClose (1 + 4n bytes) then PChgTabsAdd (1 + 3m bytes) after cb.
    const deleted = bytes[at + 1] ?? 0;
    const addAt = at + 2 + deleted * 4;
    if (addAt >= end) return null;
    return 3 + deleted * 4 + (bytes[addAt] ?? 0) * 3;
  }
  return 1 + cb;
};

/** Call `visit` for every whole Prl in bytes[start, end); false when the last one is cut off. */
export const eachPrl = (
  bytes: Uint8Array,
  start: number,
  end: number,
  visit: (sprm: number, operand: number) => void,
): boolean => {
  let at = start;
  while (at + 2 <= end) {
    const sprm = u16(bytes, at);
    const size = operandSize(bytes, sprm, at + 2, end);
    if (size === null || at + 2 + size > end) return false;
    visit(sprm, at + 2);
    at += 2 + size;
  }
  return at === end;
};

/** Apply one Prl to the character properties it can change. */
export const applyChar = (
  target: CharSprms,
  bytes: Uint8Array,
  sprm: number,
  at: number,
): void => {
  switch (sprm) {
    case 0x0800:
      target.del = bytes[at] ?? 0;
      break;
    case 0x0801:
      target.ins = bytes[at] ?? 0;
      break;
    case 0x083c:
      target.vanish = bytes[at] ?? 0;
      break;
    case 0x0855:
      target.spec = bytes[at] ?? 0;
      break;
    case 0x080a:
      target.ole = (bytes[at] ?? 0) !== 0;
      break;
    case 0x4a30:
      target.istd = u16(bytes, at);
      break;
    case 0x6a09:
      target.symbol = true;
      break;
    default:
      break;
  }
};

/** Apply one Prl to the paragraph properties it can change. */
export const applyPara = (
  target: ParaSprms,
  bytes: Uint8Array,
  sprm: number,
  at: number,
): void => {
  switch (sprm) {
    case 0x4600:
      target.istd = u16(bytes, at);
      break;
    case 0x2416:
      target.inTable = (bytes[at] ?? 0) !== 0;
      break;
    case 0x2417:
      target.ttp = (bytes[at] ?? 0) !== 0;
      break;
    case 0x6649:
      target.itap = i32(bytes, at);
      break;
    case 0x664a:
      target.dtap = (target.dtap ?? 0) + i32(bytes, at);
      break;
    case 0x244b:
      target.innerCell = (bytes[at] ?? 0) !== 0;
      break;
    case 0x244c:
      target.innerTtp = (bytes[at] ?? 0) !== 0;
      break;
    case 0x260a:
      target.ilvl = bytes[at] ?? 0;
      break;
    case 0x460b:
      target.ilfo = i16(bytes, at);
      break;
    case 0x2640:
      target.outLvl = bytes[at] ?? 0;
      break;
    default:
      break;
  }
};

/** Prm0 isprm values ([MS-DOC] 2.9.215) for the properties this reader keeps. */
const PRM0_SPRM: ReadonlyMap<number, number> = new Map([
  [0x0c, 0x260a],
  [0x18, 0x2416],
  [0x19, 0x2417],
  [0x41, 0x0800],
  [0x42, 0x0801],
  [0x4b, 0x080a],
  [0x5c, 0x083c],
  [0x75, 0x0855],
  [0x78, 0x2640],
]);

/** A piece's Prm ([MS-DOC] 2.9.214): one Prl (Prm0) or a grpprl from the Clx (Prm1). */
export const prmProps = (
  prm: number,
  grpprls: readonly Uint8Array[],
): { chp: CharSprms | null; pap: ParaSprms | null; missing: boolean } => {
  if ((prm & 1) === 0) {
    const sprm = PRM0_SPRM.get((prm >>> 1) & 0x7f);
    if (sprm === undefined) return { chp: null, pap: null, missing: false };
    const bytes = Uint8Array.of(sprm & 0xff, sprm >>> 8, prm >>> 8);
    const chp: CharSprms = {};
    const pap: ParaSprms = {};
    applyChar(chp, bytes, sprm, 2);
    applyPara(pap, bytes, sprm, 2);
    return { chp, pap, missing: false };
  }
  const grpprl = grpprls[prm >>> 1];
  if (grpprl === undefined) return { chp: null, pap: null, missing: true };
  const chp: CharSprms = {};
  const pap: ParaSprms = {};
  eachPrl(grpprl, 0, grpprl.length, (sprm, at) => {
    applyChar(chp, grpprl, sprm, at);
    applyPara(pap, grpprl, sprm, at);
  });
  return { chp, pap, missing: false };
};

export interface Plc {
  /** n + 1 positions (CPs or stream offsets). */
  readonly positions: readonly number[];
  /** Number of data elements (n). */
  readonly count: number;
  /** Offset of the first data element in the table stream. */
  readonly dataAt: number;
}

/** A PLC ([MS-DOC] 2.2.2) with `dataSize`-byte elements, checked against the table stream; null (and a diagnostic) when it does not fit. */
export const readPlc = (
  table: Uint8Array,
  entry: { fc: number; lcb: number } | null,
  dataSize: number,
  location: string,
  counters: ReaderCounters,
): Plc | null => {
  if (entry === null) return null;
  const { fc, lcb } = entry;
  if (fc + lcb > table.length) {
    counters.diagnose(
      location,
      `The structure at offset ${String(fc)} (${String(lcb)} bytes) runs past the ${String(table.length)}-byte table stream; it is not read.`,
    );
    return null;
  }
  if (lcb < 4 || (lcb - 4) % (4 + dataSize) !== 0) {
    counters.diagnose(
      location,
      `The structure is ${String(lcb)} bytes, which is not a whole number of ${String(4 + dataSize)}-byte entries plus one position; it is not read.`,
    );
    return null;
  }
  const count = (lcb - 4) / (4 + dataSize);
  if (count > MAX_PLC) {
    counters.diagnose(
      location,
      `The structure declares ${String(count)} entries, over the ${String(MAX_PLC)}-entry limit; it is not read.`,
    );
    return null;
  }
  const positions: number[] = [];
  for (let at = 0; at <= count; at += 1)
    positions.push(u32(table, fc + at * 4));
  return { positions, count, dataAt: fc + (count + 1) * 4 };
};

/** True when positions strictly increase; otherwise a diagnostic. */
export const ascending = (
  positions: readonly number[],
  upto: number,
  location: string,
  counters: ReaderCounters,
): boolean => {
  for (let at = 1; at < upto; at += 1)
    if ((positions[at] ?? 0) <= (positions[at - 1] ?? 0)) {
      counters.diagnose(
        location,
        `Position ${String(at)} (${String(positions[at])}) does not follow position ${String(at - 1)} (${String(positions[at - 1])}); the structure is not read.`,
      );
      return false;
    }
  return true;
};
