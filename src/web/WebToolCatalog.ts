import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import type { ToolContract } from "../contracts/toolContractTypes.js";
import { TOOL_CONTRACTS } from "../contracts/toolContracts.js";
import { toolRegistrationOptions } from "../server/toolRegistrationOptions.js";

/** Advertise every canonical contract through the same SDK conversion as MCP. */
export const createWebToolCatalog = async () => {
  const server = new McpServer({ name: "rea-web-catalog", version: "1" });
  const client = new Client({ name: "rea-web-catalog", version: "1" });
  const contracts: readonly ToolContract[] = TOOL_CONTRACTS;
  for (const contract of contracts) {
    server.registerTool(
      contract.name,
      toolRegistrationOptions(contract),
      async () => ({
        content: [{ type: "text", text: "Discovery only" }],
        isError: true,
      }),
    );
  }
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b);
    await client.connect(a);
    const advertised = new Map(
      (await client.listTools()).tools.map((tool) => [tool.name, tool]),
    );
    return TOOL_CONTRACTS.map((contract) => {
      const tool = advertised.get(contract.name);
      if (!tool) throw new Error(`SDK omitted ${contract.name}`);
      return {
        ...tool,
        kind: contract.kind,
        category: contract.kind,
        effects: contract.effects,
        examples: contract.examples,
      };
    });
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
};
