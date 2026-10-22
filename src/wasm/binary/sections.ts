import { ByteReader, WasmDecodeError } from "./ByteReader.js";
import { decodeConstantExpression } from "./decodeInstructions.js";
import {
  EXTERNAL_KINDS,
  MAX_FUNCTION_LOCALS,
  type ConstantOffset,
  type DecodedModule,
  type ExternalKind,
  type Limits,
} from "./moduleTypes.js";
import { REFERENCE_TYPES, VALUE_TYPES } from "./opcodes.js";

/**
 * Decoders for each section of the supported profile. Each reads only inside
 * its section's range and appends to the module being built.
 */

const valueType = (reader: ByteReader, what: string): string => {
  const at = reader.offset;
  const byte = reader.u8(what);
  const name = VALUE_TYPES.get(byte);
  if (name === undefined)
    throw new WasmDecodeError(
      at,
      `${what} 0x${byte.toString(16)} belongs to a proposal this reader does not decode.`,
      "typed-function-references",
    );
  return name;
};

const referenceType = (reader: ByteReader): string => {
  const at = reader.offset;
  const byte = reader.u8("reference type");
  const name = REFERENCE_TYPES.get(byte);
  if (name === undefined)
    throw new WasmDecodeError(
      at,
      `Reference type 0x${byte.toString(16)} belongs to a proposal this reader does not decode.`,
      "typed-function-references",
    );
  return name;
};

const limits = (
  reader: ByteReader,
  module: DecodedModule,
  memory: boolean,
): Limits => {
  const at = reader.offset;
  const flags = reader.u8("limits flags");
  if (flags > (memory ? 0x07 : 0x01))
    throw new WasmDecodeError(
      at,
      `Unknown limits flags 0x${flags.toString(16)}.`,
    );
  const memory64 = (flags & 0x04) !== 0;
  const shared = (flags & 0x02) !== 0;
  if (shared) module.proposals.add("threads");
  if (memory64) {
    module.proposals.add("memory64");
    const min = reader.u64("memory minimum");
    return {
      min,
      max: flags & 0x01 ? reader.u64("memory maximum") : null,
      shared,
      memory64,
    };
  }
  const min = BigInt(reader.u32("limits minimum"));
  const max = flags & 0x01 ? BigInt(reader.u32("limits maximum")) : null;
  return { min, max, shared, memory64 };
};

const globalType = (
  reader: ByteReader,
): { readonly type: string; readonly mutable: boolean } => {
  const type = valueType(reader, "global type");
  const at = reader.offset;
  const mutability = reader.u8("global mutability");
  if (mutability > 1)
    throw new WasmDecodeError(at, "Global mutability must be 0 or 1.");
  return { type, mutable: mutability === 1 };
};

const constant = (reader: ByteReader): ConstantOffset => {
  const expression = decodeConstantExpression(reader);
  return {
    text: expression.text,
    value: expression.value,
    global: expression.global,
  };
};

const importedCount = (module: DecodedModule, kind: ExternalKind): number =>
  module.imports.filter((entry) => entry.kind === kind).length;

const decodeType = (reader: ByteReader, module: DecodedModule): void => {
  const count = reader.count("type", 3);
  for (let index = 0; index < count; index += 1) {
    const at = reader.offset;
    const form = reader.u8("type form");
    if (form !== 0x60) {
      const gc = [0x4e, 0x50, 0x4f, 0x5f, 0x5e].includes(form);
      throw new WasmDecodeError(
        at,
        gc
          ? `Type ${String(index)} is a ${form === 0x4e ? "recursive group" : "GC type"}, which this reader does not decode.`
          : `Unknown type form 0x${form.toString(16)}.`,
        gc ? "gc" : null,
      );
    }
    const params: string[] = [];
    const paramCount = reader.count("parameter");
    for (let param = 0; param < paramCount; param += 1)
      params.push(valueType(reader, "parameter type"));
    const results: string[] = [];
    const resultCount = reader.count("result");
    for (let result = 0; result < resultCount; result += 1)
      results.push(valueType(reader, "result type"));
    module.types.push({ params, results });
  }
};

const decodeImport = (reader: ByteReader, module: DecodedModule): void => {
  const count = reader.count("import", 4);
  for (let item = 0; item < count; item += 1) {
    const offset = reader.offset;
    const moduleName = reader.name("import module name");
    const name = reader.name("import name");
    const kindAt = reader.offset;
    const kindByte = reader.u8("import kind");
    const kind = EXTERNAL_KINDS[kindByte];
    if (kind === undefined)
      throw new WasmDecodeError(
        kindAt,
        `Unknown import kind ${String(kindByte)}.`,
      );
    const base = {
      module: moduleName,
      name,
      kind,
      index: importedCount(module, kind),
      type: null,
      table: null,
      memory: null,
      global: null,
      offset,
    };
    switch (kind) {
      case "func":
        module.imports.push({ ...base, type: reader.u32("type index") });
        module.importedFunctions += 1;
        break;
      case "table": {
        const type = referenceType(reader);
        const tableLimits = limits(reader, module, false);
        module.imports.push({ ...base, table: { type, limits: tableLimits } });
        module.tables.push({
          index: base.index,
          imported: true,
          type,
          limits: tableLimits,
        });
        break;
      }
      case "memory": {
        const memoryLimits = limits(reader, module, true);
        module.imports.push({ ...base, memory: memoryLimits });
        module.memories.push({
          index: base.index,
          imported: true,
          limits: memoryLimits,
        });
        break;
      }
      case "global": {
        const global = globalType(reader);
        module.imports.push({ ...base, global });
        module.globals.push({
          index: base.index,
          imported: true,
          ...global,
          init: null,
        });
        break;
      }
      case "tag":
        throw new WasmDecodeError(
          kindAt,
          "Tag imports belong to the exception-handling proposal, which this reader does not decode.",
          "exception-handling",
        );
    }
  }
};

const decodeFunction = (reader: ByteReader, module: DecodedModule): void => {
  const count = reader.count("function");
  for (let index = 0; index < count; index += 1)
    module.functionTypes.push(reader.u32("type index"));
};

const decodeTable = (reader: ByteReader, module: DecodedModule): void => {
  const count = reader.count("table", 2);
  for (let item = 0; item < count; item += 1) {
    if (reader.bytes[reader.offset] === 0x40)
      throw new WasmDecodeError(
        reader.offset,
        "Tables with initializer expressions belong to the typed-function-references proposal, which this reader does not decode.",
        "typed-function-references",
      );
    const type = referenceType(reader);
    module.tables.push({
      index: module.tables.length,
      imported: false,
      type,
      limits: limits(reader, module, false),
    });
  }
};

const decodeMemory = (reader: ByteReader, module: DecodedModule): void => {
  const count = reader.count("memory", 2);
  for (let item = 0; item < count; item += 1)
    module.memories.push({
      index: module.memories.length,
      imported: false,
      limits: limits(reader, module, true),
    });
};

const decodeGlobal = (reader: ByteReader, module: DecodedModule): void => {
  const count = reader.count("global", 3);
  for (let item = 0; item < count; item += 1) {
    const type = globalType(reader);
    module.globals.push({
      index: module.globals.length,
      imported: false,
      ...type,
      init: decodeConstantExpression(reader).text,
    });
  }
};

const decodeExport = (reader: ByteReader, module: DecodedModule): void => {
  const count = reader.count("export", 3);
  for (let item = 0; item < count; item += 1) {
    const offset = reader.offset;
    const name = reader.name("export name");
    const kindAt = reader.offset;
    const kindByte = reader.u8("export kind");
    const kind = EXTERNAL_KINDS[kindByte];
    if (kind === undefined)
      throw new WasmDecodeError(
        kindAt,
        `Unknown export kind ${String(kindByte)}.`,
      );
    if (kind === "tag") module.proposals.add("exception-handling");
    module.exports.push({
      name,
      kind,
      index: reader.u32("export index"),
      offset,
    });
  }
};

const elementKind = (reader: ByteReader): string => {
  const at = reader.offset;
  if (reader.u8("element kind") !== 0x00)
    throw new WasmDecodeError(at, "Unknown element kind.");
  return "funcref";
};

const decodeElement = (reader: ByteReader, module: DecodedModule): void => {
  const count = reader.count("element segment");
  for (let item = 0; item < count; item += 1) {
    const offset = reader.offset;
    const flags = reader.u32("element flags");
    if (flags > 7)
      throw new WasmDecodeError(
        offset,
        `Unknown element segment flags ${String(flags)}.`,
      );
    const passiveOrDeclarative = (flags & 0x01) !== 0;
    const explicitTable = (flags & 0x02) !== 0;
    const expressions = (flags & 0x04) !== 0;
    const mode = !passiveOrDeclarative
      ? "active"
      : explicitTable
        ? "declarative"
        : "passive";
    let table: number | null = null;
    let start: ConstantOffset | null = null;
    if (mode === "active") {
      table = explicitTable ? reader.u32("table index") : 0;
      start = constant(reader);
    }
    const type =
      mode === "active" && !explicitTable
        ? "funcref"
        : expressions
          ? referenceType(reader)
          : elementKind(reader);
    const itemCount = reader.count("element item");
    const items: (number | null | "unknown")[] = [];
    for (let entry = 0; entry < itemCount; entry += 1) {
      if (!expressions) {
        items.push(reader.u32("function index"));
        continue;
      }
      const expression = decodeConstantExpression(reader);
      items.push(
        expression.func !== null
          ? expression.func
          : expression.text.startsWith("ref.null")
            ? null
            : "unknown",
      );
    }
    module.elements.push({
      index: module.elements.length,
      offset,
      mode,
      table,
      start,
      type,
      items,
    });
  }
};

const decodeData = (reader: ByteReader, module: DecodedModule): void => {
  const count = reader.count("data segment");
  for (let item = 0; item < count; item += 1) {
    const offset = reader.offset;
    const flags = reader.u32("data flags");
    if (flags > 2)
      throw new WasmDecodeError(
        offset,
        `Unknown data segment flags ${String(flags)}.`,
      );
    const memory =
      flags === 1 ? null : flags === 2 ? reader.u32("memory index") : 0;
    const start = flags === 1 ? null : constant(reader);
    const size = reader.count("data byte");
    const payloadOffset = reader.offset;
    reader.take(size, "data payload");
    module.data.push({
      index: module.data.length,
      offset,
      mode: flags === 1 ? "passive" : "active",
      memory,
      start,
      payloadOffset,
      size,
    });
  }
};

const decodeCode = (reader: ByteReader, module: DecodedModule): void => {
  const count = reader.count("function body");
  for (let item = 0; item < count; item += 1) {
    const offset = reader.offset;
    const size = reader.count("function body byte");
    const end = reader.offset + size;
    const body = new ByteReader(reader.bytes, reader.offset, end);
    const groups = body.count("local group", 2);
    const locals: { count: number; type: string }[] = [];
    let total = 0;
    for (let group = 0; group < groups; group += 1) {
      const at = body.offset;
      const localCount = body.u32("local count");
      total += localCount;
      if (total > MAX_FUNCTION_LOCALS)
        throw new WasmDecodeError(
          at,
          `Function body declares more than ${String(MAX_FUNCTION_LOCALS)} locals.`,
        );
      locals.push({ count: localCount, type: valueType(body, "local type") });
    }
    module.bodies.push({
      index: module.importedFunctions + item,
      type: module.functionTypes[item] ?? -1,
      offset,
      size,
      codeOffset: body.offset,
      end,
      locals,
    });
    reader.skipTo(end);
  }
};

/** The `name` custom section: module, function and local names. */
export const decodeNames = (
  reader: ByteReader,
  module: DecodedModule,
): void => {
  while (!reader.atEnd()) {
    const id = reader.u8("name subsection id");
    const size = reader.count("name subsection byte");
    const end = reader.offset + size;
    const sub = new ByteReader(reader.bytes, reader.offset, end);
    if (id === 0) module.names.module = sub.name("module name");
    else if (id === 1) {
      const count = sub.count("function name", 2);
      for (let item = 0; item < count; item += 1) {
        const index = sub.u32("function index");
        module.names.functions.set(index, sub.name("function name"));
      }
    } else if (id === 2) {
      const count = sub.count("local name group", 2);
      for (let item = 0; item < count; item += 1) {
        const func = sub.u32("function index");
        const names = new Map<number, string>();
        const localCount = sub.count("local name", 2);
        for (let local = 0; local < localCount; local += 1) {
          const index = sub.u32("local index");
          names.set(index, sub.name("local name"));
        }
        module.names.locals.set(func, names);
      }
    }
    // Other subsections (labels, types, ...) are kept as bytes, not decoded.
    reader.skipTo(end);
  }
};

export const decodeProducers = (
  reader: ByteReader,
  module: DecodedModule,
): void => {
  const count = reader.count("producer field", 2);
  for (let item = 0; item < count; item += 1) {
    const field = reader.name("producer field");
    const valueCount = reader.count("producer value", 2);
    const values: { name: string; version: string }[] = [];
    for (let value = 0; value < valueCount; value += 1)
      values.push({
        name: reader.name("producer name"),
        version: reader.name("producer version"),
      });
    module.producers.push({ field, values });
  }
};

export const SECTION_DECODERS: Readonly<
  Record<number, (reader: ByteReader, module: DecodedModule) => void>
> = {
  1: decodeType,
  2: decodeImport,
  3: decodeFunction,
  4: decodeTable,
  5: decodeMemory,
  6: decodeGlobal,
  7: decodeExport,
  8: (reader, module) => {
    module.start = reader.u32("start function index");
  },
  9: decodeElement,
  10: decodeCode,
  11: decodeData,
  12: (reader, module) => {
    module.dataCount = reader.u32("data count");
  },
};
