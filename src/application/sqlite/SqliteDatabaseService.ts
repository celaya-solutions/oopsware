import { isAbsolute } from "node:path";
import type {
  AnalysisExecution,
  ExecutionOptions,
} from "../AnalysisProvider.js";
import type { SqliteDatabasePort } from "./SqliteDatabasePort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import {
  createEvidence,
  type Evidence,
  type EvidenceSubjectTarget,
} from "../../domain/evidence.js";
import {
  inspectSqliteDatabaseInputSchema,
  querySqliteDatabaseInputSchema,
  sqliteDatabaseSchema,
  sqliteQuerySchema,
  type InspectSqliteDatabaseInput,
  type QuerySqliteDatabaseInput,
  type SqliteDatabase,
  type SqliteOperation,
  type SqliteQuery,
  SQLITE_ROW_LIMIT_DEFAULT,
  sqliteSchemaScope,
  sqliteInspectionParameters,
  sqliteQueryParameters,
} from "../../domain/sqlite/sqliteDatabase.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { err, ok, type Result } from "../../domain/result.js";
import { jsonValueSchema, type JsonValue } from "../../domain/jsonValue.js";
import type { ZodType } from "zod";

const matchesSelectedDatabase = (
  report: SqliteDatabase,
  input: InspectSqliteDatabaseInput,
  subject: EvidenceSubjectTarget,
): boolean =>
  report.artifact.path === input.path &&
  subject.path === input.path &&
  subject.sha256 === report.artifact.sha256 &&
  subject.format === "file" &&
  (report.wal === null || report.wal.path === `${input.path}-wal`) &&
  report.schema.scope === sqliteSchemaScope(input) &&
  (report.schema.scope !== "selected_table" ||
    (report.schema.tables.length === 1 &&
      report.schema.tables[0]?.name === input.table &&
      report.schema.indexes.every((index) => index.table === input.table) &&
      report.schema.triggers.every(
        (trigger) => trigger.table === input.table,
      ) &&
      report.schema.views.length === 0)) &&
  (input.table === undefined
    ? report.rows === null
    : report.rows?.table === input.table &&
      report.rows.row_limit === (input.row_limit ?? SQLITE_ROW_LIMIT_DEFAULT) &&
      report.rows.offset === (input.offset ?? 0) &&
      (input.columns === undefined ||
        (report.rows.columns.length === input.columns.length &&
          report.rows.columns.every(
            (name, index) => name === input.columns?.[index],
          ))));

const matchesQueriedDatabase = (
  report: SqliteQuery,
  input: QuerySqliteDatabaseInput,
  subject: EvidenceSubjectTarget,
): boolean =>
  report.artifact.path === input.path &&
  subject.path === input.path &&
  subject.sha256 === report.artifact.sha256 &&
  subject.format === "file" &&
  (report.wal === null || report.wal.path === `${input.path}-wal`) &&
  report.row_limit === (input.row_limit ?? SQLITE_ROW_LIMIT_DEFAULT) &&
  report.csv?.escaping === input.csv;

/** One operation's validation, provider call and report check; the flow around them is shared. */
interface SqliteObservation<Input extends { readonly path: string }, Report> {
  readonly operation: SqliteOperation;
  readonly inputSchema: ZodType<Input>;
  readonly reportSchema: ZodType<Report>;
  readonly run: (
    input: Input,
  ) => Promise<Result<AnalysisExecution, AnalysisError>>;
  readonly matches: (
    report: Report,
    input: Input,
    subject: EvidenceSubjectTarget,
  ) => boolean;
  readonly parameters: (input: Input) => Readonly<Record<string, JsonValue>>;
}

/** Shared snapshot inspection and query, with caller-selection validation, for CLI and MCP. */
export class SqliteDatabaseService {
  constructor(readonly provider: SqliteDatabasePort) {}

  /** Await provider shutdown, retaining failed cleanup owners for retry. */
  close(): Promise<void> {
    return this.provider.close?.() ?? Promise.resolve();
  }

  /** Inspect an explicit database snapshot and preserve its original database/WAL identity. */
  inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    return this.#observe(
      {
        operation: "inspect_sqlite_database",
        inputSchema: inspectSqliteDatabaseInputSchema,
        reportSchema: sqliteDatabaseSchema,
        run: (input) => this.provider.inspect(input, options),
        matches: matchesSelectedDatabase,
        parameters: sqliteInspectionParameters,
      },
      rawInput,
      options,
    );
  }

  /** Run one read-only statement on an explicit database snapshot and preserve its database/WAL identity. */
  query(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    return this.#observe(
      {
        operation: "query_database_readonly",
        inputSchema: querySqliteDatabaseInputSchema,
        reportSchema: sqliteQuerySchema,
        run: (input) => this.provider.query(input, options),
        matches: matchesQueriedDatabase,
        parameters: sqliteQueryParameters,
      },
      rawInput,
      options,
    );
  }

  async #observe<Input extends { readonly path: string }, Report>(
    observation: SqliteObservation<Input, Report>,
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const { operation } = observation;
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(operation));
    const input = observation.inputSchema.safeParse(rawInput);
    if (!input.success)
      return err(
        analysisInputErrorFromIssues(operation, input.error.issues, rawInput, {
          cause: input.error,
        }),
      );
    if (!isAbsolute(input.data.path))
      return err(
        new AnalysisInputError(operation, undefined, [
          {
            path: ["path"],
            reason: "invalid_format",
            message: "Expected an absolute filesystem path on this host.",
          },
        ]),
      );
    const observed = await observation.run(input.data);
    if (!observed.ok) return observed;
    const execution = observed.value;
    const report = observation.reportSchema.safeParse(execution.result);
    if (
      !report.success ||
      execution.subject === null ||
      !observation.matches(report.data, input.data, execution.subject)
    )
      return err(
        new AnalysisOutputError(
          operation,
          "SQLite adapter returned malformed data or changed the selected database identity/table/row limit.",
        ),
      );
    return ok(
      createEvidence(execution.subject, execution.provider, {
        operation,
        parameters: observation.parameters(input.data),
        result: jsonValueSchema.parse(report.data),
        ...(execution.rawResult === null
          ? {}
          : { rawResult: execution.rawResult }),
        confidence: "observed",
        locations: execution.locations,
        limitations: execution.limitations,
      }),
    );
  }
}
