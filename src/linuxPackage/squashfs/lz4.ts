/** A raw LZ4 block that cannot be decoded within its bounds. */
export class Lz4BlockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Lz4BlockError";
  }
}

/** A run length: the 4-bit field, extended by bytes while they are 255. */
const runLength = (
  input: Uint8Array,
  start: number,
  nibble: number,
): { length: number; next: number } => {
  let length = nibble;
  let at = start;
  if (nibble === 15)
    for (;;) {
      const byte = input[at];
      if (byte === undefined)
        throw new Lz4BlockError("The block ends inside a run length.");
      at += 1;
      length += byte;
      if (byte !== 255) break;
    }
  return { length, next: at };
};

/**
 * Decode one raw LZ4 block (no frame), as LZ4_decompress_safe does, into at
 * most `limit` bytes. SquashFS stores LZ4 and LZ4 HC output this way.
 */
export const decodeLz4Block = (
  input: Uint8Array,
  limit: number,
): Uint8Array => {
  const output = new Uint8Array(limit);
  let at = 0;
  let written = 0;
  for (;;) {
    const token = input[at];
    if (token === undefined)
      throw new Lz4BlockError("The block ends before its last literals.");
    const literals = runLength(input, at + 1, token >>> 4);
    at = literals.next;
    if (at + literals.length > input.length)
      throw new Lz4BlockError(
        `${String(literals.length)} literals run past the end of the block.`,
      );
    if (written + literals.length > limit)
      throw new Lz4BlockError(
        `The block decodes to more than ${String(limit)} bytes.`,
      );
    output.set(input.subarray(at, at + literals.length), written);
    at += literals.length;
    written += literals.length;
    // The last sequence is literals only and ends exactly at the end of the input.
    if (at === input.length) return output.subarray(0, written);
    if (at + 2 > input.length)
      throw new Lz4BlockError("The block ends inside a match offset.");
    const distance = (input[at] ?? 0) | ((input[at + 1] ?? 0) << 8);
    const match = runLength(input, at + 2, token & 0x0f);
    at = match.next;
    const length = match.length + 4;
    if (distance === 0 || distance > written)
      throw new Lz4BlockError(
        `Match offset ${String(distance)} reaches before the start of the output (${String(written)} bytes).`,
      );
    if (written + length > limit)
      throw new Lz4BlockError(
        `The block decodes to more than ${String(limit)} bytes.`,
      );
    if (distance >= length)
      output.copyWithin(
        written,
        written - distance,
        written - distance + length,
      );
    else
      for (let index = 0; index < length; index += 1)
        output[written + index] = output[written + index - distance] ?? 0;
    written += length;
  }
};
