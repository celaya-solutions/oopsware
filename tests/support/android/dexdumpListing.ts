import {
  NO_INDEX,
  type DexAnnotation,
  type DexClassDef,
  type DexCodeItem,
  type DexEncodedField,
  type DexEncodedMethod,
  type DexFile,
  type DexMethodHandle,
  type DexValue,
} from "../../../src/androidPackage/dex/dexFile.js";
import { DexReader } from "../../../src/androidPackage/dex/DexReader.js";
import { dexAccessFlagsText } from "../../../src/androidPackage/dex/accessFlags.js";
import {
  decodeDalvik,
  METHOD_HANDLE_TYPES,
  type DalvikInstruction,
} from "../../../src/androidPackage/dex/instructions.js";
import {
  dexValueText,
  escapeDexString,
} from "../../../src/androidPackage/dex/valueText.js";

/**
 * The text of `dexdump -d` (with `-a`, `-d -a`) for a whole DEX file, built
 * from DexFile and the Dalvik decoder only, without the leading
 * `Processing '...'` / `Opened '...'` lines. It is the oracle comparison that
 * shows both the structure parser and the instruction decoder print what
 * dexdump prints. Hidden API flags are not rendered (d8 writes none).
 */

const hex = (value: number, width: number): string =>
  (value >>> 0).toString(16).padStart(width, "0");

const PRIMITIVES: Readonly<Record<string, string>> = {
  B: "byte",
  C: "char",
  D: "double",
  F: "float",
  I: "int",
  J: "long",
  S: "short",
  V: "void",
  Z: "boolean",
};

/** dexdump's `descriptorToDot`: "Ljava/lang/String;" to "java.lang.String", "[I" to "int[]". */
const descriptorToDot = (descriptor: string): string => {
  let depth = 0;
  while (descriptor.length - depth > 1 && descriptor[depth] === "[") depth += 1;
  let name = descriptor.slice(depth);
  if (name.length === 1) name = PRIMITIVES[name] ?? "UNKNOWN";
  else if (name.startsWith("L") && name.endsWith(";")) name = name.slice(1, -1);
  return `${name.replaceAll("/", ".")}${"[]".repeat(depth)}`;
};

const VISIBILITY = [
  "VISIBILITY_BUILD",
  "VISIBILITY_RUNTIME",
  "VISIBILITY_SYSTEM",
];

const annotationSet = (
  dex: DexFile,
  set: readonly DexAnnotation[],
): string[] =>
  set.length === 0
    ? ["  empty-annotation-set"]
    : set.map(
        (annotation) =>
          `  ${VISIBILITY[annotation.visibility] ?? "VISIBILITY_UNKNOWN"} ${dexValueText({ kind: "annotation", annotation }, dex)}`,
      );

const fieldName = (dex: DexFile, index: number) =>
  dex.field(index)?.name ?? "?";
const methodName = (dex: DexFile, index: number) =>
  dex.method(index)?.name ?? "?";

const classAnnotations = (dex: DexFile, def: DexClassDef): string[] => {
  const directory = dex.annotations(def.annotations_off);
  if (directory === null) return [];
  const classSet = new DexReader(dex.bytes, def.annotations_off, dex.limit).u4(
    "class_annotations_off",
  );
  const lines = [`Class #${String(def.index)} annotations:`];
  if (classSet !== 0)
    lines.push(
      "Annotations on class",
      ...annotationSet(dex, directory.class_annotations),
    );
  for (const [index, set] of directory.fields)
    lines.push(
      `Annotations on field #${String(index)} '${fieldName(dex, index)}'`,
      ...annotationSet(dex, set),
    );
  for (const [index, set] of directory.methods)
    lines.push(
      `Annotations on method #${String(index)} '${methodName(dex, index)}'`,
      ...annotationSet(dex, set),
    );
  for (const [index, sets] of directory.parameters) {
    lines.push(
      `Annotations on method #${String(index)} '${methodName(dex, index)}' parameters`,
    );
    sets.forEach((set, position) =>
      lines.push(`#${String(position)}`, ...annotationSet(dex, set)),
    );
  }
  lines.push("");
  return lines;
};

const instructionLine = (
  units: Uint16Array,
  codeOffset: number,
  instruction: DalvikInstruction,
): string => {
  let columns = "";
  for (let index = 0; index < 8; index += 1) {
    const unit = units[instruction.address + index] ?? 0;
    if (index >= instruction.units) columns += "     ";
    else if (index === 7) columns += " ... ";
    else columns += ` ${hex(unit & 0xff, 2)}${hex(unit >> 8, 2)}`;
  }
  const text =
    instruction.operands === ""
      ? instruction.mnemonic
      : `${instruction.mnemonic} ${instruction.operands}`;
  return `${hex(codeOffset + 0x10 + instruction.address * 2, 6)}:${columns}|${hex(instruction.address, 4)}: ${text}`;
};

const catches = (dex: DexFile, code: DexCodeItem): string[] => {
  if (code.tries.length === 0) return ["      catches       : (none)"];
  const lines = [`      catches       : ${String(code.tries.length)}`];
  for (const entry of code.tries) {
    lines.push(
      `        0x${hex(entry.start, 4)} - 0x${hex(entry.start + entry.count, 4)}`,
    );
    for (const handler of entry.handlers)
      lines.push(
        `          ${handler.type_idx === null ? "<any>" : (dex.type(handler.type_idx) ?? "?")} -> 0x${hex(handler.address, 4)}`,
      );
  }
  return lines;
};

const debugLines = (
  dex: DexFile,
  code: DexCodeItem,
  method: DexEncodedMethod,
  instructions: readonly DalvikInstruction[],
): string[] => {
  const id = dex.method(method.method_idx);
  const info = dex.debugInfo(code, {
    class_descriptor: id?.class ?? null,
    is_static: (method.access_flags & 0x8) !== 0,
    proto_index: id?.proto_index ?? 0,
  });
  // dexdump stops at the first position past the last instruction's address.
  const last = instructions.at(-1);
  const lastAddress =
    last === undefined ? code.insns_size : code.insns_size - last.units;
  const lines = ["      positions     :"];
  for (const position of info?.positions ?? []) {
    if (position.address > lastAddress) break;
    lines.push(
      `        0x${hex(position.address, 4)} line=${String(position.line)}`,
    );
  }
  lines.push("      locals        :");
  // ART decodes no locals when the parameter names disagree with the prototype.
  const parameters = dex.proto(id?.proto_index ?? -1)?.parameters.length ?? 0;
  if (info !== null && info.parameter_names.length === parameters)
    for (const local of info.locals)
      lines.push(
        `        0x${hex(local.start, 4)} - 0x${hex(local.end, 4)} reg=${String(local.register)} ${local.name ?? "(null)"} ${local.type ?? "(null)"}${local.signature === null ? "" : ` ${local.signature}`}`,
      );
  return lines;
};

const methodCode = (
  dex: DexFile,
  method: DexEncodedMethod,
  out: string[],
): void => {
  const code = dex.codeItem(method.code_off);
  const units = dex.codeUnits(code);
  const decoded = decodeDalvik(units, dex);
  const id = dex.method(method.method_idx);
  const proto = dex.protoDescriptor(id?.proto_index ?? -1) ?? "?";
  out.push(
    `      registers     : ${String(code.registers)}`,
    `      ins           : ${String(code.ins)}`,
    `      outs          : ${String(code.outs)}`,
    `      insns size    : ${String(code.insns_size)} 16-bit code units`,
    `${hex(method.code_off, 6)}:${" ".repeat(40)}|[${hex(method.code_off, 6)}] ${descriptorToDot(id?.class ?? "?")}.${id?.name ?? "?"}:${proto}`,
  );
  for (const instruction of decoded.instructions)
    out.push(instructionLine(units, method.code_off, instruction));
  out.push(
    ...catches(dex, code),
    ...debugLines(dex, code, method, decoded.instructions),
  );
};

/** Appends one method's block to `out` (pushed line by line: real methods reach 100k lines). */
const methodBlock = (
  dex: DexFile,
  method: DexEncodedMethod,
  position: number,
  out: string[],
): void => {
  const id = dex.method(method.method_idx);
  out.push(
    `    #${String(position)}              : (in ${id?.class ?? "?"})`,
    `      name          : '${id?.name ?? "?"}'`,
    `      type          : '${dex.protoDescriptor(id?.proto_index ?? -1) ?? "?"}'`,
    `      access        : ${dexAccessFlagsText(method.access_flags, "method")}`,
  );
  if (method.code_off === 0) out.push("      code          : (none)");
  else {
    out.push("      code          -");
    methodCode(dex, method, out);
  }
  out.push("");
};

const fieldBlock = (
  dex: DexFile,
  field: DexEncodedField,
  position: number,
  value: DexValue | undefined,
): string[] => {
  const id = dex.field(field.field_idx);
  return [
    `    #${String(position)}              : (in ${id?.class ?? "?"})`,
    `      name          : '${id?.name ?? "?"}'`,
    `      type          : '${id?.type ?? "?"}'`,
    `      access        : ${dexAccessFlagsText(field.access_flags, "field")}`,
    ...(value === undefined
      ? []
      : [`      value         : ${dexValueText(value, dex)}`]),
  ];
};

const classBlock = (dex: DexFile, def: DexClassDef, lines: string[]): void => {
  const data = dex.classData(def);
  const values = dex.encodedArray(def.static_values_off);
  lines.push(
    `Class #${String(def.index)}            -`,
    `  Class descriptor  : '${dex.type(def.class_idx) ?? "?"}'`,
    `  Access flags      : ${dexAccessFlagsText(def.access_flags, "class")}`,
  );
  if (def.superclass_idx !== NO_INDEX)
    lines.push(
      `  Superclass        : '${dex.type(def.superclass_idx) ?? "?"}'`,
    );
  lines.push("  Interfaces        -");
  (dex.typeList(def.interfaces_off) ?? []).forEach((type, position) =>
    lines.push(
      `    #${String(position)}              : '${dex.type(type) ?? "?"}'`,
    ),
  );
  lines.push("  Static fields     -");
  (data?.static_fields ?? []).forEach((field, position) =>
    lines.push(...fieldBlock(dex, field, position, values[position])),
  );
  lines.push("  Instance fields   -");
  (data?.instance_fields ?? []).forEach((field, position) =>
    lines.push(...fieldBlock(dex, field, position, undefined)),
  );
  lines.push("  Direct methods    -");
  (data?.direct_methods ?? []).forEach((method, position) =>
    methodBlock(dex, method, position, lines),
  );
  lines.push("  Virtual methods   -");
  (data?.virtual_methods ?? []).forEach((method, position) =>
    methodBlock(dex, method, position, lines),
  );
  const source =
    def.source_file_idx === NO_INDEX
      ? "unknown"
      : (dex.string(def.source_file_idx) ?? "?");
  lines.push(
    `  source_file_idx   : ${String(def.source_file_idx | 0)} (${source})`,
    "",
  );
};

const INSTANCE_HANDLES = new Set([2, 3, 5, 6, 7, 8]);

/** dexdump's `target` owner, member and `target_type` of one method handle; instance kinds prepend the owner. */
const handleTarget = (
  dex: DexFile,
  handle: DexMethodHandle,
  type: string,
): [string, string, string] => {
  let target: [string, string, string];
  if (type.startsWith("invoke-")) {
    const method = dex.method(handle.field_or_method_id);
    target = [
      method?.class ?? "?",
      method?.name ?? "?",
      dex.protoDescriptor(method?.proto_index ?? -1) ?? "?",
    ];
  } else {
    const field = dex.field(handle.field_or_method_id);
    target = [field?.class ?? "?", field?.name ?? "?", field?.type ?? "?"];
  }
  if (INSTANCE_HANDLES.has(handle.type))
    target[2] = `(${target[0]}${target[2].slice(1)}`;
  return target;
};

const methodHandles = (dex: DexFile): string[] => {
  const lines: string[] = [];
  for (let index = 0; index < dex.method_handles.size; index += 1) {
    const handle = dex.methodHandle(index);
    const type = handle === null ? undefined : METHOD_HANDLE_TYPES[handle.type];
    const [owner, member, memberType] =
      handle === null || type === undefined
        ? ["?", "?", "?"]
        : handleTarget(dex, handle, type);
    lines.push(
      `Method handle #${String(index)}:`,
      `  type        : ${type ?? "?"}`,
      `  target      : ${owner} ${member}`,
      `  target_type : ${memberType}`,
    );
  }
  return lines;
};

const LINK_TYPES: Readonly<Record<DexValue["kind"], string>> = {
  byte: "byte",
  short: "short",
  char: "char",
  int: "int",
  long: "long",
  float: "float",
  double: "double",
  method_type: "MethodType",
  method_handle: "MethodHandle",
  string: "String",
  type: "Class",
  null: "Null",
  boolean: "boolean",
  field: "field",
  method: "method",
  enum: "enum",
  array: "array",
  annotation: "annotation",
};

/** dexdump's `link_argument` value and type name for a call site's extra arguments. */
const linkArgument = (dex: DexFile, value: DexValue): [string, string] => {
  const type = LINK_TYPES[value.kind];
  switch (value.kind) {
    case "byte":
      // Printed with %u after promotion, so negative bytes show as 32-bit unsigned.
      return [String(((value.value << 24) >> 24) >>> 0), type];
    case "method_type":
      return [dex.protoDescriptor(value.index) ?? "?", type];
    case "method_handle":
      return [String(value.index), type];
    case "string":
      // build-tools 37's dexdump escapes these (without quotes); AOSP main prints them raw.
      return [escapeDexString(dex.string(value.index) ?? "?"), type];
    case "type":
      return [dex.type(value.index) ?? "?", type];
    default:
      // Numbers, null and booleans print as they do in encoded values.
      return [dexValueText(value, dex), type];
  }
};

const indexOf = (value: DexValue | undefined): number =>
  value !== undefined && "index" in value ? value.index : -1;

const callSites = (dex: DexFile): string[] => {
  const lines: string[] = [];
  for (let index = 0; index < dex.call_site_ids.size; index += 1) {
    const values = dex.callSite(index) ?? [];
    if (values.length < 3) continue;
    const offset = new DexReader(
      dex.bytes,
      dex.call_site_ids.offset + index * 4,
      dex.limit,
    ).u4("call_site_off");
    lines.push(
      `Call site #${String(index)}: // offset ${String(offset)}`,
      `  link_argument[0] : ${String(indexOf(values[0]))} (MethodHandle)`,
      `  link_argument[1] : ${dex.string(indexOf(values[1])) ?? "?"} (String)`,
      `  link_argument[2] : ${dex.protoDescriptor(indexOf(values[2])) ?? "?"} (MethodType)`,
    );
    values.slice(3).forEach((value, position) => {
      const [text, type] = linkArgument(dex, value);
      lines.push(
        `  link_argument[${String(position + 3)}] : ${text} (${type})`,
      );
    });
  }
  return lines;
};

export const renderDexdumpListing = (
  dex: DexFile,
  options: { readonly annotations: boolean },
): string => {
  const lines: string[] = [];
  for (let index = 0; index < dex.classCount; index += 1) {
    const def = dex.classDef(index);
    if (options.annotations) lines.push(...classAnnotations(dex, def));
    classBlock(dex, def, lines);
  }
  lines.push(...methodHandles(dex), ...callSites(dex));
  return `${lines.join("\n")}\n`;
};

/** MUTF-8 bytes of `text` (NUL as C0 80, surrogates one by one), as dexdump writes DEX strings. */
export const encodeModifiedUtf8 = (text: string): Uint8Array => {
  const width = (unit: number) =>
    unit !== 0 && unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
  let length = 0;
  for (let index = 0; index < text.length; index += 1)
    length += width(text.charCodeAt(index));
  const bytes = new Uint8Array(length);
  let at = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit !== 0 && unit < 0x80) bytes[at++] = unit;
    else if (unit < 0x800) {
      bytes[at++] = 0xc0 | (unit >> 6);
      bytes[at++] = 0x80 | (unit & 0x3f);
    } else {
      bytes[at++] = 0xe0 | (unit >> 12);
      bytes[at++] = 0x80 | ((unit >> 6) & 0x3f);
      bytes[at++] = 0x80 | (unit & 0x3f);
    }
  }
  return bytes;
};
