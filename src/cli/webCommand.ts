import { z } from "incur";
import type { CliInstance } from "./types.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";

/** Register the native Oopsware local web interface without starting it at import time. */
export const registerWebCommand = (
  cli: CliInstance,
  environment: Readonly<Record<string, string | undefined>>,
): void => {
  cli.command(CLI_COMMANDS.web, {
    description: "Open Oopsware's local file inspection and AI workspace",
    options: z.object({
      port: z
        .number()
        .int()
        .min(1)
        .max(65535)
        .default(4097)
        .describe("Loopback HTTP port"),
    }),
    run: async ({ options }) => {
      const { startReaWeb } = await import("../web/WebServer.js");
      const app = await startReaWeb({ port: options.port, environment });
      process.stdout.write(`Oopsware workspace: ${app.url}\n`);
      await new Promise<void>((resolve) => {
        const stop = () => {
          process.off("SIGINT", stop);
          process.off("SIGTERM", stop);
          void app.close().finally(resolve);
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
      return { status: "stopped" };
    },
  });
};
