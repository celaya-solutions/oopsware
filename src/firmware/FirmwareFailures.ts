import type { AnalysisCleanupLease } from "../artifacts/AnalysisCleanupLease.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import {
  ArtifactFileCleanupFailure,
  artifactFileCancellationCause,
  bindArtifactFileCleanup,
} from "../artifacts/ArtifactFileOperation.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisTimeoutError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import type { FirmwareDeadline } from "./FirmwareDeadline.js";
import { firmwareDeadlineElapsed } from "./FirmwareDeadline.js";
import type { AnalysisErrorOptions } from "../domain/analysisErrorBase.js";
import { z } from "zod";

type FirmwarePublicationProgress = {
  readonly output_directory: string;
  readonly verified_files: number;
  readonly total_files: number;
};

interface FirmwareFailureContext {
  readonly engine: string;
  readonly operation: string;
  readonly deadline?: FirmwareDeadline | undefined;
  readonly treeCleanupLease?: AnalysisCleanupLease | undefined;
  readonly publication?: FirmwarePublicationProgress | undefined;
}

const timeoutFailure = (
  operation: string,
  reason: unknown,
  deadline: FirmwareDeadline,
  options: Pick<AnalysisErrorOptions, "partialObservation"> & {
    readonly publication?: FirmwarePublicationProgress | undefined;
  } = {},
): AnalysisTimeoutError =>
  new AnalysisTimeoutError(operation, deadline.timeoutMs, {
    cause: reason,
    partialObservation: options.partialObservation,
    diagnostics: {
      phase: deadline.phase,
      ...(options.publication === undefined
        ? {}
        : { publication: options.publication }),
    },
    ...(deadline.phase === "publication"
      ? {
          userMessage: `Firmware publication exceeded its ${deadline.timeoutMs}ms budget. Extraction already completed.`,
          remediationAction:
            "Read any retained publication receipt first. For a retry, choose an absent local output directory or increase publication_timeout_ms (--publication-timeout-ms in the CLI).",
        }
      : {}),
  });

/** Translate the producing file owner's outcome without guessing from a later signal. */
export const firmwareFailure = (
  cause: unknown,
  context: FirmwareFailureContext,
): AnalysisError => {
  const { engine, operation, deadline, treeCleanupLease, publication } =
    context;
  if (
    cause instanceof AnalysisCancelledError &&
    deadline?.signal.aborted &&
    cause.cause === deadline.signal.reason
  )
    return timeoutFailure(operation, cause.cause, deadline, {
      partialObservation: cause.partialObservation,
      publication,
    });
  if (cause instanceof AnalysisError) return cause;
  if (cause instanceof ArtifactReaderFailure && cause.cleanup !== undefined) {
    const cleanup = new ProviderCleanupError(
      engine,
      cause.cleanup.resources,
      { reason: cause.cleanup.reason },
      { operation, cause },
    );
    bindArtifactFileCleanup(cause, cleanup);
    if (cause.cleanupLeases === undefined)
      treeCleanupLease?.bindCleanupError(cleanup);
    if (cause instanceof ArtifactFileCleanupFailure) {
      const outcome = cause.fileCleanupFailure.outcome;
      const primary =
        outcome.kind === "failed"
          ? firmwareFailure(outcome.cause, context)
          : cause.fileCleanupFailure.completionCancellation !== undefined
            ? firmwareCancellation(
                operation,
                cause.fileCleanupFailure.completionCancellation.reason,
                deadline,
                publication,
              )
            : undefined;
      if (primary !== undefined)
        return analysisErrorWithCleanupFailure(
          primary,
          cleanup,
          operation,
        ).bindCleanupDependencies([primary, cleanup]);
    }
    if (cause.reason === "cancelled")
      return analysisErrorWithCleanupFailure(
        firmwareCancellation(
          operation,
          artifactFileCancellationCause(cause),
          deadline,
          publication,
        ),
        cleanup,
        operation,
      ).bindCleanupDependencies([cleanup]);
    return cleanup;
  }
  if (cause instanceof ArtifactReaderFailure && cause.reason === "cancelled")
    return firmwareCancellation(
      operation,
      artifactFileCancellationCause(cause),
      deadline,
      publication,
    );
  if (cause instanceof z.ZodError)
    return new AnalysisOutputError(
      operation,
      "Tool report violated the pinned producer protocol",
      { cause },
    );
  return new ProviderAdapterError(engine, operation, {
    cause,
    diagnostics: {
      reason: cause instanceof Error ? cause.message : String(cause),
    },
  });
};

/** Classify the interruption actually observed, before composing cleanup failures. */
export const firmwareCancellation = (
  operation: string,
  reason: unknown,
  deadline?: FirmwareDeadline,
  publication?: FirmwarePublicationProgress,
): AnalysisError =>
  deadline?.signal.aborted && reason === deadline.signal.reason
    ? timeoutFailure(operation, reason, deadline, { publication })
    : new AnalysisCancelledError(operation, { cause: reason });

/** Preserve observed cancellation identity; otherwise enforce the monotonic budget. */
export const firmwarePhaseInterruption = (
  operation: string,
  signal: AbortSignal,
  deadline: FirmwareDeadline,
  publication?: FirmwarePublicationProgress,
): AnalysisError | undefined =>
  signal.aborted
    ? firmwareCancellation(operation, signal.reason, deadline, publication)
    : firmwareDeadlineElapsed(deadline)
      ? timeoutFailure(operation, undefined, deadline, { publication })
      : undefined;
