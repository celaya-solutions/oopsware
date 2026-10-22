import { z } from "zod";
import { applicationCoverageSchema } from "../javascript/javascriptApplicationEvidenceSchemas.js";
import type { JavaScriptApplicationAnalysisResult } from "../javascript/javascriptApplicationAnalysis.js";
import { javaScriptSemanticGraphInputSchema } from "../javascript/javascriptSemanticGraphSchemas.js";
import { javaScriptSourceSelectionSchema } from "../javascript/javascriptSourceSelection.js";

/** Source completeness is independent of exhausting a selected fact page. */
export const javascriptApplicationSourceCoverageSchema = z.strictObject({
  source_selection: javaScriptSourceSelectionSchema.exactOptional(),
  application: applicationCoverageSchema,
  semantic: javaScriptSemanticGraphInputSchema.shape.coverage.omit({
    families: true,
  }),
  application_unknown_count: z.number().int().nonnegative(),
  semantic_unknown_count: z.number().int().nonnegative(),
});

export type JavaScriptApplicationSourceCoverage = z.infer<
  typeof javascriptApplicationSourceCoverageSchema
>;

/** Reuse retained coverage and count its unknowns once for every view. */
export const javascriptApplicationSourceCoverage = (
  analysis: JavaScriptApplicationAnalysisResult,
): JavaScriptApplicationSourceCoverage => {
  const { families: _families, ...semantic } = analysis.semantic_graph.coverage;
  return {
    ...(analysis.source_selection === undefined
      ? {}
      : { source_selection: analysis.source_selection }),
    application: analysis.graph.coverage,
    semantic,
    application_unknown_count: analysis.graph.nodes.reduce(
      (count, node) => count + Number(node.kind === "unknown"),
      0,
    ),
    semantic_unknown_count: analysis.semantic_graph.unknowns.length,
  };
};
