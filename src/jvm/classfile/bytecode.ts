import { ClassFormatError, ClassReader } from "./ClassReader.js";
import type { ConstantPool } from "./constantPool.js";
import { ARRAY_TYPES, opcodeInfo, type Opcode } from "./opcodes.js";
import { TextBudget } from "./textBudget.js";

export interface Instruction {
  readonly index: number;
  /** Offset from the start of the method's code array (javap's left column). */
  readonly pc: number;
  /** Byte offset of the opcode in the class file. */
  readonly offset: number;
  readonly size: number;
  readonly opcode: Opcode;
  /** The instruction a `wide` prefix modifies, so `op` names what runs. */
  readonly wide: boolean;
  readonly cp: number | null;
  /** Absolute pcs this instruction may jump to (branches and switch arms, default last). */
  readonly targets: readonly number[];
  readonly local: number | null;
  readonly operands: string;
}

export interface DecodedCode {
  readonly instructions: readonly Instruction[];
  /** Where and why decoding stopped before the end of the code array. */
  readonly stopped: {
    readonly offset: number;
    readonly message: string;
  } | null;
  readonly problems: readonly { offset: number; message: string }[];
}

/** javap's comment text for a constant-pool operand. */
const describeConstant = (pool: ConstantPool, index: number): string => {
  const entry = pool.get(index);
  switch (entry?.tag) {
    case "Fieldref":
      return `Field ${pool.memberText(pool.member(index))}`;
    case "Methodref":
      return `Method ${pool.memberText(pool.member(index))}`;
    case "InterfaceMethodref":
      return `InterfaceMethod ${pool.memberText(pool.member(index))}`;
    case "Class":
      return `class ${pool.className(index) ?? "?"}`;
    case "InvokeDynamic": {
      const nat = pool.nameAndType(entry.nameAndType);
      return `InvokeDynamic #${String(entry.bootstrap)}:${nat?.name ?? "?"}:${nat?.descriptor ?? "?"}`;
    }
    case undefined:
      return "invalid constant";
    default: {
      const loaded = pool.constantText(index);
      return loaded === null
        ? (entry?.tag ?? "?")
        : `${loaded.kind} ${loaded.value}`;
    }
  }
};

const withComment = (
  pool: ConstantPool,
  index: number,
  prefix: string,
  budget: TextBudget,
) => `${prefix} // ${budget.take(describeConstant(pool, index))}`;

/**
 * Decode one method's code array without interpreting it. Offsets are exact;
 * an undefined opcode or truncated operand stops decoding at that byte and
 * keeps every instruction read before it.
 */
export const decodeBytecode = (
  bytes: Uint8Array,
  codeOffset: number,
  codeLength: number,
  pool: ConstantPool,
  budget = new TextBudget(),
): DecodedCode => {
  const reader = new ClassReader(bytes, codeOffset, codeOffset + codeLength);
  const instructions: Instruction[] = [];
  const problems: { offset: number; message: string }[] = [];
  let stopped: DecodedCode["stopped"] = null;
  while (reader.remaining > 0) {
    const offset = reader.offset;
    const pc = offset - codeOffset;
    try {
      let opcode = opcodeInfo(reader.u1("opcode"));
      if (opcode === null)
        throw new ClassFormatError(
          offset,
          `Byte 0x${(bytes[offset] ?? 0).toString(16).padStart(2, "0")} at pc ${String(pc)} is not a defined opcode.`,
        );
      let wide = false;
      let cp: number | null = null;
      let targets: number[] = [];
      let local: number | null = null;
      let operands = "";
      if (opcode.operands === "wide") {
        const inner = opcodeInfo(reader.u1("wide opcode"));
        if (
          inner === null ||
          (inner.operands !== "local" && inner.operands !== "iinc")
        )
          throw new ClassFormatError(
            offset + 1,
            `wide at pc ${String(pc)} modifies an opcode that does not take a local variable index.`,
          );
        opcode = inner;
        wide = true;
      }
      switch (opcode.operands) {
        case "none":
          break;
        case "s1":
          operands = String(reader.s1());
          break;
        case "s2":
          operands = String(reader.s2());
          break;
        case "cp1":
          cp = reader.u1();
          operands = withComment(pool, cp, `#${String(cp)}`, budget);
          break;
        case "cp2":
          cp = reader.u2();
          operands = withComment(pool, cp, `#${String(cp)}`, budget);
          break;
        case "local":
          local = wide ? reader.u2() : reader.u1();
          operands = String(local);
          break;
        case "iinc": {
          local = wide ? reader.u2() : reader.u1();
          const delta = wide ? reader.s2() : reader.s1();
          operands = `${String(local)}, ${String(delta)}`;
          break;
        }
        case "branch2":
          targets = [pc + reader.s2()];
          operands = String(targets[0]);
          break;
        case "branch4":
          targets = [pc + reader.s4()];
          operands = String(targets[0]);
          break;
        case "tableswitch": {
          reader.skipTo(codeOffset + ((pc + 4) & ~3));
          const fallback = pc + reader.s4("default");
          const low = reader.s4("low");
          const high = reader.s4("high");
          if (high < low)
            throw new ClassFormatError(
              offset,
              `tableswitch at pc ${String(pc)} has high < low.`,
            );
          const count = high - low + 1;
          if (count * 4 > reader.remaining)
            throw new ClassFormatError(
              offset,
              `tableswitch at pc ${String(pc)} declares ${String(count)} arms past the code end.`,
            );
          const arms: string[] = [];
          for (let key = low; key <= high; key += 1) {
            const target = pc + reader.s4();
            targets.push(target);
            arms.push(`${String(key)}: ${String(target)}`);
          }
          targets.push(fallback);
          operands = `{ ${[...arms, `default: ${String(fallback)}`].join(", ")} }`;
          break;
        }
        case "lookupswitch": {
          reader.skipTo(codeOffset + ((pc + 4) & ~3));
          const fallback = pc + reader.s4("default");
          const pairs = reader.s4("npairs");
          if (pairs < 0 || pairs * 8 > reader.remaining)
            throw new ClassFormatError(
              offset,
              `lookupswitch at pc ${String(pc)} declares an impossible ${String(pairs)} pairs.`,
            );
          const arms: string[] = [];
          let previous: number | null = null;
          for (let pair = 0; pair < pairs; pair += 1) {
            const key = reader.s4();
            const target = pc + reader.s4();
            if (previous !== null && key <= previous)
              problems.push({
                offset,
                message: `lookupswitch at pc ${String(pc)} keys are not sorted ascending.`,
              });
            previous = key;
            targets.push(target);
            arms.push(`${String(key)}: ${String(target)}`);
          }
          targets.push(fallback);
          operands = `{ ${[...arms, `default: ${String(fallback)}`].join(", ")} }`;
          break;
        }
        case "invokeinterface": {
          cp = reader.u2();
          const count = reader.u1();
          if (reader.u1() !== 0)
            problems.push({
              offset,
              message: `invokeinterface at pc ${String(pc)} has a non-zero fourth operand byte.`,
            });
          operands = withComment(
            pool,
            cp,
            `#${String(cp)}, ${String(count)}`,
            budget,
          );
          break;
        }
        case "invokedynamic":
          cp = reader.u2();
          if (reader.u2() !== 0)
            problems.push({
              offset,
              message: `invokedynamic at pc ${String(pc)} has non-zero reserved operand bytes.`,
            });
          operands = withComment(pool, cp, `#${String(cp)}, 0`, budget);
          break;
        case "newarray": {
          const type = reader.u1();
          operands = ARRAY_TYPES[type] ?? `unknown(${String(type)})`;
          if (ARRAY_TYPES[type] === undefined)
            problems.push({
              offset,
              message: `newarray at pc ${String(pc)} has unknown element type ${String(type)}.`,
            });
          break;
        }
        case "multianewarray": {
          cp = reader.u2();
          const dimensions = reader.u1();
          operands = withComment(
            pool,
            cp,
            `#${String(cp)}, ${String(dimensions)}`,
            budget,
          );
          break;
        }
        case "wide":
          break;
      }
      instructions.push({
        index: instructions.length,
        pc,
        offset,
        size: reader.offset - offset,
        opcode,
        wide,
        cp,
        targets,
        local,
        operands,
      });
    } catch (cause) {
      if (!(cause instanceof ClassFormatError)) throw cause;
      stopped = { offset: cause.offset, message: cause.message };
      break;
    }
  }
  const starts = new Set(instructions.map((instruction) => instruction.pc));
  if (stopped === null)
    for (const instruction of instructions)
      for (const target of instruction.targets)
        if (!starts.has(target))
          problems.push({
            offset: instruction.offset,
            message: `${instruction.opcode.name} at pc ${String(instruction.pc)} jumps to pc ${String(target)}, which is not an instruction start.`,
          });
  return { instructions, stopped, problems };
};
