import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  debugSymbolsReportSchema,
  inspectDebugSymbolsInputSchema,
  type DebugSymbolsReport,
} from "../domain/debugSymbols/debugSymbols.js";
import {
  SYMBOL_TOOLS,
  buildElf,
  buildElfObject,
  buildMacho,
  dwarfdump,
  type ElfBuild,
  type MachoBuild,
} from "../../tests/fixtures/debugSymbolProducers.js";
import { DebugSymbolsProvider } from "./DebugSymbolsProvider.js";
import { readMacho } from "./macho.js";

const provider = new DebugSymbolsProvider();

const inspect = async (input: object): Promise<DebugSymbolsReport> => {
  const result = await provider.inspectSymbols(
    inspectDebugSymbolsInputSchema.parse(input),
  );
  if (!result.ok) throw result.error;
  return debugSymbolsReportSchema.parse(result.value);
};

const inspectError = async (input: object) => {
  const result = await provider.inspectSymbols(
    inspectDebugSymbolsInputSchema.parse(input),
  );
  if (result.ok) throw new Error("Expected the inspection to fail.");
  return result.error;
};

/** One DIE as llvm-dwarfdump prints it. */
interface OracleDie {
  readonly offset: number;
  readonly tag: string;
  readonly attrs: ReadonlyMap<string, string>;
}

const oracleDies = (text: string): OracleDie[] => {
  const dies: OracleDie[] = [];
  let current: { offset: number; tag: string; attrs: Map<string, string> } | null = null;
  for (const line of text.split("\n")) {
    const start = /^0x([0-9a-f]+):\s+(DW_TAG_\w+)/u.exec(line);
    if (start !== null) {
      current = { offset: parseInt(start[1]!, 16), tag: start[2]!, attrs: new Map() };
      dies.push(current);
      continue;
    }
    const attribute = /^\s+(DW_AT_\w+)\s+\((.*)\)\s*$/u.exec(line);
    if (attribute !== null && current !== null && !current.attrs.has(attribute[1]!))
      current.attrs.set(attribute[1]!, attribute[2]!);
  }
  return dies;
};

/** llvm-dwarfdump prints non-ASCII bytes as three-digit octal escapes. */
const unescapeOctal = (text: string): string => {
  const bytes: number[] = [];
  for (let at = 0; at < text.length; ) {
    if (text[at] === "\\" && /^[0-7]{3}$/u.test(text.slice(at + 1, at + 4))) {
      bytes.push(parseInt(text.slice(at + 1, at + 4), 8));
      at += 4;
    } else {
      bytes.push(...Buffer.from(text[at]!, "utf8"));
      at += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
};

const quoted = (value: string | undefined): string | null => {
  if (value === undefined) return null;
  const match = /"((?:[^"\\]|\\.)*)"\)?$/u.exec(value);
  return match === null ? null : unescapeOctal(match[1]!);
};

const address = (value: string | undefined): bigint | null => {
  const match = value === undefined ? null : /^0x[0-9a-f]+/u.exec(value);
  return match === null ? null : BigInt(match[0]);
};

interface OracleRow {
  readonly address: bigint;
  readonly line: number;
  readonly column: number;
  readonly file: number;
  readonly isa: number;
  readonly discriminator: number;
  readonly flags: string;
}

/** Line table rows by the table's offset in .debug_line. */
const oracleLines = (text: string): Map<number, OracleRow[]> => {
  const tables = new Map<number, OracleRow[]>();
  let rows: OracleRow[] | null = null;
  for (const line of text.split("\n")) {
    const header = /^debug_line\[0x([0-9a-f]+)\]/u.exec(line);
    if (header !== null) {
      rows = [];
      tables.set(parseInt(header[1]!, 16), rows);
      continue;
    }
    const row =
      /^(0x[0-9a-f]+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*(.*)$/u.exec(
        line,
      );
    if (row !== null && rows !== null)
      rows.push({
        address: BigInt(row[1]!),
        line: Number(row[2]),
        column: Number(row[3]),
        file: Number(row[4]),
        isa: Number(row[5]),
        discriminator: Number(row[6]),
        flags: row[8]!.trim().split(/\s+/u).filter(Boolean).sort().join(" "),
      });
  }
  return tables;
};

const flagsOf = (row: DebugSymbolsReport["lines"][number]): string =>
  [
    row.is_stmt ? "is_stmt" : "",
    row.basic_block ? "basic_block" : "",
    row.end_sequence ? "end_sequence" : "",
    row.prologue_end ? "prologue_end" : "",
    row.epilogue_begin ? "epilogue_begin" : "",
  ]
    .filter(Boolean)
    .sort()
    .join(" ");

/** Every function of an image, paged by the tool itself. */
const allFunctions = async (path: string): Promise<DebugSymbolsReport["functions"]> => {
  const out: DebugSymbolsReport["functions"] = [];
  let start = 0;
  for (;;) {
    const page = await inspect({ path, view: "functions", start, limit: 500 });
    out.push(...page.functions);
    if (page.page.next === null) return out;
    start = page.page.next;
  }
};

let directory = "";
const machos = new Map<number, MachoBuild>();
let other: MachoBuild;
let fat: MachoBuild;
let elf: ElfBuild;
let elfOther: ElfBuild;
let elfNoId: ElfBuild;
let object: string;

const ID_A = "00112233445566778899aabbccddeeff";
const ID_B = "ffeeddccbbaa99887766554433221100";

beforeAll(async () => {
  if (SYMBOL_TOOLS === null) return;
  directory = await mkdtemp(join(tmpdir(), "rea-debug-symbols-"));
  for (const dwarf of [2, 3, 4, 5] as const)
    machos.set(dwarf, await buildMacho(join(directory, `m${dwarf}`), "app", { dwarf }));
  other = await buildMacho(join(directory, "other"), "app", { dwarf: 5, factor: 9 });
  fat = await buildMacho(join(directory, "fat"), "fat", {
    dwarf: 5,
    architectures: ["arm64", "x86_64"],
  });
  elf = await buildElf(join(directory, "elf"), "goapp", { buildId: ID_A });
  elfOther = await buildElf(join(directory, "elf-other"), "goapp", {
    buildId: ID_B,
    factor: 5,
  });
  elfNoId = await buildElf(join(directory, "elf-noid"), "goapp", { noBuildId: true });
  object = await buildElfObject(join(directory, "object"), "thing");
}, 600_000);

afterAll(async () => {
  if (directory !== "") await rm(directory, { recursive: true, force: true });
});

describe.skipIf(SYMBOL_TOOLS === null)("Mach-O dSYM against llvm-dwarfdump", () => {
  for (const dwarf of [2, 3, 4, 5] as const)
    describe(`DWARF ${dwarf}`, () => {
      it("lists the same units, functions and line rows as llvm-dwarfdump", async () => {
        const build = machos.get(dwarf)!;
        const report = await inspect({ path: build.dsym, view: "units" });
        expect(report.images).toHaveLength(1);
        expect(report.images[0]!.dwarf.state).toBe("dwarf");
        expect(report.images[0]!.dwarf.versions).toEqual([dwarf]);
        const dies = oracleDies(await dwarfdump(["--debug-info", build.dwarfFile]));
        const units = dies.filter((die) => die.tag === "DW_TAG_compile_unit");
        expect(report.units.map((unit) => unit.name)).toEqual(
          units.map((unit) => quoted(unit.attrs.get("DW_AT_name"))),
        );
        for (const [index, unit] of units.entries()) {
          expect(report.units[index]!.producer).toBe(quoted(unit.attrs.get("DW_AT_producer")));
          expect(report.units[index]!.language?.name).toBe("C++14");
          expect(report.units[index]!.low_pc).toBe(
            `0x${address(unit.attrs.get("DW_AT_low_pc"))!.toString(16)}`,
          );
        }

        const functions = await allFunctions(build.dsym);
        const expected = dies.filter(
          (die) =>
            die.tag === "DW_TAG_subprogram" && die.attrs.has("DW_AT_low_pc"),
        );
        expect(functions.map((row) => row.offset)).toEqual(
          expected.map((die) => die.offset),
        );
        for (const [index, die] of expected.entries()) {
          const row = functions[index]!;
          expect(BigInt(row.low_pc!)).toBe(address(die.attrs.get("DW_AT_low_pc")));
          expect(BigInt(row.high_pc!)).toBe(address(die.attrs.get("DW_AT_high_pc")));
        }
        // Names come through the specification and abstract-origin DIEs.
        expect(functions.map((row) => row.name).sort()).toEqual(
          ["area", "geo_helper", "main", "perimeter"].sort(),
        );
        const perimeter = functions.find((row) => row.name === "perimeter")!;
        expect(perimeter.linkage_name).toBe("_ZNK3geo5Shape9perimeterEi");
        expect(perimeter.name_from_origin).toBe(true);
        expect(perimeter.decl_file_name).toMatch(/app-a\.cpp$/u);
        expect(perimeter.decl_line).toBe(5);

        const tables = oracleLines(await dwarfdump(["--debug-line", build.dwarfFile]));
        for (const unit of report.units) {
          const mine = await inspect({
            path: build.dsym,
            view: "lines",
            unit: unit.index,
            limit: 10_000,
          });
          const theirs = tables.get(unit.stmt_list!)!;
          expect(mine.total).toBe(theirs.length);
          expect(
            mine.lines.map((row) => ({
              address: BigInt(row.address),
              line: row.line,
              column: row.column,
              file: row.file,
              isa: row.isa,
              discriminator: row.discriminator,
              flags: flagsOf(row),
            })),
          ).toEqual(theirs);
          for (const row of mine.lines)
            expect(row.file_path).not.toBeNull();
        }
      }, 60_000);
    });

  it("reports the UUID llvm-dwarfdump prints", async () => {
    const build = machos.get(5)!;
    const report = await inspect({ path: build.dwarfFile });
    const printed = /UUID: ([0-9A-F-]+) \(arm64\)/u.exec(
      await dwarfdump(["--uuid", build.dwarfFile]),
    );
    expect(report.images[0]!.identity.uuid).toBe(printed![1]);
    expect(report.images[0]!.file_type).toBe("dsym");
  });

  it("pages units and functions with a stable next", async () => {
    const build = machos.get(5)!;
    const first = await inspect({ path: build.dsym, view: "functions", limit: 3 });
    expect(first.total).toBe(4);
    expect(first.page).toMatchObject({ start: 0, returned: 3, next: 3 });
    const second = await inspect({
      path: build.dsym,
      view: "functions",
      start: 3,
      limit: 3,
    });
    expect(second.page).toMatchObject({ start: 3, returned: 1, next: null });
    const one = await inspect({ path: build.dsym, view: "functions", unit: 1 });
    expect(one.functions.map((row) => row.name)).toEqual(["geo_helper"]);
  });

  it("selects one slice of a universal dSYM and needs a choice otherwise", async () => {
    const both = await inspect({ path: fat.dsym });
    expect(both.images.map((image) => image.architecture).sort()).toEqual([
      "arm64",
      "x86_64",
    ]);
    expect(both.selection.state).toBe("ambiguous");
    expect(both.units).toEqual([]);
    const arm = await inspect({ path: fat.dsym, architecture: "arm64" });
    expect(arm.selection).toMatchObject({ state: "selected", by: "architecture" });
    expect(arm.units.length).toBeGreaterThan(0);
    const missing = await inspectError({ path: fat.dsym, architecture: "ppc" });
    expect(missing._tag).toBe("AnalysisInputError");
  });
});

describe.skipIf(SYMBOL_TOOLS === null)("Mach-O pairing", () => {
  it("matches a dSYM with the binary it came from by UUID", async () => {
    const build = machos.get(5)!;
    const report = await inspect({ path: build.dsym, binary: build.binary });
    const pairing = report.images[0]!.pairing!;
    expect(pairing).toMatchObject({
      verdict: "matched",
      strength: "strong",
      enrichment_allowed: true,
    });
    expect(pairing.checks.find((check) => check.kind === "uuid")!.status).toBe("matched");
  });

  it("refuses a binary built from different code even when the name is the same", async () => {
    const build = machos.get(5)!;
    const report = await inspect({ path: build.dsym, binary: other.binary });
    const pairing = report.images[0]!.pairing!;
    expect(pairing.verdict).toBe("mismatched");
    expect(pairing.enrichment_allowed).toBe(false);
    expect(pairing.checks.find((check) => check.kind === "uuid")!.status).toBe("mismatched");
    // The mismatched file is still inspected on its own.
    expect(report.units.length).toBeGreaterThan(0);
  });

  it("pairs each slice of a universal dSYM with the slice of the same architecture", async () => {
    const report = await inspect({ path: fat.dsym, binary: fat.binary });
    expect(report.binary!.images.map((image) => image.architecture).sort()).toEqual([
      "arm64",
      "x86_64",
    ]);
    for (const image of report.images) {
      expect(image.pairing!.verdict).toBe("matched");
      expect(image.pairing!.checks.find((c) => c.kind === "architecture")!.debug).toBe(
        image.architecture,
      );
    }
  });

  it("refuses an ELF binary for a Mach-O dSYM", async () => {
    const build = machos.get(5)!;
    const report = await inspect({ path: build.dsym, binary: elf.stripped });
    expect(report.images[0]!.pairing!.verdict).toBe("mismatched");
    expect(report.images[0]!.pairing!.enrichment_allowed).toBe(false);
  });
});

describe.skipIf(SYMBOL_TOOLS === null)("ELF debug files made by the Go linker", () => {
  it("reads compressed DWARF 5 and matches llvm-dwarfdump function for function", async () => {
    const report = await inspect({ path: elf.debug });
    const image = report.images[0]!;
    expect(image.format).toBe("elf");
    expect(image.architecture).toBe("x86_64");
    expect(image.dwarf.state).toBe("dwarf");
    expect(image.dwarf.sections.some((section) => section.compression === "zlib")).toBe(true);
    expect(image.identity.build_id).toBe(ID_A);

    const dies = oracleDies(await dwarfdump(["--debug-info", elf.debug]));
    const units = dies.filter((die) => die.tag === "DW_TAG_compile_unit");
    expect(image.dwarf.unit_count).toBe(units.length);
    const all = await inspect({ path: elf.debug, limit: units.length });
    expect(all.units.map((unit) => unit.name)).toEqual(
      units.map((unit) => quoted(unit.attrs.get("DW_AT_name"))),
    );

    const functions = await allFunctions(elf.debug);
    const expected = dies.filter(
      (die) => die.tag === "DW_TAG_subprogram" && die.attrs.has("DW_AT_low_pc"),
    );
    const byOffset = new Map(functions.map((row) => [row.offset, row]));
    for (const die of expected) {
      const row = byOffset.get(die.offset);
      expect(row, `function at ${die.offset}`).toBeDefined();
      expect(BigInt(row!.low_pc!)).toBe(address(die.attrs.get("DW_AT_low_pc")));
      expect(BigInt(row!.high_pc!)).toBe(address(die.attrs.get("DW_AT_high_pc")));
      if (die.attrs.has("DW_AT_name"))
        expect(row!.name).toBe(quoted(die.attrs.get("DW_AT_name")));
      else {
        // An out-of-line copy of an inlined function takes its name from the abstract origin.
        expect(die.attrs.has("DW_AT_abstract_origin")).toBe(true);
        expect(row!.name_from_origin).toBe(true);
        expect(row!.name).not.toBeNull();
      }
    }
    expect(functions.map((row) => row.name)).toEqual(
      expect.arrayContaining(["main.main", "main.Area", "main.helper", "main.Shape.Perimeter"]),
    );
  }, 120_000);

  it("matches line tables of the program's own unit", async () => {
    const report = await inspect({ path: elf.debug, limit: 1000 });
    const main = report.units.find((unit) => unit.name === "main")!;
    const tables = oracleLines(await dwarfdump(["--debug-line", elf.debug]));
    const mine = await inspect({
      path: elf.debug,
      view: "lines",
      unit: main.index,
      limit: 10_000,
    });
    const theirs = tables.get(main.stmt_list!)!;
    expect(mine.total).toBe(theirs.length);
    expect(
      mine.lines.map((row) => [BigInt(row.address), row.line, row.column, row.file, flagsOf(row)]),
    ).toEqual(theirs.map((row) => [row.address, row.line, row.column, row.file, row.flags]));
    expect(mine.line_files.some((file) => file.path.endsWith("main.go"))).toBe(true);
  }, 120_000);

  it("matches the stripped binary by build id and the debug link CRC-32", async () => {
    const report = await inspect({ path: elf.debug, binary: elf.stripped });
    const pairing = report.images[0]!.pairing!;
    expect(pairing).toMatchObject({ verdict: "matched", strength: "strong" });
    const kinds = Object.fromEntries(pairing.checks.map((c) => [c.kind, c.status]));
    expect(kinds).toMatchObject({ build_id: "matched", debug_link_crc: "matched" });
    expect(report.binary!.images[0]!.identity.debug_link!.name).toBe("goapp.debug");
  }, 120_000);

  it("refuses a different build with another build id", async () => {
    const report = await inspect({ path: elf.debug, binary: elfOther.stripped });
    expect(report.images[0]!.pairing).toMatchObject({
      verdict: "mismatched",
      enrichment_allowed: false,
    });
  }, 120_000);

  it("refuses a same-named debug file whose bytes the link does not record", async () => {
    // elfOther.debug has the name and shape the stripped binary links to, but other bytes.
    const swapped = join(directory, "swap");
    await mkdir(swapped, { recursive: true });
    await copyFile(elfOther.debug, join(swapped, "goapp.debug"));
    const report = await inspect({
      path: join(swapped, "goapp.debug"),
      binary: elf.stripped,
    });
    const pairing = report.images[0]!.pairing!;
    expect(pairing.verdict).toBe("mismatched");
    expect(pairing.enrichment_allowed).toBe(false);
  }, 120_000);

  it("leaves a file without a build id unverified unless the CRC-32 matches", async () => {
    const report = await inspect({ path: elfNoId.debug, binary: elfNoId.stripped });
    const pairing = report.images[0]!.pairing!;
    expect(pairing.checks.find((c) => c.kind === "build_id")!.status).toBe("unavailable");
    expect(pairing).toMatchObject({ verdict: "matched", strength: "weak" });
    const wrong = await inspect({ path: elfNoId.debug, binary: elf.stripped });
    expect(wrong.images[0]!.pairing!.enrichment_allowed).toBe(false);
  }, 120_000);

  it("names a stripped binary instead of reading nothing silently", async () => {
    const report = await inspect({ path: elf.stripped });
    expect(report.images[0]!.dwarf.state).toBe("none");
    expect(report.images[0]!.dwarf.reason).toMatch(/debuglink/u);
    expect(report.units).toEqual([]);
    expect(report.coverage.find((c) => c.facet === "inspect")!.state).toBe("partial");
    expect(report.diagnostics.length).toBeGreaterThan(0);
  });

  it("refuses a relocatable object whose DWARF needs relocations", async () => {
    const report = await inspect({ path: object });
    expect(report.images[0]!.dwarf.state).toBe("relocatable-object");
    expect(report.images[0]!.dwarf.reason).toMatch(/relocations/u);
  });

  it("reports the wrong architecture", async () => {
    const arm = await buildElf(join(directory, "elf-arm"), "goapp", {
      buildId: ID_A,
      arch: "arm64",
    });
    const report = await inspect({ path: elf.debug, binary: arm.stripped });
    const pairing = report.images[0]!.pairing!;
    expect(pairing.verdict).toBe("mismatched");
    expect(pairing.checks.find((c) => c.kind === "architecture")!.status).toBe("mismatched");
  }, 120_000);
});

describe.skipIf(SYMBOL_TOOLS === null)("inputs it does not read", () => {
  it("refuses a PDB, a directory that is not a bundle and plain text", async () => {
    const pdb = join(directory, "x.pdb");
    await writeFile(pdb, Buffer.from("Microsoft C/C++ MSF 7.00\r\n\u001aDS\0\0\0\0", "latin1"));
    expect((await inspectError({ path: pdb }))._tag).toBe("AnalysisUnsupportedTargetError");
    expect((await inspectError({ path: directory }))._tag).toBe(
      "AnalysisUnsupportedTargetError",
    );
    const text = join(directory, "x.txt");
    await writeFile(text, "not a binary");
    expect((await inspectError({ path: text }))._tag).toBe("AnalysisUnsupportedTargetError");
  });

  it("needs a unit for the lines view and rejects one that does not exist", async () => {
    expect(
      inspectDebugSymbolsInputSchema.safeParse({ path: "/x", view: "lines" }).success,
    ).toBe(false);
    const build = machos.get(5)!;
    expect(
      (await inspectError({ path: build.dsym, view: "lines", unit: 99 }))._tag,
    ).toBe("AnalysisInputError");
  });

  it("enforces the file budget and reports a decode budget as partial coverage", async () => {
    const error = await inspectError({ path: elf.debug, max_file_bytes: 1000 });
    expect(error._tag).toBe("AnalysisResourceConstraintError");
    const report = await inspect({ path: elf.debug, max_decoded_bytes: 10 });
    expect(report.images[0]!.dwarf.state).toBe("unreadable");
    expect(report.images[0]!.dwarf.reason).toMatch(/decode budget/u);
    const coverage = report.coverage.find((c) => c.facet === "inspect")!;
    expect(coverage.state).toBe("partial");
    expect(coverage.continuation).toMatch(/max_decoded_bytes/u);
  });
});

describe.skipIf(SYMBOL_TOOLS === null)("damaged files", () => {
  it("survives a truncated debug file and a damaged abbreviation table", async () => {
    const bytes = await readFile(elf.debug);
    const cut = join(directory, "cut.debug");
    await writeFile(cut, bytes.subarray(0, Math.floor(bytes.length / 2)));
    const truncated = await inspect({ path: cut });
    expect(truncated.images[0]!.dwarf.state).not.toBe("dwarf");
    expect(truncated.diagnostics.length).toBeGreaterThan(0);

    const build = machos.get(5)!;
    const macho = await readFile(build.dwarfFile);
    const section = readMacho(new Uint8Array(macho))[0]!.sections.find(
      (item) => item.name === ".debug_abbrev",
    )!;
    const broken = Buffer.from(macho);
    broken.fill(0xff, section.offset, section.offset + section.size);
    const damaged = join(directory, "damaged");
    await writeFile(damaged, broken);
    const report = await inspect({ path: damaged });
    expect(report.coverage.find((c) => c.facet === "inspect")!.state).toBe("partial");
  });

  it("never throws anything but a typed failure on mutated bytes", async () => {
    const seeds = [machos.get(5)!.dwarfFile, machos.get(3)!.dwarfFile];
    let state = 0x2545f491;
    const random = () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) / 0x100000000;
    };
    for (const seed of seeds) {
      const original = await readFile(seed);
      for (let round = 0; round < 150; round += 1) {
        const mutated = Buffer.from(original);
        for (let flips = 0; flips < 1 + Math.floor(random() * 8); flips += 1)
          mutated[Math.floor(random() * mutated.length)] = Math.floor(random() * 256);
        const path = join(directory, "fuzz");
        await writeFile(path, mutated);
        for (const view of ["units", "functions"] as const) {
          const result = await provider.inspectSymbols(
            inspectDebugSymbolsInputSchema.parse({ path, view }),
          );
          if (result.ok) debugSymbolsReportSchema.parse(result.value);
          else expect(["ArtifactOperationError", "AnalysisUnsupportedTargetError"]).toContain(
            result.error._tag,
          );
        }
      }
    }
  }, 120_000);
});
