import type { OfficePackage } from "../../domain/officeDocument/officeDocument.js";
import { decodeCodepage } from "./codepage.js";

/**
 * [MS-OLEPS] property sets: the `\005SummaryInformation` and
 * `\005DocumentSummaryInformation` streams of a legacy Office file, mapped to
 * the same `core` / `app` / `custom` records the Open XML property parts give.
 * Every offset and count is checked against the stream before it is followed;
 * a property that cannot be read is a problem, never an exception.
 */

const MAX_SETS = 8;
const MAX_PROPERTIES = 10_000;
const MAX_VALUE = 2_000;
const MAX_VECTOR = 10_000;
export const MAX_CUSTOM = 200;

const SUMMARY = "f29f85e0-4ff9-1068-ab91-08002b27b3d9";
const DOCUMENT_SUMMARY = "d5cdd502-2e9c-101b-9397-08002b2cf9ae";
const USER_DEFINED = "d5cdd505-2e9c-101b-9397-08002b2cf9ae";

const CORE_BY_ID: ReadonlyMap<number, string> = new Map([
  [2, "title"],
  [3, "subject"],
  [4, "creator"],
  [5, "keywords"],
  [6, "description"],
  [8, "last_modified_by"],
  [9, "revision"],
  [11, "last_printed"],
  [12, "created"],
  [13, "modified"],
]);
const APP_BY_ID: ReadonlyMap<number, string> = new Map([
  [7, "Template"],
  [10, "TotalTime"],
  [14, "Pages"],
  [15, "Words"],
  [16, "Characters"],
  [18, "Application"],
  [19, "DocSecurity"],
]);
const DOC_CORE_BY_ID: ReadonlyMap<number, string> = new Map([
  [2, "category"],
  [27, "content_status"],
  [28, "language"],
  [29, "version"],
]);
const DOC_APP_BY_ID: ReadonlyMap<number, string> = new Map([
  [5, "Lines"],
  [6, "Paragraphs"],
  [7, "Slides"],
  [8, "Notes"],
  [9, "HiddenSlides"],
  [10, "MMClips"],
  [11, "ScaleCrop"],
  [13, "TitlesOfParts"],
  [14, "Manager"],
  [15, "Company"],
  [16, "LinksUpToDate"],
  [17, "CharactersWithSpaces"],
  [19, "SharedDoc"],
  [20, "HyperlinkBase"],
  [22, "HyperlinksChanged"],
  [23, "AppVersion"],
]);

interface Value {
  readonly type: string;
  readonly text: string;
  /** For a FILETIME: the raw 100-nanosecond count, which is a duration in some properties. */
  readonly ticks?: bigint;
}

export interface LegacyProperties {
  readonly core: Record<string, string>;
  readonly app: Record<string, string>;
  readonly custom: OfficePackage["properties"]["custom"];
  readonly customTotal: number;
  readonly problems: string[];
}

const guid = (view: DataView, at: number): string => {
  const hex = (offset: number, length: number): string => {
    let out = "";
    for (let i = 0; i < length; i += 1)
      out += view
        .getUint8(at + offset + i)
        .toString(16)
        .padStart(2, "0");
    return out;
  };
  const d1 = view.getUint32(at, true).toString(16).padStart(8, "0");
  const d2 = view
    .getUint16(at + 4, true)
    .toString(16)
    .padStart(4, "0");
  const d3 = view
    .getUint16(at + 6, true)
    .toString(16)
    .padStart(4, "0");
  return `${d1}-${d2}-${d3}-${hex(8, 2)}-${hex(10, 6)}`;
};

const truncate = (text: string): string =>
  text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE)}…` : text;

/** 100-nanosecond ticks since 1601-01-01 UTC, as an ISO 8601 instant; null when it is out of range. */
const filetime = (low: number, high: number): string | null => {
  const ticks = (BigInt(high) << 32n) | BigInt(low);
  if (ticks === 0n) return null;
  const millis = Number(ticks / 10_000n) - 11_644_473_600_000;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) || date.getUTCFullYear() > 9999
    ? null
    : date.toISOString();
};

/** A reader that never reads past the end of its section. */
class Section {
  /** A code page this reader has no decoder for, seen while reading a string. */
  unknownCodepage: number | null = null;

  constructor(
    readonly view: DataView,
    readonly bytes: Uint8Array,
    readonly start: number,
    readonly end: number,
  ) {}

  check(at: number, length: number): void {
    if (at < this.start || length < 0 || at + length > this.end)
      throw new RangeError("a value runs past the end of its property set");
  }
}

const readString = (
  section: Section,
  at: number,
  wide: boolean,
  codepage: number,
): { text: string; end: number } => {
  section.check(at, 4);
  const count = section.view.getUint32(at, true);
  // A UTF-16 set (code page 1200) stores even an LPSTR as UTF-16, its Size counting bytes.
  const utf16 = wide || codepage === 1200;
  const byteLength = wide ? count * 2 : count;
  if (byteLength > section.end - at)
    throw new RangeError("a string is too long");
  section.check(at + 4, byteLength);
  const body = section.bytes.subarray(at + 4, at + 4 + byteLength);
  let text: string;
  if (utf16) text = new TextDecoder("utf-16le").decode(body);
  else {
    const decoded = decodeCodepage(codepage, body);
    if (decoded === null) section.unknownCodepage = codepage;
    text = decoded ?? new TextDecoder("windows-1252").decode(body);
  }
  // The stored size counts a terminator and may include padding: the value ends at the first NUL.
  const nul = text.indexOf("\u0000");
  if (nul >= 0) text = text.slice(0, nul);
  // UTF-16 strings are padded to four bytes; code page strings are not, even inside a vector
  // (real files from Word and PowerPoint place the next element right after the terminator).
  return {
    text,
    end: utf16 ? at + Math.ceil((4 + byteLength) / 4) * 4 : at + 4 + byteLength,
  };
};

const scalar = (
  section: Section,
  type: number,
  at: number,
  codepage: number,
): { value: Value; end: number } => {
  const { view } = section;
  switch (type) {
    case 0:
    case 1:
      return { value: { type: "empty", text: "" }, end: at };
    case 2:
    case 0x12: {
      section.check(at, 2);
      const raw =
        type === 2 ? view.getInt16(at, true) : view.getUint16(at, true);
      return { value: { type: "i2", text: String(raw) }, end: at + 2 };
    }
    case 3:
    case 0x16: {
      section.check(at, 4);
      return {
        value: { type: "i4", text: String(view.getInt32(at, true)) },
        end: at + 4,
      };
    }
    case 0x13:
    case 0x17: {
      section.check(at, 4);
      return {
        value: { type: "ui4", text: String(view.getUint32(at, true)) },
        end: at + 4,
      };
    }
    case 4: {
      section.check(at, 4);
      return {
        value: { type: "r4", text: String(view.getFloat32(at, true)) },
        end: at + 4,
      };
    }
    case 5:
    case 7: {
      section.check(at, 8);
      return {
        value: {
          type: type === 5 ? "r8" : "date",
          text: String(view.getFloat64(at, true)),
        },
        end: at + 8,
      };
    }
    case 11: {
      section.check(at, 2);
      return {
        value: {
          type: "bool",
          text: view.getInt16(at, true) === 0 ? "false" : "true",
        },
        end: at + 2,
      };
    }
    case 0x10:
    case 0x11: {
      section.check(at, 1);
      return {
        value: {
          type: "i1",
          text: String(type === 0x10 ? view.getInt8(at) : view.getUint8(at)),
        },
        end: at + 1,
      };
    }
    case 0x14:
    case 0x15: {
      section.check(at, 8);
      return {
        value: {
          type: "i8",
          text: (type === 0x14
            ? view.getBigInt64(at, true)
            : view.getBigUint64(at, true)
          ).toString(),
        },
        end: at + 8,
      };
    }
    case 0x1e: {
      const read = readString(section, at, false, codepage);
      return { value: { type: "lpstr", text: read.text }, end: read.end };
    }
    case 0x1f: {
      const read = readString(section, at, true, codepage);
      return { value: { type: "lpwstr", text: read.text }, end: read.end };
    }
    case 0x40: {
      section.check(at, 8);
      const low = view.getUint32(at, true);
      const high = view.getUint32(at + 4, true);
      const ticks = (BigInt(high) << 32n) | BigInt(low);
      const stamp = filetime(low, high);
      return {
        value: {
          type: ticks === 0n ? "empty" : "filetime",
          text: ticks === 0n ? "" : (stamp ?? `${String(ticks)} ticks`),
          ticks,
        },
        end: at + 8,
      };
    }
    case 0x41: {
      section.check(at, 4);
      const size = view.getUint32(at, true);
      section.check(at + 4, size);
      return {
        value: { type: "blob", text: `(${String(size)} bytes)` },
        end: at + 4 + Math.ceil(size / 4) * 4,
      };
    }
    case 0x47: {
      section.check(at, 4);
      const size = view.getUint32(at, true);
      section.check(at + 4, size);
      return {
        value: { type: "clipboard", text: `(${String(size)} bytes)` },
        end: at + 4 + Math.ceil(size / 4) * 4,
      };
    }
    case 0x48: {
      section.check(at, 16);
      return { value: { type: "clsid", text: guid(view, at) }, end: at + 16 };
    }
    default:
      throw new RangeError(`unsupported property type 0x${type.toString(16)}`);
  }
};

const property = (
  section: Section,
  offset: number,
  codepage: number,
): Value => {
  section.check(offset, 4);
  const type = section.view.getUint16(offset, true);
  const at = offset + 4;
  if ((type & 0x1000) === 0) return scalar(section, type, at, codepage).value;
  // A vector: a count, then that many values of the base type (or variants).
  section.check(at, 4);
  const count = section.view.getUint32(at, true);
  if (count > MAX_VECTOR) throw new RangeError("a vector is too long");
  const base = type & 0x0fff;
  const list: string[] = [];
  let cursor = at + 4;
  for (let index = 0; index < count; index += 1) {
    if (base === 0x0c) {
      section.check(cursor, 4);
      const inner = section.view.getUint16(cursor, true);
      const read = scalar(section, inner, cursor + 4, codepage);
      list.push(read.value.text);
      cursor = read.end;
    } else {
      const read = scalar(section, base, cursor, codepage);
      list.push(read.value.text);
      cursor = read.end;
    }
  }
  return { type: "vector", text: list.join("; ") };
};

interface Parsed {
  readonly fmtid: string;
  readonly values: Map<number, Value>;
  readonly dictionary: Map<number, string>;
}

const parseSet = (
  view: DataView,
  bytes: Uint8Array,
  start: number,
  fmtid: string,
  problems: string[],
): Parsed => {
  const parsed: Parsed = { fmtid, values: new Map(), dictionary: new Map() };
  if (start + 8 > bytes.length) {
    problems.push(
      `The property set ${fmtid} starts past the end of its stream.`,
    );
    return parsed;
  }
  const size = view.getUint32(start, true);
  const end = Math.min(bytes.length, start + size);
  const count = view.getUint32(start + 4, true);
  if (count > MAX_PROPERTIES || start + 8 + count * 8 > end) {
    problems.push(
      `The property set ${fmtid} declares ${String(count)} properties, more than its ${String(size)} bytes can hold.`,
    );
    return parsed;
  }
  const section = new Section(view, bytes, start, end);
  const table: [number, number][] = [];
  for (let at = 0; at < count; at += 1)
    table.push([
      view.getUint32(start + 8 + at * 8, true),
      view.getUint32(start + 12 + at * 8, true),
    ]);
  // The code page comes first so every string can use it.
  let codepage = 1252;
  const codepageEntry = table.find(([id]) => id === 1);
  if (codepageEntry !== undefined) {
    try {
      const read = property(section, start + codepageEntry[1], 1252);
      const parsedPage = Number(read.text);
      if (Number.isInteger(parsedPage))
        codepage = parsedPage < 0 ? parsedPage + 65_536 : parsedPage;
    } catch {
      problems.push(
        `The code page of property set ${fmtid} could not be read; Windows-1252 is assumed.`,
      );
    }
  }
  for (const [id, offset] of table) {
    try {
      if (id === 1) continue;
      if (id === 0 && fmtid === USER_DEFINED) {
        let at = start + offset;
        section.check(at, 4);
        const entries = view.getUint32(at, true);
        at += 4;
        if (entries > MAX_PROPERTIES)
          throw new RangeError("the dictionary is too long");
        for (let entry = 0; entry < entries; entry += 1) {
          section.check(at, 8);
          const key = view.getUint32(at, true);
          const length = view.getUint32(at + 4, true);
          at += 8;
          const wide = codepage === 1200;
          const byteLength = wide ? length * 2 : length;
          section.check(at, byteLength);
          const raw = bytes.subarray(at, at + byteLength);
          const body = wide
            ? raw.subarray(0, raw.length - (raw.length >= 2 ? 2 : 0))
            : raw.subarray(0, raw.length - (raw.length >= 1 ? 1 : 0));
          const name = wide
            ? new TextDecoder("utf-16le").decode(body)
            : (decodeCodepage(codepage, body) ??
              new TextDecoder("windows-1252").decode(body));
          parsed.dictionary.set(key, name);
          at += byteLength;
          if (wide) at = start + Math.ceil((at - start) / 4) * 4;
        }
        continue;
      }
      parsed.values.set(id, property(section, start + offset, codepage));
    } catch (cause) {
      problems.push(
        `Property ${String(id)} of set ${fmtid} was not read: ${cause instanceof Error ? cause.message : String(cause)}.`,
      );
    }
  }
  if (section.unknownCodepage !== null)
    problems.push(
      `The property set ${fmtid} uses code page ${String(section.unknownCodepage)}, which this reader cannot decode; its text is read as Windows-1252 and may be wrong.`,
    );
  return parsed;
};

/** Map the sets of one or both property streams into the shared property records. */
export const readLegacyProperties = (
  summary: Uint8Array | undefined,
  documentSummary: Uint8Array | undefined,
): LegacyProperties => {
  const core: Record<string, string> = {};
  const app: Record<string, string> = {};
  const custom: OfficePackage["properties"]["custom"] = [];
  let customTotal = 0;
  const problems: string[] = [];

  for (const [label, bytes] of [
    ["SummaryInformation", summary],
    ["DocumentSummaryInformation", documentSummary],
  ] as const) {
    if (bytes === undefined) continue;
    if (bytes.length < 48) {
      problems.push(`The ${label} stream is too short to be a property set.`);
      continue;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint16(0, true) !== 0xfffe) {
      problems.push(
        `The ${label} stream does not start with the property set byte order mark.`,
      );
      continue;
    }
    const sets = view.getUint32(24, true);
    if (sets > MAX_SETS || 28 + sets * 20 > bytes.length) {
      problems.push(
        `The ${label} stream declares ${String(sets)} property sets.`,
      );
      continue;
    }
    for (let index = 0; index < sets; index += 1) {
      const base = 28 + index * 20;
      const fmtid = guid(view, base);
      const offset = view.getUint32(base + 16, true);
      if (offset >= bytes.length) {
        problems.push(
          `A property set of ${label} starts past the end of its stream.`,
        );
        continue;
      }
      const parsed = parseSet(view, bytes, offset, fmtid, problems);
      const put = (
        target: Record<string, string>,
        name: string,
        value: Value,
      ): void => {
        const text = value.text.trim();
        if (text !== "" && value.type !== "empty")
          target[name] = truncate(text);
      };
      if (fmtid === SUMMARY) {
        for (const [id, value] of parsed.values) {
          const coreName = CORE_BY_ID.get(id);
          if (coreName !== undefined) put(core, coreName, value);
          const appName = APP_BY_ID.get(id);
          // EditTime is a duration, not an instant: the OOXML TotalTime is in minutes.
          if (appName === "TotalTime")
            put(app, appName, {
              type: "text",
              text:
                value.ticks === undefined
                  ? ""
                  : String(value.ticks / 600_000_000n),
            });
          else if (appName !== undefined) put(app, appName, value);
        }
      } else if (fmtid === DOCUMENT_SUMMARY) {
        for (const [id, value] of parsed.values) {
          const coreName = DOC_CORE_BY_ID.get(id);
          if (coreName !== undefined) put(core, coreName, value);
          const appName = DOC_APP_BY_ID.get(id);
          if (appName === "AppVersion" && value.type === "i4") {
            const packed = Number(value.text);
            put(app, appName, {
              type: "text",
              text: `${String(packed >>> 16)}.${String(packed & 0xffff).padStart(4, "0")}`,
            });
          } else if (appName !== undefined) put(app, appName, value);
        }
      } else if (fmtid === USER_DEFINED) {
        for (const [id, value] of parsed.values) {
          const name = parsed.dictionary.get(id);
          if (name === undefined) continue;
          customTotal += 1;
          if (custom.length < MAX_CUSTOM)
            custom.push({
              name: truncate(name),
              type: value.type,
              value: truncate(value.text),
            });
        }
      }
    }
  }
  return { core, app, custom, customTotal, problems };
};
