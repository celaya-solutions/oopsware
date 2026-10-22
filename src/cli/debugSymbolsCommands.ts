import { z } from "incur";
import { resolve } from "node:path";
import type { Logger } from "pino";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { createDebugSymbolsService } from "../composition/debugSymbols.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { inspectDebugSymbolsInputSchema } from "../domain/debugSymbols/debugSymbols.js";
import { withCommandCancellation } from "./commandCancellation.js";
import type { CliInstance } from "./types.js";

/** Read operator-selected debug files through the same workflow as MCP. */
export const registerDebugSymbolsCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  const service = createDebugSymbolsService();
  const input = inspectDebugSymbolsInputSchema.shape;
  cli.command(CLI_COMMANDS.inspectDebugSymbols, {
    description:
      "Read an ELF or Mach-O debug file or .dSYM bundle's DWARF units, functions and line tables, and pair it with an explicit binary by identifier, without running anything or contacting a symbol server",
    args: z.object({
      path: z
        .string()
        .describe("Local ELF/Mach-O debug file or .dSYM bundle directory"),
    }),
    options: z.object({
      binary: input.binary,
      architecture: input.architecture,
      member: input.member,
      view: input.view,
      unit: input.unit,
      start: input.start,
      limit: input.limit,
      maxFileBytes: input.max_file_bytes,
      maxDecodedBytes: input.max_decoded_bytes,
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.inspectDebugSymbols, async () => {
          const result = await service.inspectSymbols(
            {
              path: resolve(args.path),
              binary:
                options.binary === undefined ? undefined : resolve(options.binary),
              architecture: options.architecture,
              member: options.member,
              view: options.view,
              unit: options.unit,
              start: options.start,
              limit: options.limit,
              max_file_bytes: options.maxFileBytes,
              max_decoded_bytes: options.maxDecodedBytes,
            },
            { signal },
          );
          return result.ok ? result.value : projectAnalysisError(result.error);
        }),
      ),
  });
};
