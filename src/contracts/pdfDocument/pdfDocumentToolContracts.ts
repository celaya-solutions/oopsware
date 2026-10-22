import {
  inspectPdfDocumentInputSchema,
  pdfDocumentReportSchema,
} from "../../domain/pdfDocument/pdfDocument.js";
import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";

/** PDF documents (format expansion F12, part 2). */
export const PDF_DOCUMENT_TOOL_CONTRACTS = [
  {
    name: "inspect_pdf_document",
    ...toolContractMetadata("inspect_pdf_document"),
    kind: "artifact-provider",
    description:
      "Read one explicit local PDF from its bytes, without rendering, repairing, running or fetching anything. view=package (default) returns the header and catalog version, linearization, the cross-reference state (table, stream, hybrid, or rebuilt by scanning when the file's own offsets are wrong), revisions, %%EOF markers and trailing bytes, trailer IDs, page count (declared and counted), tagged/language/outline/form facts, the encryption handler, method, key size and declared permissions, the Info dictionary and XMP size and hash, every attachment (name, media type, declared and decoded size, SHA-256, declared MD5, state), every action worth reviewing (JavaScript with its start and SHA-256, Launch, URI, GoToR, GoToE, SubmitForm, ImportData, non-embedded file specifications, Rich Media, Movie, Sound, 3D) with where it hangs, every signature with how far its byte ranges reach (whole file, an earlier revision with later bytes it does not cover, or a gap that is not the signature itself), and the kinds of the first pages. view=pages pages one row per page: boxes, rotation, user unit, annotation subtypes, link URIs, and whether the page draws text, text and images, only images (a scanned page), images with hidden text (an OCR layer), only vector paint, or nothing. view=objects pages one row per indirect object: where it lives, its kind, Type, Subtype, filters and stream length. view=text returns page text as Markdown lines and view=layout returns the same text as lines with bounding boxes, both from an admitted Poppler pdftotext in its own layout order (not guaranteed reading order); a page with no text says whether it is image-only; OCR is not run. An encrypted PDF is described and refused for content: no password is tried and nothing is decrypted. Word, Excel and PowerPoint files belong to inspect_office_document.",
    inputSchema: inspectPdfDocumentInputSchema,
    outputSchema: evidenceResultOf(pdfDocumentReportSchema),
    examples: [
      {
        title: "Summarize a PDF, its attachments, scripts and signatures",
        input: { path: "/artifacts/invoice.pdf" },
      },
      {
        title: "Find scanned pages",
        input: { path: "/artifacts/contract.pdf", view: "pages", limit: 50 },
      },
      {
        title: "Read the first pages as text",
        input: { path: "/artifacts/paper.pdf", view: "text", limit: 5 },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
