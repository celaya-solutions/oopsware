import type { McpServerFactory } from "@modelcontextprotocol/server";
import type { Logger } from "pino";

import type { OptionalProviderLoadResult } from "../application/OptionalObservationProviders.js";

/** Teardown handle every MCP transport returns to the runtime. */
export interface McpServerHandle {
  /** Optional transport barrier before shared provider teardown. */
  readonly prepareShutdown?: () => Promise<void>;
  readonly close: () => Promise<void>;
}

/** Runtime inputs shared by the stdio and streamable HTTP transports. */
export interface McpServeOptions {
  readonly onerror?: (error: Error) => void;
  readonly logger?: Logger;
}

/** Start one transport around the server factory; a listener binds asynchronously. */
export type McpServe = (
  factory: McpServerFactory,
  options: McpServeOptions,
) => McpServerHandle | Promise<McpServerHandle>;

export interface RuntimeDependencies {
  readonly env: NodeJS.ProcessEnv;
  readonly serve: McpServe;
  readonly writeStderr: (text: string) => void;
  readonly setExitCode: (code: number) => void;
  readonly registerShutdown: (handler: () => void) => () => void;
  readonly createServer?: typeof import("../server/createServer.js").createServer;
  readonly loadOptionalProviders?: () => Promise<OptionalProviderLoadResult>;
}
