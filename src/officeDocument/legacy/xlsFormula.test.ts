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
  arrayExtra,
  buildXls,
  cells,
  globals,
  ptg,
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

const formulaCases: readonly [number[], number[], string][] = [
  [ptg.ref(0, 0, { rowRel: false, colRel: false }), [], "$A$1"],
  [
    [
      ...ptg.ref(0, 1, { rowRel: false }),
      ...ptg.ref(9, 2, { colRel: false }),
      ...ptg.add,
    ],
    [],
    "B$1+$C10",
  ],
  [[...ptg.area([0, 1], [0, 1]), ...ptg.funcVar(1, 4)], [], "SUM(A1:B2)"],
  [[...ptg.area([0, 2], [0, 0]), ...ptg.attrSum], [], "SUM(A1:A3)"],
  [
    [
      ...ptg.ref(0, 0),
      ...ptg.int(0),
      ...ptg.gt,
      ...ptg.attrIf(9),
      ...ptg.str("yes"),
      ...ptg.attrGoto(10),
      ...ptg.str("no"),
      ...ptg.attrGoto(3),
      ...ptg.funcVar(3, 1),
    ],
    [],
    'IF(A1>0,"yes","no")',
  ],
  [
    [
      ...ptg.int(2),
      ...ptg.attrChoose([4, 8, 12]),
      ...ptg.str("a"),
      ...ptg.attrGoto(8),
      ...ptg.str("b"),
      ...ptg.attrGoto(3),
      ...ptg.funcVar(3, 100),
    ],
    [],
    'CHOOSE(2,"a","b")',
  ],
  [
    [
      ...ptg.int(1),
      ...ptg.int(2),
      ...ptg.int(3),
      ...ptg.mul,
      ...ptg.add,
      ...ptg.paren,
      ...ptg.uminus,
      ...ptg.percent,
    ],
    [],
    "-(1+2*3)%",
  ],
  [[...ptg.num(1.5e21), ...ptg.num(0.25), ...ptg.div], [], "1.5E+21/0.25"],
  [
    [...ptg.num(3.14159), ...ptg.int(2), ...ptg.func(27)],
    [],
    "ROUND(3.14159,2)",
  ],
  [[...ptg.ref(0, 0), ...ptg.missArg, ...ptg.funcVar(2, 1)], [], "IF(A1,)"],
  [[...ptg.ref(0, 0), ...ptg.ref(1, 1), ...ptg.range], [], "A1:B2"],
  [
    [...ptg.ref(0, 0), ...ptg.ref(1, 1), ...ptg.union, ...ptg.paren],
    [],
    "(A1,B2)",
  ],
  [
    [...ptg.array, ...ptg.funcVar(1, 4)],
    arrayExtra([
      [1, "a"],
      [true, { error: 0x07 }],
    ]),
    'SUM({1,"a";TRUE,#DIV/0!})',
  ],
  [ptg.area([0, 0xffff], [0, 1]), [], "A:B"],
  [ptg.area([0, 1], [0, 0xff]), [], "1:2"],
  [[...ptg.name(1), ...ptg.int(1), ...ptg.add], [], "Total+1"],
  [ptg.name(2), [], "Print_Area"],
  [ptg.ref3d(0, 2, 1), [], "Sheet2!B3"],
  [ptg.area3d(1, [0, 1], [0, 1]), [], "'My Data'!$A$1:$B$2"],
  [ptg.ref3d(2, 0, 0), [], "'Sheet2:My Data'!A1"],
  [ptg.ref3d(3, 0, 0), [], "[1]Prices!A1"],
  [ptg.ref3d(6, 0, 0), [], "#REF!A1"],
  [ptg.refErr, [], "#REF!"],
  [
    [...ptg.nameX(4, 1), ...ptg.int(1), ...ptg.int(2), ...ptg.funcVar(3, 0xff)],
    [],
    "MYFUNC(1,2)",
  ],
  [ptg.nameX(5, 1), [], "cmd|'/c calc'!'A0'"],
  [
    [...ptg.ref(0, 0), ...ptg.attrSpace(1), ...ptg.int(1), ...ptg.add],
    [],
    "A1+1",
  ],
  [
    [...ptg.memFunc(11), ...ptg.ref(0, 0), ...ptg.ref(1, 1), ...ptg.range],
    [],
    "A1:B2",
  ],
  [ptg.str('say "hi"'), [], '"say ""hi"""'],
  [[...ptg.str("calc.exe"), ...ptg.funcVar(1, 110)], [], 'EXEC("calc.exe")'],
  [
    [...ptg.str("hi"), ...ptg.int(2), ...ptg.funcVar(2, 0x76, true)],
    [],
    'ALERT("hi",2)',
  ],
];

const linkGlobals = [
  globals.supBookSelf(3),
  globals.supBook("\u0001\u0001C\u0003data\u0003prices.xls", ["Prices"]),
  globals.supBookAddin(),
  globals.externName("MYFUNC"),
  globals.supBook("cmd\u0003/c calc"),
  globals.externName("A0"),
  globals.externSheet([
    [0, 1, 1],
    [0, 2, 2],
    [0, 1, 2],
    [1, 0, 0],
    [2, 0xfffe, 0xfffe],
    [3, 0xfffe, 0xfffe],
    [0, 0xffff, 0xffff],
  ]),
  globals.name("Total"),
  globals.name("\u0006", true),
];

describe("legacy Excel formulas", () => {
  it("decodes every formula token into the text Excel writes", async () => {
    const spec: XlsSpec = {
      sheets: [
        {
          name: "Formulas",
          records: formulaCases.map(([rgce, extra], at) =>
            cells.formula(at, 0, 0, 0, rgce, extra),
          ),
        },
        { name: "Sheet2" },
        { name: "My Data" },
      ],
      links: linkGlobals,
    };
    const report = await inspect(await write(buildXls(spec)), {
      view: "content",
    });
    expect(rows(report).map((row) => row.cells[0]?.formula)).toEqual(
      formulaCases.map(([, , text]) => text),
    );
    expect(report.diagnostics).toEqual([]);
  });

  it("anchors shared, array and data-table formulas on their first cell", async () => {
    const records = [
      cells.formula(0, 1, 0, 2, ptg.exp(0, 1), [], 0x08),
      cells.shrFmla(
        [0, 2],
        [1, 1],
        [...ptg.refN(0, -1), ...ptg.int(1), ...ptg.add],
      ),
      cells.formula(0, 3, 0, 10, ptg.exp(0, 3)),
      cells.array(
        [0, 1],
        [3, 3],
        [
          ...ptg.area([0, 1], [0, 0]),
          ...ptg.area([0, 1], [1, 1]),
          ...ptg.mul,
          ...ptg.funcVar(1, 4),
        ],
      ),
      cells.formula(0, 5, 0, 1, ptg.tbl(0, 5)),
      cells.table([0, 1], [5, 5]),
      cells.formula(0, 7, 0, 0, ptg.exp(0, 7), [], 0x08),
      cells.shrFmla([0, 0], [7, 7], ptg.refN(-1, 1)),
      cells.formula(1, 1, 0, 3, ptg.exp(0, 1), [], 0x08),
      cells.formula(1, 3, 0, 10, ptg.exp(0, 3)),
      cells.formula(1, 5, 0, 2, ptg.tbl(0, 5)),
      cells.formula(2, 1, 0, 4, ptg.exp(0, 1), [], 0x08),
      cells.formula(4, 0, 0, 1, ptg.exp(9, 9), [], 0x08),
    ];
    const at = cellMap(
      await inspect(await write(buildXls(sheet(records))), { view: "content" }),
    );
    const fields = (ref: string): unknown => {
      const cell = at.get(ref);
      return [
        cell?.formula,
        cell?.formula_kind,
        cell?.formula_from,
        cell?.value,
      ];
    };
    expect(["B1", "B2", "B3"].map(fields)).toEqual([
      ["A1+1", "shared", null, "2"],
      [null, "shared", "B1", "3"],
      [null, "shared", "B1", "4"],
    ]);
    expect(["D1", "D2"].map(fields)).toEqual([
      ["SUM(A1:A2*B1:B2)", "array", null, "10"],
      [null, "array", "D1", "10"],
    ]);
    expect(["F1", "F2"].map(fields)).toEqual([
      [null, "data-table", null, "1"],
      [null, "data-table", "F1", "2"],
    ]);
    // A relative row offset of -1 from row 1 wraps to the last row, as RgceLocRel says.
    expect(fields("H1")).toEqual(["I65536", "shared", null, "0"]);
    expect(fields("A5")).toEqual([null, "shared", "J10", "1"]);
  });

  it("keeps the cached value of a formula it cannot decode and says which token stopped it", async () => {
    const report = await inspect(
      await write(
        buildXls(
          sheet([
            cells.formula(0, 0, 0, 42, [
              ...ptg.elfLel,
              ...ptg.int(1),
              ...ptg.add,
            ]),
            cells.formula(1, 0, 0, 7, ptg.attrBaxcel),
            cells.formula(2, 0, 0, 1, [...ptg.funcVar(3, 4)]),
          ]),
        ),
      ),
      { view: "content" },
    );
    expect(
      rows(report).map((row) => [row.cells[0]?.formula, row.cells[0]?.value]),
    ).toEqual([
      [null, "42"],
      [null, "7"],
      [null, "1"],
    ]);
    expect(report.omissions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "undecoded-formulas", count: 3 }),
      ]),
    );
    expect(report.diagnostics).toHaveLength(1);
    expect(report.diagnostics[0]).toMatchObject({ location: "A1" });
    expect(report.diagnostics[0]?.message).toContain("0x18");
  });
});
