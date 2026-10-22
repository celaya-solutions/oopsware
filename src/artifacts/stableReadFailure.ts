import { ArtifactReaderFailure } from "./ArtifactReader.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisAccessDeniedError,
  AnalysisCancelledError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import { ArtifactOperationError } from "../domain/artifactOperationError.js";

/** Typed failure for a {@link readStableArtifact} call that produced no bytes. */
export const stableReadFailure = (
  operation: ArtifactOperationError["operation"],
  path: string,
  cause: unknown,
  options: {
    readonly cancelled: boolean;
    readonly maxFileBytes: number;
    readonly remediationAction: string;
  },
): AnalysisError => {
  if (options.cancelled)
    return new AnalysisCancelledError(operation, { cause });
  if (cause instanceof ArtifactReaderFailure && cause.reason === "limit")
    return new AnalysisResourceConstraintError(
      operation,
      "file-size",
      cause.message,
      { max_file_bytes: options.maxFileBytes },
      { cause, remediationAction: options.remediationAction },
    );
  const code =
    cause instanceof Error && "code" in cause ? String(cause.code) : undefined;
  if (code === "EACCES" || code === "EPERM")
    return new AnalysisAccessDeniedError(operation, path, code, { cause });
  return new ArtifactOperationError(
    operation,
    cause instanceof ArtifactReaderFailure
      ? cause.reason
      : code === "ENOENT"
        ? "path"
        : "io",
    undefined,
    cause instanceof Error ? cause.message : "Artifact read failed.",
    { cause },
  );
};
