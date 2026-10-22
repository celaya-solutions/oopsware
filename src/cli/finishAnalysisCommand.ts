import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import {
  AnalysisError,
  type AnalysisPartialObservation,
} from "../domain/analysisErrorBase.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import type { Result } from "../domain/result.js";

/** Finish a one-shot CLI operation while retaining primary results through close. */
export const finishAnalysisCommand = async <
  Value extends AnalysisPartialObservation,
>(
  run: () => Promise<Result<Value, AnalysisError>>,
  service: { close(): Promise<void> },
  providerId: string,
  canonicalOperation: string,
  signal: AbortSignal,
  fallbackResource?: string,
): Promise<Value | ReturnType<typeof projectAnalysisError>> => {
  let result: Result<Value, AnalysisError>;
  try {
    result = await run();
  } catch (cause) {
    result = {
      ok: false,
      error:
        cause instanceof AnalysisError
          ? cause
          : new ProviderAdapterError(providerId, canonicalOperation, { cause }),
    };
  }
  try {
    // Resource owners may resolve their retained errors during close. This
    // adapter cannot infer resolution of a producer's earlier cleanup failure.
    await service.close();
  } catch (cause) {
    let cleanup: AnalysisError;
    if (cause instanceof AnalysisError) cleanup = cause;
    else {
      const observation =
        cause instanceof ArtifactReaderFailure
          ? ArtifactReaderFailure.cleanupObservation(
              cause,
              fallbackResource ?? `${canonicalOperation} resources`,
            )
          : {
              reason: cause instanceof Error ? cause.message : String(cause),
              resources: [],
            };
      cleanup = new ProviderCleanupError(
        providerId,
        observation.resources,
        { reason: observation.reason },
        { cause, operation: canonicalOperation },
      );
    }
    if (result.ok) cleanup.retainPartialObservation(result.value);
    return projectAnalysisError(
      result.ok
        ? cleanup
        : analysisErrorWithCleanupFailure(
            result.error,
            cleanup,
            canonicalOperation,
          ),
    );
  }
  if (result.ok && signal.aborted)
    return projectAnalysisError(
      new AnalysisCancelledError(canonicalOperation, {
        cause: signal.reason,
        partialObservation: result.value,
      }),
    );
  return result.ok ? result.value : projectAnalysisError(result.error);
};
