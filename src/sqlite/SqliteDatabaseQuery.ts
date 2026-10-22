import { constants, type SQLInputValue } from "node:sqlite";
import {
  SQLITE_ROW_LIMIT_DEFAULT,
  sqliteCsv,
  type QuerySqliteDatabaseInput,
  type SqliteParameter,
  type SqliteQuery,
} from "../domain/sqlite/sqliteDatabase.js";
import {
  OutputBudget,
  arrayRow,
  cell,
  openSqliteSnapshot,
  textEncoding,
} from "./SqliteDatabaseInspection.js";
import { SqliteInspectionFailure } from "./SqliteDatabaseLimits.js";

type Query = Pick<
  SqliteQuery,
  | "engine"
  | "database_encoding"
  | "columns"
  | "values"
  | "row_limit"
  | "returned_rows"
  | "truncated"
  | "csv"
  | "limitations"
>;

const SQLITE_RANGE = 25;

// SQLITE_ERROR (1) and SQLITE_AUTH (23) mean the caller's statement is wrong; every other
// code (corrupt, not a database, out of memory, too big) keeps its own meaning.
const STATEMENT_ERROR_CODES: ReadonlySet<unknown> = new Set([1, 23]);

const allowedActions: ReadonlySet<number> = new Set([
  constants.SQLITE_SELECT,
  constants.SQLITE_READ,
  constants.SQLITE_RECURSIVE,
  constants.SQLITE_FUNCTION,
]);

const rejected = (message: string): SqliteInspectionFailure =>
  new SqliteInspectionFailure("query", message);

// JavaScript numbers bind as REAL in node:sqlite, so integers go through BigInt.
const bindable = (value: SqliteParameter): SQLInputValue =>
  value === null || typeof value === "string"
    ? value
    : typeof value === "number"
      ? Number.isSafeInteger(value)
        ? BigInt(value)
        : value
      : value.type === "integer"
        ? BigInt(value.value)
        : Buffer.from(value.hex, "hex");

const bindsWith = (
  statement: { iterate: (...values: SQLInputValue[]) => unknown },
  values: readonly SQLInputValue[],
): boolean => {
  try {
    // iterate binds at once and steps only when read, so nothing runs here.
    statement.iterate(...values);
    return true;
  } catch (cause: unknown) {
    if (
      cause instanceof Error &&
      "errcode" in cause &&
      cause.errcode === SQLITE_RANGE
    )
      return false;
    throw cause;
  }
};

/** Run one caller statement on a provider-owned snapshot; reads only, bounded rows and bytes. */
export const querySqliteDatabaseSnapshot = (
  snapshotPath: string,
  input: QuerySqliteDatabaseInput,
): Query => {
  const { db, version, encoding } = openSqliteSnapshot(snapshotPath);
  try {
    db.enableDefensive(true);
    let firstAction: number | undefined;
    // Positive allow-list: a keyword scan cannot tell SELECT from VACUUM INTO, SQLite's authorizer can.
    db.setAuthorizer((action, _argument1, argument2) => {
      firstAction ??= action;
      return allowedActions.has(action) &&
        !(
          action === constants.SQLITE_FUNCTION && argument2 === "load_extension"
        )
        ? constants.SQLITE_OK
        : constants.SQLITE_DENY;
    });
    const limit = input.row_limit ?? SQLITE_ROW_LIMIT_DEFAULT;
    const budget = new OutputBudget();
    try {
      // The raw statement is only prepared, never stepped: it names the columns and
      // proves the text is exactly one allowed statement before it is wrapped.
      const statement = db.prepare(input.sql);
      if (input.sql.slice(statement.sourceSQL.length).trim() !== "")
        throw rejected(
          "Exactly one statement is allowed; text follows the first statement.",
        );
      if (firstAction !== constants.SQLITE_SELECT)
        throw rejected("Only a SELECT, WITH or VALUES statement is allowed.");
      const bound = (input.parameters ?? []).map(bindable);
      if (!bindsWith(statement, bound))
        throw new SqliteInspectionFailure(
          "parameters",
          `The statement has fewer ? and ?NNN placeholders than the ${String(bound.length)} values supplied. Named placeholders (:name, @name, $name) take no value by position and are refused.`,
        );
      // node:sqlite has no parameter count and never binds a position to :name, @name or
      // $name. With a 0 in every bound slot, SQLite's expanded text shows each slot left
      // without a value as an extra NULL, so none runs as NULL unseen.
      statement.iterate(...bound.map(() => 0n));
      const unbound =
        (statement.expandedSQL ?? "").split("NULL").length -
        statement.sourceSQL.split("NULL").length;
      if (statement.expandedSQL === undefined || unbound > 0)
        throw new SqliteInspectionFailure(
          "parameters",
          `The statement has more parameters than the ${String(bound.length)} values supplied; every parameter needs a value. Values bind by position to ? and ?NNN only: named parameters (:name, @name, $name) are refused.`,
        );
      const columns = statement.columns().map((column) => column.name);
      budget.retain(columns);
      const names = columns.map((_, index) => `c${String(index)}`);
      const projection = names
        .map(
          (name) =>
            `CASE typeof(${name}) WHEN 'text' THEN 't' || hex(CAST(${name} AS BLOB)) WHEN 'blob' THEN 'b' || hex(${name}) ELSE ${name} END`,
        )
        .join(", ");
      // Positional column names keep duplicate and odd result names out of the SQL;
      // the newline closes a trailing line comment before the parenthesis. The limit is
      // a literal so the caller's parameters keep the numbers SQLite gave them.
      const wrapped = db.prepare(
        `WITH q(${names.join(", ")}) AS (${statement.sourceSQL.replace(/;\s*$/, "")}\n) SELECT ${projection} FROM q LIMIT ${String(limit + 1)}`,
      );
      wrapped.setReturnArrays(true);
      const values: SqliteQuery["values"] = [];
      let truncated = false;
      for (const raw of wrapped.iterate(...bound)) {
        if (values.length === limit) {
          truncated = true;
          break;
        }
        const row = arrayRow.parse(raw);
        budget.beforeDecode(row);
        const decoded = row.map((value) => cell(value, encoding));
        budget.retain(decoded);
        values.push(decoded);
      }
      const csv =
        input.csv === undefined
          ? {}
          : {
              csv: {
                escaping: input.csv,
                text: sqliteCsv(columns, values, input.csv),
              },
            };
      if (input.csv !== undefined) budget.retain(csv);
      // Text that is not valid in the database encoding decodes with U+FFFD; only
      // bytes_hex keeps it, so say how many CSV fields differ from the stored bytes.
      const exact = new TextDecoder(textEncoding(encoding), {
        fatal: true,
        ignoreBOM: true,
      });
      const lossy =
        input.csv === undefined
          ? 0
          : values.flat().filter((value) => {
              if (value.type !== "text") return false;
              try {
                exact.decode(Buffer.from(value.bytes_hex, "hex"));
                return false;
              } catch {
                return true;
              }
            }).length;
      return {
        engine: { name: "SQLite", version },
        database_encoding: encoding,
        columns,
        values,
        row_limit: limit,
        returned_rows: values.length,
        truncated,
        ...csv,
        limitations: [
          "Runs on an offline private copy of the stable file set; filesystem identity checks detect observed acquisition changes but do not make a live database atomic.",
          "The statement is checked by SQLite's authorizer, run read-only inside one read transaction, and wrapped so row_limit caps the rows; no extension loads, writes, ATTACH, PRAGMA statements or second statements are accepted.",
          "SQLite has no in-process interrupt here: an expensive statement stops when the owned worker reaches its 30 second deadline or the caller cancels, and returns no partial rows.",
          "Result bytes are bounded as rows are retained (16 MiB reply, 16 MiB per value), and one wide row is materialised before it can be counted; the worker's 256 MiB heap is the last limit. Failures return no partial success.",
          "Integers keep 64-bit precision, text keeps its stored bytes, blobs are hex; deleted records, uncommitted or invalid WAL tails and encrypted databases are outside this profile.",
          ...(input.csv === "raw"
            ? [
                "The raw CSV keeps text exactly as stored: a value starting with =, +, -, @, tab or carriage return can run as a formula when the file is opened in a spreadsheet. Request csv: escaped for a copy that is safe to open.",
              ]
            : input.csv === "escaped"
              ? [
                  "The escaped CSV prefixes text starting with =, +, -, @, tab or carriage return with an apostrophe, so it differs from the stored values; the values array keeps the originals.",
                ]
              : []),
          ...(lossy > 0
            ? [
                `${String(lossy)} returned text values are not valid ${encoding}; the CSV shows them with U+FFFD replacement characters, and values[].bytes_hex keeps the stored bytes.`,
              ]
            : []),
        ],
      };
    } catch (cause: unknown) {
      if (
        cause instanceof Error &&
        "errcode" in cause &&
        STATEMENT_ERROR_CODES.has(cause.errcode)
      )
        throw rejected(
          cause.errcode === 23
            ? `SQLite refused the statement because it is not a plain read (${cause.message}). Writes, ATTACH, PRAGMA and extension loading are not allowed.`
            : cause.message,
        );
      throw cause;
    }
  } finally {
    db.close();
  }
};
