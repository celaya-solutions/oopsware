import type { FileHandle } from "node:fs/promises";

import { ArtifactReaderFailure } from "../ArtifactReader.js";

/**
 * What the 7z signature header and the start of the next header reveal
 * without decompressing anything.
 */
export type SevenZipHeaderObservation =
  | { readonly kind: "empty" }
  | { readonly kind: "plain" }
  | { readonly kind: "encoded"; readonly coderIds: readonly string[] }
  | { readonly kind: "encrypted"; readonly coderIds: readonly string[] };

const SIGNATURE_HEADER_BYTES = 32;
/** The header folder's coder list sits within the first bytes of the next header. */
const NEXT_HEADER_PROBE_BYTES = 4096;
/** 7zAES coder: AES-256 with a SHA-256 key derivation. */
const AES_CODER_ID = "06f10701";

const K_END = 0x00;
const K_HEADER = 0x01;
const K_PACK_INFO = 0x06;
const K_UNPACK_INFO = 0x07;
const K_SIZE = 0x09;
const K_CRC = 0x0a;
const K_FOLDER = 0x0b;
const K_ENCODED_HEADER = 0x17;

/**
 * Read the 7z signature header and classify the next header. An encoded
 * header names its coders in plain bytes, so an AES coder there proves the
 * member names are encrypted before any decoder or password is involved.
 */
export const observeSevenZipHeader = async (
  handle: FileHandle,
  fileSize: number,
): Promise<SevenZipHeaderObservation> => {
  const start = Buffer.alloc(SIGNATURE_HEADER_BYTES);
  const read = await handle.read(start, 0, start.length, 0);
  if (read.bytesRead < SIGNATURE_HEADER_BYTES)
    throw malformed("signature header is truncated");
  const nextOffset = start.readBigUInt64LE(12);
  const nextSize = start.readBigUInt64LE(20);
  if (nextSize === 0n) return { kind: "empty" };
  const absolute = BigInt(SIGNATURE_HEADER_BYTES) + nextOffset;
  if (absolute + nextSize > BigInt(fileSize))
    throw malformed(
      "next header lies beyond the end of the file; a volume may be missing",
    );
  const probe = Buffer.alloc(
    Number(
      nextSize < BigInt(NEXT_HEADER_PROBE_BYTES)
        ? nextSize
        : BigInt(NEXT_HEADER_PROBE_BYTES),
    ),
  );
  const probed = await handle.read(probe, 0, probe.length, Number(absolute));
  const bytes = probe.subarray(0, probed.bytesRead);
  if (bytes[0] === K_HEADER) return { kind: "plain" };
  if (bytes[0] !== K_ENCODED_HEADER)
    throw malformed(
      `next header starts with unknown property ${String(bytes[0])}`,
    );
  const coderIds = encodedHeaderCoders(bytes);
  return coderIds.includes(AES_CODER_ID)
    ? { kind: "encrypted", coderIds }
    : { kind: "encoded", coderIds };
};

const malformed = (reason: string): ArtifactReaderFailure =>
  new ArtifactReaderFailure("format", `7z archive is malformed: ${reason}`);

/** Walk PackInfo and the first folder of UnpackInfo in an EncodedHeader. */
const encodedHeaderCoders = (bytes: Buffer): string[] => {
  const cursor = { offset: 1 };
  const byte = (): number => {
    const value = bytes[cursor.offset];
    if (value === undefined) throw malformed("encoded header is truncated");
    cursor.offset += 1;
    return value;
  };
  /** 7z variable-length UINT64: leading one bits count extra bytes. */
  const number = (): bigint => {
    const first = byte();
    let mask = 0x80;
    let value = 0n;
    for (let index = 0; index < 8; index += 1) {
      if ((first & mask) === 0) {
        const high = BigInt(first & (mask - 1));
        return value + (high << BigInt(8 * index));
      }
      value |= BigInt(byte()) << BigInt(8 * index);
      mask >>= 1;
    }
    return value;
  };
  const small = (): number => {
    const value = number();
    if (value > 64n) throw malformed("encoded header declares too many items");
    return Number(value);
  };
  if (byte() !== K_PACK_INFO)
    throw malformed("encoded header has no pack info");
  number();
  const packStreams = small();
  for (let id = byte(); id !== K_END; id = byte()) {
    if (id === K_SIZE)
      for (let index = 0; index < packStreams; index += 1) number();
    else if (id === K_CRC) {
      const allDefined = byte();
      if (allDefined === 0)
        throw malformed("encoded header CRC vector is unsupported");
      cursor.offset += 4 * packStreams;
    } else
      throw malformed(`encoded header pack info has property ${String(id)}`);
  }
  if (byte() !== K_UNPACK_INFO || byte() !== K_FOLDER)
    throw malformed("encoded header has no folder");
  const folders = small();
  if (byte() !== 0) throw malformed("encoded header folders are external");
  const ids: string[] = [];
  for (let folder = 0; folder < folders; folder += 1) {
    const coders = small();
    for (let coder = 0; coder < coders; coder += 1) {
      const flags = byte();
      const idSize = flags & 0x0f;
      ids.push(
        bytes.subarray(cursor.offset, cursor.offset + idSize).toString("hex"),
      );
      cursor.offset += idSize;
      if ((flags & 0x10) !== 0) {
        number();
        number();
      }
      if ((flags & 0x20) !== 0) cursor.offset += Number(number());
      if (cursor.offset > bytes.length)
        throw malformed("encoded header is truncated");
    }
    // Bind pairs and packed streams follow; only the first folder decodes the header.
    break;
  }
  return ids;
};
