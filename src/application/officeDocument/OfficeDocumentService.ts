import { isAbsolute } from "node:path";

import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { OfficeDocumentPort } from "./OfficeDocumentPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import {
  inspectOfficeDocumentInputSchema,
  officeDocumentReportSchema,
  type OfficeDocumentReport,
} from "../../domain/officeDocument/officeDocument.js";
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
  report: OfficeDocumentReport,
  input: { path: string; view: string; start: number; limit: number },
) =>
  report.artifact.path === input.path &&
  report.view === input.view &&
  report.page.start === input.start &&
  report.page.limit === input.limit &&
  report.page.returned <= input.limit &&
  report.page.returned ===
    report.parts.length + report.items.length + report.text.length &&
  (report.page.next === null ||
    (report.total !== null &&
      report.page.next === input.start + report.page.returned &&
      report.page.next < report.total));

/** Shared caller validation, output checks and Evidence provenance for CLI/MCP. */
export class OfficeDocumentService {
  constructor(readonly provider: OfficeDocumentPort) {}

  async inspectDocument(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const operation = "inspect_office_document";
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(operation));
    const parsed = inspectOfficeDocumentInputSchema.safeParse(rawInput);
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
    const read = await this.provider.inspectDocument(input, options);
    if (!read.ok) return read;
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(operation));
    const report = officeDocumentReportSchema.safeParse(read.value);
    if (!report.success || !consistent(report.data, input))
      return err(
        new AnalysisOutputError(
          operation,
          "Office document reader returned malformed output or changed the path, view or page.",
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
