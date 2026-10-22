import {
  inspectOfficeDocumentInputSchema,
  officeDocumentReportSchema,
} from "../../domain/officeDocument/officeDocument.js";
import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";

/** Office Open XML and legacy 97-2003 documents (format expansion F12, parts 1 and 3), read in process. */
export const OFFICE_DOCUMENT_TOOL_CONTRACTS = [
  {
    name: "inspect_office_document",
    ...toolContractMetadata("inspect_office_document"),
    kind: "artifact-provider",
    description:
      "Read one explicit local Word, Excel or PowerPoint file (Open XML: .docx, .dotx, .docm, .dotm, .xlsx, .xltx, .xlsm, .xltm, .xlam, .pptx, .potx, .pptm, .potm, .ppsx, .ppsm, .ppam; legacy 97-2003 compound files: .doc, .dot, .xls, .xlt, .ppt, .pot, .pps) from its bytes, without opening it in an application, recalculating, converting, running a macro or fetching a link. The kind comes from the main part's content type (Open XML) or the main stream (legacy), never the file name, and a name that disagrees is reported. view=package (default) returns the kind, core, app and custom properties, a count of what the document holds, the macro, OLE, ActiveX, embedded-file, signature and comment parts (with SHA-256 for the code-bearing ones; a macro project is listed, not unpacked, and its presence is a declaration, not a safety verdict), every external relationship (linked templates, hyperlinks, linked images and objects, external workbook links) as written and never followed, and the content parts you can select. view=parts pages every package part with content type and size. view=content pages typed items of one content part: Word paragraphs (style, heading and list level, hyperlinks, field instructions, tracked-change and hidden-text flags) and tables, comments, footnotes, endnotes, headers and footers; Excel worksheet rows with each cell's type, stored or cached value, formula kept apart from its cached value, shared-formula source, number format and dates derived from the format (visible, hidden, very hidden, chart, dialog and XLM macro sheets); PowerPoint slides with title, shape text, tables, hyperlinks, hidden flag, layout and speaker notes. view=text returns the same content as readable Markdown lines. Omissions say what a read counted but did not describe (pictures, charts, text boxes, equations, blank styled cells). For a legacy file the properties come from the SummaryInformation streams, VBA projects, Excel 4.0 macro sheets and embedded OLE objects are listed and hashed (never run), and the parts view lists the compound file's streams. A password-protected document, Word 6/95 and Excel 5/95 files, a binary .xlsb and PDF are not read by this tool.",
    inputSchema: inspectOfficeDocumentInputSchema,
    outputSchema: evidenceResultOf(officeDocumentReportSchema),
    examples: [
      {
        title: "Summarize a document, its macros and external links",
        input: { path: "/artifacts/report.docm" },
      },
      {
        title:
          "Read the first rows of a worksheet with formulas and cached values",
        input: {
          path: "/artifacts/budget.xlsx",
          view: "content",
          part: "sheet:1",
          limit: 50,
        },
      },
      {
        title: "Read a deck as Markdown",
        input: { path: "/artifacts/deck.pptx", view: "text" },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
