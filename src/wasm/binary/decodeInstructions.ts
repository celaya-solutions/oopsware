import { ByteReader, WasmDecodeError } from "./ByteReader.js";
import {
  naturalAlignment,
  opcodeInfo,
  prefixedOpcodeInfo,
  REFERENCE_TYPES,
  unsupportedProposal,
  VALUE_TYPES,
  type OpcodeInfo,
} from "./opcodes.js";

/** One decoded instruction at its exact byte offset. */
export interface DecodedInstruction {
  readonly offset: number;
  /** Bytes of opcode and immediates. */
  readonly size: number;
  /** Structured-control nesting before the instruction; `else`/`end` print at their block's depth. */
  readonly depth: number;
  readonly name: string;
  /** WAT-style immediates, with indices rather than invented names. */
  readonly immediates: string;
  /** Function index of `call`, `return_call` and `ref.func`. */
  readonly func: number | null;
  /** `call_indirect`/`return_call_indirect` signature and table. */
  readonly indirect: { readonly type: number; readonly table: number } | null;
  /** Constant value of `i32.const`/`i64.const`, for offset expressions. */
  readonly constant: bigint | null;
  /** Global index of `global.get`, for offset expressions. */
  readonly global: number | null;
}

export interface DecodeVisitor {
  instruction(instruction: DecodedInstruction): void;
}

const valueType = (byte: number, at: number): string => {
  const name = VALUE_TYPES.get(byte);
  if (name === undefined)
    throw new WasmDecodeError(
      at,
      `Value type 0x${byte.toString(16)} belongs to a proposal this reader does not decode.`,
      "typed-function-references",
    );
  return name;
};

const blockType = (reader: ByteReader): string => {
  const at = reader.offset;
  const first = reader.bytes[at];
  if (first === 0x40) {
    reader.u8();
    return "";
  }
  if (first !== undefined && VALUE_TYPES.has(first)) {
    reader.u8();
    return `(result ${valueType(first, at)})`;
  }
  if (first !== undefined && (first & 0xc0) === 0x40)
    // Any other negative single byte is a value type outside this profile.
    throw new WasmDecodeError(
      at,
      `Block type 0x${first.toString(16)} belongs to a proposal this reader does not decode.`,
      "typed-function-references",
    );
  const index = reader.s33("block type index");
  if (index < 0) throw new WasmDecodeError(at, "Block type index is negative.");
  return `(type ${String(index)})`;
};

const floatText = (bits: number[], width: 32 | 64): string => {
  const view = new DataView(new Uint8Array(bits).buffer);
  const value =
    width === 32 ? view.getFloat32(0, true) : view.getFloat64(0, true);
  if (Number.isNaN(value)) {
    const raw =
      width === 32
        ? BigInt(view.getUint32(0, true))
        : view.getBigUint64(0, true);
    const mantissa = width === 32 ? raw & 0x7fffffn : raw & 0xfffffffffffffn;
    const sign = width === 32 ? raw >> 31n : raw >> 63n;
    return `${sign === 1n ? "-" : ""}nan:0x${mantissa.toString(16)}`;
  }
  if (!Number.isFinite(value)) return value > 0 ? "inf" : "-inf";
  if (Object.is(value, -0)) return "-0";
  return String(value);
};

const empty = {
  func: null,
  indirect: null,
  constant: null,
  global: null,
} as const;

/** Read one instruction's immediates; returns its WAT text and indices. */
const immediates = (
  info: OpcodeInfo,
  reader: ByteReader,
): Omit<DecodedInstruction, "offset" | "size" | "depth" | "name"> => {
  switch (info.immediate) {
    case "none":
      return { immediates: "", ...empty };
    case "block":
      return { immediates: blockType(reader), ...empty };
    case "label":
      return { immediates: String(reader.u32("label index")), ...empty };
    case "br_table": {
      const count = reader.count("br_table label");
      const labels: number[] = [];
      for (let index = 0; index <= count; index += 1)
        labels.push(reader.u32("label index"));
      return { immediates: labels.join(" "), ...empty };
    }
    case "func": {
      const func = reader.u32("function index");
      return { immediates: String(func), ...empty, func };
    }
    case "call_indirect": {
      const type = reader.u32("type index");
      const tableAt = reader.offset;
      const tableIndex = reader.u32("table index");
      if (tableAt === reader.offset)
        throw new WasmDecodeError(tableAt, "Missing table index.");
      return {
        immediates:
          tableIndex === 0
            ? `(type ${String(type)})`
            : `${String(tableIndex)} (type ${String(type)})`,
        ...empty,
        indirect: { type, table: tableIndex },
      };
    }
    case "select_types": {
      const count = reader.count("select type");
      const types: string[] = [];
      for (let index = 0; index < count; index += 1) {
        const at = reader.offset;
        types.push(valueType(reader.u8("value type"), at));
      }
      return { immediates: `(result ${types.join(" ")})`, ...empty };
    }
    case "local":
      return { immediates: String(reader.u32("local index")), ...empty };
    case "global": {
      const global = reader.u32("global index");
      return { immediates: String(global), ...empty, global };
    }
    case "table":
      return { immediates: String(reader.u32("table index")), ...empty };
    case "memarg": {
      const at = reader.offset;
      const align = reader.u32("alignment");
      if (align >= 0x40)
        throw new WasmDecodeError(
          at,
          "Memory argument names a memory index (multi-memory), which this reader does not decode.",
          "multi-memory",
        );
      const offset = reader.u32("memory offset");
      const parts: string[] = [];
      if (offset !== 0) parts.push(`offset=${String(offset)}`);
      if (align !== naturalAlignment(info.name))
        parts.push(`align=${String(2 ** align)}`);
      return { immediates: parts.join(" "), ...empty };
    }
    case "memory": {
      const at = reader.offset;
      if (reader.u8("memory index") !== 0)
        throw new WasmDecodeError(
          at,
          "A non-zero memory index (multi-memory) is not decoded by this reader.",
          "multi-memory",
        );
      return { immediates: "", ...empty };
    }
    case "i32": {
      const constant = BigInt(reader.s32("i32 constant"));
      return { immediates: String(constant), ...empty, constant };
    }
    case "i64": {
      const constant = reader.s64("i64 constant");
      return { immediates: String(constant), ...empty, constant };
    }
    case "f32":
      return {
        immediates: floatText([...reader.take(4, "f32 constant")], 32),
        ...empty,
      };
    case "f64":
      return {
        immediates: floatText([...reader.take(8, "f64 constant")], 64),
        ...empty,
      };
    case "ref_type": {
      const at = reader.offset;
      const type = REFERENCE_TYPES.get(reader.u8("reference type"));
      if (type === undefined)
        throw new WasmDecodeError(
          at,
          "Heap type belongs to a proposal this reader does not decode.",
          "typed-function-references",
        );
      return { immediates: type === "funcref" ? "func" : "extern", ...empty };
    }
    case "data_memory": {
      const data = reader.u32("data index");
      const at = reader.offset;
      if (reader.u8("memory index") !== 0)
        throw new WasmDecodeError(
          at,
          "A non-zero memory index (multi-memory) is not decoded by this reader.",
          "multi-memory",
        );
      return { immediates: String(data), ...empty };
    }
    case "data":
      return { immediates: String(reader.u32("data index")), ...empty };
    case "memory_memory": {
      const at = reader.offset;
      if (reader.u8("memory index") !== 0 || reader.u8("memory index") !== 0)
        throw new WasmDecodeError(
          at,
          "A non-zero memory index (multi-memory) is not decoded by this reader.",
          "multi-memory",
        );
      return { immediates: "", ...empty };
    }
    case "elem_table": {
      const elem = reader.u32("element index");
      const tableIndex = reader.u32("table index");
      return {
        immediates:
          tableIndex === 0
            ? String(elem)
            : `${String(tableIndex)} ${String(elem)}`,
        ...empty,
      };
    }
    case "elem":
      return { immediates: String(reader.u32("element index")), ...empty };
    case "table_table": {
      const destination = reader.u32("table index");
      const source = reader.u32("table index");
      return {
        immediates:
          destination === 0 && source === 0
            ? ""
            : `${String(destination)} ${String(source)}`,
        ...empty,
      };
    }
  }
};

/**
 * Decode an expression from the reader's position to its final `end`,
 * calling the visitor for every instruction in order. Returns the offset just
 * past that `end`. Stops at the first opcode outside the decoded profile with
 * a {@link WasmDecodeError} naming the proposal and offset.
 */
export const decodeExpression = (
  reader: ByteReader,
  visitor: DecodeVisitor,
): number => {
  let depth = 0;
  for (;;) {
    const offset = reader.offset;
    const byte = reader.u8("opcode");
    let info: OpcodeInfo | undefined;
    if (byte === 0xfc) {
      const sub = reader.u32("prefixed opcode");
      info = prefixedOpcodeInfo(sub);
      if (info === undefined)
        throw new WasmDecodeError(
          offset,
          `Unknown opcode 0xfc ${String(sub)}.`,
        );
    } else {
      info = opcodeInfo(byte);
      if (info === undefined) {
        const proposal = unsupportedProposal(byte);
        throw new WasmDecodeError(
          offset,
          proposal === null
            ? `Unknown opcode 0x${byte.toString(16).padStart(2, "0")}.`
            : `Opcode 0x${byte.toString(16).padStart(2, "0")} belongs to the ${proposal} proposal, which this reader does not decode.`,
          proposal,
        );
      }
    }
    const shown =
      info.name === "end" || info.name === "else" ? depth - 1 : depth;
    if (shown < 0 && info.name === "else")
      throw new WasmDecodeError(offset, "`else` outside an `if` block.");
    const decoded = immediates(info, reader);
    visitor.instruction({
      offset,
      size: reader.offset - offset,
      depth: Math.max(shown, 0),
      name: info.name,
      ...decoded,
    });
    if (info.immediate === "block") depth += 1;
    else if (info.name === "end") {
      if (depth === 0) return reader.offset;
      depth -= 1;
    }
  }
};

/** Collect a short constant expression (offsets, global initializers). */
export const decodeConstantExpression = (
  reader: ByteReader,
): {
  readonly text: string;
  readonly value: bigint | null;
  readonly global: number | null;
  readonly func: number | null;
} => {
  const parts: DecodedInstruction[] = [];
  decodeExpression(reader, {
    instruction: (instruction) => {
      if (instruction.name !== "end") parts.push(instruction);
      if (parts.length > 64)
        throw new WasmDecodeError(
          instruction.offset,
          "Constant expression is longer than 64 instructions.",
        );
    },
  });

  const only = parts.length === 1 ? parts[0] : undefined;
  return {
    text: parts
      .map((part) =>
        part.immediates === "" ? part.name : `${part.name} ${part.immediates}`,
      )
      .join(" "),
    value: only?.constant ?? null,
    global: only?.global ?? null,
    func: only?.name === "ref.func" ? only.func : null,
  };
};
