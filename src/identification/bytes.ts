import type { FileHandle } from "node:fs/promises";
import type { Readable } from "node:stream";

import {
  FORMAT_SIGNATURE_PREFIX_BYTES,
  UDIF_TRAILER_BYTES,
} from "../domain/formatSignatures.js";

/** Leading bytes and, when the file is long enough, its UDIF-sized trailer. */
export interface ExaminedBytes {
  readonly prefix: Buffer;
  readonly trailer: Buffer | null;
  readonly size: number;
}

const readExactly = async (
  handle: FileHandle,
  offset: number,
  length: number,
): Promise<Buffer> => {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(
      buffer,
      filled,
      length - filled,
      offset + filled,
    );
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
};

/** Read what detection examines from an open regular file. */
export const examineHandle = async (
  handle: FileHandle,
): Promise<ExaminedBytes> => {
  const { size } = await handle.stat();
  const prefix = await readExactly(
    handle,
    0,
    Math.min(size, FORMAT_SIGNATURE_PREFIX_BYTES),
  );
  const trailer =
    size >= UDIF_TRAILER_BYTES
      ? await readExactly(handle, size - UDIF_TRAILER_BYTES, UDIF_TRAILER_BYTES)
      : null;
  return { prefix, trailer, size };
};

/** The first chunks of a member stream and the iterator positioned after them. */
export interface StreamHead {
  readonly chunks: readonly Buffer[];
  readonly prefix: Buffer;
  /** Bytes read so far; the whole member when `ended`. */
  readonly bytes: number;
  readonly ended: boolean;
  readonly rest: AsyncIterator<Buffer>;
}

/** Read at least the detection window from a member without buffering the rest. */
export const readStreamHead = async (stream: Readable): Promise<StreamHead> => {
  const rest = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  const chunks: Buffer[] = [];
  let bytes = 0;
  let ended = false;
  while (bytes < FORMAT_SIGNATURE_PREFIX_BYTES) {
    const next = await rest.next();
    if (next.done === true) {
      ended = true;
      break;
    }
    const chunk = Buffer.isBuffer(next.value)
      ? next.value
      : Buffer.from(next.value);
    chunks.push(chunk);
    bytes += chunk.length;
  }
  const joined = Buffer.concat(chunks);
  return {
    chunks,
    prefix: joined.subarray(0, FORMAT_SIGNATURE_PREFIX_BYTES),
    bytes,
    ended,
    rest,
  };
};
