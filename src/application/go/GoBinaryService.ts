import { isAbsolute } from "node:path";
import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { GoBinaryPort } from "./GoBinaryPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  goArchitectureForSubject,
  goBinarySchema,
  inspectGoBinaryInputSchema,
} from "../../domain/go/goBinary.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { err, ok, type Result } from "../../domain/result.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";
import {
  requireAnalysisViewRetention,
  summarizeRetainedAnalysis,
  type AnalysisViewRetention,
} from "../analysisView/AnalysisViewService.js";

const OPERATION = "inspect_go_binary";
const NO_RETENTION: AnalysisViewRetention = {
  recordEvidence: undefined,
  evidenceById: undefined,
};

/** Shared exact input validation and artifact-bound Evidence for CLI and MCP. */
export class GoBinaryService {
  constructor(readonly provider: GoBinaryPort) {}

  close(): Promise<void> {
    return this.provider.close?.() ?? Promise.resolve();
  }

  /** Inspect one explicitly selected file without acquiring a binary session. */
  async inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
    retention: AnalysisViewRetention = NO_RETENTION,
  ): Promise<Result<Evidence, AnalysisError>> {
    if (options?.signal?.aborted)
      return err(
        new AnalysisCancelledError(OPERATION, { cause: options.signal.reason }),
      );
    const input = inspectGoBinaryInputSchema.safeParse(rawInput);
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
    const { detail, ...providerInput } = input.data;
    if (detail === "summary") {
      const ready = requireAnalysisViewRetention(OPERATION, retention);
      if (!ready.ok) return ready;
    }
    const inspected = await this.provider.inspect(providerInput, options);
    if (!inspected.ok) return inspected;
    const report = goBinarySchema.safeParse(inspected.value);
    if (!report.success || report.data.artifact.path !== input.data.path)
      return err(
        new AnalysisOutputError(
          OPERATION,
          "Go build-information reader returned malformed metadata or changed the selected artifact identity.",
        ),
      );
    const value = report.data;
    const architecture = goArchitectureForSubject(value.architecture);
    const completed = completeProviderEvidence(
      createEvidence(
        {
          path: value.artifact.path,
          sha256: value.artifact.sha256,
          format: value.format === "macho" ? "mach-o" : value.format,
          ...(architecture === undefined ? {} : { architecture }),
        },
        this.provider.identity,
        {
          operation: OPERATION,
          parameters: providerInput,
          result: value,
          confidence: "observed",
          limitations: value.limitations,
          locations: [
            { kind: "artifact-path", path: value.artifact.path },
            ...(value.build_info === null
              ? []
              : [
                  {
                    kind: "file-offset-range" as const,
                    start: value.build_info.header_offset,
                    end: value.build_info.header_offset + 32,
                  },
                ]),
          ],
        },
      ),
      options?.signal,
    );
    if (!completed.ok) return completed;
    return detail === "summary"
      ? summarizeRetainedAnalysis(completed.value, retention)
      : completed;
  }
}
