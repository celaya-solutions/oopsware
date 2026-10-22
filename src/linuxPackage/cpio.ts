import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import type { ByteSource } from "../artifacts/archives/ByteSource.js";
import type { RpmFileEntry } from "./rpm/facts.js";

export type CpioFormat = "newc" | "crc" | "stripped";

/**
 * One cpio member. A stripped (`07070X`) header carries only a file index:
 * its name, size and any mode, mtime, inode and link count come from the
 * caller's file list (the RPM header), the other numeric fields are null.
 * Hard links in newc keep their data on the last link only; earlier links
 * report size 0, exactly as stored.
 */
export interface CpioMember {
  readonly name: string | null;
  readonly rawNameHex: string;
  readonly format: CpioFormat;
  readonly fileIndex: number | null;
  readonly mode: number | null;
  readonly uid: number | null;
  readonly gid: number | null;
  readonly nlink: number | null;
  readonly mtime: number | null;
  readonly size: number;
  readonly devmajor: number | null;
  readonly devminor: number | null;
  readonly rdevmajor: number | null;
  readonly rdevminor: number | null;
  readonly inode: number | null;
  /** The crc format's sum of data bytes; null for newc and stripped. */
  readonly checksum: number | null;
  readonly headerOffset: number;
  readonly dataOffset: number;
}

/** A stripped member's facts from the RPM header's file list. */
export interface CpioStrippedFile {
  readonly path: string;
  /** Data bytes the payload stores for this member, which is not always the file size. */
  readonly size: number;
  readonly mode?: number;
  readonly mtime?: number;
  readonly inode?: number;
  readonly links?: number;
}

export type CpioStrippedLookup = (fileIndex: number) => CpioStrippedFile | null;

/** Bytes after the TRAILER!!! member, examined but not interpreted. */
export interface CpioEnd {
  readonly trailingBytes: number;
  readonly trailingNonZeroBytes: number;
}

const NEWC_HEADER_BYTES = 110;
const STRIPPED_HEADER_BYTES = 14;
const TRAILER = "TRAILER!!!";
/** Names longer than this are refused as a resource limit, not parsed. */
const MAXIMUM_NAME_BYTES = 1024 * 1024;
const FIELDS = [
  "inode",
  "mode",
  "uid",
  "gid",
  "nlink",
  "mtime",
  "size",
  "devmajor",
  "devminor",
  "rdevmajor",
  "rdevminor",
  "namesize",
  "check",
] as const;

type Field = (typeof FIELDS)[number];

const decoder = new TextDecoder("utf-8", { fatal: true });

const failure = (offset: number, message: string): ArtifactReaderFailure =>
  new ArtifactReaderFailure(
    "format",
    `cpio ${message} at offset ${String(offset)}`,
  );

const padding = (position: number): number => (4 - (position % 4)) % 4;

const parseHex = (text: string, offset: number, field: string): number => {
  if (!/^[0-9a-fA-F]{8}$/u.test(text))
    throw failure(
      offset,
      `header field ${field} ${JSON.stringify(text)} is not eight hexadecimal digits`,
    );
  return Number.parseInt(text, 16);
};

const magicProblem = (magic: Buffer): string => {
  const text = magic.toString("latin1");
  if (text === "070707")
    return "header uses the odc (070707) format, which RPM payloads never use and this reader does not read";
  if (magic[0] === 0xc7 && magic[1] === 0x71)
    return "header uses the old binary (big-endian) format, which this reader does not read";
  if (magic[0] === 0x71 && magic[1] === 0xc7)
    return "header uses the old binary (little-endian) format, which this reader does not read";
  return `header magic ${JSON.stringify(text)} is not 070701, 070702 or 07070X`;
};

/**
 * Sequential cpio parser for newc (`070701`), crc (`070702`) and rpm's
 * stripped (`07070X`) headers. Names must end in exactly one NUL; headers,
 * names and data are padded to 4 bytes from the archive start. Member data
 * stays in the source for the caller to stream or skip; a crc member's sum
 * is checked when its data is read in full.
 */
export class CpioStream {
  readonly #source: ByteSource;
  readonly #stripped: CpioStrippedLookup | undefined;
  #pendingData = 0;
  #pendingPadding = 0;
  #expectedChecksum: number | null = null;
  #sum = 0;
  #end: CpioEnd | undefined;

  /** `stripped` resolves 07070X file indexes; without it a stripped header fails. */
  constructor(source: ByteSource, stripped?: CpioStrippedLookup) {
    this.#source = source;
    this.#stripped = stripped;
  }

  /** The end observation, once `next` has returned null. */
  get end(): CpioEnd | undefined {
    return this.#end;
  }

  /** Bytes of the current member not yet read by `data`. */
  get remainingData(): number {
    return this.#pendingData;
  }

  /** Stream the current member's data; may be consumed at most once in full. */
  async *data(): AsyncGenerator<Buffer> {
    while (this.#pendingData > 0) {
      let produced = false;
      for await (const piece of this.#source.take(this.#pendingData)) {
        produced = true;
        this.#pendingData -= piece.length;
        if (this.#expectedChecksum !== null)
          for (const byte of piece) this.#sum = (this.#sum + byte) >>> 0;
        yield piece;
      }
      if (!produced && this.#pendingData > 0)
        throw failure(
          this.#source.position,
          "archive is truncated in member data",
        );
    }
    if (this.#expectedChecksum !== null) {
      const expected = this.#expectedChecksum;
      this.#expectedChecksum = null;
      if (this.#sum !== expected)
        throw new ArtifactReaderFailure(
          "integrity",
          `cpio crc member data sums to ${String(this.#sum)}, but its header declares ${String(expected)}, before offset ${String(this.#source.position)}`,
        );
    }
  }

  /** Advance to the next member, skipping any unread data of the current one. */
  async next(): Promise<CpioMember | null> {
    if (this.#end !== undefined) return null;
    await this.#skip(
      this.#pendingData + this.#pendingPadding,
      "member data or padding",
    );
    this.#pendingData = 0;
    this.#pendingPadding = 0;
    this.#expectedChecksum = null;
    this.#sum = 0;
    const headerOffset = this.#source.position;
    const magic = await this.#source.read(6);
    if (magic.length === 0)
      throw failure(headerOffset, "archive ends without a TRAILER!!! member");
    if (magic.length < 6)
      throw failure(headerOffset, "archive is truncated in a header");
    const text = magic.toString("latin1");
    if (text === "07070X") return this.#strippedMember(headerOffset);
    if (text !== "070701" && text !== "070702")
      throw failure(headerOffset, magicProblem(magic));
    const fields = await this.#fields(headerOffset);
    const name = await this.#name(headerOffset, fields.namesize);
    const decoded = decodeName(name);
    if (decoded === TRAILER) {
      await this.#skip(
        fields.size + padding(this.#source.position + fields.size),
        "trailer data",
      );
      this.#end = await this.#finish();
      return null;
    }
    const format = text === "070702" ? "crc" : "newc";
    this.#pendingData = fields.size;
    this.#pendingPadding = padding(this.#source.position + fields.size);
    if (format === "crc") this.#expectedChecksum = fields.check;
    return {
      name: decoded,
      rawNameHex: name.toString("hex"),
      format,
      fileIndex: null,
      mode: fields.mode,
      uid: fields.uid,
      gid: fields.gid,
      nlink: fields.nlink,
      mtime: fields.mtime,
      size: fields.size,
      devmajor: fields.devmajor,
      devminor: fields.devminor,
      rdevmajor: fields.rdevmajor,
      rdevminor: fields.rdevminor,
      inode: fields.inode,
      checksum: format === "crc" ? fields.check : null,
      headerOffset,
      dataOffset: this.#source.position,
    };
  }

  async #fields(headerOffset: number): Promise<Record<Field, number>> {
    const body = await this.#source.read(NEWC_HEADER_BYTES - 6);
    if (body.length < NEWC_HEADER_BYTES - 6)
      throw failure(headerOffset, "archive is truncated in a header");
    const text = body.toString("latin1");
    const fields = {} as Record<Field, number>;
    for (const [index, field] of FIELDS.entries())
      fields[field] = parseHex(
        text.slice(index * 8, index * 8 + 8),
        headerOffset + 6 + index * 8,
        field,
      );
    return fields;
  }

  async #name(headerOffset: number, size: number): Promise<Buffer> {
    if (size === 0)
      throw failure(
        headerOffset,
        "header has a zero name size; the name needs at least its NUL",
      );
    if (size > MAXIMUM_NAME_BYTES)
      throw new ArtifactReaderFailure(
        "limit",
        `cpio name at offset ${String(headerOffset)} declares ${String(size)} bytes, above the ${String(MAXIMUM_NAME_BYTES)}-byte name budget`,
      );
    const stored = await this.#source.read(size);
    if (stored.length < size)
      throw failure(headerOffset, "archive is truncated in a member name");
    if (stored[size - 1] !== 0)
      throw failure(headerOffset, "member name does not end with a NUL byte");
    const name = stored.subarray(0, size - 1);
    if (name.includes(0))
      throw failure(
        headerOffset,
        "member name contains a NUL byte before its end",
      );
    await this.#skip(padding(this.#source.position), "name padding");
    return name;
  }

  async #strippedMember(headerOffset: number): Promise<CpioMember> {
    const index = await this.#source.read(STRIPPED_HEADER_BYTES - 6);
    if (index.length < STRIPPED_HEADER_BYTES - 6)
      throw failure(headerOffset, "archive is truncated in a stripped header");
    const fileIndex = parseHex(
      index.toString("latin1"),
      headerOffset + 6,
      "file index",
    );
    await this.#skip(padding(this.#source.position), "stripped header padding");
    if (this.#stripped === undefined)
      throw failure(
        headerOffset,
        `stripped header (07070X) names file index ${String(fileIndex)}; reading it needs the RPM header's file list`,
      );
    const file = this.#stripped(fileIndex);
    if (file === null)
      throw failure(
        headerOffset,
        `stripped header names file index ${String(fileIndex)}, which the RPM header does not list`,
      );
    if (!Number.isSafeInteger(file.size) || file.size < 0)
      throw failure(
        headerOffset,
        `stripped member ${String(fileIndex)} has an invalid size from the RPM header`,
      );
    this.#pendingData = file.size;
    this.#pendingPadding = padding(this.#source.position + file.size);
    return {
      name: file.path,
      rawNameHex: Buffer.from(file.path, "utf8").toString("hex"),
      format: "stripped",
      fileIndex,
      mode: file.mode ?? null,
      uid: null,
      gid: null,
      nlink: file.links ?? null,
      mtime: file.mtime ?? null,
      size: file.size,
      devmajor: null,
      devminor: null,
      rdevmajor: null,
      rdevminor: null,
      inode: file.inode ?? null,
      checksum: null,
      headerOffset,
      dataOffset: this.#source.position,
    };
  }

  async #skip(length: number, what: string): Promise<void> {
    if (length === 0) return;
    const skipped = await this.#source.skip(length);
    if (skipped < length)
      throw failure(this.#source.position, `archive is truncated in ${what}`);
  }

  async #finish(): Promise<CpioEnd> {
    let trailingBytes = 0;
    let trailingNonZeroBytes = 0;
    for (;;) {
      const piece = await this.#source.read(64 * 1024);
      if (piece.length === 0) break;
      trailingBytes += piece.length;
      for (const byte of piece) if (byte !== 0) trailingNonZeroBytes += 1;
    }
    return { trailingBytes, trailingNonZeroBytes };
  }
}

const decodeName = (bytes: Buffer): string | null => {
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
};

/**
 * rpm's rule for what a stripped payload stores per header file (rpmfi.c
 * iterReadArchiveNext): a regular file's bytes travel with the last link
 * of its hard-link set (earlier links store none), a symlink stores its
 * target, everything else stores nothing. %ghost files are not in the
 * payload; an index naming one reads as zero bytes.
 */
export const rpmStrippedFiles = (
  files: readonly Pick<
    RpmFileEntry,
    "path" | "size" | "mode" | "mtime" | "flags" | "device" | "inode" | "links"
  >[],
): CpioStrippedLookup => {
  const regular = (file: (typeof files)[number]): boolean =>
    (file.mode & 0o170000) === 0o100000 && !file.flags.includes("ghost");
  const last = new Map<string, number>();
  for (const [index, file] of files.entries())
    if (regular(file) && file.inode > 0)
      last.set(`${String(file.device)}:${String(file.inode)}`, index);
  return (index) => {
    const file = files[index];
    if (file === undefined) return null;
    const type = file.mode & 0o170000;
    const key = `${String(file.device)}:${String(file.inode)}`;
    const size = regular(file)
      ? (last.get(key) ?? index) === index
        ? file.size
        : 0
      : type === 0o120000 && !file.flags.includes("ghost")
        ? file.size
        : 0;
    return {
      path: file.path,
      size,
      mode: file.mode,
      mtime: file.mtime,
      inode: file.inode,
      links: file.links,
    };
  };
};
