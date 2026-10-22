import { z } from "incur";
import { resolve } from "node:path";
import type { Logger } from "pino";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { createOfficeDocumentService } from "../composition/officeDocument.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { inspectOfficeDocumentInputSchema } from "../domain/officeDocument/officeDocument.js";
import { withCommandCancellation } from "./commandCancellation.js";
import type { CliInstance } from "./types.js";

/** Read operator-selected Office documents through the same workflow as MCP. */
export const registerOfficeDocumentCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  const service = createOfficeDocumentService();
  const input = inspectOfficeDocumentInputSchema.shape;
  cli.command(CLI_COMMANDS.inspectOfficeDocument, {
    description:
      "Read a Word, Excel or PowerPoint document (.docx, .xlsx, .pptx and their template and macro-enabled variants, or a legacy 97-2003 .doc, .xls or .ppt) from its bytes: kind, properties, macro and embedded-object inventory, external references, then paragraphs, tables, worksheet rows with formulas and cached values, or slides with notes, without opening it in an application, recalculating, converting or fetching anything",
    args: z.object({
      path: z
        .string()
        .describe("Local Office file (Open XML or legacy 97-2003)"),
    }),
    options: z.object({
      view: input.view,
      part: input.part,
      start: input.start,
      limit: input.limit,
      maxFileBytes: input.max_file_bytes,
      maxDecodedBytes: input.max_decoded_bytes,
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.inspectOfficeDocument, async () => {
          const result = await service.inspectDocument(
            {
              path: resolve(args.path),
              view: options.view,
              part: options.part,
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
