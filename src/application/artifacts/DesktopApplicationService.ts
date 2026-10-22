import { isAbsolute } from "node:path";
import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { DesktopApplicationPort } from "./DesktopApplicationPort.js";
import { ARTIFACT_GRAPH_PROVIDER } from "../InvestigationProviders.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";
import {
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisCancelledError,
} from "../../domain/analysisErrorCore.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import type { Evidence } from "../../domain/evidence.js";
import { createDesktopApplicationEvidence } from "../../domain/desktopApplicationEvidence.js";
import {
  desktopApplicationSchema,
  inspectDesktopApplicationInputSchema,
} from "../../domain/desktopApplication.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { err, type Result } from "../../domain/result.js";

/** One input, interpretation and Evidence boundary shared by CLI, MCP and embedders. */
export class DesktopApplicationService {
  constructor(readonly reader: DesktopApplicationPort) {}
  close(): Promise<void> {
    return this.reader.close();
  }

  async inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const operation = "inspect_desktop_application";
    if (options?.signal?.aborted)
      return err(
        new AnalysisCancelledError(operation, { cause: options.signal.reason }),
      );
    const parsed = inspectDesktopApplicationInputSchema.safeParse(rawInput);
    if (!parsed.success)
      return err(
        analysisInputErrorFromIssues(operation, parsed.error.issues, rawInput, {
          cause: parsed.error,
        }),
      );
    if (!isAbsolute(parsed.data.path))
      return err(
        new AnalysisInputError(operation, undefined, [
          {
            path: ["path"],
            reason: "invalid_format",
            message: "Expected an absolute directory path on this host.",
          },
        ]),
      );
    const result = await this.reader.inspect(parsed.data, options);
    if (!result.ok) return result;
    const report = desktopApplicationSchema.safeParse(result.value);
    if (!report.success || report.data.root.path !== parsed.data.path)
      return err(
        new AnalysisOutputError(
          operation,
          "Directory inspection changed the selected root or returned malformed facts.",
        ),
      );
    return completeProviderEvidence(
      createDesktopApplicationEvidence(
        parsed.data,
        report.data,
        ARTIFACT_GRAPH_PROVIDER,
      ),
      options?.signal,
    );
  }
}
