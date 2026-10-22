import { stat } from "node:fs/promises";

import type { ExecutionOptions } from "../../application/AnalysisProvider.js";
import { MANAGED_DECOMPILE_PROVIDER } from "../../application/InvestigationProviders.js";
import type { ManagedDecompilePort } from "../../application/managedDecompile/ManagedDecompilePort.js";
import { readStableArtifact } from "../../artifacts/readStableArtifact.js";
import { stableReadFailure } from "../../artifacts/stableReadFailure.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
  AnalysisUnsupportedTargetError,
} from "../../domain/analysisErrorCore.js";
import type {
  DecompileManagedTypeInput,
  ManagedDecompilation,
} from "../../domain/managed/managedDecompilation.js";
import { err, ok, type Result } from "../../domain/result.js";
import { OwnedCommandFailure } from "../../process/OwnedCommand.js";
import { readManagedPeLayout } from "../ManagedPeReader.js";
import { decompileManagedType, ManagedDecompileFailure } from "./decompile.js";
import { IlspyUnavailable, resolveIlspy } from "./ilspycmd.js";

const OPERATION = "decompile_managed_type";

const failure = (
  input: DecompileManagedTypeInput,
  cause: unknown,
): AnalysisError | null => {
  if (cause instanceof IlspyUnavailable)
    return new AnalysisCapabilityUnavailableError(
      "ilspycmd",
      OPERATION,
      cause.message,
      {
        cause,
      },
    );
  if (cause instanceof ManagedDecompileFailure)
    switch (cause.reason) {
      case "type-not-found":
        return new AnalysisInputError(OPERATION, undefined, [
          { path: ["type"], reason: "invalid_value", message: cause.message },
        ]);
      case "too-large":
        return new AnalysisResourceConstraintError(
          OPERATION,
          "memory",
          cause.message,
          { max_source_bytes: input.max_source_bytes },
          {
            cause,
            remediationAction:
              "Raise max_source_bytes (up to 32 MiB) or choose one type.",
          },
        );
      default:
        return new AnalysisUnsupportedTargetError(
          OPERATION,
          input.path,
          cause.message,
          {
            cause,
          },
        );
    }
  if (!(cause instanceof OwnedCommandFailure)) return null;
  switch (cause.reason) {
    case "cancelled":
      return new AnalysisCancelledError(OPERATION, { cause });
    case "timeout":
      return new AnalysisTimeoutError(OPERATION, input.timeout_ms, { cause });
    case "output-limit":
      return new AnalysisResourceConstraintError(
        OPERATION,
        "memory",
        "ilspycmd printed more diagnostics than the capture budget.",
        null,
        { cause },
      );
    case "process":
      return new AnalysisUnsupportedTargetError(
        OPERATION,
        input.path,
        `ilspycmd exited with code ${String(cause.snapshot?.exitCode ?? "unknown")}.`,
        { cause },
      );
  }
};

const notDirectory = async (path: string): Promise<boolean> => {
  try {
    return !(await stat(path)).isDirectory();
  } catch {
    return true;
  }
};

export class IlspyProvider implements ManagedDecompilePort {
  readonly identity = MANAGED_DECOMPILE_PROVIDER;

  async decompileType(
    input: DecompileManagedTypeInput,
    options?: ExecutionOptions,
  ): Promise<Result<ManagedDecompilation, AnalysisError>> {
    const signal = options?.signal;
    for (const [index, path] of input.reference_paths.entries())
      if (await notDirectory(path))
        return err(
          new AnalysisInputError(OPERATION, undefined, [
            {
              path: ["reference_paths", index],
              reason: "invalid_value",
              message: `${path} is not a readable directory.`,
            },
          ]),
        );
    let snapshot: Awaited<ReturnType<typeof readStableArtifact>>;
    try {
      snapshot = await readStableArtifact(
        input.path,
        input.max_file_bytes,
        signal,
      );
    } catch (cause) {
      return err(
        stableReadFailure(OPERATION, input.path, cause, {
          cancelled: signal?.aborted === true,
          maxFileBytes: input.max_file_bytes,
          remediationAction:
            "Raise max_file_bytes (up to 1 GiB) or select a smaller file.",
        }),
      );
    }
    const bytes = Buffer.from(snapshot.bytes);
    let layout: ReturnType<typeof readManagedPeLayout>;
    try {
      layout = readManagedPeLayout(bytes);
    } catch (cause) {
      return err(
        new AnalysisUnsupportedTargetError(
          OPERATION,
          input.path,
          `The file is not a readable PE image: ${cause instanceof Error ? cause.message : String(cause)}`,
          { cause },
        ),
      );
    }
    if (layout.cli === null)
      return err(
        new AnalysisUnsupportedTargetError(
          OPERATION,
          input.path,
          `The PE image has no readable CLI header, so it is not a .NET assembly${layout.cliIssue === null ? "" : `: ${layout.cliIssue.detail}`}.`,
        ),
      );
    try {
      const tool = await resolveIlspy();
      const report = await decompileManagedType({
        artifact: {
          path: input.path,
          sha256: snapshot.sha256,
          bytes: bytes.length,
        },
        bytes,
        layout,
        input,
        tool,
        signal,
      });
      if (signal?.aborted === true)
        return err(new AnalysisCancelledError(OPERATION));
      return ok(report);
    } catch (cause) {
      const mapped = failure(input, cause);
      if (mapped === null) throw cause;
      return err(mapped);
    }
  }
}
