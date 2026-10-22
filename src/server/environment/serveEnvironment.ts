import {
  DEFAULT_MAX_REQUEST_BODY_SIZE,
  fromJsonSchema,
  readRequestBody,
  type CallToolResult,
  type Transport,
} from "@modelcontextprotocol/server";
import type { Logger } from "pino";

import {
  replayEnvironmentTool,
  type ReplayArguments,
} from "../../application/environment/environmentReplay.js";
import type { EnvironmentSource } from "../../application/environment/environmentSource.js";
import {
  environmentCard,
  environmentToolDefinitions,
  REPLAY_CATALOG_INSTRUCTIONS,
  type EnvironmentCard,
  type EnvironmentToolDefinition,
} from "../../application/environment/environmentTools.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { isExactJsonNumber } from "../../domain/exactJsonNumber.js";
import { safeParseJson } from "../../domain/safeJson.js";
import type { AnalysisResourceConstraintError } from "../../domain/analysisErrorCore.js";
import type { StreamableHttpListenError } from "../http/streamableHttpListenError.js";
import { ok, type Result } from "../../domain/result.js";
import { PRODUCT_IDENTITY } from "../../identity.js";
import {
  jsonRpcErrorResponse,
  serveStreamableHttp,
  type StreamableHttpRoute,
  type StreamableHttpServer,
} from "../http/serveStreamableHttp.js";
import {
  TARGET_CONTENT_RESULT_META,
  UNTRUSTED_CONTENT_INSTRUCTIONS,
} from "../toolResultEncoding.js";
import { RequestTrackingMcpServer } from "../RequestTrackingMcpServer.js";
import { TargetContentTransport } from "./targetContentTransport.js";

/** Where the environment card is served. */
export const ENVIRONMENT_CARD_PATH = "/.well-known/agent-env.json";
/** The JSON-RPC data plane the card advertises; this increment answers every method as unknown. */
export const ENVIRONMENT_RPC_PATH = "/agentenv";

const METHOD_NOT_FOUND = -32601;
const INVALID_REQUEST = -32600;
const PARSE_ERROR = -32700;
/** The SDK's code for a body over its bound, so `/agentenv` and `/mcp` refuse alike. */
const PAYLOAD_TOO_LARGE = -32000;

/** Every tool result of a replay server is target content, including errors the SDK builds itself. */
class EnvironmentMcpServer extends RequestTrackingMcpServer {
  override connect(transport: Transport): Promise<void> {
    return super.connect(new TargetContentTransport(transport));
  }
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** At most this many messages in one data-plane batch; a larger batch is refused whole. */
export const MAX_RPC_BATCH_MESSAGES = 100;

/** A JSON-RPC 2.0 request or notification: an id, when present, is a string, number or null; params are structured. */
const isRpcMessage = (
  message: unknown,
): message is Readonly<Record<string, unknown>> =>
  isRecord(message) &&
  message.jsonrpc === "2.0" &&
  typeof message.method === "string" &&
  (!("id" in message) ||
    typeof message.id === "string" ||
    typeof message.id === "number" ||
    message.id === null) &&
  (!("params" in message) ||
    (typeof message.params === "object" && message.params !== null));

/** Build the MCP server whose tools replay retained records; every result is target content. */
export const createEnvironmentMcpServer = (
  name: string,
  source: EnvironmentSource,
  tools: readonly EnvironmentToolDefinition[],
): RequestTrackingMcpServer => {
  // Tool names, descriptions and replies all come from the captured application, so the
  // server carries REA's untrusted-content instructions plus a warning about its own catalog.
  const server = new EnvironmentMcpServer(
    { name, version: PRODUCT_IDENTITY.packageVersion },
    {
      instructions: `${UNTRUSTED_CONTENT_INSTRUCTIONS} ${REPLAY_CATALOG_INSTRUCTIONS}`,
    },
  );
  for (const definition of tools)
    server.registerTool(
      definition.name,
      {
        description: definition.description,
        inputSchema: fromJsonSchema<ReplayArguments>(definition.inputSchema),
      },
      (args): CallToolResult => {
        const replayed = replayEnvironmentTool(source, definition.tool, args);
        if (!replayed.ok)
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify(projectAnalysisError(replayed.error)),
              },
            ],
          };
        return {
          content: [{ type: "text", text: JSON.stringify(replayed.value) }],
          structuredContent: replayed.value,
          _meta: TARGET_CONTENT_RESULT_META,
        };
      },
    );
  return server;
};

interface RpcErrorReply {
  readonly jsonrpc: "2.0";
  readonly id: string | number | null;
  readonly error: { readonly code: number; readonly message: string };
}

/** The reply to one JSON-RPC message: invalid request, method not found, or none for a notification. */
const rpcReply = (message: unknown): RpcErrorReply | undefined => {
  const id =
    isRecord(message) &&
    (typeof message.id === "string" || typeof message.id === "number")
      ? message.id
      : null;
  if (!isRpcMessage(message))
    return {
      jsonrpc: "2.0",
      id,
      error: { code: INVALID_REQUEST, message: "invalid request" },
    };
  if (!("id" in message)) return undefined;
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: METHOD_NOT_FOUND,
      message: `method not found: ${message.method}`,
    },
  };
};

/** Answer the data plane with a JSON-RPC method-not-found error for every request within the body bound. */
const answerRpc = async (request: Request): Promise<Response> => {
  const read = await readRequestBody(request, DEFAULT_MAX_REQUEST_BODY_SIZE);
  if (read.tooLarge)
    return jsonRpcErrorResponse(
      413,
      PAYLOAD_TOO_LARGE,
      `Request body must not exceed ${String(DEFAULT_MAX_REQUEST_BODY_SIZE)} bytes`,
    );
  const parsed = safeParseJson(read.text, (key, value, context) =>
    key === "id" &&
    typeof value === "number" &&
    !isExactJsonNumber(value, context?.source)
      ? Symbol("unrepresentable RPC id")
      : value,
  );
  if (!parsed.ok) return jsonRpcErrorResponse(400, PARSE_ERROR, "parse error");
  // A batch is answered message by message; notifications get no reply at all.
  if (Array.isArray(parsed.value)) {
    if (parsed.value.length === 0)
      return jsonRpcErrorResponse(400, INVALID_REQUEST, "invalid request");
    if (parsed.value.length > MAX_RPC_BATCH_MESSAGES)
      return jsonRpcErrorResponse(
        400,
        INVALID_REQUEST,
        `batch exceeds ${String(MAX_RPC_BATCH_MESSAGES)} messages`,
      );
    const replies = parsed.value
      .map(rpcReply)
      .filter((reply) => reply !== undefined);
    return replies.length === 0
      ? new Response(null, { status: 202 })
      : Response.json(replies);
  }
  const reply = rpcReply(parsed.value);
  return reply === undefined
    ? new Response(null, { status: 202 })
    : Response.json(reply, {
        status: reply.error.code === INVALID_REQUEST ? 400 : 200,
      });
};

/** The plain routes an agent environment serves beside `/mcp`. */
export const environmentRoutes = (
  card: EnvironmentCard,
): readonly StreamableHttpRoute[] => [
  {
    method: "GET",
    path: ENVIRONMENT_CARD_PATH,
    handle: () => Response.json(card),
  },
  { method: "POST", path: ENVIRONMENT_RPC_PATH, handle: answerRpc },
];

export interface ServeEnvironmentOptions {
  readonly source: EnvironmentSource;
  readonly host: string;
  readonly port: number;
  readonly signal?: AbortSignal;
  /** Served name; defaults to the manifest's environment name. */
  readonly environmentName?: string;
  readonly logger?: Logger;
  /** Reports a listener failure after binding; the failure is logged either way. */
  readonly onerror?: (error: StreamableHttpListenError) => void;
}

/** A listening agent environment and the card it serves. */
export interface ServedEnvironment extends StreamableHttpServer {
  readonly card: EnvironmentCard;
}

/** Serve one manifest as an agent environment until closed. */
export const serveEnvironment = async (
  options: ServeEnvironmentOptions,
): Promise<Result<ServedEnvironment, AnalysisResourceConstraintError>> => {
  const { source, host, port, logger } = options;
  const name = options.environmentName ?? source.manifest.name;
  const prepared = environmentToolDefinitions(
    source.manifest,
    source.evidenceId,
    name,
  );
  if (!prepared.ok) return prepared;
  const tools = prepared.value;
  const card = environmentCard(name, tools);
  const served = await serveStreamableHttp({
    host,
    port,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    createMcpServer: () => createEnvironmentMcpServer(name, source, tools),
    routes: environmentRoutes(card),
    ...(logger === undefined ? {} : { logger }),
    onerror: (error) => {
      logger?.error(
        { error: error.message },
        "Agent environment listener failed",
      );
      options.onerror?.(error);
    },
  });
  return ok({ ...served, card });
};
