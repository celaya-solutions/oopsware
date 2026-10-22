import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import {
  ArtifactFileCleanupFailure,
  bindArtifactFileCleanup,
  artifactFileCancellationCause,
} from "../artifacts/ArtifactFileOperation.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import {
  AnalysisError,
  type AnalysisCapturedOutput,
} from "../domain/analysisErrorBase.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisCapabilityUnavailableError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { OwnedCommandFailure } from "../process/OwnedCommand.js";
import type { ProviderProcessSnapshot } from "../process/ProviderProcess.js";
import {
  SQLITE_PROVIDER_IDENTITY,
  type SqliteOperation,
} from "../domain/sqlite/sqliteDatabase.js";
import { SQLITE_DATABASE_LIMITS } from "./SqliteDatabaseLimits.js";

/** Preserve diagnostics independently of worker exit and private-root cleanup. */
export const capturedSqliteOutput = (
  snapshot: ProviderProcessSnapshot,
): AnalysisCapturedOutput => ({
  stdout: snapshot.stdout.text,
  stderr: snapshot.stderr.text,
  truncated: snapshot.diagnosticTruncated === true,
});

/** The file-set member a filesystem error names, if it is the database, its WAL or its journal. */
const busyMember = (cause: Error, path: string): string => {
  const failed = "path" in cause ? cause.path : undefined;
  return typeof failed === "string" &&
    [path, `${path}-wal`, `${path}-journal`].includes(failed)
    ? failed
    : path;
};

/** Preserve artifact, caller, process, resource and output failure meanings. */
export const sqliteDatabaseFailure = (
  cause: unknown,
  path: string,
  phase: string,
  operation: SqliteOperation,
  signal?: AbortSignal,
): AnalysisError => {
  if (cause instanceof AnalysisError) return cause;
  if (cause instanceof ArtifactReaderFailure) {
    if (cause.cleanup !== undefined) {
      const physicalRead =
        cause instanceof ArtifactFileCleanupFailure
          ? cause.fileCleanupFailure.outcome
          : undefined;
      let previous: AnalysisError | undefined;
      if (physicalRead?.kind === "failed")
        previous = sqliteDatabaseFailure(
          physicalRead.cause,
          path,
          phase,
          operation,
        );
      else if (cause.reason === "cancelled")
        previous = new AnalysisCancelledError(operation, {
          cause: artifactFileCancellationCause(cause),
        });
      else if (physicalRead?.kind === "completed") previous = undefined;
      else if (cause.cause !== undefined)
        previous = sqliteDatabaseFailure(cause.cause, path, phase, operation);
      else if (signal?.aborted)
        previous = new AnalysisCancelledError(operation, {
          cause: signal.reason,
        });
      const error = new ProviderCleanupError(
        SQLITE_PROVIDER_IDENTITY.id,
        cause.cleanup.resources,
        {
          reason: cause.cleanup.reason,
          previous_error:
            previous === undefined ? null : projectAnalysisError(previous),
        },
        {
          operation,
          cause,
          ...(previous === undefined ? {} : { cleanupPrimary: previous }),
        },
      );
      bindArtifactFileCleanup(cause, error);
      return error;
    }
    if (cause.reason === "io" && cause.cause !== undefined)
      return sqliteDatabaseFailure(cause.cause, path, phase, operation, signal);
    if (cause.reason === "integrity")
      return new AnalysisArtifactChangedError(operation, path, cause.message, {
        cause,
      });
    if (cause.reason === "cancelled")
      return new AnalysisCancelledError(operation, {
        cause: artifactFileCancellationCause(cause),
      });
    return new AnalysisInputError(operation, { cause }, [
      {
        path: ["path"],
        reason: "invalid_format",
        message: cause.message,
      },
    ]);
  }
  if (cause instanceof Error && cause.name === "AbortError")
    return new AnalysisCancelledError(operation, {
      cause:
        signal?.aborted === true && cause.cause === signal.reason
          ? signal.reason
          : cause,
    });
  if (cause instanceof OwnedCommandFailure) {
    const projected = ownedCommandFailure(cause, operation);
    if (projected !== undefined) return projected;
  }
  if (phase === "artifact-read" && cause instanceof Error && "code" in cause) {
    if (cause.code === "EACCES" || cause.code === "EPERM")
      return new AnalysisAccessDeniedError(operation, path, cause.code, {
        cause,
      });
    // Windows reports a sharing violation as EBUSY: another process holds the file without read
    // sharing. The unchanged request succeeds once that process releases it. Name the member of the
    // file set that was busy (the database, its WAL or its journal) when the error identifies it.
    if (cause.code === "EBUSY")
      return new AnalysisCapabilityUnavailableError(
        SQLITE_PROVIDER_IDENTITY.id,
        operation,
        `Selected database file set is in use by another process (EBUSY): ${busyMember(cause, path)}`,
        {
          cause,
          retryable: true,
          userMessage:
            "The selected SQLite database is held open by another process without read sharing. Close that application or inspect a copy, then retry.",
        },
      );
    if (
      cause.code === "ENOENT" ||
      cause.code === "ENOTDIR" ||
      cause.code === "ELOOP" ||
      cause.code === "ENAMETOOLONG"
    )
      return new AnalysisInputError(operation, { cause }, [
        {
          path: ["path"],
          reason: "invalid_value",
          message: `Selected database file set could not be read (${String(cause.code)}): ${path}`,
        },
      ]);
  }
  return new ProviderAdapterError(SQLITE_PROVIDER_IDENTITY.id, operation, {
    cause,
    diagnostics: {
      phase,
      path,
      reason: cause instanceof Error ? cause.message : String(cause),
      ...(cause instanceof OwnedCommandFailure && cause.snapshot !== null
        ? {
            failure_kind: cause.reason,
            exit_code: cause.snapshot.exitCode ?? null,
            signal: cause.snapshot.signal ?? null,
            captured_output: { ...capturedSqliteOutput(cause.snapshot) },
          }
        : {}),
    },
  });
};

const ownedCommandFailure = (
  cause: OwnedCommandFailure,
  operation: SqliteOperation,
): AnalysisError | undefined => {
  const capturedOutput =
    cause.snapshot === null ? undefined : capturedSqliteOutput(cause.snapshot);
  const options = {
    cause,
    ...(capturedOutput === undefined ? {} : { capturedOutput }),
  };
  if (cause.cleanupFailure !== null)
    return new ProviderCleanupError(
      SQLITE_PROVIDER_IDENTITY.id,
      cause.resources,
      {
        reason: cause.cleanupFailure,
        previous_error: {
          failure_kind: cause.reason,
          message: cause.message,
        },
        ...(capturedOutput === undefined
          ? {}
          : { captured_output: { ...capturedOutput } }),
      },
      { operation, cause },
    );
  if (cause.reason === "cancelled")
    return new AnalysisCancelledError(operation, {
      ...options,
      cause:
        cause.cancellation === undefined ? cause : cause.cancellation.reason,
    });
  if (cause.reason === "timeout")
    return new AnalysisTimeoutError(
      operation,
      SQLITE_DATABASE_LIMITS.timeoutMs,
      options,
    );
  if (cause.reason === "output-limit")
    return new AnalysisOutputError(operation, cause.message, options);
  if (
    cause.snapshot?.stderr.text.includes("JavaScript heap out of memory") ===
    true
  )
    return new AnalysisResourceConstraintError(
      operation,
      "memory",
      "Owned SQLite worker reported JavaScript heap exhaustion.",
      {
        javascript_heap_bytes: 256 * 1024 * 1024,
      },
      options,
    );
  return undefined;
};
