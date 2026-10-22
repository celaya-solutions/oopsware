import { createServer } from "node:http";

import { expect, it } from "vitest";
import { z } from "zod";

import { createStreamableHttpJebMcpConnection } from "../../../src/jeb/JebMcpConnection.js";
import { AnalysisTimeoutError } from "../../../src/domain/analysisErrorCore.js";

const requestSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.object({ cursor: z.string().optional() }).passthrough().optional(),
});

it("reads every JEB catalog page and refreshes the connected engine catalog", async () => {
  let includeOpen = true;
  let repeatedCursor = false;
  let infinitePages = false;
  let pageCount = 0;
  const cursors: (string | undefined)[] = [];
  const server = createServer(async (request, response) => {
    if (request.method !== "POST") {
      request.resume();
      response.writeHead(request.method === "DELETE" ? 200 : 405).end();
      return;
    }
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const message = requestSchema.parse(JSON.parse(body));
    if (message.id === undefined) {
      if (
        message.method !== "notifications/initialized" &&
        message.method !== "notifications/cancelled"
      )
        throw new Error(`Unexpected JEB notification: ${message.method}`);
      response.writeHead(202).end();
      return;
    }
    let result: unknown;
    if (message.method === "initialize") {
      result = {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "jeb-catalog-fixture", version: "1" },
      };
    } else if (message.method === "tools/list") {
      const cursor = message.params?.cursor;
      pageCount += 1;
      if (!infinitePages) cursors.push(cursor);
      const names =
        cursor === undefined
          ? ["get_client_information"]
          : includeOpen
            ? ["open_project"]
            : ["list_units"];
      result = {
        tools: [...names, "unused_extension"].map((name) => ({
          name,
          inputSchema: { type: "object" },
        })),
        ...(infinitePages
          ? { nextCursor: `fresh-page-${pageCount}` }
          : cursor === undefined || repeatedCursor
            ? { nextCursor: "second-page" }
            : {}),
      };
    } else {
      throw new Error(`Unexpected JEB request: ${message.method}`);
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Expected an ephemeral TCP listener");
  const connection = createStreamableHttpJebMcpConnection(
    new URL(`http://127.0.0.1:${address.port}/mcp`),
    { discoveryTimeoutMs: 1_000 },
  );
  try {
    expect(await connection.listTools()).toEqual([
      "get_client_information",
      "open_project",
    ]);
    includeOpen = false;
    expect(await connection.listTools()).toEqual([
      "get_client_information",
      "list_units",
    ]);
    expect(cursors).toEqual([
      undefined,
      "second-page",
      undefined,
      "second-page",
    ]);
    infinitePages = true;
    const before = pageCount;
    await expect(connection.listTools()).rejects.toBeInstanceOf(
      AnalysisTimeoutError,
    );
    expect(pageCount - before).toBeGreaterThan(2);
    infinitePages = false;
    expect(await connection.listTools()).toEqual([
      "get_client_information",
      "list_units",
    ]);

    // Shared initial acquisition also owns a finite deadline and can recover.
    const acquiring = createStreamableHttpJebMcpConnection(
      new URL(`http://127.0.0.1:${address.port}/mcp`),
      { discoveryTimeoutMs: 1_000 },
    );
    try {
      infinitePages = true;
      await expect(acquiring.listTools()).rejects.toBeInstanceOf(
        AnalysisTimeoutError,
      );
      infinitePages = false;
      expect(await acquiring.listTools()).toEqual([
        "get_client_information",
        "list_units",
      ]);
    } finally {
      await acquiring.close();
    }
    repeatedCursor = true;
    await expect(connection.listTools()).rejects.toThrow(
      "repeated a tool catalog cursor",
    );
    repeatedCursor = false;
    expect(await connection.listTools()).toEqual([
      "get_client_information",
      "list_units",
    ]);
  } finally {
    await connection.close();
    await new Promise<void>((resolve, reject) =>
      server.close((cause) =>
        cause === undefined ? resolve() : reject(cause),
      ),
    );
  }
});
