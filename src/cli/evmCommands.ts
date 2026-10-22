import { z } from "incur";
import { evmInterfaceModule } from "../composition/evm.js";
import { logCliCommand } from "../cliLogging.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";

/** Resolve operator paths and preserve explicit encoding through the shared workflow. */
export const registerEvmCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<NodeJS.ProcessEnv>,
): void => {
  const service = evmInterfaceModule.create(environment);
  cli.command(evmInterfaceModule.cliCommand, {
    description: "Infer interface candidates from explicit local EVM bytecode",
    args: z.object({
      path: z.string().describe("Local bytecode carrier"),
      encoding: z
        .enum(["raw", "hex"])
        .describe("Selected carrier representation"),
    }),
    run: ({ args }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, evmInterfaceModule.cliCommand, () =>
          finishAnalysisCommand(
            () =>
              service.inspect(
                {
                  path: absoluteCallerPath(args.path),
                  encoding: args.encoding,
                },
                { signal },
              ),
            service,
            "evmole-interface",
            "inspect_evm_interface",
            signal,
          ),
        ),
      ),
  });
};
