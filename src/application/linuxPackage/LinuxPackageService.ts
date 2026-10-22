import { isAbsolute } from "node:path";

import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { LinuxPackagePort } from "./LinuxPackagePort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  inspectLinuxPackageInputSchema,
  linuxPackageReportSchema,
  type LinuxPackageReport,
} from "../../domain/linuxPackage/linuxPackage.js";

/** Omitted optional choices stay absent rather than null. */
const parameters = (input: object) =>
  Object.fromEntries(
    Object.entries(input).filter(
      (entry): entry is [string, string | number] => entry[1] !== undefined,
    ),
  );

/** The provider must answer for the selected file and honour the requested page. */
const consistent = (
  report: LinuxPackageReport,
  input: { path: string; start: number; limit: number },
) =>
  report.artifact.path === input.path &&
  report.files.length === report.page.returned &&
  report.page.start === input.start &&
  report.page.limit === input.limit &&
  report.page.returned <= input.limit &&
  (report.page.next === null
    ? input.start + report.page.returned >= report.file_count
    : report.page.next === input.start + report.page.returned &&
      report.page.next < report.file_count);

/** Shared caller validation, output checks and Evidence provenance for CLI/MCP. */
export class LinuxPackageService {
  constructor(readonly provider: LinuxPackagePort) {}

  async inspectPackage(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const operation = "inspect_linux_package";
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(operation));
    const parsed = inspectLinuxPackageInputSchema.safeParse(rawInput);
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
    const read = await this.provider.inspectPackage(input, options);
    if (!read.ok) return read;
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(operation));
    const report = linuxPackageReportSchema.safeParse(read.value);
    if (!report.success || !consistent(report.data, input))
      return err(
        new AnalysisOutputError(
          operation,
          "Linux package reader returned malformed output or changed the file identity or page.",
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
          // Files carry their own package paths; members and headers carry offsets.
          locations: [
            { kind: "artifact-path", path: report.data.artifact.path },
          ],
        },
      ),
    );
  }
}
