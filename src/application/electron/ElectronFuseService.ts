import { isAbsolute } from "node:path";

import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { ElectronFusePort } from "./ElectronFusePort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import {
  electronFuseReportSchema,
  inspectElectronFusesInputSchema,
} from "../../domain/electron/electronFuses.js";
import type { Evidence } from "../../domain/evidence.js";
import { createElectronFuseEvidence } from "../../domain/electron/electronFuseEvidence.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { err, ok, type Result } from "../../domain/result.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";

const OPERATION = "inspect_electron_fuses";

/** Shared exact input validation and artifact-bound Evidence for CLI and MCP. */
export class ElectronFuseService {
  constructor(readonly provider: ElectronFusePort) {}

  /** Await and retry the reader's exact retained descriptor owners. */
  async close(): Promise<void> {
    await this.provider.close?.();
  }

  /** Read fuse wires for one explicitly selected path without launching it. */
  async inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    if (options?.signal?.aborted)
      return err(
        new AnalysisCancelledError(OPERATION, { cause: options.signal.reason }),
      );
    const input = inspectElectronFusesInputSchema.safeParse(rawInput);
    if (!input.success)
      return err(
        analysisInputErrorFromIssues(OPERATION, input.error.issues, rawInput, {
          cause: input.error,
        }),
      );
    if (!isAbsolute(input.data.path))
      return err(
        new AnalysisInputError(OPERATION, undefined, [
          {
            path: ["path"],
            reason: "invalid_format",
            message: "Expected an absolute filesystem path on this host.",
          },
        ]),
      );
    const inspected = await this.provider.inspect(input.data, options);
    if (!inspected.ok) return inspected;
    const report = electronFuseReportSchema.safeParse(inspected.value);
    if (
      !report.success ||
      report.data.artifact.selected_path !== input.data.path
    )
      return err(
        new AnalysisOutputError(
          OPERATION,
          "Electron fuse reader returned a malformed report or changed the selected artifact identity.",
        ),
      );
    return completeProviderEvidence(
      createElectronFuseEvidence(
        input.data,
        report.data,
        this.provider.identity,
      ),
      options?.signal,
    );
  }
}
