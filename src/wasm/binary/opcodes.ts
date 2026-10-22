/**
 * Opcode table of the instruction profile this reader decodes: WebAssembly
 * 2.0 without SIMD (MVP, sign extension, non-trapping float-to-int, bulk
 * memory, reference types, multi-value) plus tail calls. Opcodes of other
 * proposals are named so a decode can stop with an explicit reason instead of
 * guessing at their immediates.
 */

export type Immediate =
  | "none"
  | "block"
  | "label"
  | "br_table"
  | "func"
  | "call_indirect"
  | "select_types"
  | "local"
  | "global"
  | "table"
  | "memarg"
  | "memory"
  | "i32"
  | "i64"
  | "f32"
  | "f64"
  | "ref_type"
  | "data_memory"
  | "data"
  | "memory_memory"
  | "elem_table"
  | "elem"
  | "table_table";

export interface OpcodeInfo {
  readonly name: string;
  readonly immediate: Immediate;
}

const op = (name: string, immediate: Immediate = "none"): OpcodeInfo => ({
  name,
  immediate,
});

const MEMORY = [
  "i32.load",
  "i64.load",
  "f32.load",
  "f64.load",
  "i32.load8_s",
  "i32.load8_u",
  "i32.load16_s",
  "i32.load16_u",
  "i64.load8_s",
  "i64.load8_u",
  "i64.load16_s",
  "i64.load16_u",
  "i64.load32_s",
  "i64.load32_u",
  "i32.store",
  "i64.store",
  "f32.store",
  "f64.store",
  "i32.store8",
  "i32.store16",
  "i64.store8",
  "i64.store16",
  "i64.store32",
] as const;

/** Opcodes 0x45 through 0xC4 in order; none takes an immediate. */
const NUMERIC =
  `i32.eqz i32.eq i32.ne i32.lt_s i32.lt_u i32.gt_s i32.gt_u i32.le_s i32.le_u i32.ge_s i32.ge_u
i64.eqz i64.eq i64.ne i64.lt_s i64.lt_u i64.gt_s i64.gt_u i64.le_s i64.le_u i64.ge_s i64.ge_u
f32.eq f32.ne f32.lt f32.gt f32.le f32.ge
f64.eq f64.ne f64.lt f64.gt f64.le f64.ge
i32.clz i32.ctz i32.popcnt i32.add i32.sub i32.mul i32.div_s i32.div_u i32.rem_s i32.rem_u i32.and i32.or i32.xor i32.shl i32.shr_s i32.shr_u i32.rotl i32.rotr
i64.clz i64.ctz i64.popcnt i64.add i64.sub i64.mul i64.div_s i64.div_u i64.rem_s i64.rem_u i64.and i64.or i64.xor i64.shl i64.shr_s i64.shr_u i64.rotl i64.rotr
f32.abs f32.neg f32.ceil f32.floor f32.trunc f32.nearest f32.sqrt f32.add f32.sub f32.mul f32.div f32.min f32.max f32.copysign
f64.abs f64.neg f64.ceil f64.floor f64.trunc f64.nearest f64.sqrt f64.add f64.sub f64.mul f64.div f64.min f64.max f64.copysign
i32.wrap_i64 i32.trunc_f32_s i32.trunc_f32_u i32.trunc_f64_s i32.trunc_f64_u i64.extend_i32_s i64.extend_i32_u i64.trunc_f32_s i64.trunc_f32_u i64.trunc_f64_s i64.trunc_f64_u
f32.convert_i32_s f32.convert_i32_u f32.convert_i64_s f32.convert_i64_u f32.demote_f64 f64.convert_i32_s f64.convert_i32_u f64.convert_i64_s f64.convert_i64_u f64.promote_f32
i32.reinterpret_f32 i64.reinterpret_f64 f32.reinterpret_i32 f64.reinterpret_i64
i32.extend8_s i32.extend16_s i64.extend8_s i64.extend16_s i64.extend32_s`.split(
    /\s+/u,
  );

const table = new Map<number, OpcodeInfo>([
  [0x00, op("unreachable")],
  [0x01, op("nop")],
  [0x02, op("block", "block")],
  [0x03, op("loop", "block")],
  [0x04, op("if", "block")],
  [0x05, op("else")],
  [0x0b, op("end")],
  [0x0c, op("br", "label")],
  [0x0d, op("br_if", "label")],
  [0x0e, op("br_table", "br_table")],
  [0x0f, op("return")],
  [0x10, op("call", "func")],
  [0x11, op("call_indirect", "call_indirect")],
  [0x12, op("return_call", "func")],
  [0x13, op("return_call_indirect", "call_indirect")],
  [0x1a, op("drop")],
  [0x1b, op("select")],
  [0x1c, op("select", "select_types")],
  [0x20, op("local.get", "local")],
  [0x21, op("local.set", "local")],
  [0x22, op("local.tee", "local")],
  [0x23, op("global.get", "global")],
  [0x24, op("global.set", "global")],
  [0x25, op("table.get", "table")],
  [0x26, op("table.set", "table")],
  ...MEMORY.map((name, index): [number, OpcodeInfo] => [
    0x28 + index,
    op(name, "memarg"),
  ]),
  [0x3f, op("memory.size", "memory")],
  [0x40, op("memory.grow", "memory")],
  [0x41, op("i32.const", "i32")],
  [0x42, op("i64.const", "i64")],
  [0x43, op("f32.const", "f32")],
  [0x44, op("f64.const", "f64")],
  ...NUMERIC.map((name, index): [number, OpcodeInfo] => [
    0x45 + index,
    op(name),
  ]),
  [0xd0, op("ref.null", "ref_type")],
  [0xd1, op("ref.is_null")],
  [0xd2, op("ref.func", "func")],
]);

/** Single-byte opcodes. */
export const opcodeInfo = (byte: number): OpcodeInfo | undefined =>
  table.get(byte);

const PREFIX_FC = new Map<number, OpcodeInfo>([
  [0, op("i32.trunc_sat_f32_s")],
  [1, op("i32.trunc_sat_f32_u")],
  [2, op("i32.trunc_sat_f64_s")],
  [3, op("i32.trunc_sat_f64_u")],
  [4, op("i64.trunc_sat_f32_s")],
  [5, op("i64.trunc_sat_f32_u")],
  [6, op("i64.trunc_sat_f64_s")],
  [7, op("i64.trunc_sat_f64_u")],
  [8, op("memory.init", "data_memory")],
  [9, op("data.drop", "data")],
  [10, op("memory.copy", "memory_memory")],
  [11, op("memory.fill", "memory")],
  [12, op("table.init", "elem_table")],
  [13, op("elem.drop", "elem")],
  [14, op("table.copy", "table_table")],
  [15, op("table.grow", "table")],
  [16, op("table.size", "table")],
  [17, op("table.fill", "table")],
]);

/** Sub-opcodes after the 0xFC prefix. */
export const prefixedOpcodeInfo = (sub: number): OpcodeInfo | undefined =>
  PREFIX_FC.get(sub);

/** Proposal that owns an opcode this reader does not decode, if known. */
export const unsupportedProposal = (byte: number): string | null => {
  if ([0x06, 0x07, 0x08, 0x09, 0x0a, 0x18, 0x19, 0x1f].includes(byte))
    return "exception-handling";
  if ([0x14, 0x15, 0xd3, 0xd4, 0xd5, 0xd6].includes(byte))
    return "typed-function-references";
  if (byte === 0xfb) return "gc";
  if (byte === 0xfd) return "simd";
  if (byte === 0xfe) return "threads";
  return null;
};

/** Value types of the decoded profile, by their binary byte. */
export const VALUE_TYPES: ReadonlyMap<number, string> = new Map([
  [0x7f, "i32"],
  [0x7e, "i64"],
  [0x7d, "f32"],
  [0x7c, "f64"],
  [0x7b, "v128"],
  [0x70, "funcref"],
  [0x6f, "externref"],
]);

export const REFERENCE_TYPES: ReadonlyMap<number, string> = new Map([
  [0x70, "funcref"],
  [0x6f, "externref"],
]);

/** Natural alignment exponent of each memory instruction, for WAT-style printing. */
export const naturalAlignment = (name: string): number => {
  const width = /(8|16|32|64)(_[su])?$/u.exec(name.split(".")[1] ?? "");
  if (width?.[1] !== undefined && /load\d|store\d/u.test(name))
    return Math.log2(Number(width[1]) / 8);
  return name.startsWith("i64") || name.startsWith("f64") ? 3 : 2;
};
