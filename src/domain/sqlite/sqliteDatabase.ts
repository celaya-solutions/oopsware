import { z } from "zod";
import { localPathStringSchema } from "../localPath.js";
import type { JsonValue } from "../jsonValue.js";

/** Format identity is shared by discovery, catalog, and observed SQLite results. */
export const SQLITE_PROVIDER_IDENTITY = {
  id: "sqlite",
  name: "REA SQLite database inspector",
  version: null,
} as const;

/** Tool names that run on a frozen snapshot through the owned SQLite worker. */
export type SqliteOperation =
  | "inspect_sqlite_database"
  | "query_database_readonly";

/** Default ordinary-table sample size when the caller selects a table. */
export const SQLITE_ROW_LIMIT_DEFAULT = 20;

const nonnegative = z.number().int().nonnegative();
const hex = z.string().regex(/^(?:[0-9a-f]{2})*$/);
const encoding = z.enum(["UTF-8", "UTF-16le", "UTF-16be"]);
const artifactSchema = z.strictObject({
  path: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: nonnegative,
});

/** Inspect one frozen database and its sibling WAL, with optional ordinary-table rows. */
export const inspectSqliteDatabaseInputSchema = z
  .strictObject({
    path: localPathStringSchema.describe(
      "Absolute path to an offline SQLite database snapshot",
    ),
    table: z
      .string()
      .optional()
      .describe(
        "Exact ordinary table name; views and virtual/shadow tables are not executed",
      ),
    columns: z
      .array(z.string())
      .min(1)
      .optional()
      .describe(
        "Exact row columns in caller-selected order; requires table. Omit to sample all visible columns.",
      ),
    schema_scope: z
      .enum(["inventory", "selected_table", "database"])
      .optional()
      .describe(
        "Default: compact inventory without a table, or detailed selected-table schema with a table. selected_table requires table. Database explicitly expands all stored declarations and supported columns.",
      ),
    row_limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        "Selected-table page size, default 20; subject to byte and worker resource limits",
      ),
    offset: nonnegative
      .optional()
      .describe(
        "Rows to skip in the table's deterministic order, default 0; pass a previous next_offset to read the following page of the same snapshot. Requires table.",
      ),
  })
  .describe("When schema_scope is selected_table, also provide table.")
  .superRefine((input, context) => {
    if (input.row_limit !== undefined && input.table === undefined)
      context.addIssue({
        code: "custom",
        path: ["row_limit"],
        message: "row_limit requires an explicit table selection",
      });
    if (input.offset !== undefined && input.table === undefined)
      context.addIssue({
        code: "custom",
        path: ["offset"],
        message: "offset requires an explicit table selection",
      });
    if (input.columns !== undefined && input.table === undefined)
      context.addIssue({
        code: "custom",
        path: ["columns"],
        message: "columns requires an explicit table selection",
      });
    if (input.schema_scope === "selected_table" && input.table === undefined)
      context.addIssue({
        code: "custom",
        path: ["schema_scope"],
        message: "selected_table schema scope requires table",
      });
  })
  .meta({
    dependentRequired: {
      row_limit: ["table"],
      offset: ["table"],
      columns: ["table"],
    },
    if: {
      properties: { schema_scope: { const: "selected_table" } },
      required: ["schema_scope"],
    },
    then: { required: ["table"] },
  });

/** JSON-safe SQLite cells retain integers, binary content and special REAL values. */
export const sqliteValueSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("null") }),
  z.strictObject({
    type: z.literal("integer"),
    value: z.string().regex(/^-?(?:0|[1-9][0-9]*)$/),
  }),
  z.strictObject({
    type: z.literal("real"),
    value: z.union([z.number(), z.enum(["Infinity", "-Infinity", "-0"])]),
  }),
  z.strictObject({
    type: z.literal("text"),
    value: z.string(),
    bytes_hex: hex,
    encoding,
  }),
  z.strictObject({ type: z.literal("blob"), hex }),
]);

/** Frozen schema facts and explicitly bounded selected records, without arbitrary SQL. */
export const sqliteDatabaseSchema = z
  .strictObject({
    artifact: artifactSchema,
    wal: artifactSchema.nullable(),
    engine: z.strictObject({
      name: z.literal("SQLite"),
      version: z.string().min(1),
    }),
    database_encoding: encoding,
    schema: z.strictObject({
      scope: z.enum(["inventory", "selected_table", "database"]),
      completeness: z
        .literal("complete")
        .describe(
          "Complete within the indicated schema scope; inventory omits declarations and column details",
        ),
      tables: z.array(
        z.strictObject({
          name: z.string(),
          sql: z.string().nullable().optional(),
          root_page: nonnegative,
          kind: z
            .enum(["table", "virtual", "shadow", "unknown"])
            .describe(
              "Unknown means a possible shadow table of an unresolved virtual table; its rows cannot be inspected",
            ),
          without_rowid: z.boolean(),
          strict: z.boolean(),
          column_count: nonnegative.nullable(),
          columns_completeness: z.enum([
            "complete",
            "unsupported",
            "not_requested",
          ]),
          columns: z.array(
            z.strictObject({
              cid: nonnegative,
              name: z.string(),
              declared_type: z.string(),
              not_null: z.boolean(),
              default_sql: z.string().nullable(),
              primary_key_position: nonnegative,
              hidden: z.union([
                z.literal(0),
                z.literal(1),
                z.literal(2),
                z.literal(3),
              ]),
            }),
          ),
        }),
      ),
      indexes: z.array(
        z.strictObject({
          name: z.string(),
          table: z.string(),
          sql: z.string().nullable().optional(),
          root_page: nonnegative,
        }),
      ),
      views: z.array(
        z.strictObject({
          name: z.string(),
          sql: z.string().nullable().optional(),
        }),
      ),
      triggers: z.array(
        z.strictObject({
          name: z.string(),
          table: z.string(),
          sql: z.string().nullable().optional(),
        }),
      ),
    }),
    rows: z
      .strictObject({
        table: z.string(),
        columns: z.array(z.string()),
        values: z.array(z.array(sqliteValueSchema)),
        row_limit: z.number().int().min(1),
        returned_rows: nonnegative,
        truncated: z.boolean(),
        offset: nonnegative,
        next_offset: nonnegative
          .nullable()
          .describe("Offset of the following page, or null after the last row"),
        order: z.union([
          z.literal("unspecified"),
          z.strictObject({
            basis: z.enum(["rowid", "primary_key"]),
            columns: z.array(z.string()).min(1),
          }),
        ]),
      })
      .nullable(),
    limitations: z.array(z.string()),
  })
  .superRefine((report, context) => {
    const rows = report.rows;
    if (
      rows !== null &&
      (rows.returned_rows !== rows.values.length ||
        rows.returned_rows > rows.row_limit ||
        rows.next_offset !==
          (rows.truncated ? rows.offset + rows.returned_rows : null) ||
        (rows.order === "unspecified" && rows.offset !== 0) ||
        rows.values.some((row) => row.length !== rows.columns.length))
    )
      context.addIssue({
        code: "custom",
        path: ["rows"],
        message:
          "Selected row counts and column dimensions must match the retained values",
      });
  });

/** Longest caller statement; the snapshot's own 16 MiB SQL limit applies to the wrapped form. */
export const SQLITE_QUERY_SQL_MAX_LENGTH = 65_536;

/** SQLite's default SQLITE_MAX_VARIABLE_NUMBER before 3.32; enough for any hand-written statement. */
export const SQLITE_QUERY_PARAMETERS_MAX = 999;
/** Characters of text and blob hex across all bound values together. */
export const SQLITE_QUERY_PARAMETER_CHARACTERS = 1_048_576;

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/** One bound value: JSON scalars for null, text and numbers; objects keep 64-bit integers and blobs exact. */
export const sqliteParameterSchema = z.union([
  z.null(),
  z.string(),
  z
    .number()
    .describe("A safe integer binds as INTEGER, any other number as REAL"),
  z.strictObject({
    type: z.literal("integer"),
    value: z
      .string()
      .max(20)
      .regex(/^-?(?:0|[1-9][0-9]*)$/)
      // zod still runs this after a failed regex, so text that is not an integer must not throw.
      .refine((value) => {
        try {
          const integer = BigInt(value);
          return integer >= INT64_MIN && integer <= INT64_MAX;
        } catch {
          return false;
        }
      }, "Integer is outside SQLite's signed 64-bit range"),
  }),
  z.strictObject({ type: z.literal("blob"), hex }),
]);

const parameterCharacters = (value: SqliteParameter): number =>
  typeof value === "string"
    ? value.length
    : value !== null && typeof value === "object" && value.type === "blob"
      ? value.hex.length
      : 0;

/** Run one caller-written read-only statement against a frozen database snapshot. */
export const querySqliteDatabaseInputSchema = z.strictObject({
  path: localPathStringSchema.describe(
    "Absolute path to an offline SQLite database snapshot",
  ),
  sql: z
    .string()
    .min(1)
    .max(SQLITE_QUERY_SQL_MAX_LENGTH)
    .describe(
      "Exactly one SELECT, WITH or VALUES statement; anything that writes, attaches, runs a PRAGMA or loads an extension is refused",
    ),
  parameters: z
    .array(sqliteParameterSchema)
    .max(SQLITE_QUERY_PARAMETERS_MAX)
    .refine(
      (values) =>
        values.reduce<number>(
          (sum, value) => sum + parameterCharacters(value),
          0,
        ) <= SQLITE_QUERY_PARAMETER_CHARACTERS,
      `Bound text and blob hex may total at most ${String(SQLITE_QUERY_PARAMETER_CHARACTERS)} characters`,
    )
    .optional()
    .describe(
      'Values bound by position to the statement\'s ? and ?NNN parameters (?NNN takes the NNNth value); every parameter needs a value and named parameters (:name, @name, $name) are refused. Use {"type":"integer","value":"<decimal>"} for integers beyond 2^53 and {"type":"blob","hex":"..."} for bytes',
    ),
  row_limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "Rows to return, default 20; truncated reports more rows; subject to byte and worker resource limits",
    ),
  csv: z
    .enum(["raw", "escaped"])
    .optional()
    .describe(
      "Also return the rows as CSV text. raw keeps every value as stored, so a text value starting with =, +, -, @, tab or carriage return can run as a formula when opened in a spreadsheet; escaped prefixes such text values with an apostrophe. The values array always keeps the original values",
    ),
});

/** Result columns and rows of one read-only statement, with the frozen database identity. */
export const sqliteQuerySchema = z
  .strictObject({
    artifact: artifactSchema,
    wal: artifactSchema.nullable(),
    engine: z.strictObject({
      name: z.literal("SQLite"),
      version: z.string().min(1),
    }),
    database_encoding: encoding,
    columns: z
      .array(z.string())
      .min(1)
      .describe("Result column names exactly as SQLite reports them"),
    values: z.array(z.array(sqliteValueSchema)),
    row_limit: z.number().int().min(1),
    returned_rows: nonnegative,
    truncated: z
      .boolean()
      .describe("True when the statement produced rows beyond row_limit"),
    csv: z
      .strictObject({
        escaping: z.enum(["raw", "escaped"]),
        text: z
          .string()
          .describe(
            "RFC 4180 CSV with CRLF line ends: a header of column names, then the returned rows; null is an empty field and a blob is its lowercase hex",
          ),
      })
      .optional()
      .describe("Present only when csv was requested"),
    limitations: z.array(z.string()),
  })
  .superRefine((report, context) => {
    if (
      report.returned_rows !== report.values.length ||
      report.returned_rows > report.row_limit ||
      report.values.some((row) => row.length !== report.columns.length)
    )
      context.addIssue({
        code: "custom",
        path: ["values"],
        message:
          "Returned row counts and column dimensions must match the retained values",
      });
  });

export type InspectSqliteDatabaseInput = z.infer<
  typeof inspectSqliteDatabaseInputSchema
>;
export type SqliteDatabase = z.infer<typeof sqliteDatabaseSchema>;
export type SqliteValue = z.infer<typeof sqliteValueSchema>;
export type QuerySqliteDatabaseInput = z.infer<
  typeof querySqliteDatabaseInputSchema
>;
export type SqliteQuery = z.infer<typeof sqliteQuerySchema>;
export type SqliteParameter = z.infer<typeof sqliteParameterSchema>;

/** Preserve the caller's statement, bound values and explicit options; omit absent optionals from JSON. */
export const sqliteQueryParameters = (
  input: QuerySqliteDatabaseInput,
): Readonly<Record<string, JsonValue>> => ({
  path: input.path,
  sql: input.sql,
  ...(input.parameters === undefined ? {} : { parameters: input.parameters }),
  ...(input.row_limit === undefined ? {} : { row_limit: input.row_limit }),
  ...(input.csv === undefined ? {} : { csv: input.csv }),
});

const FORMULA_START = /^[=+\-@\t\r]/;

const csvField = (text: string): string =>
  /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;

/** RFC 4180 rows; escaped prefixes text that a spreadsheet would read as a formula. */
export const sqliteCsv = (
  columns: readonly string[],
  values: SqliteQuery["values"],
  escaping: "raw" | "escaped",
): string => {
  const text = (value: string): string =>
    csvField(
      escaping === "escaped" && FORMULA_START.test(value) ? `'${value}` : value,
    );
  const field = (value: SqliteValue): string => {
    switch (value.type) {
      case "null":
        return "";
      case "integer":
        return value.value;
      case "real":
        return String(value.value);
      case "text":
        return text(value.value);
      case "blob":
        return value.hex;
    }
  };
  return [columns.map(text), ...values.map((row) => row.map(field))]
    .map((row) => `${row.join(",")}\r\n`)
    .join("");
};

/** Preserve explicit caller selections while omitting absent optional values from JSON. */
export const sqliteInspectionParameters = (
  input: InspectSqliteDatabaseInput,
): Readonly<Record<string, JsonValue>> => ({
  path: input.path,
  ...(input.table === undefined ? {} : { table: input.table }),
  ...(input.columns === undefined ? {} : { columns: input.columns }),
  ...(input.schema_scope === undefined
    ? {}
    : { schema_scope: input.schema_scope }),
  ...(input.row_limit === undefined ? {} : { row_limit: input.row_limit }),
  ...(input.offset === undefined ? {} : { offset: input.offset }),
});

/** One contract owner interprets omitted scope for adapters and selection checks. */
export const sqliteSchemaScope = (
  input: InspectSqliteDatabaseInput,
): SqliteDatabase["schema"]["scope"] =>
  input.schema_scope ??
  (input.table === undefined ? "inventory" : "selected_table");
