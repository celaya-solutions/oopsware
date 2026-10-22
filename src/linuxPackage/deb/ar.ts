/** Read `length` bytes at `offset`; a shorter result means the source ended. */
export type PositionalRead = (
  offset: number,
  length: number,
) => Promise<Uint8Array>;

/** One `ar` member: header fields as stored, data range after any BSD long name. */
export interface ArMember {
  readonly name: string;
  readonly header_offset: number;
  readonly data_offset: number;
  readonly size: number;
  readonly mtime: number;
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
}

/** A structural problem at an exact byte offset of one `ar` archive. */
export class ArFormatError extends Error {
  constructor(
    readonly offset: number,
    message: string,
  ) {
    super(message);
    this.name = "ArFormatError";
  }
}

const MAGIC = "!<arch>\n";
const THIN_MAGIC = "!<thin>\n";
const HEADER_BYTES = 60;
/** Every member costs at least a header, so this only bounds hostile archives. */
const MAXIMUM_MEMBERS = 100_000;
/** GNU `//` long-name tables of large static libraries stay well below this. */
const MAXIMUM_NAME_TABLE_BYTES = 16 * 1024 * 1024;
const MAXIMUM_BSD_NAME_BYTES = 4096;

const utf8 = new TextDecoder("utf-8", { fatal: true });
const latin1 = new TextDecoder("latin1");

/** Read exactly `length` bytes or fail with the offset that ran short. */
export const readExactly = async (
  read: PositionalRead,
  offset: number,
  length: number,
  what: string,
): Promise<Uint8Array> => {
  const bytes = length === 0 ? new Uint8Array(0) : await read(offset, length);
  if (bytes.length < length)
    throw new ArFormatError(
      offset,
      `${what} needs ${String(length)} bytes at offset ${String(offset)} but only ${String(bytes.length)} were read.`,
    );
  return bytes.length === length ? bytes : bytes.subarray(0, length);
};

/** Header field positions: start, width and radix (ar(5)). */
const FIELDS = {
  mtime: [16, 12, 10],
  uid: [28, 6, 10],
  gid: [34, 6, 10],
  mode: [40, 8, 8],
  size: [48, 10, 10],
} as const;

/** A space-padded numeric header field; `blankAllowed` only for GNU's table headers. */
const numberField = (
  header: Uint8Array,
  field: keyof typeof FIELDS,
  headerOffset: number,
  blankAllowed: boolean,
): number => {
  const [start, length, radix] = FIELDS[field];
  const text = latin1.decode(header.subarray(start, start + length));
  const digits = text.replace(/ +$/u, "");
  if (digits === "" && blankAllowed) return 0;
  const pattern = radix === 8 ? /^[0-7]+$/u : /^[0-9]+$/u;
  if (!pattern.test(digits))
    throw new ArFormatError(
      headerOffset + start,
      `ar member ${field} field ${JSON.stringify(text)} is not a ${radix === 8 ? "octal" : "decimal"} number.`,
    );
  const value = Number.parseInt(digits, radix);
  if (!Number.isSafeInteger(value))
    throw new ArFormatError(
      headerOffset + start,
      `ar member ${field} field exceeds the safe integer range.`,
    );
  return value;
};

const decodeName = (bytes: Uint8Array, offset: number): string => {
  try {
    return utf8.decode(bytes);
  } catch {
    throw new ArFormatError(
      offset,
      `ar member name is not valid UTF-8 (bytes ${Buffer.from(bytes).toString("hex")}).`,
    );
  }
};

/** Name from a GNU `//` table: entries end with "/\n". */
const gnuLongName = (
  table: Uint8Array | null,
  index: number,
  headerOffset: number,
): string => {
  if (table === null)
    throw new ArFormatError(
      headerOffset,
      "ar member refers to a GNU long-name table that is not present before it.",
    );
  if (index >= table.length)
    throw new ArFormatError(
      headerOffset,
      `ar member long-name index ${String(index)} is outside the ${String(table.length)}-byte name table.`,
    );
  const end = table.indexOf(0x0a, index);
  if (end < 0 || end === index || table[end - 1] !== 0x2f)
    throw new ArFormatError(
      headerOffset,
      `ar long-name table entry at ${String(index)} does not end with "/\\n".`,
    );
  return decodeName(table.subarray(index, end - 1), headerOffset);
};

interface ParsedHeader {
  readonly rawName: string;
  readonly mtime: number;
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
  readonly size: number;
}

const parseHeader = (header: Uint8Array, offset: number): ParsedHeader => {
  if (header[58] !== 0x60 || header[59] !== 0x0a)
    throw new ArFormatError(
      offset + 58,
      'ar member header does not end with "`\\n".',
    );
  const rawName = latin1.decode(header.subarray(0, 16)).replace(/ +$/u, "");
  if (rawName === "")
    throw new ArFormatError(offset, "ar member header has an empty name.");
  // GNU ar leaves everything but the size blank on its "//" name table.
  const blank = rawName === "//" || rawName === "/";
  return {
    rawName,
    mtime: numberField(header, "mtime", offset, blank),
    uid: numberField(header, "uid", offset, blank),
    gid: numberField(header, "gid", offset, blank),
    mode: numberField(header, "mode", offset, blank),
    size: numberField(header, "size", offset, false),
  };
};

interface ResolvedName {
  readonly name: string;
  /** Bytes of a BSD long name stored ahead of the data. */
  readonly skipped: number;
  /** The GNU long-name table in effect after this member. */
  readonly names: Uint8Array | null;
}

/** Resolve a member name: BSD `#1/N`, GNU `//` table and `/N`, special members, short names. */
const resolveName = async (
  read: PositionalRead,
  header: ParsedHeader,
  offset: number,
  names: Uint8Array | null,
): Promise<ResolvedName> => {
  const dataStart = offset + HEADER_BYTES;
  const bsd = /^#1\/([0-9]+)$/u.exec(header.rawName);
  if (bsd !== null) {
    const length = Number(bsd[1]);
    if (length > header.size || length > MAXIMUM_BSD_NAME_BYTES)
      throw new ArFormatError(
        offset,
        `ar BSD long name of ${String(length)} bytes does not fit the ${String(header.size)}-byte member.`,
      );
    const stored = await readExactly(
      read,
      dataStart,
      length,
      "ar BSD long name",
    );
    // BSD ar pads the stored name with NULs to keep the data aligned.
    const end = stored.indexOf(0);
    const name = decodeName(
      end < 0 ? stored : stored.subarray(0, end),
      dataStart,
    );
    return { name, skipped: length, names };
  }
  if (header.rawName === "//") {
    if (header.size > MAXIMUM_NAME_TABLE_BYTES)
      throw new ArFormatError(
        offset,
        `ar GNU long-name table of ${String(header.size)} bytes exceeds the ${String(MAXIMUM_NAME_TABLE_BYTES)}-byte budget.`,
      );
    const table = await readExactly(
      read,
      dataStart,
      header.size,
      "ar GNU long-name table",
    );
    return { name: "//", skipped: 0, names: table };
  }
  const gnu = /^\/([0-9]+)$/u.exec(header.rawName);
  if (gnu !== null)
    return {
      name: gnuLongName(names, Number(gnu[1]), offset),
      skipped: 0,
      names,
    };
  if (header.rawName === "/" || header.rawName === "/SYM64/")
    return { name: header.rawName, skipped: 0, names };
  // GNU terminates short names with "/"; BSD and dpkg-deb do not.
  const short = header.rawName.endsWith("/")
    ? header.rawName.slice(0, -1)
    : header.rawName;
  if (short === "")
    throw new ArFormatError(offset, "ar member header has an empty name.");
  return {
    name: decodeName(Buffer.from(short, "latin1"), offset),
    skipped: 0,
    names,
  };
};

/** Skip the "\n" that pads odd-sized member data; absent only at the end of the file. */
const skipPadding = async (
  read: PositionalRead,
  offset: number,
  size: number,
  name: string,
): Promise<number> => {
  if (offset % 2 === 0 || offset >= size) return offset;
  const pad = await readExactly(read, offset, 1, "ar padding byte");
  if (pad[0] !== 0x0a)
    throw new ArFormatError(
      offset,
      `ar padding byte after member ${JSON.stringify(name)} is 0x${(pad[0] ?? 0).toString(16)}, not "\\n".`,
    );
  return offset + 1;
};

/**
 * Walk a Unix `ar` archive: global magic, 60-byte headers, even padding.
 * GNU long names (`//` table, `/N` references, trailing `/`) and BSD long
 * names (`#1/N`, name bytes counted in the size) are resolved; special
 * members (`/`, `//`, `__.SYMDEF`) are listed under their stored names.
 * Bytes after the last member that cannot hold a header are reported as
 * `trailing_bytes`, never interpreted.
 */
export const readArMembers = async (
  read: PositionalRead,
  size: number,
): Promise<{
  readonly members: readonly ArMember[];
  readonly trailing_bytes: number;
}> => {
  if (size < MAGIC.length)
    throw new ArFormatError(
      0,
      `File is ${String(size)} bytes, shorter than the 8-byte ar magic.`,
    );
  const magic = latin1.decode(await readExactly(read, 0, 8, "ar magic"));
  if (magic === THIN_MAGIC)
    throw new ArFormatError(
      0,
      "Thin ar archive: member data lives in other files and is not read.",
    );
  if (magic !== MAGIC)
    throw new ArFormatError(
      0,
      'File does not start with the ar magic "!<arch>\\n".',
    );
  const members: ArMember[] = [];
  let names: Uint8Array | null = null;
  let offset = MAGIC.length;
  let trailing = 0;
  while (offset < size) {
    if (size - offset < HEADER_BYTES) {
      trailing = size - offset;
      break;
    }
    if (members.length >= MAXIMUM_MEMBERS)
      throw new ArFormatError(
        offset,
        `ar archive has more than ${String(MAXIMUM_MEMBERS)} members.`,
      );
    const header = parseHeader(
      await readExactly(read, offset, HEADER_BYTES, "ar member header"),
      offset,
    );
    const dataStart = offset + HEADER_BYTES;
    if (header.size > size - dataStart)
      throw new ArFormatError(
        offset + 48,
        `ar member ${JSON.stringify(header.rawName)} declares ${String(header.size)} bytes but only ${String(size - dataStart)} remain.`,
      );
    const resolved = await resolveName(read, header, offset, names);
    names = resolved.names;
    const name = resolved.name;
    const dataOffset = dataStart + resolved.skipped;
    const dataSize = header.size - resolved.skipped;
    members.push({
      name,
      header_offset: offset,
      data_offset: dataOffset,
      size: dataSize,
      mtime: header.mtime,
      uid: header.uid,
      gid: header.gid,
      mode: header.mode,
    });
    offset = await skipPadding(read, dataStart + header.size, size, name);
  }
  return { members, trailing_bytes: trailing };
};

export type DebControlCompression = "none" | "gzip" | "xz" | "zstd";
export type DebDataCompression = DebControlCompression | "bzip2" | "lzma";

/** Debian member layout check: debian-binary first ("2.0\n"), control.tar[.gz|.xz|.zst], data.tar[.gz|.xz|.zst|.bz2|.lzma], optional _gpg* signature members, others listed. */
export interface DebLayout {
  readonly format_version: string | null;
  readonly control: {
    readonly member: ArMember;
    readonly compression: DebControlCompression;
  } | null;
  readonly data: {
    readonly member: ArMember;
    readonly compression: DebDataCompression;
  } | null;
  readonly signatures: readonly ArMember[];
  readonly other: readonly ArMember[];
  readonly problems: readonly string[];
}

/** Extensions dpkg-deb accepts per member (deb(5), dpkg-deb extract). */
const CONTROL_EXTENSIONS: ReadonlyMap<string, DebControlCompression> = new Map([
  ["", "none"],
  [".gz", "gzip"],
  [".xz", "xz"],
  [".zst", "zstd"],
]);
const DATA_EXTENSIONS: ReadonlyMap<string, DebDataCompression> = new Map([
  ...CONTROL_EXTENSIONS,
  [".bz2", "bzip2"],
  [".lzma", "lzma"],
]);

const formatVersion = (
  bytes: Uint8Array | null,
  problems: string[],
): string | null => {
  if (bytes === null) return null;
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    problems.push(
      `debian-binary is not valid UTF-8 (bytes ${Buffer.from(bytes.subarray(0, 64)).toString("hex")}).`,
    );
    return null;
  }
  const newline = text.indexOf("\n");
  if (newline < 0) {
    problems.push("debian-binary has no newline after the format version.");
    return text;
  }
  const version = text.slice(0, newline);
  const match = /^([0-9]+)\.([0-9]+)$/u.exec(version);
  if (match === null)
    problems.push(
      `debian-binary format version ${JSON.stringify(version)} is not "major.minor".`,
    );
  else if (match[1] !== "2")
    problems.push(
      `debian-binary declares format ${version}; dpkg reads major version 2 only.`,
    );
  return version;
};

interface LayoutState {
  control: DebLayout["control"];
  data: DebLayout["data"];
  readonly signatures: ArMember[];
  readonly other: ArMember[];
  readonly problems: string[];
}

const placeControl = (state: LayoutState, member: ArMember): void => {
  const name = JSON.stringify(member.name);
  const compression = CONTROL_EXTENSIONS.get(
    member.name.slice("control.tar".length),
  );
  if (compression === undefined)
    state.problems.push(
      `Control member ${name} uses a compression dpkg-deb does not accept for control.tar.`,
    );
  else if (state.control !== null)
    state.problems.push(`Second control member ${name}.`);
  else if (state.data !== null)
    state.problems.push(`Control member ${name} comes after the data member.`);
  if (
    compression !== undefined &&
    state.control === null &&
    state.data === null
  )
    state.control = { member, compression };
  else state.other.push(member);
};

const placeData = (state: LayoutState, member: ArMember): void => {
  const name = JSON.stringify(member.name);
  const compression = DATA_EXTENSIONS.get(member.name.slice("data.tar".length));
  if (compression === undefined)
    state.problems.push(
      `Data member ${name} uses a compression dpkg-deb does not know.`,
    );
  else if (state.data !== null)
    state.problems.push(`Second data member ${name}.`);
  else if (state.control === null)
    state.problems.push(`Data member ${name} comes before any control member.`);
  if (compression !== undefined && state.data === null)
    state.data = { member, compression };
  else state.other.push(member);
};

const placeMember = (
  state: LayoutState,
  member: ArMember,
  index: number,
): void => {
  if (member.name === "debian-binary") {
    if (index === 0) return;
    state.problems.push(
      `"debian-binary" appears as member ${String(index + 1)}, not first.`,
    );
    state.other.push(member);
  } else if (member.name.startsWith("_"))
    (member.name.startsWith("_gpg") ? state.signatures : state.other).push(
      member,
    );
  else if (member.name.startsWith("control.tar")) placeControl(state, member);
  else if (member.name.startsWith("data.tar")) placeData(state, member);
  else {
    if (state.data === null)
      state.problems.push(
        `Member ${JSON.stringify(member.name)} comes before data.tar; dpkg-deb only skips such members when their names start with "_".`,
      );
    state.other.push(member);
  }
};

/**
 * Check the member order dpkg-deb enforces: debian-binary, then
 * control.tar*, then data.tar*. Members whose names start with "_" may sit
 * anywhere (`_gpg*` are debsigs/dpkg-sig signatures); anything else before
 * data.tar is a problem, and members after data.tar are listed, as deb(5)
 * tells readers to ignore them.
 */
export const debLayout = (
  members: readonly ArMember[],
  debianBinary: Uint8Array | null,
): DebLayout => {
  const state: LayoutState = {
    control: null,
    data: null,
    signatures: [],
    other: [],
    problems: [],
  };
  const first = members[0];
  if (first === undefined) state.problems.push("Archive has no members.");
  else if (first.name !== "debian-binary")
    state.problems.push(
      `First member is ${JSON.stringify(first.name)}, not "debian-binary".`,
    );
  for (const [index, member] of members.entries())
    placeMember(state, member, index);
  if (state.control === null) state.problems.push("No control.tar member.");
  if (state.data === null) state.problems.push("No data.tar member.");
  return {
    format_version: formatVersion(debianBinary, state.problems),
    control: state.control,
    data: state.data,
    signatures: state.signatures,
    other: state.other,
    problems: state.problems,
  };
};
