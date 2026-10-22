import { FolderCursor } from "./cab/data.js";
import {
  CabFormatError,
  CabLimitError,
  type CabRead,
  type CabSource,
  CabUnsupportedError,
} from "./cab/format.js";
import {
  type CabFile,
  type CabFolder,
  type CabHeader,
  type CabLink,
  readCabHeader,
} from "./cab/header.js";

export {
  CabFormatError,
  CabLimitError,
  type CabRead,
  CabUnsupportedError,
  cabChecksum,
} from "./cab/format.js";
export type { CabFile, CabFolder, CabLink } from "./cab/header.js";

/**
 * A Microsoft Cabinet ([MS-CAB]) read by positional reads: header, folders
 * and files are parsed on open; file bytes are decoded on demand. Stored
 * and MSZIP folders decode in process; Quantum, LZX and files spanning
 * cabinets are listed only.
 */
export class Cabinet {
  readonly version: string;
  readonly declared_size: number;
  readonly set_id: number;
  readonly set_index: number;
  readonly reserve: CabHeader["reserve"];
  readonly previous: CabLink | null;
  readonly next: CabLink | null;
  readonly folders: readonly CabFolder[];
  readonly files: readonly CabFile[];
  readonly problems: readonly string[];
  readonly #source: CabSource;
  /** Where the last completed read stopped; a later read at or past it continues from there. */
  #cursor: FolderCursor | null = null;

  private constructor(header: CabHeader, source: CabSource) {
    this.version = header.version;
    this.declared_size = header.declared_size;
    this.set_id = header.set_id;
    this.set_index = header.set_index;
    this.reserve = header.reserve;
    this.previous = header.previous;
    this.next = header.next;
    this.folders = header.folders;
    this.files = header.files;
    this.problems = header.problems;
    this.#source = source;
  }

  /** Parse the header, folder and file tables of a cabinet of `size` bytes. */
  static async open(read: CabRead, size: number): Promise<Cabinet> {
    if (!Number.isSafeInteger(size) || size < 0)
      throw new RangeError(`Cabinet size ${String(size)} is not a byte count.`);
    const { header, source } = await readCabHeader(read, size);
    return new Cabinet(header, source);
  }

  /** Bytes a read of `file` decodes: the file alone when stored, the folder up to its end when MSZIP. */
  decodedBytes(file: CabFile): number {
    const folder = this.folders[file.folder];
    return folder?.compression === "none"
      ? file.size
      : file.folder_offset + file.size;
  }

  #own(file: CabFile): CabFolder {
    const own = this.files[file.index];
    if (
      own === undefined ||
      own.name !== file.name ||
      own.folder !== file.folder ||
      own.folder_offset !== file.folder_offset ||
      own.size !== file.size
    )
      throw new TypeError(
        `"${file.name}" is not file ${String(file.index)} of this cabinet.`,
      );
    if (file.continued !== "none") {
      const other =
        file.continued === "to-next"
          ? this.next
          : file.continued === "from-previous"
            ? this.previous
            : null;
      throw new CabUnsupportedError(
        "cabinet span",
        `"${file.name}" continues ${file.continued === "to-next" ? "into the next" : file.continued === "from-previous" ? "from the previous" : "across the previous and next"} cabinet${other === null ? "" : ` ("${other.cabinet}")`}; its bytes need that cabinet.`,
      );
    }
    const folder = this.folders[file.folder];
    if (folder === undefined)
      throw new CabFormatError(
        file.record_offset,
        `"${file.name}" names folder ${String(file.folder)}; the cabinet has ${String(this.folders.length)}.`,
      );
    if (folder.compression !== "none" && folder.compression !== "mszip")
      throw new CabUnsupportedError(
        `compression ${folder.compression}`,
        `Folder ${String(folder.index)} uses ${folder.compression}; only stored and MSZIP folders are decoded in process.`,
      );
    return folder;
  }

  /** A cursor for `folder` at or before `offset`: the cached one when it has not passed it. */
  #cursorFor(folder: CabFolder, offset: number): FolderCursor {
    const cached = this.#cursor;
    this.#cursor = null;
    if (
      cached?.context.folder === folder &&
      (cached.produced <= offset ||
        (cached.last?.bytes != null && cached.last.start <= offset))
    )
      return cached;
    return new FolderCursor({
      source: this.#source,
      folder,
      reserve: this.reserve?.data ?? 0,
      spansNext: this.next !== null && folder.index === this.folders.length - 1,
    });
  }

  /**
   * One file's bytes in order. `limit` bounds the bytes decoded (see
   * `decodedBytes`); CabLimitError is thrown before anything is read when
   * it is smaller. Quantum, LZX and spanned files are CabUnsupportedError.
   */
  async *read(
    file: CabFile,
    limit: number,
    signal?: AbortSignal,
  ): AsyncGenerator<Uint8Array> {
    const folder = this.#own(file);
    const needed = this.decodedBytes(file);
    if (!(needed <= limit))
      throw new CabLimitError(
        needed,
        limit,
        `Reading "${file.name}" decodes ${String(needed)} bytes; the limit is ${String(limit)}.`,
      );
    if (file.size === 0) return;
    const start = file.folder_offset;
    const end = start + file.size;
    const cursor = this.#cursorFor(folder, start);
    let completed = false;
    try {
      // A resumed cursor's last block may already hold the file's first bytes.
      let block = cursor.last?.bytes == null ? null : cursor.last;
      for (let at = start; at < end; block = null) {
        signal?.throwIfAborted();
        block ??= await cursor.next(start);
        if (block === null)
          throw new CabFormatError(
            folder.data_offset,
            `Folder ${String(folder.index)} ends after ${String(cursor.produced)} bytes; "${file.name}" needs bytes ${String(start)}..${String(end)}.`,
          );
        const blockEnd = block.start + block.length;
        if (block.bytes === null || blockEnd <= at) continue;
        const piece = block.bytes.subarray(
          at - block.start,
          Math.min(blockEnd, end) - block.start,
        );
        at += piece.length;
        yield piece;
      }
      completed = true;
    } finally {
      if (completed) this.#cursor = cursor;
    }
  }
}
