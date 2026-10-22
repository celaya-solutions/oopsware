import type {
  AndroidDiagnostic,
  DexClassReport,
  DexMethodReport,
  InspectDexClassInput,
  InspectDexMethodInput,
} from "../domain/android/androidArtifact.js";
import { dexAccessFlags } from "./dex/accessFlags.js";
import { DexFormatError } from "./dex/DexReader.js";
import {
  type DexAnnotation,
  type DexClassDef,
  type DexCodeItem,
  type DexDebugInfo,
  type DexEncodedMethod,
  type DexFile,
  NO_INDEX,
} from "./dex/dexFile.js";
import { decodeDalvik } from "./dex/instructions.js";
import { dexValueText } from "./dex/valueText.js";
import { binaryName, classDescriptor, type LoadedDex } from "./dexInventory.js";

export const DEX_CLASS_LIMITATIONS = [
  "DEX bytes are parsed in process; nothing is verified, optimized, installed or run, and no class is loaded.",
  "Names, descriptors and access flags are exactly what the DEX declares; values of static fields are their encoded initial values, not run-time state.",
  "Parameter names come from debug information when the DEX records it; release builds often strip it.",
];

export const DEX_METHOD_LIMITATIONS = [
  ...DEX_CLASS_LIMITATIONS,
  "Instructions and operands are rendered as dexdump (Android build-tools 37.0.0) renders them; register types and values are not inferred.",
  "Switch tables and array data are listed where they sit in the code, as dexdump lists them; their targets are also attached to the instruction that uses them.",
  "References list what the instructions name; which method a virtual or interface call reaches at run time is not resolved.",
];

/** A caller selection that does not name exactly one DEX, class or method. */
export class AndroidSelectionError extends Error {
  constructor(
    readonly field: "class" | "container" | "entry" | "method" | "descriptor",
    message: string,
  ) {
    super(message);
    this.name = "AndroidSelectionError";
  }
}

export interface SelectedClass {
  readonly loaded: LoadedDex;
  readonly dex: DexFile;
  readonly def: DexClassDef;
  readonly selection: DexClassReport["selection"];
}

const findClass = (dex: DexFile, descriptor: string): DexClassDef | null => {
  for (let index = 0; index < dex.classCount; index += 1) {
    const def = dex.classDef(index);
    if (dex.type(def.class_idx) === descriptor) return def;
  }
  return null;
};

const where = (entry: LoadedDex): string =>
  [entry.location.container, entry.location.entry ?? "the file"]
    .filter((part) => part !== null)
    .join(" ! ");

/** Find the one DEX that defines the class; several different definitions need an explicit choice. */
export const selectDexClass = (
  dexFiles: {
    readonly all: readonly LoadedDex[];
    readonly scoped: readonly LoadedDex[];
  },
  input: Pick<InspectDexClassInput, "class" | "container" | "entry">,
  bareDex: boolean,
): SelectedClass => {
  const descriptor = classDescriptor(input.class);
  const definitions = dexFiles.all.flatMap((entry) => {
    if (entry.dex === null || entry.sha256 === null) return [];
    const def = findClass(entry.dex, descriptor);
    return def === null
      ? []
      : [{ entry, dex: entry.dex, def, sha256: entry.sha256 }];
  });
  const found = definitions.filter((candidate) =>
    dexFiles.scoped.includes(candidate.entry),
  );
  const loaded = dexFiles.scoped;
  const first = found[0];
  if (first === undefined)
    throw new AndroidSelectionError(
      "class",
      `No DEX ${loaded.length === 1 ? "file" : `of the ${String(loaded.length)} searched`} defines ${descriptor}.`,
    );
  const identical = found.every(
    (candidate) => candidate.sha256 === first.sha256,
  );
  if (found.length > 1 && !identical)
    throw new AndroidSelectionError(
      "container",
      `${descriptor} is defined in ${String(found.length)} different DEX files (${found.map((candidate) => where(candidate.entry)).join(", ")}); choose one with container and entry.`,
    );
  const basis = bareDex
    ? "file"
    : input.entry !== undefined
      ? "entry"
      : found.length === 1
        ? "only"
        : "identical";
  return {
    loaded: first.entry,
    dex: first.dex,
    def: first.def,
    selection: {
      container: first.entry.location.container,
      entry: first.entry.location.entry,
      dex_sha256: first.sha256,
      basis,
      class_def_index: first.def.index,
      class_def_offset: first.def.offset,
      definitions: definitions.map((candidate) => ({
        container: candidate.entry.location.container,
        entry: candidate.entry.location.entry,
      })),
    },
  };
};

const VISIBILITY = ["build", "runtime", "system"] as const;

const annotationsOf = (
  dex: DexFile,
  annotations: readonly DexAnnotation[] | undefined,
): DexClassReport["class"]["annotations"] =>
  (annotations ?? []).map((annotation) => ({
    visibility: VISIBILITY[annotation.visibility] ?? "unknown",
    type: dex.type(annotation.type_idx),
    elements: annotation.elements.map((element) => ({
      name: dex.string(element.name_idx),
      value: dexValueText(element.value, dex),
    })),
  }));

const codeSummary = (code: DexCodeItem) => ({
  offset: code.offset,
  registers: code.registers,
  ins: code.ins,
  outs: code.outs,
  insns_units: code.insns_size,
  tries: code.tries.length,
  debug_info_offset: code.debug_info_off === 0 ? null : code.debug_info_off,
});

const diagnostic = (
  loaded: LoadedDex,
  cause: DexFormatError,
  what: string,
): AndroidDiagnostic => ({
  container: loaded.location.container,
  entry: loaded.location.entry,
  offset: cause.offset,
  message: `${what}: ${cause.message}`,
});

/** Code item and debug info of one method; damage becomes a diagnostic. */
const methodCode = (
  dex: DexFile,
  loaded: LoadedDex,
  descriptor: string,
  method: DexEncodedMethod,
  diagnostics: AndroidDiagnostic[],
): { code: DexCodeItem | null; debug: DexDebugInfo | null } => {
  if (method.code_off === 0) return { code: null, debug: null };
  const id = dex.method(method.method_idx);
  let code: DexCodeItem;
  try {
    code = dex.codeItem(method.code_off);
  } catch (cause) {
    if (!(cause instanceof DexFormatError)) throw cause;
    diagnostics.push(
      diagnostic(loaded, cause, `code_item of ${id?.name ?? "?"}`),
    );
    return { code: null, debug: null };
  }
  try {
    return {
      code,
      debug: dex.debugInfo(code, {
        class_descriptor: descriptor,
        is_static: (method.access_flags & 0x8) !== 0,
        proto_index: id?.proto_index ?? -1,
      }),
    };
  } catch (cause) {
    if (!(cause instanceof DexFormatError)) throw cause;
    diagnostics.push(
      diagnostic(loaded, cause, `debug_info of ${id?.name ?? "?"}`),
    );
    return { code, debug: null };
  }
};

/** Fields, methods, values and annotations of the selected class. */
export const dexClassReport = (
  artifact: DexClassReport["artifact"],
  selected: SelectedClass,
): DexClassReport => {
  const { dex, def, loaded } = selected;
  const descriptor = dex.type(def.class_idx) ?? "";
  const diagnostics: AndroidDiagnostic[] = [];
  const data = dex.classData(def);
  let directory: ReturnType<DexFile["annotations"]> = null;
  try {
    directory = dex.annotations(def.annotations_off);
  } catch (cause) {
    if (!(cause instanceof DexFormatError)) throw cause;
    diagnostics.push(diagnostic(loaded, cause, "annotations_directory_item"));
  }
  let statics: ReturnType<DexFile["encodedArray"]> = [];
  try {
    statics = dex.encodedArray(def.static_values_off);
  } catch (cause) {
    if (!(cause instanceof DexFormatError)) throw cause;
    diagnostics.push(diagnostic(loaded, cause, "static_values"));
  }
  const field = (
    entry: { field_idx: number; access_flags: number },
    value: string | null,
  ) => {
    const id = dex.field(entry.field_idx);
    return {
      field_index: entry.field_idx,
      name: id?.name ?? null,
      type: id?.type ?? null,
      access_flags: entry.access_flags,
      access: dexAccessFlags(entry.access_flags, "field"),
      value,
      annotations: annotationsOf(dex, directory?.fields.get(entry.field_idx)),
    };
  };
  const method = (entry: DexEncodedMethod) => {
    const id = dex.method(entry.method_idx);
    const proto = id === null ? null : dex.proto(id.proto_index);
    const { code, debug } = methodCode(
      dex,
      loaded,
      descriptor,
      entry,
      diagnostics,
    );
    const parameterAnnotations = directory?.parameters.get(entry.method_idx);
    return {
      method_index: entry.method_idx,
      name: id?.name ?? null,
      descriptor: id === null ? null : dex.protoDescriptor(id.proto_index),
      access_flags: entry.access_flags,
      access: dexAccessFlags(entry.access_flags, "method"),
      code: code === null ? null : codeSummary(code),
      parameters: (proto?.parameters ?? []).map((type, index) => ({
        type,
        name: debug?.parameter_names[index] ?? null,
        annotations: annotationsOf(dex, parameterAnnotations?.[index]),
      })),
      annotations: annotationsOf(dex, directory?.methods.get(entry.method_idx)),
    };
  };
  const staticValue = (index: number): string | null => {
    const value = statics[index];
    return value === undefined ? null : dexValueText(value, dex);
  };
  return {
    artifact,
    selection: selected.selection,
    class: {
      descriptor,
      name: binaryName(descriptor) ?? descriptor,
      access_flags: def.access_flags,
      access: dexAccessFlags(def.access_flags, "class"),
      superclass:
        def.superclass_idx === NO_INDEX ? null : dex.type(def.superclass_idx),
      interfaces: (dex.typeList(def.interfaces_off) ?? []).map((type) =>
        dex.type(type),
      ),
      source_file:
        def.source_file_idx === NO_INDEX
          ? null
          : dex.string(def.source_file_idx),
      annotations: annotationsOf(dex, directory?.class_annotations),
      static_fields: (data?.static_fields ?? []).map((entry, index) =>
        field(entry, staticValue(index)),
      ),
      instance_fields: (data?.instance_fields ?? []).map((entry) =>
        field(entry, null),
      ),
      direct_methods: (data?.direct_methods ?? []).map(method),
      virtual_methods: (data?.virtual_methods ?? []).map(method),
    },
    diagnostics,
    limitations: DEX_CLASS_LIMITATIONS,
  };
};

/** Find one method by name, and by descriptor when the name is overloaded. */
export const selectDexMethod = (
  selected: SelectedClass,
  input: Pick<InspectDexMethodInput, "method" | "descriptor">,
): DexEncodedMethod => {
  const { dex, def } = selected;
  const data = dex.classData(def);
  const methods = [
    ...(data?.direct_methods ?? []),
    ...(data?.virtual_methods ?? []),
  ];
  const named = methods.filter(
    (entry) => dex.method(entry.method_idx)?.name === input.method,
  );
  const descriptorOf = (entry: DexEncodedMethod) => {
    const id = dex.method(entry.method_idx);
    return id === null ? null : dex.protoDescriptor(id.proto_index);
  };
  if (named.length === 0)
    throw new AndroidSelectionError(
      "method",
      `${dex.type(def.class_idx) ?? "The class"} declares no method named ${input.method}.`,
    );
  const declared = named.map((entry) => descriptorOf(entry) ?? "?").join(", ");
  if (input.descriptor !== undefined) {
    const exact = named.find(
      (entry) => descriptorOf(entry) === input.descriptor,
    );
    if (exact === undefined)
      throw new AndroidSelectionError(
        "descriptor",
        `${input.method} has no overload ${input.descriptor}; declared: ${declared}.`,
      );
    return exact;
  }
  const only = named[0];
  if (named.length > 1 || only === undefined)
    throw new AndroidSelectionError(
      "descriptor",
      `${input.method} is overloaded; give descriptor, one of: ${declared}.`,
    );
  return only;
};

const lineAt = (
  positions: DexDebugInfo["positions"],
  address: number,
): number | null => {
  let line: number | null = null;
  for (const position of positions) {
    if (position.address > address) break;
    line = position.line;
  }
  return line;
};

/** Instructions, exception handlers, debug info and references of one method. */
export const dexMethodReport = (
  artifact: DexMethodReport["artifact"],
  selected: SelectedClass,
  method: DexEncodedMethod,
  page: { start: number; limit: number },
): DexMethodReport => {
  const { dex, def, loaded } = selected;
  const descriptor = dex.type(def.class_idx) ?? "";
  const id = dex.method(method.method_idx);
  const diagnostics: AndroidDiagnostic[] = [];
  const { code, debug } = methodCode(
    dex,
    loaded,
    descriptor,
    method,
    diagnostics,
  );
  const decoded =
    code === null
      ? {
          instructions: [],
          problems: [],
          references: {
            invocations: [],
            field_accesses: [],
            types: [],
            strings: [],
            other: [],
          },
        }
      : decodeDalvik(dex.codeUnits(code), dex);
  const positions = debug?.positions ?? [];
  const total = decoded.instructions.length;
  const slice = decoded.instructions.slice(page.start, page.start + page.limit);
  const next = page.start + slice.length;
  return {
    artifact,
    selection: selected.selection,
    method: {
      class: descriptor,
      name: id?.name ?? "",
      descriptor:
        id === null ? "" : (dex.protoDescriptor(id.proto_index) ?? ""),
      method_index: method.method_idx,
      access_flags: method.access_flags,
      access: dexAccessFlags(method.access_flags, "method"),
      code: code === null ? null : codeSummary(code),
    },
    instruction_count: total,
    page: {
      start: page.start,
      limit: page.limit,
      returned: slice.length,
      next: next < total ? next : null,
    },
    instructions: slice.map((instruction, offset) => ({
      index: page.start + offset,
      address: instruction.address,
      offset: (code?.insns_offset ?? 0) + instruction.address * 2,
      units: instruction.units,
      opcode: `0x${instruction.opcode.toString(16).padStart(instruction.opcode > 0xff ? 4 : 2, "0")}`,
      mnemonic: instruction.mnemonic,
      format: instruction.format,
      operands: instruction.operands,
      line: lineAt(positions, instruction.address),
      registers: [...instruction.registers],
      literal: instruction.literal,
      target: instruction.target,
      reference: instruction.reference,
      proto: instruction.proto,
      switch_targets:
        instruction.switch_targets === null
          ? null
          : instruction.switch_targets.map((entry) => ({ ...entry })),
      array_data: instruction.array_data,
    })),
    tries: (code?.tries ?? []).map((entry) => ({
      start: entry.start,
      end: entry.start + entry.count,
      handlers: entry.handlers.map((handler) => ({
        type: handler.type_idx === null ? null : dex.type(handler.type_idx),
        address: handler.address,
      })),
    })),
    positions: positions.map((position) => ({ ...position })),
    locals: (debug?.locals ?? []).map((local) => ({ ...local })),
    references: {
      invocations: decoded.references.invocations.map((entry) => ({
        ...entry,
      })),
      field_accesses: decoded.references.field_accesses.map((entry) => ({
        ...entry,
      })),
      types: decoded.references.types.map((entry) => ({ ...entry })),
      strings: decoded.references.strings.map((entry) => ({ ...entry })),
      other: decoded.references.other.map((entry) => ({ ...entry })),
    },
    problems: decoded.problems.map((problem) => ({ ...problem })),
    diagnostics,
    limitations: DEX_METHOD_LIMITATIONS,
  };
};
