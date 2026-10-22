import type { z } from "zod";

import type { DecodedModule } from "./binary/moduleTypes.js";
import {
  analyzeModule,
  describeFunction,
  exportNames,
  functionName,
  limitsView,
  signature,
  type ModuleAnalysis,
} from "./moduleAnalysis.js";
import type { facetCoverageSchema } from "../domain/formatRegistry.js";
import {
  MAX_WASM_LISTED,
  WASM_DATA_PREVIEW_BYTES,
  type WasmFunction,
  type WasmModuleReport,
} from "../domain/wasm/webAssembly.js";

/** Report for `inspect_wasm_module`, built from one decoded module. */

export type FacetCoverage = z.infer<typeof facetCoverageSchema>;
type Artifact = WasmModuleReport["artifact"];
type Source = WasmModuleReport["source"];
type Validation = WasmModuleReport["validation"];

export interface ReadOptions {
  readonly artifact: Artifact;
  readonly source: Source;
  readonly validation: Validation;
  /** Bytes of the decoded module: the original, or the module assembled from WAT. */
  readonly bytes: Uint8Array;
}

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(" ");

const printable = (bytes: Uint8Array): string =>
  [...bytes]
    .map((byte) =>
      byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : ".",
    )
    .join("");

const capped = <T>(items: readonly T[]): { list: T[]; omitted: number } => ({
  list: items.slice(0, MAX_WASM_LISTED),
  omitted: Math.max(0, items.length - MAX_WASM_LISTED),
});

const describeImport = (
  entry: DecodedModule["imports"][number],
  module: DecodedModule,
): string => {
  switch (entry.kind) {
    case "func":
      return `func ${signature(module.types[entry.type ?? -1]) ?? `(type ${String(entry.type)})`}`;
    case "table":
      return `table ${entry.table?.type ?? "?"} min=${String(entry.table?.limits.min)}${entry.table?.limits.max == null ? "" : ` max=${String(entry.table.limits.max)}`}`;
    case "memory":
      return `memory min=${String(entry.memory?.min)}${entry.memory?.max == null ? "" : ` max=${String(entry.memory.max)}`} pages${entry.memory?.shared ? " shared" : ""}`;
    case "global":
      return `global ${entry.global?.mutable ? "mut " : ""}${entry.global?.type ?? "?"}`;
    case "tag":
      return "tag";
  }
};

export const sourceLimitations = (source: Source): string[] =>
  source.format === "text"
    ? [
        "This WebAssembly text was assembled into a separate derived module by wabt.js; offsets refer to that derived module, not to lines of the original text.",
      ]
    : [];

const coverageOf = (
  analysis: ModuleAnalysis,
): { coverage: FacetCoverage[]; limitations: string[] } => {
  const { module } = analysis;
  const identify: FacetCoverage = {
    facet: "identify",
    state: module.kind === "unknown" ? "unsupported" : "complete",
    examined:
      module.kind === "unknown"
        ? null
        : "WebAssembly preamble (magic and version)",
    omitted: null,
    reason:
      module.kind === "unknown"
        ? "The bytes are not a WebAssembly module or component."
        : null,
    continuation: null,
  };
  if (module.kind !== "module")
    return {
      coverage: [
        identify,
        {
          facet: "inspect",
          state: "unsupported",
          examined: null,
          omitted: null,
          reason:
            module.kind === "component"
              ? "Component-model binaries are identified but not decoded; only core modules are inspected."
              : "Nothing past the preamble was decoded.",
          continuation: null,
        },
      ],
      limitations: [],
    };
  const stoppedBodies = [...analysis.bodies.values()].filter(
    (facts) => facts.decode === "stopped",
  ).length;
  const unreadableTail = module.incompleteSections.has(-1);
  const undecoded = module.sections.filter((section) => !section.decoded);
  const complete =
    !unreadableTail && undecoded.length === 0 && stoppedBodies === 0;
  const omittedParts = [
    ...(unreadableTail ? ["bytes after an unreadable section header"] : []),
    ...undecoded.map((section) =>
      section.customName === null
        ? `${section.name} section`
        : `custom section "${section.customName}"`,
    ),
    ...(stoppedBodies > 0
      ? [
          `${String(stoppedBodies)} function bodies after their first undecoded instruction`,
        ]
      : []),
  ];
  return {
    coverage: [
      identify,
      complete
        ? {
            facet: "inspect",
            state: "complete",
            examined: "every section and every function body",
            omitted: null,
            reason: null,
            continuation: null,
          }
        : {
            facet: "inspect",
            state: "partial",
            examined:
              "every section boundary and each section or body up to its first undecoded byte",
            omitted: [...new Set(omittedParts)].join("; "),
            reason:
              module.proposals.size > 0
                ? `The module uses proposals this reader does not decode: ${[...module.proposals].sort().join(", ")}.`
                : "Some bytes are malformed; see diagnostics for exact offsets.",
            continuation: null,
          },
    ],
    limitations: [
      ...(module.names.functions.size === 0 && analysis.functionCount > 0
        ? [
            "The module has no function names in a name section; functions are identified by index, and export or import names are labelled as borrowed.",
          ]
        : []),
      'Custom sections other than "name" and "producers" are listed with their ranges but not decoded; DWARF debug sections are not read.',
    ],
  };
};

/** Report for `inspect_wasm_module`: structure plus one page of functions. */
export const readModuleReport = (
  options: ReadOptions & {
    readonly start: number;
    readonly limit: number;
    /** A prior analysis of the same bytes, reused across pages. */
    readonly analysis?: ModuleAnalysis;
  },
): WasmModuleReport => {
  const analysis = options.analysis ?? analyzeModule(options.bytes);
  const { module } = analysis;
  const { coverage, limitations } = coverageOf(analysis);
  const functions: WasmFunction[] = [];
  const end = Math.min(analysis.functionCount, options.start + options.limit);
  for (let index = options.start; index < end; index += 1)
    functions.push(describeFunction(analysis, index));
  const types = capped(
    module.types.map((type, index) => ({
      index,
      ...type,
      params: [...type.params],
      results: [...type.results],
    })),
  );
  const imports = capped(
    module.imports.map((entry) => ({
      module: entry.module,
      name: entry.name,
      kind: entry.kind,
      index: entry.index,
      description: describeImport(entry, module),
      offset: entry.offset,
    })),
  );
  const exports = capped(module.exports.map((entry) => ({ ...entry })));
  const globals = capped(module.globals.map((global) => ({ ...global })));
  const elements = capped(
    module.elements.map((segment) => ({
      index: segment.index,
      offset: segment.offset,
      mode: segment.mode,
      table: segment.table,
      offset_expression: segment.start?.text ?? null,
      type: segment.type,
      items: segment.items.length,
      functions: segment.items
        .filter((item): item is number => typeof item === "number")
        .slice(0, MAX_WASM_LISTED),
      null_items: segment.items.filter((item) => item === null).length,
      unknown_items: segment.items.filter((item) => item === "unknown").length,
    })),
  );
  const data = capped(
    module.data.map((segment) => {
      const preview = options.bytes.subarray(
        segment.payloadOffset,
        segment.payloadOffset + Math.min(segment.size, WASM_DATA_PREVIEW_BYTES),
      );
      return {
        index: segment.index,
        offset: segment.offset,
        mode: segment.mode,
        memory: segment.memory,
        offset_expression: segment.start?.text ?? null,
        payload_offset: segment.payloadOffset,
        size: segment.size,
        preview_hex: hex(preview),
        preview_text: printable(preview),
      };
    }),
  );
  const start =
    module.start === null
      ? null
      : {
          function: module.start,
          name: functionName(module, module.start).name,
        };
  let instructions = 0;
  let edges = 0;
  let indirect = 0;
  for (const facts of analysis.bodies.values()) {
    instructions += facts.instructions;
    edges += facts.directCallees.length;
    indirect += facts.indirectSites;
  }
  return {
    artifact: options.artifact,
    source: options.source,
    encoding: { kind: module.kind, version: module.version },
    validation: options.validation,
    unsupported_proposals: [...module.proposals].sort(),
    module_name: module.names.module,
    producers: module.producers.map((producer) => ({
      field: producer.field,
      values: producer.values.map((value) => ({ ...value })),
    })),
    summary: {
      sections: module.sections.length,
      types: module.types.length,
      imports: module.imports.length,
      functions: analysis.functionCount,
      imported_functions: module.importedFunctions,
      tables: module.tables.length,
      memories: module.memories.length,
      globals: module.globals.length,
      exports: module.exports.length,
      elements: module.elements.length,
      data: module.data.length,
      named_functions: module.names.functions.size,
      instructions,
      direct_call_edges: edges,
      indirect_call_sites: indirect,
    },
    sections: module.sections.map((section) => ({
      id: section.id,
      name: section.name,
      custom_name: section.customName,
      offset: section.offset,
      payload_offset: section.payloadOffset,
      size: section.size,
      decoded: section.decoded,
    })),
    types: types.list,
    imports: imports.list,
    tables: module.tables.map((table) => ({
      index: table.index,
      imported: table.imported,
      exported_as: exportNames(module, "table", table.index),
      type: table.type,
      limits: limitsView(table.limits),
    })),
    memories: module.memories.map((memory) => ({
      index: memory.index,
      imported: memory.imported,
      exported_as: exportNames(module, "memory", memory.index),
      limits: limitsView(memory.limits),
    })),
    globals: globals.list,
    exports: exports.list,
    start,
    elements: elements.list,
    data: data.list,
    omitted: {
      types: types.omitted,
      imports: imports.omitted,
      exports: exports.omitted,
      globals: globals.omitted,
      elements: elements.omitted,
      data: data.omitted,
    },
    function_count: analysis.functionCount,
    page: {
      start: options.start,
      limit: options.limit,
      returned: functions.length,
      next: end < analysis.functionCount ? end : null,
    },
    functions,
    diagnostics: module.diagnostics.map((diagnostic) => ({ ...diagnostic })),
    coverage,
    limitations: [
      ...sourceLimitations(options.source),
      ...(module.kind === "module" ? limitations : []),
    ],
  };
};
