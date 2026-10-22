import { constants, inflateSync } from "node:zlib";

import { DecodeBudget, MemberReadFailure } from "../artifacts/zipMemberView.js";
import { asInt, type PdfDict } from "./syntax.js";

/** Filters that end in image data this reader does not decode; the bytes stop there. */
const IMAGE_FILTERS = new Set([
  "DCTDecode",
  "DCT",
  "JPXDecode",
  "CCITTFaxDecode",
  "CCF",
  "JBIG2Decode",
]);

const ABBREVIATIONS: ReadonlyMap<string, string> = new Map([
  ["Fl", "FlateDecode"],
  ["AHx", "ASCIIHexDecode"],
  ["A85", "ASCII85Decode"],
  ["LZW", "LZWDecode"],
  ["RL", "RunLengthDecode"],
  ["DCT", "DCTDecode"],
  ["CCF", "CCITTFaxDecode"],
]);

export type StreamState =
  /** Every filter was applied. */
  | "complete"
  /** The Flate data ends early: the bytes decoded so far are kept, and are not the whole stream. */
  | "truncated"
  /** The chain ends in an image filter; the bytes are the still-encoded image. */
  | "image"
  /** A filter this reader does not implement (including Crypt) stopped the chain. */
  | "unsupported"
  /** A filter failed on these bytes. */
  | "damaged";

export interface DecodedStream {
  readonly bytes: Uint8Array;
  readonly filters: readonly string[];
  readonly state: StreamState;
  readonly note: string | null;
}

export const canonicalFilter = (value: string): string =>
  ABBREVIATIONS.get(value) ?? value;

const overBudget = (budget: DecodeBudget, label: string): MemberReadFailure =>
  new MemberReadFailure(
    "budget",
    `Decoding ${label} would pass the ${String(budget.limit)}-byte decompression budget (max_decoded_bytes).`,
  );

/** Bytes the next filter may still produce: what is left of the budget, and of the member limit. */
const room = (budget: DecodeBudget): number =>
  Math.max(0, Math.min(budget.limit - budget.used, budget.memberLimit));

/** A growing byte buffer that refuses to pass its limit, so a bomb stops before it allocates. */
class Sink {
  #bytes = new Uint8Array(1024);
  length = 0;

  constructor(
    readonly limit: number,
    readonly onFull: () => Error,
  ) {}

  #grow(extra: number): void {
    const needed = this.length + extra;
    if (needed > this.limit) throw this.onFull();
    if (needed <= this.#bytes.length) return;
    const next = new Uint8Array(
      Math.min(Math.max(needed, this.#bytes.length * 2), this.limit),
    );
    next.set(this.#bytes.subarray(0, this.length));
    this.#bytes = next;
  }

  push(byte: number): void {
    this.#grow(1);
    this.#bytes[this.length] = byte;
    this.length += 1;
  }

  fill(byte: number, count: number): void {
    this.#grow(count);
    this.#bytes.fill(byte, this.length, this.length + count);
    this.length += count;
  }

  /** Reserve `count` bytes and return the offset to write them at. */
  reserve(count: number): number {
    this.#grow(count);
    const at = this.length;
    this.length += count;
    return at;
  }

  write(at: number, byte: number): void {
    this.#bytes[at] = byte;
  }

  done(): Uint8Array {
    return this.#bytes.slice(0, this.length);
  }
}

const sinkFor = (budget: DecodeBudget, label: string): Sink =>
  new Sink(room(budget), () => overBudget(budget, label));

const flate = (
  data: Uint8Array,
  budget: DecodeBudget,
  label: string,
): { bytes: Uint8Array; truncated: boolean } => {
  const maxOutputLength = Math.max(1, room(budget));
  const inflate = (finishFlush: number) =>
    inflateSync(data, { maxOutputLength, finishFlush });
  let out: Uint8Array;
  let truncated = false;
  try {
    try {
      out = inflate(constants.Z_FINISH);
    } catch (cause) {
      // Z_FINISH refuses a cut-off stream; Z_SYNC_FLUSH keeps what decoded before the cut.
      if ((cause as { code?: string }).code !== "Z_BUF_ERROR") throw cause;
      out = inflate(constants.Z_SYNC_FLUSH);
      truncated = true;
    }
  } catch (cause) {
    if ((cause as { code?: string }).code === "ERR_BUFFER_TOO_LARGE")
      throw overBudget(budget, label);
    throw cause;
  }
  budget.claim(out.length, label);
  return { bytes: out, truncated };
};

/** The text filters build output element by element, so refuse input over the member limit first. */
const guardSize = (
  data: Uint8Array,
  budget: DecodeBudget,
  label: string,
): void => {
  if (data.length > budget.memberLimit)
    throw new MemberReadFailure(
      "size",
      `${label} holds ${String(data.length)} bytes of filter input, over the ${String(budget.memberLimit)}-byte member limit.`,
    );
};

const hexDigit = (code: number): number =>
  code >= 0x30 && code <= 0x39
    ? code - 0x30
    : code >= 0x41 && code <= 0x46
      ? code - 0x37
      : code >= 0x61 && code <= 0x66
        ? code - 0x57
        : -1;

const asciiHex = (
  data: Uint8Array,
  budget: DecodeBudget,
  label: string,
): Uint8Array => {
  const sink = sinkFor(budget, label);
  let high = -1;
  for (const code of data) {
    if (code === 0x3e) break;
    const value = hexDigit(code);
    if (value < 0) continue;
    if (high < 0) high = value;
    else {
      sink.push(high * 16 + value);
      high = -1;
    }
  }
  if (high >= 0) sink.push(high * 16);
  budget.claim(sink.length, label);
  return sink.done();
};

const ascii85 = (
  data: Uint8Array,
  budget: DecodeBudget,
  label: string,
): Uint8Array => {
  const sink = sinkFor(budget, label);
  const group: number[] = [];
  let at = 0;
  if (data[0] === 0x3c && data[1] === 0x7e) at = 2;
  const flush = (count: number) => {
    let value = 0;
    for (let index = 0; index < 5; index += 1)
      value = value * 85 + (index < count ? (group[index] as number) : 84);
    const bytes = [
      (value >>> 24) & 255,
      (value >>> 16) & 255,
      (value >>> 8) & 255,
      value & 255,
    ];
    for (let index = 0; index < count - 1; index += 1)
      sink.push(bytes[index] as number);
  };
  for (; at < data.length; at += 1) {
    const code = data[at] as number;
    if (code === 0x7e) break;
    if (code === 0x7a && group.length === 0) {
      sink.fill(0, 4);
      continue;
    }
    if (code < 0x21 || code > 0x75) continue;
    group.push(code - 0x21);
    if (group.length === 5) {
      flush(5);
      group.length = 0;
    }
  }
  if (group.length > 1) flush(group.length);
  budget.claim(sink.length, label);
  return sink.done();
};

const runLength = (
  data: Uint8Array,
  budget: DecodeBudget,
  label: string,
): Uint8Array => {
  const sink = sinkFor(budget, label);
  let at = 0;
  while (at < data.length) {
    const length = data[at] as number;
    at += 1;
    if (length === 128) break;
    if (length < 128) {
      const count = Math.min(length + 1, data.length - at);
      for (let index = 0; index < count; index += 1)
        sink.push(data[at + index] as number);
      at += count;
    } else {
      const value = data[at];
      at += 1;
      if (value === undefined) break;
      sink.fill(value, 257 - length);
    }
  }
  budget.claim(sink.length, label);
  return sink.done();
};

const LZW_CLEAR = 256;
const LZW_END = 257;
const LZW_FIRST_FREE = 258;
const LZW_MAX_CODES = 4096;

const lzwWidth = (next: number, early: number): number => {
  const size = next + early;
  return size >= 2048 ? 12 : size >= 1024 ? 11 : size >= 512 ? 10 : 9;
};

/** LZW with the table as prefix links: a clear code resets a counter, and expansion copies each byte once. */
const lzw = (
  data: Uint8Array,
  early: number,
  budget: DecodeBudget,
  label: string,
): Uint8Array => {
  const sink = sinkFor(budget, label);
  const prefix = new Int32Array(LZW_MAX_CODES);
  const suffix = new Uint8Array(LZW_MAX_CODES);
  const size = new Uint32Array(LZW_MAX_CODES);
  for (let code = 0; code < 256; code += 1) {
    suffix[code] = code;
    size[code] = 1;
  }
  let next = LZW_FIRST_FREE;
  let width = 9;
  let previous = -1;
  let buffer = 0;
  let bits = 0;
  const first = (code: number): number => {
    let at = code;
    while ((size[at] as number) > 1) at = prefix[at] as number;
    return suffix[at] as number;
  };
  const emit = (code: number): void => {
    const length = size[code] as number;
    const start = sink.reserve(length);
    let at = code;
    for (let index = length - 1; index >= 0; index -= 1) {
      sink.write(start + index, suffix[at] as number);
      at = prefix[at] as number;
    }
  };
  const define = (from: number, tail: number): void => {
    prefix[next] = from;
    suffix[next] = tail;
    size[next] = (size[from] as number) + 1;
    next += 1;
  };
  for (const byte of data) {
    buffer = ((buffer << 8) | byte) >>> 0;
    bits += 8;
    while (bits >= width) {
      const code = (buffer >>> (bits - width)) & ((1 << width) - 1);
      bits -= width;
      buffer &= (1 << bits) - 1;
      if (code === LZW_CLEAR) {
        next = LZW_FIRST_FREE;
        width = 9;
        previous = -1;
        continue;
      }
      if (code === LZW_END) {
        budget.claim(sink.length, label);
        return sink.done();
      }
      if (code < 256 || (code >= LZW_FIRST_FREE && code < next)) {
        emit(code);
        if (previous >= 0 && next < LZW_MAX_CODES)
          define(previous, first(code));
      } else if (code === next && previous >= 0 && next < LZW_MAX_CODES) {
        // The code being defined right now: the previous string plus its own first byte.
        define(previous, first(previous));
        emit(code);
      } else continue;
      previous = code;
      width = lzwWidth(next, early);
    }
  }
  budget.claim(sink.length, label);
  return sink.done();
};

const BITS_PER_COMPONENT = new Set([1, 2, 4, 8, 16]);

/** PNG (10 to 15) and TIFF (2) predictors; null when the parameters are not ones this reader applies. */
const unpredict = (
  data: Uint8Array,
  parms: PdfDict | null,
): Uint8Array | null => {
  const predictor = asInt(parms?.map.get("Predictor")) ?? 1;
  if (predictor === 1) return data;
  const colors = asInt(parms?.map.get("Colors")) ?? 1;
  const bpc = asInt(parms?.map.get("BitsPerComponent")) ?? 8;
  const columns = asInt(parms?.map.get("Columns")) ?? 1;
  if (
    colors < 1 ||
    colors > 32 ||
    columns < 1 ||
    columns > 1 << 24 ||
    !BITS_PER_COMPONENT.has(bpc)
  )
    return null;
  const rowBytes = Math.ceil((colors * bpc * columns) / 8);
  const pixel = Math.max(1, Math.ceil((colors * bpc) / 8));
  if (predictor === 2) {
    if (bpc !== 8) return null;
    const out = Uint8Array.from(data);
    for (let row = 0; row + rowBytes <= out.length; row += rowBytes)
      for (let at = row + pixel; at < row + rowBytes; at += 1)
        out[at] = ((out[at] as number) + (out[at - pixel] as number)) & 255;
    return out;
  }
  if (predictor < 10 || predictor > 15) return null;
  const rows = Math.floor(data.length / (rowBytes + 1));
  const out = new Uint8Array(rows * rowBytes);
  for (let row = 0; row < rows; row += 1) {
    const kind = data[row * (rowBytes + 1)] as number;
    const source = row * (rowBytes + 1) + 1;
    const target = row * rowBytes;
    for (let at = 0; at < rowBytes; at += 1) {
      const raw = data[source + at] as number;
      const left = at >= pixel ? (out[target + at - pixel] as number) : 0;
      const up = row > 0 ? (out[target - rowBytes + at] as number) : 0;
      const upLeft =
        row > 0 && at >= pixel
          ? (out[target - rowBytes + at - pixel] as number)
          : 0;
      let value: number;
      switch (kind) {
        case 1:
          value = raw + left;
          break;
        case 2:
          value = raw + up;
          break;
        case 3:
          value = raw + ((left + up) >> 1);
          break;
        case 4: {
          const estimate = left + up - upLeft;
          const toLeft = Math.abs(estimate - left);
          const toUp = Math.abs(estimate - up);
          const toUpLeft = Math.abs(estimate - upLeft);
          value =
            raw +
            (toLeft <= toUp && toLeft <= toUpLeft
              ? left
              : toUp <= toUpLeft
                ? up
                : upLeft);
          break;
        }
        default:
          value = raw;
      }
      out[target + at] = value & 255;
    }
  }
  return out;
};

const unsupportedPredictor = (
  decoded: Uint8Array,
  applied: string[],
): DecodedStream => ({
  bytes: decoded,
  filters: applied,
  state: "unsupported",
  note: "A predictor with parameters this reader does not apply.",
});

/**
 * Apply a stream's filter chain in order. `filters` and `parms` are already
 * resolved; a chain that reaches an image filter or an unsupported one stops
 * there and says so. Flate data that ends early keeps its decoded start and
 * the state is `truncated`.
 */
export const decodeFilters = (
  raw: Uint8Array,
  filters: readonly string[],
  parms: readonly (PdfDict | null)[],
  budget: DecodeBudget,
  label: string,
): DecodedStream => {
  let bytes = raw;
  const applied: string[] = [];
  let cut: string | null = null;
  for (let index = 0; index < filters.length; index += 1) {
    const filter = canonicalFilter(filters[index] as string);
    const options = parms[index] ?? null;
    applied.push(filter);
    if (IMAGE_FILTERS.has(filter))
      return { bytes, filters: applied, state: "image", note: null };
    try {
      switch (filter) {
        case "FlateDecode": {
          const inflated = flate(bytes, budget, label);
          if (inflated.truncated)
            cut = `The FlateDecode data ends early; ${String(inflated.bytes.length)} bytes decoded before the cut.`;
          const plain = unpredict(inflated.bytes, options);
          if (plain === null)
            return unsupportedPredictor(inflated.bytes, applied);
          bytes = plain;
          break;
        }
        case "LZWDecode": {
          const decoded = lzw(
            bytes,
            asInt(options?.map.get("EarlyChange")) ?? 1,
            budget,
            label,
          );
          const plain = unpredict(decoded, options);
          if (plain === null) return unsupportedPredictor(decoded, applied);
          bytes = plain;
          break;
        }
        case "ASCIIHexDecode":
          guardSize(bytes, budget, label);
          bytes = asciiHex(bytes, budget, label);
          break;
        case "ASCII85Decode":
          guardSize(bytes, budget, label);
          bytes = ascii85(bytes, budget, label);
          break;
        case "RunLengthDecode":
          guardSize(bytes, budget, label);
          bytes = runLength(bytes, budget, label);
          break;
        default:
          return {
            bytes,
            filters: applied,
            state: "unsupported",
            note: `The ${filter} filter is not implemented.`,
          };
      }
    } catch (cause) {
      if (cause instanceof MemberReadFailure) throw cause;
      return {
        bytes: new Uint8Array(0),
        filters: applied,
        state: "damaged",
        note: `The ${filter} data could not be decoded (${cause instanceof Error ? cause.message : String(cause)}).`,
      };
    }
  }
  return cut === null
    ? { bytes, filters: applied, state: "complete", note: null }
    : { bytes, filters: applied, state: "truncated", note: cut };
};
