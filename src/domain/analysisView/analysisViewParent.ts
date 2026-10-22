import type { z } from "zod";
import type { AnalysisError } from "../analysisErrorBase.js";
import { analysisInputErrorFromIssues } from "../inputIssueProjection.js";
import { err, ok, type Result } from "../result.js";
import type { AnalysisViewParent } from "./analysisView.js";

/** Parse a parent's result with its owning schema; issues point into the view source. */
export const parseAnalysisViewResult = <Schema extends z.ZodType>(
  schema: Schema,
  parent: AnalysisViewParent,
): Result<z.output<Schema>, AnalysisError> => {
  const parsed = schema.safeParse(parent.normalizedResult);
  if (parsed.success) return ok(parsed.data);
  return err(
    analysisInputErrorFromIssues(
      "inspect_analysis_view",
      parsed.error.issues.map((issue) => ({
        ...issue,
        path: ["source", "normalized_result", ...issue.path],
      })),
      { source: { normalized_result: parent.normalizedResult } },
      { cause: parsed.error },
    ),
  );
};
