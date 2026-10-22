import { formatGuid } from "../cfb.js";
import type { CodepageDecoder } from "./codepage.js";

/**
 * [MS-OLEPS] property set streams: a header (byte order 0xFFFE, format
 * version, system identifier, CLSID, set count), then (FMTID, offset) per
 * set; a section is its size, property count, (ID, offset) pairs and typed
 * values (a VT word, two padding bytes, the value). Only the first set is
 * read, as Windows Installer writes one.
 */

/** One stored property: its VT name and value (FILETIME as ISO 8601 UTC). */
export interface StoredProperty {
  readonly id: number;
  readonly vt: string;
  readonly value: string | number | null;
}

export const VT_NAMES: Readonly<Record<number, string>> = {
  0: "VT_EMPTY",
  1: "VT_NULL",
  2: "VT_I2",
  3: "VT_I4",
  11: "VT_BOOL",
  19: "VT_UI4",
  20: "VT_I8",
  30: "VT_LPSTR",
  31: "VT_LPWSTR",
  64: "VT_FILETIME",
  65: "VT_BLOB",
  71: "VT_CF",
};

export const vtName = (vt: number): string =>
  VT_NAMES[vt] ?? `VT_${String(vt)}`;

/** 100-ns intervals between 1601-01-01 and 1970-01-01. */
const FILETIME_EPOCH = 116_444_736_000_000_000n;
const MAX_PROPERTIES = 1024;

const view = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** A FILETIME as ISO 8601 UTC, or null when it is zero or outside Date's range. */
export const filetimeToIso = (low: number, high: number): string | null => {
  const ticks = (BigInt(high) << 32n) | BigInt(low);
  if (ticks === 0n) return null;
  const date = new Date(Number((ticks - FILETIME_EPOCH) / 10_000n));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

export interface Section {
  readonly fmtid: string | null;
  /** The size the section declares, which may exceed what the stream holds. */
  readonly declared: number;
  /** The section bytes, cut to what the stream holds. */
  readonly body: Uint8Array;
  /** (property ID, value offset in the section) in stored order. */
  readonly entries: readonly (readonly [number, number])[];
}

/** The first property set's section, or a problem saying why there is none. */
export const firstSection = (bytes: Uint8Array): Section | string => {
  if (bytes.length < 48)
    return `the stream is ${String(bytes.length)} bytes, shorter than a property set header`;
  const data = view(bytes);
  if (data.getUint16(0, true) !== 0xfffe)
    return "it does not start with byte order mark 0xfffe";
  if (data.getUint32(24, true) < 1) return "it holds no property set";
  const at = data.getUint32(44, true);
  if (at + 8 > bytes.length)
    return `its section offset ${String(at)} is past its ${String(bytes.length)} bytes`;
  const declared = data.getUint32(at, true);
  const size = Math.min(declared, bytes.length - at);
  const count = data.getUint32(at + 4, true);
  if (count > MAX_PROPERTIES || 8 + count * 8 > size)
    return `its section declares ${String(count)} properties, more than its ${String(size)} bytes hold`;
  const body = bytes.subarray(at, at + size);
  const section = view(body);
  return {
    fmtid: formatGuid(bytes, 28),
    declared,
    body,
    entries: Array.from(
      { length: count },
      (_, index) =>
        [
          section.getUint32(8 + index * 8, true),
          section.getUint32(12 + index * 8, true),
        ] as const,
    ),
  };
};

type Reader = (
  data: DataView,
  at: number,
  decoder: CodepageDecoder,
) => string | number | null | { readonly cut: string };

const fixed =
  (
    bytes: number,
    read: (data: DataView, at: number) => string | number | null,
  ): Reader =>
  (data, at) =>
    at + bytes <= data.byteLength
      ? read(data, at)
      : { cut: `its ${String(bytes)}-byte value is cut off` };

const READERS: Readonly<Record<number, Reader>> = {
  0: () => null,
  1: () => null,
  2: fixed(2, (data, at) => data.getInt16(at, true)),
  3: fixed(4, (data, at) => data.getInt32(at, true)),
  11: fixed(2, (data, at) => (data.getInt16(at, true) === 0 ? 0 : 1)),
  19: fixed(4, (data, at) => data.getUint32(at, true)),
  64: fixed(8, (data, at) =>
    filetimeToIso(data.getUint32(at, true), data.getUint32(at + 4, true)),
  ),
  30: (data, at, decoder) => {
    if (at + 4 > data.byteLength)
      return { cut: "its VT_LPSTR length is cut off" };
    const length = data.getUint32(at, true);
    if (at + 4 + length > data.byteLength)
      return {
        cut: `its ${String(length)}-byte VT_LPSTR runs past the section`,
      };
    const raw = new Uint8Array(data.buffer, data.byteOffset + at + 4, length);
    const nul = raw.indexOf(0);
    return decoder.decode(nul < 0 ? raw : raw.subarray(0, nul));
  },
  31: (data, at) => {
    if (at + 4 > data.byteLength)
      return { cut: "its VT_LPWSTR length is cut off" };
    const units = data.getUint32(at, true);
    if (units > (data.byteLength - at - 4) / 2)
      return {
        cut: `its ${String(units)}-character VT_LPWSTR runs past the section`,
      };
    let text = "";
    for (let index = 0; index < units; index += 1) {
      const unit = data.getUint16(at + 4 + index * 2, true);
      if (unit === 0) break;
      text += String.fromCharCode(unit);
    }
    return text;
  },
};

/** One typed value at `offset` in the section; types without a reader keep their VT and a null value. */
export const readValue = (
  body: Uint8Array,
  offset: number,
  decoder: CodepageDecoder,
): { vt: number; value: string | number | null } | string => {
  if (offset + 4 > body.length)
    return `its value offset ${String(offset)} is past the section`;
  const data = view(body);
  const vt = data.getUint16(offset, true);
  const value = READERS[vt]?.(data, offset + 4, decoder) ?? null;
  return value !== null && typeof value === "object"
    ? value.cut
    : { vt, value };
};
