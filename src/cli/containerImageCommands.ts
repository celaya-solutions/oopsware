import { z } from "incur";
import { resolve } from "node:path";
import type { Logger } from "pino";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { createContainerImageService } from "../composition/containerImage.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { inspectContainerImageInputSchema } from "../domain/containerImage/containerImage.js";
import { withCommandCancellation } from "./commandCancellation.js";
import type { CliInstance } from "./types.js";

/** Read operator-selected container images through the same workflow as MCP. */
export const registerContainerImageCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  const service = createContainerImageService();
  const input = inspectContainerImageInputSchema.shape;
  cli.command(CLI_COMMANDS.inspectContainerImage, {
    description:
      "List an OCI image layout, OCI archive or Docker save archive's images, configuration, layers and composed filesystem without pulling or running anything",
    args: z.object({
      path: z
        .string()
        .describe(
          "Local OCI layout directory, OCI archive or Docker save .tar",
        ),
    }),
    options: z.object({
      platform: input.platform,
      manifest: input.manifest,
      layer: input.layer,
      start: input.start,
      limit: input.limit,
      maxFileBytes: input.max_file_bytes,
      maxDecodedBytes: input.max_decoded_bytes,
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.inspectContainerImage, async () => {
          const result = await service.inspectImage(
            {
              path: resolve(args.path),
              platform: options.platform,
              manifest: options.manifest,
              layer: options.layer,
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
