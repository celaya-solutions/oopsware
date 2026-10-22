import { inspect } from "node:util";
import { SdkErrorCode, SdkHttpError } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createIdaMcpConnection,
  decodeIdaToolResult,
} from "./IdaMcpConnection.js";
import { createIdaDiagnosticRedactor } from "./IdaDiagnosticRedactor.js";
import { AnalysisTimeoutError } from "../domain/analysisErrorCore.js";
import { readSettledHealth } from "./IdaBusyHealth.js";

describe("upstream IDA tool result decoding", () => {
  it("leaves successful legacy, structured, and native evidence unchanged", () => {
    const redact = createIdaDiagnosticRedactor({
      url: "http://127.0.0.1:12345/mcp",
      headers: { Authorization: "Bearer fixture-secret" },
      mode: "attached",
      timeoutMs: 1000,
    });
    const evidence = "Caller-selected fixture-secret evidence";
    expect(
      decodeIdaToolResult(
        { content: [{ type: "text", text: evidence }] },
        undefined,
        redact,
      ),
    ).toBe(evidence);
    expect(
      decodeIdaToolResult(
        { content: [], structuredContent: { evidence } },
        undefined,
        redact,
      ),
    ).toEqual({ evidence });
    expect(
      decodeIdaToolResult(
        { content: [{ type: "text", text: JSON.stringify({ evidence }) }] },
        "native",
        redact,
      ),
    ).toEqual({ evidence });
  });
  it("redacts credentials in truncated-output diagnostics before constructing the error", () => {
    const redact = createIdaDiagnosticRedactor({
      url: "http://127.0.0.1:12345/mcp",
      headers: { Authorization: "Bearer fixture-secret" },
      mode: "attached",
      timeoutMs: 1000,
    });
    expect(() =>
      decodeIdaToolResult(
        {
          content: [],
          _meta: {
            ida_mcp: {
              output_truncated: true,
              download_hint:
                "Download /caller/output?cursor=kept using Bearer fixture-secret",
            },
          },
        },
        undefined,
        redact,
      ),
    ).toThrow(
      "Download /caller/output?cursor=kept using [redacted transport credential]",
    );
  });
  it("decodes scalar wrappers and legacy text without dropping structured dictionaries", () => {
    expect(
      decodeIdaToolResult({
        content: [],
        structuredContent: { result: "code" },
      }),
    ).toBe("code");
    expect(
      decodeIdaToolResult({
        content: [],
        structuredContent: { path: "input", result: "field" },
      }),
    ).toEqual({ path: "input", result: "field" });
    expect(
      decodeIdaToolResult({
        content: [{ type: "text", text: '[{"address":"0x1000"}]' }],
      }),
    ).toEqual([{ address: "0x1000" }]);
    expect(
      decodeIdaToolResult({
        content: [{ type: "text", text: "int main(void);" }],
      }),
    ).toBe("int main(void);");
  });
  it("preserves upstream failures and rejects truncated previews that still satisfy item schemas", () => {
    expect(() => decodeIdaToolResult({ content: [] })).toThrow(
      "empty observation",
    );
    expect(() =>
      decodeIdaToolResult({
        isError: true,
        content: [{ type: "text", text: "Decompiler license is unavailable" }],
      }),
    ).toThrow("Decompiler license is unavailable");
    expect(() =>
      decodeIdaToolResult({
        isError: false,
        structuredContent: {
          result: [{ addr: "0x1000", name: "main", size: "0x20" }],
        },
        content: [{ type: "text", text: "preview" }],
        _meta: {
          ida_mcp: {
            output_truncated: true,
            total_chars: 70000,
            download_hint: "Download the full upstream output",
          },
        },
      }),
    ).toThrow("Download the full upstream output");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const failingHttpConnection = (
  credential: string,
  response: Response | Error,
) => {
  // Exercise the real SDK consumer with an explicitly simulated Fetch boundary.
  vi.stubGlobal(
    "fetch",
    response instanceof Error
      ? vi.fn().mockRejectedValue(response)
      : vi.fn().mockResolvedValue(response),
  );
  return createIdaMcpConnection(
    {
      url: "http://127.0.0.1:12345/mcp",
      headers: { Authorization: "Custom " + credential },
      mode: "attached",
      timeoutMs: 1000,
    },
    {},
  );
};

interface MockedIdaHttpRequest {
  readonly id?: string | number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

const jsonRpcResponse = (value: unknown): Response =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });

const stalledResponse = (signal: AbortSignal | null | undefined) =>
  new Promise<Response>((_resolve, reject) => {
    const aborted = () =>
      reject(new DOMException("The request was aborted", "AbortError"));
    if (signal?.aborted === true) {
      aborted();
      return;
    }
    signal?.addEventListener("abort", aborted, { once: true });
  });

const mockedHttpBoundary = ({
  serverName,
  tools,
  call,
}: {
  readonly serverName: string;
  readonly tools: readonly {
    readonly name: string;
    readonly inputSchema: object;
  }[];
  readonly call: (
    request: MockedIdaHttpRequest,
    signal: AbortSignal | null | undefined,
  ) => Response | Promise<Response>;
}): void => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = JSON.parse(
        String(init?.body ?? ""),
      ) as MockedIdaHttpRequest;
      if (request.method === "initialize")
        return jsonRpcResponse({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            protocolVersion: request.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: serverName, version: "1" },
          },
        });
      if (
        request.method === "notifications/initialized" ||
        request.method === "notifications/cancelled"
      )
        return new Response(null, { status: 202 });
      if (request.method === "tools/list")
        return jsonRpcResponse({
          jsonrpc: "2.0",
          id: request.id,
          result: { tools },
        });
      if (request.method === "tools/call") return call(request, init?.signal);
      throw new Error(`Unexpected fixture request: ${request.method}`);
    }),
  );
};

it("preserves the SDK request timeout as a typed IDA timeout", async () => {
  const timeoutMs = 1000;
  const requestTimeoutMs = 40;
  const pendingCall = vi.fn();
  mockedHttpBoundary({
    serverName: "ida-timeout-fixture",
    tools: [],
    call: (_request, signal) => {
      pendingCall();
      return stalledResponse(signal);
    },
  });
  const connection = createIdaMcpConnection(
    {
      url: "http://127.0.0.1:12345/mcp",
      headers: { Authorization: "Bearer fixture-secret" },
      mode: "attached",
      timeoutMs,
    },
    {},
  );
  try {
    await expect(connection.connect()).resolves.toEqual([]);
    const failure = await connection
      .call("decompile", {}, { timeoutMs: requestTimeoutMs })
      .catch((cause: unknown) => cause);
    expect(pendingCall).toHaveBeenCalledOnce();
    expect(failure).toBeInstanceOf(AnalysisTimeoutError);
    expect(failure).toMatchObject({
      operation: "decompile",
      timeoutMs: requestTimeoutMs,
    });
    if (!(failure instanceof AnalysisTimeoutError))
      throw new Error("Expected a typed IDA request timeout");
    expect(failure.cause).toBeInstanceOf(Error);
    expect(inspectRetainedError(failure)).not.toContain("fixture-secret");
  } finally {
    await connection.close();
  }
});

it("bounds a stalled health poll by the remaining readiness deadline", async () => {
  const timeoutMs = 800;
  const pendingCall = vi.fn();
  let clockNow = 0;
  const clock = {
    now: () => clockNow,
    delay: async (ms: number) => {
      clockNow += ms;
    },
  };
  let pendingCalls = 0;
  const busy = {
    status: "busy",
    busy_tool: "config_json_get",
    busy_sec: 1,
    queued_calls: 0,
  };
  mockedHttpBoundary({
    serverName: "ida-health-deadline-fixture",
    tools: [{ name: "server_health", inputSchema: { type: "object" } }],
    call: (request, signal) => {
      pendingCalls += 1;
      if (pendingCalls === 1) {
        clockNow += 450;
        const result = {
          content: [{ type: "text", text: JSON.stringify(busy) }],
          structuredContent: busy,
        };
        return jsonRpcResponse({ jsonrpc: "2.0", id: request.id, result });
      }
      return stalledResponse(signal);
    },
  });
  const connection = createIdaMcpConnection(
    {
      url: "http://127.0.0.1:12345/mcp",
      headers: {},
      mode: "headless",
      timeoutMs,
    },
    {},
  );
  try {
    await connection.connect();
    const failure = await readSettledHealth(connection, {
      database: "fixture-db",
      timeoutMs,
      clock,
    }).catch((cause: unknown) => cause);

    expect(pendingCalls).toBe(2);
    expect(failure).toBeInstanceOf(AnalysisTimeoutError);
    expect(failure).toMatchObject({
      operation: "server_health: headless worker still busy in config_json_get",
      timeoutMs,
      cause: busy,
      diagnostics: {
        health_request_operation: "server_health",
        health_request_timeout_ms: 250,
      },
    });
    if (!(failure instanceof AnalysisTimeoutError))
      throw new Error("Expected the readiness deadline to expire");
    expect(failure.capturedOutput).toBeDefined();
  } finally {
    await connection.close();
  }
});

const inspectRetainedError = (error: unknown): string =>
  inspect(error, { depth: null, maxStringLength: null, breakLength: Infinity });

describe("retained IDA diagnostic errors", () => {
  it.each([
    {
      credential: "fixture-secret",
      body: '{"reason":"fixture-secret at /caller/input",',
      forbidden: "fixture-secret",
    },
    {
      credential: "<token>",
      body: String.raw`["\u003ctoken\u003e",x]`,
      forbidden: "u003ctoken",
    },
  ])(
    "retains only sanitized malformed HTTP JSON: $credential",
    async ({ credential, body, forbidden }) => {
      const connection = failingHttpConnection(
        credential,
        new Response(body, { headers: { "Content-Type": "application/json" } }),
      );
      const failure: unknown = await connection
        .connect()
        .catch((cause: unknown) => cause);
      expect(failure).toBeInstanceOf(Error);
      if (!(failure instanceof Error))
        throw new Error("Expected a malformed HTTP JSON failure");
      expect(failure.message).toContain("[redacted transport credential]");
      expect(inspectRetainedError(failure)).not.toContain(forbidden);
      expect(inspectRetainedError(failure)).not.toContain(credential);
      await connection.close();
    },
  );

  it("does not rescan an owned malformed JSON replacement marker", async () => {
    const connection = failingHttpConnection(
      "redacted",
      new Response("Rejected redacted", {
        headers: { "Content-Type": "application/json" },
      }),
    );
    const failure: unknown = await connection
      .connect()
      .catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error))
      throw new Error("Expected a malformed HTTP JSON failure");
    expect(failure.message).toBe(
      "IDA MCP returned malformed HTTP JSON. Response body: \nRejected ␟",
    );
    expect(inspectRetainedError(failure)).not.toContain("[[redacted");
    await connection.close();
  });

  it("replaces an unknown network error graph with a safe owned reason", async () => {
    const upstream = Object.assign(
      new Error("fixture-secret refused at /caller/input", {
        cause: new Error("nested fixture-secret"),
      }),
      { headers: { Authorization: "Custom fixture-secret" } },
    );
    const connection = failingHttpConnection("fixture-secret", upstream);
    const failure: unknown = await connection
      .connect()
      .catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error))
      throw new Error("Expected a network failure");
    expect(failure.message).toContain("refused at /caller/input");
    expect(failure.cause).not.toBe(upstream);
    expect(inspectRetainedError(failure)).not.toContain("fixture-secret");
    await connection.close();
  });

  it("retains meaningful HTTP status without unsafe SDK metadata", async () => {
    const connection = failingHttpConnection(
      "fixture-secret",
      new Response("unavailable fixture-secret at /caller/input", {
        status: 500,
        statusText: "fixture-secret",
        headers: { "Content-Type": "text/plain" },
      }),
    );
    const failure: unknown = await connection
      .connect()
      .catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error))
      throw new Error("Expected an HTTP failure");
    expect(failure.cause).toMatchObject({ data: { status: 500 } });
    expect(failure.message).toContain(
      "unavailable [redacted transport credential] at /caller/input",
    );
    expect(inspectRetainedError(failure)).not.toContain("fixture-secret");
    await connection.close();
  });
});

it.each([
  {
    code: SdkErrorCode.ClientHttpNotImplemented,
    message: "Changed SDK context: fixture-secret",
  },
  {
    code: SdkErrorCode.ClientHttpFailedToOpenStream,
    message: "Error POSTing to endpoint: fixture-secret",
  },
])(
  "does not infer owned body spans from an unknown SDK shape: $code / $message",
  async ({ code, message }) => {
    const connection = failingHttpConnection(
      "fixture-secret",
      new SdkHttpError(code, message, { status: 500, text: "fixture-secret" }),
    );
    try {
      const failure = await connection
        .connect()
        .catch((cause: unknown) => cause);
      if (!(failure instanceof Error)) throw new Error("Expected SDK failure");
      expect(inspectRetainedError(failure)).not.toContain("fixture-secret");
      expect(failure.message).toContain("[redacted transport credential]");
      expect(failure.cause).toMatchObject({ code, data: { status: 500 } });
    } finally {
      await connection.close();
    }
  },
);

it("redacts JSON character candidates in unclassified SDK errors", async () => {
  const connection = failingHttpConnection(
    'q"uote',
    new Error(String.raw`network context {"error":"q\"uote"} at /caller/input`),
  );
  try {
    const failure = await connection.connect().catch((cause: unknown) => cause);
    if (!(failure instanceof Error)) throw new Error("Expected SDK failure");
    expect(failure.message).toContain(
      '{"error":"[redacted transport credential]"} at /caller/input',
    );
    expect(inspectRetainedError(failure)).not.toContain(String.raw`q\"uote`);
  } finally {
    await connection.close();
  }
});

it("owns unclassified truncated-output hints separately from their context", () => {
  const diagnostic = createIdaDiagnosticRedactor({
    url: "http://127.0.0.1:12345/mcp",
    mode: "attached",
    timeoutMs: 1000,
    headers: { Authorization: 'Custom q"uote' },
  });
  let failure: unknown;
  try {
    decodeIdaToolResult(
      {
        content: [],
        _meta: {
          ida_mcp: {
            output_truncated: true,
            download_hint: String.raw`{"error":"q\"uote","path":"/caller/output"}`,
          },
        },
      },
      undefined,
      diagnostic,
    );
  } catch (cause: unknown) {
    failure = cause;
  }
  if (!(failure instanceof Error))
    throw new Error("Expected truncation failure");
  expect(failure.message).toContain(
    '{"error":"[redacted transport credential]","path":"/caller/output"}',
  );
  expect(inspectRetainedError(failure)).not.toContain(String.raw`q\"uote`);
});
