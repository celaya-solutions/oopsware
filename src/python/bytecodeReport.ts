import {
  MAX_PYTHON_CODE_OBJECTS,
  MAX_PYTHON_MARSHAL_OBJECTS,
  type PythonCodeReport,
  type PythonModuleReport,
} from "../domain/python/python.js";
import { disassemble, type Instruction } from "./bytecode/disassemble.js";
import { exceptionTable, lineInfo } from "./bytecode/lineTable.js";
import type { CodeObject, PyValue } from "./bytecode/marshal.js";
import type { BytecodeProfile } from "./bytecode/profiles.js";
import {
  codeEntries,
  loadPyc,
  readPycHeader,
  type CodeEntry,
  type PycHeader,
} from "./bytecode/pyc.js";
import { reprValue } from "./bytecode/repr.js";

type BytecodeFacts = NonNullable<PythonModuleReport["bytecode"]>;
type Header = BytecodeFacts["header"];

export const headerFacts = (header: PycHeader): Header => ({
  magic: header.magic,
  release: header.release,
  admitted: header.admitted,
  flags: header.flags,
  invalidation:
    header.invalidation === null
      ? null
      : header.invalidation.kind === "timestamp"
        ? {
            kind: "timestamp",
            source_mtime: header.invalidation.sourceMtime,
            source_size: header.invalidation.sourceSize,
          }
        : {
            kind: header.invalidation.kind,
            source_hash: header.invalidation.sourceHash,
          },
  header_bytes: header.headerBytes,
  problem: header.problem,
});

export const flagNames = (
  profile: BytecodeProfile,
  flags: number,
): string[] => {
  const names: string[] = [];
  for (let bit = 0; bit < 32; bit += 1) {
    const value = 2 ** bit;
    if (Math.floor(flags / value) % 2 === 0) continue;
    names.push(
      profile.data.code_flags[String(value)] ?? `0x${value.toString(16)}`,
    );
  }
  return names;
};

interface DecodedCode {
  readonly entry: CodeEntry;
  readonly instructions: Instruction[];
  readonly exceptions: ReturnType<typeof exceptionTable>["entries"];
  readonly problems: string[];
}

export interface DecodedModule {
  readonly header: PycHeader;
  readonly profile: BytecodeProfile;
  readonly codes: DecodedCode[];
  readonly truncated: boolean;
  readonly trailing: number;
}

export type BytecodeRead =
  | { readonly kind: "decoded"; readonly module: DecodedModule }
  | {
      readonly kind: "header-only";
      readonly header: PycHeader;
      readonly problem: string | null;
      readonly profile: BytecodeProfile | null;
    }
  | { readonly kind: "not-pyc" };

const decodeCode = (
  entry: CodeEntry,
  profile: BytecodeProfile,
): DecodedCode => {
  const lines = lineInfo(entry.code, profile);
  const table =
    profile.layout === "3.11+"
      ? exceptionTable(entry.code)
      : { entries: [], problem: null };
  const { instructions, problems } = disassemble(entry.code, profile, lines);
  return {
    entry,
    instructions,
    exceptions: table.entries,
    problems: [
      ...(lines.problem === null ? [] : [lines.problem]),
      ...(table.problem === null ? [] : [table.problem]),
      ...problems,
    ],
  };
};

/** Read a .pyc: header always, code objects only with an admitted profile. */
export const readBytecode = (bytes: Uint8Array): BytecodeRead => {
  const header = readPycHeader(bytes);
  if (header === null) return { kind: "not-pyc" };
  if (header.problem !== null && header.invalidation === null)
    return {
      kind: "header-only",
      header,
      problem: header.problem,
      profile: null,
    };
  const loaded = loadPyc(bytes, header, MAX_PYTHON_MARSHAL_OBJECTS);
  if (loaded.kind === "not-admitted")
    return { kind: "header-only", header, problem: null, profile: null };
  if (loaded.kind === "failed")
    return {
      kind: "header-only",
      header,
      problem: loaded.problem,
      profile: loaded.profile,
    };
  const entries = codeEntries(loaded.module, MAX_PYTHON_CODE_OBJECTS + 1);
  const truncated = entries.length > MAX_PYTHON_CODE_OBJECTS;
  return {
    kind: "decoded",
    module: {
      header,
      profile: loaded.profile,
      codes: entries
        .slice(0, MAX_PYTHON_CODE_OBJECTS)
        .map((entry) => decodeCode(entry, loaded.profile)),
      truncated,
      trailing: loaded.trailing,
    },
  };
};

const constant = (
  code: CodeObject,
  instruction: Instruction | undefined,
): PyValue | null => {
  if (instruction === undefined || instruction.arg === null) return null;
  if (instruction.opname === "LOAD_SMALL_INT")
    return { t: "int", v: BigInt(instruction.arg) };
  if (instruction.opname !== "LOAD_CONST") return null;
  return code.consts[instruction.arg] ?? null;
};

/** IMPORT_NAME with the level and from-list constants loaded right before it. */
const importsOf = (decoded: DecodedModule): BytecodeFacts["imports"] =>
  decoded.codes.flatMap(({ entry, instructions }) =>
    instructions.flatMap((instruction, index) => {
      if (instruction.opname !== "IMPORT_NAME" || instruction.argval === null)
        return [];
      const fromlist = constant(entry.code, instructions[index - 1]);
      const level = constant(entry.code, instructions[index - 2]);
      const lazy =
        decoded.profile.rules === "3.15" && instruction.arg !== null
          ? (instruction.arg & 1) !== 0
          : null;
      return [
        {
          code_index: entry.index,
          offset: instruction.offset,
          line: instruction.line,
          module: instruction.argval,
          fromlist:
            fromlist?.t === "tuple" &&
            fromlist.items.every((item) => item.t === "str")
              ? fromlist.items.map((item) => (item.t === "str" ? item.v : ""))
              : null,
          level: level?.t === "int" ? Number(level.v) : null,
          lazy,
        },
      ];
    }),
  );

export const bytecodeFacts = (
  read: Exclude<BytecodeRead, { kind: "not-pyc" }>,
): BytecodeFacts => {
  if (read.kind === "header-only")
    return {
      header: headerFacts(read.header),
      decode:
        read.profile === null
          ? read.problem === null
            ? "not-admitted"
            : "failed"
          : "failed",
      profile:
        read.profile === null
          ? null
          : { release: read.profile.data.release, magic: read.profile.magic },
      problem:
        read.problem ??
        (read.header.admitted
          ? null
          : `No decoding profile admits magic number ${String(read.header.magic)}${read.header.release === null ? "" : ` (Python ${read.header.release})`}; the header is still read.`),
      filename: null,
      code_count: 0,
      code_objects: [],
      imports: [],
      module_names: [],
      trailing_bytes: 0,
    };
  const decoded = read.module;
  const problems = decoded.codes.reduce(
    (sum, code) => sum + code.problems.length,
    0,
  );
  const module = decoded.codes[0]?.entry.code;
  const partial =
    problems > 0 ||
    decoded.truncated ||
    decoded.trailing > 0 ||
    decoded.header.problem !== null;
  return {
    header: headerFacts(decoded.header),
    decode: partial ? "partial" : "complete",
    profile: {
      release: decoded.profile.data.release,
      magic: decoded.profile.magic,
    },
    problem: decoded.truncated
      ? `Only the first ${String(MAX_PYTHON_CODE_OBJECTS)} code objects are decoded.`
      : decoded.trailing > 0
        ? `${String(decoded.trailing)} bytes follow the marshalled code object.`
        : problems > 0
          ? `${String(problems)} instruction or table problems; see inspect_python_code.`
          : null,
    filename: module?.filename ?? null,
    code_count: decoded.codes.length,
    code_objects: decoded.codes.map(
      ({ entry, instructions, problems: found }) => ({
        index: entry.index,
        parent: entry.parent,
        depth: entry.depth,
        qualname: entry.qualname,
        name: entry.code.name,
        firstlineno: entry.code.firstlineno,
        flags: flagNames(decoded.profile, entry.code.flags),
        argcount: entry.code.argcount,
        posonlyargcount: entry.code.posonlyargcount,
        kwonlyargcount: entry.code.kwonlyargcount,
        code_bytes: entry.code.code.length,
        instruction_count: instructions.length,
        constants: entry.code.consts.length,
        names: entry.code.names.length,
        problems: found.length,
      }),
    ),
    imports: importsOf(decoded),
    module_names: module?.names ?? [],
    trailing_bytes: decoded.trailing,
  };
};

export type CodeSelection =
  | { readonly kind: "found"; readonly code: DecodedCode }
  | { readonly kind: "missing" | "ambiguous"; readonly message: string };

export const selectCode = (
  decoded: DecodedModule,
  input: { code?: string | undefined; code_index?: number | undefined },
): CodeSelection => {
  if (input.code_index !== undefined) {
    const found = decoded.codes[input.code_index];
    if (found === undefined)
      return {
        kind: "missing",
        message: `There is no code object ${String(input.code_index)}; the module has ${String(decoded.codes.length)}.`,
      };
    if (input.code !== undefined && found.entry.qualname !== input.code)
      return {
        kind: "missing",
        message: `Code object ${String(input.code_index)} is ${found.entry.qualname}, not ${input.code}.`,
      };
    return { kind: "found", code: found };
  }
  if (input.code === undefined) {
    const module = decoded.codes[0];
    return module === undefined
      ? { kind: "missing", message: "The module has no code object." }
      : { kind: "found", code: module };
  }
  const matches = decoded.codes.filter(
    (code) => code.entry.qualname === input.code,
  );
  if (matches.length === 1 && matches[0] !== undefined)
    return { kind: "found", code: matches[0] };
  if (matches.length === 0)
    return {
      kind: "missing",
      message: `No code object is named ${input.code}.`,
    };
  return {
    kind: "ambiguous",
    message: `${String(matches.length)} code objects are named ${input.code} (indexes ${matches.map((code) => String(code.entry.index)).join(", ")}); choose one with code_index.`,
  };
};

const typeOf = (value: PyValue): string =>
  value.t === "code" ? "code" : value.t === "stop-iteration" ? "type" : value.t;

export const codeReportBody = (
  decoded: DecodedModule,
  selected: DecodedCode,
  page: { start: number; limit: number },
): Omit<
  PythonCodeReport,
  "artifact" | "selection" | "coverage" | "limitations"
> => {
  const { entry, instructions } = selected;
  const code = entry.code;
  const slice = instructions.slice(page.start, page.start + page.limit);
  const next = page.start + slice.length;
  return {
    profile: {
      release: decoded.profile.data.release,
      magic: decoded.profile.magic,
    },
    code: {
      name: code.name,
      qualname: entry.qualname,
      filename: code.filename,
      firstlineno: code.firstlineno,
      argcount: code.argcount,
      posonlyargcount: code.posonlyargcount,
      kwonlyargcount: code.kwonlyargcount,
      nlocals: code.nlocals,
      stacksize: code.stacksize,
      flags: code.flags,
      flag_names: flagNames(decoded.profile, code.flags),
      varnames: code.varnames,
      cellvars: code.cellvars,
      freevars: code.freevars,
      names: code.names,
      constants: code.consts.map((value, index) => ({
        index,
        type: typeOf(value),
        repr: reprValue(decoded.profile.data.printable, value),
      })),
      code_bytes: code.code.length,
    },
    instruction_count: instructions.length,
    page: {
      start: page.start,
      limit: page.limit,
      returned: slice.length,
      next: next < instructions.length ? next : null,
    },
    instructions: slice.map((instruction, offset) => ({
      index: page.start + offset,
      offset: instruction.offset,
      start_offset: instruction.startOffset,
      opcode: instruction.opcode,
      opname: instruction.opname,
      arg: instruction.arg,
      argval: instruction.argval,
      argrepr: instruction.argrepr,
      jump_target: instruction.jumpTarget,
      cache_units: instruction.cacheUnits,
      line: instruction.line,
      starts_line: instruction.startsLine,
      column: instruction.column,
      end_line: instruction.endLine,
      end_column: instruction.endColumn,
      problem: instruction.problem,
    })),
    exception_table: selected.exceptions.map((item) => ({
      start: item.start,
      end: item.end,
      target: item.target,
      depth: item.depth,
      lasti: item.lasti,
    })),
    problems: selected.problems,
  };
};
