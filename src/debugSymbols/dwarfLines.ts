import { ByteReader, DebugFormatError, hex, stringAt } from "./byteReader.js";
import { DW_FORM } from "./dwarfConstants.js";
import type { DwarfSections } from "./dwarfUnits.js";

const DW_LNCT_path = 1;
const DW_LNCT_directory_index = 2;
const DW_LNCT_MD5 = 5;
const MAX_TABLE_ENTRIES = 1_000_000;

export interface LineFile {
  /** The number rows use for this file. */
  readonly index: number;
  readonly name: string;
  /** The include directory text, when the file names one. */
  readonly directory: string | null;
  readonly path: string;
  readonly md5: string | null;
}

export interface LineHeader {
  readonly version: number;
  readonly offsetSize: 4 | 8;
  readonly addressSize: number;
  readonly minInstLength: number;
  readonly maxOpsPerInst: number;
  readonly defaultIsStmt: boolean;
  readonly lineBase: number;
  readonly lineRange: number;
  readonly opcodeBase: number;
  readonly standardOpcodeLengths: readonly number[];
  readonly files: readonly LineFile[];
  /** Offset in .debug_line of the first program byte. */
  readonly programStart: number;
  readonly end: number;
}

export interface LineRow {
  readonly address: bigint;
  readonly opIndex: number;
  readonly file: number;
  readonly line: number;
  readonly column: number;
  readonly isStmt: boolean;
  readonly basicBlock: boolean;
  readonly endSequence: boolean;
  readonly prologueEnd: boolean;
  readonly epilogueBegin: boolean;
  readonly isa: number;
  readonly discriminator: number;
}

interface FileEntry {
  name: string;
  dirIndex: number;
  md5: string | null;
}

const joinPath = (directory: string | null, name: string): string =>
  directory === null || directory === "" || name.startsWith("/")
    ? name
    : `${directory.replace(/\/$/u, "")}/${name}`;

const readEntryValue = (
  reader: ByteReader,
  form: number,
  offsetSize: 4 | 8,
  sections: DwarfSections,
): string | number | Uint8Array => {
  switch (form) {
    case DW_FORM.string:
      return reader.cString();
    case DW_FORM.line_strp:
      return (
        stringAt(sections.get(".debug_line_str"), reader.offset(offsetSize)) ??
        ""
      );
    case DW_FORM.strp:
      return (
        stringAt(sections.get(".debug_str"), reader.offset(offsetSize)) ?? ""
      );
    case DW_FORM.udata:
      return reader.uleb();
    case DW_FORM.data1:
      return reader.u8();
    case DW_FORM.data2:
      return reader.u16();
    case DW_FORM.data4:
      return reader.u32();
    case DW_FORM.data8:
      return Number(reader.u64());
    case DW_FORM.data16:
      return reader.block(16);
    case DW_FORM.block:
      return reader.block(reader.uleb());
    default:
      throw new DebugFormatError(
        `Line table entry form 0x${form.toString(16)} is not supported.`,
      );
  }
};

/** Read the entry-format tables of a version 5 line header. */
const readEntryTable = (
  reader: ByteReader,
  offsetSize: 4 | 8,
  sections: DwarfSections,
): FileEntry[] => {
  const formatCount = reader.u8();
  const formats: { type: number; form: number }[] = [];
  for (let index = 0; index < formatCount; index += 1)
    formats.push({ type: reader.uleb(), form: reader.uleb() });
  const count = reader.uleb();
  if (count > MAX_TABLE_ENTRIES)
    throw new DebugFormatError(`A line table lists ${count} entries.`);
  const entries: FileEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    const entry: FileEntry = { name: "", dirIndex: 0, md5: null };
    for (const { type, form } of formats) {
      const value = readEntryValue(reader, form, offsetSize, sections);
      if (type === DW_LNCT_path && typeof value === "string")
        entry.name = value;
      else if (type === DW_LNCT_directory_index && typeof value === "number")
        entry.dirIndex = value;
      else if (type === DW_LNCT_MD5 && value instanceof Uint8Array)
        entry.md5 = hex(value);
    }
    entries.push(entry);
  }
  return entries;
};

/** Parse the line program header at an offset of .debug_line. */
export const readLineHeader = (
  sections: DwarfSections,
  offset: number,
  compDir: string | null,
  addressSizeHint: number,
): LineHeader => {
  const data = sections.get(".debug_line");
  if (data === undefined)
    throw new DebugFormatError(
      "The image has no readable .debug_line section.",
    );
  const littleEndian = sections.image.littleEndian;
  const reader = new ByteReader(data, littleEndian, offset);
  let length = reader.u32();
  let offsetSize: 4 | 8 = 4;
  if (length === 0xffffffff) {
    offsetSize = 8;
    length = Number(reader.u64());
  }
  const end = reader.pos + length;
  if (end > data.length)
    throw new DebugFormatError(
      "The line program extends past the end of .debug_line.",
    );
  const bounded = new ByteReader(data, littleEndian, reader.pos, end);
  const version = bounded.u16();
  if (version < 2 || version > 5)
    throw new DebugFormatError(
      `Line table version ${version} is not supported.`,
    );
  let addressSize = addressSizeHint;
  if (version >= 5) {
    addressSize = bounded.u8();
    bounded.u8();
  }
  const headerLength = bounded.offset(offsetSize);
  const programStart = bounded.pos + headerLength;
  if (programStart > end)
    throw new DebugFormatError(
      "The line program header is longer than the program.",
    );
  const minInstLength = bounded.u8();
  const maxOpsPerInst = version >= 4 ? bounded.u8() : 1;
  const defaultIsStmt = bounded.u8() !== 0;
  const lineBase = bounded.i8();
  const lineRange = bounded.u8();
  const opcodeBase = bounded.u8();
  const standardOpcodeLengths: number[] = [];
  for (let index = 1; index < opcodeBase; index += 1)
    standardOpcodeLengths.push(bounded.u8());
  if (lineRange === 0)
    throw new DebugFormatError(
      "The line program declares a line range of zero.",
    );
  if (maxOpsPerInst === 0)
    throw new DebugFormatError(
      "The line program declares zero operations per instruction.",
    );

  const files: LineFile[] = [];
  if (version >= 5) {
    const directories = readEntryTable(bounded, offsetSize, sections);
    const entries = readEntryTable(bounded, offsetSize, sections);
    entries.forEach((entry, index) =>
      files.push({
        index,
        name: entry.name,
        directory: directories[entry.dirIndex]?.name ?? null,
        path: joinPath(directories[entry.dirIndex]?.name ?? null, entry.name),
        md5: entry.md5,
      }),
    );
  } else {
    const directories: string[] = [compDir ?? ""];
    for (;;) {
      const name = bounded.cString();
      if (name === "") break;
      directories.push(name);
      if (directories.length > MAX_TABLE_ENTRIES)
        throw new DebugFormatError("A line table lists too many directories.");
    }
    for (let index = 1; ; index += 1) {
      const name = bounded.cString();
      if (name === "") break;
      const dirIndex = bounded.uleb();
      bounded.uleb();
      bounded.uleb();
      const directory =
        dirIndex === 0 ? compDir : (directories[dirIndex] ?? null);
      files.push({
        index,
        name,
        directory,
        path: joinPath(directory, name),
        md5: null,
      });
      if (index > MAX_TABLE_ENTRIES)
        throw new DebugFormatError("A line table lists too many files.");
    }
  }
  return {
    version,
    offsetSize,
    addressSize,
    minInstLength,
    maxOpsPerInst,
    defaultIsStmt,
    lineBase,
    lineRange,
    opcodeBase,
    standardOpcodeLengths,
    files,
    programStart,
    end,
  };
};

/** Run the line program and pass each row to `visit`, which returns true to stop. */
export const runLineProgram = (
  sections: DwarfSections,
  header: LineHeader,
  visit: (row: LineRow) => boolean | void,
): void => {
  const data = sections.get(".debug_line");
  if (data === undefined) return;
  const reader = new ByteReader(
    data,
    sections.image.littleEndian,
    header.programStart,
    header.end,
  );
  const mask = (1n << BigInt(header.addressSize * 8)) - 1n;
  const reset = () => ({
    address: 0n,
    opIndex: 0,
    file: 1,
    line: 1,
    column: 0,
    isStmt: header.defaultIsStmt,
    basicBlock: false,
    endSequence: false,
    prologueEnd: false,
    epilogueBegin: false,
    isa: 0,
    discriminator: 0,
  });
  let state = reset();
  const advance = (operations: number): void => {
    const { maxOpsPerInst, minInstLength } = header;
    if (maxOpsPerInst === 1) {
      state.address =
        (state.address + BigInt(minInstLength) * BigInt(operations)) & mask;
      return;
    }
    const total = state.opIndex + operations;
    state.address =
      (state.address +
        BigInt(minInstLength) * BigInt(Math.floor(total / maxOpsPerInst))) &
      mask;
    state.opIndex = total % maxOpsPerInst;
  };
  const emit = (): boolean => {
    const stop = visit({ ...state }) === true;
    state.basicBlock = false;
    state.prologueEnd = false;
    state.epilogueBegin = false;
    state.discriminator = 0;
    return stop;
  };
  while (!reader.atEnd) {
    const opcode = reader.u8();
    if (opcode >= header.opcodeBase) {
      const adjusted = opcode - header.opcodeBase;
      advance(Math.floor(adjusted / header.lineRange));
      state.line =
        (state.line + header.lineBase + (adjusted % header.lineRange)) >>> 0;
      if (emit()) return;
      continue;
    }
    switch (opcode) {
      case 0: {
        const length = reader.uleb();
        if (length === 0) break;
        const next = reader.pos + length;
        if (next > reader.end)
          throw new DebugFormatError(
            "An extended line opcode passes the end of the program.",
          );
        const sub = reader.u8();
        if (sub === 1) {
          state.endSequence = true;
          if (emit()) return;
          state = reset();
        } else if (sub === 2) {
          state.address = reader.unsignedBig(length - 1) & mask;
          state.opIndex = 0;
        } else if (sub === 4) {
          state.discriminator = reader.uleb();
        }
        reader.pos = next;
        break;
      }
      case 1:
        if (emit()) return;
        break;
      case 2:
        advance(reader.uleb());
        break;
      case 3:
        state.line = (state.line + reader.sleb()) >>> 0;
        break;
      case 4:
        state.file = reader.uleb();
        break;
      case 5:
        state.column = reader.uleb();
        break;
      case 6:
        state.isStmt = !state.isStmt;
        break;
      case 7:
        state.basicBlock = true;
        break;
      case 8:
        advance(Math.floor((255 - header.opcodeBase) / header.lineRange));
        break;
      case 9:
        state.address = (state.address + BigInt(reader.u16())) & mask;
        state.opIndex = 0;
        break;
      case 10:
        state.prologueEnd = true;
        break;
      case 11:
        state.epilogueBegin = true;
        break;
      case 12:
        state.isa = reader.uleb();
        break;
      default: {
        // An opcode this reader does not know: skip its declared uleb operands.
        const operands = header.standardOpcodeLengths[opcode - 1] ?? 0;
        for (let index = 0; index < operands; index += 1) reader.uleb();
      }
    }
  }
};
