import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import {
  inspectOfficeDocumentInputSchema,
  officeDocumentReportSchema,
  type OfficeDocumentReport,
  type OfficeRow,
} from "../../domain/officeDocument/officeDocument.js";
import {
  buildXls,
  cells,
  globals,
  hlink,
  le16,
  ptg,
  rawXls,
  record,
  workbookStream,
  type Bytes,
  type XlsSpec,
} from "../../../tests/fixtures/legacyXlsProducers.js";
import { OfficeDocumentProvider } from "../OfficeDocumentProvider.js";

/** Regressions from the review of the .xls reader: bounds, index slots, cancellation. */

const provider = new OfficeDocumentProvider();
let root: string;
let counter = 0;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "rea-xls-limits-"));
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
  bytes: Uint8Array,
  input: object = {},
): Promise<OfficeDocumentReport> => {
  const result = await provider.inspectDocument(
    inspectOfficeDocumentInputSchema.parse({
      path: await write(bytes),
      limit: 5000,
      ...input,
    }),
  );
  if (!result.ok) throw result.error;
  return officeDocumentReportSchema.parse(result.value);
};

const timed = async <T>(work: () => Promise<T>): Promise<T> => {
  const started = performance.now();
  const value = await work();
  expect(performance.now() - started).toBeLessThan(1000);
  return value;
};

const rows = (report: OfficeDocumentReport): OfficeRow[] =>
  report.items.filter((item): item is OfficeRow => item.kind === "row");

const messages = (report: OfficeDocumentReport): string =>
  report.diagnostics.map((entry) => entry.message).join(" | ");

const sheet = (records: Bytes[], extra: Partial<XlsSpec> = {}): XlsSpec => ({
  sheets: [{ name: "Data", records }],
  ...extra,
});

const formulas = (report: OfficeDocumentReport): (string | null)[] =>
  rows(report).map((row) => row.cells[0]?.formula ?? null);

describe("legacy Excel link and formula bounds", () => {
  it("refuses file monikers that climb past 255 folders and caps every target at 2,000 characters", async () => {
    const climbing = Array.from({ length: 2_000 }, (_, at) =>
      hlink(at, 0, { file: "x.doc", up: 65_535 }),
    );
    const long = [
      hlink(0, 1, { file: "f".repeat(3_000), up: 2 }),
      hlink(1, 1, { url: `https://example.com/${"u".repeat(3_000)}` }),
    ];
    const report = await timed(() =>
      inspect(buildXls(sheet([...climbing, ...long]))),
    );
    expect(messages(report)).toContain("climbs 65535 parent folders");
    expect(report.package.external_references).toHaveLength(2);
    for (const link of report.package.external_references) {
      expect(link.target.length).toBe(2_001);
      expect(link.target.endsWith("…")).toBe(true);
    }
    expect(
      report.package.external_references[0]?.target.startsWith("..\\..\\fff"),
    ).toBe(true);
  });

  it("caps the text a formula stacks up and builds each 3-D sheet prefix once", async () => {
    const union = (count: number): Bytes => [
      ...ptg.ref3d(0, 0, 0),
      ...Array.from({ length: count - 1 }, () => [
        ...ptg.ref3d(0, 0, 0),
        ...ptg.union,
      ]).flat(),
    ];
    const links = (name: string): Bytes[] => [
      globals.supBook("\u0001\u0001C\u0003book.xls", [name]),
      globals.externSheet([[0, 0, 0]]),
    ];
    const huge = await timed(() =>
      inspect(
        buildXls(
          sheet(
            Array.from({ length: 100 }, (_, at) =>
              cells.formula(at, 0, 0, at, union(1_000)),
            ),
            { links: links("S".repeat(30_000)) },
          ),
        ),
        { view: "content" },
      ),
    );
    expect(formulas(huge).every((text) => text === null)).toBe(true);
    expect(messages(huge)).toContain("longer than 32768 characters");
    const fine = await timed(() =>
      inspect(
        buildXls(
          sheet(
            Array.from({ length: 200 }, (_, at) =>
              cells.formula(at, 0, 0, at, union(1_000)),
            ),
            { links: links("S".repeat(20)) },
          ),
        ),
        { view: "content" },
      ),
    );
    expect(formulas(fine)).toHaveLength(200);
    expect(formulas(fine)[0]?.startsWith(`[1]${"S".repeat(20)}!A1,[1]`)).toBe(
      true,
    );
  });

  it("refuses a formula record longer than the 8,224 bytes BIFF8 allows", async () => {
    const tokens = [
      ...ptg.int(1),
      ...Array.from({ length: 2_100 }, () => [
        ...ptg.int(1),
        ...ptg.add,
      ]).flat(),
    ];
    const report = await inspect(
      buildXls(sheet([cells.formula(0, 0, 0, 5, tokens)])),
      { view: "content" },
    );
    expect(rows(report)[0]?.cells[0]).toMatchObject({
      formula: null,
      value: "5",
    });
    expect(messages(report)).toContain(
      "longer than the 8224 bytes BIFF8 allows",
    );
  });
});

describe("legacy Excel index slots of malformed globals records", () => {
  it("keeps a short XF record's slot so later cells keep their own formats", async () => {
    const report = await inspect(
      buildXls(
        sheet([cells.number(0, 0, 1, 36526), cells.number(0, 1, 2, 36526)], {
          preamble: [record(0x00e0, [0, 0])],
          xfs: [0, 14],
        }),
      ),
      { view: "content" },
    );
    expect(
      rows(report)[0]?.cells.map((cell) => [cell.type, cell.value]),
    ).toEqual([
      ["number", "36526"],
      ["date", "2000-01-01"],
    ]);
    expect(messages(report)).toContain("shorter than 4 bytes");
  });

  it("keeps the slots of malformed BoundSheet8, SupBook, ExternName and Lbl records", async () => {
    const spec: XlsSpec = {
      sheets: [
        {
          name: "Data",
          records: [
            cells.formula(0, 0, 0, 0, ptg.name(2)),
            cells.formula(1, 0, 0, 0, ptg.name(1)),
            cells.formula(2, 0, 0, 0, [
              ...ptg.nameX(1, 2),
              ...ptg.funcVar(1, 0xff),
            ]),
            cells.formula(3, 0, 0, 0, [
              ...ptg.nameX(1, 1),
              ...ptg.funcVar(1, 0xff),
            ]),
            cells.formula(4, 0, 0, 0, ptg.nameX(0, 1)),
            cells.formula(5, 0, 0, 0, ptg.ref3d(2, 0, 0)),
          ],
        },
        { name: "Other" },
      ],
      preamble: [record(0x0085, [0, 0])],
      links: [
        record(0x0018, [0, 0]),
        globals.name("Total"),
        record(0x01ae, [...le16(1), ...le16(0x0400)]),
        globals.externName("LOST"),
        globals.supBookAddin(),
        record(0x0023, [0]),
        globals.externName("GOOD"),
        globals.supBookSelf(3),
        globals.externSheet([
          [0, 0xfffe, 0xfffe],
          [1, 0xfffe, 0xfffe],
          [2, 2, 2],
        ]),
      ],
    };
    const report = await inspect(buildXls(spec), { view: "content" });
    expect(report.content_parts.map((part) => part.label)).toEqual([
      "Data",
      "Other",
    ]);
    expect(formulas(report)).toEqual([
      "Total",
      null,
      "GOOD()",
      null,
      null,
      "Other!A1",
    ]);
    const text = messages(report);
    for (const name of ["BoundSheet8", "Lbl (NAME)", "SupBook", "ExternName"])
      expect(text).toContain(`The ${name} record at offset`);
  });
});

describe("legacy Excel sheet ends, merge counts and cut text", () => {
  it("says when a sheet's records end without an EOF record", async () => {
    const stream = workbookStream(sheet([cells.number(0, 0, 0, 1)]));
    const report = await inspect(
      rawXls(stream.subarray(0, stream.length - 4)),
      { view: "content" },
    );
    expect(rows(report)).toHaveLength(1);
    expect(messages(report)).toContain("end without an EOF record");
  });

  it("counts no more merged ranges than the record holds", async () => {
    const report = await inspect(
      buildXls(
        sheet([
          record(0x00e5, [...le16(1000), 0, 0, 0, 0, 0, 0, 1, 0]),
          cells.number(0, 0, 0, 1),
        ]),
      ),
      { view: "content" },
    );
    expect(report.package.statistics).toMatchObject({ merged_ranges: 1 });
  });

  it("cuts long cell text without splitting a surrogate pair", async () => {
    const report = await inspect(
      buildXls(sheet([cells.label(0, 0, 0, `${"a".repeat(4_095)}😀tail`)])),
      {
        view: "content",
      },
    );
    expect(rows(report)[0]?.cells[0]?.value).toBe(`${"a".repeat(4_095)}…`);
  });
});

describe("cancelling a legacy Excel read", () => {
  it("stops a long sheet walk soon after the caller aborts", async () => {
    const records = Array.from({ length: 300_000 }, (_, at) =>
      cells.number(at & 0xffff, at >>> 16, 0, at),
    );
    const path = await write(buildXls(sheet(records)));
    const controller = new AbortController();
    let abortedAt = 0;
    setTimeout(() => {
      abortedAt = performance.now();
      controller.abort();
    }, 30);
    const result = await provider.inspectDocument(
      inspectOfficeDocumentInputSchema.parse({
        path,
        view: "content",
        limit: 1,
      }),
      { signal: controller.signal },
    );
    const finished = performance.now();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisCancelledError);
    expect(abortedAt).toBeGreaterThan(0);
    expect(finished - abortedAt).toBeLessThan(250);
  });
});
