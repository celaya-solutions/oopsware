import {
  CabFormatError,
  type CabRead,
  CabSource,
  CabUnsupportedError,
  dosDateTime,
  u16,
  u32,
} from "./format.js";

export type CabCompression =
  | "none"
  | "mszip"
  | "quantum"
  | "lzx"
  | `unknown-${number}`;

export interface CabFolder {
  readonly index: number;
  /** Offset of the folder's first CFDATA block (coffCabStart). */
  readonly data_offset: number;
  /** CFDATA blocks the folder declares in this cabinet (cCFData). */
  readonly blocks: number;
  readonly compression: CabCompression;
  /** History window in bytes: 32768 for MSZIP, 2^bits for LZX and Quantum, null for none and unknown. */
  readonly window: number | null;
  /** Quantum compression level (1-7); null for other methods. */
  readonly level: number | null;
  /** typeCompress as stored. */
  readonly type_compress: number;
}

export type CabContinuation = "none" | "from-previous" | "to-next" | "both";

export interface CabFile {
  readonly index: number;
  readonly name: string;
  readonly size: number;
  /** The folder holding the file; the special continued indexes resolve to the first or last folder. */
  readonly folder: number;
  readonly folder_offset: number;
  readonly continued: CabContinuation;
  /** Offset of the CFFILE record. */
  readonly record_offset: number;
  /** ISO date-time exactly as stored, with no zone: producers differ on local time or UTC. */
  readonly date: string | null;
  readonly dos: { readonly date: number; readonly time: number };
  readonly attributes: readonly string[];
  readonly attribute_bits: number;
}

export interface CabLink {
  readonly cabinet: string;
  readonly disk: string;
}

export interface CabReserve {
  readonly header: number;
  readonly folder: number;
  readonly data: number;
}

export interface CabHeader {
  readonly version: string;
  /** cbCabinet as stored. */
  readonly declared_size: number;
  readonly flags: number;
  readonly set_id: number;
  readonly set_index: number;
  /** Reserved-area sizes when cfhdrRESERVE_PRESENT is set; the bytes are not interpreted. */
  readonly reserve: CabReserve | null;
  readonly previous: CabLink | null;
  readonly next: CabLink | null;
  readonly folders: readonly CabFolder[];
  readonly files: readonly CabFile[];
  readonly problems: readonly string[];
}

/** CFHEADER before its optional reserve sizes. */
const CFHEADER_BYTES = 36;
const CFFOLDER_BYTES = 8;
const CFFILE_BYTES = 16;
/** Names are at most 255 bytes plus the terminating NUL (CB_MAX_FILENAME, CB_MAX_CABINET_NAME). */
const MAX_NAME = 256;
/** cbCFHeader may not exceed 60,000 bytes ([MS-CAB] 2.1). */
const MAX_HEADER_RESERVE = 60_000;
/** An MSZIP, LZX or Quantum CFDATA block never holds more than 32 KiB uncompressed. */
export const MAX_BLOCK_BYTES = 32_768;

const FLAG_PREVIOUS = 0x0001;
const FLAG_NEXT = 0x0002;
const FLAG_RESERVE = 0x0004;

const CONTINUED: Readonly<Record<number, CabContinuation>> = {
  0xfffd: "from-previous",
  0xfffe: "to-next",
  0xffff: "both",
};

const METHODS: Readonly<Record<number, CabCompression>> = {
  0: "none",
  1: "mszip",
  2: "quantum",
  3: "lzx",
};

const ATTRIBUTES: readonly (readonly [number, string])[] = [
  [0x01, "readonly"],
  [0x02, "hidden"],
  [0x04, "system"],
  [0x20, "archive"],
  [0x40, "exec"],
  [0x80, "name-is-utf8"],
];

const UTF8 = new TextDecoder("utf-8", { fatal: true });
const CP1252 = new TextDecoder("windows-1252");

/** One table read into memory: `bytes` begin at cabinet offset `base`. */
interface Table {
  readonly bytes: Uint8Array;
  readonly base: number;
  readonly problems: string[];
}

const hex4 = (value: number): string =>
  `0x${value.toString(16).padStart(4, "0")}`;

/** A NUL-terminated name of at most 256 bytes at `at`, decoded per the UTF-8 attribute. */
const readName = (
  table: Table,
  at: number,
  utf8: boolean,
  what: string,
): { name: string; next: number } => {
  const window = table.bytes.subarray(at, at + MAX_NAME);
  const nul = window.indexOf(0);
  if (nul < 0)
    throw new CabFormatError(
      table.base + at,
      window.length < MAX_NAME
        ? `${what} is cut off before its terminating NUL.`
        : `${what} has no NUL within ${String(MAX_NAME)} bytes.`,
    );
  const raw = window.subarray(0, nul);
  if (raw.every((byte) => byte < 0x80))
    return { name: CP1252.decode(raw), next: at + nul + 1 };
  if (utf8)
    try {
      return { name: UTF8.decode(raw), next: at + nul + 1 };
    } catch {
      table.problems.push(
        `${what} is marked UTF-8 but is not valid UTF-8; it is shown as Windows-1252.`,
      );
    }
  else
    table.problems.push(
      `${what} has bytes above 0x7F without the UTF-8 attribute; the code page is not recorded, so it is shown as Windows-1252.`,
    );
  return { name: CP1252.decode(raw), next: at + nul + 1 };
};

const folderParameters = (
  label: string,
  compression: CabCompression,
  type: number,
  problems: string[],
): Pick<CabFolder, "window" | "level"> => {
  const bits = (type >>> 8) & 0x1f;
  if (compression === "mszip") return { window: MAX_BLOCK_BYTES, level: null };
  if (compression === "lzx") {
    if (bits < 15 || bits > 21)
      problems.push(
        `${label} declares an LZX window of 2^${String(bits)}; 2^15 to 2^21 are defined.`,
      );
    return { window: 2 ** bits, level: null };
  }
  if (compression === "quantum") {
    const level = (type >>> 4) & 0x0f;
    if (bits < 10 || bits > 21 || level < 1 || level > 7)
      problems.push(
        `${label} declares Quantum level ${String(level)} with a 2^${String(bits)} window; levels 1-7 and windows 2^10 to 2^21 are defined.`,
      );
    return { window: 2 ** bits, level };
  }
  return { window: null, level: null };
};

const folderRecord = (
  table: Table,
  index: number,
  at: number,
  end: number,
): CabFolder => {
  const { bytes, problems } = table;
  const data_offset = u32(bytes, at);
  const blocks = u16(bytes, at + 4);
  const type = u16(bytes, at + 6);
  const method = type & 0x000f;
  const label = `Folder ${String(index)}`;
  const compression: CabCompression = METHODS[method] ?? `unknown-${method}`;
  if ((compression === "none" || compression === "mszip") && type !== method)
    problems.push(
      `${label} sets typeCompress ${hex4(type)}; ${compression} defines no parameter bits.`,
    );
  if (blocks > 0 && data_offset + CFFOLDER_BYTES > end)
    problems.push(
      `${label}'s data at ${String(data_offset)} lies past the cabinet end at ${String(end)}.`,
    );
  return {
    index,
    data_offset,
    blocks,
    compression,
    ...folderParameters(label, compression, type, problems),
    type_compress: type,
  };
};

const fileRecord = (
  table: Table,
  index: number,
  at: number,
  folderCount: number,
): { file: CabFile; next: number } => {
  const { bytes, problems } = table;
  const rawFolder = u16(bytes, at + 8);
  const date = u16(bytes, at + 10);
  const time = u16(bytes, at + 12);
  const attribute_bits = u16(bytes, at + 14);
  const label = `File ${String(index)}`;
  const { name, next } = readName(
    table,
    at + CFFILE_BYTES,
    (attribute_bits & 0x80) !== 0,
    `${label}'s name`,
  );
  const continued = CONTINUED[rawFolder] ?? "none";
  const folder =
    continued === "none"
      ? rawFolder
      : continued === "to-next"
        ? Math.max(folderCount - 1, 0)
        : 0;
  if (name === "") problems.push(`${label} has an empty name.`);
  if (folder >= folderCount)
    problems.push(
      `${label} ("${name}") names folder ${String(folder)}; the cabinet has ${String(folderCount)}.`,
    );
  const attributes = ATTRIBUTES.filter(([bit]) => attribute_bits & bit).map(
    ([, attribute]) => attribute,
  );
  if ((attribute_bits & ~0xe7) !== 0)
    attributes.push(`unknown-${hex4(attribute_bits & ~0xe7)}`);
  const file: CabFile = {
    index,
    name,
    size: u32(bytes, at),
    folder,
    folder_offset: u32(bytes, at + 4),
    continued,
    record_offset: table.base + at,
    date: dosDateTime(date, time),
    dos: { date, time },
    attributes,
    attribute_bits,
  };
  return { file, next };
};

/** Records before a name without its NUL are kept; the rest cannot be located. */
const fileRecords = (
  table: Table,
  fileCount: number,
  folderCount: number,
): { files: CabFile[]; end: number } => {
  const files: CabFile[] = [];
  let position = 0;
  for (let index = 0; index < fileCount; index += 1) {
    if (position + CFFILE_BYTES > table.bytes.length) {
      table.problems.push(
        `The file table ends at byte ${String(table.base + position)} after ${String(index)} of ${String(fileCount)} records.`,
      );
      break;
    }
    try {
      const record = fileRecord(table, index, position, folderCount);
      files.push(record.file);
      position = record.next;
    } catch (cause) {
      if (!(cause instanceof CabFormatError)) throw cause;
      table.problems.push(
        `${cause.message} The listing keeps ${String(index)} of ${String(fileCount)} records.`,
      );
      break;
    }
  }
  return { files, end: table.base + position };
};

const checkFiles = (
  header: Pick<CabHeader, "files" | "folders" | "flags">,
  problems: string[],
): void => {
  for (const file of header.files) {
    const label = `File ${String(file.index)} ("${file.name}")`;
    if (
      (file.continued === "from-previous" || file.continued === "both") &&
      (header.flags & FLAG_PREVIOUS) === 0
    )
      problems.push(
        `${label} continues from a previous cabinet, but the header names none.`,
      );
    if (
      (file.continued === "to-next" || file.continued === "both") &&
      (header.flags & FLAG_NEXT) === 0
    )
      problems.push(
        `${label} continues into a next cabinet, but the header names none.`,
      );
    const folder = header.folders[file.folder];
    if (folder === undefined || file.continued !== "none") continue;
    const capacity = folder.blocks * MAX_BLOCK_BYTES;
    if (file.folder_offset + file.size > capacity)
      problems.push(
        `${label} ends at byte ${String(file.folder_offset + file.size)} of folder ${String(folder.index)}, past the ${String(capacity)} bytes its ${String(folder.blocks)} blocks can hold.`,
      );
  }
};

/** The fixed CFHEADER fields; signature and major version are checked here. */
const fixedHeader = (head: Uint8Array, size: number, problems: string[]) => {
  if (u32(head, 0) !== 0x4643534d)
    throw new CabFormatError(0, 'The cabinet signature is not "MSCF".');
  const minor = head[24] ?? 0;
  const major = head[25] ?? 0;
  const version = `${String(major)}.${String(minor)}`;
  if (major !== 1)
    throw new CabUnsupportedError(
      `version ${version}`,
      `Cabinet format ${version} is not 1.3, the only version [MS-CAB] defines.`,
    );
  if (minor !== 3)
    problems.push(`The cabinet says format ${version}; [MS-CAB] defines 1.3.`);
  const declared = u32(head, 8);
  const flags = u16(head, 30);
  if (declared < CFHEADER_BYTES)
    throw new CabFormatError(
      8,
      `The cabinet declares ${String(declared)} bytes, less than its own header.`,
    );
  if (declared > size)
    problems.push(
      `The cabinet declares ${String(declared)} bytes; only ${String(size)} are present.`,
    );
  else if (declared < size)
    problems.push(
      `${String(size - declared)} bytes follow the declared cabinet end at ${String(declared)}.`,
    );
  if ((flags & ~0x0007) !== 0)
    problems.push(`The header sets unknown flags ${hex4(flags & ~0x0007)}.`);
  return {
    version,
    declared_size: declared,
    files_offset: u32(head, 16),
    folder_count: u16(head, 26),
    file_count: u16(head, 28),
    flags,
    set_id: u16(head, 32),
    set_index: u16(head, 34),
  };
};

/** The reserve sizes and previous/next cabinet names that follow CFHEADER; returns where folders begin. */
const optionalHeader = async (
  source: CabSource,
  flags: number,
  problems: string[],
): Promise<
  Pick<CabHeader, "reserve" | "previous" | "next"> & { folders_at: number }
> => {
  let at = CFHEADER_BYTES;
  let reserve: CabReserve | null = null;
  if ((flags & FLAG_RESERVE) !== 0) {
    const sizes = await source.bytes(at, 4, "The reserve sizes");
    reserve = {
      header: u16(sizes, 0),
      folder: sizes[2] ?? 0,
      data: sizes[3] ?? 0,
    };
    if (reserve.header > MAX_HEADER_RESERVE)
      throw new CabFormatError(
        at,
        `The header reserve is ${String(reserve.header)} bytes; at most ${String(MAX_HEADER_RESERVE)} are allowed.`,
      );
    at += 4 + reserve.header;
  }
  if ((flags & (FLAG_PREVIOUS | FLAG_NEXT)) === 0)
    return { reserve, previous: null, next: null, folders_at: at };
  const table: Table = {
    bytes: await source.bytes(
      at,
      Math.min(source.end - at, 4 * MAX_NAME),
      "The cabinet links",
    ),
    base: at,
    problems,
  };
  let cursor = 0;
  const link = (what: string): CabLink => {
    const cabinet = readName(table, cursor, false, `The ${what} cabinet name`);
    const disk = readName(table, cabinet.next, false, `The ${what} disk name`);
    cursor = disk.next;
    return { cabinet: cabinet.name, disk: disk.name };
  };
  const previous = (flags & FLAG_PREVIOUS) === 0 ? null : link("previous");
  const next = (flags & FLAG_NEXT) === 0 ? null : link("next");
  return { reserve, previous, next, folders_at: at + cursor };
};

/**
 * Parse CFHEADER, every CFFOLDER and every CFFILE ([MS-CAB] 2.1-2.3). The
 * header and folder table must be intact; a file table cut short keeps the
 * records before the cut and says so. Reads stay below the smaller of the
 * declared size and `size`.
 */
export const readCabHeader = async (
  read: CabRead,
  size: number,
): Promise<{ header: CabHeader; source: CabSource }> => {
  const problems: string[] = [];
  if (size < CFHEADER_BYTES)
    throw new CabFormatError(
      0,
      `The file is ${String(size)} bytes; a cabinet header needs ${String(CFHEADER_BYTES)}.`,
    );
  const head = await read(0, CFHEADER_BYTES);
  if (head.length !== CFHEADER_BYTES)
    throw new CabFormatError(0, "The cabinet header could not be read.");
  const fixed = fixedHeader(head, size, problems);
  const source = new CabSource(read, Math.min(fixed.declared_size, size));
  const optional = await optionalHeader(source, fixed.flags, problems);
  const folderBytes = CFFOLDER_BYTES + (optional.reserve?.folder ?? 0);
  const folderTable: Table = {
    bytes: await source.bytes(
      optional.folders_at,
      fixed.folder_count * folderBytes,
      "The folder table",
    ),
    base: optional.folders_at,
    problems,
  };
  const folders = Array.from({ length: fixed.folder_count }, (_, index) =>
    folderRecord(folderTable, index, index * folderBytes, source.end),
  );
  const tableEnd = optional.folders_at + folderTable.bytes.length;
  const filesAt = fixed.files_offset;
  if (filesAt < tableEnd || filesAt > source.end)
    throw new CabFormatError(
      16,
      `The file table offset ${String(filesAt)} is outside ${String(tableEnd)}..${String(source.end)}.`,
    );
  const { files, end } = fileRecords(
    {
      bytes: await source.bytes(
        filesAt,
        Math.min(
          source.end - filesAt,
          fixed.file_count * (CFFILE_BYTES + MAX_NAME),
        ),
        "The file table",
      ),
      base: filesAt,
      problems,
    },
    fixed.file_count,
    fixed.folder_count,
  );
  for (const folder of folders)
    if (folder.blocks > 0 && folder.data_offset < end)
      problems.push(
        `Folder ${String(folder.index)}'s data at ${String(folder.data_offset)} overlaps the header or file table, which end at ${String(end)}.`,
      );
  const header: CabHeader = {
    version: fixed.version,
    declared_size: fixed.declared_size,
    flags: fixed.flags,
    set_id: fixed.set_id,
    set_index: fixed.set_index,
    reserve: optional.reserve,
    previous: optional.previous,
    next: optional.next,
    folders,
    files,
    problems,
  };
  checkFiles(header, problems);
  return { header, source };
};
