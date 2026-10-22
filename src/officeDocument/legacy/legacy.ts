import type { DecodeBudget } from "../../artifacts/zipMemberView.js";
import type {
  OfficeExternalReference,
  OfficeNotable,
} from "../../domain/officeDocument/officeDocument.js";
import type { CfbEntry, CompoundFile } from "../../windowsInstaller/cfb.js";
import type { ReaderCounters } from "../reader.js";

/**
 * Legacy Office documents (format expansion F12, part 3): Word 97-2003 `.doc`,
 * Excel 97-2003 `.xls` and PowerPoint 97-2003 `.ppt`, stored as OLE compound
 * files. A reader gets the streams, a counter sink and a way to declare what it
 * finds beyond the text (embedded objects, macros, external references); it
 * returns the same `DocumentReader` the Open XML readers return.
 */

/** The file is a compound file of the right family but its content cannot be read as that format. */
export class LegacyFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LegacyFormatError";
  }
}

/** The document is encrypted or password-protected; nothing is decrypted and no password is tried. */
export class LegacyEncryptedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LegacyEncryptedError";
  }
}

/** Named streams of one compound file, every read charged to the call's decoding budget. */
export class LegacyStreams {
  readonly entries: readonly CfbEntry[];
  readonly #file: CompoundFile;
  readonly #budget: DecodeBudget;

  constructor(file: CompoundFile, budget: DecodeBudget) {
    this.#file = file;
    this.#budget = budget;
    this.entries = file.entries;
  }

  /** The stream or storage at this path; names compare ignoring case, as the format defines. */
  find(path: readonly string[]): CfbEntry | undefined {
    const wanted = path.map((name) => name.toUpperCase());
    return this.entries.find(
      (entry) =>
        entry.type !== "root" &&
        entry.path.length === wanted.length &&
        entry.path.every((name, at) => name.toUpperCase() === wanted[at]),
    );
  }

  /** Charge bytes a reader will produce itself (an inflated object, a joined buffer) to the decoding budget. */
  claim(bytes: number, name: string): void {
    this.#budget.claim(bytes, name);
  }

  /** A stream's bytes, charged to the decoding budget before they are read. */
  async read(entry: CfbEntry): Promise<Uint8Array> {
    this.#budget.claim(entry.size, entry.path.join("/"));
    return await this.#file.read(entry, entry.size);
  }

  /**
   * Byte ranges of one stream in a single pass, charged for those bytes only.
   * Each range is clipped to the stream, so a shorter result means it ran past
   * the end. For a large stream a reader needs a few pieces of.
   */
  async readRanges(
    entry: CfbEntry,
    ranges: readonly { offset: number; length: number }[],
  ): Promise<Uint8Array[]> {
    const clipped = ranges.map(({ offset, length }) => {
      const start = Math.min(Math.max(0, offset), entry.size);
      return { start, end: Math.min(entry.size, start + Math.max(0, length)) };
    });
    let total = 0;
    let last = 0;
    for (const range of clipped) {
      total += range.end - range.start;
      last = Math.max(last, range.end);
    }
    this.#budget.claim(total, entry.path.join("/"));
    const out = clipped.map((range) => new Uint8Array(range.end - range.start));
    const order = clipped
      .map((_, at) => at)
      .sort((a, b) => (clipped[a]?.start ?? 0) - (clipped[b]?.start ?? 0));
    let first = 0;
    let at = 0;
    for await (const chunk of this.#file.stream(entry)) {
      if (at >= last) break;
      const chunkEnd = at + chunk.length;
      for (let index = first; index < order.length; index += 1) {
        const which = order[index] ?? 0;
        const range = clipped[which];
        if (range === undefined || range.start >= chunkEnd) break;
        const from = Math.max(range.start, at);
        const to = Math.min(range.end, chunkEnd);
        if (to > from)
          out[which]?.set(
            chunk.subarray(from - at, to - at),
            from - range.start,
          );
      }
      at = chunkEnd;
      // Ranges are short; those ending before the next chunk are done.
      while (
        first < order.length &&
        (clipped[order[first] ?? 0]?.end ?? 0) <= at
      )
        first += 1;
    }
    return out;
  }
}

export interface LegacyReaderArgs {
  readonly streams: LegacyStreams;
  readonly counters: ReaderCounters;
  readonly signal: AbortSignal | undefined;
  /** Declare something notable the reader found inside a stream (an embedded object, a macro project). */
  readonly notable: (notable: OfficeNotable) => void;
  /** Declare a reference that points outside the document; it is listed, never followed. */
  readonly external: (reference: OfficeExternalReference) => void;
}

/**
 * Let the event loop run and honour a cancel. A reader is CPU-bound parsing in
 * memory, so without an occasional yield an abort signal can never be seen
 * while a hostile file is being read; call it every few thousand units of work.
 */
export const checkpoint = async (
  signal: AbortSignal | undefined,
): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
  signal?.throwIfAborted();
};
