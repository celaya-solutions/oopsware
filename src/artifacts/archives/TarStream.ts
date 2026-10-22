import {
  hasValidTarChecksum,
  TAR_BLOCK_BYTES,
} from "../../domain/archiveStreamFormat.js";
import { ArtifactReaderFailure } from "../ArtifactReader.js";
import type { ByteSource } from "./ByteSource.js";

/** Tar header dialect observed from the magic field. */
export type TarProfile = "ustar" | "gnu" | "v7";

/** One tar member header after pax and GNU long-name records are applied. */
export interface TarMember {
  /** Exact member name; null when the stored bytes are not valid UTF-8. */
  readonly name: string | null;
  /** Hexadecimal stored name bytes, kept so undecodable names stay observable. */
  readonly rawNameHex: string;
  readonly typeflag: string;
  readonly size: number;
  readonly mode: number | null;
  /** Owner, group and time as stored (pax values win); null when absent or not numeric. */
  readonly uid: number | null;
  readonly gid: number | null;
  readonly uname: string | null;
  readonly gname: string | null;
  readonly mtime: number | null;
  readonly linkName: string | null;
  readonly profile: TarProfile;
  /** pax records (`x`) contributed to this member. */
  readonly pax: boolean;
  /** GNU (`S`) or pax (`GNU.sparse.*`) sparse-file encoding. */
  readonly sparse: boolean;
  readonly headerOffset: number;
  readonly dataOffset: number;
}

/** How the archive ended; anything short of two zero blocks is named. */
export interface TarEnd {
  readonly marker: "two-zero-blocks" | "one-zero-block" | "none";
  /** Bytes after the end marker, examined but not interpreted. */
  readonly trailingBytes: number;
  readonly trailingNonZeroBytes: number;
  readonly globalPaxHeaders: number;
}

/** Members whose data never follows the header, whatever the size field says. */
const NO_DATA_TYPES = new Set(["1", "2", "3", "4", "5", "6"]);

/** pax keys that carry the GNU sparse map. */
const SPARSE_PAX_KEY = /^GNU\.sparse\./u;

/** Bounded metadata records: pax headers and GNU long names. */
const MAXIMUM_METADATA_RECORD_BYTES = 1024 * 1024;

const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Sequential tar parser for ustar, pax, and GNU archives. It validates every
 * header checksum, applies pax and GNU long-name records, and leaves member
 * data in the source for the caller to stream or skip.
 */
export class TarStream {
  readonly #source: ByteSource;
  #pendingData = 0;
  #pendingPadding = 0;
  #end: TarEnd | undefined;
  #globalPaxHeaders = 0;

  constructor(source: ByteSource) {
    this.#source = source;
  }

  /** The end-of-archive observation, once `next` has returned null. */
  get end(): TarEnd | undefined {
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
        yield piece;
      }
      if (!produced && this.#pendingData > 0)
        throw truncated(this.#source.position, "member data");
    }
  }

  /** Advance to the next member, skipping any unread data of the current one. */
  async next(): Promise<TarMember | null> {
    if (this.#end !== undefined) return null;
    await this.#skipPending();
    let longName: Buffer | null = null;
    let longLink: Buffer | null = null;
    let pax: Map<string, Buffer> | null = null;
    for (;;) {
      const headerOffset = this.#source.position;
      const block = await this.#source.read(TAR_BLOCK_BYTES);
      if (block.length === 0) {
        if (longName !== null || longLink !== null || pax !== null)
          throw truncated(
            headerOffset,
            "member header after a metadata record",
          );
        this.#end = await this.#finish("none");
        return null;
      }
      if (block.length < TAR_BLOCK_BYTES)
        throw truncated(headerOffset, "header block");
      if (isZeroBlock(block)) {
        const second = await this.#source.read(TAR_BLOCK_BYTES);
        if (second.length === TAR_BLOCK_BYTES && isZeroBlock(second)) {
          this.#end = await this.#finish("two-zero-blocks");
          return null;
        }
        if (second.length === 0) {
          this.#end = await this.#finish("one-zero-block");
          return null;
        }
        throw new ArtifactReaderFailure(
          "format",
          `Tar archive has a lone zero block followed by data at offset ${String(headerOffset)}`,
        );
      }
      if (!hasValidTarChecksum(block))
        throw new ArtifactReaderFailure(
          "integrity",
          `Tar header checksum does not match its bytes at offset ${String(headerOffset)}`,
        );
      const typeflag =
        block[156] === 0 ? "0" : String.fromCharCode(block[156] ?? 0x30);
      const size = parseNumber(block, 124, 12, headerOffset, "size");
      const dataOffset = this.#source.position;
      if (
        typeflag === "L" ||
        typeflag === "K" ||
        typeflag === "x" ||
        typeflag === "g"
      ) {
        const record = await this.#readRecord(size, headerOffset, typeflag);
        if (typeflag === "L") longName = trimNul(record);
        else if (typeflag === "K") longLink = trimNul(record);
        else if (typeflag === "x") pax = parsePax(record, headerOffset);
        else this.#globalPaxHeaders += 1;
        continue;
      }
      const profile = tarProfile(block);
      const storedName =
        pax?.get("path") ??
        longName ??
        (profile === "ustar"
          ? joinUstarName(
              trimNul(block.subarray(345, 500)),
              trimNul(block.subarray(0, 100)),
            )
          : trimNul(block.subarray(0, 100)));
      const storedLink =
        pax?.get("linkpath") ?? longLink ?? trimNul(block.subarray(157, 257));
      const paxSize = pax?.get("size");
      const effectiveSize =
        paxSize === undefined
          ? size
          : parseDecimal(paxSize.toString("latin1"), headerOffset, "pax size");
      const sparse =
        typeflag === "S" ||
        [...(pax?.keys() ?? [])].some((key) => SPARSE_PAX_KEY.test(key));
      const dataBytes = NO_DATA_TYPES.has(typeflag) ? 0 : effectiveSize;
      this.#pendingData = dataBytes;
      this.#pendingPadding = padding(dataBytes);
      return {
        name: decodeName(storedName),
        rawNameHex: storedName.toString("hex"),
        typeflag,
        size: dataBytes,
        mode: parseOptionalNumber(block, 100, 8),
        uid: paxNumber(pax, "uid") ?? parseOptionalNumber(block, 108, 8),
        gid: paxNumber(pax, "gid") ?? parseOptionalNumber(block, 116, 8),
        uname: paxText(pax, "uname") ?? textField(block, 265, 32),
        gname: paxText(pax, "gname") ?? textField(block, 297, 32),
        mtime: paxNumber(pax, "mtime") ?? parseOptionalNumber(block, 136, 12),
        linkName: storedLink.length === 0 ? null : decodeName(storedLink),
        profile,
        pax: pax !== null,
        sparse,
        headerOffset,
        dataOffset,
      };
    }
  }

  async #skipPending(): Promise<void> {
    const wanted = this.#pendingData + this.#pendingPadding;
    if (wanted === 0) return;
    const skipped = await this.#source.skip(wanted);
    this.#pendingData = 0;
    this.#pendingPadding = 0;
    if (skipped < wanted)
      throw truncated(this.#source.position, "member data or padding");
  }

  async #readRecord(
    size: number,
    headerOffset: number,
    typeflag: string,
  ): Promise<Buffer> {
    if (size > MAXIMUM_METADATA_RECORD_BYTES)
      throw new ArtifactReaderFailure(
        "limit",
        `Tar ${typeflag} metadata record at offset ${String(headerOffset)} declares ${String(size)} bytes, above the ${String(MAXIMUM_METADATA_RECORD_BYTES)}-byte record budget`,
      );
    const record = await this.#source.read(size);
    const skipped = await this.#source.skip(padding(size));
    if (record.length < size || skipped < padding(size))
      throw truncated(headerOffset, `${typeflag} metadata record`);
    return record;
  }

  /** Examine bytes after the end marker without interpreting them. */
  async #finish(marker: TarEnd["marker"]): Promise<TarEnd> {
    let trailingBytes = 0;
    let trailingNonZeroBytes = 0;
    for (;;) {
      const piece = await this.#source.read(64 * 1024);
      if (piece.length === 0) break;
      trailingBytes += piece.length;
      for (const byte of piece) if (byte !== 0) trailingNonZeroBytes += 1;
    }
    return {
      marker,
      trailingBytes,
      trailingNonZeroBytes,
      globalPaxHeaders: this.#globalPaxHeaders,
    };
  }
}

/** A pax decimal value (`mtime` may carry a fraction, which is dropped); null when absent or malformed. */
const paxNumber = (
  pax: Map<string, Buffer> | null,
  key: string,
): number | null => {
  const value = pax?.get(key)?.toString("latin1");
  if (value === undefined || !/^\d+(?:\.\d+)?$/u.test(value)) return null;
  const whole = Number(value.split(".")[0]);
  return Number.isSafeInteger(whole) ? whole : null;
};

const paxText = (
  pax: Map<string, Buffer> | null,
  key: string,
): string | null => {
  const value = pax?.get(key);
  return value === undefined ? null : decodeName(value);
};

/** A NUL-terminated ustar text field such as uname; null when empty or not UTF-8. */
const textField = (
  block: Buffer,
  offset: number,
  length: number,
): string | null => {
  const value = trimNul(block.subarray(offset, offset + length));
  return value.length === 0 ? null : decodeName(value);
};

const truncated = (offset: number, what: string): ArtifactReaderFailure =>
  new ArtifactReaderFailure(
    "format",
    `Tar archive is truncated in its ${what} near offset ${String(offset)}`,
  );

const padding = (size: number): number =>
  (TAR_BLOCK_BYTES - (size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;

const isZeroBlock = (block: Buffer): boolean =>
  block.every((byte) => byte === 0);

const trimNul = (bytes: Buffer): Buffer => {
  const end = bytes.indexOf(0);
  return end < 0 ? bytes : bytes.subarray(0, end);
};

const tarProfile = (block: Buffer): TarProfile => {
  const magic = block.subarray(257, 265).toString("latin1");
  if (magic === "ustar  \0") return "gnu";
  if (magic.startsWith("ustar\0")) return "ustar";
  return "v7";
};

const joinUstarName = (prefix: Buffer, name: Buffer): Buffer =>
  prefix.length === 0 ? name : Buffer.concat([prefix, Buffer.from("/"), name]);

const decodeName = (bytes: Buffer): string | null => {
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
};

/** Octal, or GNU base-256 when the first byte has its high bit set. */
const parseNumber = (
  block: Buffer,
  offset: number,
  length: number,
  headerOffset: number,
  field: string,
): number => {
  const first = block[offset] ?? 0;
  if ((first & 0x80) !== 0) {
    if ((first & 0x40) !== 0)
      throw new ArtifactReaderFailure(
        "format",
        `Tar ${field} at offset ${String(headerOffset)} is a negative base-256 number`,
      );
    let value = first & 0x3f;
    for (let index = offset + 1; index < offset + length; index += 1) {
      value = value * 256 + (block[index] ?? 0);
      if (!Number.isSafeInteger(value))
        throw new ArtifactReaderFailure(
          "limit",
          `Tar ${field} at offset ${String(headerOffset)} exceeds the safe integer range`,
        );
    }
    return value;
  }
  const value = parseOptionalNumber(block, offset, length);
  if (value === null) {
    if (
      block
        .subarray(offset, offset + length)
        .every((byte) => byte === 0 || byte === 0x20)
    )
      return 0;
    throw new ArtifactReaderFailure(
      "format",
      `Tar ${field} at offset ${String(headerOffset)} is not an octal number`,
    );
  }
  return value;
};

const parseOptionalNumber = (
  block: Buffer,
  offset: number,
  length: number,
): number | null => {
  const text = block
    .subarray(offset, offset + length)
    .toString("latin1")
    .replace(/[\0 ]+$/u, "")
    .replace(/^ +/u, "");
  if (!/^[0-7]+$/u.test(text)) return null;
  const value = Number.parseInt(text, 8);
  return Number.isSafeInteger(value) ? value : null;
};

const parseDecimal = (
  text: string,
  headerOffset: number,
  field: string,
): number => {
  if (!/^[0-9]+$/u.test(text))
    throw new ArtifactReaderFailure(
      "format",
      `Tar ${field} at offset ${String(headerOffset)} is not a decimal number`,
    );
  const value = Number(text);
  if (!Number.isSafeInteger(value))
    throw new ArtifactReaderFailure(
      "limit",
      `Tar ${field} at offset ${String(headerOffset)} exceeds the safe integer range`,
    );
  return value;
};

/** Parse `length key=value\n` pax records, keeping values as raw bytes. */
const parsePax = (
  record: Buffer,
  headerOffset: number,
): Map<string, Buffer> => {
  const values = new Map<string, Buffer>();
  let cursor = 0;
  while (cursor < record.length) {
    if (record[cursor] === 0) break;
    const space = record.indexOf(0x20, cursor);
    const lengthText =
      space < 0 ? "" : record.subarray(cursor, space).toString("latin1");
    const length = /^[0-9]+$/u.test(lengthText)
      ? Number(lengthText)
      : Number.NaN;
    if (
      !Number.isSafeInteger(length) ||
      length <= space - cursor + 1 ||
      cursor + length > record.length ||
      record[cursor + length - 1] !== 0x0a
    )
      throw new ArtifactReaderFailure(
        "format",
        `Tar pax header at offset ${String(headerOffset)} has a malformed record`,
      );
    const body = record.subarray(space + 1, cursor + length - 1);
    const equals = body.indexOf(0x3d);
    if (equals <= 0)
      throw new ArtifactReaderFailure(
        "format",
        `Tar pax header at offset ${String(headerOffset)} has a record without a key`,
      );
    const key = body.subarray(0, equals).toString("utf8");
    const value = body.subarray(equals + 1);
    // POSIX: an empty value deletes the keyword, so the header field applies.
    if (value.length === 0) values.delete(key);
    else values.set(key, value);
    cursor += length;
  }
  return values;
};
