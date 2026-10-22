import { z } from "incur";
import { createSqliteDatabaseService } from "../composition/sqlite.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";

// Text that is not JSON passes through unchanged, so the service's schema names the bad argument.
const jsonOrText = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/** Resolve an operator-selected SQLite snapshot through the shared inspection and query workflows. */
export const registerSqliteCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<NodeJS.ProcessEnv>,
): void => {
  const service = createSqliteDatabaseService(environment);
  cli.command(CLI_COMMANDS.inspectSqliteDatabase, {
    description:
      "Inspect SQLite schema and optional ordinary-table rows from a local snapshot",
    args: z.object({
      path: z.string().describe("Local SQLite database snapshot"),
    }),
    options: z.object({
      table: z
        .string()
        .optional()
        .describe("Exact ordinary table name to read"),
      column: z
        .array(z.string())
        .optional()
        .describe(
          "Repeat to select exact row columns in the requested order; requires table",
        ),
      schemaScope: z
        .enum(["inventory", "selected_table", "database"])
        .optional()
        .describe(
          "Compact inventory by default, or selected-table details when table is supplied; database requests full schema",
        ),
      rowLimit: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          "Positive safe integer row count; default 20; requires table",
        ),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          "Rows to skip in the table's fixed order; pass a previous next_offset for the following page; default 0; requires table",
        ),
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.inspectSqliteDatabase, () =>
          finishAnalysisCommand(
            () =>
              service.inspect(
                {
                  path: absoluteCallerPath(args.path),
                  ...(options.table === undefined
                    ? {}
                    : { table: options.table }),
                  ...(options.rowLimit === undefined
                    ? {}
                    : { row_limit: options.rowLimit }),
                  ...(options.offset === undefined
                    ? {}
                    : { offset: options.offset }),
                  ...(options.column === undefined
                    ? {}
                    : { columns: options.column }),
                  ...(options.schemaScope === undefined
                    ? {}
                    : { schema_scope: options.schemaScope }),
                },
                { signal },
              ),
            service,
            "sqlite",
            "inspect_sqlite_database",
            signal,
          ),
        ),
      ),
  });
  cli.command(CLI_COMMANDS.queryDatabaseReadonly, {
    description:
      "Run one read-only SQL statement against a local SQLite database snapshot",
    args: z.object({
      path: z.string().describe("Local SQLite database snapshot"),
      sql: z
        .string()
        .describe(
          "One SELECT, WITH or VALUES statement; writes, ATTACH, PRAGMA and extensions are refused",
        ),
    }),
    options: z.object({
      rowLimit: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Positive safe integer row count; default 20"),
      parameters: z
        .string()
        .optional()
        .describe(
          'JSON array of values bound by position, e.g. \'["a", 3, null, {"type":"blob","hex":"00ff"}]\'',
        ),
      csv: z
        .enum(["raw", "escaped"])
        .optional()
        .describe(
          "Also return CSV text; escaped guards text that a spreadsheet would run as a formula",
        ),
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.queryDatabaseReadonly, () =>
          finishAnalysisCommand(
            () =>
              service.query(
                {
                  path: absoluteCallerPath(args.path),
                  sql: args.sql,
                  ...(options.parameters === undefined
                    ? {}
                    : { parameters: jsonOrText(options.parameters) }),
                  ...(options.rowLimit === undefined
                    ? {}
                    : { row_limit: options.rowLimit }),
                  ...(options.csv === undefined ? {} : { csv: options.csv }),
                },
                { signal },
              ),
            service,
            "sqlite",
            "query_database_readonly",
            signal,
          ),
        ),
      ),
  });
};
