import type { RpmRegion, RpmValue } from "./header.js";
import {
  RPM_SIGNATURE_TAG_TYPES,
  RPM_TAG_TYPES,
  RPM_VALUE_TYPES,
  rpmTagName,
  type RpmHeaderKind,
  type RpmValueType,
} from "./tags.js";

export const INDEX_ENTRY_BYTES = 16;
const REGION_TRAILER_BYTES = 16;
const BIN_TYPE = 7;
const I18N_TABLE_TAG = 100;
const REGION_TAGS = new Set([61, 62, 63]);
/** typeSizes/typeAlign of rpm's header.c, indexed by type number. */
const TYPE_SIZES = [0, 1, 1, 2, 4, 8, -1, 1, -1, -1];
const TYPE_ALIGN = [1, 1, 1, 2, 4, 8, 1, 1, 1, 1];

const utf8 = new TextDecoder("utf-8", { fatal: true });

export const view = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

export const hex = (bytes: Uint8Array, limit = 64): string =>
  Buffer.from(bytes.subarray(0, limit)).toString("hex") +
  (bytes.length > limit ? "…" : "");

/** Types rpm accepts in place of the declared one (legacy string kinds, char/int8). */
const compatible = (declared: RpmValueType, stored: RpmValueType): boolean =>
  declared === stored ||
  (declared === "i18nstring" && stored === "string") ||
  (declared === "string" && stored === "i18nstring") ||
  (declared === "string_array" && stored === "string") ||
  (declared === "char" && stored === "int8") ||
  (declared === "int8" && stored === "char");

export interface IndexEntry {
  readonly tag: number;
  readonly type: number;
  readonly offset: number;
  readonly count: number;
}

interface Decoded {
  readonly value: RpmValue | null;
  readonly raw: Uint8Array[] | null;
  readonly end: number;
}

export class HeaderParser {
  readonly problems: string[] = [];
  readonly entries = new Map<number, RpmValue>();
  readonly undecodable = new Map<number, readonly Uint8Array[]>();
  readonly #data: Uint8Array;
  readonly #view: DataView;

  constructor(
    readonly kind: RpmHeaderKind,
    data: Uint8Array,
  ) {
    this.#data = data;
    this.#view = view(data);
  }

  /** Nul-terminated string at `start`, or null when no terminator is in the store. */
  #string(start: number): { bytes: Uint8Array; end: number } | null {
    const nul = this.#data.indexOf(0, start);
    if (nul < 0) return null;
    return { bytes: this.#data.subarray(start, nul), end: nul + 1 };
  }

  #strings(entry: IndexEntry, label: string): Decoded | null {
    if (entry.type === 6 && entry.count !== 1) {
      this.problems.push(
        `${label}: STRING entry has count ${String(entry.count)}; rpm requires 1.`,
      );
      return null;
    }
    const raw: Uint8Array[] = [];
    let cursor = entry.offset;
    for (let index = 0; index < entry.count; index += 1) {
      const found = this.#string(cursor);
      if (found === null) {
        this.problems.push(
          `${label}: string ${String(index)} at data offset ${String(cursor)} has no NUL terminator inside the data store.`,
        );
        return null;
      }
      raw.push(found.bytes);
      cursor = found.end;
    }
    const values: string[] = [];
    for (const bytes of raw) {
      try {
        values.push(utf8.decode(bytes));
      } catch {
        this.problems.push(
          `${label}: string ${String(values.length)} is not valid UTF-8 (bytes ${hex(bytes)}); the raw bytes are kept instead of a decoded value.`,
        );
        return { value: null, raw, end: cursor };
      }
    }
    const type = RPM_VALUE_TYPES[entry.type] as
      | "string"
      | "string_array"
      | "i18nstring";
    return { value: { type, values }, raw: null, end: cursor };
  }

  #fixed(entry: IndexEntry, label: string): Decoded | null {
    const size = TYPE_SIZES[entry.type] ?? 0;
    const length = size * entry.count;
    if (length > this.#data.length - entry.offset) {
      this.problems.push(
        `${label}: ${String(entry.count)} × ${String(size)} bytes from data offset ${String(entry.offset)} run past the ${String(this.#data.length)}-byte data store.`,
      );
      return null;
    }
    const end = entry.offset + length;
    const type = RPM_VALUE_TYPES[entry.type] ?? "null";
    if (type === "bin")
      return {
        value: { type, bytes: this.#data.slice(entry.offset, end) },
        raw: null,
        end,
      };
    if (type === "int64") {
      const values: bigint[] = [];
      for (let at = entry.offset; at < end; at += 8)
        values.push(this.#view.getBigUint64(at));
      return { value: { type, values }, raw: null, end };
    }
    const values: number[] = [];
    for (let at = entry.offset; at < end; at += size)
      values.push(
        size === 1
          ? (this.#data[at] ?? 0)
          : size === 2
            ? this.#view.getUint16(at)
            : this.#view.getUint32(at),
      );
    return {
      value: { type: type as "char" | "int8" | "int16" | "int32", values },
      raw: null,
      end,
    };
  }

  /** Decode one entry, or record why it cannot be decoded. */
  decode(entry: IndexEntry): Decoded | null {
    const label = `${this.kind} header ${rpmTagName(entry.tag, this.kind)} (${String(entry.tag)})`;
    if (entry.type > 9) {
      this.problems.push(`${label}: unknown data type ${String(entry.type)}.`);
      return null;
    }
    if (entry.type === 0) {
      this.problems.push(
        `${label}: NULL data type, which rpm does not accept.`,
      );
      return { value: { type: "null" }, raw: null, end: entry.offset };
    }
    if (entry.count < 1 || entry.count > this.#data.length) {
      this.problems.push(
        `${label}: count ${String(entry.count)} is outside 1..${String(this.#data.length)}.`,
      );
      return null;
    }
    if (entry.offset >= this.#data.length) {
      this.problems.push(
        `${label}: data offset ${String(entry.offset)} is past the ${String(this.#data.length)}-byte data store.`,
      );
      return null;
    }
    if (entry.offset % (TYPE_ALIGN[entry.type] ?? 1) !== 0)
      this.problems.push(
        `${label}: data offset ${String(entry.offset)} is not aligned to ${String(TYPE_ALIGN[entry.type])} bytes.`,
      );
    return entry.type === 6 || entry.type === 8 || entry.type === 9
      ? this.#strings(entry, label)
      : this.#fixed(entry, label);
  }

  /** rpm's hdrblobVerifyRegion: first entry names a region whose trailer closes it. */
  region(first: IndexEntry | undefined, il: number): RpmRegion | null {
    const expected = this.kind === "signature" ? 62 : 63;
    if (first === undefined || !REGION_TAGS.has(first.tag)) {
      this.problems.push(
        `${this.kind} header has no region tag; rpm treats it as a legacy header.`,
      );
      return null;
    }
    const label = `${this.kind} header region ${rpmTagName(first.tag, this.kind)}`;
    if (first.tag !== expected && !(this.kind === "main" && first.tag === 61))
      this.problems.push(
        `${label}: a ${this.kind} header's region should be tag ${String(expected)}.`,
      );
    if (first.type !== BIN_TYPE || first.count !== REGION_TRAILER_BYTES) {
      this.problems.push(
        `${label}: type ${String(first.type)} count ${String(first.count)}, not BIN 16.`,
      );
      return null;
    }
    if (first.offset > this.#data.length - REGION_TRAILER_BYTES) {
      this.problems.push(
        `${label}: trailer at data offset ${String(first.offset)} is outside the data store.`,
      );
      return null;
    }
    const trailer = this.#data.slice(
      first.offset,
      first.offset + REGION_TRAILER_BYTES,
    );
    const trailerView = view(trailer);
    // Some old packages carry HEADERIMAGE in the signature trailer; rpm accepts it.
    const trailerTag = trailerView.getUint32(0);
    const negative = -trailerView.getInt32(8);
    const dataBytes = first.offset + REGION_TRAILER_BYTES;
    this.entries.set(first.tag, { type: "bin", bytes: trailer });
    if (
      !(trailerTag === first.tag || (first.tag === 62 && trailerTag === 61)) ||
      trailerView.getUint32(4) !== BIN_TYPE ||
      trailerView.getUint32(12) !== REGION_TRAILER_BYTES
    ) {
      this.problems.push(`${label}: trailer does not repeat the region tag.`);
      return null;
    }
    if (
      negative <= 0 ||
      negative % INDEX_ENTRY_BYTES !== 0 ||
      negative / INDEX_ENTRY_BYTES > il
    ) {
      this.problems.push(
        `${label}: trailer offset ${String(-negative)} does not name a whole number of index entries within ${String(il)}.`,
      );
      return null;
    }
    const indexEntries = negative / INDEX_ENTRY_BYTES;
    if (indexEntries !== il || dataBytes !== this.#data.length)
      this.problems.push(
        `${label}: covers ${String(indexEntries)} of ${String(il)} entries and ${String(dataBytes)} of ${String(this.#data.length)} data bytes; rpm requires a package header to be one region.`,
      );
    return {
      tag: first.tag,
      index_entries: indexEntries,
      data_bytes: dataBytes,
    };
  }

  /** Decode every entry after the region; each bad entry is a problem and is left out. */
  readEntries(index: readonly IndexEntry[], il: number): RpmRegion | null {
    const region = il === 0 ? null : this.region(index[0], il);
    // A leading region entry is the region's own, valid or not; it was reported above.
    const leading =
      index[0] !== undefined && REGION_TAGS.has(index[0].tag) ? 1 : 0;
    let previousEnd = 0;
    for (const entry of index.slice(leading)) {
      const label = `${this.kind} header ${rpmTagName(entry.tag, this.kind)} (${String(entry.tag)})`;
      if (entry.tag < I18N_TABLE_TAG) {
        this.problems.push(
          `${label}: tag numbers below 100 are reserved for regions.`,
        );
        continue;
      }
      if (this.entries.has(entry.tag) || this.undecodable.has(entry.tag)) {
        this.problems.push(
          `${label}: tag repeated in the index; the first entry is kept.`,
        );
        continue;
      }
      if (entry.offset < previousEnd)
        this.problems.push(
          `${label}: data at offset ${String(entry.offset)} overlaps the previous entry's data, which ends at ${String(previousEnd)}.`,
        );
      const decoded = this.decode(entry);
      if (decoded === null) continue;
      if (
        region !== null &&
        decoded.end > region.data_bytes - REGION_TRAILER_BYTES &&
        entry.offset < region.data_bytes
      )
        this.problems.push(`${label}: data overlaps the region trailer.`);
      previousEnd = Math.max(previousEnd, decoded.end);
      this.typeCheck(entry);
      if (decoded.raw !== null) this.undecodable.set(entry.tag, decoded.raw);
      else if (decoded.value !== null)
        this.entries.set(entry.tag, decoded.value);
    }
    return region;
  }

  typeCheck(entry: IndexEntry): void {
    const declared = (
      this.kind === "signature" ? RPM_SIGNATURE_TAG_TYPES : RPM_TAG_TYPES
    ).get(entry.tag);
    const stored = RPM_VALUE_TYPES[entry.type];
    if (
      declared !== undefined &&
      stored !== undefined &&
      !compatible(declared, stored)
    )
      this.problems.push(
        `${this.kind} header ${rpmTagName(entry.tag, this.kind)} (${String(entry.tag)}): stored as ${stored}, rpmtag.h declares ${declared}.`,
      );
  }
}

export const parseIndex = (index: Uint8Array, il: number): IndexEntry[] => {
  const indexView = view(index);
  const entries: IndexEntry[] = [];
  for (let at = 0; at < il * INDEX_ENTRY_BYTES; at += INDEX_ENTRY_BYTES)
    entries.push({
      tag: indexView.getUint32(at),
      type: indexView.getUint32(at + 4),
      offset: indexView.getUint32(at + 8),
      count: indexView.getUint32(at + 12),
    });
  return entries;
};
