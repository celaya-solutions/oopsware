/**
 * The 256 Dalvik opcodes with dexdump's mnemonics, formats and index kinds,
 * as ART's `dex_instruction_list.h` defines them.
 */

/** Instruction formats of the Dalvik bytecode reference ("Instruction formats"). */
export type DalvikFormat =
  | "10x"
  | "12x"
  | "11n"
  | "11x"
  | "10t"
  | "20t"
  | "22x"
  | "21t"
  | "21s"
  | "21h"
  | "21c"
  | "23x"
  | "22b"
  | "22t"
  | "22s"
  | "22c"
  | "30t"
  | "32x"
  | "31i"
  | "31t"
  | "31c"
  | "35c"
  | "3rc"
  | "45cc"
  | "4rcc"
  | "51l";

/** What the index operand names; `method_and_proto` is invoke-polymorphic's method@BBBB, proto@HHHH. */
export type DalvikIndexKind =
  | "none"
  | "string"
  | "type"
  | "field"
  | "method"
  | "proto"
  | "call_site"
  | "method_handle"
  | "method_and_proto";

export type DalvikInvokeKind =
  | "virtual"
  | "super"
  | "direct"
  | "static"
  | "interface"
  | "polymorphic"
  | "custom";

export type DalvikTypeUse =
  | "new-instance"
  | "new-array"
  | "filled-new-array"
  | "check-cast"
  | "instance-of"
  | "const-class";

export interface DalvikFieldAccess {
  readonly access: "read" | "write";
  readonly static: boolean;
}

export interface DalvikOpcode {
  readonly code: number;
  readonly name: string;
  readonly format: DalvikFormat;
  /** Width in 16-bit code units; a nop whose unit is a payload identifier is sized by its payload. */
  readonly units: number;
  readonly index: DalvikIndexKind;
  /** No defined meaning (0x3e-0x43, 0x73, 0x79-0x7a, 0xe3-0xf9): format 10x, and dexdump prints the name alone. */
  readonly unused: boolean;
  readonly invoke: DalvikInvokeKind | null;
  readonly field: DalvikFieldAccess | null;
  readonly type_use: DalvikTypeUse | null;
}

export const FORMAT_UNITS: Readonly<Record<DalvikFormat, number>> = {
  "10x": 1,
  "12x": 1,
  "11n": 1,
  "11x": 1,
  "10t": 1,
  "20t": 2,
  "22x": 2,
  "21t": 2,
  "21s": 2,
  "21h": 2,
  "21c": 2,
  "23x": 2,
  "22b": 2,
  "22t": 2,
  "22s": 2,
  "22c": 2,
  "30t": 3,
  "32x": 3,
  "31i": 3,
  "31t": 3,
  "31c": 3,
  "35c": 3,
  "3rc": 3,
  "45cc": 4,
  "4rcc": 4,
  "51l": 5,
};

/** First code unit of the payload pseudo-instructions (a nop with a non-zero high byte). */
export const PACKED_SWITCH_PAYLOAD = 0x0100;
export const SPARSE_SWITCH_PAYLOAD = 0x0200;
export const ARRAY_DATA_PAYLOAD = 0x0300;

interface Extra {
  readonly index?: DalvikIndexKind;
  readonly invoke?: DalvikInvokeKind;
  readonly field?: DalvikFieldAccess;
  readonly type_use?: DalvikTypeUse;
}

const table: DalvikOpcode[] = [];
const op = (
  code: number,
  name: string,
  format: DalvikFormat,
  extra: Extra = {},
) => {
  table[code] = {
    code,
    name,
    format,
    units: FORMAT_UNITS[format],
    index: extra.index ?? "none",
    unused: false,
    invoke: extra.invoke ?? null,
    field: extra.field ?? null,
    type_use: extra.type_use ?? null,
  };
};
const run = (
  start: number,
  format: DalvikFormat,
  names: readonly string[],
  extra: (offset: number) => Extra = () => ({}),
) =>
  names.forEach((name, offset) =>
    op(start + offset, name, format, extra(offset)),
  );

const TYPES = ["", "-wide", "-object", "-boolean", "-byte", "-char", "-short"];

op(0x00, "nop", "10x");
run(0x01, "12x", ["move"]);
run(0x02, "22x", ["move/from16"]);
run(0x03, "32x", ["move/16"]);
run(0x04, "12x", ["move-wide"]);
run(0x05, "22x", ["move-wide/from16"]);
run(0x06, "32x", ["move-wide/16"]);
run(0x07, "12x", ["move-object"]);
run(0x08, "22x", ["move-object/from16"]);
run(0x09, "32x", ["move-object/16"]);
run(0x0a, "11x", [
  "move-result",
  "move-result-wide",
  "move-result-object",
  "move-exception",
]);
op(0x0e, "return-void", "10x");
run(0x0f, "11x", ["return", "return-wide", "return-object"]);
op(0x12, "const/4", "11n");
op(0x13, "const/16", "21s");
op(0x14, "const", "31i");
op(0x15, "const/high16", "21h");
op(0x16, "const-wide/16", "21s");
op(0x17, "const-wide/32", "31i");
op(0x18, "const-wide", "51l");
op(0x19, "const-wide/high16", "21h");
op(0x1a, "const-string", "21c", { index: "string" });
op(0x1b, "const-string/jumbo", "31c", { index: "string" });
op(0x1c, "const-class", "21c", { index: "type", type_use: "const-class" });
run(0x1d, "11x", ["monitor-enter", "monitor-exit"]);
op(0x1f, "check-cast", "21c", { index: "type", type_use: "check-cast" });
op(0x20, "instance-of", "22c", { index: "type", type_use: "instance-of" });
op(0x21, "array-length", "12x");
op(0x22, "new-instance", "21c", { index: "type", type_use: "new-instance" });
op(0x23, "new-array", "22c", { index: "type", type_use: "new-array" });
op(0x24, "filled-new-array", "35c", {
  index: "type",
  type_use: "filled-new-array",
});
op(0x25, "filled-new-array/range", "3rc", {
  index: "type",
  type_use: "filled-new-array",
});
op(0x26, "fill-array-data", "31t");
op(0x27, "throw", "11x");
op(0x28, "goto", "10t");
op(0x29, "goto/16", "20t");
op(0x2a, "goto/32", "30t");
run(0x2b, "31t", ["packed-switch", "sparse-switch"]);
run(0x2d, "23x", [
  "cmpl-float",
  "cmpg-float",
  "cmpl-double",
  "cmpg-double",
  "cmp-long",
]);
const CONDITIONS = ["eq", "ne", "lt", "ge", "gt", "le"];
run(
  0x32,
  "22t",
  CONDITIONS.map((name) => `if-${name}`),
);
run(
  0x38,
  "21t",
  CONDITIONS.map((name) => `if-${name}z`),
);
run(0x44, "23x", [
  ...TYPES.map((type) => `aget${type}`),
  ...TYPES.map((type) => `aput${type}`),
]);
run(
  0x52,
  "22c",
  [
    ...TYPES.map((type) => `iget${type}`),
    ...TYPES.map((type) => `iput${type}`),
  ],
  (offset) => ({
    index: "field",
    field: { access: offset < 7 ? "read" : "write", static: false },
  }),
);
run(
  0x60,
  "21c",
  [
    ...TYPES.map((type) => `sget${type}`),
    ...TYPES.map((type) => `sput${type}`),
  ],
  (offset) => ({
    index: "field",
    field: { access: offset < 7 ? "read" : "write", static: true },
  }),
);
const INVOKES = ["virtual", "super", "direct", "static", "interface"] as const;
INVOKES.forEach((kind, offset) => {
  op(0x6e + offset, `invoke-${kind}`, "35c", { index: "method", invoke: kind });
  op(0x74 + offset, `invoke-${kind}/range`, "3rc", {
    index: "method",
    invoke: kind,
  });
});
run(0x7b, "12x", [
  "neg-int",
  "not-int",
  "neg-long",
  "not-long",
  "neg-float",
  "neg-double",
  "int-to-long",
  "int-to-float",
  "int-to-double",
  "long-to-int",
  "long-to-float",
  "long-to-double",
  "float-to-int",
  "float-to-long",
  "float-to-double",
  "double-to-int",
  "double-to-long",
  "double-to-float",
  "int-to-byte",
  "int-to-char",
  "int-to-short",
]);
const INTEGRAL = [
  "add",
  "sub",
  "mul",
  "div",
  "rem",
  "and",
  "or",
  "xor",
  "shl",
  "shr",
  "ushr",
];
const FLOATING = ["add", "sub", "mul", "div", "rem"];
const BINARY = [
  ...INTEGRAL.map((name) => `${name}-int`),
  ...INTEGRAL.map((name) => `${name}-long`),
  ...FLOATING.map((name) => `${name}-float`),
  ...FLOATING.map((name) => `${name}-double`),
];
run(0x90, "23x", BINARY);
run(
  0xb0,
  "12x",
  BINARY.map((name) => `${name}/2addr`),
);
const LITERAL = ["add", "rsub", "mul", "div", "rem", "and", "or", "xor"];
run(
  0xd0,
  "22s",
  LITERAL.map((name) => (name === "rsub" ? "rsub-int" : `${name}-int/lit16`)),
);
run(0xd8, "22b", [
  ...LITERAL.map((name) => `${name}-int/lit8`),
  "shl-int/lit8",
  "shr-int/lit8",
  "ushr-int/lit8",
]);
op(0xfa, "invoke-polymorphic", "45cc", {
  index: "method_and_proto",
  invoke: "polymorphic",
});
op(0xfb, "invoke-polymorphic/range", "4rcc", {
  index: "method_and_proto",
  invoke: "polymorphic",
});
op(0xfc, "invoke-custom", "35c", { index: "call_site", invoke: "custom" });
op(0xfd, "invoke-custom/range", "3rc", {
  index: "call_site",
  invoke: "custom",
});
op(0xfe, "const-method-handle", "21c", { index: "method_handle" });
op(0xff, "const-method-type", "21c", { index: "proto" });

for (let code = 0; code < 0x100; code += 1)
  table[code] ??= {
    code,
    name: `unused-${code.toString(16).padStart(2, "0")}`,
    format: "10x",
    units: 1,
    index: "none",
    unused: true,
    invoke: null,
    field: null,
    type_use: null,
  };

/** All 256 opcodes in code order. */
export const DALVIK_OPCODES: readonly DalvikOpcode[] = table;

export const dalvikOpcode = (code: number): DalvikOpcode => {
  const entry = table[code & 0xff];
  if (entry === undefined)
    throw new RangeError(`No opcode 0x${code.toString(16)}.`);
  return entry;
};
