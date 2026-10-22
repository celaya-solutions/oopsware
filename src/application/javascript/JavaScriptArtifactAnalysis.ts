import { createHash } from "node:crypto";

import { moduleResolutionModeForJavaScriptReference } from "../../domain/javascript/javascriptModuleResolutionMode.js";
import { setImmediate } from "node:timers/promises";

import { resolveJavaScriptSourceMapReferences } from "../../domain/javascript/javascriptSourceMapPaths.js";
import { analyzeParsedJavaScriptStaticSourceSteps } from "../../domain/javascript/javascriptStaticAnalysis.js";
import { analyzeParsedJavaScriptSemanticsSteps } from "../../domain/javascript/javascriptSemanticAnalysis.js";
import type { JavaScriptSemanticIr } from "../../domain/javascript/javascriptSemanticIr.js";
import { projectJavaScriptModuleSemantics } from "../../domain/javascript/javascriptModuleSemanticIr.js";
import { parseJavaScriptSource } from "../../domain/javascript/javascriptSourceParser.js";
import { hasValidSourceMapContents } from "../../domain/sourceMapContents.js";
import {
  inspectSourceMapEnvelope,
  sourceMapJsonText,
  sourceMapMappingsSchema,
} from "../../domain/sourceMapEnvelope.js";
import type { SourceMapLeaf } from "../../domain/sourceMapEnvelope.js";
import type { JavaScriptStaticAnalysis } from "../../domain/javascript/javascriptStaticAnalysisTypes.js";
import { failedJavaScriptStaticAnalysis } from "../../domain/javascript/javascriptStaticAnalysisHelpers.js";
import type {
  JavaScriptArtifactFile,
  JavaScriptArtifactFileSet,
} from "../../domain/javascript/javascriptArtifactFiles.js";
import type {
  AnalyzedJavaScriptArtifactFile,
  JavaScriptArtifactAnalysisFailure,
  JavaScriptArtifactAnalysisScope,
  JavaScriptArtifactAnalysis,
  JavaScriptModuleArtifactAnalysis,
  JavaScriptModuleSemanticIr,
  JavaScriptHtmlInlineScriptsObservation,
  JavaScriptHtmlScriptObservation,
  JavaScriptJsonModuleObservation,
  JavaScriptPackageObservation,
  JavaScriptSourceMapObservation,
  JavaScriptSourceMapOriginal,
} from "./JavaScriptArtifactAnalysisTypes.js";
import { javascriptArtifactAnalysisScopes } from "./JavaScriptArtifactAnalysisTypes.js";
import { analyzeJavaScriptJsonModule } from "./JavaScriptJsonModules.js";
import { completeJavaScriptAnalysisSteps } from "./JavaScriptAnalysisControl.js";
import { htmlArtifactReferences } from "../../domain/javascript/htmlArtifactReferences.js";
import type { JavaScriptSourceAnalysisPort } from "../../domain/javascript/javascriptSourceAnalysis.js";
import type { JavaScriptSemanticGraphProjection } from "./JavaScriptSemanticGraphBuilder.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import {
  AnalysisCancelledError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
} from "../../domain/analysisErrorCore.js";

interface MutableArtifactAnalysis<
  SemanticIr extends JavaScriptModuleSemanticIr,
> {
  readonly files: AnalyzedJavaScriptArtifactFile<SemanticIr>[];
  readonly packages: JavaScriptPackageObservation[];
  readonly jsonModules: JavaScriptJsonModuleObservation[];
  readonly htmlScripts: JavaScriptHtmlScriptObservation[];
  readonly htmlInlineScripts: JavaScriptHtmlInlineScriptsObservation[];
  readonly sourceMaps: JavaScriptSourceMapObservation[];
  visitedNodes: number;
  findings: number;
  modules: number;
  parseFailures: number;
}

interface ArtifactAnalysisContext<
  SemanticIr extends JavaScriptModuleSemanticIr,
> {
  readonly state: MutableArtifactAnalysis<SemanticIr>;
  readonly projectSemantics: (
    file: JavaScriptArtifactFile,
    ir: JavaScriptSemanticIr,
  ) => Generator<void, SemanticIr>;
}

/** Analyze every text source from the artifact without a result quota. */
export const analyzeJavaScriptArtifactFiles = (
  fileSet: JavaScriptArtifactFileSet,
): JavaScriptArtifactAnalysis =>
  analyzeArtifactFiles(fileSet, function* (_file, ir) {
    // The full IR needs no projection; one step keeps the shared protocol.
    yield;
    return ir;
  });

/**
 * Project each file's full IR immediately, retaining only later module facts.
 * Parsing, analysis and each projection pass run as separate steps, so control
 * messages and cancellation are handled within one large file as well.
 */
export const analyzeAndProjectJavaScriptArtifactFiles = async (
  fileSet: JavaScriptArtifactFileSet,
  projectSemantics: (
    file: JavaScriptArtifactFile,
    ir: JavaScriptSemanticIr,
  ) => Iterator<void, void> | void,
  beforeFile?: (
    file: JavaScriptArtifactFile,
    completed: number,
    total: number,
  ) => Promise<void>,
  signal?: AbortSignal,
): Promise<JavaScriptModuleArtifactAnalysis> => {
  const state = emptyArtifactAnalysis<JavaScriptModuleSemanticIr>();
  const projectFileSemantics = function* (
    file: JavaScriptArtifactFile,
    ir: JavaScriptSemanticIr,
  ): Generator<void, JavaScriptModuleSemanticIr> {
    const projection = projectSemantics(file, ir);
    if (projection !== undefined) while (projection.next().done !== true) yield;
    return projectJavaScriptModuleSemantics(ir);
  };
  const context = { state, projectSemantics: projectFileSemantics };
  for (const [index, file] of fileSet.files.entries()) {
    // Let progress, cancellation and garbage collection run between files.
    await setImmediate();
    await beforeFile?.(file, index, fileSet.files.length);
    await completeJavaScriptAnalysisSteps(
      analyzeArtifactFileSteps(file, context),
      signal,
    );
  }
  return finalizeArtifactAnalysis(state);
};

/** Analyze sources behind a hard heap boundary, retaining collected facts on interruption. */
export const analyzeAndAdoptJavaScriptArtifactFiles = async (
  fileSet: JavaScriptArtifactFileSet,
  worker: Pick<JavaScriptSourceAnalysisPort, "analyze">,
  projection: JavaScriptSemanticGraphProjection,
  beforeFile: (
    file: JavaScriptArtifactFile,
    completed: number,
    total: number,
  ) => Promise<void>,
  signal?: AbortSignal,
): Promise<{
  readonly analysis: JavaScriptModuleArtifactAnalysis;
  readonly interruption: AnalysisError | null;
}> => {
  const state = emptyArtifactAnalysis<JavaScriptModuleSemanticIr>();
  let interruption: AnalysisError | null = null;
  const selectedFileCount =
    fileSet.files.length - (fileSet.source_selection?.unselected_files ?? 0);
  let selectedFileIndex = 0;
  for (const file of fileSet.files) {
    let analysisStarted = false;
    try {
      await setImmediate();
      if (classifyOutsideAnalysisScope(file, state, projection)) {
        if (signal?.aborted === true) {
          interruption = new AnalysisCancelledError(
            "analyze_javascript_application",
          );
          break;
        }
        continue;
      }
      if (signal?.aborted === true)
        throw new AnalysisCancelledError("analyze_javascript_application");
      await beforeFile(file, selectedFileIndex++, selectedFileCount);
      analysisStarted = true;
      if (file.kind !== "javascript" || !file.text.included) {
        const steps = analyzeArtifactFileSteps(file, {
          state,
          projectSemantics: function* (_file, ir) {
            yield;
            return projectJavaScriptModuleSemantics(ir);
          },
        });
        await completeJavaScriptAnalysisSteps(steps, signal);
        continue;
      }
      const result = await worker.analyze(
        file,
        projection.remainingFileCapacity(),
        signal,
      );
      const facts = result.ok ? result.value : result.error;
      const applicationProjectionFailure = facts.applicationProjectionFailure;
      if (facts.projection !== null)
        projection.adoptFileProjection(facts.projection);
      const error = result.ok ? null : result.error.error;
      const limits =
        error instanceof AnalysisResourceConstraintError
          ? error.reportedLimits
          : error instanceof AnalysisTimeoutError
            ? { worker_timeout_ms: error.timeoutMs }
            : null;
      const failure: JavaScriptArtifactAnalysisFailure | undefined =
        error === null
          ? undefined
          : {
              scope: javascriptArtifactAnalysisScopes.javascript,
              status: "interrupted",
              reason: `${file.path}: ${error.message}`,
              error: projectAnalysisError(error),
              limits,
            };
      state.files.push({
        file,
        javascript: facts.javascript,
        semantic: facts.module === null ? null : { ir: facts.module },
        ...(failure === undefined ? {} : { analysis_failure: failure }),
        ...(applicationProjectionFailure === undefined
          ? {}
          : {
              application_projection_failure: {
                reason: applicationProjectionFailure.message,
                error: projectAnalysisError(applicationProjectionFailure),
                limits: applicationProjectionFailure.reportedLimits,
              },
            }),
      });
      if (failure !== undefined && facts.projection === null)
        projection.recordUnavailableFile(
          file,
          failure.reason,
          failure.limits,
          error instanceof AnalysisResourceConstraintError ||
            error instanceof AnalysisTimeoutError
            ? "resource-limit"
            : "incomplete-module",
        );
      if (facts.javascript !== null) {
        state.visitedNodes += facts.javascript.visited_ast_nodes;
        state.findings +=
          findingCount(facts.javascript) +
          (facts.module?.moduleLinks.length ?? 0);
        state.modules += facts.javascript.bundler_registrations.reduce(
          (count, item) => count + item.modules.length,
          0,
        );
        if (facts.javascript.parse_status === "failed")
          state.parseFailures += 1;
      }
      if (
        error !== null &&
        (!(error instanceof AnalysisResourceConstraintError) ||
          error.reportedLimits?.parent_result_budget_exhausted === true)
      ) {
        interruption = error;
        break;
      }
    } catch (cause: unknown) {
      if (signal?.aborted !== true && !(cause instanceof AnalysisError))
        throw cause;
      interruption =
        signal?.aborted === true
          ? new AnalysisCancelledError("analyze_javascript_application")
          : cause instanceof AnalysisError
            ? cause
            : null;
      if (interruption !== null) {
        const scope = javascriptArtifactAnalysisScopes[file.kind];
        state.files.push({
          file,
          javascript: null,
          semantic: null,
          ...(scope === null
            ? {}
            : {
                analysis_failure: {
                  scope,
                  status: analysisStarted ? "interrupted" : "not-started",
                  reason: `${file.path}: ${interruption.message}`,
                  error: projectAnalysisError(interruption),
                  limits: null,
                },
              }),
        });
        projection.recordUnavailableFile(
          file,
          interruption.message,
          null,
          "incomplete-module",
        );
      }
      break;
    }
  }
  if (interruption !== null) {
    const analyzedPaths = new Set(state.files.map(({ file }) => file.path));
    const failure = {
      reason: `Source analysis was interrupted: ${interruption.message}`,
      error: projectAnalysisError(interruption),
      limits:
        interruption instanceof AnalysisResourceConstraintError
          ? interruption.reportedLimits
          : interruption instanceof AnalysisTimeoutError
            ? { worker_timeout_ms: interruption.timeoutMs }
            : null,
    };
    // This interruption has one cause. Share its immutable failure per phase
    // rather than copying it for every unvisited source in a large bundle.
    const failures = new Map<
      JavaScriptArtifactAnalysisScope,
      JavaScriptArtifactAnalysisFailure
    >();
    for (const file of fileSet.files) {
      if (analyzedPaths.has(file.path)) continue;
      if (classifyOutsideAnalysisScope(file, state, projection)) continue;
      const scope = javascriptArtifactAnalysisScopes[file.kind];
      let unavailable = scope === null ? undefined : failures.get(scope);
      if (scope !== null && unavailable === undefined) {
        unavailable = { ...failure, scope, status: "not-started" };
        failures.set(scope, unavailable);
      }
      state.files.push({
        file,
        javascript: null,
        semantic: null,
        ...(unavailable === undefined ? {} : { analysis_failure: unavailable }),
      });
      projection.recordUnavailableFile(
        file,
        failure.reason,
        failure.limits,
        interruption instanceof AnalysisResourceConstraintError ||
          interruption instanceof AnalysisTimeoutError
          ? "resource-limit"
          : "incomplete-module",
      );
    }
  }
  return { analysis: finalizeArtifactAnalysis(state), interruption };
};

const analyzeArtifactFiles = <SemanticIr extends JavaScriptModuleSemanticIr>(
  fileSet: JavaScriptArtifactFileSet,
  projectSemantics: ArtifactAnalysisContext<SemanticIr>["projectSemantics"],
): JavaScriptArtifactAnalysis<SemanticIr> => {
  const state = emptyArtifactAnalysis<SemanticIr>();
  const context = { state, projectSemantics };
  for (const file of fileSet.files) {
    const steps = analyzeArtifactFileSteps(file, context);
    while (steps.next().done !== true);
  }
  return finalizeArtifactAnalysis(state);
};

const finalizeArtifactAnalysis = <
  SemanticIr extends JavaScriptModuleSemanticIr,
>(
  state: MutableArtifactAnalysis<SemanticIr>,
): JavaScriptArtifactAnalysis<SemanticIr> => {
  return {
    files: state.files,
    packages: state.packages,
    json_modules: state.jsonModules,
    html_scripts: state.htmlScripts,
    html_inline_scripts: state.htmlInlineScripts,
    source_maps: state.sourceMaps,
    visited_ast_nodes: state.visitedNodes,
    findings:
      state.findings +
      state.htmlScripts.length +
      state.htmlInlineScripts.reduce(
        (count, { script_count }) => count + script_count,
        0,
      ),
    modules: state.modules,
    parse_failures: state.parseFailures,
    limitations: [
      "JavaScript and HTML were parsed as inert text; bundle bootstrap code was never executed.",
      "Static paths and relationships may remain unresolved when expressions are dynamic or obfuscated.",
      ...state.htmlInlineScripts.map(htmlInlineScriptLimitation),
      ...state.files.flatMap(
        ({ analysis_failure, application_projection_failure }) =>
          [analysis_failure, application_projection_failure].flatMap(
            (failure) => (failure === undefined ? [] : [failure.reason]),
          ),
      ),
    ],
  };
};

function* analyzeArtifactFileSteps<
  SemanticIr extends JavaScriptModuleSemanticIr,
>(
  file: JavaScriptArtifactFile,
  context: ArtifactAnalysisContext<SemanticIr>,
): Generator<void, void> {
  const { state } = context;
  if (classifyOutsideAnalysisScope(file, state)) return;
  addStructuredObservations(file, state);
  if (file.kind === "html" && file.text.included) {
    const html = parseHtmlScripts(file.path, file.text.value);
    // Append without spreading: argument count is bounded by the engine.
    for (const script of html.scripts) state.htmlScripts.push(script);
    if (html.inlineScripts !== null)
      state.htmlInlineScripts.push(html.inlineScripts);
  }
  if (file.kind === "source-map") addSourceMap(file, context);
  if (file.kind !== "javascript" || !file.text.included) {
    state.files.push({ file, javascript: null, semantic: null });
    return;
  }
  const parsed = parseJavaScriptSource(file.text.value, file.path);
  yield;
  if (parsed === null) {
    const analysis = failedJavaScriptStaticAnalysis();
    state.files.push({ file, javascript: analysis, semantic: null });
    state.parseFailures += 1;
    return;
  }
  const analysis = yield* analyzeParsedJavaScriptStaticSourceSteps(
    file.text.value,
    parsed,
  );
  const staticFindings = findingCount(analysis);
  yield;
  const semantics =
    analysis.parse_status === "complete" || analysis.parse_status === "partial"
      ? yield* analyzeParsedJavaScriptSemanticsSteps(
          parsed,
          moduleResolutionModeForJavaScriptReference(
            file.path,
            "static-import",
          ),
        )
      : null;
  const projected =
    semantics === null
      ? null
      : yield* context.projectSemantics(file, semantics);
  state.files.push({
    file,
    javascript: analysis,
    semantic: projected === null ? null : { ir: projected },
  });
  state.visitedNodes += analysis.visited_ast_nodes;
  state.findings += staticFindings + (semantics?.moduleLinks.length ?? 0);
  state.modules += analysis.bundler_registrations.reduce(
    (count, registration) => count + registration.modules.length,
    0,
  );
  if (analysis.parse_status === "failed") state.parseFailures += 1;
}

const classifyOutsideAnalysisScope = <
  SemanticIr extends JavaScriptModuleSemanticIr,
>(
  file: JavaScriptArtifactFile,
  state: MutableArtifactAnalysis<SemanticIr>,
  projection?: JavaScriptSemanticGraphProjection,
): boolean => {
  if (file.text.included || file.text.reason !== "outside-analysis-scope")
    return false;
  state.files.push({ file, javascript: null, semantic: null });
  projection?.recordUnavailableFile(
    file,
    "Source was not analyzed because it is outside the caller-selected source_paths.",
    null,
    "incomplete-module",
  );
  return true;
};

const addSourceMap = (
  file: JavaScriptArtifactFile,
  context: ArtifactAnalysisContext<JavaScriptModuleSemanticIr>,
): void => {
  const sourceMap = parseSourceMap(file);
  context.state.sourceMaps.push(sourceMap);
};

const emptyArtifactAnalysis = <
  SemanticIr extends JavaScriptModuleSemanticIr,
>(): MutableArtifactAnalysis<SemanticIr> => ({
  files: [],
  packages: [],
  jsonModules: [],
  htmlScripts: [],
  htmlInlineScripts: [],
  sourceMaps: [],
  visitedNodes: 0,
  findings: 0,
  modules: 0,
  parseFailures: 0,
});

const addStructuredObservations = (
  file: JavaScriptArtifactFile,
  state: MutableArtifactAnalysis<JavaScriptModuleSemanticIr>,
): void => {
  if (file.kind === "package-json") state.packages.push(parsePackage(file));
  if (file.kind !== "json") return;
  const json = analyzeJavaScriptJsonModule(file);
  state.jsonModules.push(json);
  if (json.status === "invalid") state.parseFailures += 1;
};

const parsePackage = (
  file: JavaScriptArtifactFile,
): JavaScriptPackageObservation => {
  if (!file.text.included)
    return unavailablePackage(file, "Package metadata text was unavailable.");
  let value: unknown;
  try {
    value = JSON.parse(file.text.value);
  } catch (cause: unknown) {
    void cause;
    return invalidPackage(file, "package.json is not valid JSON.");
  }
  if (!isRecord(value))
    return invalidPackage(file, "package.json root is not an object.");
  return {
    path: file.path,
    sha256: file.sha256,
    status: "included",
    name: optionalString(value.name),
    version: optionalString(value.version),
    main: optionalString(value.main),
    main_status:
      value.main === undefined || value.main === ""
        ? "default"
        : typeof value.main === "string"
          ? "declared"
          : "invalid",
    main_entrypoint: typeof value.main === "string" ? value.main : "",
    renderer:
      optionalString(value.renderer) ??
      optionalString(value.browser) ??
      optionalString(value.module),
    limitation: null,
  };
};

const invalidPackage = (
  file: JavaScriptArtifactFile,
  limitation: string,
): JavaScriptPackageObservation => ({
  ...unavailablePackage(file, limitation),
  status: "invalid",
});

const unavailablePackage = (
  file: JavaScriptArtifactFile,
  limitation: string,
): JavaScriptPackageObservation & { readonly status: "unavailable" } => ({
  path: file.path,
  sha256: file.sha256,
  status: "unavailable",
  name: null,
  version: null,
  main: null,
  main_status: "unavailable",
  main_entrypoint: null,
  renderer: null,
  limitation,
});

const parseHtmlScripts = (
  path: string,
  text: string,
): {
  readonly scripts: JavaScriptHtmlScriptObservation[];
  readonly inlineScripts: JavaScriptHtmlInlineScriptsObservation | null;
} => {
  const { scripts, inlineScripts, inlineScriptCount, baseHref } =
    htmlArtifactReferences(text);
  return {
    scripts: scripts.map(({ scriptPath, location }) => ({
      html_path: path,
      script_path: scriptPath,
      base_href: baseHref,
      location,
    })),
    inlineScripts:
      inlineScriptCount === 0
        ? null
        : {
            path,
            script_count: inlineScriptCount,
            scripts: inlineScripts.map(({ scriptType, location }) => ({
              script_type: scriptType,
              location,
            })),
          },
  };
};

const parseSourceMap = (
  file: JavaScriptArtifactFile,
): JavaScriptSourceMapObservation => {
  if (!file.text.included) return unavailableSourceMap(file);
  let value: unknown;
  try {
    value = JSON.parse(sourceMapJsonText(file.text.value));
  } catch (cause: unknown) {
    void cause;
    return invalidSourceMap(file, "Source map is not valid JSON.");
  }
  const envelope = inspectSourceMapEnvelope(value);
  if (envelope.status === "invalid")
    return invalidSourceMap(file, envelope.reason);
  const observation = collectSourceMapOriginals(file, envelope.leaves);
  if (envelope.status === "included") return observation;
  const envelopeLimitations = [
    ...envelope.invalid_sections.map(
      ({ section_path, reason }) =>
        `Indexed source-map section at [${section_path.join(",")}]: ${reason}`,
    ),
    ...envelope.external_sections.map(
      ({ url }) => `External source-map section URL is not fetched: ${url}`,
    ),
  ];
  const limitation = [
    ...(observation.status === "invalid" ? [observation.limitation] : []),
    ...envelopeLimitations,
  ].join("; ");
  return {
    ...observation,
    status: "invalid",
    limitation,
    ...(envelope.external_sections.length === 0
      ? {}
      : { external_sections: envelope.external_sections }),
    ...(envelope.invalid_sections.length === 0
      ? {}
      : { invalid_sections: envelope.invalid_sections }),
  };
};

const collectSourceMapOriginals = (
  file: JavaScriptArtifactFile,
  leaves: readonly SourceMapLeaf[],
): JavaScriptSourceMapObservation => {
  const sources: JavaScriptSourceMapOriginal[] = [];
  const limitations: string[] = [];
  let declarationIndex = 0;
  for (const { map, section_path } of leaves) {
    const location =
      section_path.length === 0
        ? ""
        : ` in section [${section_path.join(",")}]`;
    const names = map.sources;
    if (!Array.isArray(names)) {
      limitations.push(`Source map has no sources array${location}.`);
      continue;
    }
    const contents = map.sourcesContent;
    if (!hasValidSourceMapContents(contents))
      limitations.push(
        `Source map sourcesContent must be an array of strings or null entries${location}.`,
      );
    if (map.sourceRoot != null && typeof map.sourceRoot !== "string") {
      limitations.push(
        `Source map sourceRoot must be a string or null${location}.`,
      );
      continue;
    }
    const root = typeof map.sourceRoot === "string" ? map.sourceRoot : null;
    const sourceDeclarations: {
      readonly index: number;
      readonly name: string | null;
    }[] = [];
    for (const [index, raw] of names.entries()) {
      if (raw !== null && typeof raw !== "string") {
        limitations.push(
          `Source map contains a non-string source name at index ${String(index)}${location}.`,
        );
        continue;
      }
      sourceDeclarations.push({ index, name: raw });
    }
    const references = resolveJavaScriptSourceMapReferences(
      sourceDeclarations.map(({ name }) => name),
      root,
      file.path,
    );
    for (const [index, reference] of references.entries()) {
      const declaration = sourceDeclarations[index];
      if (declaration === undefined) continue;
      const rawContent = Array.isArray(contents)
        ? contents[declaration.index]
        : undefined;
      const content = typeof rawContent === "string" ? rawContent : null;
      sources.push({
        source_index: declaration.index,
        declaration_index: declarationIndex++,
        reference,
        content,
        content_sha256: content === null ? null : sha256(content),
        section_path,
      });
    }
    if (!sourceMapMappingsSchema.safeParse(map.mappings).success)
      limitations.push(`Source map has no mappings string${location}.`);
  }
  if (limitations.length > 0)
    return invalidSourceMap(
      file,
      [...new Set(limitations)].join("; "),
      sources,
    );
  return {
    path: file.path,
    sha256: file.sha256,
    status: "included",
    sources,
    limitation: null,
  };
};

/** Name the HTML file and lines whose inline JavaScript was not analyzed. */
export const htmlInlineScriptLimitation = ({
  path,
  script_count: count,
  scripts,
}: JavaScriptHtmlInlineScriptsObservation): string => {
  const lines = scripts
    .slice(0, HTML_INLINE_SCRIPT_LIMITATION_LINES)
    .map(({ location }) => String(location.start.line));
  const unnamed = count - lines.length;
  const one = count === 1;
  return `${path} has ${String(count)} inline JavaScript ${one ? "body" : "bodies"} starting at line${one ? "" : "s"} ${lines.join(", ")}${unnamed > 0 ? ` and ${String(unnamed)} more` : ""} that ${one ? "was" : "were"} not analyzed; endpoints, storage, imports and other facts in ${one ? "it" : "them"} are absent from the evidence.`;
};

// Keep the agent-facing limitation short; the unknown scope keeps the ranges.
const HTML_INLINE_SCRIPT_LIMITATION_LINES = 10;

const unavailableSourceMap = (
  file: JavaScriptArtifactFile,
): JavaScriptSourceMapObservation => {
  if (file.text.included)
    throw new TypeError("Expected unavailable source-map text");
  return {
    path: file.path,
    sha256: file.sha256,
    status: "invalid",
    sources: [],
    limitation: "Source-map text could not be decoded as UTF-8.",
  };
};

const invalidSourceMap = (
  file: JavaScriptArtifactFile,
  limitation: string,
  sources: readonly JavaScriptSourceMapOriginal[] = [],
): JavaScriptSourceMapObservation => ({
  path: file.path,
  sha256: file.sha256,
  status: "invalid",
  sources,
  limitation,
});

const findingCount = (analysis: JavaScriptStaticAnalysis): number =>
  analysis.references.length +
  analysis.endpoints.length +
  analysis.storage.length +
  analysis.role_paths.length +
  analysis.source_map_urls.length +
  analysis.bundler_registrations.length +
  analysis.electron.browser_windows.length +
  analysis.electron.context_bridge_apis.length +
  analysis.electron.ipc.length +
  analysis.electron.sender_validations.length +
  analysis.electron.utility_processes.length +
  analysis.electron.native_addon_bindings.length;

const optionalString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
