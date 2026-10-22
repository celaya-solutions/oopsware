import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  inspectOfficeDocumentInputSchema,
  officeDocumentReportSchema,
  type OfficeDocumentReport,
  type OfficeItem,
} from "../../domain/officeDocument/officeDocument.js";
import {
  SPRM,
  TEXTUTIL,
  buildDoc,
  dttm,
  prl,
  readDoc,
  textutilDoc,
  type DocParagraph,
  type DocSpec,
} from "../../../tests/fixtures/legacyDocProducers.js";
import { OfficeDocumentProvider } from "../OfficeDocumentProvider.js";

const provider = new OfficeDocumentProvider();
let root: string;
let counter = 0;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "rea-doc-"));
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
    inspectOfficeDocumentInputSchema.parse({ path, limit: 1000, ...input }),
  );
  if (!result.ok) throw result.error;
  return officeDocumentReportSchema.parse(result.value);
};

const doc = async (spec: DocSpec, part?: string) =>
  await readDoc(buildDoc(spec).bytes, {
    view: "content",
    ...(part === undefined ? {} : { part }),
  });

const items = <K extends OfficeItem["kind"]>(
  report: OfficeDocumentReport,
  kind: K,
): Extract<OfficeItem, { kind: K }>[] =>
  report.items.filter(
    (item): item is Extract<OfficeItem, { kind: K }> => item.kind === kind,
  );

/** Our reading as lines in document order: paragraphs, then each table cell's lines. */
const lines = (report: OfficeDocumentReport): string[] =>
  report.items
    .flatMap((item) =>
      item.kind === "paragraph"
        ? [item.text]
        : item.kind === "table"
          ? item.cells.flat().flatMap((cell) => cell.split("\n"))
          : [],
    )
    .filter((line) => line.trim() !== "");

const oracle = (text: string): string[] =>
  text.split("\n").filter((line) => line.trim() !== "");

const SPEC_CHAR = prl(SPRM.spec, 1);
const cell = (text: string): DocParagraph => ({
  runs: [text],
  pap: prl(SPRM.inTable, 1),
  end: "\u0007",
});
const rowEnd: DocParagraph = {
  runs: [],
  pap: [...prl(SPRM.inTable, 1), ...prl(SPRM.ttp, 1)],
  end: "\u0007",
};

describe("Word 97-2003 documents written by textutil", () => {
  it("reads headings, a table, links, CP1252 and non-Latin text exactly as textutil reads it back", async () => {
    if (TEXTUTIL === null) return; // textutil is macOS-only; the hand-assembled tests below still run.
    const made = await textutilDoc(
      root,
      "report",
      `<html><head><meta charset="utf-8"></head><body><h1>Quarterly Report</h1><h2>Second level</h2><p>Hello <b>bold</b> and <i>italic</i> and <a href="https://example.com/x?a=1&amp;b=2">a link</a>.</p><p>Café € naïve “quoted” — dash … ™</p><table border="1"><tr><td>A1</td><td>B1</td></tr><tr><td>A2</td><td>B2 with words</td></tr></table><p>Ελληνικά and 日本語 and עברית text</p><ul><li>one</li><li>two</li></ul><p>Tail line</p></body></html>`,
    );
    const report = await inspect(made.doc, { view: "content" });
    expect(report.package).toMatchObject({
      kind: "doc",
      family: "word",
      macro_enabled: false,
      main_part: "WordDocument",
    });
    expect(report.content_parts.map((part) => part.id)).toEqual(["body"]);
    expect(lines(report)).toEqual(oracle(made.text));
    const [table] = items(report, "table");
    expect(table).toMatchObject({
      rows: 2,
      columns: 2,
      cells: [
        ["A1", "B1"],
        ["A2", "B2 with words"],
      ],
    });
    const summary = await inspect(made.doc);
    expect(summary.package.statistics).toMatchObject({ tables: 1 });
    expect(summary.diagnostics).toEqual([]);
  });

  it("reads long documents across many property pages and RTF input", async () => {
    if (TEXTUTIL === null) return;
    const body = Array.from(
      { length: 1500 },
      (_, at) => `Line ${String(at)} — “${"word ".repeat(at % 7)}” ‰ œ`,
    ).join("\n");
    const long = await textutilDoc(root, "long", body, "txt");
    const report = await inspect(long.doc, { view: "content", limit: 5000 });
    expect(lines(report)).toEqual(oracle(long.text));
    const rtf = await textutilDoc(
      root,
      "rich",
      String.raw`{\rtf1\ansi\ansicpg1252{\fonttbl\f0\fswiss Helvetica;}\pard Caf\'e9 \'80 \'93quoted\'94\par\pard Second \b bold\b0  line\par}`,
      "rtf",
    );
    expect(lines(await inspect(rtf.doc, { view: "content" }))).toEqual(
      oracle(rtf.text),
    );
  });
});

const RICH: DocSpec = {
  nFib: 0x0101,
  styles: [
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    { name: "Secret Para", chp: prl(SPRM.vanish, 1) },
    { name: "Hidden Char", stk: 2, chp: prl(SPRM.vanish, 1) },
    { name: "Heading 3", pap: prl(SPRM.outLvl, 2) },
    { name: "Bulleted", pap: [...prl(SPRM.ilfo, 2, 0), ...prl(SPRM.ilvl, 1)] },
  ],
  body: [
    { runs: ["Main Title"], istd: 1 },
    { runs: ["Custom heading"], istd: 17 },
    { runs: ["Outline only"], pap: prl(SPRM.outLvl, 3) },
    {
      runs: [
        "Visit ",
        "\u0013",
        ' HYPERLINK "https://example.com/a?b=1" \\o "tip" ',
        "\u0014",
        "the site",
        "\u0015",
        " or ",
        "\u0013",
        ' HYPERLINK \\l "intro" ',
        "\u0014",
        "jump",
        "\u0015",
        ".",
        { text: "\u0002", chp: SPEC_CHAR },
        { text: "\u0005", chp: SPEC_CHAR },
      ],
    },
    {
      runs: [
        "Total: ",
        "\u0013",
        " SUM(ABOVE) ",
        "\u0014",
        "42",
        "\u0015",
        " on ",
        "\u0013",
        " DATE \\@ ",
        "\u0013",
        " QUOTE x ",
        "\u0014",
        "x",
        "\u0015",
        "\u0014",
        "today",
        "\u0015",
      ],
    },
    {
      runs: [
        "Keep ",
        { text: "added", chp: prl(SPRM.ins, 1) },
        { text: " removed", chp: prl(SPRM.del, 1) },
      ],
    },
    { runs: [{ text: "only deleted", chp: prl(SPRM.del, 1) }] },
    { runs: [{ text: "secret", chp: prl(SPRM.vanish, 1) }] },
    { runs: ["styled away"], istd: 15 },
    { runs: [{ text: "char styled", chp: prl(SPRM.charStyle, 16, 0) }] },
    {
      runs: [
        "shown ",
        { text: "half", chp: prl(SPRM.vanish, 1) },
        { text: "\u0001", chp: SPEC_CHAR },
        { text: "\u0008", chp: SPEC_CHAR },
      ],
    },
    { runs: ["Bullet"], istd: 18 },
    {
      runs: ["Numbered"],
      pap: [...prl(SPRM.ilfo, 1, 0), ...prl(SPRM.ilvl, 3)],
    },
    { runs: ["Not a list"], pap: prl(SPRM.ilfo, 0x01, 0xf8) },
    cell("A1"),
    cell("B1"),
    rowEnd,
    { runs: ["A2 first"], pap: prl(SPRM.inTable, 1) },
    cell("A2 second"),
    cell(""),
    rowEnd,
    {
      runs: [
        "a\tb",
        { text: "\u000b" },
        "c\u001enon\u001fbreak\u00a0end\u000ecolumn",
      ],
    },
    { runs: ["Last", { text: "\u0002", chp: SPEC_CHAR }] },
  ],
  footnotes: [[{ runs: [" First note."] }]],
  endnotes: [[{ runs: [" End note"] }, { runs: ["second paragraph"] }]],
  comments: [
    {
      author: "Ada Lovelace",
      initials: "AL",
      date: dttm(2024, 3, 9, 14, 5),
      paragraphs: [{ runs: ["Check this"] }],
    },
  ],
  headers: [
    [
      [],
      [{ runs: ["Odd header"] }],
      [{ runs: ["Even footer"] }],
      [{ runs: ["Odd footer"] }],
      [{ runs: ["First header"] }],
      [],
    ],
  ],
  textBoxes: [[{ runs: ["boxed text"] }], [{ runs: ["second box"] }]],
};

describe("hand-assembled Word documents: body content", () => {
  it("reads styles, headings, lists, fields, links, tracked changes, hidden text and tables", async () => {
    const report = await doc(RICH);
    const paragraphs = items(report, "paragraph");
    const byText = (text: string) =>
      paragraphs.find((paragraph) => paragraph.text === text);
    expect(byText("Main Title")).toMatchObject({
      style: "heading 1",
      heading_level: 1,
    });
    expect(byText("Custom heading")).toMatchObject({
      style: "Heading 3",
      heading_level: 3,
    });
    expect(byText("Outline only")).toMatchObject({
      style: null,
      heading_level: 4,
    });
    expect(byText("Visit the site or jump.[^fn1]")).toMatchObject({
      links: [
        {
          text: "the site",
          target: "https://example.com/a?b=1",
          external: true,
        },
        { text: "jump", target: "#intro", external: false },
      ],
      fields: [
        'HYPERLINK "https://example.com/a?b=1" \\o "tip"',
        'HYPERLINK \\l "intro"',
      ],
    });
    // A field nested in another's instruction belongs to that instruction; only results are text.
    expect(byText("Total: 42 on today")?.fields).toEqual([
      "SUM(ABOVE)",
      "QUOTE x",
      "DATE \\@ x",
    ]);
    expect(byText("Keep added")?.revision).toBe("mixed");
    expect(byText("")?.revision).toBe("deleted");
    expect(byText("secret")?.hidden).toBe(true);
    expect(byText("styled away")).toMatchObject({
      hidden: true,
      style: "Secret Para",
    });
    expect(byText("char styled")?.hidden).toBe(true);
    expect(byText("shown half")?.hidden).toBe(false);
    expect(byText("Bullet")?.list_level).toBe(1);
    expect(byText("Numbered")?.list_level).toBe(3);
    expect(byText("Not a list")?.list_level).toBeNull();
    // 0x0B line break and 0x0E column break both become a line break.
    expect(byText("a\tb\nc-nonbreak\u00a0end\ncolumn")).toBeDefined();
    expect(byText("Last[^en1]")).toBeDefined();
    expect(items(report, "table")).toEqual([
      expect.objectContaining({
        rows: 2,
        columns: 2,
        cells: [
          ["A1", "B1"],
          ["A2 first\nA2 second", ""],
        ],
        truncated: false,
      }),
    ]);
    expect(report.package.external_references).toEqual([
      {
        source: "body",
        kind: "hyperlink",
        target: "https://example.com/a?b=1",
        id: expect.stringMatching(/^field-cp\d+$/u),
      },
    ]);
    const omissions = new Map(
      report.omissions.map((entry) => [entry.kind, entry.count]),
    );
    expect(Object.fromEntries(omissions)).toMatchObject({
      picture: 1,
      drawing: 1,
      "deleted-text": 2,
      "text-box": 2,
    });
    expect(report.diagnostics).toEqual([]);
  });
});

describe("hand-assembled Word documents: content parts", () => {
  it("counts what the package view reads across every part", async () => {
    const report = await inspect(await write("rich.doc", buildDoc(RICH).bytes));
    expect(
      report.content_parts.map((part) => [part.id, part.kind, part.label]),
    ).toEqual([
      ["body", "body", "Document body"],
      ["comments", "comments", "Comments"],
      ["footnotes", "footnotes", "Footnotes"],
      ["endnotes", "endnotes", "Endnotes"],
      ["header", "header", "Headers"],
      ["footer", "footer", "Footers"],
    ]);
    expect(report.package.statistics).toMatchObject({
      paragraphs: 20,
      tables: 1,
      fields: 5,
      hyperlinks: 2,
      comments: 1,
      footnotes: 1,
      endnotes: 1,
      pictures: 1,
      drawn_objects: 1,
      tracked_insertions: 1,
      tracked_deletions: 2,
      hidden_text_runs: 4,
      hidden_paragraphs: 3,
      sections: 1,
      comments_parts: 1,
    });
    expect(report.package.notable).toEqual([
      expect.objectContaining({
        kind: "comments",
        part: "WordDocument",
        sha256: null,
      }),
    ]);
    expect(report.package.problems).toEqual([]);
  });

  it("reads notes, comments with author and date, and each header and footer story", async () => {
    const bytes = buildDoc(RICH).bytes;
    const path = await write("parts.doc", bytes);
    const notes = await inspect(path, { view: "content", part: "footnotes" });
    expect(notes.items).toEqual([
      {
        kind: "note",
        index: 0,
        location: "footnotes#footnote1",
        id: "1",
        text: " First note.",
      },
    ]);
    const endnotes = await inspect(path, { view: "content", part: "endnotes" });
    expect(items(endnotes, "note")[0]?.text).toBe(
      " End note\nsecond paragraph",
    );
    const comments = await inspect(path, { view: "content", part: "comments" });
    expect(comments.items).toEqual([
      {
        kind: "comment",
        index: 0,
        location: "comments#comment1",
        id: "1",
        author: "Ada Lovelace",
        date: "2024-03-09T14:05",
        text: "Check this",
      },
    ]);
    const headers = await inspect(path, { view: "content", part: "header" });
    expect(
      items(headers, "paragraph").map((p) => [p.location, p.text]),
    ).toEqual([
      ["header:s1:odd#p1", "Odd header"],
      ["header:s1:first#p1", "First header"],
    ]);
    const footers = await inspect(path, { view: "content", part: "footer" });
    expect(
      items(footers, "paragraph").map((p) => [p.location, p.text]),
    ).toEqual([
      ["footer:s1:even#p1", "Even footer"],
      ["footer:s1:odd#p1", "Odd footer"],
    ]);
    const text = await inspect(path, { view: "text" });
    expect(text.text).toContain("# Main Title");
    expect(text.text).toContain(
      "> link: the site -> https://example.com/a?b=1 (external)",
    );
  });
});

describe("hand-assembled Word documents: pieces, objects and sections", () => {
  it("reads compressed and UTF-16 pieces in any stream order, with piece properties", async () => {
    const body: DocParagraph[] = [
      { runs: ["Quotes “here” – dash — ellipsis… ™ €uro? ‰ Œ"] },
      { runs: ["Ελληνικά 日本語"] },
      { runs: ["Hidden by piece"] },
      { runs: ["Deleted by piece"] },
      { runs: ["plain end"] },
    ];
    const starts = [0];
    for (const paragraph of body.slice(0, -1))
      starts.push(
        (starts[starts.length - 1] ?? 0) + String(paragraph.runs[0]).length + 1,
      );
    const report = await doc({
      body,
      reversePieces: true,
      prcs: [prl(SPRM.del, 1)],
      pieces: [
        { at: 0, compressed: false },
        { at: starts[1] ?? 0, compressed: false },
        // Prm0: isprm 0x5C (sprmCFVanish), operand 1.
        { at: starts[2] ?? 0, compressed: true, prm: (0x5c << 1) | (1 << 8) },
        // Prm1: the first property group (sprmCFRMarkDel).
        { at: starts[3] ?? 0, compressed: true, prm: (0 << 1) | 1 },
        { at: starts[4] ?? 0, compressed: true },
      ],
    });
    expect(
      items(report, "paragraph").map((p) => [p.text, p.hidden, p.revision]),
    ).toEqual([
      ["Quotes “here” – dash — ellipsis… ™ €uro? ‰ Œ", false, null],
      ["Ελληνικά 日本語", false, null],
      ["Hidden by piece", true, null],
      ["", false, "deleted"],
      ["plain end", false, null],
    ]);
    expect(report.diagnostics).toEqual([]);
  });

  it("maps the compressed bytes 0x80-0x9F as the format defines", async () => {
    const report = await doc({
      body: [{ runs: ["‚ƒ„…†‡ˆ‰Š‹Œ‘’“”•–—˜™š›œŸ \u0080\u0081\u008d\u009d"] }],
      pieces: [{ at: 0, compressed: true }],
    });
    expect(items(report, "paragraph")[0]?.text).toBe(
      "‚ƒ„…†‡ˆ‰Š‹Œ‘’“”•–—˜™š›œŸ \u0080\u0081\u008d\u009d",
    );
  });

  it("flattens nested tables, counts objects and sections, and keeps page breaks as line breaks", async () => {
    const nested = (text: string, extra: number[] = []): DocParagraph => ({
      runs: [text],
      pap: [...prl(SPRM.inTable, 1), ...prl(SPRM.itap, 2, 0, 0, 0), ...extra],
    });
    const body: DocParagraph[] = [
      { runs: ["before", "\u000c", "after page break"] },
      { runs: ["end of section one"], end: "\u000c" },
      { runs: ["outer"], pap: prl(SPRM.inTable, 1) },
      nested("n1", prl(SPRM.innerCell, 1)),
      nested("n2", prl(SPRM.innerCell, 1)),
      nested("", prl(SPRM.innerTtp, 1)),
      cell("outer end"),
      cell("B"),
      rowEnd,
      {
        runs: [
          "Object ",
          "\u0013",
          " EMBED Excel.Sheet.8 ",
          { text: "\u0014", chp: [...SPEC_CHAR, ...prl(SPRM.ole, 1)] },
          { text: "\u0001", chp: SPEC_CHAR },
          "\u0015",
          {
            text: "(",
            chp: [...SPEC_CHAR, ...prl(SPRM.symbol, 0x02, 0x00, 0x22, 0xf0)],
          },
          " done",
        ],
      },
    ];
    const prefix = "before\u000cafter page break\rend of section one\u000c"
      .length;
    const report = await doc({ body, sectionStarts: [prefix] });
    expect(items(report, "paragraph").map((p) => p.text)).toEqual([
      "before\nafter page break",
      "end of section one",
      "Object  done",
    ]);
    expect(items(report, "table")[0]?.cells).toEqual([
      ["outer\nn1 | n2\nouter end", "B"],
    ]);
    const omissions = Object.fromEntries(
      report.omissions.map((entry) => [entry.kind, entry.count]),
    );
    expect(omissions).toMatchObject({
      "nested-table": 1,
      "embedded-object": 1,
      picture: 1,
      symbol: 1,
    });
    const summary = await inspect(
      await write(
        "objects.doc",
        buildDoc({ body, sectionStarts: [prefix] }).bytes,
      ),
    );
    expect(summary.package.statistics).toMatchObject({
      sections: 2,
      ole_objects: 1,
      nested_tables: 1,
      fields: 1,
    });
  });

  it("reads paragraph properties kept in the Data stream (sprmPHugePapx)", async () => {
    const report = await doc({
      body: [
        { runs: ["Heading"], istd: 2, huge: true },
        { runs: ["A1"], pap: prl(SPRM.inTable, 1), end: "\u0007", huge: true },
        { ...rowEnd, huge: true },
        { runs: ["after"] },
      ],
    });
    expect(report.items).toMatchObject([
      { kind: "paragraph", style: "heading 2", heading_level: 2 },
      { kind: "table", cells: [["A1"]] },
      { kind: "paragraph", text: "after" },
    ]);
    expect(report.diagnostics).toEqual([]);
  });
});
