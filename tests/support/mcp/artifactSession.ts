import type { Client } from "@modelcontextprotocol/client";
import { expect, type OnTestFinishedHandler } from "vitest";

import { createArtifactBinarySession } from "../../../src/composition/binary.js";
import { createServer } from "../../../src/server/createServer.js";
import type { TestMcp } from "./mcpFixture.js";

/** Open a static artifact target in the production artifact-only MCP composition. */
export const openArtifactTarget = async (
  mcp: TestMcp,
  onTestFinished: (handler: OnTestFinishedHandler) => void,
  path: string,
): Promise<Client> => {
  const session = await createArtifactBinarySession(process.env);
  onTestFinished(async () => {
    await session.close();
  });
  const client = await mcp.connect(createServer({ kind: "session", session }));
  const opened = await client.callTool({
    name: "open_binary",
    arguments: { path },
  });
  expect(opened.isError, JSON.stringify(opened.content)).not.toBe(true);
  return client;
};
