import {
  analysisEvidenceDeliveryOptions,
  deliverCliAnalysisEvidence,
} from "./analysisEvidenceDelivery.js";
import { z } from "incur";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { createDesktopApplicationService } from "../composition/desktop.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { withCommandCancellation } from "./commandCancellation.js";

/** One-shot complete Evidence can be saved and queried with inspect-analysis-view. */
export const registerDesktopApplicationCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.inspectDesktopApplication, {
    description:
      "Identify desktop runtime candidates from bounded directory and header observations",
    args: z.object({
      path: z.string().describe("Local installation directory"),
    }),
    options: z.object({
      max_entries: z
        .number()
        .int()
        .positive()
        .max(100_000)
        .default(20_000)
        .describe(
          "Maximum directory entries to examine; exhaustion leaves partial coverage",
        ),
      ...analysisEvidenceDeliveryOptions,
      max_probe_bytes: z
        .number()
        .int()
        .min(4096)
        .max(64 * 1024 * 1024)
        .default(8 * 1024 * 1024)
        .describe("Maximum total bytes read from selected file ranges"),
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(
          logger,
          CLI_COMMANDS.inspectDesktopApplication,
          async () => {
            const { detail, evidence_output, ...limits } = options;
            const service = createDesktopApplicationService();
            return deliverCliAnalysisEvidence({
              run: () =>
                service.inspect(
                  { path: absoluteCallerPath(args.path), ...limits },
                  { signal },
                ),
              service,
              providerId: "rea-artifact-graph",
              operation: "inspect_desktop_application",
              signal,
              detail,
              evidenceOutput: evidence_output,
            });
          },
        ),
      ),
  });
};
