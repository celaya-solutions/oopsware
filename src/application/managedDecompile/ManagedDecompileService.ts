import { isAbsolute } from "node:path";

import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { ManagedDecompilePort } from "./ManagedDecompilePort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import {
  decompileManagedTypeInputSchema,
  managedDecompilationSchema,
} from "../../domain/managed/managedDecompilation.js";
import { err, ok, type Result } from "../../domain/result.js";

/** Omitted optional choices stay absent rather than null. */
const parameters = (input: object) =>
  Object.fromEntries(
    Object.entries(input).filter((entry) => entry[1] !== undefined),
  );

/** Shared caller validation, output checks and Evidence provenance for CLI/MCP. */
export class ManagedDecompileService {
  constructor(readonly provider: ManagedDecompilePort) {}

  async decompileType(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const operation = "decompile_managed_type";
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(operation));
    const parsed = decompileManagedTypeInputSchema.safeParse(rawInput);
    if (!parsed.success)
      return err(
        analysisInputErrorFromIssues(operation, parsed.error.issues, rawInput, {
          cause: parsed.error,
        }),
      );
    const input = parsed.data;
    const relative = [
      ...(isAbsolute(input.path) ? [] : [["path"]]),
      ...input.reference_paths.flatMap((path, index) =>
        isAbsolute(path) ? [] : [["reference_paths", index]],
      ),
    ];
    if (relative.length > 0)
      return err(
        new AnalysisInputError(
          operation,
          undefined,
          relative.map((path) => ({
            path,
            reason: "invalid_format" as const,
            message: "Expected an absolute filesystem path on this host.",
          })),
        ),
      );
    const read = await this.provider.decompileType(input, options);
    if (!read.ok) return read;
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(operation));
    const report = managedDecompilationSchema.safeParse(read.value);
    if (
      !report.success ||
      report.data.artifact.path !== input.path ||
      report.data.selection.type !== (input.type ?? null) ||
      report.data.selection.decompiled !==
        (input.type === undefined
          ? null
          : (input.type.split("+")[0] ?? null)) ||
      !report.data.source.derived_from.includes(report.data.artifact.sha256)
    )
      return err(
        new AnalysisOutputError(
          operation,
          "The .NET decompiler returned malformed output or changed the selected type.",
        ),
      );
    return ok(
      createEvidence(
        {
          path: report.data.artifact.path,
          format: "pe",
          sha256: report.data.artifact.sha256,
        },
        this.provider.identity,
        {
          operation,
          parameters: parameters(input),
          result: report.data,
          confidence: "inferred",
          limitations: [...report.data.limitations],
          locations: [
            { kind: "artifact-path", path: report.data.artifact.path },
          ],
        },
      ),
    );
  }
}
