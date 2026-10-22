import type { LineInfo } from "./lineTable.js";
import type { CodeObject, PyValue } from "./marshal.js";
import type { BytecodeProfile } from "./profiles.js";
import { reprValue } from "./repr.js";

/**
 * Instructions of one code object, rendered as the producing release's
 * `dis.get_instructions` renders them: the same names, arguments, jump
 * targets and argument text (labels "L<n>" count jump targets from 3.13).
 * Inline CACHE units are skipped and counted. Nothing is executed; an
 * argument that indexes past its table is reported, not guessed.
 */

export interface Instruction {
  readonly offset: number;
  /** Offset of the first EXTENDED_ARG prefix (3.13+ dis start_offset). */
  readonly startOffset: number;
  readonly opcode: number;
  readonly opname: string;
  readonly arg: number | null;
  /** The name, constant or offset the argument stands for, as text; null when it has none. */
  readonly argval: string | null;
  readonly argrepr: string;
  readonly jumpTarget: number | null;
  readonly cacheUnits: number;
  readonly line: number | null;
  readonly startsLine: boolean;
  readonly column: number | null;
  readonly endLine: number | null;
  readonly endColumn: number | null;
  /** Set when the argument could not be resolved or the opcode is not a base instruction. */
  readonly problem: string | null;
}

export interface Disassembly {
  readonly instructions: Instruction[];
  readonly problems: string[];
}

const INT_OVERFLOW = 2 ** 31;

interface Unpacked {
  readonly offset: number;
  readonly startOffset: number;
  readonly opcode: number;
  readonly arg: number | null;
}

const cacheUnits = (profile: BytecodeProfile, opcode: number) =>
  profile.cache.get(opcode) ?? 0;

/** dis._unpack_opargs for the profile's release. */
const unpack = (code: Uint8Array, profile: BytecodeProfile): Unpacked[] => {
  const extended = profile.opcode.get("EXTENDED_ARG");
  const result: Unpacked[] = [];
  let extendedArg = 0;
  let prefixStart: number | null = null;
  let skip = 0;
  for (let offset = 0; offset + 1 < code.length; offset += 2) {
    if (skip > 0) {
      skip -= 1;
      continue;
    }
    const opcode = code[offset] ?? 0;
    skip = profile.layout === "3.11+" ? cacheUnits(profile, opcode) : 0;
    let arg: number | null;
    if (profile.takesArgument(opcode)) {
      arg = extendedArg + (code[offset + 1] ?? 0);
      extendedArg = opcode === extended ? arg * 256 : 0;
      if (profile.layout === "3.11+" && extendedArg >= INT_OVERFLOW)
        extendedArg -= 2 * INT_OVERFLOW;
    } else {
      arg = null;
      if (profile.layout === "3.11+") extendedArg = 0;
    }
    result.push({
      offset,
      startOffset: prefixStart ?? offset,
      opcode,
      arg,
    });
    prefixStart = opcode === extended ? (prefixStart ?? offset) : null;
  }
  return result;
};

const isBackward = (profile: BytecodeProfile, name: string): boolean => {
  if (profile.rules === "3.11" || profile.rules === "3.12")
    return name.includes("JUMP_BACKWARD");
  return (
    name === "JUMP_BACKWARD" ||
    name === "JUMP_BACKWARD_NO_INTERRUPT" ||
    (name === "END_ASYNC_FOR" &&
      (profile.rules === "3.14" || profile.rules === "3.15"))
  );
};

/** dis._get_jump_target (and the 3.9-3.12 inline equivalents). */
const jumpTarget = (
  profile: BytecodeProfile,
  entry: Unpacked,
): number | null => {
  if (entry.arg === null) return null;
  const name = profile.opname.get(entry.opcode) ?? "";
  if (profile.rules === "3.9") {
    if (profile.has("hasjrel", entry.opcode))
      return entry.offset + 2 + entry.arg;
    if (profile.has("hasjabs", entry.opcode)) return entry.arg;
    return null;
  }
  if (profile.has("hasjrel", entry.opcode)) {
    const signed = isBackward(profile, name) ? -entry.arg : entry.arg;
    const caches =
      profile.rules === "3.11" ? 0 : cacheUnits(profile, entry.opcode);
    return entry.offset + 2 + signed * 2 + caches * 2;
  }
  if (profile.has("hasjabs", entry.opcode)) return entry.arg * 2;
  return null;
};

const flagNames = (names: readonly string[] | null, arg: number) =>
  (names ?? []).filter((_, bit) => (arg & (1 << bit)) !== 0).join(", ");

interface Resolved {
  argval: string | null;
  argrepr: string;
  problem: string | null;
}

const pick = <T>(
  list: readonly T[] | null,
  index: number,
  what: string,
): { value: T } | { problem: string } => {
  const value = list?.[index];
  return value === undefined
    ? { problem: `Argument ${String(index)} is past the end of ${what}.` }
    : { value };
};

const RUNTIME_ONLY = /^(?:INSTRUMENTED_|ENTER_EXECUTOR$)/u;

const resolve = (
  code: CodeObject,
  profile: BytecodeProfile,
  entry: Unpacked,
  target: number | null,
  labels: ReadonlyMap<number, number>,
  reprs: Map<PyValue, string>,
): Resolved => {
  const arg = entry.arg;
  const name = profile.opname.get(entry.opcode);
  if (name === undefined)
    return {
      argval: arg === null ? null : String(arg),
      argrepr: "",
      problem: `Opcode ${String(entry.opcode)} is not a base instruction of Python ${profile.version}.`,
    };
  if (RUNTIME_ONLY.test(name))
    return {
      argval: arg === null ? null : String(arg),
      argrepr: "",
      problem: `${name} is only created at run time and should not be in a .pyc.`,
    };
  if (arg === null) return { argval: null, argrepr: "", problem: null };
  const rules = profile.rules;
  const modern = rules !== "3.9" && rules !== "3.11" && rules !== "3.12";
  const text = (value: string, repr = value): Resolved => ({
    argval: value,
    argrepr: repr,
    problem: null,
  });
  const failed = (problem: string): Resolved => ({
    argval: String(arg),
    argrepr: "",
    problem,
  });
  const nameAt = (index: number) => pick(code.names, index, "co_names");
  const localAt = (index: number) =>
    rules === "3.9"
      ? profile.has("hasfree", entry.opcode)
        ? pick(
            [...code.cellvars, ...code.freevars],
            index,
            "the cell and free variables",
          )
        : pick(code.varnames, index, "co_varnames")
      : pick(
          code.localsplus.map((local) => local.name),
          index,
          "co_localsplusnames",
        );
  const named = (
    found: { value: string } | { problem: string },
    suffix: string | null,
    prefix: boolean,
  ): Resolved => {
    if ("problem" in found) return failed(found.problem);
    // dis adds the suffix only to a non-empty name (`from . import x` has none).
    if (suffix === null || found.value === "") return text(found.value);
    return text(
      found.value,
      prefix ? `${suffix} + ${found.value}` : `${found.value} + ${suffix}`,
    );
  };

  if (profile.has("hasconst", entry.opcode)) {
    if (name === "LOAD_SMALL_INT") return text(String(arg));
    // 3.11's dis resolves only LOAD_CONST; KW_NAMES keeps its bare index.
    if (rules === "3.11" && name !== "LOAD_CONST")
      return { argval: String(arg), argrepr: "", problem: null };
    const found = pick<PyValue>(code.consts, arg, "co_consts");
    if ("problem" in found) return failed(found.problem);
    // A large constant loaded many times is printed once, not once per load.
    let repr = reprs.get(found.value);
    if (repr === undefined) {
      repr = reprValue(profile.data.printable, found.value);
      reprs.set(found.value, repr);
    }
    return text(repr);
  }
  if (profile.has("hasname", entry.opcode)) {
    const prefix = rules === "3.11" || rules === "3.12";
    if (name === "LOAD_GLOBAL" && rules !== "3.9")
      return named(nameAt(arg >> 1), arg & 1 ? "NULL" : null, prefix);
    if (name === "LOAD_ATTR" && rules !== "3.9" && rules !== "3.11")
      return named(nameAt(arg >> 1), arg & 1 ? "NULL|self" : null, prefix);
    if (name === "LOAD_SUPER_ATTR")
      return named(nameAt(arg >> 2), arg & 1 ? "NULL|self" : null, prefix);
    if (name === "IMPORT_NAME" && rules === "3.15")
      return named(
        nameAt(arg >> 2),
        arg & 1 ? "lazy" : arg & 2 ? "eager" : null,
        false,
      );
    return named(nameAt(arg), null, false);
  }
  const jumps = modern
    ? profile.has("hasjump", entry.opcode) ||
      profile.has("hasexc", entry.opcode)
    : profile.has("hasjrel", entry.opcode) ||
      (rules !== "3.9" && profile.has("hasjabs", entry.opcode));
  if (jumps) {
    if (target === null) return failed(`${name} has no jump target.`);
    if (!modern) return text(String(target), `to ${String(target)}`);
    const label = labels.get(target);
    if (label === undefined)
      return failed(`${name} jumps to an unlabelled offset.`);
    const preposition =
      name === "END_ASYNC_FOR" && (rules === "3.14" || rules === "3.15")
        ? "from"
        : "to";
    return text(String(target), `${preposition} L${String(label)}`);
  }
  if (
    modern &&
    (name === "LOAD_FAST_LOAD_FAST" ||
      name === "LOAD_FAST_BORROW_LOAD_FAST_BORROW" ||
      name === "STORE_FAST_LOAD_FAST" ||
      name === "STORE_FAST_STORE_FAST")
  ) {
    const first = localAt(arg >> 4);
    const second = localAt(arg & 15);
    if ("problem" in first) return failed(first.problem);
    if ("problem" in second) return failed(second.problem);
    return text(
      `(${first.value}, ${second.value})`,
      `${first.value}, ${second.value}`,
    );
  }
  if (
    profile.has("haslocal", entry.opcode) ||
    profile.has("hasfree", entry.opcode)
  )
    return named(localAt(arg), null, false);
  if (profile.has("hascompare", entry.opcode)) {
    const shift =
      rules === "3.9" || rules === "3.11" ? 0 : rules === "3.12" ? 4 : 5;
    const found = pick(profile.data.cmp_op, arg >> shift, "cmp_op");
    if ("problem" in found) return failed(found.problem);
    return text(
      found.value,
      modern && (arg & 16) !== 0 ? `bool(${found.value})` : found.value,
    );
  }
  switch (name) {
    case "FORMAT_VALUE": {
      const conversion = profile.data.format_value_converters?.[arg & 3] ?? "";
      const withFormat = (arg & 4) !== 0;
      return {
        argval: String(arg),
        argrepr: withFormat
          ? `${conversion === "" ? "" : `${conversion}, `}with format`
          : conversion,
        problem: null,
      };
    }
    case "MAKE_FUNCTION":
      if (rules === "3.9" || rules === "3.11" || rules === "3.12")
        return {
          argval: String(arg),
          argrepr: flagNames(profile.data.make_function_flags, arg),
          problem: null,
        };
      break;
    case "SET_FUNCTION_ATTRIBUTE":
      return {
        argval: String(arg),
        argrepr: flagNames(profile.data.function_attr_flags, arg),
        problem: null,
      };
    case "BINARY_OP": {
      const found = pick(profile.data.nb_ops, arg, "the binary operators");
      return "problem" in found
        ? failed(found.problem)
        : { argval: String(arg), argrepr: found.value, problem: null };
    }
    case "CALL_INTRINSIC_1":
    case "CALL_INTRINSIC_2": {
      const list =
        name === "CALL_INTRINSIC_1"
          ? profile.data.intrinsic_1
          : profile.data.intrinsic_2;
      const found = pick(list, arg, "the intrinsic functions");
      return "problem" in found
        ? failed(found.problem)
        : { argval: String(arg), argrepr: found.value, problem: null };
    }
    case "CONVERT_VALUE": {
      const found = pick(["", "str", "repr", "ascii"], arg, "the conversions");
      return "problem" in found
        ? failed(found.problem)
        : {
            argval: found.value === "" ? "None" : found.value,
            argrepr: found.value,
            problem: null,
          };
    }
    case "LOAD_COMMON_CONSTANT": {
      const found = pick(
        profile.data.common_constants,
        arg,
        "the common constants",
      );
      return "problem" in found
        ? failed(found.problem)
        : { argval: found.value, argrepr: found.value, problem: null };
    }
    case "LOAD_SPECIAL": {
      const found = pick(
        profile.data.special_methods,
        arg,
        "the special methods",
      );
      return "problem" in found
        ? failed(found.problem)
        : { argval: String(arg), argrepr: found.value, problem: null };
    }
    case "IS_OP":
    case "CONTAINS_OP":
      if (rules === "3.14" || rules === "3.15")
        return {
          argval: String(arg),
          argrepr:
            name === "IS_OP" ? (arg ? "is not" : "is") : arg ? "not in" : "in",
          problem: null,
        };
      break;
  }
  return { argval: String(arg), argrepr: "", problem: null };
};

export const disassemble = (
  code: CodeObject,
  profile: BytecodeProfile,
  lines: LineInfo,
): Disassembly => {
  const problems: string[] = [];
  if (code.code.length % 2 !== 0)
    problems.push("co_code has an odd length; the last byte is ignored.");
  const unpacked = unpack(code.code, profile);
  const targets = unpacked.map((entry) => jumpTarget(profile, entry));
  // dis numbers labels over jump targets in offset order (get_instructions passes no exception entries).
  const labels = new Map(
    [...new Set(targets.filter((target): target is number => target !== null))]
      .sort((left, right) => left - right)
      .map((offset, index) => [offset, index + 1]),
  );
  let line: number | null = null;
  const reprs = new Map<PyValue, string>();
  const instructions = unpacked.map((entry, index): Instruction => {
    const target = targets[index] ?? null;
    const resolved = resolve(code, profile, entry, target, labels, reprs);
    if (resolved.problem !== null)
      problems.push(`At offset ${String(entry.offset)}: ${resolved.problem}`);
    if (target !== null && (target < 0 || target >= code.code.length))
      problems.push(
        `At offset ${String(entry.offset)}: the jump target ${String(target)} is outside the bytecode.`,
      );
    const start = lines.starts.get(entry.offset);
    const startsLine = start !== undefined;
    const position = lines.positions[entry.offset / 2];
    if (profile.layout === "3.11+") line = position?.line ?? null;
    else if (startsLine) line = start;
    return {
      offset: entry.offset,
      startOffset: entry.startOffset,
      opcode: entry.opcode,
      opname: profile.opname.get(entry.opcode) ?? `<${String(entry.opcode)}>`,
      arg: entry.arg,
      argval: resolved.argval,
      argrepr: resolved.argrepr,
      jumpTarget: target,
      cacheUnits:
        profile.layout === "3.11+" ? cacheUnits(profile, entry.opcode) : 0,
      line,
      startsLine,
      column: position?.column ?? null,
      endLine: position?.endLine ?? null,
      endColumn: position?.endColumn ?? null,
      problem: resolved.problem,
    };
  });
  return { instructions, problems };
};
