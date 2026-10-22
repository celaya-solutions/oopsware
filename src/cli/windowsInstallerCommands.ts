import { z } from "incur";
import { resolve } from "node:path";
import type { Logger } from "pino";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { createWindowsInstallerService } from "../composition/windowsInstaller.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { inspectMsixPackageInputSchema } from "../domain/windowsInstaller/msixPackage.js";
import { inspectWindowsInstallerInputSchema } from "../domain/windowsInstaller/windowsInstaller.js";
import { withCommandCancellation } from "./commandCancellation.js";
import type { CliInstance } from "./types.js";

/** Read operator-selected MSI and MSIX/AppX files through the same workflows as MCP. */
export const registerWindowsInstallerCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  const service = createWindowsInstallerService();
  const msi = inspectWindowsInstallerInputSchema.shape;
  const msix = inspectMsixPackageInputSchema.shape;

  cli.command(CLI_COMMANDS.inspectWindowsInstaller, {
    description:
      "List an MSI's tables, features, components, files, registry, services and custom actions without installing or running anything",
    args: z.object({ path: z.string().describe("Local .msi file") }),
    options: z.object({
      cabinets: z
        .array(z.string())
        .optional()
        .describe("External cabinet named by the Media table (repeatable)"),
      start: msi.start,
      limit: msi.limit,
      maxFileBytes: msi.max_file_bytes,
      maxDecodedBytes: msi.max_decoded_bytes,
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(
          logger,
          CLI_COMMANDS.inspectWindowsInstaller,
          async () => {
            const result = await service.inspectInstaller(
              {
                path: resolve(args.path),
                ...(options.cabinets === undefined
                  ? {}
                  : {
                      cabinets: options.cabinets.map((path) => resolve(path)),
                    }),
                start: options.start,
                limit: options.limit,
                max_file_bytes: options.maxFileBytes,
                max_decoded_bytes: options.maxDecodedBytes,
              },
              { signal },
            );
            return result.ok
              ? result.value
              : projectAnalysisError(result.error);
          },
        ),
      ),
  });

  cli.command(CLI_COMMANDS.inspectMsixPackage, {
    description:
      "Read an MSIX/AppX package or bundle's manifests, block maps and signature parts without installing it",
    args: z.object({
      path: z
        .string()
        .describe("Local .msix, .appx, .msixbundle or .appxbundle file"),
    }),
    options: z.object({
      container: msix.container,
      maxFileBytes: msix.max_file_bytes,
      maxDecodedBytes: msix.max_decoded_bytes,
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.inspectMsixPackage, async () => {
          const result = await service.inspectMsix(
            {
              path: resolve(args.path),
              ...(options.container === undefined
                ? {}
                : { container: options.container }),
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
