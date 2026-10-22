import { createHash } from "node:crypto";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createIdentificationService } from "../../src/composition/identification.js";
import { analysisErrorUserMessage } from "../../src/domain/analysisErrorPresentation.js";
import { artifactIdentificationSchema } from "../../src/domain/identification/identification.js";
import {
  produceDemoWheel as wheel,
  ZIP,
} from "../fixtures/identificationProducers.js";
import { textutilDoc } from "../fixtures/legacyDocProducers.js";
import {
  buildPackage,
  MAIN_TYPES,
  para,
  TEXTUTIL,
  wordDocument,
  zip,
} from "../fixtures/officeProducers.js";
import { buildPdf, onePage } from "../fixtures/pdfProducers.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

const answer = (
  result: Awaited<
    ReturnType<ReturnType<typeof createIdentificationService>["identify"]>
  >,
) => {
  if (!result.ok) throw result.error;
  return {
    evidence: result.value,
    report: artifactIdentificationSchema.parse(result.value.normalized_result),
  };
};

describe("identify_artifact through the real readers", () => {
  it.skipIf(ZIP === null)(
    "names a wheel from its own METADATA and lists what is inside",
    async () => {
      const root = await createTestTempDirectory("rea-identify-wheel-");
      const path = await wheel(root);
      const { evidence, report } = answer(
        await createIdentificationService().identify({ path }),
      );
      expect(evidence.operation).toBe("identify_artifact");
      expect(evidence.subject?.digest.sha256).toBe(
        createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
      );
      expect(report.answer).toMatchObject({
        format: "wheel",
        headline: {
          tool: "inspect_python_artifact",
          title: "Python wheel demo 1.2.0",
        },
      });
      expect(report.answer.summary).toMatch(/^Python wheel demo 1\.2\.0 \(/u);
      expect(report.pieces[0]).toMatchObject({ format_basis: "reader" });
      // Parsing source needs an installed CPython, so it is offered, never run.
      expect(
        report.pieces.find((piece) => piece.path === "demo/__init__.py")
          ?.reader,
      ).toMatchObject({
        tool: "inspect_python_artifact",
        state: "needs_provider",
      });
      expect(report.pieces.map((piece) => piece.path)).toContain(
        "demo-1.2.0.dist-info/METADATA",
      );
      expect(report.next_steps.map((step) => step.tool)).toEqual(
        expect.arrayContaining(["inspect_python_artifact", "inspect_artifact"]),
      );
    },
  );

  it("answers for a folder with the document and native readers that own its files", async () => {
    const root = await createTestTempDirectory("rea-identify-folder-");
    await writeFile(
      join(root, "settings.json"),
      '{"theme": "dark", "size": 3}\n',
    );
    await copyFile(process.execPath, join(root, "runtime"));
    const { evidence, report } = answer(
      await createIdentificationService().identify({ path: root }),
    );
    expect(evidence.subject).toMatchObject({ format: "directory" });
    expect(report.subject.sha256_of).toBe("listing");
    const json = report.pieces.find((piece) => piece.path === "settings.json");
    expect(json).toMatchObject({
      format: "json",
      format_basis: "reader",
      headline: {
        tool: "inspect_document",
        title: "JSON document",
        facts: expect.arrayContaining([{ label: "Parse", value: "parsed" }]),
      },
    });
    const runtime = report.pieces.find((piece) => piece.path === "runtime");
    expect(runtime?.reader.state).toMatch(/^(ran|needs_provider)$/u);
    if (runtime?.reader.state === "ran")
      expect(runtime.headline?.title).toMatch(/image|program/u);
    expect(report.answer.summary).toMatch(
      /^Folder with 2 files in 0 subfolders/u,
    );
  });

  it("refuses a relative path and reports a missing one", async () => {
    const service = createIdentificationService();
    const relative = await service.identify({ path: "relative/file" });
    expect(relative.ok).toBe(false);
    if (!relative.ok) expect(relative.error._tag).toBe("AnalysisInputError");
    const missing = await service.identify({ path: "/definitely/not/here" });
    expect(missing.ok).toBe(false);
    if (!missing.ok)
      expect(analysisErrorUserMessage(missing.error)).toMatch(/ENOENT/u);
  });
});

describe("identify_artifact for documents", () => {
  const identify = async (path: string) =>
    answer(await createIdentificationService().identify({ path })).report;

  it("reads a PDF's own structure and says how much of it is scanned", async () => {
    const root = await createTestTempDirectory("rea-identify-pdf-");
    const path = join(root, "plan.pdf");
    await writeFile(
      path,
      buildPdf(
        [
          ...onePage("BT /F1 12 Tf 20 100 Td (Hello) Tj ET"),
          {
            num: 6,
            body: "<< /Title (Quarterly plan) /Producer (rea-test) >>",
          },
        ],
        { trailer: "/Info 6 0 R" },
      ),
    );
    const report = await identify(path);
    expect(report.answer).toMatchObject({
      format: "pdf",
      headline: {
        tool: "inspect_pdf_document",
        title: "PDF 1.7 document",
        facts: expect.arrayContaining([
          { label: "Pages", value: "1" },
          { label: "Title", value: "Quarterly plan" },
          { label: "Producer", value: "rea-test" },
        ]),
      },
    });
    expect(report.pieces[0]).toMatchObject({ format_basis: "bytes" });
  });

  it("reads an Open XML document's kind from its main part and keeps the name's claim", async () => {
    const root = await createTestTempDirectory("rea-identify-docx-");
    const path = join(root, "letter.docx");
    await writeFile(
      path,
      await buildPackage({
        mainPath: "word/document.xml",
        mainType: MAIN_TYPES.docx,
        main: wordDocument(para("Dear Eve")),
        core: `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Letter</dc:title><dc:creator>Eve</dc:creator></cp:coreProperties>`,
      }),
    );
    const report = await identify(path);
    expect(report.answer).toMatchObject({
      format: "ooxml-document",
      headline: {
        tool: "inspect_office_document",
        title: 'Word document "Letter"',
        facts: expect.arrayContaining([{ label: "Author", value: "Eve" }]),
      },
    });
    expect(report.pieces[0]).toMatchObject({ format_basis: "reader" });
  });

  it("flags macros from the content type when the name says a plain workbook", async () => {
    const root = await createTestTempDirectory("rea-identify-xlsm-");
    const path = join(root, "totals.xlsx");
    await writeFile(
      path,
      await buildPackage({
        mainPath: "xl/workbook.xml",
        mainType: MAIN_TYPES.xlsm,
        main: '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets/></workbook>',
      }),
    );
    const report = await identify(path);
    expect(report.answer.headline).toMatchObject({
      tool: "inspect_office_document",
      title: "Excel macro-enabled workbook",
      facts: expect.arrayContaining([{ label: "Macros", value: "Yes" }]),
    });
  });

  it("drops a document name that its own reader refutes and keeps the archive the bytes show", async () => {
    const root = await createTestTempDirectory("rea-identify-fake-docx-");
    const path = join(root, "notes.docx");
    await writeFile(path, await zip({ "readme.txt": "just a zip" }));
    const report = await identify(path);
    expect(report.answer.format).toBe("zip");
    expect(report.pieces[0]?.name_conflict).toMatch(
      /inspect_office_document did not confirm it/u,
    );
  });

  it.skipIf(TEXTUTIL === null)("reads a real Word 97-2003 file", async () => {
    const root = await createTestTempDirectory("rea-identify-doc-");
    const made = await textutilDoc(
      root,
      "old",
      "<html><body><p>Legacy letter</p></body></html>",
    );
    const report = await identify(made.doc);
    expect(report.answer).toMatchObject({
      format: "ole-office-document",
      headline: {
        tool: "inspect_office_document",
        title: "Word 97-2003 document",
      },
    });
  });
});
