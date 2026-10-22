import { z } from "incur";
import { resolve } from "node:path";
import type { Logger } from "pino";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { createPythonService } from "../composition/python.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import {
  decompilePythonCodeInputSchema,
  inspectPythonArtifactInputSchema,
  inspectPythonCodeInputSchema,
  inspectPythonModuleInputSchema,
} from "../domain/python/python.js";
import { withCommandCancellation } from "./commandCancellation.js";
import type { CliInstance } from "./types.js";

/** Only options the operator actually passed reach the shared workflow. */
const present = (values: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(values).filter((entry) => entry[1] !== undefined),
  );

/** Read operator-selected .py, .pyc, wheel and zip application files through the same workflows as MCP. */
export const registerPythonCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  const service = createPythonService();
  const artifact = inspectPythonArtifactInputSchema.shape;
  const module = inspectPythonModuleInputSchema.shape;
  const code = inspectPythonCodeInputSchema.shape;
  const decompile = decompilePythonCodeInputSchema.shape;
  const pathArg = z.object({
    path: z.string().describe("Local .py, .pyc, .whl, .pyz or ZIP file"),
  });

  cli.command(CLI_COMMANDS.inspectPythonArtifact, {
    description:
      "List a Python file, wheel or zip application's metadata, RECORD digests, entry points and modules without installing or running it",
    args: pathArg,
    options: z.object({
      start: artifact.start,
      limit: artifact.limit,
      maxFileBytes: artifact.max_file_bytes,
      maxDecodedBytes: artifact.max_decoded_bytes,
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.inspectPythonArtifact, async () => {
          const result = await service.inspectArtifact(
            {
              path: resolve(args.path),
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

  cli.command(CLI_COMMANDS.inspectPythonModule, {
    description:
      "Parse one Python source module's imports, definitions and calls, or list a .pyc's code objects, without running it",
    args: pathArg,
    options: z.object({
      entry: module.entry,
      python: module.python,
      maxListed: module.max_listed,
      timeoutMs: module.timeout_ms,
      maxFileBytes: module.max_file_bytes,
      maxDecodedBytes: module.max_decoded_bytes,
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.inspectPythonModule, async () => {
          const result = await service.inspectModule(
            {
              path: resolve(args.path),
              ...present({ entry: options.entry, python: options.python }),
              max_listed: options.maxListed,
              timeout_ms: options.timeoutMs,
              max_file_bytes: options.maxFileBytes,
              max_decoded_bytes: options.maxDecodedBytes,
            },
            { signal },
          );
          return result.ok ? result.value : projectAnalysisError(result.error);
        }),
      ),
  });

  cli.command(CLI_COMMANDS.inspectPythonCode, {
    description:
      "Decode one .pyc code object's instructions, exception table and constants as its release's dis shows them",
    args: pathArg,
    options: z.object({
      entry: code.entry,
      code: code.code,
      codeIndex: code.code_index,
      start: code.start,
      limit: code.limit,
      maxFileBytes: code.max_file_bytes,
      maxDecodedBytes: code.max_decoded_bytes,
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.inspectPythonCode, async () => {
          const result = await service.inspectCode(
            {
              path: resolve(args.path),
              ...present({
                entry: options.entry,
                code: options.code,
                code_index: options.codeIndex,
              }),
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

  cli.command(CLI_COMMANDS.decompilePythonCode, {
    description:
      "Reconstruct inferred Python source for one .pyc with the installed pycdc decompiler and check it compiles",
    args: pathArg,
    options: z.object({
      entry: decompile.entry,
      check: decompile.check,
      timeoutMs: decompile.timeout_ms,
      maxSourceBytes: decompile.max_source_bytes,
      maxFileBytes: decompile.max_file_bytes,
      maxDecodedBytes: decompile.max_decoded_bytes,
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.decompilePythonCode, async () => {
          const result = await service.decompileCode(
            {
              path: resolve(args.path),
              ...present({ entry: options.entry }),
              check: options.check,
              timeout_ms: options.timeoutMs,
              max_source_bytes: options.maxSourceBytes,
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
