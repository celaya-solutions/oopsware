import { JadxInterruption } from "./JadxInterruption.js";
import { z } from "zod";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisOutputError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import type { AndroidRequest } from "../domain/android/androidAnalysis.js";
import {
  stableFileHashCause,
  StableFileHashFailure,
} from "../filesystem/StableFileHash.js";
import {
  RegularFileCleanupFailure,
  regularFileCancellation,
} from "../filesystem/OwnedRegularFile.js";
import type { JadxSession } from "./JadxSession.js";
import type { JadxMcpTransport } from "./JadxMcpTransport.js";

interface FailureContext {
  readonly cause: unknown;
  readonly request: AndroidRequest;
  readonly timeout: AbortSignal;
  readonly timeoutMs: number;
  readonly signal: AbortSignal | undefined;
  readonly session: JadxSession | undefined;
}

type DiagnosticFailure = {
  readonly operation: string;
  readonly cause: unknown;
  readonly transport: JadxMcpTransport | undefined;
} & (
  | { readonly kind: "startup"; readonly command: string }
  | { readonly kind: "execution" }
  | { readonly kind: "output"; readonly reason: string }
  | { readonly kind: "cancelled" }
  | { readonly kind: "timeout"; readonly timeoutMs: number }
);

/** Freeze failure selection now; read diagnostics once after owned finalization. */
export const captureJadxFailure = (
  context: FailureContext,
): (() => AnalysisError) => {
  const observed = observeJadxFailure(context);
  const partial = context.session?.partialObservation();
  let projected: AnalysisError | undefined;
  return () => {
    if (projected === undefined) {
      projected =
        observed instanceof AnalysisError
          ? observed
          : presentDiagnosticFailure(observed);
      if (partial !== undefined) projected.retainPartialObservation(partial);
    }
    return projected;
  };
};

const observeJadxFailure = (
  context: FailureContext,
): AnalysisError | DiagnosticFailure => {
  const { cause, request, timeout, timeoutMs, signal, session } = context;
  const transport = session?.transport;
  const observed = transport?.observedFailure();
  const diagnostic = {
    operation: request.operation,
    transport,
    cause,
  };
  const physicalFailure = (failureCause: unknown): DiagnosticFailure =>
    session !== undefined && !session.initialized()
      ? {
          ...diagnostic,
          cause: failureCause,
          kind: "startup",
          command: session.transport.options.command,
        }
      : { ...diagnostic, cause: failureCause, kind: "execution" };
  const interruptionFailure = (reason: unknown): DiagnosticFailure => {
    if (timeout.aborted && reason === timeout.reason)
      return {
        ...diagnostic,
        cause: reason,
        kind: "timeout",
        timeoutMs,
      };
    if (signal?.aborted === true && reason === signal.reason)
      return { ...diagnostic, cause: reason, kind: "cancelled" };
    return physicalFailure(reason);
  };
  // Caller reasons are opaque even when they are instances of our own errors.
  // Only the owning interruption boundary can select this path; a recorded
  // physical failure keeps precedence over a later abort using the same object.
  if (observed?.kind === "interrupted" && cause === observed.reason)
    return interruptionFailure(observed.reason);
  if (cause instanceof JadxInterruption && observed === undefined)
    return interruptionFailure(cause.reason);
  const cancellation = regularFileCancellation(cause);
  const cancellationError =
    cancellation === undefined
      ? undefined
      : timeout.aborted && cancellation.reason === timeout.reason
        ? new AnalysisTimeoutError(request.operation, timeoutMs, {
            cause: cancellation.reason,
          })
        : new AnalysisCancelledError(request.operation, {
            cause: cancellation.reason,
          });
  if (cause instanceof RegularFileCleanupFailure) {
    const primaryCause =
      cause.outcome.kind === "failed"
        ? stableFileHashCause(cause.outcome.cause)
        : cause;
    const primary =
      cancellationError ??
      (primaryCause instanceof AnalysisError
        ? primaryCause
        : new ProviderAdapterError("jadx", request.operation, {
            cause: primaryCause,
            userMessage:
              primaryCause instanceof Error
                ? primaryCause.message
                : String(primaryCause),
          }));
    const cleanup = new ProviderCleanupError(
      "jadx",
      [cause.path],
      {
        reason:
          cause.cleanupCause instanceof Error
            ? cause.cleanupCause.message
            : String(cause.cleanupCause),
      },
      { operation: request.operation, cause },
    );
    return analysisErrorWithCleanupFailure(primary, cleanup, request.operation);
  }
  if (cancellationError !== undefined) return cancellationError;
  if (cause instanceof StableFileHashFailure)
    return new ProviderAdapterError("jadx", request.operation, {
      cause: cause.cause,
      userMessage: cause.message,
    });
  if (cause instanceof AnalysisError) return cause;
  if (cause instanceof z.ZodError)
    return {
      ...diagnostic,
      kind: "output",
      reason: "JADX response violated the pinned upstream protocol",
    };
  if (observed?.kind === "protocol")
    return {
      ...diagnostic,
      cause: observed.cause,
      kind: "output",
      reason: observed.cause.message,
    };
  if (observed?.kind === "process") return physicalFailure(observed.cause);
  if (observed?.kind === "exit") return physicalFailure(cause);
  if (observed?.kind === "interrupted")
    return interruptionFailure(observed.reason);
  if (signal?.aborted === true)
    return { ...diagnostic, cause: signal.reason, kind: "cancelled" };
  if (timeout.aborted)
    return { ...diagnostic, cause: timeout.reason, kind: "timeout", timeoutMs };
  return physicalFailure(
    cause instanceof JadxInterruption ? cause.reason : cause,
  );
};

const presentDiagnosticFailure = (
  failure: DiagnosticFailure,
): AnalysisError => {
  const output = failure.transport?.diagnostics();
  const options = {
    cause: failure.cause,
    ...(output === undefined ? {} : { capturedOutput: output }),
  };
  if (failure.kind === "cancelled")
    return new AnalysisCancelledError(failure.operation, options);
  if (failure.kind === "timeout")
    return new AnalysisTimeoutError(
      failure.operation,
      failure.timeoutMs,
      options,
    );
  if (failure.kind === "output")
    return new AnalysisOutputError(failure.operation, failure.reason, options);
  if (failure.kind === "startup") {
    const reason = `Java could not start REA's Android bridge using ${failure.command}: ${failure.cause instanceof Error ? failure.cause.message : String(failure.cause)}. ${output === undefined || output.stderr.length === 0 ? "No launcher stderr was observed." : "Review the retained launcher diagnostics."}${output?.truncated === true ? " Diagnostics are incomplete." : ""} Review the selected Java/JADX configuration; for a JVM memory limit, review REA_JADX_HEAP_MIB and inherited JVM options such as JAVA_TOOL_OPTIONS.`;
    return new AnalysisCapabilityUnavailableError(
      "jadx",
      failure.operation,
      reason,
      {
        ...options,
        userMessage: reason,
      },
    );
  }
  return new ProviderAdapterError("jadx", failure.operation, {
    ...options,
    diagnostics: {
      reason:
        failure.cause instanceof Error
          ? failure.cause.message
          : String(failure.cause),
    },
  });
};
