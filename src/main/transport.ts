import { createAndroidAnalysisProvider } from "../composition/android.js";
import type { AndroidAnalysisPort } from "../application/android/AndroidAnalysisPort.js";

import type { BinarySession } from "../application/binary/BinarySession.js";
import type { Logger } from "pino";
import { createServer } from "../server/createServer.js";
import { StreamableHttpListenError } from "../server/http/streamableHttpListenError.js";
import type { ToolResultDelivery } from "../server/toolResult.js";
import type { McpServerHandle, RuntimeDependencies } from "./types.js";
import type { OptionalProviderLoadResult } from "../application/OptionalObservationProviders.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import {
  MCP_CONNECTION_LOST,
  MCP_CONNECTION_START_FAILED,
  MCP_HTTP_LISTEN_FAILED,
} from "./messages.js";

interface ServerContext {
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly delivery: ToolResultDelivery;
  readonly logger: Logger;
  readonly serverLogger: Logger;
  readonly loadOptionalProviders: () => Promise<OptionalProviderLoadResult>;
}

type ClosableOptionalProvider = {
  readonly close?: () => Promise<void>;
};

/** Start the injected transport (stdio or streamable HTTP) around one shared session. */
export const startMcpTransport = async (
  dependencies: RuntimeDependencies,
  session: BinarySession,
  serverContext: ServerContext,
): Promise<
  | {
      readonly ok: true;
      readonly handle: McpServerHandle;
      readonly closeAndroid: () => Promise<void>;
      readonly closeOptionalProviders: () => Promise<void>;
    }
  | { readonly ok: false }
> => {
  const { serverLogger } = serverContext;
  let optionalProviders: OptionalProviderLoadResult = {};
  try {
    optionalProviders = await serverContext.loadOptionalProviders();
  } catch (cause: unknown) {
    serverLogger.warn(
      {
        error: cause instanceof Error ? cause.message : String(cause),
      },
      "Optional MCP providers could not load; affected tools remain unavailable",
    );
  }
  const { optionalProviderLoadFailures, ...observationProviders } =
    optionalProviders;
  for (const failure of Object.values(optionalProviderLoadFailures ?? {})) {
    serverLogger.warn(
      { providerId: failure.providerId, error: failure.reason },
      "Optional MCP adapter could not load; its peers remain available",
    );
  }
  const androidProviders: AndroidAnalysisPort[] = [];
  const servers = new Set<ReturnType<typeof createServer>>();
  const closeServers = async (): Promise<void> => {
    const results = await Promise.allSettled(
      [...servers].map((server) => server.close()),
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0)
      throw new AggregateError(failures, "REA server cleanup failed");
  };
  const closeAndroid = async (): Promise<void> => {
    const results = await Promise.allSettled(
      androidProviders.map((provider) => provider.close()),
    );
    for (const result of results)
      if (result.status === "rejected") throw result.reason;
  };
  // Optional providers are shared by every server instance the SDK creates,
  // including a discarded discovery probe, so only process shutdown closes them.
  const optionalProvidersToClose = new Set<ClosableOptionalProvider>(
    Object.values(observationProviders).filter(
      (provider) => provider !== undefined,
    ),
  );
  let optionalProviderClose: Promise<void> | undefined;
  const closeOptionalProviders = async (): Promise<void> => {
    optionalProviderClose ??= (async () => {
      const results = await Promise.allSettled(
        [...optionalProvidersToClose].map(async (provider) => {
          await provider.close?.();
          optionalProvidersToClose.delete(provider);
        }),
      );
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length > 0)
        throw new AggregateError(failures, "Optional provider cleanup failed");
    })().catch((cause: unknown) => {
      optionalProviderClose = undefined;
      throw cause;
    });
    await optionalProviderClose;
  };
  let handle: McpServerHandle;
  try {
    handle = await dependencies.serve(
      () => {
        // The SDK can discard a discovery probe and construct a replacement server.
        const android = createAndroidAnalysisProvider(
          serverContext.environment,
        );
        androidProviders.push(android);
        const server = (dependencies.createServer ?? createServer)(
          { kind: "session", session },
          {
            logger: serverContext.logger,
            environment: serverContext.environment,
            delivery: serverContext.delivery,
            ...optionalProviders,
            optionalObservationProviderOwner: "caller",
            androidAnalysis: android,
          },
        );
        // The SDK can discard a server even when its provider cleanup failed.
        servers.add(server);
        const closeServer = server.close.bind(server);
        server.close = async () => {
          await closeServer();
          servers.delete(server);
        };
        return server;
      },
      {
        onerror: () => {
          serverLogger.error(MCP_CONNECTION_LOST);
          dependencies.writeStderr(`${MCP_CONNECTION_LOST}\n`);
        },
        logger: serverLogger,
      },
    );
  } catch (cause: unknown) {
    const [
      binaryCleanup,
      androidCleanup,
      serverCleanup,
      optionalProviderCleanup,
    ] = await Promise.allSettled([
      session.close(),
      closeAndroid(),
      closeServers(),
      closeOptionalProviders(),
    ]);
    const startFailure =
      cause instanceof StreamableHttpListenError
        ? MCP_HTTP_LISTEN_FAILED
        : MCP_CONNECTION_START_FAILED;
    serverLogger.error(
      {
        error: cause instanceof Error ? cause.message : String(cause),
      },
      startFailure,
    );
    dependencies.writeStderr(`${startFailure}\n`);
    if (binaryCleanup.status === "fulfilled" && !binaryCleanup.value.ok) {
      const cleanupError = projectAnalysisError(binaryCleanup.value.error);
      serverLogger.error(
        { cleanup_error: cleanupError },
        "Binary provider cleanup failed after MCP startup",
      );
      dependencies.writeStderr(`${cleanupError.message}\n`);
    }
    for (const cleanup of [
      binaryCleanup,
      androidCleanup,
      serverCleanup,
      optionalProviderCleanup,
    ]) {
      if (cleanup.status === "rejected") {
        const reason =
          cleanup.reason instanceof Error
            ? cleanup.reason.message
            : String(cleanup.reason);
        serverLogger.error(
          { cleanup_error: reason },
          "Provider cleanup rejected after MCP startup",
        );
        dependencies.writeStderr(`Provider cleanup failed: ${reason}\n`);
      }
    }
    return { ok: false };
  }
  return {
    ok: true,
    handle: {
      ...(handle.prepareShutdown === undefined
        ? {}
        : { prepareShutdown: handle.prepareShutdown }),
      close: async () => {
        await handle.prepareShutdown?.();
        const results = await Promise.allSettled([
          handle.close(),
          closeServers(),
        ]);
        const failures = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1)
          throw new AggregateError(failures, "REA transport cleanup failed");
      },
    },
    closeAndroid,
    closeOptionalProviders,
  };
};
