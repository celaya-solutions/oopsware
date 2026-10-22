import {
  AnalysisInputError,
  type AnalysisInputIssue,
} from "../analysisErrorCore.js";
import type { AnalysisError } from "../analysisErrorBase.js";
import { jsonObjectSchema, type JsonValue } from "../jsonValue.js";
import type { JavaScriptApplicationAnalysisResult } from "../javascript/javascriptApplicationAnalysis.js";
import type { ApplicationNode } from "../javascript/javascriptApplicationGraphSchemas.js";
import { err, ok, type Result } from "../result.js";
import type { JavaScriptModuleReference } from "./javascriptModuleReferences.js";
import {
  javascriptApplicationSourceCoverage,
  type JavaScriptApplicationSourceCoverage,
} from "./javascriptApplicationCoverage.js";
import { projectJavaScriptFacts } from "./javascriptFactsView.js";
import {
  boundedViewMessages,
  completeWithinViewCoverage as completeCoverage,
  pageViewCoverage as pageCoverage,
} from "./analysisViewCoverage.js";
import type {
  AnalysisViewParent,
  AnalysisViewRequest,
  UnsignedAnalysisView,
} from "./analysisView.js";

const OPERATION = "inspect_analysis_view";

const inputError = (
  issues: readonly AnalysisInputIssue[],
): AnalysisInputError => new AnalysisInputError(OPERATION, undefined, issues);

const jsIncompatible = (detail: string): AnalysisError =>
  inputError([
    {
      path: ["view"],
      reason: "invalid_value",
      message: detail,
    },
  ]);

/** Exact module path or original source-map reference, when available. */
export const javascriptModulePath = (node: ApplicationNode): string | null => {
  if (node.identity.strategy === "canonical-path") return node.identity.path;
  if (node.identity.strategy === "source-map-original")
    return node.identity.original_source;
  for (const observation of node.observations) {
    const path = observation.properties.path;
    if (typeof path === "string") return path;
    const location = observation.evidence.location;
    if (location.available && location.value.kind === "artifact-path")
      return location.value.path;
    if (location.available && location.value.kind === "source-range")
      return location.value.source;
  }
  return null;
};

interface ModuleEntry {
  readonly node: ApplicationNode & {
    readonly kind: JavaScriptModuleReference["kind"];
  };
  readonly path: string | null;
}

const isModuleNode = (node: ApplicationNode): node is ModuleEntry["node"] =>
  node.kind === "javascript-asset" ||
  node.kind === "javascript-module" ||
  node.kind === "source-module";

/** One owner for the module kinds and path semantics of every module view. */
function* moduleEntries(
  nodes: readonly ApplicationNode[],
): Generator<ModuleEntry> {
  for (const node of nodes) {
    if (isModuleNode(node)) yield { node, path: javascriptModulePath(node) };
  }
}

/** Scan retained order once; materialize only the requested matching page. */
const modulePage = (
  nodes: readonly ApplicationNode[],
  view: {
    readonly offset: number;
    readonly limit: number;
    readonly where?: Extract<
      AnalysisViewRequest,
      { kind: "javascript" }
    >["where"];
  },
): { entries: ModuleEntry[]; total: number } => {
  const entries: ModuleEntry[] = [];
  let total = 0;
  for (const entry of moduleEntries(nodes)) {
    if (view.where?.kind !== undefined && entry.node.kind !== view.where.kind)
      continue;
    if (view.where?.path !== undefined && entry.path !== view.where.path)
      continue;
    if (total >= view.offset && entries.length < view.limit)
      entries.push(entry);
    total += 1;
  }
  return { entries, total };
};

const exportNames = (node: ApplicationNode): readonly string[] => {
  const names = new Set<string>();
  for (const observation of node.observations) {
    const value =
      observation.properties.export_names ?? observation.properties.exports;
    if (!Array.isArray(value)) continue;
    for (const entry of value) if (typeof entry === "string") names.add(entry);
  }
  return [...names];
};

const nodeHashes = (node: ApplicationNode): readonly string[] => {
  const hashes = new Set<string>();
  const { identity } = node;
  if (identity.strategy === "content-digest") hashes.add(identity.sha256);
  if (identity.strategy === "canonical-path")
    hashes.add(identity.artifact_sha256);
  if (identity.strategy === "source-map-original") {
    hashes.add(identity.source_map_sha256);
    if (identity.source_sha256 !== null) hashes.add(identity.source_sha256);
  }
  for (const observation of node.observations) {
    for (const key of [
      "sha256",
      "container_sha256",
      "entry_sha256",
      "source_sha256",
    ] as const) {
      const value = observation.properties[key];
      if (typeof value === "string" && /^[a-f0-9]{64}$/u.test(value))
        hashes.add(value);
    }
  }
  return [...hashes];
};

const sourceRanges = (node: ApplicationNode): readonly JsonValue[] =>
  node.observations.flatMap((observation) => {
    const location = observation.evidence.location;
    return location.available && location.value.kind === "source-range"
      ? [location.value]
      : [];
  });

const moduleItem = (node: ApplicationNode): JsonValue => ({
  node_id: node.node_id,
  kind: node.kind,
  path: javascriptModulePath(node),
  identity: node.identity,
  hashes: [...nodeHashes(node)],
  exports: [...exportNames(node)],
  source_ranges: [...sourceRanges(node)],
  observations: node.observations.map((observation) => ({
    observation_id: observation.observation_id,
    label: observation.label,
    properties: observation.properties,
    evidence: {
      ...observation.evidence,
      location: observation.evidence.location,
    },
  })),
});

const moduleReference = ({
  node,
  path,
}: ModuleEntry): JavaScriptModuleReference => {
  let ranges = 0;
  const support = new Map<string, JavaScriptModuleReference["basis"][number]>();
  for (const { evidence } of node.observations) {
    if (
      evidence.location.available &&
      evidence.location.value.kind === "source-range"
    )
      ranges += 1;
    const { authority, state, confidence } = evidence;
    support.set(`${authority}:${state}:${confidence}`, {
      authority,
      state,
      confidence,
    });
  }
  return {
    node_id: node.node_id,
    kind: node.kind,
    path,
    identity: node.identity,
    retained_source_range_count: ranges,
    basis: [...support.values()],
  };
};

const javascriptCoverageUnknowns = (
  coverage: JavaScriptApplicationSourceCoverage,
): readonly string[] => {
  const unknowns: string[] = [];
  if (coverage.application.status !== "complete")
    unknowns.push(`graph.coverage.status is ${coverage.application.status}`);
  if (coverage.semantic.status !== "complete")
    unknowns.push(
      `semantic_graph.coverage.status is ${coverage.semantic.status}`,
    );
  const applicationUnknowns = coverage.application_unknown_count;
  if (applicationUnknowns > 0)
    unknowns.push(
      `${String(applicationUnknowns)} application graph unknowns remain in the parent Evidence.`,
    );
  if (coverage.semantic_unknown_count > 0)
    unknowns.push(
      `${String(coverage.semantic_unknown_count)} semantic graph unknowns remain in the parent Evidence.`,
    );
  return unknowns;
};

const parentFields = (
  parent: AnalysisViewParent,
  analysis: JavaScriptApplicationAnalysisResult,
  sourceCoverage: JavaScriptApplicationSourceCoverage,
) => {
  const limitations = [
    ...analysis.limitations,
    ...analysis.graph.limitations,
    ...analysis.semantic_graph.limitations,
  ];
  return {
    parent_evidence_id: parent.evidenceId,
    parent_operation: "analyze_javascript_application" as const,
    parent_digest: parent.evidenceId.slice(3),
    artifact: {
      path: analysis.input_path,
      sha256: analysis.root_artifact_sha256,
    },
    limitations: boundedViewMessages(
      [...parent.limitations, ...limitations],
      parent.evidenceId,
      "limitations",
    ),
    unknowns: boundedViewMessages(
      limitations,
      parent.evidenceId,
      "unknowns",
      javascriptCoverageUnknowns(sourceCoverage),
    ),
  };
};

const selectModule = (
  modules: readonly ModuleEntry[],
  selector: Extract<AnalysisViewRequest, { readonly kind: "item" }>["selector"],
): Result<ApplicationNode, AnalysisError> => {
  if ("node_id" in selector) {
    const matches = modules.filter(
      ({ node }) => node.node_id === selector.node_id,
    );
    if (matches.length === 1) {
      const selected = matches[0];
      if (selected !== undefined) return ok(selected.node);
    }
    return err(
      inputError([
        {
          path: ["view", "selector", "node_id"],
          reason: "invalid_value",
          message: `No module has node_id ${JSON.stringify(selector.node_id)}. Page the modules collection to inspect available identities.`,
        },
      ]),
    );
  }
  if ("path" in selector) {
    const matches = modules.filter((entry) => entry.path === selector.path);
    if (matches.length === 1) {
      const selected = matches[0];
      if (selected !== undefined) return ok(selected.node);
    }
    if (matches.length === 0)
      return err(
        inputError([
          {
            path: ["view", "selector", "path"],
            reason: "invalid_value",
            message: `No module has path ${JSON.stringify(selector.path)}. Page the modules collection to inspect exact paths and node_id values.`,
          },
        ]),
      );
    return err(
      inputError([
        {
          path: ["view", "selector", "path"],
          reason: "invalid_value",
          message: `Multiple modules have path ${JSON.stringify(selector.path)}; select one by node_id.`,
          expected: matches.map((entry) => ({ node_id: entry.node.node_id })),
        },
      ]),
    );
  }
  return err(
    jsIncompatible("Module items are selected by exact path or node_id."),
  );
};

/** Project one JavaScript application view without re-running reconstruction. */
export const projectJavaScriptApplicationView = (
  parent: AnalysisViewParent,
  analysis: JavaScriptApplicationAnalysisResult,
  view: Exclude<
    AnalysisViewRequest,
    { kind: "api-surface" | "environment-manifest" | "environment-state" }
  >,
): Result<UnsignedAnalysisView, AnalysisError> => {
  if (
    view.kind !== "summary" &&
    view.kind !== "item" &&
    view.kind !== "page" &&
    view.kind !== "javascript" &&
    view.kind !== "javascript-facts"
  )
    return err(
      jsIncompatible(
        "JavaScript application Evidence supports summary, module item/page, typed module references or selected JavaScript facts.",
      ),
    );
  const sourceCoverage = javascriptApplicationSourceCoverage(analysis);
  const shared = parentFields(parent, analysis, sourceCoverage);
  if (view.kind === "javascript-facts") {
    const { rows, total } = projectJavaScriptFacts(analysis.graph.nodes, view);
    return ok({
      ...shared,
      kind: "javascript-facts",
      view,
      rows,
      source_coverage: sourceCoverage,
      coverage: pageCoverage(view.offset, rows.length, total),
    });
  }
  if (view.kind === "javascript") {
    const { entries, total } = modulePage(analysis.graph.nodes, view);
    const rows = entries.map(moduleReference);
    return ok({
      ...shared,
      kind: "javascript",
      view,
      rows,
      source_coverage: sourceCoverage,
      coverage: pageCoverage(view.offset, rows.length, total),
    });
  }
  if (view.kind === "summary") {
    const moduleCount = analysis.graph.nodes.reduce(
      (count, node) => count + Number(isModuleNode(node)),
      0,
    );
    return ok({
      kind: "summary",
      view,
      summary: {
        input_path: analysis.input_path,
        format: analysis.format,
        root_artifact_sha256: analysis.root_artifact_sha256,
        ...(analysis.source_selection === undefined
          ? {}
          : {
              source_selection: analysis.source_selection,
            }),
        statistics: jsonObjectSchema.parse(analysis.statistics),
        electron: jsonObjectSchema.parse(analysis.summary),
        coverage: jsonObjectSchema.parse({
          application: analysis.graph.coverage,
          semantic: {
            ...analysis.semantic_graph.coverage,
            families: analysis.semantic_graph.coverage.families.map(
              ({ unknown_ids, ...family }) => ({
                ...family,
                unknown_count: unknown_ids.length,
              }),
            ),
          },
          application_unknowns: sourceCoverage.application_unknown_count,
          semantic_unknowns: sourceCoverage.semantic_unknown_count,
        }),
        limitation_count: analysis.limitations.length,
      },
      coverage: completeCoverage(moduleCount, analysis.graph.nodes.length),
      ...shared,
    });
  }
  if (view.kind === "item") {
    if (view.collection !== "modules")
      return err(
        jsIncompatible(
          "Section and symbol collections apply to inspect_binary_layout Evidence.",
        ),
      );
    const modules = [...moduleEntries(analysis.graph.nodes)];
    const selected = selectModule(modules, view.selector);
    if (!selected.ok) return selected;
    return ok({
      kind: "item",
      view,
      item: moduleItem(selected.value),
      coverage: completeCoverage(1, modules.length),
      ...shared,
    });
  }
  if (view.kind !== "page" || view.collection !== "modules")
    return err(
      jsIncompatible(
        "Section and symbol collections apply to inspect_binary_layout Evidence.",
      ),
    );
  const { entries, total } = modulePage(analysis.graph.nodes, view);
  const items = entries.map(({ node, path }) => ({
    node_id: node.node_id,
    kind: node.kind,
    path,
  }));
  return ok({
    kind: "page",
    view,
    items,
    coverage: pageCoverage(view.offset, items.length, total),
    ...shared,
  });
};
