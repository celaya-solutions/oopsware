import type { ExecutionOptions } from "../../application/AnalysisProvider.js";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import { analysisErrorWithCleanupFailure } from "../../domain/analysisErrorCleanup.js";
import { bindArtifactFileCleanup } from "../../artifacts/ArtifactFileOperation.js";
import { artifactFileCancellationCause } from "../../artifacts/ArtifactFileOperation.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
} from "../../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import {
  WEB_NETWORK_CAPTURE_LIMITS,
  type InspectWebNetworkCaptureInput,
} from "../../domain/webNetworkCapture.js";
import { OwnedCommandFailure } from "../../process/OwnedCommand.js";
import {
  NODE_CAPTURE_HEAP_ENFORCED,
  NODE_CAPTURE_HEAP_LIMITS,
  NODE_CAPTURE_PROCESS_MEMORY_LIMIT_BYTES,
} from "./CaptureRelease.js";
const OPERATION = "inspect_web_network_capture";

/** Reason for a decoder whose owned process tree reached its Job Object commit limit. */
export const CAPTURE_PROCESS_MEMORY_LIMIT_REASON =
  "The capture decoder reached its Windows Job Object memory limit";

/** Preserve the origin and typed cause of a historical capture failure. */
export const historicalCaptureFailure = (
  input: InspectWebNetworkCaptureInput,
  cause: unknown,
  phase: "capture-read" | "descriptor-read" | "decoder",
  options?: ExecutionOptions,
): AnalysisError => {
  if (cause instanceof AnalysisError) return cause;
  const descriptorRead = phase === "descriptor-read";
  const sourcePath = descriptorRead
    ? (input.protobuf?.schema?.descriptor_set_path ?? input.capture_path)
    : input.capture_path;
  const inputPath = descriptorRead
    ? ["protobuf", "schema", "descriptor_set_path"]
    : ["capture_path"];
  const sourceLabel = descriptorRead ? "descriptor set" : "capture";
  if (cause instanceof OwnedCommandFailure) {
    if (cause.cleanupFailure !== null)
      return new ProviderCleanupError(
        input.format,
        cause.resources,
        {
          reason: cause.cleanupFailure,
          previous_error: {
            failure_kind: cause.reason,
            message: cause.message,
            exit_code: cause.snapshot?.exitCode ?? null,
            signal: cause.snapshot?.signal ?? null,
            stdout: cause.snapshot?.stdout.text ?? null,
            stderr: cause.snapshot?.stderr.text ?? null,
            diagnostic_truncated: cause.snapshot?.diagnosticTruncated ?? null,
          },
        },
        { operation: OPERATION, cause },
      );
    if (cause.reason === "cancelled")
      return new AnalysisCancelledError(OPERATION, {
        cause:
          cause.cancellation === undefined
            ? options?.signal?.aborted === true
              ? options.signal.reason
              : undefined
            : cause.cancellation.reason,
      });
    if (cause.reason === "timeout")
      return new AnalysisTimeoutError(
        OPERATION,
        WEB_NETWORK_CAPTURE_LIMITS.timeoutMs,
      );
    if (cause.reason === "output-limit")
      return new AnalysisOutputError(OPERATION, cause.message);
    // The job's own notification is runtime-independent; Bun's exit status
    // and diagnostics for an allocation failure are not.
    if (
      phase === "decoder" &&
      cause.reason === "process" &&
      cause.snapshot?.memoryLimitReached === true
    )
      return captureMemoryFailure(
        input,
        CAPTURE_PROCESS_MEMORY_LIMIT_REASON,
        cause,
      );
    if (
      phase === "decoder" &&
      input.format !== "mitmproxy" &&
      cause.reason === "process" &&
      (cause.snapshot?.signal === "SIGABRT" ||
        (cause.snapshot?.signal === null && cause.snapshot.exitCode === 134)) &&
      /FATAL ERROR:[^\r\n]*heap out of memory/u.test(cause.snapshot.stderr.text)
    )
      return captureMemoryFailure(
        input,
        `The ${input.format} decoder exhausted its fixed V8 heap`,
        cause,
      );
  }
  if (
    phase !== "decoder" &&
    cause instanceof ArtifactReaderFailure &&
    cause.reason === "integrity"
  )
    return new AnalysisArtifactChangedError(
      OPERATION,
      sourcePath,
      cause.message,
      { cause },
    );
  if (
    phase !== "decoder" &&
    cause instanceof ArtifactReaderFailure &&
    cause.reason === "cancelled"
  )
    return new AnalysisCancelledError(OPERATION, {
      cause: artifactFileCancellationCause(cause),
    });
  if (
    phase !== "decoder" &&
    cause instanceof ArtifactReaderFailure &&
    (cause.reason === "limit" ||
      cause.reason === "format" ||
      cause.reason === "path")
  )
    return new AnalysisInputError(OPERATION, { cause }, [
      {
        path: inputPath,
        reason: cause.reason === "limit" ? "out_of_range" : "invalid_format",
        message:
          cause.reason === "limit"
            ? `${cause.message}. Select a ${sourceLabel} within the ${WEB_NETWORK_CAPTURE_LIMITS.inputBytes}-byte input budget.`
            : cause.message,
        ...(cause.reason === "limit"
          ? {
              expected: {
                [descriptorRead
                  ? "maximum_descriptor_set_bytes"
                  : "maximum_capture_bytes"]:
                  WEB_NETWORK_CAPTURE_LIMITS.inputBytes,
              },
            }
          : {}),
      },
    ]);
  if (
    phase !== "decoder" &&
    cause instanceof Error &&
    "code" in cause &&
    (cause.code === "EACCES" || cause.code === "EPERM")
  )
    return new AnalysisAccessDeniedError(OPERATION, sourcePath, cause.code, {
      cause,
    });
  if (
    phase !== "decoder" &&
    cause instanceof Error &&
    "code" in cause &&
    ["ENOENT", "ENOTDIR"].includes(String(cause.code))
  )
    return new AnalysisInputError(OPERATION, { cause }, [
      {
        path: inputPath,
        reason: "invalid_value",
        message: `Selected ${sourceLabel} could not be read (${String(cause.code)}): ${sourcePath}.`,
      },
    ]);
  if (
    options?.signal?.aborted === true &&
    (cause === options.signal.reason ||
      (cause instanceof Error &&
        cause.name === "AbortError" &&
        "code" in cause &&
        cause.code === "ABORT_ERR"))
  )
    return new AnalysisCancelledError(OPERATION, {
      cause: options.signal.reason,
    });
  return new ProviderAdapterError(input.format, OPERATION, {
    cause,
    diagnostics: {
      phase,
      capture_path: input.capture_path,
      ...(descriptorRead
        ? { source_path: sourcePath, input_path: inputPath }
        : {}),
      reason: cause instanceof Error ? cause.message : String(cause),
      ...(cause instanceof ArtifactReaderFailure
        ? { failure_kind: cause.reason }
        : {}),
      ...(cause instanceof OwnedCommandFailure && cause.snapshot !== null
        ? {
            exit_code: cause.snapshot.exitCode ?? null,
            signal: cause.snapshot.signal ?? null,
            stdout: cause.snapshot.stdout.text,
            stderr: cause.snapshot.stderr.text,
            diagnostic_truncated: cause.snapshot.diagnosticTruncated ?? false,
          }
        : {}),
    },
  });
};

/** Preserve a decoder's observed memory failure and its actual workload limits. */
export const captureMemoryFailure = (
  input: InspectWebNetworkCaptureInput,
  reason: string,
  cause?: unknown,
): AnalysisResourceConstraintError =>
  new AnalysisResourceConstraintError(
    OPERATION,
    "memory",
    `${reason}: ${input.capture_path}. No complete capture result is available.`,
    {
      boundary: "historical-capture-decoder",
      capture_path: input.capture_path,
      format: input.format,
      maximum_input_bytes: WEB_NETWORK_CAPTURE_LIMITS.inputBytes,
      maximum_reply_bytes: WEB_NETWORK_CAPTURE_LIMITS.outputBytes,
      ...(input.format !== "mitmproxy" && NODE_CAPTURE_HEAP_ENFORCED
        ? {
            old_generation_heap_mib: NODE_CAPTURE_HEAP_LIMITS.oldGenerationMiB,
            semi_space_heap_mib: NODE_CAPTURE_HEAP_LIMITS.semiSpaceMiB,
          }
        : {}),
      ...(input.format !== "mitmproxy" &&
      NODE_CAPTURE_PROCESS_MEMORY_LIMIT_BYTES !== null
        ? {
            process_memory_limit_bytes: NODE_CAPTURE_PROCESS_MEMORY_LIMIT_BYTES,
          }
        : {}),
      ...(cause instanceof OwnedCommandFailure
        ? {
            observed_exit_code: cause.snapshot?.exitCode ?? null,
            observed_signal: cause.snapshot?.signal ?? null,
          }
        : {}),
    },
    {
      cause,
      remediationAction: `Use a smaller capture exported by its producer, or another decoder with sufficient capacity for the original capture. Preserve the original for provenance; a subset does not establish complete-capture coverage.${input.format !== "mitmproxy" && NODE_CAPTURE_HEAP_ENFORCED ? ` Oopsware's Node capture old-generation heap is fixed at ${NODE_CAPTURE_HEAP_LIMITS.oldGenerationMiB} MiB; inherited NODE_OPTIONS cannot raise it.` : ""}${input.format !== "mitmproxy" && NODE_CAPTURE_PROCESS_MEMORY_LIMIT_BYTES !== null ? ` Oopsware's Node capture decoder process commit limit is fixed at ${String(NODE_CAPTURE_PROCESS_MEMORY_LIMIT_BYTES)} bytes.` : ""}`,
      ...(cause instanceof OwnedCommandFailure && cause.snapshot !== null
        ? {
            capturedOutput: {
              stdout: cause.snapshot.stdout.text,
              stderr: cause.snapshot.stderr.text,
              truncated: cause.snapshot.diagnosticTruncated ?? false,
            },
          }
        : {}),
    },
  );

/** Preserve the exact file owner when capture or descriptor acquisition needs cleanup. */
export const withCaptureReaderCleanup = (
  primary: AnalysisError,
  cause: unknown,
): AnalysisError => {
  if (!(cause instanceof ArtifactReaderFailure) || cause.cleanup === undefined)
    return primary;
  if (cause.reason === "unavailable") {
    const cleanup = new ProviderCleanupError(
      "web-network-capture",
      cause.cleanup.resources,
      { reason: cause.cleanup.reason },
      { operation: OPERATION, cause },
    );
    bindArtifactFileCleanup(cause, cleanup);
    return cleanup;
  }
  const cleanup = new ProviderCleanupError(
    "web-network-capture",
    cause.cleanup.resources,
    { reason: cause.cleanup.reason },
    { operation: OPERATION, cause },
  );
  bindArtifactFileCleanup(cause, cleanup);
  const composed = analysisErrorWithCleanupFailure(
    primary,
    cleanup,
    OPERATION,
  ).bindCleanupDependencies([primary, cleanup]);
  bindArtifactFileCleanup(cause, composed);
  return composed;
};
