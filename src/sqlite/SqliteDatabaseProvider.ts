import {
  createAnalysisExecution,
  type AnalysisExecution,
  type ExecutionOptions,
} from "../application/AnalysisProvider.js";
import type { SqliteDatabasePort } from "../application/sqlite/SqliteDatabasePort.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { bindArtifactFileCleanup } from "../artifacts/ArtifactFileOperation.js";
import type {
  AnalysisCapturedOutput,
  AnalysisError,
} from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { createEvidence } from "../domain/evidence.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  inspectSqliteDatabaseInputSchema,
  querySqliteDatabaseInputSchema,
  sqliteDatabaseSchema,
  sqliteQuerySchema,
  type InspectSqliteDatabaseInput,
  type QuerySqliteDatabaseInput,
  type SqliteDatabase,
  type SqliteQuery,
  SQLITE_PROVIDER_IDENTITY,
  sqliteInspectionParameters,
  sqliteQueryParameters,
} from "../domain/sqlite/sqliteDatabase.js";
import { isAbsolute } from "node:path";
import { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";
import {
  OwnedCommandFailure,
  ownedCommandResources,
} from "../process/OwnedCommand.js";
import type {
  ProviderProcessStopResult,
  ProviderProcessSupervisor,
} from "../process/ProviderProcess.js";
import { sqliteDatabaseFailure } from "./SqliteDatabaseFailures.js";
import { captureSqliteDatabaseSnapshot } from "./SqliteDatabaseSnapshot.js";
import { SQLITE_DATABASE_LIMITS } from "./SqliteDatabaseLimits.js";

import {
  executeSqliteDatabaseWorker,
  type SqliteWorkerLauncher,
  type SqliteWorkerWork,
} from "./SqliteDatabaseWorkerExecution.js";

// Provider-wide lifecycle errors (close, retained cleanup) keep the family's first tool name.
const operation = "inspect_sqlite_database";
type SqliteOutcome = Result<AnalysisExecution, AnalysisError>;
type SqliteRuntimeRoot = Pick<PrivateRuntimeRoot, "path" | "close">;
type SqliteReport = SqliteDatabase | SqliteQuery;
/** One admitted request: what the worker runs and how its report becomes Evidence. */
interface SqliteJob {
  readonly work: SqliteWorkerWork;
  readonly parameters: Readonly<Record<string, JsonValue>>;
  /** Schema message when the input is malformed, else undefined. */
  readonly inputProblem: string | undefined;
  /** Add the original file identities to the worker's report and check the whole. */
  readonly complete: (candidate: object) => SqliteReport | undefined;
}
const inputProblem = (
  schema: { safeParse(input: unknown): { success: boolean; error?: Error } },
  input: unknown,
): string | undefined => {
  const parsed = schema.safeParse(input);
  return parsed.success ? undefined : parsed.error?.message;
};
const inspectJob = (input: InspectSqliteDatabaseInput): SqliteJob => ({
  work: { operation: "inspect_sqlite_database", input },
  parameters: sqliteInspectionParameters(input),
  inputProblem: inputProblem(inspectSqliteDatabaseInputSchema, input),
  complete: (candidate) => {
    const parsed = sqliteDatabaseSchema.safeParse(candidate);
    return parsed.success ? parsed.data : undefined;
  },
});
const queryJob = (input: QuerySqliteDatabaseInput): SqliteJob => ({
  work: { operation: "query_database_readonly", input },
  parameters: sqliteQueryParameters(input),
  inputProblem: inputProblem(querySqliteDatabaseInputSchema, input),
  complete: (candidate) => {
    const parsed = sqliteQuerySchema.safeParse(candidate);
    return parsed.success ? parsed.data : undefined;
  },
});
interface PendingSnapshotCleanup {
  readonly job: SqliteJob;
  readonly result: SqliteOutcome;
  readonly output: AnalysisCapturedOutput | undefined;
  readonly rootFailure: AnalysisError;
  readonly processFailure: AnalysisError | undefined;
  process: ProviderProcessSupervisor | undefined;
}
const MISSING_WAL =
  "The database header says WAL mode but no -wal file was beside it. This is the last checkpointed state only: anything committed to a WAL that was not supplied is missing, so the result is not proven current. Supply the database together with its -wal file.";

/** Inspect a provider-owned copy through a cancellable SQLite child, without source writes. */
export class SqliteDatabaseProvider implements SqliteDatabasePort {
  readonly #active = new Set<Promise<SqliteOutcome>>();
  readonly #artifactResources = new ArtifactResourceScope();
  readonly #pendingCleanup = new Map<
    SqliteRuntimeRoot,
    PendingSnapshotCleanup
  >();
  #closed = false;
  #closePromise: Promise<void> | undefined;
  #retryPromise: Promise<Result<null, AnalysisError>> | undefined;
  constructor(
    readonly environment: Readonly<NodeJS.ProcessEnv> = process.env,
    readonly launcher?: SqliteWorkerLauncher,
    readonly createRuntime: () => Promise<
      Pick<PrivateRuntimeRoot, "path" | "close">
    > = () => PrivateRuntimeRoot.create({ prefix: "rea-sqlite-database-" }),
  ) {}

  /** Return exact original DB/WAL identities and current schema/selected committed rows. */
  inspect(
    input: InspectSqliteDatabaseInput,
    options?: ExecutionOptions,
  ): Promise<SqliteOutcome> {
    return this.#admit(inspectJob(input), options);
  }

  /** Return one read-only statement's rows from a frozen copy, with the original DB/WAL identities. */
  query(
    input: QuerySqliteDatabaseInput,
    options?: ExecutionOptions,
  ): Promise<SqliteOutcome> {
    return this.#admit(queryJob(input), options);
  }

  async #admit(
    job: SqliteJob,
    options?: ExecutionOptions,
  ): Promise<SqliteOutcome> {
    const { operation } = job.work;
    if (options?.signal?.aborted)
      return err(
        new AnalysisCancelledError(operation, {
          cause: options.signal.reason,
        }),
      );
    if (this.#closed) return err(new AnalysisCancelledError(operation));
    if (this.#active.size >= SQLITE_DATABASE_LIMITS.concurrentInspections)
      return err(
        new AnalysisResourceConstraintError(
          operation,
          "capacity",
          "SQLite inspection capacity is occupied. Retry after an active inspection completes.",
          {
            active_inspections: this.#active.size,
            max_concurrent_inspections:
              SQLITE_DATABASE_LIMITS.concurrentInspections,
            input_bytes_per_inspection: SQLITE_DATABASE_LIMITS.inputBytes,
          },
          {
            remediationAction:
              "Retry after an active SQLite inspection completes.",
          },
        ),
      );
    const inspection = this.#artifactResources
      .run(() => this.#execute(job, options))
      .catch((cause: unknown) =>
        err(
          sqliteDatabaseFailure(
            cause,
            job.work.input.path,
            "artifact-read",
            operation,
            options?.signal,
          ),
        ),
      );
    this.#active.add(inspection);
    try {
      return await inspection;
    } finally {
      this.#active.delete(inspection);
    }
  }

  /** Await inspections and retry retained descriptors, workers, and snapshot roots. */
  close(): Promise<void> {
    this.#closed = true;
    this.#closePromise ??= Promise.allSettled(this.#active)
      .then(async () => {
        let descriptorFailure: AnalysisError | undefined;
        try {
          await this.#artifactResources.close();
        } catch (cause: unknown) {
          const cleanup = ArtifactReaderFailure.cleanupObservation(
            cause,
            "SQLite artifact descriptors",
          );
          descriptorFailure = new ProviderCleanupError(
            SQLITE_PROVIDER_IDENTITY.id,
            cleanup.resources,
            { reason: cleanup.reason },
            { operation, cause },
          );
          bindArtifactFileCleanup(cause, descriptorFailure);
        }
        const cleaned = await this.#retryCleanup();
        if (descriptorFailure !== undefined && !cleaned.ok) {
          const failure = new ProviderCleanupError(
            SQLITE_PROVIDER_IDENTITY.id,
            [
              ...descriptorFailure.cleanupResources,
              ...cleaned.error.cleanupResources,
            ],
            {
              failures: [
                projectAnalysisError(descriptorFailure),
                projectAnalysisError(cleaned.error),
              ],
            },
            { operation },
          );
          failure.bindCleanupDependencies([descriptorFailure, cleaned.error]);
          throw failure;
        }
        if (descriptorFailure !== undefined) throw descriptorFailure;
        if (!cleaned.ok) throw cleaned.error;
      })
      .catch((cause: unknown) => {
        this.#closePromise = undefined;
        throw cause;
      });
    return this.#closePromise;
  }

  #retryCleanup(): Promise<Result<null, AnalysisError>> {
    this.#retryPromise ??= this.#cleanupPending().finally(() => {
      this.#retryPromise = undefined;
    });
    return this.#retryPromise;
  }

  async #cleanupPending(): Promise<Result<null, AnalysisError>> {
    const failures: AnalysisError[] = [];
    for (const [root, pending] of [...this.#pendingCleanup]) {
      if (pending.process !== undefined) {
        const stopped = await pending.process.stop();
        if (stopped.status === "incomplete" || stopped.status === "not-owned") {
          const reason =
            stopped.status === "incomplete"
              ? stopped.reason
              : "SQLite worker ownership remains unresolved.";
          const failure = sqliteCleanupFailure(
            [
              pending.process.launch.ownership?.runId ?? "owned-sqlite-worker",
              root.path,
            ],
            reason,
            pending.result,
            pending.job,
            pending.output,
          );
          failure.bindCleanupDependencies(
            [pending.processFailure, pending.rootFailure].filter(
              (dependency): dependency is AnalysisError =>
                dependency !== undefined,
            ),
          );
          failures.push(failure);
          continue;
        }
        pending.process = undefined;
        pending.processFailure?.resolveCleanup();
      }
      const cleaned = await cleanupSqliteRoot(
        root,
        pending.result,
        pending.job,
        pending.output,
      );
      if (cleaned.ok) {
        pending.rootFailure.resolveCleanup();
        this.#pendingCleanup.delete(root);
      } else {
        cleaned.error.bindCleanupDependencies([pending.rootFailure]);
        failures.push(cleaned.error);
      }
    }
    if (failures.length === 1 && failures[0] !== undefined)
      return err(failures[0]);
    return failures.length === 0
      ? ok(null)
      : err(
          new ProviderCleanupError(
            SQLITE_PROVIDER_IDENTITY.id,
            failures.flatMap((failure) => failure.cleanupResources),
            { failures: failures.map(projectAnalysisError) },
            { operation },
          ).bindCleanupDependencies(failures),
        );
  }

  async #execute(
    job: SqliteJob,
    options?: ExecutionOptions,
  ): Promise<SqliteOutcome> {
    const { operation } = job.work;
    const { path } = job.work.input;
    let root: Pick<PrivateRuntimeRoot, "path" | "close"> | undefined;
    let processOwner: ProviderProcessSupervisor | undefined;
    let processCleanup:
      | Extract<ProviderProcessStopResult, { status: "incomplete" }>
      | undefined;
    let retainedOutput: AnalysisCapturedOutput | undefined;
    let phase = "configuration";
    let result: Result<AnalysisExecution, AnalysisError>;
    try {
      if (options?.signal?.aborted)
        throw new AnalysisCancelledError(operation, {
          cause: options.signal.reason,
        });
      validateSqliteJob(job);
      const retired = await this.#retryCleanup();
      if (!retired.ok) return retired;
      if (options?.signal?.aborted)
        throw new AnalysisCancelledError(operation, {
          cause: options.signal.reason,
        });
      if (this.#closed) throw new AnalysisCancelledError(operation);
      root = await this.createRuntime();
      phase = "artifact-read";
      const snapshot = await captureSqliteDatabaseSnapshot(
        path,
        root.path,
        this.#artifactResources,
        options?.signal,
        undefined,
        operation,
      );
      phase = "worker";
      const report = await executeSqliteDatabaseWorker({
        work: job.work,
        root: root.path,
        snapshotPath: snapshot.snapshotPath,
        environment: this.environment,
        resourceScope: this.#artifactResources,
        ...(this.launcher === undefined ? {} : { launcher: this.launcher }),
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
        captured: (output) => {
          retainedOutput = output;
        },
        retainCleanup: (owner, result) => {
          processOwner = owner;
          processCleanup = result;
        },
      });
      const validated = job.complete({
        artifact: snapshot.artifact,
        wal: snapshot.wal,
        ...report,
        limitations:
          snapshot.wal === null && snapshot.walMode
            ? [...report.limitations, MISSING_WAL]
            : report.limitations,
      });
      if (validated === undefined)
        throw new AnalysisOutputError(
          operation,
          "SQLite worker report dimensions or identity fields are invalid",
          retainedOutput === undefined
            ? undefined
            : { capturedOutput: retainedOutput },
        );
      result = ok(createSqliteObservation(validated, path));
    } catch (cause: unknown) {
      // A failure rethrown after retainCleanup carries no owner of its own;
      // keep the retained worker instead of discarding it.
      if (
        cause instanceof OwnedCommandFailure &&
        cause.cleanupOwner !== undefined
      )
        processOwner = cause.cleanupOwner;
      const failure = sqliteDatabaseFailure(
        cause,
        path,
        phase,
        operation,
        options?.signal,
      );
      retainedOutput ??= failure.capturedOutput;
      result = err(failure);
    }
    if (root !== undefined) {
      if (processOwner !== undefined) {
        const ownership = processOwner.launch.ownership;
        const rootFailure = new ProviderCleanupError(
          SQLITE_PROVIDER_IDENTITY.id,
          [root.path],
          { reason: "SQLite runtime root cleanup remains unresolved." },
          { operation },
        );
        const processReason =
          processCleanup?.reason ?? "SQLite worker cleanup remains unresolved.";
        const processFailure = new ProviderCleanupError(
          SQLITE_PROVIDER_IDENTITY.id,
          ownership === undefined
            ? ["owned-sqlite-worker"]
            : ownedCommandResources(ownership),
          { reason: processReason },
          { operation },
        );
        this.#pendingCleanup.set(root, {
          job,
          result,
          output: retainedOutput,
          rootFailure,
          processFailure,
          process: processOwner,
        });
        if (processCleanup !== undefined) {
          const failure = sqliteCleanupFailure(
            ownership === undefined
              ? ["owned-sqlite-worker", root.path]
              : ownedCommandResources(ownership, root.path),
            processCleanup.reason,
            result,
            job,
            retainedOutput,
            processCleanup.cleanupResult === undefined
              ? undefined
              : {
                  ...(processCleanup.cleanupResult.failures === undefined
                    ? {}
                    : {
                        failures: processCleanup.cleanupResult.failures.map(
                          (failure) => ({ ...failure }),
                        ),
                      }),
                  ...(processCleanup.cleanupResult.unverified === undefined
                    ? {}
                    : {
                        unverified: processCleanup.cleanupResult.unverified.map(
                          (process) => ({ ...process }),
                        ),
                      }),
                },
          );
          failure.bindCleanupDependencies([processFailure, rootFailure]);
          return err(failure);
        }
        if (!result.ok) {
          result.error.bindCleanupDependencies([processFailure, rootFailure]);
          return result;
        }
        const failure = sqliteCleanupFailure(
          [
            ...(ownership === undefined
              ? ["owned-sqlite-worker"]
              : ownedCommandResources(ownership)),
            root.path,
          ],
          processReason,
          result,
          job,
          retainedOutput,
        );
        failure.bindCleanupDependencies([processFailure, rootFailure]);
        return err(failure);
      }
      const cleaned = await cleanupSqliteRoot(
        root,
        result,
        job,
        retainedOutput,
      );
      if (!cleaned.ok) {
        const rootFailure = new ProviderCleanupError(
          SQLITE_PROVIDER_IDENTITY.id,
          [root.path],
          { reason: "SQLite runtime root cleanup remains unresolved." },
          { operation },
        );
        cleaned.error.bindCleanupDependencies([rootFailure]);
        this.#pendingCleanup.set(root, {
          job,
          result,
          output: retainedOutput,
          rootFailure,
          processFailure: undefined,
          process: undefined,
        });
        return cleaned;
      }
    }
    if (result.ok && options?.signal?.aborted)
      return err(
        new AnalysisCancelledError(operation, {
          cause: options.signal.reason,
          partialObservation: completedSqliteEvidence(job, result.value),
        }),
      );
    return result;
  }
}

const createSqliteObservation = (
  report: SqliteReport,
  path: string,
): AnalysisExecution => {
  const locations: AnalysisExecution["locations"][number][] = [
    { kind: "artifact-path", path },
  ];
  if (report.wal !== null)
    locations.push({ kind: "artifact-path", path: report.wal.path });
  return createAnalysisExecution(
    report,
    { ...SQLITE_PROVIDER_IDENTITY, version: `SQLite ${report.engine.version}` },
    {
      rawResult: null,
      subject: { path, format: "file", sha256: report.artifact.sha256 },
      locations,
      limitations: report.limitations,
    },
  );
};
const cleanupSqliteRoot = async (
  root: Pick<PrivateRuntimeRoot, "path" | "close">,
  result: Result<AnalysisExecution, AnalysisError>,
  job: SqliteJob,
  output?: AnalysisCapturedOutput,
): Promise<Result<null, AnalysisError>> => {
  try {
    await root.close();
    return ok(null);
  } catch (cause: unknown) {
    return err(
      sqliteCleanupFailure(
        [root.path],
        cause instanceof Error ? cause.message : String(cause),
        result,
        job,
        output,
        undefined,
        cause,
      ),
    );
  }
};

const sqliteCleanupFailure = (
  resources: readonly string[],
  reason: string,
  result: SqliteOutcome,
  job: SqliteJob,
  output?: AnalysisCapturedOutput,
  details?: Readonly<Record<string, JsonValue>>,
  cause?: unknown,
): ProviderCleanupError => {
  const partialObservation = result.ok
    ? completedSqliteEvidence(job, result.value)
    : result.error.partialObservation;
  return new ProviderCleanupError(
    SQLITE_PROVIDER_IDENTITY.id,
    resources,
    {
      ...details,
      reason,
      previous_error: result.ok ? null : projectAnalysisError(result.error),
      ...(output === undefined ? {} : { captured_output: { ...output } }),
    },
    {
      operation: job.work.operation,
      ...(result.ok ? {} : { cleanupPrimary: result.error }),
      ...(cause === undefined ? {} : { cause }),
      ...(partialObservation === undefined ? {} : { partialObservation }),
    },
  );
};

const completedSqliteEvidence = (
  job: SqliteJob,
  execution: AnalysisExecution,
) =>
  createEvidence(execution.subject ?? undefined, execution.provider, {
    operation: job.work.operation,
    parameters: job.parameters,
    result: execution.result,
    confidence: "observed",
    locations: execution.locations,
    limitations: execution.limitations,
  });

const validateSqliteJob = (job: SqliteJob): void => {
  if (job.inputProblem !== undefined || !isAbsolute(job.work.input.path))
    throw new AnalysisInputError(job.work.operation, undefined, [
      {
        path: ["path"],
        reason: "invalid_format",
        message:
          job.inputProblem ?? "path must be an absolute local filesystem path",
      },
    ]);
};
