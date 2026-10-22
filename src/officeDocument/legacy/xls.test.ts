import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  inspectOfficeDocumentInputSchema,
  officeDocumentReportSchema,
  type OfficeCell,
  type OfficeDocumentReport,
  type OfficeRow,
} from "../../domain/officeDocument/officeDocument.js";
import {
  bof,
  buildXls,
  cells,
  eof,
  globals,
  hlink,
  ptg,
  record,
  sstRecords,
  type XlsSpec,
} from "../../../tests/fixtures/legacyXlsProducers.js";
import { OfficeDocumentProvider } from "../OfficeDocumentProvider.js";

const provider = new OfficeDocumentProvider();
let root: string;
let counter = 0;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "rea-xls-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const write = async (bytes: Uint8Array): Promise<string> => {
  const path = join(root, `${String((counter += 1))}.xls`);
  await writeFile(path, bytes);
  return path;
};

const inspect = async (
  path: string,
  input: object = {},
): Promise<OfficeDocumentReport> => {
  const result = await provider.inspectDocument(
    inspectOfficeDocumentInputSchema.parse({ path, limit: 500, ...input }),
  );
  if (!result.ok) throw result.error;
  return officeDocumentReportSchema.parse(result.value);
};

const failure = async (path: string): Promise<Error> => {
  const result = await provider.inspectDocument(
    inspectOfficeDocumentInputSchema.parse({ path }),
  );
  if (result.ok) throw new Error("Expected the inspection to fail.");
  return result.error;
};

const rows = (report: OfficeDocumentReport): OfficeRow[] =>
  report.items.filter((item): item is OfficeRow => item.kind === "row");

const cellMap = (report: OfficeDocumentReport): Map<string, OfficeCell> =>
  new Map(
    rows(report).flatMap((row) =>
      row.cells.map((cell): [string, OfficeCell] => [cell.ref, cell]),
    ),
  );

const sheet = (records: number[][], extra: Partial<XlsSpec> = {}): XlsSpec => ({
  sheets: [{ name: "Data", records }],
  ...extra,
});

describe("the BIFF8 fixture writer", () => {
  it("writes records, tokens and a split shared string table byte for byte as the spec lays them out", () => {
    expect(record(0x0203, [1, 2])).toEqual([0x03, 0x02, 0x02, 0x00, 1, 2]);
    expect(ptg.ref(0, 0)).toEqual([0x24, 0, 0, 0, 0xc0]);
    expect(ptg.ref(2, 3, { rowRel: false, colRel: false })).toEqual([
      0x24, 2, 0, 3, 0,
    ]);
    expect(ptg.refN(-1, -1)).toEqual([0x2c, 0xff, 0xff, 0xff, 0xc0]);
    expect(sstRecords(["ab"], 100)).toEqual([
      0xfc, 0, 13, 0, 1, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0x61, 0x62,
    ]);
    // 8 header bytes + 3 string-header bytes leave 1 byte: one character, then a CONTINUE with fHighByte 0.
    expect(sstRecords(["abc"], 12)).toEqual([
      0xfc, 0, 12, 0, 1, 0, 0, 0, 1, 0, 0, 0, 3, 0, 0, 0x61, 0x3c, 0, 3, 0, 0,
      0x62, 0x63,
    ]);
    expect(cells.rk(0, 0, 0, 0x3ff00000).slice(10)).toEqual([
      0x00, 0x00, 0xf0, 0x3f,
    ]);
  });
});

const cellSpec = sheet(
  [
    cells.labelSst(0, 0, 0, 0),
    cells.labelSst(0, 1, 0, 1),
    cells.labelSst(0, 2, 0, 2),
    cells.label(0, 3, 0, "inline"),
    cells.boolErr(0, 4, 0, 1, false),
    cells.boolErr(0, 5, 0, 0x07, true),
    cells.number(1, 0, 0, 3.5),
    cells.rk(1, 1, 0, 0x3ff00000),
    cells.rk(1, 2, 0, (123 << 2) | 3),
    cells.rk(1, 3, 0, ((-5 << 2) | 2) >>> 0),
    cells.rk(1, 4, 0, 0x40290001),
    cells.mulRk(1, 5, [
      [0, (7 << 2) | 2],
      [4, (250 << 2) | 3],
    ]),
    cells.number(2, 0, 1, 36526),
    cells.number(2, 1, 3, 45000.75),
    cells.number(2, 2, 2, 12.5),
    cells.blank(2, 3, 1),
    cells.mulBlank(2, 4, [1, 1]),
    cells.formula(3, 0, 0, 7, [...ptg.ref(1, 0), ...ptg.int(2), ...ptg.mul]),
    cells.formula(3, 1, 0, { string: true }, [
      ...ptg.str("x"),
      ...ptg.str("y"),
      ...ptg.concat,
    ]),
    cells.string("xy"),
    cells.formula(3, 2, 0, { boolean: true }, ptg.bool(true)),
    cells.formula(3, 3, 0, { error: 0x2a }, ptg.err(0x2a)),
    cells.formula(3, 4, 0, { empty: true }, ptg.str("")),
    cells.formula(3, 5, 0, 0, ptg.func(74)),
    cells.row(5, true),
    cells.number(5, 0, 0, 5),
    cells.labelSst(7, 0, 0, 99),
    cells.mergeCells(2),
    cells.note(0, 0),
  ],
  {
    strings: ["Name", "Größe", "€uro"],
    formats: [
      [164, '0.0" m"'],
      [165, "yyyy\\-mm\\-dd hh:mm"],
    ],
    xfs: [0, 14, 164, 165, 2],
  },
);

describe("legacy Excel cells", () => {
  it("types every cell record the way the Open XML reader does", async () => {
    const report = await inspect(await write(buildXls(cellSpec)), {
      view: "content",
      part: "sheet:1",
    });
    expect(rows(report).map((row) => row.row)).toEqual([1, 2, 3, 4, 6, 8]);
    const at = cellMap(report);
    const brief = (ref: string): unknown => {
      const cell = at.get(ref);
      return cell === undefined ? undefined : [cell.type, cell.value];
    };
    expect(["A1", "B1", "C1", "D1", "E1", "F1"].map(brief)).toEqual([
      ["string", "Name"],
      ["string", "Größe"],
      ["string", "€uro"],
      ["string", "inline"],
      ["boolean", "true"],
      ["error", "#DIV/0!"],
    ]);
    // RK: 0x3FF00000 is the high word of 1.0; 123 with fX100 is 1.23; 12.5's high word with fX100 is 0.125.
    expect(["A2", "B2", "C2", "D2", "E2", "F2", "G2"].map(brief)).toEqual([
      ["number", "3.5"],
      ["number", "1"],
      ["number", "1.23"],
      ["number", "-5"],
      ["number", "0.125"],
      ["number", "7"],
      ["number", "2.5"],
    ]);
    expect(at.get("G2")?.number_format).toBe("0.00");
    expect(at.get("A3")).toMatchObject({
      type: "date",
      value: "2000-01-01",
      serial: "36526",
      number_format: "mm-dd-yy",
    });
    expect(at.get("B3")).toMatchObject({
      type: "date",
      value: "2023-03-15T18:00:00",
      number_format: "yyyy\\-mm\\-dd hh:mm",
    });
    expect(at.get("C3")).toMatchObject({
      type: "number",
      value: "12.5",
      number_format: '0.0" m"',
    });
    expect(at.has("D3")).toBe(false);
    expect(at.get("A4")).toMatchObject({
      formula: "A2*2",
      formula_kind: "normal",
      value: "7",
      type: "number",
    });
    expect(at.get("B4")).toMatchObject({
      formula: '"x"&"y"',
      value: "xy",
      type: "string",
    });
    expect(at.get("C4")).toMatchObject({
      formula: "TRUE",
      value: "true",
      type: "boolean",
    });
    expect(at.get("D4")).toMatchObject({
      formula: "#N/A",
      value: "#N/A",
      type: "error",
    });
    expect(at.get("E4")).toMatchObject({
      formula: '""',
      value: "",
      type: "string",
    });
    expect(at.get("F4")).toMatchObject({ formula: "NOW()", value: "0" });
    expect(rows(report)[4]).toMatchObject({ row: 6, hidden: true });
    expect(at.get("A8")).toMatchObject({ type: "string", value: null });
    expect(
      report.diagnostics.map((entry) => entry.message).join(" "),
    ).toContain("Shared string 99 does not exist.");
    expect(report.omissions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "blank-cells", count: 3 }),
        expect.objectContaining({ kind: "comments", count: 1 }),
      ]),
    );
    expect(report.package.statistics).toMatchObject({
      formulas: 6,
      hidden_rows: 1,
      cells_scanned: 27,
      merged_ranges: 2,
      rows_with_values: 6,
    });
    const text = await inspect(await write(buildXls(cellSpec)), {
      view: "text",
    });
    expect(text.text).toContain(
      '| 4 | 7 {=A2*2} | xy {="x"&"y"} | true {=TRUE} | #N/A {=#N/A} | {=""} | 0 {=NOW()} |',
    );
  });

  it("honors the 1904 date system and the 1900 leap-year day", async () => {
    const report = await inspect(
      await write(
        buildXls(
          sheet([cells.number(0, 0, 1, 1462), cells.number(0, 1, 1, 0)], {
            preamble: [globals.date1904()],
            xfs: [0, 14],
          }),
        ),
      ),
      { view: "content" },
    );
    expect(
      rows(report)[0]?.cells.map((cell) => [cell.value, cell.serial]),
    ).toEqual([
      ["1908-01-02", "1462"],
      ["1904-01-01", "0"],
    ]);
    const leap = await inspect(
      await write(
        buildXls(sheet([cells.number(0, 0, 1, 60)], { xfs: [0, 14] })),
      ),
      {
        view: "content",
      },
    );
    expect(rows(leap)[0]?.cells[0]).toMatchObject({
      value: "1900-02-29",
      serial: "60",
    });
  });
});

describe("legacy Excel shared strings", () => {
  it("reads shared strings split across CONTINUE records, with runs and phonetic data skipped", async () => {
    const strings = [
      "A".repeat(100),
      `€${"B".repeat(60)}`,
      `${"C".repeat(50)}€`,
      { text: "rich", runs: 9 },
      { text: "phonetic", phonetic: 70 },
      "",
      "Z",
    ];
    const report = await inspect(
      await write(
        buildXls(
          sheet(
            strings.map((_, at) => cells.labelSst(at, 0, 0, at)),
            { strings, sstMax: 40 },
          ),
        ),
      ),
      { view: "content" },
    );
    expect(rows(report).map((row) => row.cells[0]?.value)).toEqual([
      "A".repeat(100),
      `€${"B".repeat(60)}`,
      `${"C".repeat(50)}€`,
      "rich",
      "phonetic",
      "",
      "Z",
    ]);
    expect(report.diagnostics).toEqual([]);
  });
});

describe("legacy Excel sheets and links", () => {
  const macroRecords = [
    cells.formula(0, 0, 0, 0, [...ptg.str("calc.exe"), ...ptg.funcVar(1, 110)]),
  ];
  const spec: XlsSpec = {
    sheets: [
      { name: "Hidden", state: 1, records: [cells.number(0, 0, 0, 1)] },
      {
        name: "Links",
        records: [
          hlink(1, 1, { url: "https://example.com/a?b=1" }),
          hlink(2, 1, { file: "docs\\report.doc", up: 1 }),
          hlink(3, 1, { location: "Hidden!A1" }),
          hlink(4, 1, { saved: "mailto:someone@example.com" }),
          cells.number(0, 0, 0, 2),
        ],
      },
      { name: "Very", state: 2 },
      { name: "Chart", kind: "chart" },
      { name: "Macro", kind: "macro", records: macroRecords },
      { name: "Dialog", kind: "dialog" },
      { name: "Module1", kind: "module" },
    ],
    links: [
      globals.supBookSelf(7),
      globals.supBook("\u0001\u0001C\u0003data\u0003prices.xls", ["Prices"]),
      globals.supBook("cmd\u0003/c calc"),
      globals.externName("A0"),
      globals.externSheet([[0, 0, 0]]),
      globals.name("Total"),
      globals.name("\u0001", true),
    ],
  };

  it("lists sheet kinds and states, declares macro sheets and links, and reads the first visible sheet", async () => {
    const path = await write(buildXls(spec));
    const overview = await inspect(path);
    expect(overview.package).toMatchObject({
      kind: "xls",
      family: "excel",
      macro_enabled: true,
    });
    expect(
      overview.content_parts.map((part) => [
        part.id,
        part.label,
        part.kind,
        part.hidden,
      ]),
    ).toEqual([
      ["sheet:1", "Hidden", "worksheet", true],
      ["sheet:2", "Links", "worksheet", false],
      ["sheet:3", "Very", "worksheet", true],
      ["sheet:4", "Chart", "chartsheet", false],
      ["sheet:5", "Macro", "macro-sheet", false],
      ["sheet:6", "Dialog", "dialog-sheet", false],
    ]);
    expect(overview.package.statistics).toMatchObject({
      sheets: 6,
      hidden_sheets: 2,
      macro_sheets: 1,
      vba_module_sheets: 1,
      defined_names: 2,
      external_workbooks: 1,
    });
    const body = [
      ...bof(0x40),
      ...record(0x0081, [0x00, 0x04]),
      ...macroRecords.flat(),
      ...eof(),
    ];
    expect(overview.package.notable).toEqual([
      expect.objectContaining({
        kind: "macro-sheet",
        part: "Macro",
        bytes: body.length,
        sha256: createHash("sha256")
          .update(Uint8Array.from(body))
          .digest("hex"),
      }),
    ]);
    expect(overview.package.external_references).toEqual([
      {
        source: "workbook",
        kind: "external-workbook",
        target: "C:\\data\\prices.xls",
        id: "1",
      },
      {
        source: "workbook",
        kind: "dde-or-ole-link",
        target: "cmd|/c calc",
        id: "2",
      },
      {
        source: "Links",
        kind: "hyperlink",
        target: "https://example.com/a?b=1",
        id: "B2",
      },
      {
        source: "Links",
        kind: "hyperlink",
        target: "..\\docs\\report.doc",
        id: "B3",
      },
      {
        source: "Links",
        kind: "hyperlink",
        target: "mailto:someone@example.com",
        id: "B5",
      },
    ]);
    expect(overview.diagnostics).toEqual([]);
    const first = await inspect(path, { view: "content" });
    expect(first.part?.id).toBe("sheet:2");
    expect(first.package.statistics).toMatchObject({ hyperlinks: 4 });
    const macro = await inspect(path, { view: "content", part: "sheet:5" });
    expect(rows(macro)[0]?.cells[0]?.formula).toBe('EXEC("calc.exe")');
    const chart = await inspect(path, { view: "content", part: "sheet:4" });
    expect(chart.items).toEqual([]);
    expect(chart.omissions.map((entry) => entry.kind)).toContain("chart-sheet");
  });

  it("refuses a password-protected workbook without trying a password", async () => {
    const error = await failure(
      await write(buildXls(sheet([], { preamble: [globals.filePass(1)] }))),
    );
    expect(error.message).toContain("password-protected");
    expect(error.message).toContain(
      "No password is tried and nothing is decrypted",
    );
  });

  it("names Excel 5.0/95 and older workbooks instead of reading them", async () => {
    expect(
      (await failure(await write(buildXls(sheet([]), "Book")))).message,
    ).toContain("Excel 5.0/95");
    expect(
      (await failure(await write(buildXls(sheet([], { version: 0x0500 })))))
        .message,
    ).toContain("Excel 5.0/95");
  });
});
