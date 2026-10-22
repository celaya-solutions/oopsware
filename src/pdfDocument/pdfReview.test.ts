import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { DecodeBudget, MemberReadFailure } from "../artifacts/zipMemberView.js";
import { usePdfHarness } from "../../tests/fixtures/pdfHarness.js";
import {
  CUPSFILTER,
  PDFLATEX,
  buildPdf,
  concat,
  latexPdf,
  onePage,
  type PdfObject,
} from "../../tests/fixtures/pdfProducers.js";
import { decodeFilters } from "./filters.js";
import { PdfDeadlineError, PdfFile } from "./file.js";
import { parseTsv } from "./poppler.js";
import { Lexer } from "./syntax.js";

const { write, inspect, root } = usePdfHarness();

const sha = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (char) => char.charCodeAt(0) & 0xff);
const doc = async (
  objects: readonly PdfObject[],
  options?: Parameters<typeof buildPdf>[1],
): Promise<string> => await write("doc.pdf", buildPdf(objects, options));
const page = (
  content: string,
  resources = "/Font << /F1 5 0 R >>",
  more: PdfObject[] = [],
  pageExtra = "",
  catalog = "",
): PdfObject[] => [
  ...onePage(content, { resources, page: pageExtra, catalog }),
  ...more,
];
const budget = () => new DecodeBudget(1024 ** 3, 256 * 1024 ** 2);

describe("syntax and filter fixes", () => {
  it("lexes a very long numeric token in linear time", () => {
    const started = Date.now();
    const lexer = new Lexer(ascii(`${"1".repeat(300_000)}x`));
    lexer.readValue();
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("treats a 400-digit number as no number rather than Infinity", async () => {
    const path = await doc(
      page(
        "q Q",
        "/Font << /F1 5 0 R >>",
        [],
        `/CropBox [0 0 ${"9".repeat(400)} 10] /UserUnit ${"9".repeat(400)}`,
      ),
    );
    const row = (await inspect(path, { view: "pages" })).pages[0]!;
    expect(row.crop_box).toBeNull();
    expect(row.user_unit).toBe(1);
  });

  it("does not leak prototype members through a filter name", () => {
    const decoded = decodeFilters(
      ascii("x"),
      ["constructor"],
      [],
      budget(),
      "x",
    );
    expect(decoded.state).toBe("unsupported");
    expect(decoded.note).toBe("The constructor filter is not implemented.");
  });

  it("refuses predictor parameters it cannot apply", () => {
    const parms = (bits: number) => ({
      t: "dict" as const,
      map: new Map<string, never>([
        ["Predictor", 12 as never],
        ["Columns", 3 as never],
        ["BitsPerComponent", bits as never],
      ]),
    });
    const packed = new Uint8Array(deflateSync(Uint8Array.from([2, 1, 2, 3])));
    for (const bits of [0, -8, 3])
      expect(
        decodeFilters(packed, ["FlateDecode"], [parms(bits)], budget(), "x")
          .state,
      ).toBe("unsupported");
  });

  it("stops a RunLength or ASCII85 bomb at the budget without building it first", () => {
    const small = new DecodeBudget(1024 ** 2, 256 * 1024 ** 2);
    const runs = new Uint8Array(20_000);
    for (let at = 0; at < runs.length; at += 2) {
      runs[at] = 129; // repeat the next byte 128 times
      runs[at + 1] = 7;
    }
    expect(() =>
      decodeFilters(runs, ["RunLengthDecode"], [], small, "runs"),
    ).toThrow(MemberReadFailure);
    const zeros = ascii(`${"z".repeat(600_000)}~>`);
    expect(() =>
      decodeFilters(zeros, ["ASCII85Decode"], [], small, "a85"),
    ).toThrow(MemberReadFailure);
    // What a text filter produces is charged to the budget.
    const hex = new DecodeBudget(1024 ** 3, 256 * 1024 ** 2);
    decodeFilters(ascii("4142>"), ["ASCIIHexDecode"], [], hex, "hex");
    expect(hex.used).toBe(2);
  });
});

/** An LZW encoder (EarlyChange 1) to round-trip the decoder through table growth, a full table and a clear code. */
const lzwEncode = (data: Uint8Array): Uint8Array => {
  const out: number[] = [];
  let accumulator = 0;
  let bits = 0;
  const put = (code: number, width: number) => {
    accumulator = (accumulator << width) | code;
    bits += width;
    while (bits >= 8) {
      out.push((accumulator >>> (bits - 8)) & 255);
      bits -= 8;
      accumulator &= (1 << bits) - 1;
    }
  };
  let table = new Map<string, number>();
  let next = 258;
  const widthFor = (size: number) =>
    size + 1 >= 2048 ? 12 : size + 1 >= 1024 ? 11 : size + 1 >= 512 ? 10 : 9;
  let width = 9;
  put(256, width);
  let current = "";
  const codeOf = (text: string) =>
    text.length === 1 ? text.charCodeAt(0) : (table.get(text) as number);
  for (const byte of data) {
    const candidate = current + String.fromCharCode(byte);
    if (candidate.length === 1 || table.has(candidate)) {
      current = candidate;
      continue;
    }
    put(codeOf(current), width);
    table.set(candidate, next);
    next += 1;
    width = widthFor(next - 1);
    if (next >= 4095) {
      put(256, width);
      table = new Map();
      next = 258;
      width = 9;
    }
    current = String.fromCharCode(byte);
  }
  if (current.length > 0) put(codeOf(current), width);
  put(257, width);
  if (bits > 0) put(0, 8 - bits);
  return Uint8Array.from(out);
};

describe("LZW decoding", () => {
  it("round-trips text that grows the table, fills it and clears it", () => {
    let text = "";
    let seed = 7;
    for (let index = 0; index < 60_000; index += 1) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      text += "abcdefgh ".charAt(seed % 9);
    }
    const decoded = decodeFilters(
      lzwEncode(ascii(text)),
      ["LZWDecode"],
      [],
      budget(),
      "lzw",
    );
    expect(decoded.state).toBe("complete");
    expect(Buffer.from(decoded.bytes).toString("latin1")).toBe(text);
  });

  it("handles the code being defined right now (aaaa...)", () => {
    const text = "a".repeat(5000);
    const decoded = decodeFilters(
      lzwEncode(ascii(text)),
      ["LZWDecode"],
      [],
      budget(),
      "lzw",
    );
    expect(Buffer.from(decoded.bytes).toString("latin1")).toBe(text);
  });

  it("resets without cost when clear codes flood the stream", () => {
    const clears = new Uint8Array(300_000).fill(0x80); // 9-bit 256 repeated, mostly
    const started = Date.now();
    decodeFilters(clears, ["LZWDecode"], [], budget(), "clears");
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

describe("text layout from Poppler", () => {
  const header =
    "level\tpage_num\tpar_num\tblock_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext";
  const word = (
    par: number,
    block: number,
    line: number,
    index: number,
    left: number,
    text: string,
  ) =>
    `5\t1\t${String(par)}\t${String(block)}\t${String(line)}\t${String(index)}\t${String(left)}\t10\t20\t12\t100\t${text}`;

  it("keeps lines of different flows and blocks apart", () => {
    const tsv = [
      header,
      "1\t1\t0\t0\t0\t0\t0\t0\t200\t300\t-1\t###PAGE###",
      word(0, 0, 0, 0, 10, "Alpha"),
      word(0, 0, 0, 1, 40, "one"),
      word(1, 0, 0, 0, 10, "Beta"),
      word(2, 0, 0, 0, 10, "Gamma"),
      word(2, 0, 1, 0, 10, "second"),
    ].join("\n");
    const lines = parseTsv(tsv)[0]!.lines;
    expect(lines.map((line) => line.text)).toEqual([
      "Alpha one",
      "Beta",
      "Gamma",
      "second",
    ]);
    expect(lines.map((line) => [line.flow, line.block, line.line])).toEqual([
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
      [2, 0, 1],
    ]);
    expect(lines[0]!.bbox).toEqual([10, 10, 60, 22]);
  });

  it("turns a bad cell into zero, never NaN", () => {
    const tsv = [
      header,
      "1\t1\t0\t0\t0\t0\t0\t0\tnope\t300\t-1\t###PAGE###",
      "5\t1\t0\t0\t0\t0\tx\t10\t20\t12\t100\tword",
    ].join("\n");
    const parsed = parseTsv(tsv)[0]!;
    expect(parsed.width).toBe(0);
    expect(parsed.lines[0]!.bbox.every((value) => Number.isFinite(value))).toBe(
      true,
    );
  });
});

describe.skipIf(PDFLATEX === null)("a real two-paragraph page", () => {
  it("returns one line per Poppler line, not one per line number", async () => {
    const path = await latexPdf(
      root(),
      "paragraphs",
      "\\section*{Heading}First paragraph of the page.\\par\\bigskip Second paragraph of the page.\\par\\bigskip Third paragraph final words.",
    );
    const report = await inspect(path, { view: "layout" });
    const lines = report.layout[0]!.lines.map((line) => line.text);
    expect(lines.length).toBeGreaterThanOrEqual(4);
    for (const line of lines)
      expect(
        [
          line.includes("First"),
          line.includes("Second"),
          line.includes("Third"),
        ].filter(Boolean).length,
      ).toBeLessThanOrEqual(1);
  });
});

describe.skipIf(CUPSFILTER === null)("page text cannot forge structure", () => {
  it("escapes Markdown that starts a line", async () => {
    const path = await doc(
      page(
        "BT /F1 12 Tf 20 150 Td (## Page 2) Tj ET BT /F1 12 Tf 20 120 Td (*No text layer: image only.*) Tj ET BT /F1 12 Tf 20 90 Td (- item) Tj ET",
      ),
    );
    const text = (await inspect(path, { view: "text" })).text;
    expect(text.filter((line) => line.startsWith("## "))).toEqual([
      "## Page 1",
    ]);
    expect(text.some((line) => line.startsWith("\\## Page 2"))).toBe(true);
    expect(text.some((line) => line.startsWith("\\*No text layer"))).toBe(true);
    expect(text.some((line) => line.startsWith("\\- item"))).toBe(true);
  });
});

describe("values that must not break the report", () => {
  it("lists a prototype-named annotation subtype without leaking a member", async () => {
    const path = await doc(
      page(
        "q Q",
        "/Font << /F1 5 0 R >>",
        [
          {
            num: 6,
            body: "<< /Type /Annot /Subtype /constructor /Rect [0 0 1 1] >>",
          },
          {
            num: 7,
            body: "<< /Type /Annot /Subtype /__proto__ /Rect [0 0 1 1] >>",
          },
          {
            num: 8,
            body: "<< /Type /Annot /Subtype /toString /Rect [0 0 1 1] >>",
          },
        ],
        "/Annots [6 0 R 7 0 R 8 0 R]",
      ),
    );
    const report = await inspect(path);
    expect(report.actions).toEqual([]);
    const row = (await inspect(path, { view: "pages" })).pages[0]!;
    expect(row.annotations.total).toBe(3);
    expect(
      row.annotations.subtypes.map((entry) => entry.subtype).sort(),
    ).toEqual(["__proto__", "constructor", "toString"]);
  });

  it("nulls negative sizes, lengths and generations instead of failing the call", async () => {
    const path = await doc(
      page(
        "q Q",
        "/Font << /F1 5 0 R >>",
        [
          {
            num: 6,
            body: "<< /Type /Filespec /F (neg.bin) /EF << /F 7 0 R >> >>",
          },
          {
            num: 7,
            body: "/Type /EmbeddedFile /Params << /Size -5 >>",
            stream: "data",
          },
          { num: 8, body: "<< /Names [(n) 6 0 R] >>" },
        ],
        "",
        "/Names << /EmbeddedFiles 8 0 R >>",
      ),
    );
    const report = await inspect(path);
    expect(report.attachments[0]).toMatchObject({
      declared_bytes: null,
      state: "read",
    });
    const text = new TextDecoder("latin1").decode(
      await (await import("node:fs/promises")).readFile(path),
    );
    const negative = text.replace(
      /\/Length \d+ >>\nstream\ndata/u,
      "/Length -4 >>\nstream\ndata",
    );
    const objects = await inspect(await write("neg.pdf", ascii(negative)), {
      view: "objects",
    });
    expect(objects.objects.find((row) => row.number === 7)).toMatchObject({
      kind: "stream",
      stream_bytes: null,
    });
  });

  it("clips free text and nested field names so one file cannot make a huge report", async () => {
    const depth = 60;
    const name = "N".repeat(3000);
    const fields: PdfObject[] = [];
    for (let index = 0; index < depth; index += 1)
      fields.push({
        num: 10 + index,
        body: `<< /T (${name}) /FT /Tx ${index + 1 < depth ? `/Kids [${String(11 + index)} 0 R]` : ""} /A << /S /URI /URI (https://example.com/${String(index)}) >> >>`,
      });
    const path = await doc(
      page(
        "q Q",
        "/Font << /F1 5 0 R >>",
        fields,
        "",
        "/AcroForm << /Fields [10 0 R] >>",
      ),
    );
    const report = await inspect(path);
    expect(report.actions.length).toBe(depth);
    for (const action of report.actions)
      expect(action.trigger.length).toBeLessThanOrEqual(700);
    expect(JSON.stringify(report).length).toBeLessThan(600_000);
  });

  it("clips the document ID", async () => {
    const path = await doc(page("q Q"), {
      trailer: `/ID [<${"ab".repeat(5000)}> <00>]`,
    });
    const ids = (await inspect(path)).document.ids;
    expect(ids[0]!.length).toBe(128);
  });
});

describe("walks that shared references could multiply", () => {
  it("follows an action chain of arrays thousands of links long without overflowing", async () => {
    const links = 8000;
    const objects: PdfObject[] = [];
    for (let index = 0; index < links; index += 1)
      objects.push({
        num: 10 + index,
        body: `<< /S /URI /URI (https://example.com/${String(index)}) ${index + 1 < links ? `/Next [${String(11 + index)} 0 R]` : ""} >>`,
      });
    const path = await doc(
      page("q Q", "/Font << /F1 5 0 R >>", objects, "", "/OpenAction 10 0 R"),
    );
    const report = await inspect(path);
    expect(report.action_total).toBe(links);
    expect(report.actions.length).toBe(500);
    expect(
      report.diagnostics.map((entry) => entry.message).join(" "),
    ).toContain(`${String(links)} actions were found`);
  });

  it("reads each shared action object once, whatever number of pages point at it", async () => {
    const pages = 300;
    const leaves = 300;
    const objects: PdfObject[] = [
      { num: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
      {
        num: 2,
        body: `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, index) => `${String(10 + index)} 0 R`).join(" ")}] /Count ${String(pages)} >>`,
      },
      {
        num: 5,
        body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      },
      {
        num: 6,
        body: `<< /S /URI /URI (hub) /Next [${Array.from({ length: leaves }, (_, index) => `${String(1000 + index)} 0 R`).join(" ")}] >>`,
      },
    ];
    for (let index = 0; index < pages; index += 1)
      objects.push({
        num: 10 + index,
        body: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] /AA << /O 6 0 R >> >>",
      });
    for (let index = 0; index < leaves; index += 1)
      objects.push({
        num: 1000 + index,
        body: `<< /S /URI /URI (leaf${String(index)}) >>`,
      });
    const started = Date.now();
    const report = await inspect(await doc(objects));
    expect(report.action_total).toBe(leaves + 1);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("does not multiply a page tree whose nodes share one Kids array", async () => {
    const nodes = 2500;
    const kids = `[${Array.from({ length: nodes }, (_, index) => `${String(10 + index)} 0 R`).join(" ")}]`;
    const objects: PdfObject[] = [
      { num: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
      { num: 2, body: `<< /Type /Pages /Kids ${kids} /Count 1 >>` },
    ];
    for (let index = 0; index < nodes; index += 1)
      objects.push({
        num: 10 + index,
        body: `<< /Type /Pages /Parent 2 0 R /Kids ${kids} /Count 1 >>`,
      });
    const started = Date.now();
    const report = await inspect(await doc(objects));
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(report.document.problems.join(" ")).toContain("more than");
  });

  it("stops a form field tree whose fields share one Kids array", async () => {
    const fields = 3000;
    const kids = `[${Array.from({ length: fields }, (_, index) => `${String(10 + index)} 0 R`).join(" ")}]`;
    const objects: PdfObject[] = [];
    for (let index = 0; index < fields; index += 1)
      objects.push({
        num: 10 + index,
        body: `<< /T (f${String(index)}) /FT /Tx /Kids ${kids} >>`,
      });
    const started = Date.now();
    const report = await inspect(
      await doc(
        page(
          "q Q",
          "/Font << /F1 5 0 R >>",
          objects,
          "",
          "/AcroForm << /Fields [10 0 R] >>",
        ),
      ),
    );
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(report.document.form?.fields).toBeLessThanOrEqual(fields);
  });
});

describe("cross-reference and rebuild fixes", () => {
  /** A hybrid file: a classic table marks object 7 free and its XRefStm brings it back. */
  const hybrid = (): { bytes: Uint8Array; xrefAt: number } => {
    const parts: Uint8Array[] = [ascii("%PDF-1.7\n")];
    let size = parts[0]!.length;
    const offsets = new Map<number, number>();
    const add = (num: number, body: Uint8Array | string) => {
      offsets.set(num, size);
      const bytes = typeof body === "string" ? ascii(body) : body;
      parts.push(bytes);
      size += bytes.length;
    };
    add(1, "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
    add(2, "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
    add(
      3,
      "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] >>\nendobj\n",
    );
    add(7, "7 0 obj\n<< /Marker (hybrid) >>\nendobj\n");
    const seven = offsets.get(7)!;
    const entry = Uint8Array.from([1, (seven >> 8) & 255, seven & 255, 0]);
    const stream = concat([
      ascii(
        `8 0 obj\n<< /Type /XRef /W [1 2 1] /Index [7 1] /Size 9 /Length 4 >>\nstream\n`,
      ),
      entry,
      ascii("\nendstream\nendobj\n"),
    ]);
    add(8, stream);
    const free = "0000000000 00001 f \n";
    const used = (num: number) =>
      `${String(offsets.get(num)).padStart(10, "0")} 00000 n \n`;
    const xrefAt = size;
    const table = `xref\n0 9\n0000000000 65535 f \n${used(1)}${used(2)}${used(3)}${free}${free}${free}${free}${used(8)}trailer\n<< /Size 9 /Root 1 0 R /XRefStm ${String(offsets.get(8))} >>\nstartxref\n${String(xrefAt)}\n%%EOF\n`;
    parts.push(ascii(table));
    return { bytes: concat(parts), xrefAt };
  };

  it("fills a number from the hybrid stream only where its own table marked it free", async () => {
    const { bytes } = hybrid();
    const report = await inspect(await write("hybrid.pdf", bytes), {
      view: "objects",
    });
    expect(report.objects.map((row) => row.number)).toContain(7);
    expect(
      (await inspect(await write("hybrid2.pdf", bytes))).document.xref.state,
    ).toBe("hybrid");
  });

  it("does not bring back an object a newer revision freed", async () => {
    const { bytes, xrefAt } = hybrid();
    const update = ascii(
      `xref\n7 1\n0000000000 00001 f \ntrailer\n<< /Size 9 /Root 1 0 R /Prev ${String(xrefAt)} >>\nstartxref\n${String(bytes.length)}\n%%EOF\n`,
    );
    const report = await inspect(
      await write("freed.pdf", concat([bytes, update])),
      { view: "objects" },
    );
    expect(report.objects.map((row) => row.number)).not.toContain(7);
  });

  it("reads a valid cross-reference table with 700,000 entries", async () => {
    const objects = page("q Q");
    const built = buildPdf(objects);
    const text = new TextDecoder("latin1").decode(built);
    const entries = 700_001;
    const free = "0000000000 65535 f \n";
    const table = text.slice(text.indexOf("xref\n"), text.indexOf("trailer\n"));
    const lines = table.split("\n");
    const used = lines.slice(2, 2 + 6); // entries 0..5
    const filler = free.repeat(entries - 6);
    const before = text.slice(0, text.indexOf("xref\n"));
    const rebuilt = `${before}xref\n0 ${String(entries)}\n${used.join("\n")}\n${filler}trailer\n<< /Size ${String(entries)} /Root 1 0 R >>\nstartxref\n${String(before.length)}\n%%EOF\n`;
    const report = await inspect(await write("big-table.pdf", ascii(rebuilt)));
    expect(report.document.xref).toMatchObject({ state: "table", sections: 1 });
    expect(report.document.page_count).toBe(1);
  });

  it("skips the bytes of a stream when it rebuilds, so an embedded file adds no objects or trailer", async () => {
    const embedded =
      "1 0 obj\n<< /Type /Catalog /Lang (FAKE) /Pages 9 0 R >>\nendobj\ntrailer\n<< /Root 1 0 R /Size 2 >>\n";
    const path = await doc(
      [
        ...page("q Q"),
        { num: 6, body: "/Type /EmbeddedFile", stream: embedded },
      ],
      { badStartxref: true },
    );
    const report = await inspect(path);
    expect(report.document.xref.state).toBe("rebuilt");
    expect(report.document.language).toBeNull();
    expect(report.document.page_count).toBe(1);
  });

  it("rebuilds past a stray trailer with a nested array and past a first object this reader cannot parse", async () => {
    const deep = `[`.repeat(80);
    const path = await write(
      "stray.pdf",
      concat([
        buildPdf(page("q Q"), { badStartxref: true }),
        ascii(`\ntrailer\n<< /X ${deep}\n`),
      ]),
    );
    const report = await inspect(path);
    expect(report.document.xref.state).toBe("rebuilt");
    expect(report.document.page_count).toBe(1);
    const first = await doc([{ num: 10, body: deep }, ...page("q Q")]);
    const valid = await inspect(first);
    expect(valid.document.linearized).toBe(false);
    expect(valid.document.page_count).toBe(1);
  });

  it("stops past its deadline between steps", () => {
    // A past deadline stops a long loop at its next clock check; a short file never reaches one.
    expect(() =>
      PdfFile.open(buildPdf(page("q Q")), budget(), {
        deadline: Date.now() - 1,
      }),
    ).not.toThrow();
    const entries = 2000;
    const text = `%PDF-1.7\nxref\n0 ${String(entries)}\n${"0000000000 65535 f \n".repeat(entries)}trailer\n<< /Size ${String(entries)} /Root 1 0 R >>\nstartxref\n9\n%%EOF\n`;
    expect(() =>
      PdfFile.open(ascii(text), budget(), { deadline: Date.now() - 1 }),
    ).toThrow(PdfDeadlineError);
  });
});

describe("content and encryption fixes", () => {
  const kind = async (content: string, resources: string, more: PdfObject[]) =>
    (
      await inspect(await doc(page(content, resources, more)), {
        view: "pages",
      })
    ).pages[0]!;
  const form = (num: number, content: string, extra = ""): PdfObject => ({
    num,
    body: `/Type /XObject /Subtype /Form /BBox [0 0 10 10] /Resources << /Font << /F1 5 0 R >> ${extra} >>`,
    stream: content,
  });

  it("scans a form with the render mode it was invoked under, and each mode once", async () => {
    const row = await kind(
      "q 3 Tr /Fm1 Do Q /Fm1 Do",
      "/XObject << /Fm1 6 0 R >> /Font << /F1 5 0 R >>",
      [form(6, "BT /F1 12 Tf (inside) Tj ET")],
    );
    expect(row).toMatchObject({
      text_operations: 2,
      hidden_text_operations: 1,
      kind: "text",
    });
  });

  it("says so when a form is nested past the depth it scans", async () => {
    const forms: PdfObject[] = [];
    for (let level = 0; level < 7; level += 1)
      forms.push(
        form(
          6 + level,
          level === 6
            ? "BT /F1 12 Tf (deep) Tj ET"
            : `/Fm${String(level + 1)} Do`,
          `/XObject << /Fm${String(level + 1)} ${String(7 + level)} 0 R >>`,
        ),
      );
    const row = await kind("/Fm0 Do", "/XObject << /Fm0 6 0 R >>", forms);
    expect(row.kind).toBe("unreadable");
    expect(row.note).toContain("nested more than 4 levels");
  });

  it("sizes an unfiltered inline image from its dictionary, not from bytes that look like EI", async () => {
    // The 16 data bytes of this 8x2 image read " EI BT (A) Tj ET"; the real EI follows them.
    const row = await kind(
      "q 8 0 0 2 0 0 cm BI /W 8 /H 2 /CS /G /BPC 8 ID  EI BT (A) Tj ET\nEI Q",
      "/Font << /F1 5 0 R >>",
      [],
    );
    expect(row).toMatchObject({
      kind: "image-only",
      images: 1,
      text_operations: 0,
    });
  });

  it("ends an ASCIIHex inline image at an EI that follows its > marker", async () => {
    const row = await kind(
      "q 2 0 0 2 0 0 cm BI /W 2 /H 1 /CS /G /BPC 8 /F /AHx ID 0102>EI Q BT /F1 12 Tf (real) Tj ET",
      "/Font << /F1 5 0 R >>",
      [],
    );
    expect(row).toMatchObject({
      kind: "text-and-images",
      images: 1,
      text_operations: 1,
    });
  });
});

describe("streams and declarations", () => {
  it("uses the start of a truncated Flate content stream and says it ends early", async () => {
    const full = new Uint8Array(
      deflateSync(ascii("BT /F1 12 Tf (cut) Tj ET ".repeat(2000))),
    );
    const path = await doc([
      ...onePage("", {}).slice(0, 3),
      {
        num: 4,
        body: "/Filter /FlateDecode",
        stream: full.subarray(0, Math.floor(full.length / 2)),
      },
      {
        num: 5,
        body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      },
    ]);
    const row = (await inspect(path, { view: "pages" })).pages[0]!;
    expect(row.kind).toBe("text");
    expect(row.note).toContain("ends early");
  });

  it("does not hash a truncated attachment as if it were whole", async () => {
    const full = new Uint8Array(
      deflateSync(ascii("attachment body ".repeat(4000))),
    );
    const path = await doc(
      page(
        "q Q",
        "/Font << /F1 5 0 R >>",
        [
          {
            num: 6,
            body: "<< /Type /Filespec /F (cut.bin) /EF << /F 7 0 R >> >>",
          },
          {
            num: 7,
            body: "/Type /EmbeddedFile /Filter /FlateDecode",
            stream: full.subarray(0, Math.floor(full.length / 2)),
          },
          { num: 8, body: "<< /Names [(n) 6 0 R] >>" },
        ],
        "",
        "/Names << /EmbeddedFiles 8 0 R >>",
      ),
    );
    const attachment = (await inspect(path)).attachments[0]!;
    expect(attachment).toMatchObject({
      state: "not-decoded",
      sha256: null,
      decoded_bytes: null,
    });
    expect(attachment.note).toContain("ends early");
  });

  it("decodes a script that many actions share once, so it does not drain the budget", async () => {
    const script = "var x = 1; // " + "a".repeat(1024 ** 2);
    const actions = 40;
    const objects: PdfObject[] = [
      { num: 6, body: "", stream: script, flate: true },
      {
        num: 8,
        body: `<< /Names [${Array.from({ length: actions }, (_, index) => `(a${String(index)}) ${String(100 + index)} 0 R`).join(" ")}] >>`,
      },
    ];
    for (let index = 0; index < actions; index += 1)
      objects.push({
        num: 100 + index,
        body: "<< /S /JavaScript /JS 6 0 R >>",
      });
    const report = await inspect(
      await doc(
        page(
          "q Q",
          "/Font << /F1 5 0 R >>",
          objects,
          "",
          "/Names << /JavaScript 8 0 R >>",
        ),
      ),
      { max_decoded_bytes: 8 * 1024 ** 2 },
    );
    expect(
      report.actions.filter((action) => action.script_sha256 === sha(script))
        .length,
    ).toBe(actions);
    expect(report.document.decoded_bytes).toBeLessThan(3 * 1024 ** 2);
  });

  it("reads an absent StmF as the identity filter and a reversed box as its normalized corners", async () => {
    const path = await doc(
      page(
        "q Q",
        "/Font << /F1 5 0 R >>",
        [
          {
            num: 6,
            body: "<< /Filter /Standard /V 4 /R 4 /CF << /StdCF << /CFM /AESV2 >> >> /P -4 /O <00> /U <00> >>",
          },
        ],
        "/MediaBox [200 300 0 0]",
      ),
      { trailer: "/Encrypt 6 0 R" },
    );
    expect((await inspect(path)).document.encryption?.method).toBe("identity");
    const boxes = await doc(
      page("q Q", "/Font << /F1 5 0 R >>", [], "/MediaBox [200 300 0 0]"),
    );
    expect(
      (await inspect(boxes, { view: "pages" })).pages[0]!.media_box,
    ).toEqual([0, 0, 200, 300]);
  });

  it("names a missing page tree instead of reporting zero pages quietly", async () => {
    const path = await doc([{ num: 1, body: "<< /Type /Catalog >>" }]);
    const report = await inspect(path);
    expect(report.document.page_count).toBe(0);
    expect(report.document.problems.join(" ")).toContain(
      "no readable Pages tree",
    );
  });
});

describe("signatures that skip bytes", () => {
  const placeholder = "[0 0000000000 0000000000 0000000000]";
  const signedWith = (
    shape: (
      length: number,
      start: number,
      end: number,
    ) => [number, number, number, number],
  ): Uint8Array => {
    const bytes = buildPdf(
      page(
        "q Q",
        "/Font << /F1 5 0 R >>",
        [
          {
            num: 6,
            body: "<< /Type /Annot /Subtype /Widget /FT /Sig /T (S) /Rect [0 0 0 0] /V 7 0 R >>",
          },
          {
            num: 7,
            body: `<< /Type /Sig /SubFilter /adbe.pkcs7.detached /ByteRange ${placeholder} /Contents <${"00".repeat(32)}> >>`,
          },
        ],
        "",
        "/AcroForm << /Fields [6 0 R] >>",
      ),
    );
    const text = new TextDecoder("latin1").decode(bytes);
    const start = text.indexOf("<", text.indexOf("/Contents <"));
    const end = text.indexOf(">", start) + 1;
    const [a, b, c, d] = shape(bytes.length, start, end);
    const fill = `[${String(a)} ${String(b).padStart(10, "0")} ${String(c).padStart(10, "0")} ${String(d).padStart(10, "0")}]`;
    const at = text.indexOf(placeholder);
    return concat([
      bytes.subarray(0, at),
      ascii(fill),
      bytes.subarray(at + placeholder.length),
    ]);
  };

  it("reports a gap that is not the Contents string as a mismatch, not as the whole file", async () => {
    const report = await inspect(
      await write(
        "gap.pdf",
        signedWith((length, start, end) => [0, start - 10, end, length - end]),
      ),
    );
    expect(report.signatures[0]).toMatchObject({
      coverage: "gap-mismatch",
      gap_bytes: 64 + 2 + 10,
    });
    const exact = await inspect(
      await write(
        "exact.pdf",
        signedWith((length, start, end) => [0, start, end, length - end]),
      ),
    );
    expect(exact.signatures[0]).toMatchObject({
      coverage: "whole-file",
      gap_bytes: 66,
    });
  });
});

describe("text view honesty", () => {
  it("warns when Poppler's page tree and this reader's disagree", async () => {
    const path = await doc([
      { num: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
      { num: 2, body: "<< /Type /Pages /Kids [3 0 R 3 0 R 4 0 R] /Count 2 >>" },
      {
        num: 3,
        body: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 5 0 R /Resources << /Font << /F1 7 0 R >> >> >>",
      },
      {
        num: 4,
        body: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>",
      },
      { num: 5, body: "", stream: "BT /F1 12 Tf 20 100 Td (FIRST) Tj ET" },
      { num: 6, body: "", stream: "BT /F1 12 Tf 20 100 Td (SECOND) Tj ET" },
      {
        num: 7,
        body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      },
    ]);
    const report = await inspect(path, { view: "text" });
    expect(
      report.diagnostics.map((entry) => entry.message).join(" "),
    ).toContain("repeats a node or its Count is wrong");
  });
});
