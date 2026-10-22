import { z } from "incur";
import { resolve } from "node:path";
import type { Logger } from "pino";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { createWebAssemblyService } from "../composition/wasm.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import {
  convertWasmToCInputSchema,
  convertWasmToTextInputSchema,
  inspectWasmFunctionInputSchema,
  inspectWasmModuleInputSchema,
} from "../domain/wasm/webAssembly.js";
import { withCommandCancellation } from "./commandCancellation.js";
import type { CliInstance } from "./types.js";

/** Read operator-selected WebAssembly modules through the same workflows as MCP. */
export const registerWasmCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  const service = createWebAssemblyService();
  const module = inspectWasmModuleInputSchema.shape;
  const func = inspectWasmFunctionInputSchema.shape;
  const convert = convertWasmToTextInputSchema.shape;
  const toC = convertWasmToCInputSchema.shape;
  const pathArg = z.object({
    path: z.string().describe("Local .wasm module or .wat text file"),
  });

  cli.command(CLI_COMMANDS.inspectWasmModule, {
    description:
      "Decode a WebAssembly module's sections, imports, exports and functions without running it",
    args: pathArg,
    options: z.object({
      readAs: module.format,
      start: module.start,
      limit: module.limit,
      maxFileBytes: module.max_file_bytes,
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.inspectWasmModule, async () => {
          const result = await service.inspectModule(
            {
              path: resolve(args.path),
              ...(options.readAs === undefined
                ? {}
                : { format: options.readAs }),
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

  cli.command(CLI_COMMANDS.inspectWasmFunction, {
    description:
      "Decode one WebAssembly function's instructions, direct calls and indirect-call candidates",
    args: pathArg.extend({
      functionIndex: z.coerce
        .number()
        .int()
        .min(0)
        .describe("Function index (imported functions come first)"),
    }),
    options: z.object({
      readAs: func.format,
      start: func.start,
      limit: func.limit,
      maxFileBytes: func.max_file_bytes,
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.inspectWasmFunction, async () => {
          const result = await service.inspectFunction(
            {
              path: resolve(args.path),
              function_index: args.functionIndex,
              ...(options.readAs === undefined
                ? {}
                : { format: options.readAs }),
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

  cli.command(CLI_COMMANDS.convertWasmToText, {
    description:
      "Write the WebAssembly text (WAT) rendering of a module to a new file",
    args: pathArg.extend({
      output: z.string().describe("New .wat file to create; never overwritten"),
    }),
    options: z.object({ maxFileBytes: convert.max_file_bytes }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.convertWasmToText, async () => {
          const result = await service.convertToText(
            {
              path: resolve(args.path),
              output_path: resolve(args.output),
              max_file_bytes: options.maxFileBytes,
            },
            { signal },
          );
          return result.ok ? result.value : projectAnalysisError(result.error);
        }),
      ),
  });

  cli.command(CLI_COMMANDS.convertWasmToC, {
    description:
      "Translate a WebAssembly core module to C with the installed wasm2c and check that it compiles",
    args: pathArg,
    options: z.object({
      readAs: toC.format,
      moduleName: toC.module_name,
      check: toC.check,
      timeoutMs: toC.timeout_ms,
      maxSourceBytes: toC.max_source_bytes,
      maxFileBytes: toC.max_file_bytes,
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.convertWasmToC, async () => {
          const result = await service.convertToC(
            {
              path: resolve(args.path),
              ...(options.readAs === undefined
                ? {}
                : { format: options.readAs }),
              ...(options.moduleName === undefined
                ? {}
                : { module_name: options.moduleName }),
              check: options.check,
              timeout_ms: options.timeoutMs,
              max_source_bytes: options.maxSourceBytes,
              max_file_bytes: options.maxFileBytes,
            },
            { signal },
          );
          return result.ok ? result.value : projectAnalysisError(result.error);
        }),
      ),
  });
};
