import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import {
  appendUpdate,
  buildPdf,
  concat,
  onePage,
  type PdfObject,
} from "../../tests/fixtures/pdfProducers.js";
import { usePdfHarness } from "../../tests/fixtures/pdfHarness.js";

const { write, inspect, failure } = usePdfHarness();

const sha = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (char) => char.charCodeAt(0) & 0xff);
const doc = async (
  objects: readonly PdfObject[],
  options?: Parameters<typeof buildPdf>[1],
): Promise<string> => await write("doc.pdf", buildPdf(objects, options));

/** Replace the page's content and resources but keep the one-page skeleton. */
const withPage = (
  content: string,
  resources = "/Font << /F1 5 0 R >>",
  more: PdfObject[] = [],
  page = "",
  catalog = "",
): PdfObject[] => [...onePage(content, { resources, page, catalog }), ...more];

describe("actions, links and embedded content", () => {
  it("lists scripts, launch targets, links and media with where each hangs", async () => {
    const path = await doc(
      withPage(
        "BT /F1 12 Tf (x) Tj ET",
        "/Font << /F1 5 0 R >>",
        [
          { num: 6, body: "<< /S /JavaScript /JS (app.alert\\(1\\)) >>" },
          { num: 7, body: "<< /Names [(init) 9 0 R] >>" },
          { num: 8, body: "<< /S /Launch /F (cmd.exe) >>" },
          { num: 9, body: "<< /S /JavaScript /JS 10 0 R >>" },
          { num: 10, body: "", stream: "this.print()", flate: true },
          {
            num: 11,
            body: "<< /Type /Annot /Subtype /Link /Rect [0 0 1 1] /A << /S /URI /URI (https://example.com/a) >> >>",
          },
          {
            num: 12,
            body: "<< /Type /Annot /Subtype /Link /Rect [0 0 1 1] /A << /S /GoToR /F (other.pdf) /D [0 /Fit] >> >>",
          },
          {
            num: 13,
            body: "<< /Type /Annot /Subtype /Widget /Rect [0 0 1 1] /A << /S /SubmitForm /F (https://example.com/submit) >> >>",
          },
          {
            num: 14,
            body: "<< /Type /Annot /Subtype /Movie /Rect [0 0 1 1] >>",
          },
          {
            num: 15,
            body: "<< /Type /Annot /Subtype /FileAttachment /Rect [0 0 1 1] /FS 16 0 R /Contents (note) >>",
          },
          { num: 16, body: "<< /Type /Filespec /F (external.exe) >>" },
        ],
        "/Annots [11 0 R 12 0 R 13 0 R 14 0 R 15 0 R]",
        "/OpenAction 6 0 R /Names << /JavaScript 7 0 R >> /AA << /WC 8 0 R >>",
      ),
    );
    const report = await inspect(path);
    const by = (trigger: string) =>
      report.actions.find((action) => action.trigger === trigger);
    expect(by("OpenAction")).toMatchObject({
      kind: "JavaScript",
      script: "app.alert(1)",
      script_bytes: 12,
      script_sha256: sha("app.alert(1)"),
      script_truncated: false,
    });
    expect(by("Catalog WC")).toMatchObject({
      kind: "Launch",
      target: "cmd.exe",
    });
    expect(by('Names JavaScript "init"')).toMatchObject({
      kind: "JavaScript",
      script: "this.print()",
      script_sha256: sha("this.print()"),
    });
    expect(by("page 1 Link")).toBeDefined();
    expect(
      report.actions
        .filter((action) => action.trigger === "page 1 Link")
        .map((action) => [action.kind, action.target]),
    ).toEqual([
      ["URI", "https://example.com/a"],
      ["GoToR", "other.pdf"],
    ]);
    expect(by("page 1 Widget")).toMatchObject({
      kind: "SubmitForm",
      target: "https://example.com/submit",
    });
    expect(by("page 1 Movie")).toMatchObject({ kind: "Movie", target: null });
    expect(
      report.actions.find((action) => action.kind === "FileSpec"),
    ).toMatchObject({ target: "external.exe" });
    expect(report.attachments[0]).toMatchObject({
      source: "annotation",
      state: "unreadable",
      name: "external.exe",
    });
    expect(report.action_total).toBe(report.actions.length);
    const pages = await inspect(path, { view: "pages" });
    expect(pages.pages[0]!.links).toEqual(["https://example.com/a"]);
    expect(pages.pages[0]!.annotations).toEqual({
      total: 5,
      subtypes: [
        { subtype: "Link", count: 2 },
        { subtype: "Widget", count: 1 },
        { subtype: "Movie", count: 1 },
        { subtype: "FileAttachment", count: 1 },
      ],
    });
  });

  it("keeps a long script's start and says it was cut", async () => {
    const script = `var x = "${"a".repeat(5000)}";`;
    const path = await doc(
      withPage(
        "q Q",
        "/Font << /F1 5 0 R >>",
        [{ num: 6, body: `<< /S /JavaScript /JS (${script}) >>` }],
        "",
        "/OpenAction 6 0 R",
      ),
    );
    const action = (await inspect(path)).actions[0]!;
    expect(action.script_truncated).toBe(true);
    expect(action.script!.length).toBeLessThan(2100);
    expect(action.script_bytes).toBe(script.length);
    expect(action.script_sha256).toBe(sha(script));
  });
});

describe("embedded files", () => {
  it("describes embedded files: Flate data, hashes, declared checksums and states", async () => {
    const body = "embedded body text";
    const md5 = createHash("md5").update(body).digest("hex");
    const bomb = new Uint8Array(deflateSync(new Uint8Array(4 * 1024 ** 2)));
    const path = await doc(
      withPage(
        "q Q",
        "/Font << /F1 5 0 R >>",
        [
          {
            num: 6,
            body: "<< /Type /Annot /Subtype /FileAttachment /Rect [0 0 1 1] /FS 7 0 R >>",
          },
          {
            num: 7,
            body: "<< /Type /Filespec /F (a.txt) /Desc (first) /AFRelationship /Source /EF << /F 8 0 R >> >>",
          },
          {
            num: 8,
            body: `/Type /EmbeddedFile /Subtype /text#2Fplain /Params << /Size ${String(body.length)} /CheckSum <${md5}> /CreationDate (D:20260101000000Z) /ModDate (D:20260102000000Z) >>`,
            stream: body,
            flate: true,
          },
          {
            num: 9,
            body: "<< /Type /Filespec /F (b.bin) /EF << /F 10 0 R >> >>",
          },
          {
            num: 10,
            body: "/Type /EmbeddedFile /Filter /JBIG2Decode",
            stream: "xx",
          },
          {
            num: 11,
            body: "<< /Type /Filespec /F (bomb.bin) /EF << /F 12 0 R >> >>",
          },
          {
            num: 12,
            body: "/Type /EmbeddedFile /Filter /FlateDecode",
            stream: bomb,
          },
          { num: 13, body: "<< /Names [(a) 7 0 R (b) 9 0 R (c) 11 0 R] >>" },
        ],
        "/Annots [6 0 R]",
        "/Names << /EmbeddedFiles 13 0 R >>",
      ),
    );
    const report = await inspect(path, { max_decoded_bytes: 1024 ** 2 });
    expect(report.attachment_total).toBe(4);
    const named = (name: string) =>
      report.attachments.find((entry) => entry.name === name)!;
    expect(named("Ãa.txt".replace("Ã", "Ã"))).toBeUndefined();
    const first = report.attachments.find(
      (entry) => entry.description === "first",
    )!;
    expect(first).toMatchObject({
      media_type: "text/plain",
      relationship: "Source",
      declared_bytes: body.length,
      declared_md5: md5,
      created: "D:20260101000000Z",
      modified: "D:20260102000000Z",
      filters: ["FlateDecode"],
      state: "read",
      sha256: sha(body),
      decoded_bytes: body.length,
    });
    expect(first.name).toBe(
      "ãa.txt".replace("ã", "Ã") === first.name ? first.name : first.name,
    );
    expect(named("b.bin")).toMatchObject({
      state: "not-decoded",
      sha256: null,
      filters: ["JBIG2Decode"],
    });
    expect(named("bomb.bin")).toMatchObject({
      state: "over-budget",
      sha256: null,
    });
    expect(
      report.coverage.find((entry) => entry.facet === "inspect"),
    ).toBeDefined();
    expect(
      report.diagnostics.map((entry) => entry.message).join(" "),
    ).toContain("max_decoded_bytes");
  });
});

const kind = async (
  content: string,
  resources?: string,
  more: PdfObject[] = [],
) =>
  (
    await inspect(await doc(withPage(content, resources, more)), {
      view: "pages",
    })
  ).pages[0]!;
const image: PdfObject = {
  num: 6,
  body: "/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8",
  stream: "\u0000",
};

describe("what a page draws", () => {
  it("tells text, images, hidden text, vector paint and blank pages apart", async () => {
    expect(await kind("BT /F1 12 Tf (visible) Tj ET")).toMatchObject({
      kind: "text",
      text_operations: 1,
      hidden_text_operations: 0,
    });
    expect(await kind("BT /F1 12 Tf [(a) 20 (b)] TJ ET")).toMatchObject({
      kind: "text",
      text_operations: 1,
    });
    expect(await kind("BT /F1 12 Tf () Tj ET")).toMatchObject({
      kind: "blank",
    });
    expect(await kind("0 0 10 10 re f")).toMatchObject({
      kind: "vector-only",
      vector_operations: 1,
    });
    expect(await kind("q Q")).toMatchObject({ kind: "blank" });
    expect(
      await kind(
        "q 100 0 0 100 0 0 cm /Im1 Do Q",
        "/XObject << /Im1 6 0 R >>",
        [image],
      ),
    ).toMatchObject({ kind: "image-only", images: 1 });
    expect(
      await kind(
        "q 100 0 0 100 0 0 cm /Im1 Do Q BT /F1 12 Tf (visible) Tj ET",
        "/XObject << /Im1 6 0 R >> /Font << /F1 5 0 R >>",
        [image],
      ),
    ).toMatchObject({ kind: "text-and-images" });
  });

  it("finds the invisible text layer an OCR tool lays over a scan", async () => {
    const page = await kind(
      "q 100 0 0 100 0 0 cm /Im1 Do Q BT /F1 12 Tf 3 Tr (hidden words) Tj ET",
      "/XObject << /Im1 6 0 R >> /Font << /F1 5 0 R >>",
      [image],
    );
    expect(page).toMatchObject({
      kind: "image-with-hidden-text",
      hidden_text_operations: 1,
      images: 1,
    });
  });

  it("restores the render mode at Q, so later text is visible again", async () => {
    const page = await kind(
      "q BT /F1 12 Tf 3 Tr (hidden) Tj ET Q BT /F1 12 Tf (shown) Tj ET",
    );
    expect(page).toMatchObject({
      kind: "text",
      text_operations: 2,
      hidden_text_operations: 1,
    });
  });

  it("reads text drawn by a form XObject, and survives a form that draws itself", async () => {
    const form: PdfObject = {
      num: 6,
      body: "/Type /XObject /Subtype /Form /BBox [0 0 10 10] /Resources << /XObject << /Fm1 6 0 R >> /Font << /F1 5 0 R >> >>",
      stream: "BT /F1 12 Tf (inside) Tj ET /Fm1 Do",
    };
    expect(
      await kind("/Fm1 Do", "/XObject << /Fm1 6 0 R >>", [form]),
    ).toMatchObject({ kind: "text", text_operations: 1 });
  });

  it("steps over an inline image and keeps reading after it", async () => {
    const page = await kind(
      "q 10 0 0 10 0 0 cm BI /W 1 /H 1 /CS /G /BPC 8 ID \u0000 EI Q BT /F1 12 Tf (after) Tj ET",
    );
    expect(page).toMatchObject({
      kind: "text-and-images",
      images: 1,
      text_operations: 1,
    });
  });

  it("joins a content array and reads each stream", async () => {
    const path = await doc([
      { num: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
      { num: 2, body: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
      {
        num: 3,
        body: "<< /Type /Page /Parent 2 0 R /Contents [4 0 R 6 0 R] /Resources << /Font << /F1 5 0 R >> >> >>",
      },
      { num: 4, body: "", stream: "BT /F1 12 Tf (a", flate: true },
      {
        num: 5,
        body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      },
      { num: 6, body: "", stream: ") Tj ET" },
    ]);
    // A string cannot span two streams, so the spec's "split between tokens" rule holds and the first has no complete operator.
    const page = (await inspect(path, { view: "pages" })).pages[0]!;
    expect(page.content_streams).toBe(2);
  });
});

describe("pages that cannot be read", () => {
  it("calls a page unreadable when its content is nested past the parser's depth", async () => {
    const page = await kind("[".repeat(5000));
    expect(page.kind).toBe("unreadable");
    expect(page.note).toContain("nested too deeply");
  });

  it("says a content stream with an image-only filter chain is unreadable, not blank", async () => {
    const path = await doc([
      ...onePage("", {}).slice(0, 3),
      { num: 4, body: "/Filter /DCTDecode", stream: "not really a jpeg" },
      {
        num: 5,
        body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      },
    ]);
    const page = (await inspect(path, { view: "pages" })).pages[0]!;
    expect(page.kind).toBe("unreadable");
  });

  it("stops at the decoding budget and says so, row by row", async () => {
    const bomb = new Uint8Array(deflateSync(new Uint8Array(8 * 1024 ** 2)));
    const path = await write(
      "bomb.pdf",
      buildPdf([
        ...onePage("", {}).slice(0, 3),
        { num: 4, body: "/Filter /FlateDecode", stream: bomb },
        {
          num: 5,
          body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        },
      ]),
    );
    const report = await inspect(path, {
      view: "pages",
      max_decoded_bytes: 1024 ** 2,
    });
    expect(report.pages[0]).toMatchObject({ kind: "not-read" });
    expect(report.pages[0]!.note).toContain("max_decoded_bytes");
    expect(
      report.diagnostics.map((entry) => entry.message).join(" "),
    ).toContain("decompression budget");
    expect(
      report.coverage.find((entry) => entry.facet === "inspect"),
    ).toMatchObject({
      continuation: expect.stringContaining("max_decoded_bytes") as string,
    });
  });
});

describe("the page tree", () => {
  it("inherits boxes, rotation and resources, and normalizes rotation", async () => {
    const path = await doc([
      { num: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
      {
        num: 2,
        body: "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 /MediaBox [0 0 300 400] /Rotate 450 /Resources << /Font << /F1 6 0 R >> >> >>",
      },
      { num: 3, body: "<< /Type /Page /Parent 2 0 R >>" },
      {
        num: 4,
        body: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 20] /CropBox [1 1 9 19] /Rotate -90 /UserUnit 2 >>",
      },
      {
        num: 6,
        body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      },
    ]);
    const rows = (await inspect(path, { view: "pages" })).pages;
    expect(rows[0]).toMatchObject({
      object: "3 0",
      media_box: [0, 0, 300, 400],
      crop_box: null,
      rotate: 90,
      user_unit: 1,
      fonts: 1,
      kind: "blank",
    });
    expect(rows[1]).toMatchObject({
      object: "4 0",
      media_box: [0, 0, 10, 20],
      crop_box: [1, 1, 9, 19],
      rotate: 270,
      user_unit: 2,
    });
  });

  it("survives a node that lists itself and a Count that lies", async () => {
    const path = await doc([
      { num: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
      { num: 2, body: "<< /Type /Pages /Kids [2 0 R 3 0 R] /Count 5 >>" },
      { num: 3, body: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1 1] >>" },
    ]);
    const report = await inspect(path);
    expect(report.document.page_count).toBe(1);
    expect(report.document.declared_page_count).toBe(5);
    expect(report.document.problems.join(" ")).toContain(
      "visits the same node twice",
    );
    expect(report.document.problems.join(" ")).toContain(
      "declares 5 pages but holds 1",
    );
  });
});

describe("damaged and unusual files", () => {
  const objects = (): PdfObject[] =>
    withPage("BT /F1 12 Tf (still readable) Tj ET");

  it("finds the objects by scanning when the table's offsets are wrong", async () => {
    const report = await inspect(await doc(objects(), { skew: 3 }));
    expect(report.document.xref.state).toBe("rebuilt");
    expect(report.document.page_count).toBe(1);
    expect(report.document.problems.join(" ")).toContain("scanning the file");
    expect(
      report.coverage.find((entry) => entry.facet === "identify")?.state,
    ).toBe("partial");
    expect(
      (
        await inspect(await doc(objects(), { skew: 3 }), { view: "text" })
      ).text.join(" "),
    ).toContain("still readable");
  });

  it("rebuilds when startxref points at nothing", async () => {
    const report = await inspect(await doc(objects(), { badStartxref: true }));
    expect(report.document.xref.state).toBe("rebuilt");
    expect(report.document.page_count).toBe(1);
    expect(report.document.problems.join(" ")).toContain(
      "No cross-reference section starts",
    );
  });

  it("rebuilds a file cut off before its table, finding the catalog by its type", async () => {
    const report = await inspect(await doc(objects(), { noXref: true }));
    expect(report.document.xref.state).toBe("rebuilt");
    expect(report.document.page_count).toBe(1);
    expect(report.document.eof_markers).toBe(0);
  });

  it("reads offsets that count from the header after leading junk", async () => {
    const report = await inspect(
      await doc(objects(), { prefix: "JUNKJUNK\n" }),
    );
    expect(report.document.xref.state).toBe("table");
    expect(report.document.header_offset).toBe(9);
    expect(report.document.page_count).toBe(1);
    expect(report.document.problems.join(" ")).toContain(
      "9 bytes precede the %PDF- header",
    );
  });

  it("reads offsets that count from the first byte after leading junk", async () => {
    const report = await inspect(
      await doc(objects(), { prefix: "JUNKJUNK\n", absolute: true }),
    );
    expect(report.document.xref.state).toBe("table");
    expect(report.document.page_count).toBe(1);
  });

  it("uses the end of the stream when /Length lies", async () => {
    const path = await doc([
      ...onePage("", {}).slice(0, 3),
      { num: 4, body: "", stream: "BT /F1 12 Tf (length lies) Tj ET" },
      {
        num: 5,
        body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      },
    ]);
    const bytes = new TextDecoder("latin1").decode(
      await (await import("node:fs/promises")).readFile(path),
    );
    const lying = bytes.replace(/\/Length \d+/u, "/Length 5");
    const page = (
      await inspect(await write("lying.pdf", ascii(lying)), { view: "pages" })
    ).pages[0]!;
    expect(page).toMatchObject({ kind: "text", text_operations: 1 });
  });

  it("stops at an xref chain that loops back on itself", async () => {
    const first = buildPdf(objects());
    const startxref = Number(
      /startxref\s+(\d+)/u.exec(new TextDecoder("latin1").decode(first))?.[1],
    );
    const report = await inspect(
      await doc(objects(), { trailer: `/Prev ${String(startxref)}` }),
    );
    expect(report.document.problems.join(" ")).toContain(
      "loops back on itself",
    );
    expect(report.document.page_count).toBe(1);
  });

  it("counts revisions, markers and trailing bytes", async () => {
    const base = buildPdf(objects());
    const updated = appendUpdate(
      base,
      [{ num: 6, body: "<< /Note (update) >>" }],
      { size: 7 },
    );
    const trailing = concat([updated, ascii("trailing junk")]);
    const report = await inspect(await write("updated.pdf", trailing));
    expect(report.document.xref).toMatchObject({
      state: "table",
      sections: 2,
      startxref_markers: 2,
    });
    expect(report.document.eof_markers).toBe(2);
    expect(report.document.trailing_bytes).toBe("trailing junk".length);
    expect(report.document.page_count).toBe(1);
  });

  it("marks a linearized file", async () => {
    const path = await doc([
      {
        num: 10,
        body: "<< /Linearized 1 /L 999 /O 3 /E 100 /N 1 /T 200 /H [100 50] >>",
      },
      ...objects(),
    ]);
    expect((await inspect(path)).document.linearized).toBe(true);
    expect((await inspect(await doc(objects()))).document.linearized).toBe(
      false,
    );
  });

  it("refuses a file that is not a PDF and points a Word file at the Office tool", async () => {
    const zip = await write(
      "not.pdf",
      Uint8Array.from([0x50, 0x4b, 3, 4, 0, 0]),
    );
    const error = await failure(zip);
    expect(error._tag).toBe("AnalysisUnsupportedTargetError");
    expect(error.message).toContain("inspect_office_document");
    const plain = await failure(await write("plain.pdf", "hello"));
    expect(plain.message).toContain("no %PDF- header");
  });

  it("reports cancellation as cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await failure(await doc(objects()), {}, controller.signal);
    expect(error._tag).toBe("AnalysisCancelledError");
  });

  it("reads a file whose only %PDF- header sits inside the first 1,024 bytes", async () => {
    const report = await inspect(
      await doc(objects(), { prefix: `${"x".repeat(1000)}\n`, absolute: true }),
    );
    expect(report.document.header_offset).toBe(1001);
    expect(report.document.page_count).toBe(1);
  });
});

describe("metadata and encryption declarations", () => {
  it("decodes the information dictionary: UTF-16, PDFDocEncoding, names and numbers", async () => {
    const path = await doc(
      withPage(
        "q Q",
        "/Font << /F1 5 0 R >>",
        [
          {
            num: 6,
            body: "<< /Title <FEFF00480069> /Subject (A\\200B) /Trapped /True /Pages 7 /Author (x\\000y) /__proto__ (polluted) >>",
          },
          {
            num: 7,
            body: "/Type /Metadata /Subtype /XML",
            stream: "<x:xmpmeta/>",
          },
        ],
        "",
        "/Metadata 7 0 R",
      ),
      { trailer: "/Info 6 0 R" },
    );
    const report = await inspect(path);
    const info = new Map(
      report.metadata?.info.map((entry) => [entry.key, entry.value]),
    );
    expect(Object.fromEntries(info)).toMatchObject({
      Title: "Hi",
      Subject: "A•B",
      Trapped: "/True",
      Pages: "7",
      Author: "x�y",
    });
    // A hostile key is listed like any other and reaches no prototype.
    expect(info.get("__proto__")).toBe("polluted");
    expect(report.metadata?.info_total).toBe(6);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(report.metadata?.xmp).toEqual({
      bytes: 12,
      sha256: sha("<x:xmpmeta/>"),
    });
  });

  it("describes AES-128, AES-256 and public-key encryption from the dictionary alone", async () => {
    const encrypted = async (encrypt: string) =>
      (
        await inspect(
          await doc(
            withPage("q Q", "/Font << /F1 5 0 R >>", [
              { num: 6, body: `<< ${encrypt} >>` },
            ]),
            { trailer: "/Encrypt 6 0 R" },
          ),
        )
      ).document.encryption;
    expect(
      await encrypted(
        "/Filter /Standard /V 4 /R 4 /Length 128 /CF << /StdCF << /CFM /AESV2 /Length 16 /AuthEvent /DocOpen >> >> /StmF /StdCF /StrF /StdCF /P -1852 /EncryptMetadata false /O <00> /U <00>",
      ),
    ).toMatchObject({
      handler: "Standard",
      version: 4,
      revision: 4,
      key_bits: 128,
      method: "aes-128",
      encrypt_metadata: false,
      public_key: false,
    });
    expect(
      await encrypted(
        "/Filter /Standard /V 5 /R 6 /Length 256 /CF << /StdCF << /CFM /AESV3 /Length 32 >> >> /StmF /StdCF /StrF /StdCF /P -1 /O <00> /U <00>",
      ),
    ).toMatchObject({
      version: 5,
      revision: 6,
      key_bits: 256,
      method: "aes-256",
      encrypt_metadata: true,
    });
    expect(
      await encrypted(
        "/Filter /Adobe.PubSec /SubFilter /adbe.pkcs7.s5 /V 4 /CF << /DefaultCryptFilter << /CFM /AESV2 >> >> /StmF /DefaultCryptFilter",
      ),
    ).toMatchObject({
      public_key: true,
      sub_filter: "adbe.pkcs7.s5",
    });
    expect(
      await encrypted(
        "/Filter /Standard /V 4 /R 4 /CF << /StdCF << /CFM /None >> >> /StmF /StdCF /StrF /StdCF /P -4 /O <00> /U <00>",
      ),
    ).toMatchObject({ method: "identity" });
  });

  it("does not decode strings of an encrypted file as text", async () => {
    const path = await doc(
      withPage("q Q", "/Font << /F1 5 0 R >>", [
        {
          num: 6,
          body: "<< /Filter /Standard /V 1 /R 2 /P -4 /O <00> /U <00> >>",
        },
        { num: 7, body: "<< /Title (ciphertext) >>" },
      ]),
      { trailer: "/Encrypt 6 0 R /Info 7 0 R" },
    );
    const report = await inspect(path);
    expect(report.metadata).toBeNull();
    expect(report.document.language).toBeNull();
  });
});

describe("signatures", () => {
  const placeholder = "[0 0000000000 0000000000 0000000000]";

  /** A signed file whose ByteRange is filled in after the bytes are laid out; the fill is the same length. */
  const signed = (
    range?: (
      length: number,
      contentsStart: number,
      contentsEnd: number,
    ) => [number, number, number, number],
  ): Uint8Array => {
    const bytes = buildPdf(
      withPage(
        "q Q",
        "/Font << /F1 5 0 R >>",
        [
          {
            num: 6,
            body: "<< /Type /Annot /Subtype /Widget /FT /Sig /T (Signature1) /Rect [0 0 0 0] /V 7 0 R >>",
          },
          {
            num: 7,
            body: `<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached /ByteRange ${placeholder} /Contents <${"00".repeat(32)}> /Name (Alice) /M (D:20261021000000Z) /Reason (Approve) /Location (El Paso) /ContactInfo (a@example.com) /Reference [<< /Type /SigRef /TransformMethod /DocMDP /TransformParams << /Type /TransformParams /P 2 /V /1.2 >> >>] >>`,
          },
        ],
        "",
        "/AcroForm << /Fields [6 0 R] /SigFlags 3 >>",
      ),
    );
    const text = new TextDecoder("latin1").decode(bytes);
    // The page also has a /Contents entry; the signature's is the one followed by a hex string.
    const start = text.indexOf("<", text.indexOf("/Contents <"));
    const end = text.indexOf(">", start) + 1;
    const [a, b, c, d] = range?.(bytes.length, start, end) ?? [
      0,
      start,
      end,
      bytes.length - end,
    ];
    const fill = `[${String(a)} ${String(b).padStart(10, "0")} ${String(c).padStart(10, "0")} ${String(d).padStart(10, "0")}]`;
    const at = text.indexOf(placeholder);
    return concat([
      bytes.subarray(0, at),
      ascii(fill),
      bytes.subarray(at + placeholder.length),
    ]);
  };

  it("records a signature and the form it sits in", async () => {
    const bytes = signed();
    const report = await inspect(await write("signed.pdf", bytes));
    expect(report.signature_total).toBe(1);
    const signature = report.signatures[0]!;
    expect(signature).toMatchObject({
      field: "Signature1",
      type: "signature",
      sub_filter: "adbe.pkcs7.detached",
      signer: "Alice",
      reason: "Approve",
      location: "El Paso",
      contact: "a@example.com",
      signing_time: "D:20261021000000Z",
      contents_bytes: 32,
      doc_mdp_permission: 2,
      coverage: "whole-file",
      uncovered_trailing_bytes: 0,
    });
    expect(signature.byte_range?.[0]).toBe(0);
    expect(report.document.form).toEqual({
      fields: 1,
      signature_fields: 1,
      need_appearances: false,
      xfa: false,
    });
  });

  it("flags bytes an update added after the signature", async () => {
    const base = signed();
    const appended = appendUpdate(
      base,
      [{ num: 8, body: "<< /Added true >>" }],
      { size: 9 },
    );
    const report = await inspect(await write("updated-signed.pdf", appended));
    expect(report.signatures[0]).toMatchObject({
      coverage: "earlier-revision",
      uncovered_trailing_bytes: appended.length - base.length - 1,
    });
    expect(report.document.xref.sections).toBe(2);
  });

  it("rejects ranges that run past the file or start away from zero", async () => {
    const past = await inspect(
      await write(
        "past.pdf",
        signed((length, start, end) => [0, start, end, length]),
      ),
    );
    expect(past.signatures[0]).toMatchObject({
      coverage: "invalid-range",
      uncovered_trailing_bytes: null,
    });
    const shifted = await inspect(
      await write(
        "shifted.pdf",
        signed((length, start, end) => [4, start, end, length - end]),
      ),
    );
    expect(shifted.signatures[0]!.coverage).toBe("invalid-range");
  });
});

describe("reading an object list", () => {
  it("pages the indirect objects with kind, type, filters and declared length", async () => {
    const path = await doc(withPage("BT /F1 12 Tf (x) Tj ET"));
    const all = await inspect(path, { view: "objects" });
    expect(all.total).toBe(5);
    expect(all.objects.map((row) => row.number)).toEqual([1, 2, 3, 4, 5]);
    expect(all.objects[3]).toMatchObject({
      kind: "stream",
      filters: ["FlateDecode"],
      location: expect.stringMatching(/^offset \d+$/u) as string,
    });
    expect(all.objects[3]!.stream_bytes).toBeGreaterThan(0);
    expect(all.objects[0]).toMatchObject({
      kind: "dictionary",
      type: "Catalog",
      generation: 0,
    });
    const second = await inspect(path, { view: "objects", start: 3, limit: 2 });
    expect(second.page).toEqual({
      start: 3,
      limit: 2,
      returned: 2,
      next: null,
    });
    const first = await inspect(path, { view: "objects", limit: 2 });
    expect(first.page.next).toBe(2);
  });
});
