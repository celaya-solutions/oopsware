import { z } from "incur";
import { resolve } from "node:path";
import type { Logger } from "pino";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { createPdfDocumentService } from "../composition/pdfDocument.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { inspectPdfDocumentInputSchema } from "../domain/pdfDocument/pdfDocument.js";
import { withCommandCancellation } from "./commandCancellation.js";
import type { CliInstance } from "./types.js";

/** Read operator-selected PDF files through the same workflow as MCP. */
export const registerPdfDocumentCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  const service = createPdfDocumentService();
  const input = inspectPdfDocumentInputSchema.shape;
  cli.command(CLI_COMMANDS.inspectPdfDocument, {
    description:
      "Read a PDF from its bytes: header, cross-reference state, encryption, metadata, attachments, actions (JavaScript, launch and URI targets) and signatures, then per-page kinds (text, scanned image-only, hidden-text OCR layer), the object list, or page text with bounding boxes from an admitted Poppler, without rendering, decrypting, running or fetching anything",
    args: z.object({
      path: z.string().describe("Local PDF file"),
    }),
    options: z.object({
      view: input.view,
      start: input.start,
      limit: input.limit,
      maxFileBytes: input.max_file_bytes,
      maxDecodedBytes: input.max_decoded_bytes,
      timeoutMs: input.timeout_ms,
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.inspectPdfDocument, async () => {
          const result = await service.inspectDocument(
            {
              path: resolve(args.path),
              view: options.view,
              start: options.start,
              limit: options.limit,
              max_file_bytes: options.maxFileBytes,
              max_decoded_bytes: options.maxDecodedBytes,
              timeout_ms: options.timeoutMs,
            },
            { signal },
          );
          return result.ok ? result.value : projectAnalysisError(result.error);
        }),
      ),
  });
};
