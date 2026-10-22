import { ByteReader, DebugFormatError, hex } from "./byteReader.js";
import type {
  DebugImage,
  DebugLink,
  DebugSection,
  ImageIdentity,
} from "./image.js";

const SHT_NOTE = 7;
const SHT_NOBITS = 8;
const SHF_COMPRESSED = 0x800;
const PT_NOTE = 4;
const NT_GNU_BUILD_ID = 3;
const ELFCOMPRESS_ZLIB = 1;
const ELFCOMPRESS_ZSTD = 2;
const MAX_SECTIONS = 65_536;
const MAX_NOTES = 4_096;

const MACHINES: Readonly<Record<number, string>> = {
  2: "sparc",
  3: "i386",
  4: "m68k",
  8: "mips",
  20: "ppc",
  21: "ppc64",
  22: "s390",
  40: "arm",
  42: "sh",
  43: "sparcv9",
  50: "ia64",
  62: "x86_64",
  183: "aarch64",
  243: "riscv",
  258: "loongarch",
};

const FILE_TYPES: Readonly<Record<number, string>> = {
  1: "relocatable",
  2: "executable",
  3: "shared",
  4: "core",
};

export const isElf = (bytes: Uint8Array): boolean =>
  bytes.length >= 20 &&
  bytes[0] === 0x7f &&
  bytes[1] === 0x45 &&
  bytes[2] === 0x4c &&
  bytes[3] === 0x46;

interface RawSection {
  readonly name: string;
  readonly type: number;
  readonly flags: bigint;
  readonly offset: number;
  readonly size: number;
}

const safe = (value: bigint, what: string): number => {
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new DebugFormatError(`${what} ${value} exceeds the supported range.`);
  return Number(value);
};

/** A NUL-terminated name at an offset of a string table the section headers pointed to. */
const nameAt = (table: Uint8Array, offset: number): string => {
  if (offset >= table.length) return "";
  const stop = table.indexOf(0, offset);
  return Buffer.from(
    table.subarray(offset, stop < 0 ? table.length : stop),
  ).toString("utf8");
};

interface Notes {
  readonly buildIds: Set<string>;
  readonly problems: string[];
}

/** NT_GNU_BUILD_ID notes in one byte range; other notes are skipped. */
const readNotes = (
  bytes: Uint8Array,
  littleEndian: boolean,
  notes: Notes,
): void => {
  const reader = new ByteReader(bytes, littleEndian);
  for (let seen = 0; reader.remaining >= 12; seen += 1) {
    if (seen >= MAX_NOTES) {
      notes.problems.push(
        `More than ${MAX_NOTES} notes; the rest were not read.`,
      );
      return;
    }
    const nameSize = reader.u32();
    const descSize = reader.u32();
    const type = reader.u32();
    // Plain arithmetic: u32 sizes near 2^32 overflow the int32 bit operators.
    const nameBytes = nameSize + ((4 - (nameSize % 4)) % 4);
    const descBytes = descSize + ((4 - (descSize % 4)) % 4);
    if (nameBytes + descBytes > reader.remaining) {
      notes.problems.push("A note extends past the end of its section.");
      return;
    }
    const name = reader.block(nameBytes).subarray(0, nameSize);
    const desc = reader.block(descBytes).subarray(0, descSize);
    const owner = Buffer.from(name).toString("utf8").replace(/\0+$/u, "");
    if (owner === "GNU" && type === NT_GNU_BUILD_ID && descSize > 0) {
      const id = hex(desc);
      // An all-zero id is a placeholder, not an identity two files can share.
      if (/^0+$/u.test(id))
        notes.problems.push("The GNU build id is all zeros and is ignored.");
      else notes.buildIds.add(id);
    }
  }
};

const readSections = (
  bytes: Uint8Array,
  reader: ByteReader,
  wide: boolean,
  header: {
    readonly shoff: number;
    readonly shentsize: number;
    readonly shnum: number;
    readonly shstrndx: number;
  },
): RawSection[] => {
  const minimum = wide ? 64 : 40;
  if (header.shoff === 0 || header.shentsize < minimum) return [];
  if (header.shoff > bytes.length)
    throw new DebugFormatError(
      "The section header table starts past the end of the file.",
    );
  const readAt = (index: number) => {
    const at = header.shoff + index * header.shentsize;
    if (at + minimum > bytes.length)
      throw new DebugFormatError(
        `Section header ${index} extends past the end of the file.`,
      );
    const section = new ByteReader(
      bytes,
      reader.littleEndian,
      at,
      at + minimum,
    );
    const nameOffset = section.u32();
    const type = section.u32();
    if (wide) {
      const flags = section.u64();
      section.skip(8);
      const offset = section.u64();
      const size = section.u64();
      const link = section.u32();
      return { nameOffset, type, flags, offset, size, link };
    }
    const flags = BigInt(section.u32());
    section.skip(4);
    const offset = BigInt(section.u32());
    const size = BigInt(section.u32());
    const link = section.u32();
    return { nameOffset, type, flags, offset, size, link };
  };
  let count = header.shnum;
  let strIndex = header.shstrndx;
  const first =
    header.shoff + header.shentsize <= bytes.length ? readAt(0) : null;
  if (count === 0 && first !== null) count = safe(first.size, "Section count");
  if (strIndex === 0xffff && first !== null) strIndex = first.link;
  if (count > MAX_SECTIONS)
    throw new DebugFormatError(`The file declares ${count} sections.`);
  if (strIndex >= count)
    throw new DebugFormatError("The section name table index is out of range.");
  const raw = Array.from({ length: count }, (_, index) => readAt(index));
  const names = raw[strIndex]!;
  const tableOffset = safe(names.offset, "Name table offset");
  const tableSize = safe(names.size, "Name table size");
  if (tableOffset + tableSize > bytes.length)
    throw new DebugFormatError(
      "The section name table extends past the end of the file.",
    );
  const table = bytes.subarray(tableOffset, tableOffset + tableSize);
  return raw.map((section) => ({
    name: nameAt(table, section.nameOffset),
    type: section.type,
    flags: section.flags,
    offset: safe(section.offset, "Section offset"),
    size: safe(section.size, "Section size"),
  }));
};

const toSection = (
  raw: RawSection,
  bytes: Uint8Array,
  wide: boolean,
  littleEndian: boolean,
): DebugSection => {
  const gnu = raw.name.startsWith(".zdebug_");
  const base = {
    name: gnu ? `.debug_${raw.name.slice(".zdebug_".length)}` : raw.name,
    storedName: raw.name,
    offset: raw.offset,
    size: raw.size,
    noBits: raw.type === SHT_NOBITS,
  };
  const plain: DebugSection = {
    ...base,
    compression: "none",
    declaredSize: null,
    streamOffset: 0,
    problem: null,
  };
  const broken = (problem: string): DebugSection => ({ ...plain, problem });
  if (base.noBits) return plain;
  try {
    if (gnu) {
      // GNU style: "ZLIB", then the decompressed size as 8 big-endian bytes, then a zlib stream.
      if (raw.size < 12 || raw.offset + 12 > bytes.length)
        return broken("the GNU compression header is truncated");
      const head = new ByteReader(bytes, false, raw.offset, raw.offset + 12);
      if (Buffer.from(head.block(4)).toString("latin1") !== "ZLIB")
        return broken("a .zdebug section does not start with ZLIB");
      return {
        ...plain,
        compression: "zlib",
        declaredSize: safe(head.u64(), "Decompressed size"),
        streamOffset: 12,
      };
    }
    if ((raw.flags & BigInt(SHF_COMPRESSED)) === 0n) return plain;
    const chdrSize = wide ? 24 : 12;
    if (raw.size < chdrSize || raw.offset + chdrSize > bytes.length)
      return broken("the compression header is truncated");
    const chdr = new ByteReader(
      bytes,
      littleEndian,
      raw.offset,
      raw.offset + chdrSize,
    );
    const type = chdr.u32();
    if (wide) chdr.skip(4);
    const declaredSize = wide
      ? safe(chdr.u64(), "Decompressed size")
      : chdr.u32();
    const compression =
      type === ELFCOMPRESS_ZLIB
        ? "zlib"
        : type === ELFCOMPRESS_ZSTD
          ? "zstd"
          : null;
    if (compression === null)
      return broken(`compression type ${type} is not supported`);
    return { ...plain, compression, declaredSize, streamOffset: chdrSize };
  } catch (cause) {
    if (!(cause instanceof DebugFormatError)) throw cause;
    return broken(cause.message);
  }
};

const debugLink = (
  bytes: Uint8Array,
  section: RawSection,
  littleEndian: boolean,
): DebugLink | null => {
  if (section.offset + section.size > bytes.length || section.size < 5)
    return null;
  const reader = new ByteReader(
    bytes,
    littleEndian,
    section.offset,
    section.offset + section.size,
  );
  const name = reader.cString();
  const aligned = (reader.pos - section.offset + 3) & ~3;
  const crcAt = section.offset + aligned;
  if (crcAt + 4 > section.offset + section.size) return null;
  reader.pos = crcAt;
  return { name, crc32: reader.u32().toString(16).padStart(8, "0") };
};

const debugAltLink = (
  bytes: Uint8Array,
  section: RawSection,
  littleEndian: boolean,
): ImageIdentity["debugAltLink"] => {
  if (section.offset + section.size > bytes.length || section.size < 2)
    return null;
  const reader = new ByteReader(
    bytes,
    littleEndian,
    section.offset,
    section.offset + section.size,
  );
  const name = reader.cString();
  return { name, buildId: hex(reader.block(reader.remaining)) };
};

/** Read one ELF image's headers, notes and DWARF section locations. Throws DebugFormatError. */
export const readElf = (bytes: Uint8Array): DebugImage => {
  if (!isElf(bytes)) throw new DebugFormatError("The file is not an ELF file.");
  const wide = bytes[4] === 2;
  if (bytes[4] !== 1 && bytes[4] !== 2)
    throw new DebugFormatError(`Unknown ELF class ${bytes[4]}.`);
  if (bytes[5] !== 1 && bytes[5] !== 2)
    throw new DebugFormatError(`Unknown ELF data encoding ${bytes[5]}.`);
  const littleEndian = bytes[5] === 1;
  const reader = new ByteReader(bytes, littleEndian, 16);
  const type = reader.u16();
  const machine = reader.u16();
  reader.skip(4);
  reader.skip(wide ? 8 : 4);
  const phoff = wide
    ? Number(safe(reader.u64(), "Program header offset"))
    : reader.u32();
  const shoff = wide
    ? Number(safe(reader.u64(), "Section header offset"))
    : reader.u32();
  reader.skip(4);
  reader.skip(2);
  const phentsize = reader.u16();
  const phnum = reader.u16();
  const shentsize = reader.u16();
  const shnum = reader.u16();
  const shstrndx = reader.u16();

  const problems: string[] = [];
  let rawSections: RawSection[] = [];
  try {
    rawSections = readSections(bytes, reader, wide, {
      shoff,
      shentsize,
      shnum,
      shstrndx,
    });
  } catch (cause) {
    if (!(cause instanceof DebugFormatError)) throw cause;
    problems.push(`Section headers could not be read: ${cause.message}`);
  }

  const notes: Notes = { buildIds: new Set(), problems };
  let sawNoteSection = false;
  for (const section of rawSections) {
    if (
      section.type !== SHT_NOTE ||
      section.offset + section.size > bytes.length
    )
      continue;
    sawNoteSection = true;
    try {
      readNotes(
        bytes.subarray(section.offset, section.offset + section.size),
        littleEndian,
        notes,
      );
    } catch (cause) {
      if (!(cause instanceof DebugFormatError)) throw cause;
      problems.push(`Note section ${section.name}: ${cause.message}`);
    }
  }
  // A file without section headers can still carry its build id in a PT_NOTE segment.
  if (!sawNoteSection && phoff > 0 && phentsize >= (wide ? 56 : 32)) {
    for (let index = 0; index < Math.min(phnum, 4096); index += 1) {
      const at = phoff + index * phentsize;
      if (at + (wide ? 56 : 32) > bytes.length) break;
      const entry = new ByteReader(bytes, littleEndian, at);
      const kind = entry.u32();
      if (kind !== PT_NOTE) continue;
      let offset: number;
      let size: number;
      if (wide) {
        entry.skip(4);
        offset = safe(entry.u64(), "Segment offset");
        entry.skip(16);
        size = safe(entry.u64(), "Segment size");
      } else {
        offset = entry.u32();
        entry.skip(8);
        size = entry.u32();
      }
      if (offset + size > bytes.length) continue;
      try {
        readNotes(bytes.subarray(offset, offset + size), littleEndian, notes);
      } catch (cause) {
        if (!(cause instanceof DebugFormatError)) throw cause;
        problems.push(`Note segment ${index}: ${cause.message}`);
      }
    }
  }
  const buildIds = [...notes.buildIds];
  if (buildIds.length > 1)
    problems.push(
      `Two different GNU build ids are present (${buildIds.join(", ")}); the build id is unknown.`,
    );

  const link = rawSections.find((section) => section.name === ".gnu_debuglink");
  const altLink = rawSections.find(
    (section) => section.name === ".gnu_debugaltlink",
  );
  let identityLink: DebugLink | null = null;
  let identityAlt: ImageIdentity["debugAltLink"] = null;
  try {
    identityLink =
      link === undefined ? null : debugLink(bytes, link, littleEndian);
    identityAlt =
      altLink === undefined ? null : debugAltLink(bytes, altLink, littleEndian);
  } catch (cause) {
    if (!(cause instanceof DebugFormatError)) throw cause;
    problems.push(`Debug link section: ${cause.message}`);
  }

  const sections = rawSections
    .filter(
      (section) =>
        section.name.startsWith(".debug_") ||
        section.name.startsWith(".zdebug_"),
    )
    .map((section) => toSection(section, bytes, wide, littleEndian));

  return {
    format: "elf",
    bytes,
    fileOffset: 0,
    architecture: MACHINES[machine] ?? `machine-${machine}`,
    bits: wide ? 64 : 32,
    littleEndian,
    fileType: FILE_TYPES[type] ?? `type-${type}`,
    relocatable: type === 1,
    identity: {
      buildId: buildIds.length === 1 ? buildIds[0]! : null,
      uuid: null,
      debugLink: identityLink,
      debugAltLink: identityAlt,
    },
    sections,
    hasSymbolTable: rawSections.some((section) => section.name === ".symtab"),
    problems,
  };
};
