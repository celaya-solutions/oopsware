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
  MAIN_TYPES,
  PKG_REL,
  P,
  S,
  W,
  XML_DECL,
  buildPackage,
  para,
  relType,
  shape,
  slide,
  workbook,
  worksheet,
  wordDocument,
  zip,
  type PackageSpec,
} from "../../tests/fixtures/officeProducers.js";
import { OfficeDocumentProvider } from "./OfficeDocumentProvider.js";
import { formatSerial } from "./xlsx.js";
import { parseXml } from "./xml.js";

const provider = new OfficeDocumentProvider();
let root: string;
let counter = 0;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "rea-office-hostile-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const write = async (name: string, bytes: Uint8Array): Promise<string> => {
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

const make = async (name: string, spec: PackageSpec): Promise<string> =>
  await write(name, await buildPackage(spec));

const items = <K extends OfficeItem["kind"]>(
  report: OfficeDocumentReport,
  kind: K,
): Extract<OfficeItem, { kind: K }>[] =>
  report.items.filter(
    (item): item is Extract<OfficeItem, { kind: K }> => item.kind === kind,
  );

const WORD = {
  mainPath: "word/document.xml",
  mainType: MAIN_TYPES.docx,
} as const;
const sheetLinks = [
  { id: "rId1", type: relType("worksheet"), target: "worksheets/sheet1.xml" },
];
const xlsx = (rows: string, extra: Partial<PackageSpec> = {}): PackageSpec => ({
  mainPath: "xl/workbook.xml",
  mainType: MAIN_TYPES.xlsx,
  main: workbook([{ name: "S", id: "rId1" }]),
  mainLinks: sheetLinks,
  parts: { "xl/worksheets/sheet1.xml": { data: worksheet(rows) } },
  ...extra,
});

describe("hostile XML", () => {
  it("resolves namespaces in near-linear time however many prefixes a parent declares", () => {
    const declarations = Array.from(
      { length: 3000 },
      (_, at) => `xmlns:p${String(at)}="urn:p${String(at)}"`,
    ).join(" ");
    const children = Array.from(
      { length: 10_000 },
      (_, at) => `<c xmlns:q${String(at % 50)}="urn:q"/>`,
    ).join("");
    const started = performance.now();
    const parsed = parseXml(`<r ${declarations}>${children}</r>`);
    expect(parsed.ok).toBe(true);
    expect(performance.now() - started).toBeLessThan(3000);
  });

  it("never reads an inherited property for an entity or a namespace", () => {
    for (const name of [
      "constructor",
      "__proto__",
      "toString",
      "hasOwnProperty",
    ]) {
      const entity = parseXml(`<r>&${name};</r>`);
      expect(entity.ok, name).toBe(false);
    }
    const strict = parseXml(`<a:r xmlns:a="constructor"/>`);
    expect(strict.ok && strict.value.ns).toBe("constructor");
    expect(parseXml("<r>a & b</r>").ok).toBe(false);
    expect(parseXml("<r a='x & y'/>").ok).toBe(false);
  });

  it("maps strict math to the transitional namespace", () => {
    const parsed = parseXml(
      `<m:oMath xmlns:m="http://purl.oclc.org/ooxml/officeDocument/math"/>`,
    );
    expect(parsed.ok && parsed.value.ns).toBe(
      "http://schemas.openxmlformats.org/officeDocument/2006/math",
    );
  });
});

describe("hostile packages", () => {
  it("ignores inherited property names in content types, relationship types and formula kinds", async () => {
    const path = await make(
      "proto.xlsx",
      xlsx(`<row r="1"><c r="A1"><f t="constructor">1</f><v>1</v></c></row>`, {
        mainType: "constructor",
        mainLinks: [
          {
            id: "rId1",
            type: "http://x/y/constructor",
            target: "worksheets/sheet1.xml",
          },
        ],
      }),
    );
    const report = await inspect(path);
    expect(report.package.kind).toBe("unknown");
    const typed = await make(
      "proto2.xlsx",
      xlsx(`<row r="1"><c r="A1"><f t="__proto__">1</f><v>1</v></c></row>`, {
        mainLinks: [
          {
            id: "rId1",
            type: "http://x/y/__proto__",
            target: "worksheets/sheet1.xml",
          },
        ],
      }),
    );
    const sheet = await inspect(typed, { view: "content" });
    expect(sheet.content_parts[0]).toMatchObject({ kind: "worksheet" });
    expect(items(sheet, "row")[0]!.cells[0]).toMatchObject({
      formula_kind: "normal",
    });
  });

  it("does not let a decoy relationship of another family pose as the main document", async () => {
    const package_ = await zip({
      "[Content_Types].xml": `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/decoy.xml" ContentType="${MAIN_TYPES.docm}"/><Override PartName="/word/document.xml" ContentType="${MAIN_TYPES.docx}"/></Types>`,
      "_rels/.rels": `<Relationships xmlns="${PKG_REL}"><Relationship Id="a" Type="http://evil.example/x/officeDocument" Target="word/decoy.xml"/><Relationship Id="b" Type="${relType("officeDocument")}" Target="word/document.xml"/></Relationships>`,
      "word/decoy.xml": wordDocument(para("FAKE")),
      "word/document.xml": wordDocument(para("REAL")),
    });
    const report = await inspect(await write("decoy.docx", package_), {
      view: "content",
    });
    expect(report.package.kind).toBe("docx");
    expect(items(report, "paragraph")[0]!.text).toBe("REAL");
  });
});

describe("hostile package names", () => {
  it("compares media types ignoring case", async () => {
    const path = await make("upper.docx", {
      ...WORD,
      mainType: MAIN_TYPES.docx.toUpperCase(),
      main: wordDocument(para("x")),
      mainLinks: [
        {
          id: "v",
          type: "http://schemas.microsoft.com/office/2006/relationships/vbaProject",
          target: "p.bin",
        },
      ],
      parts: {
        "word/p.bin": {
          type: "Application/VND.MS-Office.VBAProject",
          data: new Uint8Array([1]),
        },
      },
    });
    const report = await inspect(path);
    expect(report.package.kind).toBe("docx");
    expect(report.package.notable.map((entry) => entry.kind)).toContain(
      "macro-project",
    );
  });

  it("counts a stray .rels outside _rels once and says it is not read", async () => {
    const path = await make("stray.docx", {
      ...WORD,
      main: wordDocument(para("x")),
      parts: {
        "word/stray.rels": {
          data: `<Relationships xmlns="${PKG_REL}"><Relationship Id="e" Type="${relType("hyperlink")}" Target="https://a.example/" TargetMode="External"/></Relationships>`,
        },
      },
    });
    const report = await inspect(path);
    expect(report.package.external_total).toBe(0);
    expect(report.package.problems.join(" ")).toContain("word/stray.rels");
  });

  it("reads the first of two parts that differ only in case, and says so", async () => {
    const bytes = await zip({
      "[Content_Types].xml": `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="${MAIN_TYPES.docx}"/></Types>`,
      "_rels/.rels": `<Relationships xmlns="${PKG_REL}"><Relationship Id="a" Type="${relType("officeDocument")}" Target="word/document.xml"/></Relationships>`,
      "word/document.xml": wordDocument(para("FIRST")),
      "word/Document.xml": wordDocument(para("SECOND")),
    });
    const report = await inspect(await write("case.docx", bytes), {
      view: "content",
    });
    expect(items(report, "paragraph")[0]!.text).toBe("FIRST");
    expect(report.package.problems.join(" ")).toContain(
      "differ only in letter case",
    );
  });

  it("finds a part named with percent-encoding", async () => {
    const path = await make("encoded.docx", {
      ...WORD,
      main: wordDocument(para("x")),
      mainLinks: [
        { id: "h", type: relType("header"), target: "my%20header.xml" },
      ],
      parts: {
        "word/my header.xml": {
          type: "application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml",
          data: `<w:hdr xmlns:w="${W}"><w:p><w:r><w:t>spaced</w:t></w:r></w:p></w:hdr>`,
        },
      },
    });
    const report = await inspect(path);
    expect(report.content_parts.map((part) => part.id)).toContain(
      "header:my header.xml",
    );
  });

  it("turns a malformed relationships part into a diagnostic on the content view", async () => {
    const bytes = await zip({
      "[Content_Types].xml": `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="${MAIN_TYPES.docx}"/></Types>`,
      "_rels/.rels": `<Relationships xmlns="${PKG_REL}"><Relationship Id="a" Type="${relType("officeDocument")}" Target="word/document.xml"/></Relationships>`,
      "word/document.xml": wordDocument(para("x")),
      "word/_rels/document.xml.rels": "<Relationships",
    });
    const report = await inspect(await write("badrels.docx", bytes), {
      view: "content",
    });
    expect(
      report.diagnostics.map((entry) => entry.message).join(" "),
    ).toContain("document.xml.rels");
    expect(
      report.coverage.find((entry) => entry.facet === "inspect")?.state,
    ).toBe("partial");
  });

  it("says a document with no readable content part is not fully read", async () => {
    const path = await make("none.docx", {
      mainPath: "word/document.xml",
      mainType: "application/x-unknown",
      main: wordDocument(para("x")),
    });
    const report = await inspect(path, { view: "content" });
    expect(
      report.coverage.find((entry) => entry.facet === "inspect"),
    ).toMatchObject({
      state: "partial",
      omitted: "document content",
    });
  });
});

describe("hostile numbers", () => {
  it("survives out-of-range row, column, level and outline values", async () => {
    const path = await make(
      "numbers.xlsx",
      xlsx(
        `<row r="-1"><c r="A1"><v>1</v></c></row><row r="99999999999"><c r="ZZZZZZZZ1"><v>2</v></c></row><row><c r="XFD3"><v>3</v></c></row>`,
      ),
    );
    const report = await inspect(path, { view: "content" });
    expect(report.items.length).toBeGreaterThan(0);
    expect(
      report.diagnostics.map((entry) => entry.message).join(" "),
    ).toContain("outside the worksheet grid");
    const text = await inspect(path, { view: "text" });
    expect(text.text.every((line) => line.length < 100_000)).toBe(true);

    const docx = await make("levels.docx", {
      ...WORD,
      main: wordDocument(
        para(
          "deep",
          '<w:numPr><w:ilvl w:val="99999999999999999999"/><w:numId w:val="1"/></w:numPr>',
        ) +
          para(
            "billion",
            '<w:numPr><w:ilvl w:val="1000000000"/><w:numId w:val="1"/></w:numPr>',
          ),
      ),
    });
    const content = await inspect(docx, { view: "content" });
    expect(
      items(content, "paragraph").map((entry) => entry.list_level),
    ).toEqual([8, 8]);
    expect(
      (await inspect(docx, { view: "text" })).text.join("\n").length,
    ).toBeLessThan(1000);

    const pptx = await make("lvl.pptx", {
      mainPath: "ppt/presentation.xml",
      mainType: MAIN_TYPES.pptx,
      main: `<p:presentation xmlns:p="${P}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="1" r:id="s1"/></p:sldIdLst></p:presentation>`,
      mainLinks: [
        { id: "s1", type: relType("slide"), target: "slides/slide1.xml" },
      ],
      parts: {
        "ppt/slides/slide1.xml": {
          data: slide(
            shape("Body", ["x"]).replace(
              "<a:p>",
              '<a:p><a:pPr lvl="2000000000"/>',
            ),
          ),
        },
      },
    });
    const deck = await inspect(pptx, { view: "content" });
    expect(items(deck, "slide")[0]!.texts[0]!.text.length).toBeLessThan(100);
  });

  it("carries a second that rounds up to a whole day into the next day", () => {
    expect(formatSerial(60.9999999, false)).toBe("1900-03-01");
    expect(formatSerial(44_926.999_999_99, false)).toBe("2023-01-01");
  });

  it("gives an empty value element no value, even under a date style", async () => {
    const path = await make(
      "empty.xlsx",
      xlsx(
        `<row r="1"><c r="A1" s="1"><v></v></c><c r="B1"><v></v><f>1+1</f></c></row>`,
        {
          mainLinks: [
            ...sheetLinks,
            { id: "rIdSt", type: relType("styles"), target: "styles.xml" },
          ],
          parts: {
            "xl/worksheets/sheet1.xml": {
              data: worksheet(
                `<row r="1"><c r="A1" s="1"><v></v></c><c r="B1"><f>1+1</f><v></v></c></row>`,
              ),
            },
            "xl/styles.xml": {
              data: `<styleSheet xmlns="${S}"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`,
            },
          },
        },
      ),
    );
    const row = items(await inspect(path, { view: "content" }), "row")[0]!;
    expect(row.cells).toHaveLength(1);
    expect(row.cells[0]).toMatchObject({
      ref: "B1",
      value: null,
      formula: "1+1",
    });
  });
});

describe("bounded output", () => {
  it("cuts a huge number format and keeps the page small", async () => {
    const format = "0".repeat(200_000);
    const rows = Array.from(
      { length: 400 },
      (_, at) =>
        `<row r="${String(at + 1)}"><c r="A${String(at + 1)}" s="1"><v>1</v></c></row>`,
    ).join("");
    const path = await make("format.xlsx", {
      ...xlsx(rows),
      mainLinks: [
        ...sheetLinks,
        { id: "rIdSt", type: relType("styles"), target: "styles.xml" },
      ],
      parts: {
        "xl/worksheets/sheet1.xml": { data: worksheet(rows) },
        "xl/styles.xml": {
          data: `<styleSheet xmlns="${S}"><numFmts count="1"><numFmt numFmtId="170" formatCode="${format}"/></numFmts><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="170"/></cellXfs></styleSheet>`,
        },
      },
    });
    const report = await inspect(path, { view: "content", limit: 400 });
    expect(JSON.stringify(report).length).toBeLessThan(500_000);
  });

  it("stops a page near its size budget and continues where it stopped", async () => {
    const big = "x".repeat(30_000);
    const path = await make("pages.docx", {
      ...WORD,
      main: wordDocument(Array.from({ length: 200 }, () => para(big)).join("")),
    });
    const first = await inspect(path, { view: "content", limit: 200 });
    expect(first.page.returned).toBeLessThan(200);
    expect(first.page.returned).toBeGreaterThan(0);
    expect(first.page.next).toBe(first.page.returned);
    expect(
      first.coverage.find((entry) => entry.facet === "inspect")?.state,
    ).toBe("partial");
    const second = await inspect(path, {
      view: "content",
      start: first.page.next ?? 0,
      limit: 200,
    });
    expect(second.items[0]).toMatchObject({ index: first.page.next });
  });

  it("limits listed links and fields per paragraph and counts the rest", async () => {
    const fields = Array.from(
      { length: 300 },
      () =>
        `<w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple>`,
    ).join("");
    const path = await make("fields.docx", {
      ...WORD,
      main: wordDocument(`<w:p>${fields}</w:p>`),
    });
    const report = await inspect(path, { view: "content" });
    expect(items(report, "paragraph")[0]!.fields).toHaveLength(100);
    expect(report.omissions.map((entry) => entry.kind)).toContain(
      "fields-past-limit",
    );
    expect(XML_DECL.length).toBeGreaterThan(0);
  });
});

describe("content that was silently dropped", () => {
  it("reads content controls inside table cells and rows, and fields across paragraphs", async () => {
    const path = await make("controls.docx", {
      ...WORD,
      main: wordDocument(
        `<w:tbl><w:sdt><w:sdtContent><w:tr><w:tc><w:sdt><w:sdtContent><w:p><w:r><w:t>wrapped</w:t></w:r></w:p></w:sdtContent></w:sdt></w:tc></w:tr></w:sdtContent></w:sdt></w:tbl>` +
          `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> TOC \\o "1-3" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>one</w:t></w:r></w:p>` +
          `<w:p><w:r><w:t>two</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`,
      ),
    });
    const report = await inspect(path, { view: "content" });
    expect(items(report, "table")[0]!.cells).toEqual([["wrapped"]]);
    const paragraphs = items(report, "paragraph");
    expect(paragraphs[1]!.fields).toEqual(['TOC \\o "1-3"']);
  });

  it("flags text hidden by a character style or the paragraph style", async () => {
    const path = await make("hiddenstyle.docx", {
      ...WORD,
      main: wordDocument(
        `<w:p><w:r><w:rPr><w:rStyle w:val="Secret"/></w:rPr><w:t>by character style</w:t></w:r></w:p>` +
          `<w:p><w:pPr><w:pStyle w:val="Hush"/></w:pPr><w:r><w:t>by paragraph style</w:t></w:r></w:p>` +
          `<w:p><w:pPr><w:pStyle w:val="Hush"/></w:pPr><w:r><w:rPr><w:vanish w:val="0"/></w:rPr><w:t>shown</w:t></w:r></w:p>`,
      ),
      mainLinks: [{ id: "st", type: relType("styles"), target: "styles.xml" }],
      parts: {
        "word/styles.xml": {
          data: `<w:styles xmlns:w="${W}"><w:style w:type="character" w:styleId="Secret"><w:name w:val="Secret"/><w:rPr><w:vanish/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Hush"><w:name w:val="Hush"/><w:rPr><w:vanish/></w:rPr></w:style></w:styles>`,
        },
      },
    });
    const paragraphs = items(
      await inspect(path, { view: "content" }),
      "paragraph",
    );
    expect(paragraphs.map((entry) => entry.hidden)).toEqual([
      true,
      true,
      false,
    ]);
  });

  it("reports nesting deeper than the reader follows", async () => {
    const depth = 80;
    const nested = `${"<w:smartTag>".repeat(depth)}<w:r><w:t>deep</w:t></w:r>${"</w:smartTag>".repeat(depth)}`;
    const path = await make("deepsmart.docx", {
      ...WORD,
      main: wordDocument(`<w:p>${nested}</w:p>`),
    });
    const report = await inspect(path, { view: "content" });
    expect(report.omissions.map((entry) => entry.kind)).toContain(
      "nesting-limit",
    );
    expect(
      report.coverage.find((entry) => entry.facet === "inspect")?.state,
    ).toBe("partial");
  });

  it("keeps a worksheet cell whose shared string is missing instead of dropping it as blank", async () => {
    const path = await make(
      "lost.xlsx",
      xlsx(`<row r="1"><c r="A1" t="s"><v>0</v></c></row>`),
    );
    const report = await inspect(path, { view: "content" });
    expect(items(report, "row")[0]!.cells[0]).toMatchObject({
      ref: "A1",
      type: "string",
      value: null,
    });
    expect(report.omissions.map((entry) => entry.kind)).not.toContain(
      "blank-cells",
    );
  });
});
