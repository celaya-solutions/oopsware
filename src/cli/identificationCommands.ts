import { z } from "incur";
import { resolve } from "node:path";
import type { Logger } from "pino";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { createIdentificationService } from "../composition/identification.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { identifyArtifactInputSchema } from "../domain/identification/identification.js";
import { withCommandCancellation } from "./commandCancellation.js";
import type { CliInstance } from "./types.js";

/** "What is this?" for an operator-selected file or folder, the same workflow as MCP. */
export const registerIdentificationCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  const service = createIdentificationService();
  const input = identifyArtifactInputSchema.shape;
  cli.command(CLI_COMMANDS.identifyArtifact, {
    description:
      "Say what a file or folder is: its format from the bytes, a headline from the reader that owns it, what is nested inside, and which tool to run next; no file is run or installed",
    args: z.object({
      path: z.string().describe("Local file or folder"),
    }),
    options: z.object({
      depth: input.depth,
      maxEntries: input.max_entries,
      maxReaders: input.max_readers,
      maxSpoolBytes: input.max_spool_bytes,
      maxDecodedBytes: input.max_decoded_bytes,
      start: input.start,
      limit: input.limit,
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.identifyArtifact, async () => {
          const result = await service.identify(
            {
              path: resolve(args.path),
              ...(options.depth === undefined ? {} : { depth: options.depth }),
              max_entries: options.maxEntries,
              max_readers: options.maxReaders,
              max_spool_bytes: options.maxSpoolBytes,
              max_decoded_bytes: options.maxDecodedBytes,
              start: options.start,
              limit: options.limit,
            },
            { signal },
          );
          return result.ok ? result.value : projectAnalysisError(result.error);
        }),
      ),
  });
};
