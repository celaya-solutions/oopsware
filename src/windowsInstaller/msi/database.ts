import { CfbFormatError, type CfbEntry, type CompoundFile } from "../cfb.js";
import { MSI_LIMITS, Problems } from "./bounds.js";
import { StringPool } from "./stringPool.js";
import { decodeMsiStreamName } from "./streamNames.js";
import { parseColumn, SYSTEM_COLUMNS, TableDecoder } from "./tableDecoder.js";

/**
 * A Windows Installer database read the way msitools' libmsi and Windows
 * read it: the string pool (_StringPool + _StringData), _Tables, _Columns,
 * and each table's stream decoded column by column (tableDecoder.ts).
 * Nothing is evaluated: conditions and formatted text stay as stored.
 */

/** A binary (`v0`) cell: the stream the row's keys name. */
export interface MsiStreamValue {
  readonly stream: string;
}

export type MsiValue = number | string | null | MsiStreamValue;

export interface MsiColumn {
  readonly name: string;
  readonly type: "integer" | "string" | "binary";
  /** Bytes per stored cell. */
  readonly bytes: number;
  readonly nullable: boolean;
  readonly key: boolean;
  readonly localizable: boolean;
  /** msiinfo's type code, e.g. s72, i2, S255, L255, I4, v0. */
  readonly declared: string;
  /** The stored _Columns type word. */
  readonly code: number;
}

export interface MsiTable {
  readonly name: string;
  readonly columns: readonly MsiColumn[];
  readonly rows: readonly (readonly MsiValue[])[];
}

export interface MsiStream {
  /** The decoded name, e.g. "oops.cab", "Binary.SetupDll", "\u0005SummaryInformation". */
  readonly name: string;
  readonly entry: CfbEntry;
}

/** A structural problem in one MSI stream that stops the database from being read. */
export class MsiFormatError extends Error {
  constructor(
    readonly stream: string,
    message: string,
  ) {
    super(message);
    this.name = "MsiFormatError";
  }
}

interface Parts {
  readonly codepage: number;
  readonly strref: number;
  readonly tables: Map<string, MsiTable>;
  readonly streams: readonly MsiStream[];
  readonly storages: readonly string[];
  readonly problems: readonly string[];
}

type DeclaredColumns = Map<
  string,
  { number: number; name: string; code: number }[]
>;

const SYSTEM_STREAMS = new Set([
  "_Tables",
  "_Columns",
  "_StringPool",
  "_StringData",
]);

/** A compound file problem with its quoted stream names (`Stream <id> "<stored>"`) decoded. */
const withDecodedNames = (problem: string): string =>
  problem.replace(
    /Stream (\d+) ("(?:[^"\\]|\\.)*")/gu,
    (_whole, id: string, quoted: string) => {
      const decoded = decodeMsiStreamName(JSON.parse(quoted) as string);
      return `${decoded.table ? "Table stream" : "Stream"} ${id} ${JSON.stringify(decoded.name)}`;
    },
  );

/** Root-level entries by kind: table streams (0x4840 names), other streams, storages. */
const classify = (
  file: CompoundFile,
): {
  tableStreams: Map<string, CfbEntry>;
  streams: MsiStream[];
  storages: string[];
} => {
  const tableStreams = new Map<string, CfbEntry>();
  const streams: MsiStream[] = [];
  const storages: string[] = [];
  for (const entry of file.entries) {
    if (entry.path.length !== 1) continue;
    const decoded = decodeMsiStreamName(entry.name);
    if (entry.type === "storage") storages.push(decoded.name);
    else if (decoded.table) tableStreams.set(decoded.name, entry);
    else streams.push(Object.freeze({ name: decoded.name, entry }));
  }
  return { tableStreams, streams, storages };
};

/** _Columns rows grouped by table; rows with a null or unresolved cell are counted and skipped. */
const declaredColumns = (
  columns: MsiTable,
  problems: Problems,
): DeclaredColumns => {
  const declared: DeclaredColumns = new Map();
  let skipped = 0;
  for (const [table, number, name, code] of columns.rows) {
    if (
      typeof table !== "string" ||
      typeof number !== "number" ||
      typeof name !== "string" ||
      typeof code !== "number"
    ) {
      skipped += 1;
      continue;
    }
    const list = declared.get(table) ?? [];
    list.push({ number, name, code: code & 0xffff });
    declared.set(table, list);
  }
  if (skipped > 0)
    problems.add(
      `${String(skipped)} _Columns rows have a null or unresolved cell; they are skipped.`,
    );
  return declared;
};

/** Reads table streams under the size limit; a missing stream is an empty table, an unreadable one a problem. */
class TableStreams {
  constructor(
    readonly file: CompoundFile,
    readonly streams: ReadonlyMap<string, CfbEntry>,
    readonly problems: Problems,
  ) {}

  async required(name: string, limit: number): Promise<Uint8Array> {
    const entry = this.streams.get(name);
    if (entry === undefined)
      throw new MsiFormatError(
        name,
        `The database has no ${name} stream; it is not a Windows Installer database.`,
      );
    if (entry.size > limit)
      throw new MsiFormatError(
        name,
        `${name} is ${String(entry.size)} bytes; at most ${String(limit)} are read.`,
      );
    return this.file.read(entry, limit);
  }

  async table(name: string): Promise<Uint8Array | null> {
    const entry = this.streams.get(name);
    if (entry === undefined) return null;
    if (entry.size > MSI_LIMITS.tableBytes) {
      this.problems.add(
        `Table ${name}'s stream is ${String(entry.size)} bytes; at most ${String(MSI_LIMITS.tableBytes)} are read, so its rows are not decoded.`,
      );
      return null;
    }
    try {
      return await this.file.read(entry, MSI_LIMITS.tableBytes);
    } catch (cause: unknown) {
      if (!(cause instanceof CfbFormatError)) throw cause;
      this.problems.add(
        `Table ${name}'s stream cannot be read: ${cause.message}`,
      );
      return null;
    }
  }
}

/** Every table _Tables lists, columns from _Columns ordered by Number. */
const readTables = async (
  names: readonly string[],
  declared: DeclaredColumns,
  decoder: TableDecoder,
  streams: TableStreams,
): Promise<Map<string, MsiTable>> => {
  const tables = new Map<string, MsiTable>();
  const problems = decoder.problems;
  for (const name of names) {
    if (tables.has(name)) {
      problems.add(`_Tables lists ${name} twice.`);
      continue;
    }
    const list = (declared.get(name) ?? []).sort(
      (left, right) => left.number - right.number,
    );
    if (list.length === 0)
      problems.add(`Table ${name} has no columns in _Columns.`);
    if (list.some((column, index) => column.number !== index + 1))
      problems.add(
        `Table ${name}'s column numbers are ${list.map((column) => String(column.number)).join(", ")}, not 1..${String(list.length)}.`,
      );
    const parsed = list.map((column) =>
      parseColumn(column.name, column.code, decoder.strings.strref),
    );
    for (const { problem } of parsed)
      if (problem !== null) problems.add(`Table ${name}: ${problem}.`);
    tables.set(
      name,
      decoder.decode(
        name,
        parsed.map(({ column }) => column),
        await streams.table(name),
      ),
    );
  }
  for (const name of declared.keys())
    if (!tables.has(name))
      problems.add(
        `_Columns declares columns for ${name}, which _Tables does not list.`,
      );
  for (const name of streams.streams.keys())
    if (!tables.has(name) && !SYSTEM_STREAMS.has(name))
      problems.add(
        `Table stream ${name} is not listed in _Tables; it is not decoded.`,
      );
  return tables;
};

export class MsiDatabase {
  readonly codepage: number;
  /** Bytes per string reference: 2, or 3 when the pool marks long references. */
  readonly strref: number;
  readonly streams: readonly MsiStream[];
  readonly storages: readonly string[];
  readonly problems: readonly string[];
  readonly #tables: Map<string, MsiTable>;

  private constructor(parts: Parts) {
    this.codepage = parts.codepage;
    this.strref = parts.strref;
    this.#tables = parts.tables;
    this.streams = parts.streams;
    this.storages = parts.storages;
    this.problems = parts.problems;
  }

  /** Tables listed in _Tables, in that order, then _Tables and _Columns. */
  get tables(): ReadonlyMap<string, MsiTable> {
    return this.#tables;
  }

  table(name: string): MsiTable | null {
    return this.#tables.get(name) ?? null;
  }

  rows(name: string): readonly Readonly<Record<string, MsiValue>>[] {
    const table = this.#tables.get(name);
    if (table === undefined) return [];
    return table.rows.map((row) =>
      Object.freeze(
        Object.fromEntries(
          table.columns.map((column, index) => [
            column.name,
            row[index] ?? null,
          ]),
        ),
      ),
    );
  }

  /** The stream with this decoded name, or null. */
  stream(name: string): CfbEntry | null {
    return this.streams.find((stream) => stream.name === name)?.entry ?? null;
  }

  static async open(file: CompoundFile): Promise<MsiDatabase> {
    const problems = new Problems();
    for (const problem of file.problems)
      problems.add(`Compound file: ${withDecodedNames(problem)}`);
    const { tableStreams, streams, storages } = classify(file);
    const reader = new TableStreams(file, tableStreams, problems);
    const strings = StringPool.read(
      await reader.required("_StringPool", MSI_LIMITS.stringPoolBytes),
      await reader.required("_StringData", MSI_LIMITS.stringDataBytes),
      problems,
    );
    const decoder = new TableDecoder(strings, problems);
    const system = async (
      name: keyof typeof SYSTEM_COLUMNS,
    ): Promise<MsiTable> =>
      decoder.decode(
        name,
        SYSTEM_COLUMNS[name].map(
          ([column, code]) => parseColumn(column, code, strings.strref).column,
        ),
        await reader.table(name),
      );
    const tablesTable = await system("_Tables");
    const columnsTable = await system("_Columns");
    const names = tablesTable.rows
      .map(([name]) => name)
      .filter((name): name is string => typeof name === "string");
    if (names.length !== tablesTable.rows.length)
      problems.add(
        "A _Tables row has a null or unresolved name; it is skipped.",
      );
    const tables = await readTables(
      names,
      declaredColumns(columnsTable, problems),
      decoder,
      reader,
    );
    tables.set("_Tables", tablesTable);
    tables.set("_Columns", columnsTable);
    decoder.checkStreams(tables, new Set(streams.map((stream) => stream.name)));
    return new MsiDatabase({
      codepage: strings.codepage,
      strref: strings.strref,
      tables,
      streams: Object.freeze(streams),
      storages: Object.freeze(storages),
      problems: problems.done(),
    });
  }
}
