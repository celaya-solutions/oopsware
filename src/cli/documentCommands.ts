import { z } from "incur";
import { resolve } from "node:path";
import type { Logger } from "pino";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { createDocumentService } from "../composition/documents.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { inspectDocumentInputSchema } from "../domain/document/structuredText.js";
import { withCommandCancellation } from "./commandCancellation.js";
import type { CliInstance } from "./types.js";

/** Read an operator-selected document through the same workflow as MCP. */
export const registerDocumentCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  const service = createDocumentService();
  const shape = inspectDocumentInputSchema.shape;
  cli.command(CLI_COMMANDS.inspectDocument, {
    description:
      "Read a structured-text document's parsed structure with source locations",
    args: z.object({
      path: z
        .string()
        .describe(
          "Local Markdown, JSON, JSONL, YAML, TOML, XML, CSV, TSV or text file",
        ),
    }),
    options: z.object({
      parseAs: shape.format,
      encoding: shape.encoding,
      delimiter: shape.delimiter,
      start: shape.start,
      limit: shape.limit,
      maxFileBytes: shape.max_file_bytes,
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.inspectDocument, async () => {
          const result = await service.inspect(
            {
              path: resolve(args.path),
              ...(options.parseAs === undefined
                ? {}
                : { format: options.parseAs }),
              ...(options.encoding === undefined
                ? {}
                : { encoding: options.encoding }),
              ...(options.delimiter === undefined
                ? {}
                : { delimiter: options.delimiter }),
              start: options.start,
              limit: options.limit,
              max_file_bytes: options.maxFileBytes,
            },
            { signal },
          );
          return result.ok ? result.value : projectAnalysisError(result.error);
        }),
      ),
  });
};
