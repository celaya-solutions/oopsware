import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { jsonParts } from "../domain/jsonSerialization.js";
import {
  SQLITE_ROW_LIMIT_DEFAULT,
  sqliteSchemaScope,
  type InspectSqliteDatabaseInput,
  type SqliteDatabase,
  type SqliteValue,
} from "../domain/sqlite/sqliteDatabase.js";
import {
  SQLITE_DATABASE_LIMITS,
  SqliteInspectionFailure,
} from "./SqliteDatabaseLimits.js";

const natural = z
  .bigint()
  .nonnegative()
  .max(BigInt(Number.MAX_SAFE_INTEGER))
  .transform(Number);
const schemaRow = z.object({
  type: z.enum(["table", "index", "view", "trigger"]),
  name: z.instanceof(Uint8Array),
  tbl_name: z.instanceof(Uint8Array),
  rootpage: natural,
  sql: z.instanceof(Uint8Array).nullable().optional(),
});
const tableRow = z.object({
  schema: z.string(),
  name: z.string(),
  type: z.enum(["table", "view", "virtual", "shadow"]),
  ncol: natural,
  wr: z.bigint(),
  strict: z.bigint(),
});
const columnRow = z.object({
  cid: natural,
  name: z.instanceof(Uint8Array),
  type: z.instanceof(Uint8Array),
  notnull: z.bigint(),
  dflt_value: z.instanceof(Uint8Array).nullable(),
  pk: natural,
  hidden: z
    .bigint()
    .transform(Number)
    .pipe(z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)])),
});
const keyRow = z.object({ name: z.instanceof(Uint8Array) });
const aliasRow = z.object({ name: z.string() });
export const arrayRow = z.array(
  z.union([
    z.null(),
    z.bigint(),
    z.custom<number>(
      (value) => typeof value === "number" && !Number.isNaN(value),
    ),
    z.string(),
  ]),
);
const encodingSchema = z.enum(["UTF-8", "UTF-16le", "UTF-16be"]);
const cellByteLengths = z.array(z.bigint().nonnegative());
export type DatabaseEncoding = z.output<typeof encodingSchema>;
type Inspection = Pick<
  SqliteDatabase,
  "engine" | "database_encoding" | "schema" | "rows" | "limitations"
>;
type SelectedTableFacts = Pick<
  SqliteDatabase["schema"]["tables"][number],
  "name" | "kind" | "columns" | "without_rowid"
>;
type RowOrder = NonNullable<SqliteDatabase["rows"]>["order"];

export class OutputBudget {
  #bytes = 1024;
  retain(value: unknown): void {
    // Count bounded encoded parts, including escapes, without allocating a
    // document-sized string just to decide whether it fits the reply.
    this.#bytes += 1;
    for (const part of jsonParts(value)) {
      this.#bytes += Buffer.byteLength(part);
      if (this.#bytes > SQLITE_DATABASE_LIMITS.outputBytes)
        throw new SqliteInspectionFailure(
          "output-limit",
          "Complete SQLite evidence exceeds the 16 MiB JSON reply budget; no partial success was returned.",
        );
    }
  }
  beforeDecode(row: z.output<typeof arrayRow>): void {
    let minimumBytes = this.#bytes;
    for (const value of row)
      if (typeof value === "string") minimumBytes += Buffer.byteLength(value);
    if (minimumBytes > SQLITE_DATABASE_LIMITS.outputBytes)
      throw new SqliteInspectionFailure(
        "output-limit",
        "Selected cells exceed the 16 MiB reply budget before text/hex expansion.",
      );
  }
  beforeProjection(lengths: readonly bigint[]): void {
    const encodedBytes = lengths.reduce(
      (total, length) => total + length * 2n,
      BigInt(lengths.length * 64),
    );
    if (
      encodedBytes + BigInt(this.#bytes) >
      BigInt(SQLITE_DATABASE_LIMITS.outputBytes)
    )
      throw new SqliteInspectionFailure(
        "output-limit",
        "Selected row byte lengths exceed the 16 MiB reply budget before hex projection.",
      );
  }
}
const quoteIdentifier = (name: string): string =>
  `"${name.replaceAll('"', '""')}"`;
const missingSelectedTable = (name: string): SqliteInspectionFailure =>
  new SqliteInspectionFailure(
    "selection",
    `Selected ordinary table does not exist with that exact name: ${name}`,
  );
// SQLite folds only ASCII letters when matching virtual/shadow table names.
const sqliteIdentifierKey = (name: string): string =>
  name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
export const textEncoding = (encoding: DatabaseEncoding): string =>
  encoding === "UTF-8"
    ? "utf-8"
    : encoding === "UTF-16le"
      ? "utf-16le"
      : "utf-16be";

const decodeSchemaText = (
  value: Uint8Array,
  encoding: DatabaseEncoding,
  label: string,
): string => {
  try {
    return new TextDecoder(textEncoding(encoding), {
      fatal: true,
      ignoreBOM: true,
    }).decode(value);
  } catch (cause: unknown) {
    throw new SqliteInspectionFailure(
      "format",
      `SQLite schema ${label} contains malformed ${encoding} text: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
};

export const cell = (
  value: z.output<typeof arrayRow>[number],
  encoding: DatabaseEncoding,
): SqliteValue => {
  if (value === null) return { type: "null" };
  if (typeof value === "bigint")
    return { type: "integer", value: String(value) };
  if (typeof value === "number")
    return {
      type: "real",
      value:
        value === Infinity
          ? "Infinity"
          : value === -Infinity
            ? "-Infinity"
            : Object.is(value, -0)
              ? "-0"
              : value,
    };
  const hex = value.slice(1).toLowerCase();
  if (!/^(?:[0-9a-f]{2})*$/.test(hex))
    throw new SqliteInspectionFailure(
      "format",
      "SQLite returned an invalid encoded cell.",
    );
  if (value[0] === "b") return { type: "blob", hex };
  if (value[0] !== "t")
    throw new SqliteInspectionFailure(
      "format",
      "SQLite returned an unknown encoded cell type.",
    );
  return {
    type: "text",
    value: new TextDecoder(textEncoding(encoding), { ignoreBOM: true }).decode(
      Buffer.from(hex, "hex"),
    ),
    bytes_hex: hex,
    encoding,
  };
};

const readColumns = (
  db: DatabaseSync,
  name: string,
  context: {
    readonly budget: OutputBudget;
    readonly encoding: DatabaseEncoding;
    readonly selectedColumns?: readonly string[] | undefined;
  },
): SqliteDatabase["schema"]["tables"][number]["columns"] => {
  const { budget, encoding, selectedColumns } = context;
  const columns: SqliteDatabase["schema"]["tables"][number]["columns"] = [];
  // This private read-only connection has an empty temp schema. Qualifying the
  // built-in there prevents stored main tables/views from shadowing it; the
  // final argument selects main's metadata. Decode bytes before names become
  // SQL identifiers. Inventory-only row subsets compare exact encoded names
  // first, so an unrelated malformed identifier cannot alias a requested one.
  const selection =
    selectedColumns === undefined
      ? ""
      : ` WHERE CAST(name AS BLOB) IN (${selectedColumns.map(() => "CAST(? AS BLOB)").join(", ")})`;
  for (const raw of db
    .prepare(
      `SELECT cid, CAST(name AS BLOB) AS name, CAST(type AS BLOB) AS type, "notnull", CAST(dflt_value AS BLOB) AS dflt_value, pk, hidden FROM temp.pragma_table_xinfo(?, 'main')${selection}`,
    )
    .iterate(name, ...(selectedColumns ?? []))) {
    const value = columnRow.parse(raw);
    const column = {
      cid: value.cid,
      name: decodeSchemaText(value.name, encoding, "column name"),
      declared_type: decodeSchemaText(value.type, encoding, "column type"),
      not_null: value.notnull !== 0n,
      default_sql:
        value.dflt_value === null
          ? null
          : decodeSchemaText(value.dflt_value, encoding, "column default"),
      primary_key_position: value.pk,
      hidden: value.hidden,
    };
    budget.retain(column);
    columns.push(column);
  }
  // Sort only retained facts, without copying untrusted text into native sorter records.
  return columns.sort((left, right) => left.cid - right.cid);
};

const readSchema = (
  db: DatabaseSync,
  input: InspectSqliteDatabaseInput,
  context: {
    readonly budget: OutputBudget;
    readonly limitations: string[];
    readonly encoding: DatabaseEncoding;
  },
): {
  schema: SqliteDatabase["schema"];
  selectedTable: SelectedTableFacts | undefined;
} => {
  const { budget, limitations, encoding } = context;
  const scope = sqliteSchemaScope(input);
  const selectedName = scope === "selected_table" ? input.table : undefined;
  if (scope === "selected_table" && selectedName === undefined)
    throw new SqliteInspectionFailure(
      "selection",
      "Selected-table schema scope requires an exact table name.",
    );
  let selectedTable: SelectedTableFacts | undefined;
  const metadata = new Map<string, z.output<typeof tableRow>>();
  // Names bound the minimum eventual schema output while metadata is collected.
  // The full schema objects below account for them in the actual reply budget.
  const metadataBudget = new OutputBudget();
  for (const raw of db.prepare("PRAGMA main.table_list").iterate()) {
    const value = tableRow.parse(raw);
    if (value.schema === "main") {
      metadataBudget.retain(value.name);
      metadata.set(value.name, value);
    }
  }
  // A trigger stores its target as written in CREATE TRIGGER, which SQLite
  // resolves by ASCII case folding; report the stored table or view name.
  // A selected-table scan returns only the selected table's dependents, and
  // other scopes fold stored names once, only when a spelling differs.
  let foldedNames: Map<string, string> | undefined;
  const triggerTable = (written: string): string => {
    if (selectedName !== undefined) return selectedName;
    if (metadata.has(written)) return written;
    foldedNames ??= new Map(
      [...metadata.keys()].map((name) => [sqliteIdentifierKey(name), name]),
    );
    return foldedNames.get(sqliteIdentifierKey(written)) ?? written;
  };
  const unresolvedVirtualTables = [...metadata.values()]
    .filter((value) => value.type === "virtual" && value.ncol === 0)
    .map((value) => ({
      name: value.name,
      prefix: sqliteIdentifierKey(`${value.name}_`),
    }));
  const shadowParentOf = (
    name: string,
    listed: z.output<typeof tableRow>,
  ): (typeof unresolvedVirtualTables)[number] | undefined => {
    if (listed.type !== "table") return undefined;
    const identifier = sqliteIdentifierKey(name);
    return unresolvedVirtualTables.find((parent) =>
      identifier.startsWith(parent.prefix),
    );
  };
  const selected =
    selectedName === undefined ? undefined : metadata.get(selectedName);
  if (selectedName !== undefined && selected === undefined)
    throw missingSelectedTable(selectedName);
  const selectedShadowParent =
    selectedName === undefined || selected === undefined
      ? undefined
      : shadowParentOf(selectedName, selected);
  // NOCASE folds only ASCII letters, as SQLite does when it resolves the
  // table named by an index or trigger. Fold only for an ordinary table whose
  // rows can be selected; a selection refused later keeps the exact filter,
  // so its failure does not depend on declarations under another spelling.
  const foldDependents =
    selected?.type === "table" && selectedShadowParent === undefined;
  const schema: SqliteDatabase["schema"] = {
    scope,
    completeness: "complete",
    tables: [],
    indexes: [],
    views: [],
    triggers: [],
  };
  // Raw bytes preserve text without hex expansion; avoid sorter records that
  // duplicate large names or definitions beyond SQLite's native record limit.
  const declaration = scope === "inventory" ? "" : ", CAST(sql AS BLOB) AS sql";
  const selection =
    scope === "selected_table"
      ? ` WHERE tbl_name = ? COLLATE ${foldDependents ? "NOCASE" : "BINARY"}`
      : "";
  const statement = db.prepare(
    `SELECT type, CAST(name AS BLOB) AS name, CAST(tbl_name AS BLOB) AS tbl_name, rootpage${declaration} FROM main.sqlite_schema${selection}`,
  );
  for (const raw of statement.iterate(
    ...(selectedName === undefined ? [] : [selectedName]),
  )) {
    const parsed = schemaRow.parse(raw);
    const value = {
      ...parsed,
      name: decodeSchemaText(parsed.name, encoding, "name"),
      tbl_name: decodeSchemaText(parsed.tbl_name, encoding, "table"),
      sql:
        parsed.sql === undefined
          ? undefined
          : parsed.sql === null
            ? null
            : decodeSchemaText(parsed.sql, encoding, "sql"),
    };
    if (value.type === "table") {
      const listed = metadata.get(value.name);
      if (listed === undefined || listed.type === "view")
        throw new SqliteInspectionFailure(
          "format",
          `SQLite schema/table inventory mismatch: ${value.name}`,
        );
      const possibleShadowParent =
        value.name === selectedName
          ? selectedShadowParent
          : shadowParentOf(value.name, listed);
      const table: SqliteDatabase["schema"]["tables"][number] = {
        name: value.name,
        ...(scope === "inventory" ? {} : { sql: value.sql }),
        root_page: value.rootpage,
        kind: possibleShadowParent === undefined ? listed.type : "unknown",
        without_rowid: listed.wr !== 0n,
        strict: listed.strict !== 0n,
        column_count:
          listed.type === "virtual" && listed.ncol === 0 ? null : listed.ncol,
        columns_completeness: "complete",
        columns: [],
      };
      if (possibleShadowParent !== undefined)
        limitations.push(
          `SQLite could not resolve virtual table ${possibleShadowParent.name}. Table ${value.name} may be its shadow table; its kind is unknown and row inspection is unavailable.`,
        );
      budget.retain(table);
      if (scope === "inventory") table.columns_completeness = "not_requested";
      if (listed.type === "virtual" && scope !== "inventory") {
        table.columns_completeness = "unsupported";
        limitations.push(
          `Virtual table column expansion is not performed: ${value.name}. Its complete stored CREATE statement is retained.`,
        );
      } else if (
        listed.type !== "virtual" &&
        (scope !== "inventory" || input.table === value.name)
      ) {
        const columns = readColumns(db, value.name, {
          budget: scope === "inventory" ? new OutputBudget() : budget,
          encoding,
          selectedColumns: scope === "inventory" ? input.columns : undefined,
        });
        if (input.table === value.name)
          selectedTable = {
            name: table.name,
            kind: table.kind,
            without_rowid: table.without_rowid,
            columns,
          };
        if (scope !== "inventory") table.columns = columns;
      }
      if (input.table === value.name && selectedTable === undefined)
        selectedTable = {
          name: table.name,
          kind: table.kind,
          without_rowid: table.without_rowid,
          columns: table.columns,
        };
      schema.tables.push(table);
    } else if (value.type === "index") {
      const index = {
        name: value.name,
        table: value.tbl_name,
        ...(scope === "inventory" ? {} : { sql: value.sql }),
        root_page: value.rootpage,
      };
      budget.retain(index);
      schema.indexes.push(index);
    } else if (value.type === "view") {
      const view = {
        name: value.name,
        ...(scope === "inventory" ? {} : { sql: value.sql }),
      };
      budget.retain(view);
      schema.views.push(view);
    } else {
      const trigger = {
        name: value.name,
        table: triggerTable(value.tbl_name),
        ...(scope === "inventory" ? {} : { sql: value.sql }),
      };
      budget.retain(trigger);
      schema.triggers.push(trigger);
    }
  }
  return { schema, selectedTable };
};

// A real column may shadow rowid; SQLite then reaches it by another alias.
const ROWID_ALIASES = ["rowid", "_rowid_", "oid"] as const;

/**
 * Unique order that a frozen snapshot keeps between calls: the rowid, or the
 * WITHOUT ROWID primary key (NOT NULL and unique). A rowid table's declared
 * primary key may repeat NULLs, so it is never the order. Reads names from the
 * pragma rather than the retained columns, which inventory scope may narrow.
 */
const rowOrder = (
  db: DatabaseSync,
  table: SelectedTableFacts,
  encoding: DatabaseEncoding,
): { readonly order: RowOrder; readonly sql: string } => {
  const names = (condition: string): Uint8Array[] =>
    [
      ...db
        .prepare(
          `SELECT CAST(name AS BLOB) AS name FROM temp.pragma_table_xinfo(?, 'main') WHERE ${condition} ORDER BY pk, cid`,
        )
        .iterate(table.name),
    ].map((raw) => keyRow.parse(raw).name);
  const unspecified = { order: "unspecified", sql: "" } as const;
  if (table.without_rowid) {
    try {
      const columns = names("pk > 0").map((name) =>
        decodeSchemaText(name, encoding, "primary key column name"),
      );
      return columns.length === 0
        ? unspecified
        : {
            order: { basis: "primary_key", columns },
            sql: ` ORDER BY ${columns.map(quoteIdentifier).join(", ")}`,
          };
    } catch (cause: unknown) {
      if (cause instanceof SqliteInspectionFailure) return unspecified;
      throw cause;
    }
  }
  // Matched names are ASCII, so text (UTF-8 at the API) is lossless in any database encoding.
  const shadowed = new Set(
    [
      ...db
        .prepare(
          "SELECT lower(name) AS name FROM temp.pragma_table_xinfo(?, 'main') WHERE lower(name) IN ('rowid', '_rowid_', 'oid')",
        )
        .iterate(table.name),
    ].map((raw) => aliasRow.parse(raw).name),
  );
  const alias = ROWID_ALIASES.find((name) => !shadowed.has(name));
  return alias === undefined
    ? unspecified
    : {
        order: { basis: "rowid", columns: [alias] },
        sql: ` ORDER BY ${alias}`,
      };
};

const readRows = (
  db: DatabaseSync,
  input: InspectSqliteDatabaseInput,
  table: SelectedTableFacts | undefined,
  context: {
    readonly encoding: DatabaseEncoding;
    readonly budget: OutputBudget;
  },
): SqliteDatabase["rows"] => {
  const { encoding, budget } = context;
  if (input.table === undefined) return null;
  if (table === undefined) throw missingSelectedTable(input.table);
  if (table.kind === "unknown")
    throw new SqliteInspectionFailure(
      "selection",
      `SQLite cannot determine whether selected table ${input.table} is a shadow table of an unresolved virtual table. Row inspection requires a confirmed ordinary table.`,
    );
  if (table.kind !== "table")
    throw new SqliteInspectionFailure(
      "selection",
      `Rows from ${table.kind} table ${input.table} are outside the ordinary-table inspection profile.`,
    );
  const limit = input.row_limit ?? SQLITE_ROW_LIMIT_DEFAULT;
  const offset = input.offset ?? 0;
  const visibleColumns = table.columns
    .filter((column) => column.hidden !== 1)
    .map((column) => column.name);
  const columns = input.columns ?? visibleColumns;
  const available = new Set(visibleColumns);
  for (const name of columns)
    if (!available.has(name))
      throw new SqliteInspectionFailure(
        "column-selection",
        `Selected column does not exist with that exact name in table ${input.table}: ${name}`,
      );
  const projection = columns
    .map((name) => {
      const column = quoteIdentifier(name);
      return `CASE typeof(${column}) WHEN 'text' THEN 't' || hex(CAST(${column} AS BLOB)) WHEN 'blob' THEN 'b' || hex(${column}) ELSE ${column} END`;
    })
    .join(", ");
  const source = `main.${quoteIdentifier(input.table)} NOT INDEXED`;
  const { order, sql: orderBy } = rowOrder(db, table, encoding);
  if (order === "unspecified" && offset > 0)
    throw new SqliteInspectionFailure(
      "selection",
      `Table ${input.table} has no unique order SQLite can name, so an offset would not select a stable page. Read it from offset 0.`,
    );
  const lengths = db.prepare(
    `SELECT ${columns
      .map((name) => {
        const column = quoteIdentifier(name);
        return `CASE typeof(${column}) WHEN 'text' THEN length(CAST(${column} AS BLOB)) WHEN 'blob' THEN length(${column}) ELSE 0 END`;
      })
      .join(", ")} FROM ${source}${orderBy} LIMIT ? OFFSET ?`,
  );
  lengths.setReturnArrays(true);
  for (const raw of lengths.iterate(limit, offset))
    budget.beforeProjection(cellByteLengths.parse(raw));
  const statement = db.prepare(
    `SELECT ${projection} FROM ${source}${orderBy} LIMIT ? OFFSET ?`,
  );
  statement.setReturnArrays(true);
  const rows: NonNullable<SqliteDatabase["rows"]> = {
    table: input.table,
    columns,
    values: [],
    row_limit: limit,
    returned_rows: 0,
    truncated: false,
    offset,
    next_offset: null,
    order,
  };
  for (const raw of statement.iterate(limit, offset)) {
    const rawRow = arrayRow.parse(raw);
    // Hex expansion already belongs to the retained-output budget, before decoding/copying cells.
    budget.beforeDecode(rawRow);
    const values = rawRow.map((value) => cell(value, encoding));
    budget.retain(values);
    rows.values.push(values);
  }
  rows.returned_rows = rows.values.length;
  rows.truncated =
    db
      .prepare(`SELECT 1 FROM ${source}${orderBy} LIMIT 1 OFFSET ?`)
      .get(offset + rows.returned_rows) !== undefined;
  rows.next_offset = rows.truncated ? offset + rows.returned_rows : null;
  return rows;
};

/** Open a provider-owned snapshot read-only, with bounded values and SQL, inside one read transaction. */
export const openSqliteSnapshot = (
  snapshotPath: string,
): {
  readonly db: DatabaseSync;
  readonly version: string;
  readonly encoding: DatabaseEncoding;
} => {
  const db = new DatabaseSync(snapshotPath, {
    readOnly: true,
    allowExtension: false,
    readBigInts: true,
    enableDoubleQuotedStringLiterals: false,
    timeout: 0,
    limits: {
      length: SQLITE_DATABASE_LIMITS.outputBytes,
      sqlLength: SQLITE_DATABASE_LIMITS.outputBytes,
    },
  });
  try {
    const limits: unknown = db.limits;
    const supported = z
      .object({
        length: z
          .number()
          .int()
          .positive()
          .max(SQLITE_DATABASE_LIMITS.outputBytes),
        sqlLength: z
          .number()
          .int()
          .positive()
          .max(SQLITE_DATABASE_LIMITS.outputBytes),
      })
      .safeParse(limits);
    if (!supported.success)
      throw new SqliteInspectionFailure(
        "unavailable",
        "SQLite inspection requires the native DatabaseSync.limits API to bound untrusted values and SQL. Use Node.js 24.15 or newer in the supported 24.x line, or a compatible Node.js 26+ runtime.",
      );
    db.exec(
      "PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; PRAGMA mmap_size=0; PRAGMA cell_size_check=ON; BEGIN;",
    );
    const version = z
      .object({ version: z.string() })
      .parse(db.prepare("SELECT sqlite_version() AS version").get()).version;
    const encoding = z
      .object({ encoding: encodingSchema })
      .parse(db.prepare("PRAGMA encoding").get()).encoding;
    return { db, version, encoding };
  } catch (cause: unknown) {
    db.close();
    throw cause;
  }
};

/** Query only a provider-owned snapshot; no caller SQL, extensions, views or virtual rows. */
export const inspectSqliteDatabaseSnapshot = (
  snapshotPath: string,
  input: InspectSqliteDatabaseInput,
): Inspection => {
  const { db, version, encoding } = openSqliteSnapshot(snapshotPath);
  try {
    const limitations = [
      "Inspects an offline stable file set. Filesystem identity checks detect observed acquisition changes; they do not establish an atomic snapshot of an actively changing database. Supply an application-created backup or quiescent database/WAL pair.",
      "The source database and WAL are never opened by SQLite or modified. A private copy may acquire its own WAL-index sidecar and is removed after inspection.",
      "SQLite reports current schema and selected committed rows from its valid database/WAL state. Deleted records, uncommitted or invalid WAL tails, encrypted databases, forensic recovery, and full integrity verification are outside this profile.",
      "Stored CREATE statements preserve index/view/trigger definitions. Views, triggers, and virtual/shadow table rows are not executed; virtual-table column expansion is unsupported.",
      "Selected rows are one page of the table in its rowid or WITHOUT ROWID primary-key order, which stays fixed for one frozen snapshot; the page offset is not a cursor into a changing database. A table with no nameable unique order returns an unspecified-order first page only. Text display may replace invalid sequences; bytes_hex and encoding preserve SQLite's text byte representation, not original on-disk page offsets.",
      "Resource boundaries: at most two concurrent inspections per provider; combined input 256 MiB per inspection, complete worker JSON 16 MiB, native SQLite value/record and SQL statement lengths 16 MiB, owned-worker JavaScript heap 256 MiB and supervised deadline 30 seconds. These are distinct from total resident memory; an overall native SQLite heap cap is not claimed. Failures return no partial success.",
    ];
    const budget = new OutputBudget();
    const { schema, selectedTable } = readSchema(db, input, {
      budget,
      limitations,
      encoding,
    });
    return {
      engine: { name: "SQLite", version },
      database_encoding: encoding,
      schema,
      rows: readRows(db, input, selectedTable, { encoding, budget }),
      limitations,
    };
  } finally {
    db.close();
  }
};
