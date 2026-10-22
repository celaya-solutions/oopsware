import { ByteReader, WasmDecodeError } from "./binary/ByteReader.js";
import {
  decodeExpression,
  type DecodedInstruction,
} from "./binary/decodeInstructions.js";
import { decodeModule } from "./binary/decodeModule.js";
import type {
  DecodedModule,
  FuncType,
  FunctionBody,
  Limits,
} from "./binary/moduleTypes.js";
import type {
  WasmFunction,
  WasmFunctionReport,
} from "../domain/wasm/webAssembly.js";

/**
 * Facts derived by walking every function body of a decoded module once:
 * instruction counts, direct call edges, indirect-call sites and table
 * writes. Nothing is instantiated or executed.
 */

interface BodyFacts {
  readonly instructions: number;
  readonly decode: "complete" | "stopped";
  readonly error: {
    offset: number;
    message: string;
    proposal: string | null;
  } | null;
  readonly directCallees: number[];
  readonly indirectSites: number;
  /** Tables an instruction in this body can modify. */
  readonly mutatedTables: Set<number>;
}

const TABLE_WRITERS = new Set([
  "table.set",
  "table.grow",
  "table.fill",
  "table.init",
  "table.copy",
]);

export const signature = (type: FuncType | undefined): string | null =>
  type === undefined
    ? null
    : `(${type.params.join(", ")}) -> (${type.results.join(", ")})`;

export const limitsView = (limits: Limits) => ({
  min: Number(limits.min),
  max: limits.max === null ? null : Number(limits.max),
  shared: limits.shared,
  memory64: limits.memory64,
});

const tableOperand = (instruction: DecodedInstruction): number[] => {
  const numbers = instruction.immediates
    .split(" ")
    .filter((part) => /^\d+$/u.test(part))
    .map(Number);
  switch (instruction.name) {
    case "table.copy":
      // Destination first; an empty immediate means table 0 to table 0.
      return numbers.length === 0 ? [0] : [numbers[0] as number];
    case "table.init":
      return numbers.length === 2 ? [numbers[0] as number] : [0];
    default:
      return [numbers[0] ?? 0];
  }
};

/** Walk one body; a stop is recorded, not thrown. */
export const walkBody = (
  bytes: Uint8Array,
  body: FunctionBody,
  visit?: (instruction: DecodedInstruction, index: number) => void,
): BodyFacts => {
  const callees = new Set<number>();
  const mutatedTables = new Set<number>();
  let instructions = 0;
  let indirectSites = 0;
  try {
    const reader = new ByteReader(bytes, body.codeOffset, body.end);
    const end = decodeExpression(reader, {
      instruction: (instruction) => {
        visit?.(instruction, instructions);
        instructions += 1;
        if (instruction.func !== null && instruction.name !== "ref.func")
          callees.add(instruction.func);
        if (instruction.indirect !== null) indirectSites += 1;
        if (TABLE_WRITERS.has(instruction.name))
          for (const table of tableOperand(instruction))
            mutatedTables.add(table);
      },
    });
    if (end !== body.end)
      throw new WasmDecodeError(
        end,
        `Function body ends ${String(body.end - end)} bytes after its final \`end\`.`,
      );
    return {
      instructions,
      decode: "complete",
      error: null,
      directCallees: [...callees].sort((a, b) => a - b),
      indirectSites,
      mutatedTables,
    };
  } catch (cause) {
    if (!(cause instanceof WasmDecodeError)) throw cause;
    return {
      instructions,
      decode: "stopped",
      error: {
        offset: cause.offset,
        message: cause.message,
        proposal: cause.proposal,
      },
      directCallees: [...callees].sort((a, b) => a - b),
      indirectSites,
      mutatedTables,
    };
  }
};

/** Decoded module plus everything derived from walking its bodies once. */
export interface ModuleAnalysis {
  readonly module: DecodedModule;
  readonly bodies: Map<number, BodyFacts>;
  readonly callers: Map<number, Set<number>>;
  readonly mutatedTables: Set<number>;
  readonly functionCount: number;
}

export const analyzeModule = (bytes: Uint8Array): ModuleAnalysis => {
  const module = decodeModule(bytes);
  const bodies = new Map<number, BodyFacts>();
  const callers = new Map<number, Set<number>>();
  const mutatedTables = new Set<number>();
  for (const body of module.bodies) {
    const facts = walkBody(bytes, body);
    bodies.set(body.index, facts);
    if (facts.error?.proposal) module.proposals.add(facts.error.proposal);
    for (const table of facts.mutatedTables) mutatedTables.add(table);
    for (const callee of facts.directCallees) {
      const set = callers.get(callee) ?? new Set<number>();
      set.add(body.index);
      callers.set(callee, set);
    }
  }
  return {
    module,
    bodies,
    callers,
    mutatedTables,
    functionCount: module.importedFunctions + module.functionTypes.length,
  };
};

export const exportNames = (
  module: DecodedModule,
  kind: string,
  index: number,
) =>
  module.exports
    .filter((entry) => entry.kind === kind && entry.index === index)
    .map((entry) => entry.name);

/** Name of a function and where it came from; never invented. */
export const functionName = (
  module: DecodedModule,
  index: number,
): Pick<WasmFunction, "name" | "name_source"> => {
  const named = module.names.functions.get(index);
  if (named !== undefined) return { name: named, name_source: "name-section" };
  const exported = exportNames(module, "func", index)[0];
  if (exported !== undefined) return { name: exported, name_source: "export" };
  const imported = module.imports.find(
    (entry) => entry.kind === "func" && entry.index === index,
  );
  if (imported !== undefined)
    return {
      name: `${imported.module}.${imported.name}`,
      name_source: "import",
    };
  return { name: null, name_source: null };
};

export const describeFunction = (
  analysis: ModuleAnalysis,
  index: number,
): WasmFunction => {
  const { module } = analysis;
  const imported =
    index < module.importedFunctions
      ? module.imports.filter((entry) => entry.kind === "func")[index]
      : undefined;
  const body = module.bodies.find((candidate) => candidate.index === index);
  const type =
    imported?.type ??
    module.functionTypes[index - module.importedFunctions] ??
    null;
  const facts = analysis.bodies.get(index);
  return {
    index,
    ...functionName(module, index),
    imported:
      imported === undefined
        ? null
        : {
            module: imported.module,
            name: imported.name,
            offset: imported.offset,
          },
    type,
    signature: type === null ? null : signature(module.types[type]),
    exports: exportNames(module, "func", index),
    body:
      body === undefined
        ? null
        : {
            offset: body.offset,
            size: body.size,
            code_offset: body.codeOffset,
            locals: body.locals.reduce((sum, group) => sum + group.count, 0),
          },
    instructions: facts?.instructions ?? null,
    decode: facts?.decode ?? "not_applicable",
    decode_error: facts?.error ?? null,
    direct_callees: facts?.directCallees ?? [],
    indirect_call_sites: facts?.indirectSites ?? 0,
    direct_callers: analysis.callers.get(index)?.size ?? 0,
  };
};

const sameType = (left: FuncType | undefined, right: FuncType | undefined) =>
  left !== undefined &&
  right !== undefined &&
  left.params.join(",") === right.params.join(",") &&
  left.results.join(",") === right.results.join(",");

/** Candidate targets of `call_indirect` through one table and signature; unknowns stay explicit. */
export const indirectTargets = (
  analysis: ModuleAnalysis,
  tableIndex: number,
  typeIndex: number,
): WasmFunctionReport["indirect_calls"][number]["targets"] => {
  const { module } = analysis;
  const table = module.tables[tableIndex];
  const wanted = module.types[typeIndex];
  const reasons: string[] = [];
  if (table === undefined)
    return {
      state: "unknown",
      candidates: [],
      reasons: [`Table ${String(tableIndex)} is not declared.`],
    };
  let state: "static" | "partial" | "unknown" = "static";
  if (table.imported) {
    state = "unknown";
    reasons.push("The table is imported, so its contents come from the host.");
  }
  if (exportNames(module, "table", tableIndex).length > 0) {
    if (state === "static") state = "partial";
    reasons.push("The table is exported, so the host can change its entries.");
  }
  if (analysis.mutatedTables.has(tableIndex)) {
    if (state === "static") state = "partial";
    reasons.push(
      "Code in this module writes to the table (table.set, grow, fill, init or copy).",
    );
  }
  const candidates = new Set<number>();
  for (const segment of module.elements) {
    const reachesTable =
      (segment.mode === "active" && segment.table === tableIndex) ||
      (segment.mode === "passive" && analysis.mutatedTables.has(tableIndex));
    if (!reachesTable) continue;
    if (segment.mode === "active" && segment.start?.value === null) {
      if (state === "static") state = "partial";
      reasons.push(
        `Element segment ${String(segment.index)} is placed at an offset only known at instantiation (${segment.start.text}).`,
      );
    }
    for (const item of segment.items) {
      if (item === "unknown") {
        if (state === "static") state = "partial";
        reasons.push(
          `Element segment ${String(segment.index)} has items computed at instantiation.`,
        );
        continue;
      }
      if (item === null) continue;
      const type =
        item < module.importedFunctions
          ? module.imports.filter((entry) => entry.kind === "func")[item]?.type
          : module.functionTypes[item - module.importedFunctions];
      if (
        type !== undefined &&
        type !== null &&
        sameType(module.types[type], wanted)
      )
        candidates.add(item);
    }
  }
  if (module.incompleteSections.has(9)) {
    if (state === "static") state = "partial";
    reasons.push("The element section was not fully decoded.");
  }
  if (candidates.size === 0 && state === "static")
    reasons.push(
      "No element of a matching signature can reach this table; the call traps if executed.",
    );
  return {
    state,
    candidates: [...candidates]
      .sort((a, b) => a - b)
      .map((index) => ({ index, name: functionName(module, index).name })),
    reasons: [...new Set(reasons)],
  };
};
