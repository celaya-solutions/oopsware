import { z } from "incur";
import { resolve } from "node:path";
import type { Logger } from "pino";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { createLinuxPackageService } from "../composition/linuxPackage.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { inspectLinuxPackageInputSchema } from "../domain/linuxPackage/linuxPackage.js";
import { withCommandCancellation } from "./commandCancellation.js";
import type { CliInstance } from "./types.js";

/** Read operator-selected Linux packages through the same workflow as MCP. */
export const registerLinuxPackageCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  const service = createLinuxPackageService();
  const input = inspectLinuxPackageInputSchema.shape;
  cli.command(CLI_COMMANDS.inspectLinuxPackage, {
    description:
      "List a .deb, .rpm, AppImage or SquashFS image's identity, dependencies, scripts, signatures and files without installing or running anything",
    args: z.object({
      path: z.string().describe("Local .deb, .rpm, .AppImage or SquashFS file"),
    }),
    options: z.object({
      start: input.start,
      limit: input.limit,
      maxFileBytes: input.max_file_bytes,
      maxDecodedBytes: input.max_decoded_bytes,
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.inspectLinuxPackage, async () => {
          const result = await service.inspectPackage(
            {
              path: resolve(args.path),
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
