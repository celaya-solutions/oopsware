import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  debugSymbolsReportSchema,
  inspectDebugSymbolsInputSchema,
} from "../domain/debugSymbols/debugSymbols.js";
import { AnalysisUnsupportedTargetError } from "../domain/analysisErrorCore.js";
import { ArtifactOperationError } from "../domain/artifactOperationError.js";
import {
  SYMBOL_TOOLS,
  buildElf as buildGoElf,
  buildMacho,
  type ElfBuild,
  type MachoBuild,
} from "../../tests/fixtures/debugSymbolProducers.js";
import {
  Writer,
  abbrevTable,
  buildElf,
  unit,
  type ElfSection,
} from "../../tests/fixtures/syntheticDwarf.js";
import { DebugFormatError } from "./byteReader.js";
import { DW_AT, DW_FORM, DW_TAG } from "./dwarfConstants.js";
import { readLineHeader, runLineProgram } from "./dwarfLines.js";
import { FunctionIndex, summarizeUnit } from "./dwarfSymbols.js";
import { DwarfSections, UnitReader, readUnitHeaders } from "./dwarfUnits.js";
import { DebugSymbolsProvider } from "./DebugSymbolsProvider.js";
import { DecodeBudget } from "./image.js";
import { parseImages } from "./source.js";

/**
 * Hostile and malformed inputs. Everything here is hand-assembled or mutated from
 * real producer output; a failure must be typed and local, never a crash.
 */

const provider = new DebugSymbolsProvider();
let directory = "";

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "rea-debug-hostile-"));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

const run = async (bytes: Uint8Array, input: object = {}) => {
  const path = join(directory, `case-${Math.random().toString(16).slice(2)}`);
  await writeFile(path, bytes);
  const result = await provider.inspectSymbols(
    inspectDebugSymbolsInputSchema.parse({ path, ...input }),
  );
  if (!result.ok) throw result.error;
  return debugSymbolsReportSchema.parse(result.value);
};

const section = (name: string, data: Uint8Array): ElfSection => ({
  name,
  data,
});

const open = (bytes: Uint8Array) => {
  const [image] = parseImages("/synthetic", bytes);
  const sections = new DwarfSections(image!, new DecodeBudget(1 << 26));
  const { units, problems } = readUnitHeaders(sections);
  return {
    image: image!,
    sections,
    units,
    problems,
    reader: new UnitReader(sections),
  };
};

describe("work and memory stay bounded", () => {
  it("does not keep or re-read quadratic abbreviation tables", async () => {
    // 3,000 units whose abbreviation tables are overlapping suffixes of one 40,000-entry table.
    const entries = 40_000;
    const units = 3_000;
    const abbrev = new Writer();
    const starts: number[] = [];
    for (let code = 1; code <= entries; code += 1) {
      starts.push(abbrev.length);
      abbrev.uleb(code).uleb(DW_TAG.compile_unit).u8(0).uleb(0).uleb(0);
    }
    abbrev.uleb(0);
    const info = new Writer();
    for (let index = 0; index < units; index += 1)
      info.raw(
        unit({
          version: 4,
          abbrevOffset: starts[index]!,
          dies: new Writer().uleb(index + 1).toBytes(),
        }),
      );
    const started = Date.now();
    const report = await run(
      buildElf({
        sections: [
          section(".debug_info", info.toBytes()),
          section(".debug_abbrev", abbrev.toBytes()),
        ],
      }),
      { limit: 3000 },
    );
    expect(Date.now() - started).toBeLessThan(60_000);
    // The call stops decoding at its step budget and says so on the units it could not read.
    expect(
      report.units.some((row) => /decoding steps/u.test(row.problem ?? "")),
    ).toBe(true);
  }, 120_000);

  it("lists at most 500,000 units and says so", async () => {
    const empty = unit({ version: 4, dies: new Uint8Array(0) });
    const info = new Uint8Array(empty.length * 500_001);
    for (let index = 0; index < 500_001; index += 1)
      info.set(empty, index * empty.length);
    const report = await run(
      buildElf({
        sections: [
          section(".debug_info", info),
          section(".debug_abbrev", new Uint8Array([0])),
        ],
      }),
      { limit: 1 },
    );
    expect(report.images[0]!.dwarf.unit_count).toBe(500_000);
    expect(report.diagnostics.map((item) => item.message).join(" ")).toMatch(
      /More than 500000 units/u,
    );
  }, 120_000);

  it("stops DW_FORM_indirect chains instead of overflowing the stack", async () => {
    const abbrev = abbrevTable([
      {
        code: 1,
        tag: DW_TAG.compile_unit,
        children: false,
        attrs: [[DW_AT.name, DW_FORM.indirect]],
      },
    ]);
    const dies = new Writer().uleb(1);
    for (let index = 0; index < 200_000; index += 1) dies.u8(0x16);
    const report = await run(
      buildElf({
        sections: [
          section(".debug_info", unit({ version: 4, dies: dies.toBytes() })),
          section(".debug_abbrev", abbrev),
        ],
      }),
    );
    expect(report.units[0]!.problem).toMatch(/nests too deeply/u);
  });
});

describe("values that do not fit a count", () => {
  it("wraps line numbers to 32 bits as llvm does", () => {
    const body = new Writer().u16(4).u32(0).toBytes();
    void body;
    const header = new Writer().u8(1).u8(1).u8(1).u8(0xfb).u8(14).u8(13);
    for (const length of [0, 1, 1, 1, 1, 0, 0, 0, 1, 0, 0, 1])
      header.u8(length);
    header.u8(0).cstr("a.c").uleb(0).uleb(0).uleb(0).u8(0);
    const program = new Writer().u8(3).sleb(-5).u8(1).toBytes();
    const afterLength = new Writer()
      .u16(4)
      .u32(header.length)
      .raw(header.toBytes())
      .raw(program);
    const line = new Writer()
      .u32(afterLength.length)
      .raw(afterLength.toBytes())
      .toBytes();
    const { sections } = open(
      buildElf({ sections: [section(".debug_line", line)] }),
    );
    const parsed = readLineHeader(sections, 0, null, 8);
    const lines: number[] = [];
    runLineProgram(sections, parsed, (row) => {
      lines.push(row.line);
    });
    expect(lines).toEqual([4294967292]);
  });

  it("drops a negative declaration line instead of failing the page", async () => {
    const abbrev = abbrevTable([
      {
        code: 1,
        tag: DW_TAG.compile_unit,
        children: true,
        attrs: [[DW_AT.name, DW_FORM.string]],
      },
      {
        code: 2,
        tag: DW_TAG.subprogram,
        children: false,
        attrs: [
          [DW_AT.name, DW_FORM.string],
          [DW_AT.low_pc, DW_FORM.addr],
          [DW_AT.high_pc, DW_FORM.data4],
          [DW_AT.decl_line, DW_FORM.sdata],
          [DW_AT.decl_file, DW_FORM.implicit_const, -4],
        ],
      },
    ]);
    const dies = new Writer()
      .uleb(1)
      .cstr("u.c")
      .uleb(2)
      .cstr("f")
      .u64(0x1000)
      .u32(8)
      .sleb(-1)
      .uleb(0);
    const report = await run(
      buildElf({
        sections: [
          section(".debug_info", unit({ version: 5, dies: dies.toBytes() })),
          section(".debug_abbrev", abbrev),
        ],
      }),
      { view: "functions" },
    );
    expect(report.functions[0]).toMatchObject({
      name: "f",
      decl_line: null,
      decl_file: null,
      low_pc: "0x1000",
    });
  });

  it("reports ranges_truncated when a list is longer than the 4,096 it lists", async () => {
    const abbrev = abbrevTable([
      {
        code: 1,
        tag: DW_TAG.compile_unit,
        children: true,
        attrs: [[DW_AT.low_pc, DW_FORM.addr]],
      },
      {
        code: 2,
        tag: DW_TAG.subprogram,
        children: false,
        attrs: [
          [DW_AT.name, DW_FORM.string],
          [DW_AT.ranges, DW_FORM.sec_offset],
        ],
      },
    ]);
    const list = new Writer();
    for (let index = 0; index < 5000; index += 1)
      list.u64(index * 16).u64(index * 16 + 8);
    list.u64(0).u64(0);
    const dies = new Writer()
      .uleb(1)
      .u64(0)
      .uleb(2)
      .cstr("wide")
      .u32(0)
      .uleb(0);
    const report = await run(
      buildElf({
        sections: [
          section(".debug_info", unit({ version: 4, dies: dies.toBytes() })),
          section(".debug_abbrev", abbrev),
          section(".debug_ranges", list.toBytes()),
        ],
      }),
      { view: "functions" },
    );
    expect(report.functions[0]).toMatchObject({
      range_count: 4096,
      ranges_truncated: true,
    });
    expect(report.functions[0]!.ranges).toHaveLength(16);
  });
});

describe("damaged ELF headers", () => {
  const note = (desc: number) =>
    new Writer().u32(4).u32(desc).u32(3).cstr("GNU").toBytes();

  it("does not let a note with a near-2^32 size throw", () => {
    const { image } = open(
      buildElf({
        sections: [
          { name: ".note.gnu.build-id", data: note(0xfffffffd), type: 7 },
        ],
      }),
    );
    expect(image.identity.buildId).toBeNull();
    expect(image.problems.join(" ")).toMatch(/note extends past/u);
  });

  it("marks one broken compressed section and keeps the rest", async () => {
    const huge = new Writer()
      .u32(1)
      .u32(0)
      .u64(2n ** 60n)
      .u64(1)
      .toBytes();
    const odd = new Writer()
      .u32(7)
      .u32(0)
      .u64(10)
      .u64(1)
      .raw([1, 2, 3])
      .toBytes();
    const report = await run(
      buildElf({
        sections: [
          { name: ".debug_info", data: huge, flags: 0x800 },
          { name: ".debug_str", data: odd, flags: 0x800 },
          section(".debug_abbrev", new Uint8Array([0])),
        ],
      }),
    );
    expect(report.images[0]!.dwarf.state).toBe("unreadable");
    expect(report.images[0]!.dwarf.reason).toMatch(
      /exceeds the supported range/u,
    );
    expect(report.images[0]!.dwarf.sections.map((item) => item.name)).toEqual([
      ".debug_info",
      ".debug_str",
      ".debug_abbrev",
    ]);
    // An unsupported compression type is not decoded as if it were plain DWARF.
    const second = await run(
      buildElf({
        sections: [
          { name: ".debug_info", data: odd, flags: 0x800 },
          section(".debug_abbrev", new Uint8Array([0])),
        ],
      }),
    );
    expect(second.images[0]!.dwarf.reason).toMatch(/compression type 7/u);
  });

  it("ignores an all-zero build id as a placeholder", () => {
    const zero = new Writer()
      .u32(4)
      .u32(8)
      .u32(3)
      .cstr("GNU")
      .raw(new Array<number>(8).fill(0))
      .toBytes();
    const { image } = open(
      buildElf({
        sections: [{ name: ".note.gnu.build-id", data: zero, type: 7 }],
      }),
    );
    expect(image.identity.buildId).toBeNull();
    expect(image.problems.join(" ")).toMatch(/all zeros/u);
  });
});

describe("declaration files belong to the unit that declared them", () => {
  const lineTable = (files: readonly string[]): Uint8Array => {
    const header = new Writer().u8(1).u8(1).u8(1).u8(0xfb).u8(14).u8(13);
    for (const length of [0, 1, 1, 1, 1, 0, 0, 0, 1, 0, 0, 1])
      header.u8(length);
    header.u8(0);
    for (const file of files) header.cstr(file).uleb(0).uleb(0).uleb(0);
    header.u8(0);
    const body = new Writer().u16(4).u32(header.length).raw(header.toBytes());
    return new Writer().u32(body.length).raw(body.toBytes()).toBytes();
  };

  it("resolves decl_file through an abstract origin in another unit", () => {
    const first = lineTable(["x.c", "a_origin.c"]);
    const second = lineTable(["b_first.c", "b_second.c"]);
    const abbrev = abbrevTable([
      {
        code: 1,
        tag: DW_TAG.compile_unit,
        children: true,
        attrs: [
          [DW_AT.name, DW_FORM.string],
          [DW_AT.stmt_list, DW_FORM.data4],
          [DW_AT.low_pc, DW_FORM.addr],
        ],
      },
      {
        code: 2,
        tag: DW_TAG.subprogram,
        children: false,
        attrs: [
          [DW_AT.name, DW_FORM.string],
          [DW_AT.decl_file, DW_FORM.data1],
          [DW_AT.decl_line, DW_FORM.data1],
          [DW_AT.inline, DW_FORM.data1],
        ],
      },
      {
        code: 3,
        tag: DW_TAG.subprogram,
        children: false,
        attrs: [
          [DW_AT.abstract_origin, DW_FORM.ref_addr],
          [DW_AT.low_pc, DW_FORM.addr],
          [DW_AT.high_pc, DW_FORM.data4],
        ],
      },
    ]);
    const headerSize = 11;
    const a = new Writer().uleb(1).cstr("a.c").u32(0).u64(0x1000);
    const abstractAt = headerSize + a.length;
    a.uleb(2).cstr("orig").u8(2).u8(9).u8(1).uleb(0);
    const b = new Writer()
      .uleb(1)
      .cstr("b.c")
      .u32(first.length)
      .u64(0x2000)
      .uleb(3)
      .u32(abstractAt)
      .u64(0x2010)
      .u32(4)
      .uleb(0);
    const unitA = unit({ version: 4, dies: a.toBytes() });
    const { units, reader } = open(
      buildElf({
        sections: [
          section(
            ".debug_info",
            new Writer()
              .raw(unitA)
              .raw(unit({ version: 4, dies: b.toBytes() }))
              .toBytes(),
          ),
          section(".debug_abbrev", abbrev),
          section(".debug_line", new Writer().raw(first).raw(second).toBytes()),
        ],
      }),
    );
    const row = new FunctionIndex(reader, units).functions(units[1]!)[0]!;
    expect(row).toMatchObject({
      name: "orig",
      declLine: 9,
      nameFromOrigin: true,
    });
    // File 2 is a_origin.c in the declaring unit; unit B's own file 2 is b_second.c.
    expect(row.declFileName).toBe("a_origin.c");
  });
});

describe.skipIf(SYMBOL_TOOLS === null)(
  "bundles and fuzzing on producer output",
  () => {
    let macho: MachoBuild;
    let elf: ElfBuild;

    beforeAll(async () => {
      macho = await buildMacho(join(directory, "m"), "app", { dwarf: 5 });
      elf = await buildGoElf(join(directory, "g"), "goapp", {
        buildId: "00112233445566778899aabbccddeeff",
      });
    }, 300_000);

    const bundleCopy = async (name: string) => {
      const root = join(directory, name);
      const dwarf = join(root, "Contents/Resources/DWARF");
      await mkdir(dwarf, { recursive: true });
      await copyFile(macho.dwarfFile, join(dwarf, "app"));
      return { root, dwarf };
    };

    it("leaves out hidden and non-DWARF files in a .dSYM bundle instead of failing it", async () => {
      const { root, dwarf } = await bundleCopy("stray.dSYM");
      await writeFile(join(dwarf, "._app"), "appledouble");
      await writeFile(join(dwarf, "notes.txt"), "not a binary");
      const result = await provider.inspectSymbols(
        inspectDebugSymbolsInputSchema.parse({ path: root, member: "app" }),
      );
      if (!result.ok) throw result.error;
      expect(result.value.images).toHaveLength(1);
      const left = result.value.diagnostics.filter((item) =>
        /^bundle member/u.test(item.location ?? ""),
      );
      expect(left.map((item) => item.location).sort()).toEqual([
        "bundle member ._app",
        "bundle member notes.txt",
      ]);
    });

    it("does not follow a linked Contents folder out of the bundle", async () => {
      const outside = join(directory, "outside");
      await mkdir(join(outside, "Contents/Resources/DWARF"), {
        recursive: true,
      });
      await copyFile(
        macho.dwarfFile,
        join(outside, "Contents/Resources/DWARF/secret"),
      );
      const root = join(directory, "linked.dSYM");
      await mkdir(root, { recursive: true });
      await symlink(join(outside, "Contents"), join(root, "Contents"));
      const result = await provider.inspectSymbols(
        inspectDebugSymbolsInputSchema.parse({ path: root }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.error._tag).toBe("AnalysisUnsupportedTargetError");
    });

    /** Everything the tool does to one file, calling the readers directly so a stray RangeError shows. */
    const exercise = (bytes: Uint8Array): void => {
      let images;
      try {
        images = parseImages("/fuzz", bytes);
      } catch (cause) {
        if (
          cause instanceof AnalysisUnsupportedTargetError ||
          cause instanceof ArtifactOperationError
        )
          return;
        throw cause;
      }
      for (const image of images) {
        const sections = new DwarfSections(image, new DecodeBudget(1 << 26));
        if (image.relocatable) continue;
        const { units } = readUnitHeaders(sections);
        const reader = new UnitReader(sections);
        const index = new FunctionIndex(reader, units);
        for (const header of units.slice(0, 4)) {
          try {
            summarizeUnit(reader, header);
            index.functions(header);
            const table = index.lineTable(header);
            if (table !== null && "header" in table) {
              let rows = 0;
              runLineProgram(sections, table.header, () => ++rows > 500);
            }
          } catch (cause) {
            if (!(cause instanceof DebugFormatError)) throw cause;
          }
        }
      }
    };

    const fuzz = async (
      path: string,
      rounds: number,
      region: (size: number) => [number, number],
    ) => {
      const original = await readFile(path);
      let state = 0x9e3779b9;
      const random = () => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return (state >>> 0) / 0x100000000;
      };
      for (let round = 0; round < rounds; round += 1) {
        const mutated = Buffer.from(original);
        const [from, to] = region(mutated.length);
        for (let flips = 0; flips < 1 + Math.floor(random() * 6); flips += 1)
          mutated[from + Math.floor(random() * (to - from))] = Math.floor(
            random() * 256,
          );
        exercise(mutated);
      }
    };

    it("never throws anything but a typed failure when a dSYM is mutated anywhere", async () => {
      await fuzz(macho.dwarfFile, 400, (size) => [0, size]);
    }, 120_000);

    it("never throws anything but a typed failure when ELF headers, notes and section tables are mutated", async () => {
      await fuzz(elf.stripped, 400, (size) => [0, Math.min(size, 4096)]);
      await fuzz(elf.stripped, 200, (size) => [size - 2048, size]);
      await fuzz(elf.debug, 300, (size) => [0, Math.min(size, 1024)]);
      await fuzz(elf.debug, 300, (size) => [size - 1500, size]);
    }, 120_000);
  },
);
