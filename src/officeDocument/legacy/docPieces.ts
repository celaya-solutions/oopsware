import type { ReaderCounters } from "../reader.js";
import { FC, type DocFib, type StoryCounts } from "./docFib.js";
import {
  MAX_PLC,
  prmProps,
  u32,
  type CharSprms,
  type ParaSprms,
} from "./docProps.js";
import { LegacyFormatError, checkpoint } from "./legacy.js";

/**
 * The Word 97-2003 piece table ([MS-DOC] 2.9.38 Clx, 2.9.177 Pcd): it maps
 * character positions (CPs) to the WordDocument stream. Pieces are checked
 * before anything else is done with them: CPs must increase, text must lie in
 * the stream, and a piece whose bytes overlap a piece kept earlier in text
 * order is left out (the spec is silent on overlap; this bounds the text to
 * the stream). Only then is each distinct Prm parsed, once.
 */

export interface Piece {
  readonly cp: number;
  readonly end: number;
  /** Byte offset of the piece's first character in the WordDocument stream. */
  readonly byte: number;
  readonly width: 1 | 2;
  readonly chp: CharSprms | null;
  readonly pap: ParaSprms | null;
}

interface Candidate {
  readonly cp: number;
  readonly end: number;
  readonly byte: number;
  readonly width: 1 | 2;
  readonly prm: number;
}

/** Pieces checked between yields to the event loop. */
const BATCH = 4096;

const totalCps = (ccp: StoryCounts): number => {
  const others = ccp.ftn + ccp.hdd + ccp.atn + ccp.edn + ccp.txbx + ccp.hdrTxbx;
  // A document with any part beyond the main text carries one extra paragraph mark.
  return ccp.text + others + (others > 0 ? 1 : 0);
};

/** The Clx ([MS-DOC] 2.9.38): its property groups (Prc) and where its PlcPcd lies. */
const readClx = (
  table: Uint8Array,
  entry: { fc: number; lcb: number } | null,
): { grpprls: Uint8Array[]; plcAt: number; count: number } => {
  if (entry === null)
    throw new LegacyFormatError(
      "The document has no piece table (Clx), so its text cannot be located.",
    );
  const end = entry.fc + entry.lcb;
  if (end > table.length)
    throw new LegacyFormatError(
      `The piece table (Clx) runs past the ${String(table.length)}-byte table stream.`,
    );
  const grpprls: Uint8Array[] = [];
  let at = entry.fc;
  // Each Prc is at least 3 bytes, so the loop ends within the Clx.
  while (at < end && table[at] === 0x01) {
    const size =
      (((table[at + 1] ?? 0) | ((table[at + 2] ?? 0) << 8)) << 16) >> 16;
    if (size < 0 || at + 3 + size > end || grpprls.length >= MAX_PLC)
      throw new LegacyFormatError(
        `The piece table (Clx) has a damaged property group at table offset ${String(at)}.`,
      );
    grpprls.push(table.subarray(at + 3, at + 3 + size));
    at += 3 + size;
  }
  if (at < end && table[at] !== 0x02)
    throw new LegacyFormatError(
      `The piece table (Clx) has an unexpected byte 0x${(table[at] ?? 0).toString(16)} at table offset ${String(at)}.`,
    );
  const size = at < end ? u32(table, at + 1) : 0;
  if (at >= end || at + 5 + size > end || size < 16 || (size - 4) % 12 !== 0)
    throw new LegacyFormatError(
      "The piece table (PlcPcd) is missing or not a whole number of pieces.",
    );
  const count = (size - 4) / 12;
  if (count > MAX_PLC)
    throw new LegacyFormatError(
      `The piece table declares ${String(count)} pieces, over the ${String(MAX_PLC)}-piece limit.`,
    );
  return { grpprls, plcAt: at + 5, count };
};

/** Pieces whose CPs increase and whose text lies inside the stream, in text order. */
const candidates = async (
  table: Uint8Array,
  clx: { plcAt: number; count: number },
  wordLength: number,
  signal: AbortSignal | undefined,
): Promise<Candidate[]> => {
  const { plcAt, count } = clx;
  const out: Candidate[] = [];
  let lastEnd = 0;
  for (let i = 0; i < count; i += 1) {
    if (i % BATCH === BATCH - 1) await checkpoint(signal);
    const cp = u32(table, plcAt + i * 4);
    const end = u32(table, plcAt + i * 4 + 4);
    const pcd = plcAt + (count + 1) * 4 + i * 8;
    const fc = u32(table, pcd + 2);
    const width: 1 | 2 = (fc & 0x40000000) !== 0 ? 1 : 2;
    const raw = fc & 0x3fffffff;
    const byte = width === 1 ? Math.floor(raw / 2) : raw;
    if (
      end <= cp ||
      cp < lastEnd ||
      end > 0x7fffffff ||
      byte + (end - cp) * width > wordLength
    )
      continue;
    out.push({
      cp,
      end,
      byte,
      width,
      prm: (table[pcd + 6] ?? 0) | ((table[pcd + 7] ?? 0) << 8),
    });
    lastEnd = end;
  }
  return out;
};

/**
 * Keep pieces in text order unless their bytes overlap a piece already kept.
 * Kept byte ranges never overlap, so the kept range with the largest start
 * below a piece's end decides; a Fenwick tree over the starts finds it in
 * O(log n).
 */
const keepDisjoint = async (
  pieces: readonly Candidate[],
  signal: AbortSignal | undefined,
): Promise<Candidate[]> => {
  const starts = [...new Set(pieces.map((piece) => piece.byte))].sort(
    (a, b) => a - b,
  );
  const size = starts.length;
  const tree = new Int32Array(size + 1);
  const endAt = new Float64Array(size);
  /** How many starts are below `value`. */
  const below = (value: number): number => {
    let low = 0;
    let high = size;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((starts[middle] ?? 0) < value) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  const keptBelow = (count: number): number => {
    let sum = 0;
    for (let at = count; at > 0; at -= at & -at) sum += tree[at] ?? 0;
    return sum;
  };
  /** Rank of the k-th kept start (1-based k). */
  const kth = (k: number): number => {
    let position = 0;
    let remaining = k;
    for (let step = 1 << Math.floor(Math.log2(size || 1)); step > 0; step >>= 1)
      if (position + step <= size && (tree[position + step] ?? 0) < remaining) {
        position += step;
        remaining -= tree[position] ?? 0;
      }
    return position;
  };
  const kept: Candidate[] = [];
  for (const [index, piece] of pieces.entries()) {
    if (index % BATCH === BATCH - 1) await checkpoint(signal);
    const end = piece.byte + (piece.end - piece.cp) * piece.width;
    const count = keptBelow(below(end));
    if (count > 0 && (endAt[kth(count)] ?? 0) > piece.byte) continue;
    const rank = below(piece.byte);
    for (let at = rank + 1; at <= size; at += at & -at)
      tree[at] = (tree[at] ?? 0) + 1;
    endAt[rank] = end;
    kept.push(piece);
  }
  return kept;
};

/** Read the piece table. Throws when there is no usable piece; damaged pieces are left out and reported. */
export const readPieces = async (
  fib: DocFib,
  table: Uint8Array,
  wordLength: number,
  context: { counters: ReaderCounters; signal: AbortSignal | undefined },
): Promise<Piece[]> => {
  const { counters, signal } = context;
  const clx = readClx(table, fib.fcLcb(FC.clx));
  const kept = await keepDisjoint(
    await candidates(table, clx, wordLength, signal),
    signal,
  );
  if (kept.length < clx.count)
    counters.diagnose(
      "Clx",
      `${String(clx.count - kept.length)} of ${String(clx.count)} pieces are out of order, outside the WordDocument stream or share bytes with another piece; their text is left out.`,
    );
  if (kept.length === 0)
    throw new LegacyFormatError(
      "The piece table has no usable piece, so the document's text cannot be located.",
    );
  // Many pieces share one Prm; each distinct value is parsed once.
  const parsed = new Map<number, ReturnType<typeof prmProps>>();
  let missingPrm = 0;
  const pieces = kept.map((piece): Piece => {
    let prm = parsed.get(piece.prm);
    if (prm === undefined) {
      prm = prmProps(piece.prm, clx.grpprls);
      parsed.set(piece.prm, prm);
    }
    if (prm.missing) missingPrm += 1;
    const { cp, end, byte, width } = piece;
    return { cp, end, byte, width, chp: prm.chp, pap: prm.pap };
  });
  if (missingPrm > 0)
    counters.diagnose(
      "Clx",
      `${String(missingPrm)} pieces name a property group the piece table does not have; their extra properties are not applied.`,
    );
  const covered = pieces[pieces.length - 1]?.end ?? 0;
  const declared = totalCps(fib.ccp);
  if (covered !== declared)
    counters.diagnose(
      "Clx",
      `The piece table covers ${String(covered)} characters; the file information block declares ${String(declared)}.`,
    );
  return pieces;
};
