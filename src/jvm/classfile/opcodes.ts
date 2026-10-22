/** How the bytes after an opcode are laid out (JVMS 6.5). */
export type OperandKind =
  | "none"
  | "s1"
  | "s2"
  | "cp1"
  | "cp2"
  | "local"
  | "iinc"
  | "branch2"
  | "branch4"
  | "tableswitch"
  | "lookupswitch"
  | "invokeinterface"
  | "invokedynamic"
  | "newarray"
  | "multianewarray"
  | "wide";

/** What a constant-pool operand names, for reference extraction. */
export type OperandRole =
  | "constant"
  | "field"
  | "method"
  | "class"
  | "dynamic"
  | null;

export interface Opcode {
  readonly code: number;
  readonly name: string;
  readonly operands: OperandKind;
  readonly role: OperandRole;
}

const table: Opcode[] = [];
const op = (
  code: number,
  name: string,
  operands: OperandKind = "none",
  role: OperandRole = null,
) => {
  table[code] = { code, name, operands, role };
};

const NONE = [
  "nop",
  "aconst_null",
  "iconst_m1",
  "iconst_0",
  "iconst_1",
  "iconst_2",
  "iconst_3",
  "iconst_4",
  "iconst_5",
  "lconst_0",
  "lconst_1",
  "fconst_0",
  "fconst_1",
  "fconst_2",
  "dconst_0",
  "dconst_1",
];
NONE.forEach((name, code) => op(code, name));
op(16, "bipush", "s1");
op(17, "sipush", "s2");
op(18, "ldc", "cp1", "constant");
op(19, "ldc_w", "cp2", "constant");
op(20, "ldc2_w", "cp2", "constant");
["iload", "lload", "fload", "dload", "aload"].forEach((name, index) =>
  op(21 + index, name, "local"),
);
["i", "l", "f", "d", "a"].forEach((prefix, type) => {
  for (let slot = 0; slot < 4; slot += 1)
    op(26 + type * 4 + slot, `${prefix}load_${String(slot)}`);
});
[
  "iaload",
  "laload",
  "faload",
  "daload",
  "aaload",
  "baload",
  "caload",
  "saload",
].forEach((name, index) => op(46 + index, name));
["istore", "lstore", "fstore", "dstore", "astore"].forEach((name, index) =>
  op(54 + index, name, "local"),
);
["i", "l", "f", "d", "a"].forEach((prefix, type) => {
  for (let slot = 0; slot < 4; slot += 1)
    op(59 + type * 4 + slot, `${prefix}store_${String(slot)}`);
});
[
  "iastore",
  "lastore",
  "fastore",
  "dastore",
  "aastore",
  "bastore",
  "castore",
  "sastore",
  "pop",
  "pop2",
  "dup",
  "dup_x1",
  "dup_x2",
  "dup2",
  "dup2_x1",
  "dup2_x2",
  "swap",
  "iadd",
  "ladd",
  "fadd",
  "dadd",
  "isub",
  "lsub",
  "fsub",
  "dsub",
  "imul",
  "lmul",
  "fmul",
  "dmul",
  "idiv",
  "ldiv",
  "fdiv",
  "ddiv",
  "irem",
  "lrem",
  "frem",
  "drem",
  "ineg",
  "lneg",
  "fneg",
  "dneg",
  "ishl",
  "lshl",
  "ishr",
  "lshr",
  "iushr",
  "lushr",
  "iand",
  "land",
  "ior",
  "lor",
  "ixor",
  "lxor",
].forEach((name, index) => op(79 + index, name));
op(132, "iinc", "iinc");
[
  "i2l",
  "i2f",
  "i2d",
  "l2i",
  "l2f",
  "l2d",
  "f2i",
  "f2l",
  "f2d",
  "d2i",
  "d2l",
  "d2f",
  "i2b",
  "i2c",
  "i2s",
  "lcmp",
  "fcmpl",
  "fcmpg",
  "dcmpl",
  "dcmpg",
].forEach((name, index) => op(133 + index, name));
[
  "ifeq",
  "ifne",
  "iflt",
  "ifge",
  "ifgt",
  "ifle",
  "if_icmpeq",
  "if_icmpne",
  "if_icmplt",
  "if_icmpge",
  "if_icmpgt",
  "if_icmple",
  "if_acmpeq",
  "if_acmpne",
  "goto",
  "jsr",
].forEach((name, index) => op(153 + index, name, "branch2"));
op(169, "ret", "local");
op(170, "tableswitch", "tableswitch");
op(171, "lookupswitch", "lookupswitch");
["ireturn", "lreturn", "freturn", "dreturn", "areturn", "return"].forEach(
  (name, index) => op(172 + index, name),
);
["getstatic", "putstatic", "getfield", "putfield"].forEach((name, index) =>
  op(178 + index, name, "cp2", "field"),
);
["invokevirtual", "invokespecial", "invokestatic"].forEach((name, index) =>
  op(182 + index, name, "cp2", "method"),
);
op(185, "invokeinterface", "invokeinterface", "method");
op(186, "invokedynamic", "invokedynamic", "dynamic");
op(187, "new", "cp2", "class");
op(188, "newarray", "newarray");
op(189, "anewarray", "cp2", "class");
op(190, "arraylength");
op(191, "athrow");
op(192, "checkcast", "cp2", "class");
op(193, "instanceof", "cp2", "class");
op(194, "monitorenter");
op(195, "monitorexit");
op(196, "wide", "wide");
op(197, "multianewarray", "multianewarray", "class");
op(198, "ifnull", "branch2");
op(199, "ifnonnull", "branch2");
op(200, "goto_w", "branch4");
op(201, "jsr_w", "branch4");

export const opcodeInfo = (code: number): Opcode | null => table[code] ?? null;

/** Every defined opcode; reserved 0xca, 0xfe and 0xff are not valid in class files. */
export const OPCODES: readonly Opcode[] = table.filter(
  (entry): entry is Opcode => entry !== undefined,
);

/** newarray element types (JVMS 6.5 newarray). */
export const ARRAY_TYPES: Readonly<Record<number, string>> = {
  4: "boolean",
  5: "char",
  6: "float",
  7: "double",
  8: "byte",
  9: "short",
  10: "int",
  11: "long",
};
