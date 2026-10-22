import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  inspectOfficeDocumentInputSchema,
  officeDocumentReportSchema,
  type OfficeDocumentReport,
  type OfficeRow,
} from "../../domain/officeDocument/officeDocument.js";
import {
  bof,
  buildXls,
  cells,
  eof,
  globals,
  le16,
  le32,
  ptg,
  rawXls,
  record,
  workbookStream,
  type Bytes,
  type XlsSpec,
} from "../../../tests/fixtures/legacyXlsProducers.js";
import { OfficeDocumentProvider } from "../OfficeDocumentProvider.js";

const provider = new OfficeDocumentProvider();
let root: string;
let counter = 0;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "rea-xls-hostile-"));
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

/** Globals BOF, the given globals records, one BoundSheet8 pointing just after the globals EOF, then the sheet. */
const handMade = (
  globalRecords: Bytes[],
  sheetRecords: Bytes[],
): Uint8Array => {
  const head = [...bof(0x0005), ...globalRecords.flat()];
  const boundSize = 4 + 4 + 2 + 2 + 4;
  const position = head.length + boundSize + 4;
  return Uint8Array.from([
    ...head,
    ...record(0x0085, [
      ...le32(position),
      0,
      0,
      4,
      0,
      ...[..."Data"].map((ch) => ch.charCodeAt(0)),
    ]),
    ...eof(),
    ...bof(0x0010),
    ...sheetRecords.flat(),
    ...eof(),
  ]);
};

/** Patch the lbPlyPos of the first BoundSheet8 record of a Workbook stream. */
const repoint = (stream: Uint8Array, position: number): Uint8Array => {
  const copy = Uint8Array.from(stream);
  const view = new DataView(copy.buffer);
  for (
    let at = 0;
    at + 4 <= copy.length;
    at += 4 + view.getUint16(at + 2, true)
  )
    if (view.getUint16(at, true) === 0x0085) {
      view.setUint32(at + 4, position, true);
      return copy;
    }
  throw new Error("no BoundSheet8 record");
};

describe("hostile legacy Excel workbooks", () => {
  it("reads a stream cut inside a cell record up to the cut", async () => {
    const stream = workbookStream(
      sheet([
        cells.number(0, 0, 0, 1),
        cells.number(1, 0, 0, 2),
        cells.number(2, 0, 0, 3),
      ]),
    );
    const report = await inspect(
      rawXls(stream.subarray(0, stream.length - 12)),
      { view: "content" },
    );
    expect(rows(report).map((row) => row.cells[0]?.value)).toEqual(["1", "2"]);
    expect(messages(report)).toContain("ends inside a record");
  });

  it("stops a shared string table that declares far more strings than it holds", async () => {
    const sst = record(0x00fc, [
      ...le32(0x7fffffff),
      ...le32(0x7fffffff),
      ...le16(1),
      0,
      0x61,
    ]);
    const report = await timed(() =>
      inspect(rawXls(handMade([sst], [cells.labelSst(0, 0, 0, 0)])), {
        view: "content",
      }),
    );
    expect(rows(report)[0]?.cells[0]?.value).toBe("a");
    expect(messages(report)).toContain(
      "declares 2147483647 strings but holds 1",
    );
    const long = record(0x00fc, [
      ...le32(1),
      ...le32(1),
      ...le16(0xffff),
      0,
      0x61,
      0x62,
    ]);
    const cut = await inspect(
      rawXls(handMade([long], [cells.labelSst(0, 0, 0, 0)])),
      { view: "content" },
    );
    expect(messages(cut)).toContain("cut off after 0 of 1 strings");
  });

  it("walks a long chain of empty CONTINUE records in bounded time", async () => {
    const sst = record(0x00fc, [...le32(1), ...le32(1), ...le16(3), 0, 0x61]);
    const chain = Array.from({ length: 100_000 }, () => record(0x003c));
    const tail = record(0x003c, [0, 0x62, 0x63]);
    const report = await timed(() =>
      inspect(
        rawXls(handMade([sst, ...chain, tail], [cells.labelSst(0, 0, 0, 0)])),
        { view: "content" },
      ),
    );
    expect(rows(report)[0]?.cells[0]?.value).toBe("abc");
  });

  it("names a two-byte character split across records and a string past its record", async () => {
    const sst = record(0x00fc, [...le32(1), ...le32(1), ...le16(2), 1, 0x41]);
    const split = record(0x003c, [1, 0x00, 0x42, 0x00]);
    const report = await inspect(
      rawXls(handMade([sst, split], [cells.labelSst(0, 0, 0, 0)])),
      { view: "content" },
    );
    expect(messages(report)).toContain("two-byte character is split");
  });

  it("keeps a sheet whose offset leads nowhere and says why", async () => {
    const stream = workbookStream(sheet([cells.number(0, 0, 0, 1)]));
    for (const position of [0, 3, stream.length + 100, 0xffffffff]) {
      const report = await inspect(rawXls(repoint(stream, position)), {
        view: "content",
      });
      expect(report.content_parts.map((part) => part.id)).toEqual(["sheet:1"]);
      expect(report.items).toEqual([]);
      expect(messages(report)).toContain("where no sheet begins");
    }
  });

  it("reads thousands of sheets that share one substream in linear time", async () => {
    const records = Array.from({ length: 20_000 }, (_, at) =>
      cells.number(at, 0, 0, at),
    );
    const spec: XlsSpec = {
      sheets: Array.from({ length: 2_000 }, (_, at) => ({
        name: `S${String(at)}`,
        records: at === 0 ? records : [],
      })),
    };
    const stream = workbookStream(spec);
    // Point every BoundSheet8 at the first sheet's substream.
    const view = new DataView(stream.buffer);
    let first = -1;
    for (
      let at = 0;
      at + 4 <= stream.length;
      at += 4 + view.getUint16(at + 2, true)
    ) {
      if (view.getUint16(at, true) !== 0x0085) continue;
      if (first < 0) first = view.getUint32(at + 4, true);
      view.setUint32(at + 4, first, true);
    }
    const overview = await timed(() => inspect(rawXls(stream)));
    expect(overview.content_parts).toHaveLength(2_000);
    const report = await inspect(rawXls(stream), {
      view: "content",
      part: "sheet:1999",
    });
    expect(report.total).toBe(20_000);
  });

  it("refuses every malformed formula token stream without guessing", async () => {
    const tooLong = cells.formula(0, 0, 0, 1, ptg.int(1));
    tooLong[24] = 0xff; // cce past the record
    const nested = [...ptg.int(1), ...Array<number>(4000).fill(0x15)];
    const formulas = [
      tooLong,
      cells.formula(1, 0, 0, 2, ptg.funcVar(255, 4)),
      cells.formula(2, 0, 0, 3, nested),
      cells.formula(3, 0, 0, 4, [...ptg.int(1), 0x19, 0x04, 0xff, 0xff]),
      cells.formula(4, 0, 0, 5, [0x17, 200, 0, 0x61]),
      cells.formula(5, 0, 0, 6, [...ptg.int(1), ...ptg.int(2)]),
      cells.formula(6, 0, 0, 7, ptg.func(202)),
      cells.formula(7, 0, 0, 8, [...ptg.exp(7, 0)]),
      cells.formula(8, 0, 0, 9, [0x24, 0, 0, 0x00, 0x01]),
    ];
    const report = await timed(() =>
      inspect(buildXls(sheet(formulas)), { view: "content" }),
    );
    expect(
      rows(report).map((row) => [
        row.cells[0]?.formula ?? null,
        row.cells[0]?.value,
      ]),
    ).toEqual([
      [null, "1"],
      [null, "2"],
      [`${`${"(".repeat(4000)}1${")".repeat(4000)}`.slice(0, 4096)}…`, "3"],
      [null, "4"],
      [null, "5"],
      [null, "6"],
      [null, "7"],
      [null, "8"],
      [null, "9"],
    ]);
    expect(report.omissions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "undecoded-formulas", count: 7 }),
      ]),
    );
  });
});

describe("hostile legacy Excel cells and records", () => {
  it("names a MULRK whose last column disagrees with its values, a column past IV and stored row disorder", async () => {
    const report = await inspect(
      buildXls(
        sheet([
          cells.number(5, 0, 0, 1),
          cells.mulRk(
            2,
            0,
            [
              [0, (1 << 2) | 2],
              [0, (2 << 2) | 2],
            ],
            9,
          ),
          cells.number(3, 300, 0, 4),
        ]),
      ),
      { view: "content" },
    );
    expect(
      rows(report).map((row) => [row.row, row.cells.map((cell) => cell.ref)]),
    ).toEqual([
      [6, ["A6"]],
      [3, ["A3", "B3"]],
    ]);
    const text = messages(report);
    expect(text).toContain("does not match its 2 values");
    expect(text).toContain("past the last BIFF8 column");
    expect(text).toContain("out of row order");
  });

  it("lists at most 2,000 cells per row and counts repeats past that", async () => {
    const report = await inspect(
      buildXls(
        sheet(Array.from({ length: 2_500 }, () => cells.number(0, 0, 0, 1))),
      ),
      { view: "content" },
    );
    expect(rows(report)[0]?.cells).toHaveLength(2_000);
    expect(report.omissions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "cells-past-row-limit", count: 500 }),
      ]),
    );
  });

  it("survives lone surrogates, short records and hostile link records", async () => {
    const lone = record(0x0204, [
      ...le16(0),
      ...le16(0),
      ...le16(0),
      ...le16(1),
      1,
      0x00,
      0xd8,
    ]);
    const hugeLink = record(0x01b8, [
      ...Array<number>(24).fill(0),
      ...le32(2),
      ...le32(0x101),
      ...le32(0x7fffffff),
      0x41,
      0,
    ]);
    const report = await inspect(
      rawXls(
        handMade(
          [
            record(0x0017, le16(0xffff)),
            record(0x01ae, [...le16(1), ...le16(0x0400)]),
          ],
          [
            lone,
            record(0x0203, [0, 0]),
            record(0x00fd, [0, 0, 0, 0]),
            hugeLink,
          ],
        ),
      ),
      { view: "content" },
    );
    expect(rows(report)[0]?.cells[0]?.value).toBe("\ud800");
    const text = messages(report);
    expect(text).toContain("ExternSheet record");
    expect(text).toContain("SupBook record");
    expect(text).toContain("NUMBER record");
    expect(text).toContain("LABELSST record");
    expect(text).toContain("hyperlink record");
  });

  it("refuses streams that are not BIFF8 workbooks, naming older versions", async () => {
    const fail = async (stream: Bytes): Promise<string> => {
      const result = await provider.inspectDocument(
        inspectOfficeDocumentInputSchema.parse({
          path: await write(rawXls(stream)),
        }),
      );
      if (result.ok) throw new Error("Expected a failure.");
      return result.error.message;
    };
    expect(await fail(record(0x0409, [0, 0, 0x10, 0]))).toContain("Excel 4.0");
    expect(await fail(record(0x0006, []))).toContain(
      "does not start with a BOF record",
    );
    expect(await fail([1, 2])).toContain(
      "empty or ends inside its first record",
    );
    expect(
      await fail(record(0x0809, [...le16(0x0600), ...le16(0x0010)])),
    ).toContain("does not begin with the workbook globals");
  });

  it("scans a megabyte of padding records after the sheets quickly", async () => {
    const stream = Uint8Array.from([
      ...workbookStream(sheet([cells.number(0, 0, 0, 1)])),
      ...new Uint8Array(1024 * 1024),
    ]);
    const report = await timed(() =>
      inspect(rawXls(stream), { view: "content" }),
    );
    expect(rows(report)).toHaveLength(1);
    expect(report.diagnostics).toEqual([]);
  });
});

describe("hostile legacy Excel formulas and links", () => {
  it("stops formula text that grows past its cap and a shared formula that points at itself", async () => {
    const long = "N".repeat(255);
    const names = [
      ...ptg.name(1),
      ...Array.from({ length: 129 }, () => [
        ...ptg.name(1),
        ...ptg.concat,
      ]).flat(),
    ];
    const report = await inspect(
      buildXls(
        sheet(
          [
            cells.formula(0, 0, 0, 1, names),
            cells.formula(1, 0, 0, 2, ptg.exp(1, 0), [], 0x08),
            cells.shrFmla([1, 1], [0, 0], ptg.exp(1, 0)),
          ],
          { links: [globals.name(long)] },
        ),
      ),
      { view: "content" },
    );
    expect(rows(report).map((row) => row.cells[0]?.formula ?? null)).toEqual([
      null,
      null,
    ]);
    expect(messages(report)).toContain("longer than 32768 characters");
    expect(report.omissions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "undecoded-formulas", count: 2 }),
      ]),
    );
  });

  it("keeps at most 65,536 external names and says so", async () => {
    const many = Array.from({ length: 65_600 }, () => globals.externName("F"));
    const report = await timed(() =>
      inspect(
        buildXls(sheet([], { links: [globals.supBookAddin(), ...many] })),
      ),
    );
    expect(messages(report)).toContain(
      "Only the first 65536 external sheet names and external names are kept.",
    );
  });
});
