import { isAbsolute } from "node:path";

import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { PdfDocumentPort } from "./PdfDocumentPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import {
  inspectPdfDocumentInputSchema,
  MAX_PDF_TEXT_PAGES,
  pdfDocumentReportSchema,
  resolvePdfLimit,
  type PdfDocumentReport,
} from "../../domain/pdfDocument/pdfDocument.js";
import { err, ok, type Result } from "../../domain/result.js";

/** Omitted optional choices stay absent rather than null. */
const parameters = (input: object) =>
  Object.fromEntries(
    Object.entries(input).filter(
      (entry): entry is [string, string | number] => entry[1] !== undefined,
    ),
  );

/** The provider must answer for the selected path, view and page. */
const consistent = (
  report: PdfDocumentReport,
  input: { path: string; view: string; start: number },
  limit: number,
) => {
  const held =
    report.view === "pages"
      ? report.pages.length
      : report.view === "objects"
        ? report.objects.length
        : report.view === "layout"
          ? report.layout.length
          : report.view === "package"
            ? 0
            : report.page.returned;
  return (
    report.artifact.path === input.path &&
    report.view === input.view &&
    report.page.start === input.start &&
    report.page.limit === limit &&
    report.page.returned <= limit &&
    report.page.returned === held &&
    (report.page.next === null ||
      (report.total !== null &&
        report.page.next === input.start + report.page.returned &&
        report.page.next < report.total))
  );
};

/** Shared caller validation, output checks and Evidence provenance for CLI/MCP. */
export class PdfDocumentService {
  constructor(readonly provider: PdfDocumentPort) {}

  async inspectDocument(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const operation = "inspect_pdf_document";
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(operation));
    const parsed = inspectPdfDocumentInputSchema.safeParse(rawInput);
    if (!parsed.success)
      return err(
        analysisInputErrorFromIssues(operation, parsed.error.issues, rawInput, {
          cause: parsed.error,
        }),
      );
    const input = parsed.data;
    if (!isAbsolute(input.path))
      return err(
        new AnalysisInputError(operation, undefined, [
          {
            path: ["path"],
            reason: "invalid_format",
            message: "Expected an absolute filesystem path on this host.",
          },
        ]),
      );
    const limit = resolvePdfLimit(input.view, input.limit);
    if (
      (input.view === "text" || input.view === "layout") &&
      limit > MAX_PDF_TEXT_PAGES
    )
      return err(
        new AnalysisInputError(operation, undefined, [
          {
            path: ["limit"],
            reason: "invalid_value",
            message: `The text and layout views read at most ${String(MAX_PDF_TEXT_PAGES)} pages per call; use start to continue.`,
          },
        ]),
      );
    const read = await this.provider.inspectDocument(input, options);
    if (!read.ok) return read;
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(operation));
    const report = pdfDocumentReportSchema.safeParse(read.value);
    if (!report.success || !consistent(report.data, input, limit))
      return err(
        new AnalysisOutputError(
          operation,
          "PDF reader returned malformed output or changed the path, view or page.",
        ),
      );
    return ok(
      createEvidence(
        {
          path: report.data.artifact.path,
          format: "file",
          sha256: report.data.artifact.sha256,
        },
        this.provider.identity,
        {
          operation,
          parameters: parameters(input),
          result: report.data,
          confidence: "observed",
          limitations: [...report.data.limitations],
          locations: [
            { kind: "artifact-path", path: report.data.artifact.path },
          ],
        },
      ),
    );
  }
}
