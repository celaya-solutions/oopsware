import type { WebPageInspection } from "./browserObservationSchemas.js";
import {
  analyzeScript,
  emptyAccumulator,
  isIncludedScript,
  type IncludedScript,
} from "./webBundleAnalyzerInspection.js";
import { buildCapturedWebBundleAnalysis } from "./webBundleAnalyzerResult.js";
import type { WebBundleAnalysis } from "./webBundleAnalysis.js";
import {
  webBundleScriptAnalysisSchema,
  type WebBundleScriptAnalysis,
} from "./webBundleScriptAnalysis.js";

/** Analyze one selected captured script without executing its source. */
export const analyzeCapturedWebScript = (
  script: IncludedScript,
): WebBundleScriptAnalysis => {
  const accumulator = emptyAccumulator();
  analyzeScript(script, accumulator);
  const failed = accumulator.failedScripts.length > 0;
  const recovered = accumulator.recoveredScripts.length > 0;
  return webBundleScriptAnalysisSchema.parse({
    status: "analyzed",
    script_key: script.script_key,
    parse_status: failed ? "failed" : recovered ? "recovered" : "parsed",
    visited_ast_nodes: accumulator.visitedNodes,
    widened_return_references: accumulator.widenedScripts.length > 0,
    observations: {
      edges: accumulator.edges,
      routes: accumulator.routes,
      endpoints: accumulator.endpoints,
      webmcp_declarations: accumulator.webMcp,
    },
    inferences: accumulator.inferences,
  });
};

/** Analyze selected captured JavaScript source without execution. */
export const analyzeCapturedWebBundle = (
  inspection: WebPageInspection,
  sourceMaps: WebBundleAnalysis["observations"]["source_maps"] = {
    status: "not_requested",
    requested: 0,
    processed: 0,
    items: [],
  },
): WebBundleAnalysis => {
  const sourceScripts = inspection.scripts.items.filter(isIncludedScript);
  return buildCapturedWebBundleAnalysis(
    inspection,
    sourceMaps,
    sourceScripts.map(analyzeCapturedWebScript),
  );
};
