import { z } from "incur";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { parseCliJsonInput } from "../cliJsonInput.js";
import { analysisProviderSelectorSchema } from "../contracts/providerSelection.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { withCommandCancellation } from "./commandCancellation.js";

/** Expose the same static two-path workflow as MCP and the generic dashboard. */
export const registerNativeVersionCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<NodeJS.ProcessEnv>,
): void => {
  cli.command(CLI_COMMANDS.compareNativeVersions, {
    description:
      "Discover native function changes between two local binaries without executing them",
    args: z.object({
      left: z.string().describe("Path to the earlier local native binary"),
      right: z.string().describe("Path to the later local native binary"),
    }),
    options: z.object({
      providerId: analysisProviderSelectorSchema
        .optional()
        .describe(
          "Native analysis provider; omit to use the configured default",
        ),
      leftSha256: z
        .string()
        .optional()
        .describe("Expected SHA-256 digest of the earlier binary"),
      rightSha256: z
        .string()
        .optional()
        .describe("Expected SHA-256 digest of the later binary"),
      selectedPairs: z
        .string()
        .optional()
        .describe(
          "JSON array of left_address/right_address pairs, or a local JSON file path",
        ),
    }),
    run: ({ args, options }) =>
      withCommandCancellation(async (signal) => {
        const selected =
          options.selectedPairs === undefined
            ? { ok: true as const, value: [] }
            : await parseCliJsonInput(
                options.selectedPairs,
                "compare_native_versions",
              );
        if (!selected.ok) return selected.error;
        // Lazy: native provider composition must not load to register the catalog.
        const { createNativeVersionComparison } =
          await import("../composition/nativeVersionComparison.js");
        const service = createNativeVersionComparison(environment, logger);
        const result = await service.compare(
          {
            left: {
              path: args.left,
              ...(options.leftSha256 === undefined
                ? {}
                : { expected_sha256: options.leftSha256 }),
            },
            right: {
              path: args.right,
              ...(options.rightSha256 === undefined
                ? {}
                : { expected_sha256: options.rightSha256 }),
            },
            ...(options.providerId === undefined
              ? {}
              : { provider_id: options.providerId }),
            selected_pairs: selected.value,
          },
          signal,
        );
        return result.ok ? result.value : projectAnalysisError(result.error);
      }),
  });
};
