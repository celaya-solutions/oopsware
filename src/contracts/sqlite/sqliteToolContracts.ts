import {
  inspectSqliteDatabaseInputSchema,
  querySqliteDatabaseInputSchema,
  sqliteDatabaseSchema,
  sqliteQuerySchema,
} from "../../domain/sqlite/sqliteDatabase.js";
import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";

/** Snapshot inspection is independent of any active native-analysis target. */
export const SQLITE_TOOL_CONTRACTS = [
  {
    name: "inspect_sqlite_database",
    ...toolContractMetadata("inspect_sqlite_database"),
    kind: "artifact-provider",
    description:
      "Inspect an explicit local SQLite database snapshot and its existing sibling WAL without modifying source files or opening a native analysis provider. Requires Node.js 24.x >=24.15 or 26+ with native DatabaseSync.limits support, checked by the worker. Returns observed Evidence with database/WAL SHA-256 and a compact schema inventory. Selecting an exact ordinary table expands only its schema and returns one page of rows (default 20, subject to byte and worker resource limits) in rowid or WITHOUT ROWID primary-key order; pass next_offset as offset for the following page of the same snapshot. Select exact columns in the requested order to avoid unrelated or large values; schema_scope=database explicitly expands the whole schema; returned rows retain 64-bit integers, text bytes and blobs with explicit truncation. No arbitrary SQL, view or virtual-table execution, extension loading, database repair, encryption support or live-snapshot atomicity claim. At most two inspections per provider are admitted; occupied capacity is retryable. An isolated temporary copy and owned worker enforce input, value/record, SQL-statement, JSON-reply, JavaScript-heap and deadline limits; overall native heap is not capped. Supply a quiescent snapshot for coherent database/WAL evidence.",
    inputSchema: inspectSqliteDatabaseInputSchema,
    outputSchema: evidenceResultOf(sqliteDatabaseSchema),
    examples: [
      {
        title: "Inspect a compact inventory of a local SQLite snapshot",
        input: { path: "/artifacts/application.sqlite" },
      },
      {
        title: "Read selected rows from an ordinary table",
        input: {
          path: "/artifacts/application.sqlite",
          table: "settings",
          columns: ["key", "value"],
          row_limit: 20,
        },
      },
      {
        title: "Read the next page of rows",
        input: {
          path: "/artifacts/application.sqlite",
          table: "settings",
          row_limit: 20,
          offset: 20,
        },
      },
      {
        title: "Expand the complete stored schema",
        input: {
          path: "/artifacts/application.sqlite",
          schema_scope: "database",
        },
      },
    ],
  },
  {
    name: "query_database_readonly",
    ...toolContractMetadata("query_database_readonly"),
    kind: "artifact-provider",
    description:
      "Run one read-only SQL statement (SELECT, WITH or VALUES) against an explicit local SQLite database snapshot and its existing sibling WAL, on an isolated temporary copy; source files are never opened by SQLite or modified. Local only; the public library never runs caller SQL. SQLite's own authorizer admits only reads, so writes, ATTACH/DETACH, PRAGMA statements, VACUUM, extension loading and second statements are refused without a keyword scan; the copy is opened read-only, query-only and defensive. Returns observed Evidence with database/WAL SHA-256, the result column names exactly as SQLite reports them, and up to row_limit rows (default 20; truncated says more existed) that keep 64-bit integers, text bytes and blobs. parameters binds values by position to ? and ?NNN (every placeholder needs one; named placeholders are refused), and csv returns the rows as raw or formula-escaped CSV text beside the lossless values. Use inspect_sqlite_database first to learn table and column names; use ORDER BY in the statement when row order matters, because the order of an unsorted result is not specified. SQLite offers no in-process interrupt here, so an expensive statement ends at the owned worker's 30 second deadline or on caller cancellation and returns no partial rows; reply bytes are budgeted as rows are retained. Same input, value and heap limits, two-at-a-time capacity and Node.js requirement as inspect_sqlite_database. No live-snapshot atomicity claim: supply a quiescent snapshot.",
    inputSchema: querySqliteDatabaseInputSchema,
    outputSchema: evidenceResultOf(sqliteQuerySchema),
    examples: [
      {
        title: "Count rows per group with an explicit order",
        input: {
          path: "/artifacts/application.sqlite",
          sql: "SELECT kind, count(*) AS n FROM events GROUP BY kind ORDER BY n DESC",
          row_limit: 10,
        },
      },
      {
        title: "Join two tables and read a handful of rows",
        input: {
          path: "/artifacts/application.sqlite",
          sql: "SELECT u.name, o.total FROM users u JOIN orders o ON o.user_id = u.id ORDER BY o.total DESC",
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
