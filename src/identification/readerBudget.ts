import type { WalkedPiece } from "../domain/identification/identification.js";
import type { ReaderRoute } from "../domain/identification/readerRoutes.js";

/** Pieces on disk kept per format in case the chosen one fails to read. */
const BACKLOG_PER_FORMAT = 2;

/**
 * Which pieces get a built-in reader: one per format within `max_readers`,
 * the root first. A read that fails or is never made gives its format back,
 * so another piece of that format may be read instead.
 */
export class ReaderBudget<P extends WalkedPiece> {
  readonly #limit: number;
  readonly #formats = new Set<string>();
  readonly #backlog = new Map<string, { piece: P; path: string }[]>();
  #chosen = 0;

  constructor(limit: number) {
    this.#limit = limit;
  }

  /** Null when the piece may be read now, else why it is not. */
  claim(piece: P, route: ReaderRoute): string | null {
    const key = keyOf(piece, route);
    if (this.#limit === 0) return "max_readers is 0.";
    if (this.#chosen >= this.#limit)
      return "The reader budget (max_readers) was used by earlier pieces.";
    if (this.#formats.has(key)) {
      if (piece.onDisk !== null) this.#keep(key, piece, piece.onDisk);
      return `Another ${piece.label ?? "piece of this format"} was read; run ${route.tool} on this one for its own facts.`;
    }
    this.#chosen += 1;
    this.#formats.add(key);
    return null;
  }

  /** A claimed read that never happened gives back its slot and its format. */
  release(piece: WalkedPiece, route: ReaderRoute): void {
    this.#chosen = Math.max(0, this.#chosen - 1);
    this.#formats.delete(keyOf(piece, route));
  }

  /** A read that failed keeps its slot but lets the format be tried again. */
  failed(piece: WalkedPiece, route: ReaderRoute): void {
    this.#formats.delete(keyOf(piece, route));
  }

  /** The next on-disk piece of a format whose read failed, if budget remains. */
  retry(key: string): { readonly piece: P; readonly path: string } | undefined {
    const next = this.#backlog.get(key)?.shift();
    if (next === undefined || this.#chosen >= this.#limit) return undefined;
    this.#chosen += 1;
    this.#formats.add(key);
    return next;
  }

  #keep(key: string, piece: P, path: string): void {
    const kept = this.#backlog.get(key) ?? [];
    if (kept.length < BACKLOG_PER_FORMAT) kept.push({ piece, path });
    this.#backlog.set(key, kept);
  }
}

/** One reader slot per format; a piece with no format shares its reader's slot. */
export const keyOf = (piece: WalkedPiece, route: ReaderRoute): string =>
  piece.format ?? route.tool;
