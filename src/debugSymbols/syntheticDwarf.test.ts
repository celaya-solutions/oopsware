import { deflateSync, zstdCompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import {
  Writer,
  abbrevTable,
  buildElf,
  unit,
  type ElfSection,
} from "../../tests/fixtures/syntheticDwarf.js";
import { DW_AT, DW_FORM, DW_TAG } from "./dwarfConstants.js";
import { readLineHeader, runLineProgram, type LineRow } from "./dwarfLines.js";
import { FunctionIndex, summarizeUnit } from "./dwarfSymbols.js";
import { DwarfSections, UnitReader, readUnitHeaders } from "./dwarfUnits.js";
import { DecodeBudget } from "./image.js";
import { parseImages } from "./source.js";

/**
 * Hand-assembled images: no installed producer writes 64-bit DWARF, big-endian
 * images, GNU or zstd compressed sections, or these range and line encodings.
 */

const open = (bytes: Uint8Array) => {
  const [image] = parseImages("/synthetic", bytes);
  const sections = new DwarfSections(image!, new DecodeBudget(1 << 24));
  const { units, problems } = readUnitHeaders(sections);
  const reader = new UnitReader(sections);
  return { image: image!, sections, units, problems, reader };
};

const section = (name: string, data: Uint8Array): ElfSection => ({
  name,
  data,
});

/** A CU (name, low_pc) with one child subprogram (name, low_pc, high_pc as a length). */
const simple = (options: {
  readonly version: number;
  readonly little?: boolean;
  readonly addressSize?: number;
  readonly dwarf64?: boolean;
  readonly nameForm?: number;
  readonly strings?: Writer;
  readonly stringOffset?: (index: number) => number;
}) => {
  const little = options.little ?? true;
  const addressSize = options.addressSize ?? 8;
  const nameForm = options.nameForm ?? DW_FORM.string;
  const abbrev = abbrevTable(
    [
      {
        code: 1,
        tag: DW_TAG.compile_unit,
        children: true,
        attrs: [
          [DW_AT.name, nameForm],
          [DW_AT.low_pc, DW_FORM.addr],
          [DW_AT.language, DW_FORM.data1],
        ],
      },
      {
        code: 2,
        tag: DW_TAG.subprogram,
        children: false,
        attrs: [
          [DW_AT.name, DW_FORM.string],
          [DW_AT.low_pc, DW_FORM.addr],
          [DW_AT.high_pc, DW_FORM.data4],
          [DW_AT.decl_line, DW_FORM.data1],
        ],
      },
    ],
    little,
  );
  const dies = new Writer(little);
  dies.uleb(1);
  if (nameForm === DW_FORM.string) dies.cstr("unit.c");
  else
    dies.int(
      BigInt(options.stringOffset?.(0) ?? 0),
      options.dwarf64 === true ? 8 : 4,
    );
  dies.int(0x1000n, addressSize).u8(0x0c);
  dies.uleb(2).cstr("work").int(0x1010n, addressSize).u32(0x20).u8(7);
  dies.uleb(0);
  return {
    info: unit({
      version: options.version,
      dies: dies.toBytes(),
      addressSize,
      dwarf64: options.dwarf64,
      little,
    }),
    abbrev,
  };
};

describe("DWARF forms and unit formats", () => {
  it("reads 64-bit DWARF (8-byte offsets) with a string section name", () => {
    const strings = new Writer().cstr("ignored").cstr("big.c");
    const { info, abbrev } = simple({
      version: 5,
      dwarf64: true,
      nameForm: DW_FORM.strp,
      stringOffset: () => 8,
    });
    const { units, reader } = open(
      buildElf({
        sections: [
          section(".debug_info", info),
          section(".debug_abbrev", abbrev),
          section(".debug_str", strings.toBytes()),
        ],
      }),
    );
    expect(units).toHaveLength(1);
    expect(units[0]!.offsetSize).toBe(8);
    const summary = summarizeUnit(reader, units[0]!);
    expect(summary.name).toBe("big.c");
    expect(summary.offsetSize).toBe(8);
    expect(summary.language).toEqual({ code: 12, name: "C99" });
    const rows = new FunctionIndex(reader, units).functions(units[0]!);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: "work",
      lowPc: "0x1010",
      highPc: "0x1030",
      declLine: 7,
    });
  });

  it("reads a big-endian 32-bit image with DWARF 3", () => {
    const { info, abbrev } = simple({
      version: 3,
      little: false,
      addressSize: 4,
    });
    const { image, units, reader } = open(
      buildElf({
        wide: false,
        little: false,
        machine: 8,
        sections: [
          section(".debug_info", info),
          section(".debug_abbrev", abbrev),
        ],
      }),
    );
    expect(image).toMatchObject({
      architecture: "mips",
      bits: 32,
      littleEndian: false,
    });
    expect(units[0]).toMatchObject({ version: 3, addressSize: 4 });
    expect(summarizeUnit(reader, units[0]!).name).toBe("unit.c");
    expect(
      new FunctionIndex(reader, units).functions(units[0]!)[0],
    ).toMatchObject({
      name: "work",
      lowPc: "0x1010",
    });
  });
});

describe("compressed sections and malformed units", () => {
  it("decodes the same unit from zlib, zstd and GNU compressed sections", () => {
    const { info, abbrev } = simple({ version: 4 });
    const chdr = (type: number, data: Uint8Array, compressed: Uint8Array) =>
      new Writer()
        .u32(type)
        .u32(0)
        .u64(data.length)
        .u64(1)
        .raw(compressed)
        .toBytes();
    const SHF_COMPRESSED = 0x800;
    const gnu = (data: Uint8Array) =>
      new Writer(false)
        .raw(Buffer.from("ZLIB"))
        .u64(data.length)
        .raw(deflateSync(data))
        .toBytes();
    const variants: ElfSection[][] = [
      [
        {
          name: ".debug_info",
          data: chdr(1, info, deflateSync(info)),
          flags: SHF_COMPRESSED,
        },
        {
          name: ".debug_abbrev",
          data: chdr(1, abbrev, deflateSync(abbrev)),
          flags: SHF_COMPRESSED,
        },
      ],
      [
        {
          name: ".debug_info",
          data: chdr(2, info, zstdCompressSync(info)),
          flags: SHF_COMPRESSED,
        },
        {
          name: ".debug_abbrev",
          data: chdr(2, abbrev, zstdCompressSync(abbrev)),
          flags: SHF_COMPRESSED,
        },
      ],
      [
        { name: ".zdebug_info", data: gnu(info) },
        { name: ".zdebug_abbrev", data: gnu(abbrev) },
      ],
    ];
    const kinds: string[] = [];
    for (const sections of variants) {
      const { image, units, reader } = open(buildElf({ sections }));
      kinds.push(image.sections[0]!.compression);
      expect(image.sections[0]!.name).toBe(".debug_info");
      expect(summarizeUnit(reader, units[0]!).name).toBe("unit.c");
    }
    expect(kinds).toEqual(["zlib", "zstd", "zlib"]);
  });

  it("states a decompressed size that does not match the declared one", () => {
    const { info, abbrev } = simple({ version: 4 });
    const lying = new Writer()
      .u32(1)
      .u32(0)
      .u64(info.length + 5)
      .u64(1)
      .raw(deflateSync(info))
      .toBytes();
    const { sections, units } = open(
      buildElf({
        sections: [
          { name: ".debug_info", data: lying, flags: 0x800 },
          section(".debug_abbrev", abbrev),
        ],
      }),
    );
    expect(units).toEqual([]);
    expect([...sections.problems].join(" ")).toMatch(/declared|decompressed/u);
  });

  it("names an attribute form it does not know instead of guessing", () => {
    const abbrev = abbrevTable([
      {
        code: 1,
        tag: DW_TAG.compile_unit,
        children: false,
        attrs: [[DW_AT.name, 0x7f]],
      },
    ]);
    const info = unit({
      version: 4,
      dies: new Writer().uleb(1).u8(0).toBytes(),
    });
    const { units, reader } = open(
      buildElf({
        sections: [
          section(".debug_info", info),
          section(".debug_abbrev", abbrev),
        ],
      }),
    );
    const summary = summarizeUnit(reader, units[0]!);
    expect(summary.problem).toMatch(/form 0x7f is not supported/u);
  });

  it("reports an unsupported DWARF version on the unit", () => {
    const { info, abbrev } = simple({ version: 4 });
    const bytes = Uint8Array.from(info);
    bytes[4] = 9;
    const { units, reader } = open(
      buildElf({
        sections: [
          section(".debug_info", bytes),
          section(".debug_abbrev", abbrev),
        ],
      }),
    );
    expect(summarizeUnit(reader, units[0]!).problem).toMatch(/version 9/u);
  });

  it("keeps constants larger than a double as bigints without failing the unit", () => {
    const abbrev = abbrevTable([
      {
        code: 1,
        tag: DW_TAG.compile_unit,
        children: false,
        attrs: [
          [DW_AT.name, DW_FORM.string],
          [0x1c, DW_FORM.udata],
          [0x1d, DW_FORM.sdata],
        ],
      },
    ]);
    const dies = new Writer()
      .uleb(1)
      .cstr("big.c")
      .uleb(0xffffffffffffffffn)
      .sleb(-5)
      .toBytes();
    const { units, reader } = open(
      buildElf({
        sections: [
          section(".debug_info", unit({ version: 4, dies })),
          section(".debug_abbrev", abbrev),
        ],
      }),
    );
    expect(summarizeUnit(reader, units[0]!)).toMatchObject({
      name: "big.c",
      problem: null,
    });
  });
});

describe("address ranges", () => {
  const rangedUnit = (
    version: 4 | 5,
    listForm: number,
    listValue: number | bigint,
    extra: Writer,
  ) => {
    const abbrev = abbrevTable([
      {
        code: 1,
        tag: DW_TAG.compile_unit,
        children: true,
        attrs: [
          [DW_AT.low_pc, DW_FORM.addr],
          ...(version === 5
            ? ([[DW_AT.rnglists_base, DW_FORM.sec_offset]] as const)
            : []),
        ],
      },
      {
        code: 2,
        tag: DW_TAG.subprogram,
        children: false,
        attrs: [
          [DW_AT.name, DW_FORM.string],
          [DW_AT.ranges, listForm],
        ],
      },
    ]);
    const dies = new Writer().uleb(1).u64(0x1000);
    if (version === 5) dies.u32(12);
    dies.uleb(2).cstr("split");
    if (listForm === DW_FORM.rnglistx) dies.uleb(listValue);
    else dies.u32(Number(listValue));
    dies.uleb(0);
    return { abbrev, info: unit({ version, dies: dies.toBytes() }), extra };
  };

  it("resolves DWARF 4 .debug_ranges with a base address selection", () => {
    const list = new Writer()
      .u64(0x10)
      .u64(0x20)
      .u64(0x40)
      .u64(0x50)
      .u64(0xffffffffffffffffn)
      .u64(0x2000)
      .u64(0x4)
      .u64(0x8)
      .u64(0)
      .u64(0);
    const { abbrev, info } = rangedUnit(4, DW_FORM.sec_offset, 0, list);
    const { units, reader } = open(
      buildElf({
        sections: [
          section(".debug_info", info),
          section(".debug_abbrev", abbrev),
          section(".debug_ranges", list.toBytes()),
        ],
      }),
    );
    const row = new FunctionIndex(reader, units).functions(units[0]!)[0]!;
    expect(row.ranges).toEqual([
      { low: "0x1010", high: "0x1020" },
      { low: "0x1040", high: "0x1050" },
      { low: "0x2004", high: "0x2008" },
    ]);
    expect(row.rangeCount).toBe(3);
    expect(row.lowPc).toBe("0x1010");
  });

  it("resolves DWARF 5 .debug_rnglists through rnglistx and every entry kind", () => {
    const list = new Writer()
      .u8(5)
      .u64(0x3000)
      .u8(4)
      .uleb(0x10)
      .uleb(0x18)
      .u8(7)
      .u64(0x5000)
      .uleb(0x30)
      .u8(6)
      .u64(0x6000)
      .u64(0x6008)
      .u8(0);
    const header = new Writer().u32(0).u16(5).u8(8).u8(0).u32(1).u32(4);
    const body = header.toBytes();
    const full = new Writer().raw(body).raw(list.toBytes()).toBytes();
    const patched = new Writer()
      .u32(full.length - 4)
      .raw(full.subarray(4))
      .toBytes();
    const { abbrev, info } = rangedUnit(5, DW_FORM.rnglistx, 0, list);
    const { units, reader } = open(
      buildElf({
        sections: [
          section(".debug_info", info),
          section(".debug_abbrev", abbrev),
          section(".debug_rnglists", patched),
        ],
      }),
    );
    const row = new FunctionIndex(reader, units).functions(units[0]!)[0]!;
    expect(row.ranges).toEqual([
      { low: "0x3010", high: "0x3018" },
      { low: "0x5000", high: "0x5030" },
      { low: "0x6000", high: "0x6008" },
    ]);
  });

  it("fails the unit, not the call, when a range list offset is out of bounds", () => {
    const { abbrev, info } = rangedUnit(
      4,
      DW_FORM.sec_offset,
      9999,
      new Writer(),
    );
    const { units, reader } = open(
      buildElf({
        sections: [
          section(".debug_info", info),
          section(".debug_abbrev", abbrev),
          section(".debug_ranges", new Uint8Array(16)),
        ],
      }),
    );
    expect(() => new FunctionIndex(reader, units).functions(units[0]!)).toThrow(
      /range list/u,
    );
  });
});

describe("line programs", () => {
  const rows = (program: Uint8Array, version: number): LineRow[] => {
    const lineBody = new Writer().u16(version);
    const afterLength = new Writer()
      .u8(1) // minimum instruction length
      .u8(1) // default_is_stmt
      .u8(0xfb) // line_base -5
      .u8(14) // line_range
      .u8(10); // opcode_base: opcodes 10 and up are special
    for (const length of [0, 1, 1, 1, 1, 0, 0, 0, 1]) afterLength.u8(length);
    afterLength.u8(0); // no include directories
    afterLength.cstr("a.c").uleb(0).uleb(0).uleb(0).u8(0);
    lineBody.u32(afterLength.length).raw(afterLength.toBytes()).raw(program);
    const line = new Writer()
      .u32(lineBody.length)
      .raw(lineBody.toBytes())
      .toBytes();
    const { sections } = open(
      buildElf({ sections: [section(".debug_line", line)] }),
    );
    const parsed = readLineHeader(sections, 0, "/work", 8);
    expect(parsed.files.map((file) => file.path)).toEqual(["/work/a.c"]);
    const out: LineRow[] = [];
    runLineProgram(sections, parsed, (row) => {
      out.push(row);
    });
    return out;
  };

  it("runs a DWARF 2 program: special opcode at the old opcode base, const_add_pc, fixed_advance_pc, unknown extended opcodes", () => {
    const program = new Writer()
      .u8(0)
      .uleb(9)
      .u8(2)
      .u64(0x1000)
      .u8(20) // special: advance 0, line += -5 + 10
      .u8(8) // const_add_pc: (255 - 10) / 14 = 17
      .u8(3)
      .sleb(-2)
      .u8(1)
      .u8(9)
      .u16(0x100)
      .u8(2)
      .uleb(5)
      .u8(0)
      .uleb(8)
      .u8(3)
      .cstr("x.c")
      .uleb(0)
      .uleb(0)
      .uleb(0)
      .u8(0)
      .uleb(3)
      .u8(0x80)
      .u8(1)
      .u8(2)
      .u8(5)
      .uleb(7)
      .u8(6)
      .u8(1)
      .u8(0)
      .uleb(1)
      .u8(1)
      .toBytes();
    const result = rows(program, 2);
    expect(
      result.map((row) => [
        row.address,
        row.line,
        row.column,
        row.isStmt,
        row.endSequence,
      ]),
    ).toEqual([
      [0x1000n, 6, 0, true, false],
      [0x1011n, 4, 0, true, false],
      [0x1116n, 4, 7, false, false],
      [0x1116n, 4, 7, false, true],
    ]);
  });

  it("refuses a line table that runs past its section and one with a zero line range", () => {
    const bad = new Writer().u32(9999).u16(4).toBytes();
    const { sections } = open(
      buildElf({ sections: [section(".debug_line", bad)] }),
    );
    expect(() => readLineHeader(sections, 0, null, 8)).toThrow(/past the end/u);
  });
});

describe("ELF identifiers", () => {
  const note = (id: string) => {
    const desc = Buffer.from(id, "hex");
    return new Writer()
      .u32(4)
      .u32(desc.length)
      .u32(3)
      .cstr("GNU")
      .raw(desc)
      .pad(4)
      .toBytes();
  };

  it("reads a build id and a debug link, and says nothing when two build ids disagree", () => {
    const link = new Writer()
      .cstr("prog.debug")
      .pad(4)
      .u32(0xdeadbeef)
      .toBytes();
    const one = open(
      buildElf({
        sections: [
          { name: ".note.gnu.build-id", data: note("aabbccdd"), type: 7 },
          section(".gnu_debuglink", link),
        ],
      }),
    ).image;
    expect(one.identity.buildId).toBe("aabbccdd");
    expect(one.identity.debugLink).toEqual({
      name: "prog.debug",
      crc32: "deadbeef",
    });

    const two = open(
      buildElf({
        sections: [
          { name: ".note.gnu.build-id", data: note("aabbccdd"), type: 7 },
          { name: ".note.other", data: note("11223344"), type: 7 },
        ],
      }),
    ).image;
    expect(two.identity.buildId).toBeNull();
    expect(two.problems.join(" ")).toMatch(/Two different GNU build ids/u);
  });

  it("reads the build id from a program header when a file has no section headers", () => {
    // Section-less: an ELF header whose e_shoff is zero and one PT_NOTE segment.
    const noteBytes = note("0102030405060708");
    const out = new Writer();
    out
      .raw([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0])
      .raw(new Array<number>(8).fill(0));
    out.u16(3).u16(183).u32(1).u64(0).u64(64).u64(0).u32(0);
    out.u16(64).u16(56).u16(1).u16(64).u16(0).u16(0);
    out
      .u32(4)
      .u32(4)
      .u64(120)
      .u64(0)
      .u64(0)
      .u64(noteBytes.length)
      .u64(noteBytes.length)
      .u64(4);
    out.raw(noteBytes);
    const [image] = parseImages("/synthetic", out.toBytes());
    expect(image!.architecture).toBe("aarch64");
    expect(image!.identity.buildId).toBe("0102030405060708");
  });
});
