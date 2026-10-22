import type { ReaderCounters } from "../reader.js";
import { firstRunAfter, type FcRun } from "./docFkp.js";
import type { Piece } from "./docPieces.js";
import { NO_CHAR, type CharSprms, type ParaSprms } from "./docProps.js";
import { checkpoint, type LegacyStreams } from "./legacy.js";

/**
 * Word 97-2003 text ([MS-DOC] 2.4.1, 2.9.73): a story's characters, cut into
 * segments, each one validated piece crossed with one character run, decoded
 * from 8-bit "compressed" text or UTF-16LE. CPs no piece covers are a gap.
 */

export interface Segment {
  readonly cp: number;
  readonly text: string;
  /** Byte offset of the segment's first character. */
  readonly fc: number;
  readonly width: 1 | 2;
  readonly chp: CharSprms;
  readonly pap: ParaSprms | null;
}

/** [MS-DOC] 2.9.73: the bytes 0x82-0x9F of compressed text that are not Latin-1. */
const COMPRESSED_SPECIAL: ReadonlyMap<number, number> = new Map([
  [0x82, 0x201a],
  [0x83, 0x0192],
  [0x84, 0x201e],
  [0x85, 0x2026],
  [0x86, 0x2020],
  [0x87, 0x2021],
  [0x88, 0x02c6],
  [0x89, 0x2030],
  [0x8a, 0x0160],
  [0x8b, 0x2039],
  [0x8c, 0x0152],
  [0x91, 0x2018],
  [0x92, 0x2019],
  [0x93, 0x201c],
  [0x94, 0x201d],
  [0x95, 0x2022],
  [0x96, 0x2013],
  [0x97, 0x2014],
  [0x98, 0x02dc],
  [0x99, 0x2122],
  [0x9a, 0x0161],
  [0x9b, 0x203a],
  [0x9c, 0x0153],
  [0x9f, 0x0178],
]);
const COMPRESSED = Uint16Array.from(
  { length: 256 },
  (_, byte) => COMPRESSED_SPECIAL.get(byte) ?? byte,
);
const UTF16 = new TextDecoder("utf-16le");

const decode = (bytes: Uint8Array, width: 1 | 2): string => {
  if (width === 2) return UTF16.decode(bytes);
  const units = new Uint16Array(bytes.length);
  for (let at = 0; at < bytes.length; at += 1)
    units[at] = COMPRESSED[bytes[at] ?? 0] ?? 0;
  return UTF16.decode(units);
};

const firstPieceAfter = (pieces: readonly Piece[], cp: number): number => {
  let low = 0;
  let high = pieces.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((pieces[middle]?.end ?? 0) <= cp) low = middle + 1;
    else high = middle;
  }
  return low;
};

export interface TextSource {
  readonly word: Uint8Array;
  readonly pieces: readonly Piece[];
  readonly chpRuns: readonly FcRun<CharSprms>[];
  readonly streams: LegacyStreams;
  readonly counters: ReaderCounters;
  readonly signal: AbortSignal | undefined;
}

/** The text of CPs [from, to) as segments; CPs no piece covers are skipped and reported once. */
export const segments = async (
  source: TextSource,
  from: number,
  to: number,
  label: string,
): Promise<Segment[]> => {
  const { pieces, chpRuns, word } = source;
  let chars = 0;
  for (let at = firstPieceAfter(pieces, from); at < pieces.length; at += 1) {
    const piece = pieces[at];
    if (piece === undefined || piece.cp >= to) break;
    chars += Math.min(to, piece.end) - Math.max(from, piece.cp);
  }
  source.streams.claim(chars * 2, `${label} text`);
  if (chars < to - from)
    source.counters.diagnose(
      label,
      `${String(to - from - chars)} characters of this story are not in the piece table; they are left out.`,
    );
  const out: Segment[] = [];
  for (let at = firstPieceAfter(pieces, from); at < pieces.length; at += 1) {
    if (at % 4096 === 4095) await checkpoint(source.signal);
    const piece = pieces[at];
    if (piece === undefined || piece.cp >= to) break;
    const start = Math.max(from, piece.cp);
    const end = Math.min(to, piece.end);
    const width = piece.width;
    const byteStart = piece.byte + (start - piece.cp) * width;
    const byteEnd = piece.byte + (end - piece.cp) * width;
    let cursor = byteStart;
    const emit = (until: number, chp: CharSprms): void => {
      // Runs split on byte offsets; a UTF-16 piece is cut on whole characters.
      const stop = Math.min(
        byteEnd,
        byteStart + Math.ceil((until - byteStart) / width) * width,
      );
      if (stop <= cursor) return;
      out.push({
        cp: start + (cursor - byteStart) / width,
        text: decode(word.subarray(cursor, stop), width),
        fc: cursor,
        width,
        chp: piece.chp === null ? chp : { ...chp, ...piece.chp },
        pap: piece.pap,
      });
      cursor = stop;
    };
    for (
      let run = firstRunAfter(chpRuns, cursor);
      run < chpRuns.length && cursor < byteEnd;
      run += 1
    ) {
      const current = chpRuns[run];
      if (current === undefined || current.start >= byteEnd) break;
      if (current.start > cursor) emit(current.start, NO_CHAR);
      emit(current.end, current.props);
    }
    emit(byteEnd, NO_CHAR);
  }
  return out;
};
