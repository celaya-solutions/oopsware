import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  inspectOfficeDocumentInputSchema,
  officeDocumentReportSchema,
  type OfficeDocumentReport,
  type OfficeItem,
} from "../domain/officeDocument/officeDocument.js";
import {
  A,
  MAIN_TYPES,
  P,
  S,
  TEXTUTIL,
  W,
  buildPackage,
  compoundFile,
  para,
  relType,
  shape,
  sharedStrings,
  slide,
  textutilDocx,
  workbook,
  worksheet,
  wordDocument,
  zip,
  type PackageSpec,
} from "../../tests/fixtures/officeProducers.js";
import { OfficeDocumentProvider } from "./OfficeDocumentProvider.js";
import { formatSerial, isDateFormat } from "./xlsx.js";

const provider = new OfficeDocumentProvider();
let root: string;
let counter = 0;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "rea-office-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const write = async (
  name: string,
  bytes: Uint8Array | string,
): Promise<string> => {
  const path = join(root, `${String((counter += 1))}-${name}`);
  await writeFile(path, bytes);
  return path;
};

const inspect = async (
  path: string,
  input: object = {},
): Promise<OfficeDocumentReport> => {
  const result = await provider.inspectDocument(
    inspectOfficeDocumentInputSchema.parse({ path, ...input }),
  );
  if (!result.ok) throw result.error;
  return officeDocumentReportSchema.parse(result.value);
};

const failure = async (path: string, input: object = {}) => {
  const result = await provider.inspectDocument(
    inspectOfficeDocumentInputSchema.parse({ path, ...input }),
  );
  if (result.ok) throw new Error("Expected the inspection to fail.");
  return result.error;
};

const make = async (name: string, spec: PackageSpec): Promise<string> =>
  await write(name, await buildPackage(spec));

const items = <K extends OfficeItem["kind"]>(
  report: OfficeDocumentReport,
  kind: K,
): Extract<OfficeItem, { kind: K }>[] =>
  report.items.filter(
    (item): item is Extract<OfficeItem, { kind: K }> => item.kind === kind,
  );

const WORD_SPEC = {
  mainPath: "word/document.xml",
  mainType: MAIN_TYPES.docx,
} as const;

describe("Word documents", () => {
  it("reads a real textutil .docx and agrees with textutil's own text", async () => {
    if (TEXTUTIL === null) return;
    const made = await textutilDocx(
      root,
      "report",
      `<html><body><h1>Quarterly Report</h1><p>Hello <b>bold</b> and <a href="https://example.com/x?a=1&amp;b=2">a link</a>.</p><ul><li>one</li><li>two</li></ul><p>Tail line</p></body></html>`,
    );
    const report = await inspect(made.docx, { view: "text", limit: 200 });
    expect(report.package).toMatchObject({
      kind: "docx",
      family: "word",
      macro_enabled: false,
    });
    expect(report.package.conformance).toBe("transitional");
    const ours = report.text.join("\n").replace(/\s+/gu, " ").trim();
    for (const word of made.text.split(/\s+/u).filter(Boolean))
      expect(ours).toContain(word);
    const content = await inspect(made.docx, { view: "content" });
    const links = items(content, "paragraph").flatMap(
      (paragraph) => paragraph.links,
    );
    expect(links.length + items(content, "paragraph").length).toBeGreaterThan(
      3,
    );
  });

  it("reads styles, lists, links, fields, tracked changes and hidden text", async () => {
    const path = await make("rich.docx", {
      ...WORD_SPEC,
      main: wordDocument(
        [
          para("Title text", '<w:pStyle w:val="Heading1"/>'),
          para(
            "Item one",
            '<w:numPr><w:ilvl w:val="1"/><w:numId w:val="3"/></w:numPr>',
          ),
          `<w:p><w:hyperlink r:id="rIdLink"><w:r><w:t>site</w:t></w:r></w:hyperlink><w:r><w:t xml:space="preserve"> and </w:t></w:r><w:hyperlink w:anchor="mark"><w:r><w:t>inside</w:t></w:r></w:hyperlink></w:p>`,
          `<w:p><w:r><w:t xml:space="preserve">Total: </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> SUM(ABOVE) </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>42</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:fldSimple w:instr=" DATE "><w:r><w:t>today</w:t></w:r></w:fldSimple></w:p>`,
          `<w:p><w:r><w:t xml:space="preserve">Keep </w:t></w:r><w:ins w:id="1" w:author="a"><w:r><w:t>added</w:t></w:r></w:ins><w:del w:id="2" w:author="a"><w:r><w:delText>removed</w:delText></w:r></w:del></w:p>`,
          `<w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>secret</w:t></w:r></w:p>`,
          `<w:p><w:r><w:t>a</w:t><w:tab/><w:t>b</w:t><w:br/><w:t>c</w:t></w:r></w:p>`,
          `<w:p><m:oMath><m:r><m:t>x+y</m:t></m:r></m:oMath></w:p>`,
          `<w:p><w:r><w:drawing><wp:inline xmlns:wp="x"/></w:drawing></w:r></w:p>`,
          `<w:sdt><w:sdtContent><w:p><w:r><w:t>in control</w:t></w:r></w:p></w:sdtContent></w:sdt>`,
          `<mc:AlternateContent><mc:Choice><w:p><w:r><w:t>chosen</w:t></w:r></w:p></mc:Choice><mc:Fallback><w:p><w:r><w:t>fallback</w:t></w:r></w:p></mc:Fallback></mc:AlternateContent>`,
        ].join(""),
      ),
      mainLinks: [
        {
          id: "rIdLink",
          type: relType("hyperlink"),
          target: "https://example.com/",
          external: true,
        },
        { id: "rIdStyles", type: relType("styles"), target: "styles.xml" },
      ],
      parts: {
        "word/styles.xml": {
          type: "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml",
          data: `<w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>`,
        },
      },
    });
    const report = await inspect(path, { view: "content" });
    const paragraphs = items(report, "paragraph");
    expect(paragraphs[0]).toMatchObject({
      style: "heading 1",
      heading_level: 1,
      text: "Title text",
    });
    expect(paragraphs[1]).toMatchObject({ list_level: 1, text: "Item one" });
    expect(paragraphs[2]!.links).toEqual([
      { text: "site", target: "https://example.com/", external: true },
      { text: "inside", target: "#mark", external: false },
    ]);
    expect(paragraphs[3]).toMatchObject({
      text: "Total: 42today",
      fields: ["SUM(ABOVE)", "DATE"],
    });
    expect(paragraphs[4]).toMatchObject({
      text: "Keep added",
      revision: "mixed",
    });
    expect(paragraphs[5]).toMatchObject({ text: "secret", hidden: true });
    expect(paragraphs[6]!.text).toBe("a\tb\nc");
    expect(paragraphs[7]!.text).toBe("x+y");
    expect(paragraphs.map((entry) => entry.text)).toContain("in control");
    expect(paragraphs.map((entry) => entry.text)).toContain("chosen");
    expect(paragraphs.map((entry) => entry.text)).not.toContain("fallback");
    expect(report.omissions.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining(["drawing", "equation"]),
    );
    expect(report.package.statistics).toMatchObject({
      tracked_insertions: 1,
      tracked_deletions: 1,
      hidden_text_runs: 1,
    });
    const text = await inspect(path, { view: "text" });
    expect(text.text).toContain("# Title text");
    expect(text.text).toContain("  - Item one");
  });
});

describe("Word document parts", () => {
  it("reads tables, comments, footnotes, headers and selects a part", async () => {
    const path = await make("parts.docx", {
      ...WORD_SPEC,
      main: wordDocument(
        `<w:tbl><w:tr><w:tc><w:p><w:r><w:t>H1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>H|2</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>a</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>nested</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:tc><w:tc><w:p><w:r><w:t>b</w:t></w:r></w:p></w:tc></w:tr></w:tbl>${para("after")}`,
      ),
      mainLinks: [
        { id: "c", type: relType("comments"), target: "comments.xml" },
        { id: "f", type: relType("footnotes"), target: "footnotes.xml" },
        { id: "h", type: relType("header"), target: "header1.xml" },
      ],
      parts: {
        "word/comments.xml": {
          type: "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml",
          data: `<w:comments xmlns:w="${W}"><w:comment w:id="0" w:author="Ada" w:date="2026-01-02T03:04:05Z"><w:p><w:r><w:t>check this</w:t></w:r></w:p></w:comment></w:comments>`,
        },
        "word/footnotes.xml": {
          type: "application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml",
          data: `<w:footnotes xmlns:w="${W}"><w:footnote w:type="separator" w:id="-1"><w:p/></w:footnote><w:footnote w:id="1"><w:p><w:r><w:t>note text</w:t></w:r></w:p></w:footnote></w:footnotes>`,
        },
        "word/header1.xml": {
          type: "application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml",
          data: `<w:hdr xmlns:w="${W}"><w:p><w:r><w:t>Running head</w:t></w:r></w:p></w:hdr>`,
        },
      },
    });
    const overview = await inspect(path);
    expect(overview.content_parts.map((part) => part.id)).toEqual([
      "body",
      "comments",
      "footnotes",
      "header:header1.xml",
    ]);
    expect(overview.package.notable.map((entry) => entry.kind)).toContain(
      "comments",
    );
    const body = await inspect(path, { view: "content" });
    expect(items(body, "table")[0]).toMatchObject({
      rows: 2,
      columns: 2,
      cells: [
        ["H1", "H|2"],
        ["a\nnested", "b"],
      ],
    });
    const text = await inspect(path, { view: "text" });
    expect(text.text).toContain("| H1 | H\\|2 |");
    expect(
      items(
        await inspect(path, { view: "content", part: "comments" }),
        "comment",
      )[0],
    ).toMatchObject({
      author: "Ada",
      text: "check this",
    });
    expect(
      items(
        await inspect(path, { view: "content", part: "footnotes" }),
        "note",
      ),
    ).toHaveLength(1);
    expect(
      items(
        await inspect(path, { view: "content", part: "header:header1.xml" }),
        "paragraph",
      )[0]!.text,
    ).toBe("Running head");
    const error = await failure(path, { view: "content", part: "sheet:1" });
    expect(error._tag).toBe("AnalysisInputError");
  });

  it("pages items and keeps the totals honest", async () => {
    const path = await make("long.docx", {
      ...WORD_SPEC,
      main: wordDocument(
        Array.from({ length: 25 }, (_, at) => para(`line ${String(at)}`)).join(
          "",
        ),
      ),
    });
    const first = await inspect(path, { view: "content", limit: 10 });
    expect(first).toMatchObject({
      total: 25,
      page: { start: 0, returned: 10, next: 10 },
    });
    const last = await inspect(path, { view: "content", start: 20, limit: 10 });
    expect(last.page).toMatchObject({ returned: 5, next: null });
    expect(
      last.coverage.find((entry) => entry.facet === "inspect")?.state,
    ).toBe("complete");
    expect(
      first.coverage.find((entry) => entry.facet === "inspect"),
    ).toMatchObject({
      state: "partial",
      continuation: "Pass start=10 for the next page.",
    });
  });

  it("reads strict namespaces and a UTF-16 document part", async () => {
    const strictW = "http://purl.oclc.org/ooxml/wordprocessingml/main";
    const document = `<w:document xmlns:w="${strictW}"><w:body><w:p><w:r><w:t>strict text</w:t></w:r></w:p></w:body></w:document>`;
    const strict = await make("strict.docx", { ...WORD_SPEC, main: document });
    expect(
      items(await inspect(strict, { view: "content" }), "paragraph")[0]!.text,
    ).toBe("strict text");
    const utf16 = await make("utf16.docx", {
      ...WORD_SPEC,
      main: Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from(wordDocument(para("wide text")), "utf16le"),
      ]),
    });
    expect(
      items(await inspect(utf16, { view: "content" }), "paragraph")[0]!.text,
    ).toBe("wide text");
  });
});

const sheetSpec = (
  rows: string,
  extra?: Partial<PackageSpec>,
): PackageSpec => ({
  mainPath: "xl/workbook.xml",
  mainType: MAIN_TYPES.xlsx,
  main: workbook([{ name: "Data", id: "rId1" }]),
  mainLinks: [
    {
      id: "rId1",
      type: relType("worksheet"),
      target: "worksheets/sheet1.xml",
    },
    {
      id: "rIdSs",
      type: relType("sharedStrings"),
      target: "sharedStrings.xml",
    },
    { id: "rIdSt", type: relType("styles"), target: "styles.xml" },
  ],
  parts: {
    "xl/worksheets/sheet1.xml": {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml",
      data: worksheet(rows),
    },
    "xl/sharedStrings.xml": {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml",
      data: sharedStrings(
        "Name",
        `<r><t>Rich </t></r><r><t>text</t></r><rPh sb="0" eb="1"><t>PHONETIC</t></rPh>`,
      ),
    },
    "xl/styles.xml": {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml",
      data: `<styleSheet xmlns="${S}"><numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd hh:mm"/><numFmt numFmtId="165" formatCode="0.0&quot; m&quot;"/></numFmts><cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="165"/></cellXfs></styleSheet>`,
    },
  },
  ...extra,
});

describe("Excel workbooks", () => {
  it("types cells and keeps a formula apart from its cached value", async () => {
    const path = await make(
      "cells.xlsx",
      sheetSpec(
        [
          `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>inline</t><rPh><t>ph</t></rPh></is></c><c r="D1" t="b"><v>1</v></c><c r="E1" t="e"><v>#DIV/0!</v></c></row>`,
          `<row r="2"><c r="A2"><v>3.5</v></c><c r="B2"><f>A2*2</f><v>7</v></c><c r="C2" t="str"><f>"x"&amp;"y"</f><v>xy</v></c><c r="D2"><f>NOW()</f></c></row>`,
          `<row r="3"><c r="A3"><f t="shared" ref="A3:A5" si="0">B2+1</f><v>8</v></c><c r="B3"><f t="shared" si="0"/><v>9</v></c><c r="C3"><f t="array" ref="C3:C4">SUM(A2:A3)</f><v>11.5</v></c></row>`,
          `<row r="4"><c r="A4" s="1"><v>45000</v></c><c r="B4" s="2"><v>45000.75</v></c><c r="C4" s="3"><v>12.5</v></c></row>`,
          `<row r="5"><c r="A5" s="1"/><c r="B5" s="2"/></row>`,
          `<row r="6" hidden="1"><c r="A6"><v>5</v></c></row>`,
          `<row r="7"><c r="A7" t="s"><v>99</v></c></row>`,
        ].join(""),
      ),
    );
    const report = await inspect(path, { view: "content", part: "sheet:1" });
    const rows = items(report, "row");
    expect(rows.map((row) => row.row)).toEqual([1, 2, 3, 4, 6, 7]);
    expect(
      rows[0]!.cells.map((cell) => [cell.ref, cell.type, cell.value]),
    ).toEqual([
      ["A1", "string", "Name"],
      ["B1", "string", "Rich text"],
      ["C1", "inline-string", "inline"],
      ["D1", "boolean", "true"],
      ["E1", "error", "#DIV/0!"],
    ]);
    expect(rows[1]!.cells[1]).toMatchObject({
      formula: "A2*2",
      formula_kind: "normal",
      value: "7",
      type: "number",
    });
    expect(rows[1]!.cells[2]).toMatchObject({
      formula: '"x"&"y"',
      value: "xy",
      type: "string",
    });
    expect(rows[1]!.cells[3]).toMatchObject({ formula: "NOW()", value: null });
    expect(rows[2]!.cells[0]).toMatchObject({
      formula: "B2+1",
      formula_kind: "shared",
      formula_from: null,
    });
    expect(rows[2]!.cells[1]).toMatchObject({
      formula: null,
      formula_kind: "shared",
      formula_from: "A3",
      value: "9",
    });
    expect(rows[2]!.cells[2]).toMatchObject({ formula_kind: "array" });
    expect(rows[3]!.cells[0]).toMatchObject({
      type: "date",
      value: "2023-03-15",
      serial: "45000",
      number_format: "mm-dd-yy",
    });
    expect(rows[3]!.cells[1]).toMatchObject({
      type: "date",
      value: "2023-03-15T18:00:00",
      number_format: "yyyy\\-mm\\-dd hh:mm",
    });
    expect(rows[3]!.cells[2]).toMatchObject({
      type: "number",
      value: "12.5",
      number_format: '0.0" m"',
    });
    expect(rows[4]).toMatchObject({ hidden: true });
    expect(rows[4]!.cells[0]).toMatchObject({ value: "5" });
    expect(report.omissions.map((entry) => entry.kind)).toContain(
      "blank-cells",
    );
    expect(
      report.diagnostics.map((entry) => entry.message).join(" "),
    ).toContain("Shared string 99");
    expect(report.package.statistics).toMatchObject({
      formulas: 6,
      hidden_rows: 1,
    });
    const text = await inspect(path, { view: "text" });
    expect(text.text).toContain(
      '| 2 | 3.5 | 7 {=A2*2} | xy {="x"&"y"} | {=NOW()} |',
    );
  });
});

describe("Excel sheets and dates", () => {
  it("lists every sheet kind and state, and reads the first visible sheet by default", async () => {
    const path = await make("sheets.xlsx", {
      mainPath: "xl/workbook.xml",
      mainType: MAIN_TYPES.xlsx,
      main: workbook(
        [
          { name: "Hidden", id: "r1", state: "hidden" },
          { name: "Shown", id: "r2" },
          { name: "Very", id: "r3", state: "veryHidden" },
          { name: "Chart", id: "r4" },
          { name: "Macro", id: "r5" },
        ],
        `<definedNames><definedName name="Total">Shown!$A$1</definedName></definedNames><externalReferences><externalReference r:id="r6"/></externalReferences>`,
        '<workbookPr date1904="1"/>',
      ),
      mainLinks: [
        {
          id: "r1",
          type: relType("worksheet"),
          target: "worksheets/sheet1.xml",
        },
        {
          id: "r2",
          type: relType("worksheet"),
          target: "worksheets/sheet2.xml",
        },
        {
          id: "r3",
          type: relType("worksheet"),
          target: "worksheets/sheet3.xml",
        },
        {
          id: "r4",
          type: relType("chartsheet"),
          target: "chartsheets/sheet1.xml",
        },
        {
          id: "r5",
          type: "http://schemas.microsoft.com/office/2006/relationships/xlMacrosheet",
          target: "macrosheets/sheet1.xml",
        },
        {
          id: "r6",
          type: relType("externalLink"),
          target: "externalLinks/externalLink1.xml",
        },
      ],
      partLinks: {
        "xl/externalLinks/externalLink1.xml": [
          {
            id: "x1",
            type: relType("externalLinkPath"),
            target: "file:///C:/data/other.xlsx",
            external: true,
          },
        ],
      },
      parts: {
        "xl/worksheets/sheet1.xml": {
          data: worksheet(`<row r="1"><c r="A1"><v>1</v></c></row>`),
        },
        "xl/worksheets/sheet2.xml": {
          data: worksheet(
            `<row r="1"><c r="A1" s="0"><v>1</v></c></row>`,
            `<mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells>`,
          ),
        },
        "xl/worksheets/sheet3.xml": { data: worksheet("") },
        "xl/chartsheets/sheet1.xml": { data: "<chartsheet/>" },
        "xl/macrosheets/sheet1.xml": {
          type: "application/vnd.ms-excel.macrosheet+xml",
          data: worksheet(
            `<row r="1"><c r="A1"><f>EXEC("calc.exe")</f></c></row>`,
          ),
        },
        "xl/externalLinks/externalLink1.xml": { data: "<externalLink/>" },
      },
    });
    const overview = await inspect(path);
    expect(
      overview.content_parts.map((part) => [part.id, part.kind, part.hidden]),
    ).toEqual([
      ["sheet:1", "worksheet", true],
      ["sheet:2", "worksheet", false],
      ["sheet:3", "worksheet", true],
      ["sheet:4", "chartsheet", false],
      ["sheet:5", "macro-sheet", false],
    ]);
    expect(overview.package.statistics).toMatchObject({
      sheets: 5,
      hidden_sheets: 2,
      macro_sheets: 1,
      defined_names: 1,
      external_workbooks: 1,
    });
    expect(overview.package.notable.map((entry) => entry.kind)).toContain(
      "macro-sheet",
    );
    expect(overview.package.external_references).toEqual([
      expect.objectContaining({
        kind: "externalLinkPath",
        target: "file:///C:/data/other.xlsx",
      }),
    ]);
    const first = await inspect(path, { view: "content" });
    expect(first.part?.id).toBe("sheet:2");
    expect(first.package.statistics).toMatchObject({ merged_ranges: 1 });
    const macro = await inspect(path, { view: "content", part: "sheet:5" });
    expect(items(macro, "row")[0]!.cells[0]).toMatchObject({
      formula: 'EXEC("calc.exe")',
    });
    const chart = await inspect(path, { view: "content", part: "sheet:4" });
    expect(chart.items).toEqual([]);
    expect(chart.omissions.map((entry) => entry.kind)).toContain("chart-sheet");
  });

  it("honors the 1904 date system declared by the workbook", async () => {
    const path = await make("dates1904.xlsx", {
      ...sheetSpec(`<row r="1"><c r="A1" s="1"><v>1462</v></c></row>`),
      main: workbook(
        [{ name: "Data", id: "rId1" }],
        "",
        '<workbookPr date1904="true"/>',
      ),
    });
    const report = await inspect(path, { view: "content" });
    expect(items(report, "row")[0]!.cells[0]).toMatchObject({
      value: "1908-01-02",
      serial: "1462",
    });
  });
});

describe("Excel dates and sheets", () => {
  it("converts serial dates in both systems, including the 1900 leap-year day", () => {
    expect(formatSerial(1, false)).toBe("1900-01-01");
    expect(formatSerial(59, false)).toBe("1900-02-28");
    expect(formatSerial(60, false)).toBe("1900-02-29");
    expect(formatSerial(61, false)).toBe("1900-03-01");
    expect(formatSerial(45000, false)).toBe("2023-03-15");
    expect(formatSerial(45000.5, false)).toBe("2023-03-15T12:00:00");
    expect(formatSerial(0.25, false)).toBe("06:00:00");
    expect(formatSerial(0, true)).toBe("1904-01-01");
    expect(formatSerial(1462, true)).toBe("1908-01-02");
    expect(formatSerial(1462, false)).toBe("1904-01-01");
    expect(formatSerial(-1, false)).toBeNull();
    expect(formatSerial(Number.NaN, false)).toBeNull();
    expect(formatSerial(3_000_000, false)).toBeNull();
    for (const code of [
      "yyyy-mm-dd",
      "h:mm AM/PM",
      "[h]:mm:ss",
      "dd/mm/yy",
      "[$-409]d-mmm",
    ])
      expect(isDateFormat(code), code).toBe(true);
    for (const code of [
      "General",
      "0.00",
      "#,##0",
      "0%",
      '0.0" m"',
      "[Red]0.00",
      "@",
      "0.00E+00",
    ])
      expect(isDateFormat(code), code).toBe(false);
  });
});

describe("PowerPoint presentations", () => {
  it("reads slides, titles, tables, notes, hidden slides and links", async () => {
    const path = await make("deck.pptx", {
      mainPath: "ppt/presentation.xml",
      mainType: MAIN_TYPES.pptx,
      main: `<p:presentation xmlns:p="${P}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="s1"/><p:sldId id="257" r:id="s2"/></p:sldIdLst></p:presentation>`,
      mainLinks: [
        { id: "s1", type: relType("slide"), target: "slides/slide1.xml" },
        { id: "s2", type: relType("slide"), target: "slides/slide2.xml" },
      ],
      partLinks: {
        "ppt/slides/slide1.xml": [
          {
            id: "n1",
            type: relType("notesSlide"),
            target: "../notesSlides/notesSlide1.xml",
          },
          {
            id: "l1",
            type: relType("slideLayout"),
            target: "../slideLayouts/slideLayout1.xml",
          },
          {
            id: "h1",
            type: relType("hyperlink"),
            target: "https://example.org/deck",
            external: true,
          },
        ],
      },
      parts: {
        "ppt/slides/slide1.xml": {
          type: "application/vnd.openxmlformats-officedocument.presentationml.slide+xml",
          data: slide(
            [
              shape("Title 1", ["Launch plan"], "title"),
              shape("Content", ["First point", "Second point"], "body"),
              `<p:grpSp><p:nvGrpSpPr/>${shape("Grouped", ["inside group"])}</p:grpSp>`,
              `<p:sp><p:nvSpPr><p:cNvPr id="9" name="Link"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:txBody><a:bodyPr/><a:p><a:r><a:rPr><a:hlinkClick r:id="h1"/></a:rPr><a:t>the deck</a:t></a:r></a:p></p:txBody></p:sp>`,
              `<p:graphicFrame><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>Q</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>Rev</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`,
              `<p:pic/>`,
            ].join(""),
          ),
        },
        "ppt/slides/slide2.xml": {
          data: slide(shape("Title", ["Appendix"], "ctrTitle"), ' show="0"'),
        },
        "ppt/notesSlides/notesSlide1.xml": {
          data: slide(
            `${shape("Slide Image", [""], "sldImg")}${shape("Notes", ["Say this aloud"], "body")}`,
          ),
        },
        "ppt/slideLayouts/slideLayout1.xml": {
          data: `<p:sldLayout xmlns:p="${P}"><p:cSld name="Title and Content"/></p:sldLayout>`,
        },
      },
    });
    const report = await inspect(path, { view: "content" });
    const slides = items(report, "slide");
    expect(slides).toHaveLength(2);
    expect(slides[0]).toMatchObject({
      number: 1,
      title: "Launch plan",
      layout: "Title and Content",
      notes: "Say this aloud",
      hidden: false,
      tables: [[["Q", "Rev"]]],
      links: [
        {
          text: "the deck",
          target: "https://example.org/deck",
          external: true,
        },
      ],
    });
    expect(slides[0]!.texts.map((entry) => entry.text)).toEqual([
      "First point\nSecond point",
      "inside group",
      "the deck",
    ]);
    expect(slides[1]).toMatchObject({
      number: 2,
      hidden: true,
      title: "Appendix",
    });
    expect(report.omissions.map((entry) => entry.kind)).toContain("picture");
    const overview = await inspect(path);
    expect(overview.package.statistics).toMatchObject({
      slides: 2,
      hidden_slides: 1,
      slides_with_notes: 1,
      tables: 1,
    });
    const text = await inspect(path, { view: "text" });
    expect(text.text).toContain("## Slide 1: Launch plan");
    expect(text.text).toContain("## Slide 2: Appendix (hidden)");
    expect(text.text).toContain("> Notes: Say this aloud");
    expect(A).toContain("drawingml");
  });
});

describe("package facts", () => {
  it("lists a macro project with its hash, flags a name that disagrees and reports external links", async () => {
    const vba = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3]);
    const path = await write(
      "invoice.docx",
      await buildPackage({
        mainPath: "word/document.xml",
        mainType: MAIN_TYPES.docm,
        main: wordDocument(para("macro body")),
        rootLinks: [
          {
            id: "sig",
            type: "http://schemas.openxmlformats.org/package/2006/relationships/digital-signature/origin",
            target: "_xmlsignatures/origin.sigs",
          },
        ],
        mainLinks: [
          {
            id: "vba",
            type: "http://schemas.microsoft.com/office/2006/relationships/vbaProject",
            target: "vbaProject.bin",
          },
          {
            id: "tpl",
            type: relType("attachedTemplate"),
            target: "https://evil.example/template.dotm",
            external: true,
          },
          {
            id: "ole",
            type: relType("oleObject"),
            target: "embeddings/oleObject1.bin",
          },
        ],
        parts: {
          "word/vbaProject.bin": {
            type: "application/vnd.ms-office.vbaProject",
            data: vba,
          },
          "word/embeddings/oleObject1.bin": {
            type: "application/vnd.openxmlformats-officedocument.oleObject",
            data: new Uint8Array([9, 9]),
          },
          "_xmlsignatures/origin.sigs": {
            type: "application/vnd.openxmlformats-package.digital-signature-origin",
            data: "",
          },
        },
        core: `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"><dc:title>Invoice</dc:title><dc:creator>Eve</dc:creator><cp:lastModifiedBy>Mallory</cp:lastModifiedBy><dcterms:created>2026-01-01T00:00:00Z</dcterms:created></cp:coreProperties>`,
        app: `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Microsoft Office Word</Application><Company>ACME</Company><TitlesOfParts><vt:vector xmlns:vt="x" size="1"><vt:lpstr>ignored</vt:lpstr></vt:vector></TitlesOfParts></Properties>`,
        custom: `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property fmtid="{D5CDD505}" pid="2" name="Reviewer"><vt:lpwstr>Bob</vt:lpwstr></property></Properties>`,
      }),
    );
    const report = await inspect(path);
    expect(report.package).toMatchObject({
      kind: "docm",
      macro_enabled: true,
      main_content_type: MAIN_TYPES.docm,
      name_conflict:
        "The file name says .docx; the main part's content type is docm.",
      properties: {
        core: {
          title: "Invoice",
          creator: "Eve",
          last_modified_by: "Mallory",
          created: "2026-01-01T00:00:00Z",
        },
        app: { Application: "Microsoft Office Word", Company: "ACME" },
        custom: [{ name: "Reviewer", type: "lpwstr", value: "Bob" }],
      },
    });
    const kinds = report.package.notable.map((entry) => entry.kind);
    expect(kinds).toEqual(
      expect.arrayContaining([
        "macro-project",
        "ole-object",
        "digital-signature",
      ]),
    );
    const project = report.package.notable.find(
      (entry) => entry.kind === "macro-project",
    )!;
    expect(project.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(project.note).toContain("not a safety verdict");
    expect(report.package.external_references).toEqual([
      expect.objectContaining({
        source: "word/document.xml",
        kind: "attachedTemplate",
        target: "https://evil.example/template.dotm",
      }),
    ]);
    expect(report.package.problems).toEqual([]);
  });

  it("flags a plain document type that carries a VBA project and a macro type that has none", async () => {
    const carried = await inspect(
      await make("carried.docx", {
        ...WORD_SPEC,
        main: wordDocument(para("x")),
        mainLinks: [
          {
            id: "v",
            type: "http://schemas.microsoft.com/office/2006/relationships/vbaProject",
            target: "vbaProject.bin",
          },
        ],
        parts: {
          "word/vbaProject.bin": {
            type: "application/vnd.ms-office.vbaProject",
            data: new Uint8Array([1]),
          },
        },
      }),
    );
    expect(carried.package.macro_enabled).toBe(false);
    expect(carried.package.problems.join(" ")).toContain(
      "carries a VBA project",
    );
    const empty = await inspect(
      await make("empty.docm", {
        mainPath: "word/document.xml",
        mainType: MAIN_TYPES.docm,
        main: wordDocument(para("x")),
      }),
    );
    expect(empty.package.problems.join(" ")).toContain(
      "has no VBA project part",
    );
  });
});

describe("package structure", () => {
  it("pages the parts view and reports an unknown main part type", async () => {
    const path = await make("odd.docx", {
      mainPath: "word/document.xml",
      mainType: "application/x-unknown+xml",
      main: wordDocument(para("x")),
      parts: Object.fromEntries(
        Array.from({ length: 5 }, (_, at) => [
          `extra/p${String(at)}.bin`,
          { data: new Uint8Array([at]) },
        ]),
      ),
    });
    const parts = await inspect(path, { view: "parts", limit: 3 });
    expect(parts).toMatchObject({ total: 7, page: { returned: 3, next: 3 } });
    expect(parts.parts[0]).toMatchObject({
      path: expect.any(String),
      encrypted: false,
    });
    expect(parts.package.kind).toBe("unknown");
    expect(parts.package.problems.join(" ")).toContain(
      "not a Word, Excel or PowerPoint document type",
    );
    expect(parts.content_parts).toEqual([]);
  });

  it("reports repeated ZIP member names and unreadable relationship parts without failing", async () => {
    const base = await buildPackage({
      ...WORD_SPEC,
      main: wordDocument(para("x")),
      mainLinks: [
        { id: "a", type: relType("hyperlink"), target: "x", external: true },
      ],
    });
    expect(base.length).toBeGreaterThan(0);
    const broken = await zip({
      "[Content_Types].xml": `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="${MAIN_TYPES.docx}"/></Types>`,
      "_rels/.rels": "<Relationships",
      "word/document.xml": wordDocument(para("still read")),
    });
    const report = await inspect(await write("broken-rels.docx", broken), {
      view: "content",
    });
    expect(report.package.problems.join(" ")).toContain("_rels/.rels");
    expect(report.package.main_part).toBeNull();
    expect(report.items).toEqual([]);
  });
});

describe("refusals and bounds", () => {
  it("refuses a password-protected package, a compound file that is not Office and a non-ZIP file", async () => {
    const ole = compoundFile(["EncryptedInfo", "EncryptedPackage"]);
    const encrypted = await failure(await write("locked.docx", ole));
    expect(encrypted._tag).toBe("AnalysisUnsupportedTargetError");
    expect(String((encrypted as { reason?: string }).reason)).toContain(
      "password-protected",
    );
    const other = await failure(
      await write("mail.doc", compoundFile(["__properties_version1.0"])),
    );
    expect(String((other as { reason?: string }).reason)).toContain(
      "not a Word, Excel or PowerPoint 97-2003 document",
    );
    const text = await failure(await write("plain.docx", "not a zip"));
    expect(String((text as { reason?: string }).reason)).toContain(
      "neither a ZIP package",
    );
  });

  it("refuses a ZIP without content types and a corrupt ZIP", async () => {
    const plain = await failure(
      await write("plain.zip", await zip({ "a.txt": "hi" })),
    );
    expect(plain._tag).toBe("AnalysisUnsupportedTargetError");
    const corrupt = await failure(
      await write(
        "corrupt.docx",
        Buffer.from("PK\u0003\u0004 truncated and broken"),
      ),
    );
    expect([
      "ArtifactOperationError",
      "AnalysisUnsupportedTargetError",
    ]).toContain(corrupt._tag);
  });

  it("names a part that is not well-formed or holds a DOCTYPE and still reads the rest", async () => {
    const path = await make("hostile.docx", {
      ...WORD_SPEC,
      main: `<?xml version="1.0"?><!DOCTYPE d [<!ENTITY e SYSTEM "file:///etc/passwd">]>${wordDocument(para("&e;"))}`,
      mainLinks: [
        { id: "c", type: relType("comments"), target: "comments.xml" },
      ],
      parts: {
        "word/comments.xml": {
          type: "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml",
          data: `<w:comments xmlns:w="${W}"><w:comment w:id="1"><w:p><w:r><w:t>fine</w:t></w:r></w:p></w:comment></w:comments>`,
        },
      },
    });
    const body = await inspect(path, { view: "content" });
    expect(body.items).toEqual([]);
    expect(body.diagnostics[0]!.message).toContain("DOCTYPE");
    expect(
      body.coverage.find((entry) => entry.facet === "inspect")?.state,
    ).toBe("partial");
    expect(
      items(
        await inspect(path, { view: "content", part: "comments" }),
        "comment",
      )[0]!.text,
    ).toBe("fine");
  });

  it("stops when the decompression budget runs out and says how to raise it", async () => {
    const path = await make("big.docx", {
      ...WORD_SPEC,
      main: wordDocument(
        Array.from({ length: 2000 }, () => para("filler filler filler")).join(
          "",
        ),
      ),
    });
    const report = await inspect(path, {
      view: "content",
      max_decoded_bytes: 2000,
    });
    expect(report.items).toEqual([]);
    expect(report.diagnostics[0]!.message).toContain("max_decoded_bytes");
    expect(
      report.coverage.find((entry) => entry.facet === "inspect"),
    ).toMatchObject({
      state: "partial",
      continuation: "Raise max_decoded_bytes (up to 2 GiB).",
    });
    const starved = await failure(path, { max_decoded_bytes: 10 });
    expect(starved._tag).toBe("AnalysisResourceConstraintError");
  });

  it("refuses a file over max_file_bytes", async () => {
    const path = await make("limit.docx", {
      ...WORD_SPEC,
      main: wordDocument(para("x")),
    });
    const error = await failure(path, { max_file_bytes: 100 });
    expect(error._tag).toBe("AnalysisResourceConstraintError");
  });
});
