import { MSI_LIMITS, type Problems } from "./bounds.js";
import type { MsiColumn, MsiTable, MsiValue } from "./database.js";
import type { StringPool } from "./stringPool.js";

/** _Columns type word bits (msidefs.h icd*, libmsi MSITYPE_*). */
const VALID = 0x0100;
const LOCALIZABLE = 0x0200;
const STRING = 0x0800;
const NULLABLE = 0x1000;
const KEY = 0x2000;
const TEMPORARY = 0x4000;
const UNKNOWN = 0x8000;

const isBinary = (code: number): boolean =>
  (code & ~NULLABLE) === (STRING | VALID);

/** msiinfo's spelling of a type word (libmsi msi_set_record_type_string). */
const declaredType = (code: number): string => {
  const letter = isBinary(code)
    ? "v"
    : code & LOCALIZABLE
      ? "l"
      : code & UNKNOWN
        ? "f"
        : code & STRING
          ? "s"
          : "i";
  return `${code & NULLABLE ? letter.toUpperCase() : letter}${String(code & 0xff)}`;
};

/**
 * A column from its type word, sized as libmsi sizes it (binary 2, string
 * the reference width, integer 2 when it declares at most 2 bytes, else
 * 4), with a note when the word is one no stored column uses.
 */
export const parseColumn = (
  name: string,
  code: number,
  strref: number,
): { column: MsiColumn; problem: string | null } => {
  const binary = isBinary(code);
  const text = !binary && (code & STRING) !== 0;
  const size = code & 0xff;
  let problem: string | null = null;
  if ((code & (TEMPORARY | UNKNOWN)) !== 0 || (code & VALID) === 0)
    problem = `column ${name} has type word 0x${code.toString(16)}, which no stored column uses`;
  else if (!binary && !text && size !== 2 && size !== 4)
    problem = `column ${name} declares a ${String(size)}-byte integer; it is read as ${size <= 2 ? "2" : "4"} bytes, as msitools reads it`;
  const column: MsiColumn = {
    name,
    type: binary ? "binary" : text ? "string" : "integer",
    bytes: binary ? 2 : text ? strref : size <= 2 ? 2 : 4,
    nullable: (code & NULLABLE) !== 0,
    key: (code & KEY) !== 0,
    localizable: (code & LOCALIZABLE) !== 0,
    declared: declaredType(code),
    code,
  };
  return { column, problem };
};

/** The columns libmsi and Windows build in for the two system tables. */
export const SYSTEM_COLUMNS = {
  _Tables: [["Name", STRING | VALID | KEY | 64]],
  _Columns: [
    ["Table", STRING | VALID | KEY | 64],
    ["Number", VALID | KEY | 2],
    ["Name", STRING | VALID | 64],
    ["Type", VALID | 2],
  ],
} as const;

const u16 = (bytes: Uint8Array, at: number): number =>
  (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);

const cell = (bytes: Uint8Array, at: number, width: number): number =>
  width === 2
    ? u16(bytes, at)
    : width === 3
      ? u16(bytes, at) | ((bytes[at + 2] ?? 0) << 16)
      : (u16(bytes, at) | (u16(bytes, at + 2) << 16)) >>> 0;

const freeze = (
  name: string,
  columns: readonly MsiColumn[],
  rows: readonly (readonly MsiValue[])[],
): MsiTable =>
  Object.freeze({
    name,
    columns: Object.freeze([...columns]),
    rows: Object.freeze(rows.map((row) => Object.freeze(row))),
  });

/**
 * Table streams: cells stored column by column, integers biased (2-byte
 * minus 0x8000, 4-byte xor 0x80000000; 0 is null), strings as pool IDs
 * (0 is null), and binary cells naming the stream "Table.key1.key2..."
 * (libmsi msi_stream_name), whatever their stored value.
 */
export class TableDecoder {
  #cells = 0;

  constructor(
    readonly strings: StringPool,
    readonly problems: Problems,
  ) {}

  decode(
    name: string,
    columns: readonly MsiColumn[],
    bytes: Uint8Array | null,
  ): MsiTable {
    if (bytes === null || bytes.length === 0 || columns.length === 0)
      return freeze(name, columns, []);
    const rowBytes = columns.reduce((sum, column) => sum + column.bytes, 0);
    // Cells are stored column by column, so a partial row moves every column after the first.
    if (bytes.length % rowBytes !== 0) {
      this.problems.add(
        `Table ${name}'s stream is ${String(bytes.length)} bytes, not a multiple of its ${String(rowBytes)}-byte rows; its rows are not decoded.`,
      );
      return freeze(name, columns, []);
    }
    const count = bytes.length / rowBytes;
    if (this.#cells + count * columns.length > MSI_LIMITS.cells) {
      this.problems.add(
        `Table ${name} has ${String(count)} rows, past the ${String(MSI_LIMITS.cells)}-cell budget; its rows are not decoded.`,
      );
      return freeze(name, columns, []);
    }
    this.#cells += count * columns.length;
    const rows: MsiValue[][] = Array.from({ length: count }, () => []);
    let unresolved = 0;
    let start = 0;
    for (const column of columns) {
      for (let row = 0; row < count; row += 1) {
        const value = this.value(
          column,
          cell(bytes, start * count + row * column.bytes, column.bytes),
        );
        if (value === undefined) unresolved += 1;
        rows[row]?.push(value ?? null);
      }
      start += column.bytes;
    }
    if (unresolved > 0)
      this.problems.add(
        `Table ${name} has ${String(unresolved)} string references the string pool does not hold; they read as null.`,
      );
    this.nameStreams(name, columns, rows);
    return freeze(name, columns, rows);
  }

  /** One cell; undefined when a string reference has no string. */
  value(column: MsiColumn, raw: number): MsiValue | undefined {
    if (column.type === "binary" || raw === 0) return null;
    if (column.type === "string") return this.strings.lookup(raw);
    return column.bytes === 2 ? raw - 0x8000 : (raw ^ 0x80000000) | 0;
  }

  nameStreams(
    name: string,
    columns: readonly MsiColumn[],
    rows: MsiValue[][],
  ): void {
    const keys = columns.flatMap((column, index) =>
      column.key ? [index] : [],
    );
    const binary = columns.flatMap((column, index) =>
      column.type === "binary" ? [index] : [],
    );
    if (binary.length === 0) return;
    for (const row of rows) {
      const stream = [
        name,
        ...keys.map((index) => String(row[index] ?? "")),
      ].join(".");
      for (const index of binary) row[index] = Object.freeze({ stream });
    }
  }

  /** Binary cells whose stream is absent read as null, as libmsi exports them. */
  checkStreams(
    tables: Map<string, MsiTable>,
    present: ReadonlySet<string>,
  ): void {
    for (const [name, table] of tables) {
      let missing = 0;
      const rows = table.rows.map((row) =>
        row.map((value) => {
          if (
            value === null ||
            typeof value !== "object" ||
            present.has(value.stream)
          )
            return value;
          missing += 1;
          return null;
        }),
      );
      if (missing === 0) continue;
      this.problems.add(
        `Table ${name} has ${String(missing)} binary cells whose stream is not in the database; they read as null.`,
      );
      tables.set(name, freeze(name, table.columns, rows));
    }
  }
}
