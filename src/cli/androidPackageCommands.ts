import { z } from "incur";
import { resolve } from "node:path";
import type { Logger } from "pino";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { createAndroidPackageService } from "../composition/androidPackage.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import {
  decompileDexClassInputSchema,
  inspectAndroidArtifactInputSchema,
  inspectDexClassInputSchema,
  inspectDexMethodInputSchema,
} from "../domain/android/androidArtifact.js";
import { withCommandCancellation } from "./commandCancellation.js";
import type { CliInstance } from "./types.js";

/** Only options the operator actually passed reach the shared workflow. */
const present = (values: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(values).filter((entry) => entry[1] !== undefined),
  );

/** Read operator-selected DEX files and Android packages through the same workflows as MCP. */
export const registerAndroidPackageCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  const service = createAndroidPackageService();
  const artifact = inspectAndroidArtifactInputSchema.shape;
  const cls = inspectDexClassInputSchema.shape;
  const method = inspectDexMethodInputSchema.shape;
  const pathArg = z.object({
    path: z.string().describe("Local .dex, .apk, .aab, .apks or .xapk file"),
  });
  const selectorOptions = { container: cls.container, entry: cls.entry };

  cli.command(CLI_COMMANDS.inspectAndroidArtifact, {
    description:
      "List an Android package's manifests, modules, splits, resources, signatures, DEX files, native libraries and classes without installing or running it",
    args: pathArg,
    options: z.object({
      ...selectorOptions,
      start: artifact.start,
      limit: artifact.limit,
      maxFileBytes: artifact.max_file_bytes,
      maxDecodedBytes: artifact.max_decoded_bytes,
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.inspectAndroidArtifact, async () => {
          const result = await service.inspectArtifact(
            {
              path: resolve(args.path),
              ...present({
                container: options.container,
                entry: options.entry,
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

  cli.command(CLI_COMMANDS.inspectDexClass, {
    description:
      "Parse one DEX class's fields, methods, values and annotations without loading it",
    args: pathArg.extend({
      class: z
        .string()
        .describe("Class descriptor (Lcom/example/Main;) or binary name"),
    }),
    options: z.object({
      ...selectorOptions,
      maxFileBytes: cls.max_file_bytes,
      maxDecodedBytes: cls.max_decoded_bytes,
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.inspectDexClass, async () => {
          const result = await service.inspectClass(
            {
              path: resolve(args.path),
              class: args.class,
              ...present({
                container: options.container,
                entry: options.entry,
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

  cli.command(CLI_COMMANDS.inspectDexMethod, {
    description:
      "Decode one DEX method's Dalvik bytecode, handlers, lines, locals and references without running it",
    args: pathArg.extend({
      class: z
        .string()
        .describe("Class descriptor (Lcom/example/Main;) or binary name"),
      method: z.string().describe("Method name, e.g. onCreate or <init>"),
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
        logCliCommand(logger, CLI_COMMANDS.inspectDexMethod, async () => {
          const result = await service.inspectMethod(
            {
              path: resolve(args.path),
              class: args.class,
              method: args.method,
              ...present({
                container: options.container,
                entry: options.entry,
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

  const decompile = decompileDexClassInputSchema.shape;
  cli.command(CLI_COMMANDS.decompileDexClass, {
    description:
      "Reconstruct inferred Java source for one DEX class with the installed dex2jar and Vineflower, and check it against the DEX",
    args: pathArg.extend({
      class: z
        .string()
        .describe("Class descriptor (Lcom/example/Main;) or binary name"),
    }),
    options: z.object({
      ...selectorOptions,
      timeoutMs: decompile.timeout_ms,
      maxHeapMib: decompile.max_heap_mib,
      maxSourceBytes: decompile.max_source_bytes,
      maxFileBytes: decompile.max_file_bytes,
      maxDecodedBytes: decompile.max_decoded_bytes,
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.decompileDexClass, async () => {
          const result = await service.decompileClass(
            {
              path: resolve(args.path),
              class: args.class,
              ...present({
                container: options.container,
                entry: options.entry,
              }),
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
