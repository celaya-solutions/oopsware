#!/usr/bin/env node

import { snapshotEnvironment } from "./process/snapshotEnvironment.js";
import { CURRENT_ENTRYPOINT_PATH } from "./process/CurrentEntrypointPath.js";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { parseConfig } from "./config/parseConfig.js";
import { createBinarySession } from "./composition/binary.js";
import { createLogger } from "./logger.js";
import { projectAnalysisError } from "./domain/analysisErrorProjection.js";
import type { RuntimeDependencies } from "./main/types.js";
import { SERVER_START_FAILED } from "./main/messages.js";
import { openInitialTarget } from "./main/startup.js";
import { startMcpTransport } from "./main/transport.js";
import {
  createOptionalObservationFactories,
  loadOptionalObservationProviders,
} from "./composition/optionalObservationProviders.js";
import { createToolResultDelivery } from "./server/toolResult.js";
import { createShutdown } from "./main/shutdown.js";
import {
  createExitStatus,
  latchSignalShutdown,
  registerProcessShutdown,
  registerSignalShutdown,
  type ExitStatus,
  type SignalLatch,
} from "./main/processShutdown.js";
import {
  parseMcpHttpEndpoint,
  type McpHttpEndpoint,
} from "./config/mcpHttpEndpoint.js";

const runtimeDependencies = (): RuntimeDependencies => ({
  env: process.env,
  serve: serveStdio,
  writeStderr: (text) => process.stderr.write(text),
  setExitCode: (code) => {
    process.exitCode = code;
  },
  registerShutdown: registerProcessShutdown,
});

/** Replace stdio with the streamable HTTP listener; signals alone end it, never stdin. */
const httpRuntimeDependencies = (
  endpoint: McpHttpEndpoint,
  latch: SignalLatch,
  exit: ExitStatus,
): RuntimeDependencies => {
  const base = runtimeDependencies();
  return {
    ...base,
    setExitCode: exit.set,
    serve: async (factory, options) => {
      // Loaded here so the default stdio entry never loads the HTTP listener.
      const { serveStreamableHttp } =
        await import("./server/http/serveStreamableHttp.js");
      const { RequestTrackingMcpServer } =
        await import("./server/RequestTrackingMcpServer.js");
      // The transport's factory owner closes every instance it created; the listener must not race it.
      return serveStreamableHttp({
        ...endpoint,
        createMcpServer: async (context) => {
          const server = await factory(context);
          if (!(server instanceof RequestTrackingMcpServer))
            throw new TypeError("HTTP MCP servers must track tool completion");
          return server;
        },
        closeInstance: false,
        ...options,
      });
    },
    registerShutdown: (request) => {
      const unregister = registerSignalShutdown((exitStatus) => {
        exit.signal(exitStatus);
        request();
      });
      // A signal that arrived during startup is honoured now that the lifecycle owner exists;
      // its status outlives the entry's own `0`, which startup returns right after this.
      const pending = latch.release();
      if (pending !== undefined) {
        exit.signal(pending);
        request();
      }
      return unregister;
    },
  };
};

/**
 * Start the long-lived MCP adapter and install idempotent shutdown handlers.
 * The adapter owns its BinarySession for the process lifetime; stdin EOF on
 * the stdio transport and process signals on either transport close bridge
 * resources without assuming ownership of the Hopper app.
 */
export const run = async (
  dependencies: RuntimeDependencies = runtimeDependencies(),
): Promise<number> => {
  const environment = snapshotEnvironment(dependencies.env);
  const config = parseConfig(environment);
  if (!config.ok) {
    dependencies.writeStderr(`${projectAnalysisError(config.error).message}\n`);
    return 1;
  }
  const logger = createLogger("mcp", config.value.logLevel);
  const serverLogger = logger.child({ layer: "server" });
  const session = createBinarySession(config.value, logger, environment);
  const opened = await openInitialTarget(
    session,
    config.value,
    serverLogger,
    dependencies.writeStderr,
  );
  if (!opened.ok) return opened.exitCode;
  const transport = await startMcpTransport(dependencies, session, {
    logger,
    serverLogger,
    environment,
    delivery: createToolResultDelivery(config.value.mcpMaxResponseBytes),
    loadOptionalProviders:
      dependencies.loadOptionalProviders ??
      (() =>
        loadOptionalObservationProviders(
          createOptionalObservationFactories(environment),
        )),
  });
  if (!transport.ok) return 1;
  createShutdown({
    handle: transport.handle,
    closeAndroid: transport.closeAndroid,
    closeOptionalProviders: transport.closeOptionalProviders,
    session,
    dependencies,
    serverLogger,
  });
  return 0;
};

/** Run the executable boundary without exposing an unexpected startup cause. */
export const runEntrypoint = async (
  start: () => Promise<number> = () => run(),
  writeStderr: (text: string) => void = (text) => process.stderr.write(text),
  setExitCode: (code: number) => void = (code) => {
    process.exitCode = code;
  },
): Promise<void> => {
  try {
    setExitCode(await start());
  } catch (cause: unknown) {
    // Intentionally redact the startup cause from caller-visible output;
    // unexpected failures must not leak internal details.
    void cause;
    writeStderr(`${SERVER_START_FAILED}\n`);
    setExitCode(1);
  }
};

/** Process streams the dispatcher entries write to. */
export interface EntrypointIo {
  readonly writeStdout: (text: string) => void;
  readonly writeStderr: (text: string) => void;
  readonly setExitCode: (code: number) => void;
}

const processIo: EntrypointIo = {
  writeStdout: (text) => void process.stdout.write(text),
  writeStderr: (text) => void process.stderr.write(text),
  setExitCode: (code) => {
    process.exitCode = code;
  },
};

/** Run `rea mcp --http`: parse its flags, resolve MCP_HOST/MCP_PORT, then serve over HTTP. */
export const runMcpHttpEntrypoint = async (
  arguments_: readonly string[],
  io: EntrypointIo = processIo,
): Promise<void> => {
  const { parseMcpHttpArguments, renderMcpHttpHelp } =
    await import("./main/mcpHttpArguments.js");
  const parsed = parseMcpHttpArguments(arguments_);
  if (!parsed.ok) {
    if (parsed.help) {
      io.writeStdout(`${renderMcpHttpHelp()}\n`);
      io.setExitCode(0);
      return;
    }
    io.writeStderr(`${parsed.message}\n`);
    io.setExitCode(1);
    return;
  }
  const endpoint = parseMcpHttpEndpoint(snapshotEnvironment(process.env), {
    ...(parsed.host === undefined ? {} : { host: parsed.host }),
    ...(parsed.port === undefined ? {} : { port: parsed.port }),
  });
  if (!endpoint.ok) {
    io.writeStderr(`${projectAnalysisError(endpoint.error).message}\n`);
    io.setExitCode(1);
    return;
  }
  // Latched before any asynchronous startup so a signal cannot end the process without cleanup.
  const latch = latchSignalShutdown();
  const exit = createExitStatus(io.setExitCode);
  try {
    await runEntrypoint(
      () => run(httpRuntimeDependencies(endpoint.value, latch, exit)),
      io.writeStderr,
      exit.set,
    );
  } finally {
    latch.release();
  }
};

/** Return false when the runtime's argv path is synthetic or no longer exists. */
const isDirectEntrypoint = (
  entryPath: string | undefined,
  moduleUrl: string,
): boolean => {
  if (entryPath === undefined) return false;
  try {
    return pathToFileURL(realpathSync(entryPath)).href === moduleUrl;
  } catch {
    return false;
  }
};

if (isDirectEntrypoint(CURRENT_ENTRYPOINT_PATH, import.meta.url)) {
  void runEntrypoint();
}
