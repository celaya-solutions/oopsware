import { z } from "incur";
import { resolve } from "node:path";
import type { Logger } from "pino";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { createManagedDecompileService } from "../composition/managedDecompile.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { decompileManagedTypeInputSchema } from "../domain/managed/managedDecompilation.js";
import { withCommandCancellation } from "./commandCancellation.js";
import type { CliInstance } from "./types.js";

/** Reconstruct C# from an operator-selected .NET assembly through the same workflow as MCP. */
export const registerManagedDecompileCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  const service = createManagedDecompileService();
  const decompile = decompileManagedTypeInputSchema.shape;
  cli.command(CLI_COMMANDS.decompileManagedType, {
    description:
      "Reconstruct inferred C# for one type of a .NET assembly with the installed ILSpy (ilspycmd) and check it against the metadata",
    args: z.object({
      path: z.string().describe("Local .NET assembly (.dll or .exe)"),
    }),
    options: z.object({
      type: decompile.type,
      reference: z
        .array(z.string())
        .optional()
        .describe(
          "Directory of dependencies read as type context (repeatable)",
        ),
      timeoutMs: decompile.timeout_ms,
      maxSourceBytes: decompile.max_source_bytes,
      maxFileBytes: decompile.max_file_bytes,
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.decompileManagedType, async () => {
          const result = await service.decompileType(
            {
              path: resolve(args.path),
              ...(options.type === undefined ? {} : { type: options.type }),
              reference_paths: (options.reference ?? []).map((path) =>
                resolve(path),
              ),
              timeout_ms: options.timeoutMs,
              max_source_bytes: options.maxSourceBytes,
              max_file_bytes: options.maxFileBytes,
            },
            { signal },
          );
          return result.ok ? result.value : projectAnalysisError(result.error);
        }),
      ),
  });
};
