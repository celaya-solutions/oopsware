import { createHash } from "node:crypto";

import {
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipReader,
  type Entry,
} from "@zip.js/zip.js";

export const sha256Hex = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/** A member read failed for a reason the report states; the archive is still read. */
export class MemberReadFailure extends Error {
  constructor(
    readonly reason: "budget" | "size" | "encrypted" | "format" | "cancelled",
    message: string,
  ) {
    super(message);
    this.name = "MemberReadFailure";
  }
}

/** Decompressed bytes shared by every member read in one call. */
export class DecodeBudget {
  used = 0;
  constructor(
    readonly limit: number,
    /** Largest single member a family's real files need. */
    readonly memberLimit: number,
  ) {}

  claim(bytes: number, name: string): void {
    if (bytes > this.memberLimit)
      throw new MemberReadFailure(
        "size",
        `${name} declares ${String(bytes)} bytes, over the ${String(this.memberLimit)}-byte member limit.`,
      );
    if (this.used + bytes > this.limit)
      throw new MemberReadFailure(
        "budget",
        `Reading ${name} would pass the ${String(this.limit)}-byte decompression budget (max_decoded_bytes).`,
      );
    this.used += bytes;
  }
}

/** Read freshly: a signal can abort while a member decompresses. */
const aborted = (signal?: AbortSignal): boolean => signal?.aborted === true;

export interface ZipMember {
  readonly path: string;
  readonly directory: boolean;
  readonly bytes: number;
  readonly encrypted: boolean;
  /** Offset of the member's local file header and its stored (compressed) size. */
  readonly local_header_offset: number;
  readonly stored_bytes: number;
}

/** One in-memory ZIP (an outer archive or an embedded one). Member names are kept exactly. */
export class ZipView {
  readonly #reader: ZipReader<Uint8Array>;
  readonly #entries = new Map<string, Entry>();
  readonly members: ZipMember[] = [];
  readonly duplicates: string[] = [];

  private constructor(reader: ZipReader<Uint8Array>) {
    this.#reader = reader;
  }

  static async open(
    bytes: Uint8Array,
    maximumMembers = Number.POSITIVE_INFINITY,
  ): Promise<ZipView> {
    const reader = new ZipReader(new Uint8ArrayReader(bytes), {
      checkSignature: true,
      checkOverlappingEntry: true,
      filenameValidation: "tolerant",
      // java.util.zip and zipfile both read member names as UTF-8 here.
      filenameEncoding: "utf-8",
      useWebWorkers: false,
    });
    const view = new ZipView(reader);
    let count = 0;
    try {
      for await (const entry of reader.getEntriesGenerator()) {
        if (++count > maximumMembers)
          throw new MemberReadFailure(
            "budget",
            `ZIP contains more than ${String(maximumMembers)} members.`,
          );
        if (view.#entries.has(entry.filename)) {
          view.duplicates.push(entry.filename);
          continue;
        }
        view.#entries.set(entry.filename, entry);
        view.members.push({
          path: entry.filename,
          directory: entry.directory,
          bytes: entry.directory ? 0 : entry.uncompressedSize,
          encrypted: entry.encrypted,
          local_header_offset: entry.offset,
          stored_bytes: entry.compressedSize,
        });
      }
    } catch (cause) {
      await reader.close();
      throw cause;
    }
    return view;
  }

  has(path: string): boolean {
    return this.#entries.has(path);
  }

  /** Decompress one member inside the shared budget; the CRC is checked by the reader. */
  async read(
    path: string,
    budget: DecodeBudget,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const entry = this.#entries.get(path);
    if (entry === undefined || entry.directory)
      throw new MemberReadFailure("format", `${path} is not a file member.`);
    if (entry.encrypted)
      throw new MemberReadFailure("encrypted", `${path} is encrypted.`);
    if (signal?.aborted === true)
      throw new MemberReadFailure("cancelled", "The read was cancelled.");
    budget.claim(entry.uncompressedSize, path);
    try {
      const data = await entry.getData(new Uint8ArrayWriter(), {
        checkSignature: true,
        ...(signal === undefined ? {} : { signal }),
      });
      if (data.length !== entry.uncompressedSize)
        throw new MemberReadFailure(
          "format",
          `${path} decompressed to ${String(data.length)} bytes, not the declared ${String(entry.uncompressedSize)}.`,
        );
      return data;
    } catch (cause) {
      if (cause instanceof MemberReadFailure) throw cause;
      if (aborted(signal))
        throw new MemberReadFailure("cancelled", "The read was cancelled.");
      throw new MemberReadFailure(
        "format",
        `${path} could not be decompressed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  async close(): Promise<void> {
    await this.#reader.close();
  }
}
