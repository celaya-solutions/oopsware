import {
  CfbFormatError,
  ENDOFCHAIN,
  MINI_SECTOR,
  type CfbEntry,
  type CfbRead,
} from "./cfbFormat.js";
import {
  CfbLayout,
  type Location,
  type ParsedCompoundFile,
} from "./cfbLayout.js";

export {
  CfbFormatError,
  formatGuid,
  type CfbEntry,
  type CfbRead,
} from "./cfbFormat.js";

/**
 * [MS-CFB] compound files (the container of MSI databases): header, DIFAT,
 * FAT, miniFAT, the red-black directory tree and stream reading. Every
 * sector number, chain, count and size is checked before it is followed or
 * allocated (cfbLayout.ts); chains are cycle-checked and every sector may
 * belong to one structure only. Problems that leave the rest readable are
 * reported; a stream whose chain is broken throws when it is read.
 */

/** Bytes per read when streaming. */
const CHUNK = 1 << 20;

export class CompoundFile {
  readonly version: 3 | 4;
  readonly sectorSize: number;
  /** The root, then every storage and stream in tree (name) order, depth first. */
  readonly entries: readonly CfbEntry[];
  readonly problems: readonly string[];
  readonly #read: CfbRead;
  readonly #size: number;
  readonly #parsed: ParsedCompoundFile;

  private constructor(read: CfbRead, size: number, parsed: ParsedCompoundFile) {
    this.#read = read;
    this.#size = size;
    this.#parsed = parsed;
    this.version = parsed.version;
    this.sectorSize = parsed.sectorSize;
    this.entries = parsed.entries;
    this.problems = parsed.problems;
  }

  static async open(read: CfbRead, size: number): Promise<CompoundFile> {
    return new CompoundFile(
      read,
      size,
      await new CfbLayout(read, size).parse(),
    );
  }

  /** The first min(size, limit) bytes of a stream (or of the root's mini stream). */
  async read(entry: CfbEntry, limit: number): Promise<Uint8Array> {
    const length = Math.max(0, Math.min(entry.size, Math.floor(limit)));
    const out = new Uint8Array(length);
    let at = 0;
    for await (const chunk of this.#chunks(entry, length)) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  }

  /** Every byte of a stream, in order, at most 1 MiB at a time. */
  stream(entry: CfbEntry): AsyncIterable<Uint8Array> {
    return this.#chunks(entry, entry.size);
  }

  async *#chunks(entry: CfbEntry, length: number): AsyncGenerator<Uint8Array> {
    const location: Location | undefined = this.#parsed.locations.get(entry);
    if (location === undefined)
      throw new CfbFormatError(
        0,
        `Entry ${String(entry.id)} does not belong to this compound file.`,
      );
    if (location.kind === "broken")
      throw new CfbFormatError(location.offset, location.reason);
    if (location.kind === "none" || length === 0) return;
    for (const [offset, bytes] of this.#runs(location, length))
      for (let done = 0; done < bytes; done += CHUNK)
        yield await this.#readExactly(
          offset + done,
          Math.min(CHUNK, bytes - done),
          entry,
        );
  }

  /** File (offset, length) runs holding the first `length` bytes, adjacent sectors merged. */
  #runs(
    location: { kind: "regular" | "mini"; start: number },
    length: number,
  ): [number, number][] {
    const mini = location.kind === "mini";
    const unit = mini ? MINI_SECTOR : this.sectorSize;
    const table = mini ? this.#parsed.miniFat : this.#parsed.fat;
    const runs: [number, number][] = [];
    let sector = location.start;
    for (let done = 0; done < length; done += unit) {
      const offset = mini
        ? this.#miniOffset(sector)
        : (sector + 1) * this.sectorSize;
      const bytes = Math.min(unit, length - done);
      const last = runs.at(-1);
      if (last !== undefined && last[0] + last[1] === offset) last[1] += bytes;
      else runs.push([offset, bytes]);
      sector = table[sector] ?? ENDOFCHAIN;
    }
    return runs;
  }

  #miniOffset(miniSector: number): number {
    const position = miniSector * MINI_SECTOR;
    const host =
      this.#parsed.miniStream[Math.floor(position / this.sectorSize)] ?? 0;
    return (host + 1) * this.sectorSize + (position % this.sectorSize);
  }

  async #readExactly(
    offset: number,
    length: number,
    entry: CfbEntry,
  ): Promise<Uint8Array> {
    const bytes =
      offset + length <= this.#size
        ? await this.#read(offset, length)
        : new Uint8Array(0);
    if (bytes.length < length)
      throw new CfbFormatError(
        offset,
        `Stream ${String(entry.id)} ${JSON.stringify(entry.name)} needs ${String(length)} bytes at offset ${String(offset)}, past the end of the ${String(this.#size)}-byte file.`,
      );
    return bytes.length === length ? bytes : bytes.subarray(0, length);
  }
}
