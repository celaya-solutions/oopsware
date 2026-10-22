import {
  bindArtifactFileCleanup,
  ArtifactFileCleanupFailure,
  artifactFileCancellationCause,
} from "../artifacts/ArtifactFileOperation.js";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AnalysisCapturedOutput } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisCapabilityUnavailableError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import {
  sqliteDatabaseSchema,
  sqliteQuerySchema,
  type InspectSqliteDatabaseInput,
  type QuerySqliteDatabaseInput,
} from "../domain/sqlite/sqliteDatabase.js";
import { readStableArtifact } from "../artifacts/readStableArtifact.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { runOwnedCommand } from "../process/OwnedCommand.js";
import type {
  ProviderProcessSupervisor,
  ProviderProcessStopResult,
} from "../process/ProviderProcess.js";
import { capturedSqliteOutput } from "./SqliteDatabaseFailures.js";
import { SQLITE_DATABASE_LIMITS } from "./SqliteDatabaseLimits.js";

/** One unit of owned worker work; the operation names the tool the caller invoked. */
export type SqliteWorkerWork =
  | {
      readonly operation: "inspect_sqlite_database";
      readonly input: InspectSqliteDatabaseInput;
    }
  | {
      readonly operation: "query_database_readonly";
      readonly input: QuerySqliteDatabaseInput;
    };
// The worker reports the part of each result it produces; the provider adds the file identities.
const {
  artifact: _artifactSchema,
  wal: _walSchema,
  ...inspectionShape
} = sqliteDatabaseSchema.shape;
const {
  artifact: _queryArtifactSchema,
  wal: _queryWalSchema,
  ...queryShape
} = sqliteQuerySchema.shape;
const reportSchemas = {
  inspect_sqlite_database: z.strictObject(inspectionShape),
  query_database_readonly: z.strictObject(queryShape),
} as const;
const replySchemaFor = (operation: SqliteWorkerWork["operation"]) =>
  z.discriminatedUnion("ok", [
    z.strictObject({ ok: z.literal(true), report: reportSchemas[operation] }),
    z.strictObject({
      ok: z.literal(false),
      reason: z.enum([
        "format",
        "selection",
        "column-selection",
        "query",
        "parameters",
        "unsupported",
        "unavailable",
        "output-limit",
        "memory",
      ]),
      message: z.string(),
    }),
  ]);
type SqliteWorkerReply = z.output<ReturnType<typeof replySchemaFor>>;
/** Replaceable launcher retains the shared owned-process supervision boundary. */
export type SqliteWorkerLauncher = NonNullable<
  Parameters<typeof runOwnedCommand>[2]
>["launcher"];

// Each input rejection names the caller argument that requires correction.
const rejectedArgument = {
  format: "path",
  unsupported: "path",
  selection: "table",
  "column-selection": "columns",
  query: "sql",
  parameters: "parameters",
} as const;

const rejectedReply = (
  operation: SqliteWorkerWork["operation"],
  reply: SqliteWorkerReply & { ok: false },
  capturedOutput: AnalysisCapturedOutput,
) => {
  if (reply.reason === "unavailable")
    return new AnalysisCapabilityUnavailableError(
      "sqlite",
      operation,
      reply.message,
      { capturedOutput, userMessage: reply.message },
    );
  if (reply.reason === "memory")
    return new AnalysisResourceConstraintError(
      operation,
      "memory",
      reply.message,
      {
        javascript_heap_bytes: 256 * 1024 * 1024,
      },
      { capturedOutput },
    );
  if (reply.reason === "output-limit")
    return new AnalysisResourceConstraintError(
      operation,
      "transport",
      reply.message,
      {
        sqlite_value_or_record_bytes: SQLITE_DATABASE_LIMITS.outputBytes,
        worker_reply_bytes: SQLITE_DATABASE_LIMITS.outputBytes,
      },
      { capturedOutput },
    );
  return new AnalysisInputError(operation, { capturedOutput }, [
    {
      path: [rejectedArgument[reply.reason]],
      reason: "invalid_format",
      message: reply.message,
    },
  ]);
};

/** Execute only the private snapshot and validate the bounded worker protocol. */
export const executeSqliteDatabaseWorker = async (request: {
  readonly work: SqliteWorkerWork;
  readonly root: string;
  readonly snapshotPath: string;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly resourceScope: ArtifactResourceScope;
  readonly launcher?: SqliteWorkerLauncher;
  readonly signal?: AbortSignal;
  readonly captured: (output: AnalysisCapturedOutput) => void;
  readonly retainCleanup?: (
    owner: ProviderProcessSupervisor,
    result: Extract<ProviderProcessStopResult, { status: "incomplete" }>,
  ) => void;
}): Promise<Extract<SqliteWorkerReply, { ok: true }>["report"]> => {
  const { operation } = request.work;
  const replySchema = replySchemaFor(operation);
  const requestPath = join(request.root, "request.json");
  const replyPath = join(request.root, "reply.json");
  await writeFile(
    requestPath,
    JSON.stringify({
      snapshot_path: request.snapshotPath,
      reply_path: replyPath,
      work: request.work,
    }),
    { flag: "wx", mode: 0o600 },
  );
  const { NODE_OPTIONS: _ambientNodeOptions, ...environment } =
    request.environment;
  const execution = await runOwnedCommand(
    {
      command: process.execPath,
      arguments: [
        "--max-old-space-size=256",
        fileURLToPath(new URL("./SqliteDatabaseWorker.js", import.meta.url)),
        requestPath,
      ],
      cwd: request.root,
      expectedCommand: null,
      runId: `rea-sqlite-database-${randomUUID()}`,
      hostEnvironment: environment,
    },
    {
      timeoutMs: SQLITE_DATABASE_LIMITS.timeoutMs,
      diagnosticBytes: SQLITE_DATABASE_LIMITS.diagnosticBytes,
    },
    {
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.launcher === undefined ? {} : { launcher: request.launcher }),
      ...(request.retainCleanup === undefined
        ? {}
        : { retainCleanup: request.retainCleanup }),
    },
  );
  const capturedOutput = capturedSqliteOutput(execution);
  request.captured(capturedOutput);
  let reply: SqliteWorkerReply;
  try {
    const file = await readStableArtifact(
      replyPath,
      SQLITE_DATABASE_LIMITS.outputBytes,
      request.signal,
      undefined,
      request.resourceScope,
    );
    reply = replySchema.parse(JSON.parse(file.bytes.toString("utf8")));
  } catch (cause: unknown) {
    const options = {
      cause,
      capturedOutput,
      ...(cause instanceof ArtifactReaderFailure && cause.cleanup !== undefined
        ? { cleanup: cause.cleanup }
        : {}),
    };
    if (
      cause instanceof ArtifactReaderFailure &&
      (cause.reason === "cancelled" ||
        (cause instanceof ArtifactFileCleanupFailure &&
          cause.fileCleanupFailure.outcome.kind === "completed" &&
          request.signal?.aborted))
    ) {
      const error = new AnalysisCancelledError(operation, {
        ...options,
        cause:
          cause.reason === "cancelled"
            ? artifactFileCancellationCause(cause)
            : request.signal?.reason,
      });
      bindArtifactFileCleanup(cause, error);
      throw error;
    }
    const error = new AnalysisOutputError(
      operation,
      `Owned SQLite worker reply is missing or malformed: ${cause instanceof Error ? cause.message : String(cause)}`,
      options,
    );
    bindArtifactFileCleanup(cause, error);
    throw error;
  }
  if (!reply.ok) throw rejectedReply(operation, reply, capturedOutput);
  return reply.report;
};
