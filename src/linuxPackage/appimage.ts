import { elfHeader } from "../jvm/jarMetadata.js";

/**
 * The ELF runtime at the front of an AppImage, read from its headers only:
 * the AppImage magic, where the runtime says its payload starts, and the
 * AppImage-specific sections. The runtime is never executed.
 */

/** Positional read of the file: bytes [offset, offset+length). */
export type AppImageRead = (
  offset: number,
  length: number,
) => Promise<Uint8Array>;

export interface AppImageSection {
  readonly name: string;
  readonly offset: number;
  readonly size: number;
}

export interface AppImageRuntime {
  /** Magic "AI" + 0x01/0x02 at ELF offset 8; null when absent. */
  readonly type: 1 | 2 | null;
  readonly elf: {
    readonly class: "32" | "64";
    readonly endianness: "little" | "big";
    readonly machine: string;
    readonly type: string;
    /** e_entry as 0x-prefixed hex. */
    readonly entry: string;
  };
  /**
   * First byte after the ELF as the type 2 runtime computes it
   * (`read_elf32`/`read_elf64` in AppImage/type2-runtime src/runtime/runtime.c):
   * the larger of the section header table's end (e_shoff + e_shentsize *
   * e_shnum) and the last section header's sh_offset + sh_size. The SquashFS
   * image starts here. A type 1 AppImage is an ISO 9660 image from offset 0.
   */
  readonly payload_offset: number;
  /** Section headers after the null section at index 0, in table order. */
  readonly sections: readonly AppImageSection[];
  /** .upd_info as NUL-trimmed text; null when absent or empty. */
  readonly update_information: string | null;
  /** .sha256_sig: bytes before the NUL padding; null when absent or empty. */
  readonly signature: {
    readonly section: string;
    readonly bytes: number;
  } | null;
  /** .sig_key: bytes before the NUL padding; null when absent or empty. */
  readonly signing_key: {
    readonly section: string;
    readonly bytes: number;
  } | null;
  /** .digest_md5 as hex; null when absent or all zero. */
  readonly digest_md5: string | null;
  readonly problems: readonly string[];
}

/** An ELF runtime the AppImage loader could not locate a payload behind. */
export class AppImageFormatError extends Error {
  constructor(
    readonly offset: number,
    message: string,
  ) {
    super(message);
    this.name = "AppImageFormatError";
  }
}

/** Bytes of the ELF header to cover both classes. */
const ELF_HEADER_BYTES = 64;
/** e_shnum is 16 bits; 65535 headers of 64 bytes. */
const MAXIMUM_SECTION_TABLE_BYTES = 65_535 * 64;
const MAXIMUM_NAME_TABLE_BYTES = 1024 * 1024;
/** The runtime reserves 1 KiB to 8 KiB for its own sections. */
const MAXIMUM_APPIMAGE_SECTION_BYTES = 64 * 1024;
/** SHT_NOBITS: the section occupies no file bytes. */
const SHT_NOBITS = 8;

const ELF_TYPES: Readonly<Record<number, string>> = {
  0: "none",
  1: "relocatable",
  2: "executable",
  3: "shared-object",
  4: "core",
};

/** ELF magic plus "AI" and the AppImage type at offsets 8..10. */
export const hasAppImageMagic = (bytes: Uint8Array): 1 | 2 | null => {
  if (
    bytes.length < 11 ||
    bytes[0] !== 0x7f ||
    bytes[1] !== 0x45 ||
    bytes[2] !== 0x4c ||
    bytes[3] !== 0x46 ||
    bytes[8] !== 0x41 ||
    bytes[9] !== 0x49
  )
    return null;
  return bytes[10] === 1 ? 1 : bytes[10] === 2 ? 2 : null;
};

/** Endian-aware unsigned fields of one ELF file. */
const fields = (little: boolean) => {
  const u16 = (bytes: Uint8Array, at: number): number =>
    little
      ? (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8)
      : ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
  const u32 = (bytes: Uint8Array, at: number): number =>
    little
      ? (u16(bytes, at) | (u16(bytes, at + 2) << 16)) >>> 0
      : ((u16(bytes, at) << 16) | u16(bytes, at + 2)) >>> 0;
  const u64 = (bytes: Uint8Array, at: number): bigint => {
    const low = BigInt(u32(bytes, little ? at : at + 4));
    const high = BigInt(u32(bytes, little ? at + 4 : at));
    return (high << 32n) | low;
  };
  return { u16, u32, u64 };
};

const asOffset = (value: bigint, at: number, what: string): number => {
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new AppImageFormatError(
      at,
      `${what} ${value.toString()} is beyond any file.`,
    );
  return Number(value);
};

const utf8 = new TextDecoder("utf-8");

const trimmed = (bytes: Uint8Array): Uint8Array => {
  const end = bytes.indexOf(0);
  return end === -1 ? bytes : bytes.subarray(0, end);
};

type Fetch = (
  offset: number,
  length: number,
  what: string,
) => Promise<Uint8Array>;

/** Reads checked against the file size; a short read is a format error. */
const fetcher =
  (read: AppImageRead, size: number): Fetch =>
  async (offset, length, what) => {
    if (offset + length > size)
      throw new AppImageFormatError(
        offset,
        `${what} needs bytes ${String(offset)}..${String(offset + length)} but the file has ${String(size)}.`,
      );
    const bytes = await read(offset, length);
    if (bytes.length !== length)
      throw new AppImageFormatError(
        offset,
        `${what} is truncated: ${String(bytes.length)} of ${String(length)} bytes could be read.`,
      );
    return bytes;
  };

interface ElfLayout {
  readonly elf: AppImageRuntime["elf"];
  readonly fields: ReturnType<typeof fields>;
  readonly wide: boolean;
  readonly sectionTable: number;
  readonly entrySize: number;
  readonly count: number;
  readonly namesIndex: number;
}

/** The ELF header fields the runtime's own payload search reads. */
const readElfLayout = (header: Uint8Array): ElfLayout => {
  const identity = elfHeader(header);
  if (identity === null || (header[5] !== 1 && header[5] !== 2))
    throw new AppImageFormatError(
      0,
      "The file does not start with an ELF header of a known class and byte order.",
    );
  const wide = identity.class === "64";
  if (header.length < (wide ? 64 : 52))
    throw new AppImageFormatError(
      0,
      `The ELF header is truncated at ${String(header.length)} bytes.`,
    );
  const little = header[5] === 1;
  const { u16, u32, u64 } = fields(little);
  const elfType = u16(header, 16);
  const entry = wide ? u64(header, 24) : BigInt(u32(header, 24));
  const layout = {
    elf: {
      class: identity.class,
      endianness: little ? "little" : "big",
      machine: identity.machine,
      type: ELF_TYPES[elfType] ?? `e_type ${String(elfType)}`,
      entry: `0x${entry.toString(16)}`,
    },
    fields: fields(little),
    wide,
    sectionTable: wide
      ? asOffset(u64(header, 40), 40, "e_shoff")
      : u32(header, 32),
    entrySize: u16(header, wide ? 58 : 46),
    count: u16(header, wide ? 60 : 48),
    namesIndex: u16(header, wide ? 62 : 50),
  } as const;
  if (layout.sectionTable === 0 || layout.count === 0)
    throw new AppImageFormatError(
      wide ? 40 : 32,
      "The ELF has no section header table, so the runtime cannot locate its payload.",
    );
  if (
    layout.entrySize < (wide ? 64 : 40) ||
    layout.entrySize * layout.count > MAXIMUM_SECTION_TABLE_BYTES
  )
    throw new AppImageFormatError(
      wide ? 58 : 46,
      `Section headers of ${String(layout.entrySize)} bytes (${String(layout.count)} of them) are not ELF${identity.class} section headers.`,
    );
  return layout;
};

interface SectionHeader extends AppImageSection {
  readonly type: number;
}

/** Every section header (the null section at index 0 included), named from the section name table when it is readable. */
const readSections = async (
  fetch: Fetch,
  layout: ElfLayout,
  size: number,
  problems: string[],
): Promise<SectionHeader[]> => {
  const { u32, u64 } = layout.fields;
  const { sectionTable, entrySize, wide } = layout;
  const table = await fetch(
    sectionTable,
    entrySize * layout.count,
    "Section header table",
  );
  const headers = Array.from({ length: layout.count }, (_, index) => {
    const at = index * entrySize;
    return {
      name: u32(table, at),
      type: u32(table, at + 4),
      offset: wide
        ? asOffset(u64(table, at + 24), sectionTable + at + 24, "sh_offset")
        : u32(table, at + 16),
      size: wide
        ? asOffset(u64(table, at + 32), sectionTable + at + 32, "sh_size")
        : u32(table, at + 20),
    };
  });
  const namesHeader =
    layout.namesIndex === 0 ? undefined : headers[layout.namesIndex];
  let names: Uint8Array | null = null;
  if (namesHeader === undefined)
    problems.push(
      `The section name table index ${String(layout.namesIndex)} does not name a section; section names are unknown.`,
    );
  else if (
    namesHeader.size > MAXIMUM_NAME_TABLE_BYTES ||
    namesHeader.offset + namesHeader.size > size
  )
    problems.push(
      `The section name table (${String(namesHeader.size)} bytes at ${String(namesHeader.offset)}) is outside the file or too large; section names are unknown.`,
    );
  else
    names = await fetch(
      namesHeader.offset,
      namesHeader.size,
      "Section name table",
    );
  return headers.map((header) => ({
    name:
      names === null || header.name >= names.length
        ? ""
        : utf8.decode(trimmed(names.subarray(header.name))),
    offset: header.offset,
    size: header.size,
    type: header.type,
  }));
};

/** What reading AppImage sections needs: the reads, the section headers, the file size and the problem list. */
interface SectionContext {
  readonly fetch: Fetch;
  readonly sections: readonly SectionHeader[];
  readonly size: number;
  readonly problems: string[];
}

/** The bytes of the first section named `name`; empty for NOBITS, null when absent or unreadable. */
const sectionContents = async (
  { fetch, sections, size, problems }: SectionContext,
  name: string,
): Promise<Uint8Array | null> => {
  const matches = sections.filter((section) => section.name === name);
  const [section] = matches;
  if (section === undefined) return null;
  if (matches.length > 1)
    problems.push(
      `${String(matches.length)} sections are named ${name}; the first is read.`,
    );
  if (section.type === SHT_NOBITS || section.size === 0)
    return new Uint8Array(0);
  if (
    section.size > MAXIMUM_APPIMAGE_SECTION_BYTES ||
    section.offset + section.size > size
  ) {
    problems.push(
      `${name} (${String(section.size)} bytes at ${String(section.offset)}) is outside the file or larger than ${String(MAXIMUM_APPIMAGE_SECTION_BYTES)} bytes; it is not read.`,
    );
    return null;
  }
  return fetch(section.offset, section.size, name);
};

/**
 * Read an AppImage runtime from a file of `size` bytes with positional
 * reads: the ELF header, then the section header table, the section name
 * table and the AppImage sections it locates.
 */
export const readAppImageRuntime = async (
  read: AppImageRead,
  size: number,
): Promise<AppImageRuntime> => {
  const fetch = fetcher(read, size);
  const header = await fetch(0, Math.min(size, ELF_HEADER_BYTES), "ELF header");
  const layout = readElfLayout(header);
  const problems: string[] = [];
  const headers = await readSections(fetch, layout, size, problems);
  const last = headers.at(-1);
  const payloadOffset = Math.max(
    layout.sectionTable + layout.entrySize * layout.count,
    last === undefined ? 0 : last.offset + last.size,
  );
  if (payloadOffset > size)
    problems.push(
      `The runtime would look for its payload at ${String(payloadOffset)}, past the end of the ${String(size)}-byte file.`,
    );
  const context = { fetch, sections: headers, size, problems };
  const contents = (name: string): Promise<Uint8Array | null> =>
    sectionContents(context, name);
  const padded = async (
    name: string,
  ): Promise<{ section: string; bytes: number } | null> => {
    const bytes = await contents(name);
    const length = bytes === null ? 0 : trimmed(bytes).length;
    return length === 0 ? null : { section: name, bytes: length };
  };
  const update = await contents(".upd_info");
  const updateText = update === null ? "" : utf8.decode(trimmed(update));
  const digest = await contents(".digest_md5");
  return {
    type: hasAppImageMagic(header),
    elf: layout.elf,
    payload_offset: payloadOffset,
    sections: headers
      .slice(1)
      .map(({ name, offset, size: bytes }) => ({ name, offset, size: bytes })),
    update_information: updateText === "" ? null : updateText,
    signature: await padded(".sha256_sig"),
    signing_key: await padded(".sig_key"),
    digest_md5:
      digest === null || digest.every((byte) => byte === 0)
        ? null
        : Buffer.from(digest).toString("hex"),
    problems,
  };
};
