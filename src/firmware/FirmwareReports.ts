import { z } from "zod";
import { AnalysisOutputError } from "../domain/analysisErrorCore.js";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import { digestSchema } from "../domain/digests.js";
import { uniqueSorted } from "../domain/canonicalOrdering.js";
import { firmwareLogicalPath } from "./FirmwareFiles.js";

const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const signature = z.object({
  id: z.string().min(1),
  offset: integer,
  size: integer,
  name: z.string(),
  description: z.string(),
  confidence: z.number().int().min(0).max(255),
  always_display: z.boolean(),
  extraction_declined: z.boolean(),
});
const scan = z.array(
  z.object({
    Analysis: z.object({
      file_path: z.string(),
      file_map: z.array(signature),
      extractions: z.record(z.string(), jsonValueSchema),
    }),
  }),
);
const report = z.object({ __typename__: z.string() }).catchall(jsonValueSchema);
const task = z.object({
  path: z.string(),
  depth: integer,
  blob_id: z.string(),
  is_multi_file: z.boolean(),
});
const extraction = z.array(
  z.object({ task, reports: z.array(report), subtasks: z.array(task) }),
);
const stat = z.object({
  __typename__: z.literal("StatReport"),
  path: z.string(),
  size: integer,
  is_dir: z.boolean(),
  is_file: z.boolean(),
  is_link: z.boolean(),
  link_target: z.string().nullable(),
});
const multiFile = z.object({
  id: z.string(),
  handler_name: z.string(),
  name: z.string(),
  paths: z.array(z.string()),
  extraction_reports: z.array(jsonValueSchema),
});
const hashes = z.object({ sha256: digestSchema });
/**
 * The provider's structured missing-dependency report. Non-strict on purpose:
 * unfamiliar extra fields stay in retained diagnostics, only the dependency
 * names are derived here.
 */
const missingDependency = z.object({
  __typename__: z.literal("ExtractorDependencyNotFoundReport"),
  dependencies: z.array(z.string()),
});
const region = z.object({
  id: z.string(),
  start_offset: integer,
  end_offset: integer,
  size: integer,
});
type BlobOrigin = {
  readonly handler: string | null;
  readonly range: { readonly offset: number; readonly length: number } | null;
};
const known = new Set([
  "StatReport",
  "HashReport",
  "FileMagicReport",
  "RandomnessReport",
  "ChunkReport",
  "UnknownChunkReport",
  "CarveDirectoryReport",
  "MultiFileReport",
]);

const dependencyFailure = z.object({
  __typename__: z.literal("ExtractorDependencyNotFoundReport"),
  dependencies: z.array(z.string().min(1)).min(1),
});

/** Collect the named extractors from any dependency report nested in one value. */
const missingDependencies = (value: unknown): string[] => {
  // Producer-controlled name volume must not make deduplication quadratic;
  // a Set keeps collection linear and uniqueSorted restores canonical order.
  const found = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const failure = dependencyFailure.safeParse(node);
    if (failure.success) {
      for (const dependency of failure.data.dependencies) found.add(dependency);
      return;
    }
    for (const child of Object.values(node)) visit(child);
  };
  visit(value);
  return [...found];
};

/**
 * Name the missing extractors and the producing stage for one extraction
 * problem so a caller can act without decoding the raw report. The original
 * report stays retained alongside the normalized fields.
 */
const extractionDiagnostic = (
  inputPath: string,
  stage: string | null,
  report: JsonValue,
): JsonValue => {
  const dependencies = missingDependencies(report);
  return {
    input_path: inputPath,
    ...(stage === null ? {} : { stage }),
    ...(dependencies.length === 0
      ? {}
      : { missing_dependencies: dependencies }),
    report,
  };
};

/** Interpret the pinned Binwalk report without inventing validated region lengths. */
export const normalizeBinwalkReport = (
  raw: unknown,
  inputPath: string,
  size: number,
) => {
  const records = scan.parse(raw);
  const analysis = records[0]?.Analysis;
  if (
    records.length !== 1 ||
    analysis?.file_path !== inputPath ||
    Object.keys(analysis.extractions).length !== 0
  )
    throw new AnalysisOutputError(
      "inspect_firmware_regions",
      "Expected one inspection-only report for the selected immutable input",
    );
  return analysis.file_map.map((hit) => {
    if (hit.offset >= size || hit.size > size - hit.offset)
      throw new AnalysisOutputError(
        "inspect_firmware_regions",
        "Reported region lies outside the selected file",
      );
    return {
      provider_id: hit.id,
      offset: hit.offset,
      reported_size: hit.size,
      signature: hit.name,
      description: hit.description,
      reported_confidence: hit.confidence,
      size_basis: "provider_reported_validation_unknown" as const,
    };
  });
};

/** Normalize Unblob's unordered task graph, retaining unknown and failed analyses. */
export const normalizeUnblobReport = (
  raw: unknown,
  context: {
    inputPath: string;
    outputRoot: string;
    sha256: string;
    length: number;
    offset: number;
    maxDepth: number;
  },
) => {
  const records = extraction.parse(raw);
  const logical = (path: string) =>
    firmwareLogicalPath(path, context.inputPath, context.outputRoot);
  const roots = records.filter(
    ({ task: item }) => item.path === context.inputPath && item.depth === 0,
  );
  if (roots.length !== 1)
    throw new AnalysisOutputError(
      "extract_firmware",
      "Expected exactly one selected input task",
    );
  const rootHash = roots[0]?.reports.find(
    (r) => r.__typename__ === "HashReport",
  );
  if (
    rootHash === undefined ||
    hashes.parse(rootHash).sha256 !== context.sha256
  )
    throw new AnalysisOutputError(
      "extract_firmware",
      "Unblob input hash disagrees with selected snapshot",
    );
  const files = new Map<
    string,
    { sha256: string | null; mimeType: string | null; depth: number }
  >();
  const sizes = new Map<string, number>();
  const depths: string[] = [];
  const failedExtractionStages: {
    input_path: string;
    provider_id: string | null;
    handler: string | null;
    dependencies: readonly string[];
    kind: "missing-extractor-dependency" | "extractor-failure";
  }[] = [];
  const diagnostics: JsonValue[] = [];
  const blobOrigins = new Map<string, BlobOrigin>();
  const addBlobOrigin = (
    parentPath: string,
    id: string,
    origin: BlobOrigin,
  ) => {
    const key = JSON.stringify([parentPath, id]);
    if (blobOrigins.has(key))
      throw new AnalysisOutputError(
        "extract_firmware",
        `Duplicate blob identity in parent task: ${parentPath} (${id})`,
      );
    blobOrigins.set(key, origin);
  };
  const chunks: {
    input_path: string;
    provider_id: string;
    range: { offset: number; length: number };
    handler: string | null;
    encrypted: boolean | null;
    root_file_range: { offset: number; length: number } | null;
    extraction_failed: boolean;
  }[] = [];
  const seen = new Set<string>();
  const taskFailures = new Set<string>();
  type DependencyFacts = { readonly names: Set<string>; unnamed: boolean };
  const missingDependencies = new Map<string, DependencyFacts>();
  /** Dependencies reported by one chunk's extraction, keyed with its chunk id. */
  const chunkMissingDependencies = new Map<string, DependencyFacts>();
  const dependencyNames = (
    reports: readonly unknown[],
  ): DependencyFacts | null => {
    const names = new Set<string>();
    let unnamed = false;
    let reported = false;
    for (const item of reports) {
      const parsed = missingDependency.safeParse(item);
      if (!parsed.success) continue;
      reported = true;
      if (
        parsed.data.dependencies.length === 0 ||
        parsed.data.dependencies.includes("")
      )
        unnamed = true;
      for (const name of parsed.data.dependencies)
        if (name !== "") names.add(name);
    }
    return reported ? { names, unnamed } : null;
  };
  const dependencyRows = (
    facts: DependencyFacts,
  ): readonly { dependencies: readonly string[] }[] => [
    ...(facts.names.size > 0
      ? [{ dependencies: uniqueSorted([...facts.names]) }]
      : []),
    ...(facts.unnamed ? [{ dependencies: [] }] : []),
  ];
  const noteMissingDependencies = (
    path: string,
    reports: readonly unknown[],
  ): void => {
    const names = dependencyNames(reports);
    // null means no accepted failure; [] means a definite dependency failure
    // whose executable identity the producer left unavailable.
    if (names === null) return;
    const known = missingDependencies.get(path) ?? {
      names: new Set<string>(),
      unnamed: false,
    };
    for (const name of names.names) known.names.add(name);
    known.unnamed ||= names.unnamed;
    missingDependencies.set(path, known);
  };
  const noteChunkMissingDependencies = (
    path: string,
    chunkId: string,
    reports: readonly unknown[],
  ): void => {
    const names = dependencyNames(reports);
    if (names === null) return;
    const key = JSON.stringify([path, chunkId]);
    const known = chunkMissingDependencies.get(key) ?? {
      names: new Set<string>(),
      unnamed: false,
    };
    for (const name of names.names) known.names.add(name);
    known.unnamed ||= names.unnamed;
    chunkMissingDependencies.set(key, known);
  };
  for (const record of records) {
    const path = logical(record.task.path);
    if (seen.has(path))
      throw new AnalysisOutputError(
        "extract_firmware",
        `Duplicate analysis task: ${path}`,
      );
    seen.add(path);
    if (record.task.depth >= context.maxDepth) depths.push(path);
    const metadata = record.reports.find(
      (r) => r.__typename__ === "StatReport",
    );
    if (metadata === undefined)
      throw new AnalysisOutputError(
        "extract_firmware",
        `Missing StatReport: ${path}`,
      );
    const parsedStat = stat.parse(metadata);
    if (parsedStat.path !== record.task.path)
      throw new AnalysisOutputError(
        "extract_firmware",
        `StatReport is bound to another task: ${path}`,
      );
    if (path === "$input" && parsedStat.size !== context.length)
      throw new AnalysisOutputError(
        "extract_firmware",
        "Unblob input size disagrees with selected snapshot",
      );
    if (
      path === "$input" &&
      (!parsedStat.is_file || parsedStat.is_link || parsedStat.is_dir)
    )
      throw new AnalysisOutputError(
        "extract_firmware",
        "Selected input was not reported as a regular file",
      );
    sizes.set(path, parsedStat.size);
    const hash = record.reports.find((r) => r.__typename__ === "HashReport");
    const magic = record.reports.find(
      (r) => r.__typename__ === "FileMagicReport",
    );
    if (parsedStat.is_file && !parsedStat.is_link)
      files.set(path, {
        sha256: hash === undefined ? null : hashes.parse(hash).sha256,
        mimeType:
          magic === undefined
            ? null
            : z.object({ mime_type: z.string() }).parse(magic).mime_type,
        depth: record.task.depth,
      });
    for (const item of record.reports) {
      if (!known.has(item.__typename__))
        diagnostics.push(
          jsonValueSchema.parse({ input_path: path, report: item }),
        );
      noteMissingDependencies(path, [item]);
      if (
        item.__typename__ === "ExtractorExecutionErrorReport" &&
        !taskFailures.has(path)
      ) {
        taskFailures.add(path);
        failedExtractionStages.push({
          input_path: path,
          provider_id: null,
          handler: null,
          dependencies: [],
          kind: "extractor-failure",
        });
      }
      if (
        item.__typename__ === "ChunkReport" ||
        item.__typename__ === "UnknownChunkReport"
      ) {
        const parsed = region.parse(item);
        if (
          parsed.end_offset <= parsed.start_offset ||
          parsed.end_offset > parsedStat.size ||
          parsed.size !== parsed.end_offset - parsed.start_offset
        )
          throw new AnalysisOutputError(
            "extract_firmware",
            `Invalid chunk bounds for ${path}`,
          );
        const detail =
          item.__typename__ === "ChunkReport"
            ? z
                .object({
                  handler_name: z.string(),
                  is_encrypted: z.boolean(),
                  extraction_reports: z.array(jsonValueSchema),
                })
                .parse(item)
            : null;
        const extractionFailed =
          detail !== null && detail.extraction_reports.length > 0;
        if (detail !== null)
          for (const problem of detail.extraction_reports) {
            diagnostics.push(
              extractionDiagnostic(
                path,
                detail.handler_name,
                jsonValueSchema.parse(problem),
              ),
            );
            // Nested under one chunk: keep the owning chunk, not the whole task.
            noteChunkMissingDependencies(path, parsed.id, [problem]);
          }
        addBlobOrigin(path, parsed.id, {
          handler: detail?.handler_name ?? null,
          range: { offset: parsed.start_offset, length: parsed.size },
        });
        chunks.push({
          input_path: path,
          provider_id: parsed.id,
          range: { offset: parsed.start_offset, length: parsed.size },
          handler: detail?.handler_name ?? null,
          encrypted: detail?.is_encrypted ?? null,
          extraction_failed: extractionFailed,
          root_file_range:
            path === "$input"
              ? {
                  offset: context.offset + parsed.start_offset,
                  length: parsed.size,
                }
              : null,
        });
      }
      if (item.__typename__ === "MultiFileReport") {
        const parsed = multiFile.parse(item);
        addBlobOrigin(path, parsed.id, {
          handler: parsed.handler_name,
          range: null,
        });
        if (parsed.extraction_reports.length > 0) {
          diagnostics.push(
            extractionDiagnostic(
              path,
              parsed.handler_name,
              jsonValueSchema.parse(item),
            ),
          );
          // The report owns its failure and dependencies. A produced subtask
          // is a derivation, not a new owner for the parent's report.
          const dependencies = dependencyNames(parsed.extraction_reports);
          const rows =
            dependencies === null
              ? [{ dependencies: [] as readonly string[] }]
              : dependencyRows(dependencies);
          for (const row of rows)
            failedExtractionStages.push({
              input_path: path,
              provider_id: parsed.id,
              handler: parsed.handler_name,
              dependencies:
                dependencies === null
                  ? []
                  : uniqueSorted([...row.dependencies]),
              kind:
                dependencies === null
                  ? "extractor-failure"
                  : "missing-extractor-dependency",
            });
        }
      }
    }
  }
  const recordsByPath = new Map(
    records.map((record) => [record.task.path, record.task]),
  );
  const derivations = records.flatMap((record) =>
    record.subtasks.map((child) => {
      const parentPath = logical(record.task.path);
      const childPath = logical(child.path);
      if (!seen.has(childPath))
        throw new AnalysisOutputError(
          "extract_firmware",
          `Missing child task: ${childPath}`,
        );
      const reportedChild = recordsByPath.get(child.path);
      if (
        reportedChild?.depth !== child.depth ||
        reportedChild.blob_id !== child.blob_id ||
        reportedChild.is_multi_file !== child.is_multi_file
      )
        throw new AnalysisOutputError(
          "extract_firmware",
          `Child task identity disagrees with its analysis: ${childPath}`,
        );
      const origin = blobOrigins.get(
        JSON.stringify([parentPath, child.blob_id]),
      );
      return {
        parent_path: parentPath,
        child_path: childPath,
        provider_blob_id: child.blob_id,
        handler: origin?.handler ?? null,
        parent_file_range: origin?.range ?? null,
      };
    }),
  );
  const reachable = new Set(["$input"]);
  const pending = ["$input"];
  const childrenByParent = new Map<string, string[]>();
  for (const edge of derivations) {
    const children = childrenByParent.get(edge.parent_path) ?? [];
    children.push(edge.child_path);
    childrenByParent.set(edge.parent_path, children);
  }
  while (pending.length > 0) {
    const parent = pending.pop();
    for (const child of childrenByParent.get(parent ?? "") ?? []) {
      if (reachable.has(child)) continue;
      reachable.add(child);
      pending.push(child);
    }
  }
  if (reachable.size !== seen.size)
    throw new AnalysisOutputError(
      "extract_firmware",
      "Report contains tasks disconnected from the selected input",
    );
  return {
    files,
    sizes,
    chunks,
    derivations,
    depth_limited_paths: depths.sort(),
    failed_extraction_stages: failedExtractionStages.sort((left, right) =>
      `${left.input_path}\u0000${left.provider_id ?? ""}` <
      `${right.input_path}\u0000${right.provider_id ?? ""}`
        ? -1
        : `${left.input_path}\u0000${left.provider_id ?? ""}` >
            `${right.input_path}\u0000${right.provider_id ?? ""}`
          ? 1
          : 0,
    ),
    diagnostics,
    missing_dependencies: [...missingDependencies.entries()]
      .flatMap(([input_path, facts]) =>
        dependencyRows(facts).map(({ dependencies }) => ({
          input_path,
          dependencies,
        })),
      )
      .sort((left, right) =>
        left.input_path < right.input_path
          ? -1
          : left.input_path > right.input_path
            ? 1
            : 0,
      ),
    chunk_missing_dependencies: [...chunkMissingDependencies.entries()]
      .flatMap(([key, facts]) => {
        const [input_path, provider_id] = JSON.parse(key) as [string, string];
        return dependencyRows(facts).map(({ dependencies }) => ({
          input_path,
          provider_id,
          dependencies,
        }));
      })
      .sort((left, right) =>
        `${left.input_path}\u0000${left.provider_id}` <
        `${right.input_path}\u0000${right.provider_id}`
          ? -1
          : `${left.input_path}\u0000${left.provider_id}` >
              `${right.input_path}\u0000${right.provider_id}`
            ? 1
            : 0,
      ),
    coverage:
      depths.length > 0 ||
      diagnostics.length > 0 ||
      chunks.some((c) => c.handler === null || c.encrypted === true)
        ? ("partial" as const)
        : ("complete" as const),
  };
};
