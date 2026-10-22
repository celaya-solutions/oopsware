import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import { expect, it } from "vitest";

import {
  TOOL_CONTRACTS,
  toolContract,
} from "../../../src/contracts/toolContracts.js";
import { EvidenceMcpServer } from "../../../src/server/EvidenceMcpServer.js";
import { toolRegistrationOptions } from "../../../src/server/toolRegistrationOptions.js";
import { createToolResultDelivery } from "../../../src/server/toolResult.js";
import type { ToolContract } from "../../../src/contracts/toolContractTypes.js";
import { CATALOG_IDENTITY } from "../../../src/catalogIdentity.js";

const createServer = (omitOutputSchemas: boolean) =>
  new EvidenceMcpServer(
    { name: "output-schema-fixture", version: "1" },
    { capabilities: {} },
    undefined,
    createToolResultDelivery(10 * 1024 * 1024),
    undefined,
    omitOutputSchemas,
  );

it("omits only output schema advertisements and keeps canonical MCP output validation", async () => {
  const server = createServer(true);
  expect(server.catalogIdentity.digests.combined_sha256).not.toBe(
    CATALOG_IDENTITY.digests.combined_sha256,
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "schema-profile-test", version: "1" });
  const contract = {
    ...toolContract("comment"),
    name: "output_schema_fixture",
    inputSchema: z.strictObject({}),
    outputSchema: z.strictObject({ value: z.string() }),
  } satisfies ToolContract;
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async () => ({
      content: [{ type: "text" as const, text: "fixture" }],
      structuredContent: { value: "complete" },
    }),
  );
  const invalidContract = {
    ...contract,
    name: "invalid_output_schema_fixture",
  } satisfies ToolContract;
  server.registerTool(
    invalidContract.name,
    toolRegistrationOptions(invalidContract),
    async () => ({
      content: [{ type: "text" as const, text: "invalid fixture" }],
      structuredContent: { value: 42 },
    }),
  );

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const tools = (await client.listTools()).tools;
    expect(tools).toHaveLength(2);
    expect(tools.every((tool) => tool.outputSchema === undefined)).toBe(true);
    const success = await client.callTool({
      name: contract.name,
      arguments: {},
    });
    expect(success.isError).not.toBe(true);
    expect(success.structuredContent).toEqual({ value: "complete" });
    const invalid = await client.callTool({
      name: invalidContract.name,
      arguments: {},
    });
    expect(invalid.isError).toBe(true);
    expect(invalid.content).toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("Output validation error"),
      }),
    ]);
  } finally {
    await client.close();
    await server.close();
  }
});

it("keeps a full catalog below a measured one-megabyte frame when output schemas are off", async () => {
  const measure = async (omitOutputSchemas: boolean): Promise<number> => {
    const server = createServer(omitOutputSchemas);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "catalog-size-test", version: "1" });
    for (const contract of TOOL_CONTRACTS)
      server.registerTool(
        contract.name,
        toolRegistrationOptions(contract),
        async () => ({
          content: [{ type: "text" as const, text: "unused" }],
        }),
      );
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = await client.listTools();
      return Buffer.byteLength(JSON.stringify(listed), "utf8");
    } finally {
      await client.close();
      await server.close();
    }
  };

  const fullBytes = await measure(false);
  const compactBytes = await measure(true);
  expect(fullBytes).toBeGreaterThan(1024 * 1024);
  expect(compactBytes).toBeLessThan(1024 * 1024);
  expect(compactBytes).toBeLessThan(fullBytes);
});
