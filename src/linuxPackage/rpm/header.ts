import type { PositionalRead } from "../deb/ar.js";
import {
  HeaderParser,
  hex,
  INDEX_ENTRY_BYTES,
  parseIndex,
  view,
} from "./headerEntries.js";
import type { RpmHeaderKind } from "./tags.js";

export { rpmTagName, type RpmHeaderKind } from "./tags.js";

/** A structural problem at an exact byte offset of one RPM file. */
export class RpmFormatError extends Error {
  constructor(
    readonly offset: number,
    message: string,
  ) {
    super(message);
    this.name = "RpmFormatError";
  }
}

/** Numbers are unsigned, as rpm prints them; INT64 values are bigints. */
export type RpmValue =
  | { readonly type: "null" }
  | {
      readonly type: "char" | "int8" | "int16" | "int32";
      readonly values: readonly number[];
    }
  | { readonly type: "int64"; readonly values: readonly bigint[] }
  | {
      readonly type: "string" | "i18nstring" | "string_array";
      readonly values: readonly string[];
    }
  | { readonly type: "bin"; readonly bytes: Uint8Array };

/** The region a header's first index entry declares (rpm's immutable/signature region). */
export interface RpmRegion {
  readonly tag: number;
  readonly index_entries: number;
  readonly data_bytes: number;
}

export interface RpmHeader {
  readonly offset: number;
  readonly length: number;
  readonly entries: ReadonlyMap<number, RpmValue>;
  readonly problems: readonly string[];
  readonly index_count: number;
  readonly data_size: number;
  readonly region: RpmRegion | null;
  /**
   * String entries whose bytes are not valid UTF-8, kept as raw elements
   * and left out of `entries` so no replacement character ever stands in.
   */
  readonly undecodable: ReadonlyMap<number, readonly Uint8Array[]>;
}

export interface RpmLead {
  readonly major: number;
  readonly minor: number;
  readonly type: "binary" | "source" | number;
  readonly arch_number: number;
  readonly name: string;
  readonly os_number: number;
  readonly signature_type: number;
}

export interface RpmFile {
  readonly lead: RpmLead;
  readonly signature: RpmHeader;
  readonly header: RpmHeader;
  readonly payload_offset: number;
  /** Lead and layout problems that belong to neither header. */
  readonly problems: readonly string[];
}

export const RPM_LEAD_BYTES = 96;
const LEAD_MAGIC = [0xed, 0xab, 0xee, 0xdb];
/** rpm's header magic, including the four reserved zero bytes it hashes. */
export const RPM_HEADER_MAGIC = Uint8Array.of(
  0x8e,
  0xad,
  0xe8,
  0x01,
  0,
  0,
  0,
  0,
);
const RPMSIGTYPE_HEADERSIG = 5;
const utf8 = new TextDecoder("utf-8", { fatal: true });
/** rpm's hdrblobRead limits: signature headers are small, main headers are bounded. */
const LIMITS = {
  signature: { tags: 32, data: 64 * 1024 * 1024 },
  main: { tags: 0xffff, data: 0x0fffffff },
} as const;
const readExactly = async (
  read: PositionalRead,
  offset: number,
  length: number,
  what: string,
): Promise<Uint8Array> => {
  const bytes = length === 0 ? new Uint8Array(0) : await read(offset, length);
  if (bytes.length < length)
    throw new RpmFormatError(
      offset,
      `${what} needs ${String(length)} bytes at offset ${String(offset)} but only ${String(bytes.length)} were read.`,
    );
  return bytes.length === length ? bytes : bytes.subarray(0, length);
};

/**
 * Parse one header structure (magic, index count, data size, index, data
 * store) at `offset`. Structure that makes the rest unreadable throws;
 * a bad entry is a problem and is left out, so the other entries stay.
 */
export const readRpmHeader = async (
  read: PositionalRead,
  offset: number,
  size: number,
  kind: RpmHeaderKind,
): Promise<RpmHeader> => {
  if (size - offset < 16)
    throw new RpmFormatError(
      offset,
      `The ${kind} header is truncated before its 16-byte preamble.`,
    );
  const preamble = await readExactly(
    read,
    offset,
    16,
    `${kind} header preamble`,
  );
  if (
    !RPM_HEADER_MAGIC.subarray(0, 4).every(
      (byte, index) => preamble[index] === byte,
    )
  )
    throw new RpmFormatError(
      offset,
      `The ${kind} header does not start with the header magic 8eade801.`,
    );
  const preambleView = view(preamble);
  const il = preambleView.getUint32(8);
  const dl = preambleView.getUint32(12);
  const limit = LIMITS[kind];
  if (il > limit.tags)
    throw new RpmFormatError(
      offset + 8,
      `The ${kind} header declares ${String(il)} index entries; rpm accepts at most ${String(limit.tags)}.`,
    );
  if (dl > limit.data)
    throw new RpmFormatError(
      offset + 12,
      `The ${kind} header declares a ${String(dl)}-byte data store; rpm accepts at most ${String(limit.data)}.`,
    );
  const length = 16 + il * INDEX_ENTRY_BYTES + dl;
  if (length > size - offset)
    throw new RpmFormatError(
      offset + 8,
      `The ${kind} header declares ${String(il)} index entries and ${String(dl)} data bytes (${String(length)} bytes), but only ${String(size - offset)} bytes remain.`,
    );
  const body = await readExactly(
    read,
    offset + 16,
    length - 16,
    `${kind} header index and data`,
  );
  const index = parseIndex(body.subarray(0, il * INDEX_ENTRY_BYTES), il);
  const parser = new HeaderParser(kind, body.subarray(il * INDEX_ENTRY_BYTES));
  if (preamble.subarray(4, 8).some((byte) => byte !== 0))
    parser.problems.push(
      `${kind} header reserved bytes are ${hex(preamble.subarray(4, 8))}, not zero.`,
    );
  if (il === 0) parser.problems.push(`${kind} header has no index entries.`);
  const region = parser.readEntries(index, il);
  return {
    offset,
    length,
    entries: parser.entries,
    problems: parser.problems,
    index_count: il,
    data_size: dl,
    region,
    undecodable: parser.undecodable,
  };
};

const decodeLeadName = (bytes: Uint8Array, problems: string[]): string => {
  const nul = bytes.indexOf(0);
  if (nul < 0)
    problems.push("Lead name has no NUL terminator within its 66 bytes.");
  const stored = nul < 0 ? bytes : bytes.subarray(0, nul);
  try {
    return utf8.decode(stored);
  } catch {
    problems.push(
      `Lead name is not valid UTF-8 (bytes ${hex(stored, 66)}); the name is given as those hex bytes.`,
    );
    return hex(stored, 66);
  }
};

const readLead = async (
  read: PositionalRead,
  size: number,
  problems: string[],
): Promise<RpmLead> => {
  if (size < RPM_LEAD_BYTES)
    throw new RpmFormatError(
      0,
      `File is ${String(size)} bytes, shorter than the 96-byte RPM lead.`,
    );
  const lead = await readExactly(read, 0, RPM_LEAD_BYTES, "RPM lead");
  if (!LEAD_MAGIC.every((byte, index) => lead[index] === byte))
    throw new RpmFormatError(
      0,
      "File does not start with the RPM lead magic edabeedb.",
    );
  const leadView = view(lead);
  const major = lead[4] ?? 0;
  if (major < 3 || major > 4)
    throw new RpmFormatError(
      4,
      `RPM lead major version ${String(major)}; rpm reads versions 3 and 4 only.`,
    );
  const signatureType = leadView.getUint16(78);
  if (signatureType !== RPMSIGTYPE_HEADERSIG)
    throw new RpmFormatError(
      78,
      `RPM lead signature type ${String(signatureType)}; only header signatures (5) are defined.`,
    );
  const type = leadView.getUint16(6);
  return {
    major,
    minor: lead[5] ?? 0,
    type: type === 0 ? "binary" : type === 1 ? "source" : type,
    arch_number: leadView.getUint16(8),
    name: decodeLeadName(lead.subarray(10, 76), problems),
    os_number: leadView.getUint16(76),
    signature_type: signatureType,
  };
};

/**
 * Read an RPM package's lead, signature header (padded to 8 bytes) and main
 * header; the payload starts right after the main header. Nothing is
 * verified or decompressed here.
 */
export const readRpm = async (
  read: PositionalRead,
  size: number,
): Promise<RpmFile> => {
  const problems: string[] = [];
  const lead = await readLead(read, size, problems);
  const signature = await readRpmHeader(
    read,
    RPM_LEAD_BYTES,
    size,
    "signature",
  );
  const end = RPM_LEAD_BYTES + signature.length;
  const padding = (8 - (signature.length % 8)) % 8;
  if (padding > size - end)
    throw new RpmFormatError(
      end,
      "File ends inside the signature header padding.",
    );
  const pad = await readExactly(read, end, padding, "signature header padding");
  if (pad.some((byte) => byte !== 0))
    problems.push(`Signature header padding is ${hex(pad)}, not zero.`);
  const header = await readRpmHeader(read, end + padding, size, "main");
  return {
    lead,
    signature,
    header,
    payload_offset: header.offset + header.length,
    problems,
  };
};
