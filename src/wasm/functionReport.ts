import type { DecodedModule } from "./binary/moduleTypes.js";
import {
  analyzeModule,
  describeFunction,
  functionName,
  indirectTargets,
  signature,
  walkBody,
} from "./moduleAnalysis.js";
import {
  sourceLimitations,
  type FacetCoverage,
  type ReadOptions,
} from "./moduleReport.js";
import {
  MAX_WASM_LISTED,
  type WasmFunctionReport,
} from "../domain/wasm/webAssembly.js";

/** Report for `inspect_wasm_function`: one function's instructions and call sites. */
export const readFunctionReport = (
  options: ReadOptions & {
    readonly functionIndex: number;
    readonly start: number;
    readonly limit: number;
  },
):
  | WasmFunctionReport
  | {
      readonly missing: true;
      readonly functionCount: number;
      readonly kind: DecodedModule["kind"];
    } => {
  const analysis = analyzeModule(options.bytes);
  const { module } = analysis;
  if (
    module.kind !== "module" ||
    options.functionIndex >= analysis.functionCount
  )
    return {
      missing: true,
      functionCount: analysis.functionCount,
      kind: module.kind,
    };
  const described = describeFunction(analysis, options.functionIndex);
  const body = module.bodies.find(
    (candidate) => candidate.index === options.functionIndex,
  );
  const type =
    described.type === null ? undefined : module.types[described.type];
  const localNames = module.names.locals.get(options.functionIndex);
  const locals: WasmFunctionReport["function"]["locals"] = [];
  let localTotal = 0;
  const addLocal = (typeName: string) => {
    if (locals.length < MAX_WASM_LISTED)
      locals.push({
        index: localTotal,
        type: typeName,
        name: localNames?.get(localTotal) ?? null,
      });
    localTotal += 1;
  };
  for (const param of type?.params ?? []) addLocal(param);
  for (const group of body?.locals ?? [])
    for (let count = 0; count < group.count; count += 1) addLocal(group.type);

  const instructions: WasmFunctionReport["instructions"] = [];
  const calls: WasmFunctionReport["calls"] = [];
  const indirectCalls: WasmFunctionReport["indirect_calls"] = [];
  let callsSeen = 0;
  const pageEnd = options.start + options.limit;
  if (body !== undefined)
    walkBody(options.bytes, body, (instruction, index) => {
      if (index >= options.start && index < pageEnd)
        instructions.push({
          index,
          offset: instruction.offset,
          size: instruction.size,
          depth: instruction.depth,
          op: instruction.name,
          immediates: instruction.immediates,
        });
      const tail = instruction.name.startsWith("return_call");
      if (instruction.func !== null && instruction.name !== "ref.func") {
        callsSeen += 1;
        if (calls.length + indirectCalls.length < MAX_WASM_LISTED)
          calls.push({
            instruction: index,
            offset: instruction.offset,
            tail,
            target: {
              index: instruction.func,
              name: functionName(module, instruction.func).name,
            },
          });
      }
      if (instruction.indirect !== null) {
        callsSeen += 1;
        if (calls.length + indirectCalls.length < MAX_WASM_LISTED)
          indirectCalls.push({
            instruction: index,
            offset: instruction.offset,
            tail,
            type: instruction.indirect.type,
            table: instruction.indirect.table,
            signature: signature(module.types[instruction.indirect.type]),
            targets: indirectTargets(
              analysis,
              instruction.indirect.table,
              instruction.indirect.type,
            ),
          });
      }
    });
  const count = described.instructions ?? 0;
  const examined =
    body === undefined
      ? null
      : described.decode === "complete"
        ? "the whole function body"
        : "the function body up to its first undecoded instruction";
  const coverage: FacetCoverage[] =
    body === undefined
      ? [
          {
            facet: "inspect",
            state: "unsupported",
            examined: null,
            omitted: null,
            reason: "Imported functions have no body in this module.",
            continuation: null,
          },
        ]
      : described.decode === "complete"
        ? [
            {
              facet: "inspect",
              state: "complete",
              examined: examined ?? "",
              omitted: null,
              reason: null,
              continuation: null,
            },
          ]
        : [
            {
              facet: "inspect",
              state: "partial",
              examined: examined ?? "",
              omitted: `instructions from offset ${String(described.decode_error?.offset)} to the end of the body`,
              reason: described.decode_error?.message ?? "Decoding stopped.",
              continuation: null,
            },
          ];
  return {
    artifact: options.artifact,
    source: options.source,
    function: {
      ...described,
      locals,
      locals_omitted: Math.max(0, localTotal - locals.length),
    },
    instruction_count: count,
    page: {
      start: options.start,
      limit: options.limit,
      returned: instructions.length,
      next: pageEnd < count ? pageEnd : null,
    },
    instructions,
    calls,
    indirect_calls: indirectCalls,
    calls_omitted: Math.max(0, callsSeen - calls.length - indirectCalls.length),
    coverage,
    limitations: [
      ...sourceLimitations(options.source),
      ...(described.name_source === null
        ? [
            "This function has no name in the module; it is identified by index only.",
          ]
        : []),
    ],
  };
};
