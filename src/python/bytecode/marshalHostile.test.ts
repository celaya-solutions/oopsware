import { describe, expect, it } from "vitest";

import { disassemble } from "./disassemble.js";
import { lineInfo } from "./lineTable.js";
import {
  MarshalError,
  MarshalReader,
  type CodeObject,
  type PyValue,
} from "./marshal.js";
import { admittedProfiles } from "./profiles.js";
import { reprValue } from "./repr.js";

const profile = admittedProfiles().find(
  (candidate) => candidate.layout === "3.8-3.10",
);
if (profile === undefined) throw new Error("No admitted bytecode profile");

const FLAG_REF = 0x80;
const ref = (slot: number) => [0x72, slot, 0, 0, 0];

/**
 * A tuple holding `levels` flagged tuples, each two references to the one
 * before it: a few bytes per level, but 2^levels leaves once expanded.
 */
const doublingTuples = (levels: number): Uint8Array => {
  const bytes = [0x28 /* ( */, (levels + 1) & 0xff, 0, 0, 0, 0x4e | FLAG_REF];
  for (let level = 1; level <= levels; level += 1)
    bytes.push(0x29 | FLAG_REF, 2, ...ref(level - 1), ...ref(level - 1));
  return Uint8Array.from(bytes);
};

describe("LOAD_CONST text", () => {
  it("prints a large constant once however often it is loaded", () => {
    const opcode = [...profile.opname].find(
      ([, name]) => name === "LOAD_CONST",
    );
    if (opcode === undefined) throw new Error("No LOAD_CONST");
    const big: PyValue = {
      t: "tuple",
      items: Array.from({ length: 200_000 }, () => ({ t: "none" })),
    };
    const loads = 5000;
    const code: CodeObject = {
      argcount: 0,
      posonlyargcount: 0,
      kwonlyargcount: 0,
      nlocals: 0,
      stacksize: 1,
      flags: 0,
      code: Uint8Array.from(
        Array.from({ length: loads }, () => [opcode[0], 0]).flat(),
      ),
      consts: [big],
      names: [],
      varnames: [],
      cellvars: [],
      freevars: [],
      localsplus: [],
      filename: "big.py",
      name: "big",
      qualname: null,
      firstlineno: 1,
      linetable: new Uint8Array(),
      exceptiontable: new Uint8Array(),
      offset: 0,
    };
    const started = performance.now();
    const { instructions } = disassemble(
      code,
      profile,
      lineInfo(code, profile),
    );
    expect(instructions).toHaveLength(loads);
    expect(instructions[loads - 1]?.argrepr.length).toBeGreaterThan(1_000_000);
    // Printing it per load would take minutes.
    expect(performance.now() - started).toBeLessThan(10_000);
  });
});

describe("marshal reference expansion", () => {
  it("refuses a stream whose shared objects expand past the object limit", () => {
    const read = () =>
      new MarshalReader(doublingTuples(60), 0, profile, {
        maxObjects: 100_000,
      }).read();
    expect(read).toThrow(MarshalError);
    expect(read).toThrow(/expand/u);
  });

  it("reads a small amount of sharing and prints it in full", () => {
    const value = new MarshalReader(doublingTuples(4), 0, profile, {
      maxObjects: 100_000,
    }).read();
    const text = reprValue(profile.data.printable, value);
    // The first item plus the 2, 4, 8 and 16 leaves of levels 1 to 4.
    expect(text.split("None").length - 1).toBe(1 + 2 + 4 + 8 + 16);
  });
});
