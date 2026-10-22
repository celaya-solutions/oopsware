import { z } from "incur";
import { createRustBinaryService } from "../composition/rust.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";

/** Resolve caller paths and inspect embedded Rust dependencies through the shared workflow. */
export const registerRustCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.inspectRustBinary, {
    description:
      "Inspect an embedded cargo-auditable Rust dependency list without target execution",
    args: z.object({
      path: z.string().describe("Local ELF, PE or thin Mach-O image"),
    }),
    run: ({ args }) =>
      withCommandCancellation((signal) => {
        const service = createRustBinaryService();
        return logCliCommand(logger, CLI_COMMANDS.inspectRustBinary, () =>
          finishAnalysisCommand(
            () =>
              service.inspect(
                { path: absoluteCallerPath(args.path) },
                { signal },
              ),
            service,
            "rust-auditable",
            "inspect_rust_binary",
            signal,
          ),
        );
      }),
  });
};
