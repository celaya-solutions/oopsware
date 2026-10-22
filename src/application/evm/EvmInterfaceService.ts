import { isAbsolute } from "node:path";
import { z } from "zod";
import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { EvmInterfacePort } from "./EvmInterfacePort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import type { Evidence } from "../../domain/evidence.js";
import { evmInterfaceEvidence } from "./EvmInterfaceEvidence.js";
import {
  inspectEvmInterfaceInputSchema,
  evmInterfaceSchema,
} from "../../domain/evm/evmInterface.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { err, ok, type Result } from "../../domain/result.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";

const OPERATION = "inspect_evm_interface";
const diagnosticsSchema = z.object({
  diagnostics: evmInterfaceSchema.shape.diagnostics,
});

/** Shared carrier validation and typed inline Evidence for CLI/MCP. */
export class EvmInterfaceService {
  constructor(readonly provider: EvmInterfacePort) {}

  close(): Promise<void> {
    return this.provider.close?.() ?? Promise.resolve();
  }

  /** Preserve selected byte identity while clearly labeling recovered ABI candidates as inferences. */
  async inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    if (options?.signal?.aborted)
      return err(
        new AnalysisCancelledError(OPERATION, { cause: options.signal.reason }),
      );
    const input = inspectEvmInterfaceInputSchema.safeParse(rawInput);
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
    const diagnostics = diagnosticsSchema.safeParse(inspected.value.result);
    const outputOptions = diagnostics.success
      ? { capturedOutput: diagnostics.data.diagnostics }
      : undefined;
    const execution = inspected.value;
    const report = evmInterfaceSchema.safeParse(execution.result);
    if (
      !report.success ||
      report.data.artifact.path !== input.data.path ||
      report.data.artifact.encoding !== input.data.encoding ||
      execution.subject?.format !== "file" ||
      execution.subject?.path !== input.data.path ||
      execution.subject.sha256 !== report.data.artifact.sha256
    )
      return err(
        new AnalysisOutputError(
          OPERATION,
          "Interface adapter returned malformed data or changed the selected carrier identity/encoding.",
          outputOptions,
        ),
      );
    return completeProviderEvidence(
      evmInterfaceEvidence(input.data, execution),
      options?.signal,
      outputOptions?.capturedOutput,
    );
  }
}
