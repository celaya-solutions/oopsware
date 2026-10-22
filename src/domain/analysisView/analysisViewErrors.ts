import {
  AnalysisInputError,
  type AnalysisInputIssue,
} from "../analysisErrorCore.js";

export const INSPECT_ANALYSIS_VIEW_OPERATION = "inspect_analysis_view" as const;

/** Construct a typed input failure for one selected-view constraint. */
export const analysisViewInputError = (
  issues: readonly AnalysisInputIssue[],
): AnalysisInputError =>
  new AnalysisInputError(INSPECT_ANALYSIS_VIEW_OPERATION, undefined, issues);
