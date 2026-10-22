import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import {
  CUPSFILTER,
  GS,
  PDFATTACH,
  PDFDETACH,
  PDFIMAGES,
  PDFINFO,
  PDFLATEX,
  PDFTOPPM,
  PDFTOTEXT,
  SIPS,
  attachFile,
  gsEncrypt,
  latexPdf,
  oracle,
  quartzPdf,
  scannedPdf,
} from "../../tests/fixtures/pdfProducers.js";
import { usePdfHarness } from "../../tests/fixtures/pdfHarness.js";

const harness = usePdfHarness();
const { write, inspect, failure } = harness;
const root = () => harness.root();

const words = (text: string): string[] =>
  text.split(/\s+/u).filter((word) => word.length > 0);
const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

const have = (...tools: (string | null)[]): boolean =>
  tools.every((tool) => tool !== null);

describe.skipIf(!have(CUPSFILTER, PDFINFO, PDFTOTEXT))(
  "a Quartz PDF from the macOS print filter",
  () => {
    const text =
      "Hello PDF world\nSecond line here.\n\nParagraph two with words.\n";
    let path: string;
    beforeAll(async () => {
      path = await quartzPdf(root(), "quartz", text);
    });

    it("matches pdfinfo on version, pages and producer", async () => {
      const report = await inspect(path);
      const info = oracle.info(path);
      expect(report.document.header_version).toBe(
        /PDF version:\s+(\S+)/u.exec(info)?.[1],
      );
      expect(report.document.page_count).toBe(
        Number(/Pages:\s+(\d+)/u.exec(info)?.[1]),
      );
      expect(report.document.xref.state).toBe("table");
      expect(report.document.encryption).toBeNull();
      expect(report.document.problems).toEqual([]);
      expect(
        report.metadata?.info.find((entry) => entry.key === "Producer")?.value,
      ).toContain("Quartz");
      expect(report.content_sample).toEqual({
        pages_examined: 1,
        by_kind: { text: 1 },
      });
      expect(
        report.coverage.map((entry) => [entry.facet, entry.state]),
      ).toEqual([
        ["identify", "complete"],
        ["inspect", "partial"],
      ]);
    });

    it("returns the words pdftotext returns, in the same order, as text and as layout", async () => {
      const expected = words(oracle.text(path, 1, 1));
      const asText = await inspect(path, { view: "text" });
      expect(
        words(asText.text.join("\n")).filter(
          (word) => word !== "##" && word !== "Page" && word !== "1",
        ),
      ).toEqual(expected);
      expect(asText.text_tool?.name).toBe("pdftotext");
      const asLayout = await inspect(path, { view: "layout" });
      const page = asLayout.layout[0]!;
      expect(page).toMatchObject({ page: 0, width: 612, height: 792 });
      expect(words(page.lines.map((line) => line.text).join(" "))).toEqual(
        expected,
      );
      for (const line of page.lines) {
        const [left, top, right, bottom] = line.bbox;
        expect(left).toBeGreaterThanOrEqual(0);
        expect(right).toBeLessThanOrEqual(612);
        expect(top).toBeLessThan(bottom);
      }
      expect(page.words).toBe(expected.length);
    });

    it("classifies the page and lists its objects", async () => {
      const pages = await inspect(path, { view: "pages" });
      expect(pages.total).toBe(1);
      expect(pages.pages[0]).toMatchObject({
        index: 0,
        kind: "text",
        rotate: 0,
        user_unit: 1,
        images: 0,
      });
      expect(pages.pages[0]!.text_operations).toBeGreaterThan(0);
      expect(pages.pages[0]!.media_box).toEqual([0, 0, 612, 792]);
      const objects = await inspect(path, { view: "objects", limit: 500 });
      const types = objects.objects.map((row) => row.type);
      expect(types).toEqual(
        expect.arrayContaining(["Catalog", "Pages", "Page"]),
      );
      expect(
        objects.objects.every((row) => row.location.startsWith("offset ")),
      ).toBe(true);
      expect(
        objects.objects.some(
          (row) => row.kind === "stream" && row.filters.includes("FlateDecode"),
        ),
      ).toBe(true);
    });
  },
);

describe.skipIf(!have(PDFLATEX, PDFINFO, PDFTOTEXT))(
  "a pdfTeX PDF with object streams",
  () => {
    let path: string;
    beforeAll(async () => {
      path = await latexPdf(
        root(),
        "latex",
        "Hello \\textbf{LaTeX} world.\\newpage Page two text.\\newpage Page three.",
      );
    });

    it("reads the cross-reference stream and compressed objects", async () => {
      const report = await inspect(path);
      const info = oracle.info(path);
      expect(report.document.xref.state).toBe("stream");
      expect(report.document.page_count).toBe(3);
      expect(report.document.page_count).toBe(
        Number(/Pages:\s+(\d+)/u.exec(info)?.[1]),
      );
      expect(report.document.header_version).toBe(
        /PDF version:\s+(\S+)/u.exec(info)?.[1],
      );
      expect(report.document.ids).toHaveLength(2);
      expect(
        report.metadata?.info.find((entry) => entry.key === "Producer")?.value,
      ).toContain("pdfTeX");
      expect(report.document.problems).toEqual([]);
      const objects = await inspect(path, { view: "objects", limit: 200 });
      expect(
        objects.objects.some((row) =>
          row.location.startsWith("object stream "),
        ),
      ).toBe(true);
      expect(
        objects.objects.some(
          (row) => row.type === "ObjStm" && row.kind === "stream",
        ),
      ).toBe(true);
      expect(objects.objects.some((row) => row.type === "XRef")).toBe(true);
    });

    it("pages text one page at a time and continues where it stopped", async () => {
      const first = await inspect(path, { view: "text", limit: 1 });
      expect(first.page).toEqual({ start: 0, limit: 1, returned: 1, next: 1 });
      expect(first.text[0]).toBe("## Page 1");
      expect(first.text.join(" ")).toContain("Hello LaTeX world.");
      const rest = await inspect(path, { view: "text", start: 1, limit: 5 });
      expect(rest.page).toEqual({
        start: 1,
        limit: 5,
        returned: 2,
        next: null,
      });
      expect(rest.text.filter((line) => line.startsWith("## Page"))).toEqual([
        "## Page 2",
        "## Page 3",
      ]);
      expect(rest.text.join(" ")).toContain("Page two text.");
      const beyond = await inspect(path, { view: "text", start: 9, limit: 5 });
      expect(beyond.page).toMatchObject({ returned: 0, next: null });
      expect(beyond.text).toEqual([]);
    });

    it("pages the page rows", async () => {
      const report = await inspect(path, { view: "pages", start: 1, limit: 1 });
      expect(report.page).toEqual({ start: 1, limit: 1, returned: 1, next: 2 });
      expect(report.pages[0]!.index).toBe(1);
    });
  },
);

describe.skipIf(!have(GS, CUPSFILTER, PDFINFO))(
  "an encrypted PDF from Ghostscript",
  () => {
    let source: string;
    beforeAll(async () => {
      source = await quartzPdf(root(), "secret", "Secret text on the page.\n");
    });

    it("describes RC4 encryption and refuses content", async () => {
      const path = await gsEncrypt(root(), source, "enc128", {
        user: "user",
        owner: "owner",
        revision: 3,
        keyLength: 128,
      });
      const report = await inspect(path);
      expect(report.document.encryption).toMatchObject({
        handler: "Standard",
        version: 2,
        revision: 3,
        key_bits: 128,
        method: "rc4",
        public_key: false,
      });
      expect(report.document.encryption?.permissions?.raw).toBe(-4);
      expect(oracle.info(path, "user")).toContain("algorithm:RC4");
      expect(report.metadata).toBeNull();
      expect(report.attachments).toEqual([]);
      expect(report.content_sample).toBeNull();
      expect(report.document.page_count).toBe(1);
      for (const view of ["text", "layout"] as const) {
        const error = await failure(path, { view });
        expect(error._tag).toBe("AnalysisUnsupportedTargetError");
        expect(error.message).toContain("No password is tried");
      }
      const pages = await inspect(path, { view: "pages" });
      expect(pages.pages[0]).toMatchObject({
        kind: "not-read",
        text_operations: 0,
      });
      expect(
        pages.diagnostics.map((entry) => entry.message).join(" "),
      ).toContain("encrypted");
    });

    it("decodes the declared permissions", async () => {
      const path = await gsEncrypt(root(), source, "encperm", {
        user: "",
        owner: "owner",
        revision: 3,
        keyLength: 128,
        permissions: -3904,
      });
      const report = await inspect(path);
      const permissions = report.document.encryption?.permissions;
      expect(permissions).toMatchObject({
        raw: -3904,
        print: false,
        copy: false,
        modify: false,
        annotate: false,
      });
      expect(oracle.info(path)).toContain(
        "print:no copy:no change:no addNotes:no",
      );
    });

    it("describes RC4 40-bit encryption", async () => {
      const path = await gsEncrypt(root(), source, "enc40", {
        user: "u",
        owner: "o",
        revision: 2,
      });
      const report = await inspect(path);
      expect(report.document.encryption).toMatchObject({
        version: 1,
        revision: 2,
        key_bits: 40,
        method: "rc4",
      });
    });
  },
);

describe.skipIf(!have(PDFATTACH, PDFDETACH, CUPSFILTER))(
  "a PDF with an attached file",
  () => {
    it("lists the attachment with the hash of its bytes", async () => {
      const base = await quartzPdf(root(), "carrier", "Carrier page.\n");
      const attachment = await write(
        "notes.txt",
        "attached file contents\nline two\n",
      );
      const path = await attachFile(root(), base, attachment, "attached");
      const report = await inspect(path);
      expect(oracle.attachments(path)).toContain("notes.txt");
      expect(report.attachment_total).toBe(1);
      expect(report.attachments[0]).toMatchObject({
        source: "name-tree",
        name: expect.stringContaining("notes.txt") as string,
        state: "read",
        decoded_bytes: 32,
        sha256: sha256("attached file contents\nline two\n"),
      });
      expect(report.attachments[0]!.declared_bytes).toBe(32);
      // pdfattach appends an update: a second table, a second %%EOF.
      expect(report.document.xref.sections).toBe(2);
      expect(report.document.eof_markers).toBe(2);
      expect(report.document.trailing_bytes).toBe(0);
    });
  },
);

describe.skipIf(!have(PDFTOPPM, SIPS, CUPSFILTER, PDFIMAGES, PDFTOTEXT))(
  "a scanned PDF",
  () => {
    it("names the page image-only and says the text layer is missing", async () => {
      const base = await quartzPdf(
        root(),
        "toscan",
        "Text that becomes pixels.\n",
      );
      const path = await scannedPdf(root(), base, "scanned");
      expect(oracle.images(path).trim().split("\n").length).toBe(3);
      expect(oracle.text(path, 1, 1).trim()).toBe("");
      const pages = await inspect(path, { view: "pages" });
      expect(pages.pages[0]).toMatchObject({
        kind: "image-only",
        text_operations: 0,
        images: 1,
      });
      const text = await inspect(path, { view: "text" });
      expect(text.text.join("\n")).toContain("No text layer");
      expect(text.layout).toEqual([]);
      const layout = await inspect(path, { view: "layout" });
      expect(layout.layout[0]).toMatchObject({ page: 0, words: 0, lines: [] });
      const summary = await inspect(path);
      expect(summary.content_sample?.by_kind).toEqual({ "image-only": 1 });
    });
  },
);
