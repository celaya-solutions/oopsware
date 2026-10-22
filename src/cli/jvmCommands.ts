import { z } from "incur";
import { resolve } from "node:path";
import type { Logger } from "pino";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { createJvmService } from "../composition/jvm.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import {
  decompileJvmClassInputSchema,
  inspectJvmArtifactInputSchema,
  inspectJvmClassInputSchema,
  inspectJvmMethodInputSchema,
} from "../domain/jvm/jvm.js";
import { withCommandCancellation } from "./commandCancellation.js";
import type { CliInstance } from "./types.js";

/** Only options the operator actually passed reach the shared workflow. */
const present = (values: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(values).filter((entry) => entry[1] !== undefined),
  );

/** Read operator-selected class files, JARs and AARs through the same workflows as MCP. */
export const registerJvmCommands = (cli: CliInstance, logger: Logger): void => {
  const service = createJvmService();
  const artifact = inspectJvmArtifactInputSchema.shape;
  const cls = inspectJvmClassInputSchema.shape;
  const method = inspectJvmMethodInputSchema.shape;
  const pathArg = z.object({
    path: z.string().describe("Local .class, .jar or .aar file"),
  });
  const selectorOptions = {
    class: cls.class,
    entry: cls.entry,
    container: cls.container,
    release: cls.release,
  };

  cli.command(CLI_COMMANDS.inspectJvmArtifact, {
    description:
      "List a class file, JAR or AAR's manifest, services, modules, signatures, variants and classes without running it",
    args: pathArg,
    options: z.object({
      start: artifact.start,
      limit: artifact.limit,
      maxFileBytes: artifact.max_file_bytes,
      maxDecodedBytes: artifact.max_decoded_bytes,
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.inspectJvmArtifact, async () => {
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

  cli.command(CLI_COMMANDS.inspectJvmClass, {
    description:
      "Parse one class's fields, methods, annotations and attributes without loading it",
    args: pathArg,
    options: z.object({
      ...selectorOptions,
      maxFileBytes: cls.max_file_bytes,
      maxDecodedBytes: cls.max_decoded_bytes,
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.inspectJvmClass, async () => {
          const result = await service.inspectClass(
            {
              path: resolve(args.path),
              ...present({
                class: options.class,
                entry: options.entry,
                container: options.container,
                release: options.release,
              }),
              max_file_bytes: options.maxFileBytes,
              max_decoded_bytes: options.maxDecodedBytes,
            },
            { signal },
          );
          return result.ok ? result.value : projectAnalysisError(result.error);
        }),
      ),
  });

  cli.command(CLI_COMMANDS.inspectJvmMethod, {
    description:
      "Decode one method's bytecode, exception table, lines and references without running it",
    args: pathArg.extend({
      method: z.string().describe("Method name, e.g. main or <init>"),
    }),
    options: z.object({
      ...selectorOptions,
      descriptor: method.descriptor,
      start: method.start,
      limit: method.limit,
      maxFileBytes: method.max_file_bytes,
      maxDecodedBytes: method.max_decoded_bytes,
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.inspectJvmMethod, async () => {
          const result = await service.inspectMethod(
            {
              path: resolve(args.path),
              method: args.method,
              ...present({
                class: options.class,
                entry: options.entry,
                container: options.container,
                release: options.release,
                descriptor: options.descriptor,
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

  const decompile = decompileJvmClassInputSchema.shape;
  cli.command(CLI_COMMANDS.decompileJvmClass, {
    description:
      "Reconstruct inferred Java source for one class with the installed Vineflower decompiler",
    args: pathArg,
    options: z.object({
      ...selectorOptions,
      siblings: decompile.siblings,
      timeoutMs: decompile.timeout_ms,
      maxHeapMib: decompile.max_heap_mib,
      maxSourceBytes: decompile.max_source_bytes,
      maxFileBytes: decompile.max_file_bytes,
      maxDecodedBytes: decompile.max_decoded_bytes,
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.decompileJvmClass, async () => {
          const result = await service.decompileClass(
            {
              path: resolve(args.path),
              ...present({
                class: options.class,
                entry: options.entry,
                container: options.container,
                release: options.release,
              }),
              siblings: options.siblings,
              timeout_ms: options.timeoutMs,
              max_heap_mib: options.maxHeapMib,
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
