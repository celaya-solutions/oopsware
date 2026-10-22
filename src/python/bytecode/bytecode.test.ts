import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  admittedProducers,
  compileSample,
  disOracle,
  minorOf,
  PYTHON_SAMPLES,
  type Invalidation,
  sortSets,
  type OracleCode,
} from "../../../tests/fixtures/pythonProducers.js";
import { disassemble, type Instruction } from "./disassemble.js";
import { exceptionTable, lineInfo } from "./lineTable.js";
import { codeEntries, loadPyc, readPycHeader } from "./pyc.js";
import type { CodeObject } from "./marshal.js";
import type { BytecodeProfile } from "./profiles.js";
import { reprValue } from "./repr.js";

const producers = await admittedProducers();
const scratch = await mkdtemp(join(tmpdir(), "oopsware-pyc-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));

/** A container constant's argument text with sets sorted, as the oracle prints it. */
const constantText = (
  code: CodeObject,
  profile: BytecodeProfile,
  item: Instruction,
): string => {
  const value = item.arg === null ? undefined : code.consts[item.arg];
  return item.argrepr !== "" &&
    item.opname !== "LOAD_SMALL_INT" &&
    profile.has("hasconst", item.opcode) &&
    value !== undefined &&
    (value.t === "tuple" || value.t === "set" || value.t === "frozenset")
    ? reprValue(profile.data.printable, sortSets(profile.data.printable, value))
    : item.argrepr;
};

const compareCode = (
  ours: ReturnType<typeof decode>[number],
  oracle: OracleCode,
  modern: boolean,
) => {
  const { entry, profile } = ours;
  const code = entry.code;
  expect({
    name: code.name,
    qualname: code.qualname,
    firstlineno: code.firstlineno,
    argcount: code.argcount,
    posonlyargcount: code.posonlyargcount,
    kwonlyargcount: code.kwonlyargcount,
    nlocals: code.nlocals,
    stacksize: code.stacksize,
    flags: code.flags,
    names: code.names,
    varnames: code.varnames,
    cellvars: code.cellvars,
    freevars: code.freevars,
    filename: code.filename,
    code_bytes: code.code.length,
  }).toEqual({
    name: oracle.name,
    qualname: oracle.qualname,
    firstlineno: oracle.firstlineno,
    argcount: oracle.argcount,
    posonlyargcount: oracle.posonlyargcount,
    kwonlyargcount: oracle.kwonlyargcount,
    nlocals: oracle.nlocals,
    stacksize: oracle.stacksize,
    flags: oracle.flags,
    names: oracle.names,
    varnames: oracle.varnames,
    cellvars: oracle.cellvars,
    freevars: oracle.freevars,
    filename: oracle.filename,
    code_bytes: oracle.code_bytes,
  });
  expect(
    code.consts.map((value) =>
      reprValue(
        profile.data.printable,
        sortSets(profile.data.printable, value),
      ),
    ),
  ).toEqual(oracle.consts);
  const lines = lineInfo(code, profile);
  expect(lines.problem).toBeNull();
  const table = exceptionTable(code);
  expect(table.problem).toBeNull();
  if (oracle.exception_table !== undefined)
    expect(
      table.entries.map((item) => [
        item.start,
        item.end,
        item.target,
        item.depth,
        item.lasti,
      ]),
    ).toEqual(oracle.exception_table);
  const { instructions, problems } = disassemble(code, profile, lines);
  expect(problems).toEqual([]);
  expect(
    instructions.map((item) => ({
      offset: item.offset,
      opname: item.opname,
      opcode: item.opcode,
      arg: item.arg,
      argrepr: constantText(code, profile, item),
      ...(modern ? { start_offset: item.startOffset } : {}),
      starts_line: modern
        ? item.startsLine
        : item.startsLine
          ? item.line
          : null,
      ...(modern ? { line: item.line } : {}),
      ...(profile.layout === "3.11+"
        ? { positions: [item.line, item.endLine, item.column, item.endColumn] }
        : {}),
    })),
  ).toEqual(
    oracle.instructions.map((item) => ({
      offset: item.offset,
      opname: item.opname,
      opcode: item.opcode,
      arg: item.arg,
      argrepr: item.argrepr,
      ...(modern ? { start_offset: item.start_offset } : {}),
      starts_line: item.starts_line,
      ...(modern ? { line: item.line } : {}),
      ...(item.positions === undefined ? {} : { positions: item.positions }),
    })),
  );
  for (const [index, item] of oracle.instructions.entries())
    if (item.jump_target !== undefined)
      expect(instructions[index]?.jumpTarget).toBe(item.jump_target);
};

const decode = (bytes: Uint8Array) => {
  const header = readPycHeader(bytes);
  if (header === null) throw new Error("not a pyc");
  const loaded = loadPyc(bytes, header, 1_000_000);
  if (loaded.kind !== "decoded") throw new Error(`not decoded: ${loaded.kind}`);
  expect(loaded.trailing).toBe(0);
  return codeEntries(loaded.module, 100_000).map((entry) => ({
    entry,
    profile: loaded.profile,
  }));
};

describe.skipIf(producers.length === 0)(
  "pyc decoding against the producer's dis",
  () => {
    for (const interpreter of producers) {
      const minor = minorOf(interpreter);
      const modern = minor >= 13;
      describe(`Python ${interpreter.release}`, () => {
        for (const sample of PYTHON_SAMPLES.filter(
          (item) => item.since <= minor,
        ))
          it(`decodes ${sample.file} like dis`, async () => {
            const directory = join(scratch, interpreter.version);
            const file = await compileSample(
              interpreter,
              directory,
              sample.file,
            );
            const oracle = await disOracle(interpreter, [file]);
            const ours = decode(await readFile(file));
            const codes = oracle.files[0]?.codes ?? [];
            expect(ours.map((item) => item.entry.code.name)).toEqual(
              codes.map((code) => code.name),
            );
            ours.forEach((item, index) => {
              const expected = codes[index];
              if (expected === undefined)
                throw new Error("missing oracle code");
              compareCode(item, expected, modern);
            });
          });

        it("reads timestamp and hash-based headers", async () => {
          const directory = join(scratch, `${interpreter.version}-headers`);
          const kinds: Invalidation[] = [
            "TIMESTAMP",
            "CHECKED_HASH",
            "UNCHECKED_HASH",
          ];
          for (const kind of kinds) {
            const file = await compileSample(
              interpreter,
              directory,
              "sample.py",
              kind,
            );
            const header = readPycHeader(await readFile(file));
            expect(header?.admitted).toBe(true);
            expect(header?.release).toBe(interpreter.version);
            expect(header?.problem).toBeNull();
            expect(header?.invalidation?.kind).toBe(
              kind === "TIMESTAMP"
                ? "timestamp"
                : kind === "CHECKED_HASH"
                  ? "checked-hash"
                  : "unchecked-hash",
            );
          }
        });
      });
    }
  },
);
