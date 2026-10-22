import { createServer } from "node:http";
import { describe, expect, it } from "vitest";

import {
  decodeJebToolResult,
  createStreamableHttpJebMcpConnection,
} from "./JebMcpConnection.js";
import {
  AnalysisCancelledError,
  AnalysisProtocolError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";

const jebTools = [
  "get_client_information",
  "open_project",
  "list_units",
  "decompile_code_item",
] as const;

const waitForRequestCount = async (
  readCount: () => number,
  expected: number,
  method: string,
): Promise<void> => {
  const deadline = performance.now() + 1_000;
  while (readCount() < expected && performance.now() < deadline)
    await new Promise((wake) => setTimeout(wake, 5));
  if (readCount() < expected)
    throw new Error(`Expected ${expected} ${method} requests`);
};

const startJebHttpFixture = (
  responseDelayMs: number,
  catalogRefreshDelayMs = 0,
) => {
  let callCount = 0;
  let catalogCount = 0;
  const pendingTimers = new Set<NodeJS.Timeout>();
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (chunks.length === 0) {
        response.writeHead(202).end();
        return;
      }
      const message: {
        readonly id?: string | number;
        readonly method: string;
        readonly params?: Record<string, unknown>;
      } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (message.method === "notifications/initialized") {
        response.writeHead(202).end();
        return;
      }
      if (message.method === "notifications/cancelled") {
        response.writeHead(202).end();
        return;
      }
      if (message.method === "initialize") {
        response.writeHead(200, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: message.params?.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "jeb-timeout-fixture", version: "1" },
            },
          }),
        );
        return;
      }
      if (message.method === "tools/list") {
        catalogCount++;
        let responseClosed = false;
        response.on("close", () => {
          if (!response.writableEnded) responseClosed = true;
        });
        const sendCatalog = () => {
          if (responseClosed) return;
          response.writeHead(200, { "Content-Type": "application/json" }).end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                tools: jebTools.map((name) => ({
                  name,
                  inputSchema: { type: "object", properties: {} },
                })),
              },
            }),
          );
        };
        if (catalogCount > 1 && catalogRefreshDelayMs > 0) {
          const timer = setTimeout(() => {
            pendingTimers.delete(timer);
            sendCatalog();
          }, catalogRefreshDelayMs);
          pendingTimers.add(timer);
        } else {
          sendCatalog();
        }
        return;
      }
      if (message.method !== "tools/call") {
        response.writeHead(202).end();
        return;
      }
      callCount++;
      let responseClosed = false;
      response.on("close", () => {
        if (!response.writableEnded) {
          responseClosed = true;
        }
      });
      const timer = setTimeout(() => {
        pendingTimers.delete(timer);
        if (responseClosed) return;
        response.writeHead(200, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              structuredContent: { success: true, text: "finished" },
              content: [{ type: "text", text: '{"success":true}' }],
            },
          }),
        );
      }, responseDelayMs);
      pendingTimers.add(timer);
    });
  });

  return new Promise<{
    readonly endpoint: URL;
    readonly callCount: () => number;
    readonly waitForCall: (count?: number) => Promise<void>;
    readonly waitForCatalog: (count?: number) => Promise<void>;
    readonly close: () => Promise<void>;
  }>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Expected TCP listener"));
        return;
      }
      server.removeListener("error", reject);
      resolve({
        endpoint: new URL(`http://127.0.0.1:${address.port}/mcp`),
        callCount: () => callCount,
        waitForCall: (count = 1) =>
          waitForRequestCount(() => callCount, count, "tools/call"),
        waitForCatalog: (count = 1) =>
          waitForRequestCount(() => catalogCount, count, "tools/list"),
        close: async () => {
          for (const timer of pendingTimers) clearTimeout(timer);
          pendingTimers.clear();
          const closed = new Promise<void>((done, fail) =>
            server.close((cause) =>
              cause === undefined ? done() : fail(cause),
            ),
          );
          server.closeAllConnections();
          await closed;
        },
      });
    });
  });
};

describe("decodeJebToolResult", () => {
  it("passes refusal envelopes through so the provider preserves the engine reason", () => {
    expect(
      decodeJebToolResult({
        isError: true,
        structuredContent: {
          success: false,
          message: "The decompilation failed because the item is missing",
        },
      }),
    ).toEqual({
      success: false,
      message: "The decompilation failed because the item is missing",
    });
  });

  it.each([
    [
      "structured content",
      {
        isError: true,
        structuredContent: {
          success: true,
          input_files: [],
          units: [],
        },
      },
    ],
    [
      "JSON text",
      {
        isError: true,
        content: [{ type: "text", text: '{"success":true}' }],
      },
    ],
  ] as const)("rejects error-marked success in %s", (_source, result) => {
    expect(() => decodeJebToolResult(result)).toThrow(AnalysisProtocolError);
  });

  it("preserves an explicit JEB failure envelope returned as JSON text", () => {
    expect(
      decodeJebToolResult({
        isError: true,
        content: [
          { type: "text", text: '{"success":false,"message":"missing"}' },
        ],
      }),
    ).toEqual({ success: false, message: "missing" });
  });

  it("decodes a single JSON text block", () => {
    expect(
      decodeJebToolResult({
        content: [
          { type: "text", text: '{"success":true,"text":"int x(){}"}' },
        ],
      }),
    ).toEqual({ success: true, text: "int x(){}" });
  });

  it("keeps non-JSON success text as an observed string", () => {
    expect(
      decodeJebToolResult({
        content: [{ type: "text", text: "plain observation" }],
      }),
    ).toBe("plain observation");
  });

  it("rejects unparseable error text as a protocol failure with the engine text", () => {
    expect(() =>
      decodeJebToolResult({
        isError: true,
        content: [{ type: "text", text: "engine exploded" }],
      }),
    ).toThrow(/engine exploded/);
  });

  it("rejects contentless results instead of inventing an observation", () => {
    expect(() => decodeJebToolResult({ content: [] })).toThrow(
      AnalysisProtocolError,
    );
  });
});

it("refuses HTTP redirects before sending requests to another endpoint", async () => {
  let followed = false;
  const server = createServer((request, response) => {
    if (request.url === "/redirected") followed = true;
    request.resume();
    response.writeHead(307, { Location: "/redirected" });
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Expected TCP listener");
  const connection = createStreamableHttpJebMcpConnection(
    new URL(`http://127.0.0.1:${address.port}/mcp`),
  );
  try {
    await expect(connection.connect()).rejects.toThrow();
    expect(followed).toBe(false);
  } finally {
    await connection.close();
    await new Promise<void>((resolve, reject) =>
      server.close((cause) =>
        cause === undefined ? resolve() : reject(cause),
      ),
    );
  }
});

it("applies the selected timeout to real MCP tool calls", async () => {
  const fixture = await startJebHttpFixture(180);
  const short = createStreamableHttpJebMcpConnection(fixture.endpoint, {
    requestTimeoutMs: 50,
  });
  const extended = createStreamableHttpJebMcpConnection(fixture.endpoint, {
    requestTimeoutMs: 500,
  });
  try {
    await short.connect();
    await expect(short.call("decompile_code_item", {})).rejects.toBeInstanceOf(
      AnalysisTimeoutError,
    );
    expect(fixture.callCount()).toBe(1);

    await extended.connect();
    await expect(
      extended.call("decompile_code_item", {}),
    ).resolves.toMatchObject({ success: true, text: "finished" });
    expect(fixture.callCount()).toBe(2);
  } finally {
    try {
      await Promise.all([short.close(), extended.close()]);
    } finally {
      await fixture.close();
    }
  }
});

it("keeps caller abort and connection close as cancellations for active HTTP calls", async () => {
  const fixture = await startJebHttpFixture(1_000);
  const connection = createStreamableHttpJebMcpConnection(fixture.endpoint, {
    requestTimeoutMs: 2_000,
  });
  try {
    await connection.connect();
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(
      connection.call("decompile_code_item", {}, alreadyAborted.signal),
    ).rejects.toBeInstanceOf(AnalysisCancelledError);
    expect(fixture.callCount()).toBe(0);

    const caller = new AbortController();
    const callerCall = connection.call(
      "decompile_code_item",
      {},
      caller.signal,
    );
    await fixture.waitForCall(1);
    caller.abort();
    await expect(callerCall).rejects.toBeInstanceOf(AnalysisCancelledError);

    const closingCall = connection.call("decompile_code_item", {});
    await fixture.waitForCall(2);
    await connection.close();
    await expect(closingCall).rejects.toBeInstanceOf(AnalysisCancelledError);
  } finally {
    try {
      await connection.close();
    } finally {
      await fixture.close();
    }
  }
});

it("keeps caller abort and connection close as cancellations during catalog refresh", async () => {
  const fixture = await startJebHttpFixture(0, 1_000);
  const connection = createStreamableHttpJebMcpConnection(fixture.endpoint);
  try {
    await connection.connect();
    const caller = new AbortController();
    const callerRefresh = connection.listTools(caller.signal);
    await fixture.waitForCatalog(2);
    caller.abort();
    await expect(callerRefresh).rejects.toBeInstanceOf(AnalysisCancelledError);

    const closingRefresh = connection.listTools();
    await fixture.waitForCatalog(3);
    await connection.close();
    await expect(closingRefresh).rejects.toBeInstanceOf(AnalysisCancelledError);
  } finally {
    try {
      await connection.close();
    } finally {
      await fixture.close();
    }
  }
});
