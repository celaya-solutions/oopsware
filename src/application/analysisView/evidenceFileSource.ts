import { getHeapStatistics } from "node:v8";
import { z } from "zod";

import type { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisResourceConstraintError,
} from "../../domain/analysisErrorCore.js";
import { INSPECT_ANALYSIS_VIEW_OPERATION } from "../../domain/analysisView/analysisViewErrors.js";
import { err, ok, type Result } from "../../domain/result.js";
import { parseEvidence, type Evidence } from "../../domain/evidence.js";
import {
  EvidenceFileError,
  EvidenceIntegrityError,
} from "../../domain/evidenceErrors.js";
import { projectInputIssues } from "../../domain/inputIssueProjection.js";
import { readJsonFile } from "../JsonFiles.js";
import { RegularFileCleanupFailure } from "../RegularFileRead.js";

/** The request's cancellation and the scope that owns descriptors whose close failed. */
export interface EvidenceFileReadOptions {
  readonly signal?: AbortSignal;
  readonly resources?: ArtifactResourceScope;
}

/** Authentication clones the parsed Evidence and hashes its canonical JSON. */
const AUTHENTICATION_COPIES = 2;

/** Conservative bytes a parsed JSON value occupies: UTF-16 text plus container and slot overhead. */
export const estimateJsonValueBytes = (value: unknown): number => {
  let bytes = 0;
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const item = stack.pop();
    if (typeof item === "string") bytes += 64 + item.length * 2;
    else if (Array.isArray(item)) {
      bytes += 128 + item.length * 16;
      for (const entry of item) stack.push(entry);
    } else if (typeof item === "object" && item !== null) {
      bytes += 128;
      for (const [key, entry] of Object.entries(item)) {
        bytes += 64 + key.length * 2;
        stack.push(entry);
      }
    } else bytes += 16;
  }
  return bytes;
};

/** Refuse before authentication when live heap headroom cannot hold its copies of the parsed value. */
export const requireAuthenticationHeadroom = (
  value: unknown,
  path: string,
  availableBytes: number = getHeapStatistics().total_available_size,
): Result<void, AnalysisError> => {
  const valueBytes = estimateJsonValueBytes(value);
  const requiredBytes = valueBytes * AUTHENTICATION_COPIES;
  if (requiredBytes <= availableBytes) return ok(undefined);
  return err(
    new AnalysisResourceConstraintError(
      INSPECT_ANALYSIS_VIEW_OPERATION,
      "memory",
      "Insufficient heap headroom to authenticate the Evidence file",
      {
        input_path: path,
        projected_value_bytes: valueBytes,
        authentication_bytes: requiredBytes,
        available_heap_bytes: availableBytes,
      },
    ),
  );
};

/** Read and authenticate one Evidence file under the request's cancellation and resource scope. */
export const readEvidenceFileSource = async (
  path: string,
  options: EvidenceFileReadOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  const { signal, resources } = options;
  if (signal?.aborted)
    return err(new AnalysisCancelledError(INSPECT_ANALYSIS_VIEW_OPERATION));
  const loaded = await readJsonFile(path, signal, resources).catch(
    (cause: unknown) => {
      // A failed close transfers a live handle owner; preserve that failure.
      if (
        signal?.aborted === true &&
        !(cause instanceof RegularFileCleanupFailure)
      )
        return err(
          new AnalysisCancelledError(INSPECT_ANALYSIS_VIEW_OPERATION, {
            cause,
          }),
        );
      throw cause;
    },
  );
  if (!loaded.ok) return loaded;
  if (signal?.aborted)
    return err(new AnalysisCancelledError(INSPECT_ANALYSIS_VIEW_OPERATION));
  const headroom = requireAuthenticationHeadroom(loaded.value, path);
  if (!headroom.ok) return headroom;
  try {
    return ok(parseEvidence(loaded.value));
  } catch (cause: unknown) {
    if (cause instanceof z.ZodError)
      return err(
        new EvidenceFileError("read", "wrong-kind", {
          path,
          cause,
          contentIssues: projectInputIssues(cause.issues, loaded.value),
          userMessage:
            "The selected file does not contain valid Evidence. Repair or recreate the file and try again.",
        }),
      );
    if (cause instanceof TypeError)
      return err(
        new EvidenceIntegrityError(cause.message, {
          cause,
          userMessage: cause.message,
        }),
      );
    throw cause;
  }
};
