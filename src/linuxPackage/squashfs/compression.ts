import { inflateSync, zstdDecompressSync } from "node:zlib";

import { SquashfsFormatError, SquashfsUnsupportedError } from "./format.js";
import { decodeLz4Block } from "./lz4.js";
import type { SquashfsCompression } from "./superblock.js";

/** Decompress one block into at most `limit` bytes; `offset` names the block in errors. */
export type Decompress = (
  input: Uint8Array,
  limit: number,
  offset: number,
) => Uint8Array;

const bounded =
  (decode: (input: Uint8Array, limit: number) => Uint8Array): Decompress =>
  (input, limit, offset) => {
    try {
      return decode(input, limit);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new SquashfsFormatError(
        offset,
        `The compressed block at ${String(offset)} does not decompress within ${String(limit)} bytes: ${reason}`,
      );
    }
  };

const DECODERS: Partial<Record<SquashfsCompression, Decompress>> = {
  // SquashFS "gzip" blocks are zlib streams (zlib header and Adler-32), as the kernel's zlib_inflate reads them.
  gzip: bounded((input, limit) =>
    inflateSync(input, { maxOutputLength: limit }),
  ),
  zstd: bounded((input, limit) =>
    zstdDecompressSync(input, { maxOutputLength: limit }),
  ),
  lz4: bounded(decodeLz4Block),
};

/** The in-process decoder for a compressor; lzma, lzo, xz and unknown ids are unsupported. */
export const decompressorFor = (
  compression: SquashfsCompression,
): Decompress => {
  const decode = DECODERS[compression];
  if (decode === undefined)
    throw new SquashfsUnsupportedError(
      `compression ${compression}`,
      `SquashFS compression ${compression} is not decoded in process; gzip, lz4 and zstd are.`,
    );
  return decode;
};
