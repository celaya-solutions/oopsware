import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";
import { createServer } from "../../../src/server/createServer.js";
import { NativeVersionComparison } from "../../../src/application/NativeVersionComparison.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { thinMach } from "../../../src/domain/binaryTarget.fixture.js";
import { observed } from "../../fixtures/analysisExecution.js";
import { ok } from "../../../src/domain/result.js";
import { FUNCTION_COMPARISON_EXAMPLE } from "../../../src/contracts/functionComparisonExample.js";
import { functionDossierSchema } from "../../../src/domain/hopperValues.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { nativeVersionComparisonResultSchema } from "../../../src/domain/nativeVersionComparisonSchemas.js";

it("collects independent native versions through MCP and preserves the active caller target", async () => {
  const directory = await createTestTempDirectory("rea-native-version-mcp-");
  const path = join(directory, "binary");
  await writeFile(path, thinMach(0xcffaedfe, 0x0100000c));
  let closed = 0;
  const factory = () =>
    createTestBinarySession(() => ({
      health: () => Promise.resolve(),
      close: () => {
        closed++;
        return Promise.resolve(ok(null));
      },
      execute: (operation) =>
        Promise.resolve(
          observed(
            operation === "health"
              ? {}
              : operation === "list_procedures"
                ? [{ address: "0x1000", value: "main" }]
                : functionDossierSchema.parse(
                    FUNCTION_COMPARISON_EXAMPLE.left.normalized_result,
                  ),
          ),
        ),
    }));
  const session = factory();
  const server = createServer(
    { kind: "session", session },
    {
      nativeVersionComparison: new NativeVersionComparison(() => ok(factory())),
    },
  );
  const client = new Client({
    name: "native-version-comparison",
    version: "1",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const inventory = await client.listTools();
    expect(
      inventory.tools.some((tool) => tool.name === "compare_native_versions"),
    ).toBe(true);
    const opened = await session.open(path);
    expect(opened.ok).toBe(true);
    const active = session.activeTarget();
    const request = {
      left: { path },
      right: { path },
      selected_pairs: [{ left_address: "0x1000", right_address: "0x1000" }],
    };
    const response = await client.callTool({
      name: "compare_native_versions",
      arguments: request,
    });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    const evidence = parseEvidence(response.structuredContent);
    const result = nativeVersionComparisonResultSchema.parse(
      evidence.normalized_result,
    );
    expect(result.comparisons[0]?.selection).toBe("analyst-selected");
    expect(result.left.functions).toHaveLength(1);
    expect(session.activeTarget()).toEqual(active);
    expect(closed).toBe(2);
    expect(
      session
        .exportEvidenceBundle()
        .records.some((record) => record.evidence_id === evidence.evidence_id),
    ).toBe(true);
    const invalid = await client.callTool({
      name: "compare_native_versions",
      arguments: { ...request, left: { path, expected_sha256: "broken" } },
    });
    expect(invalid.isError).toBe(true);
    expect(closed).toBe(2);
  } finally {
    await client.close();
    await server.close();
    await session.close();
  }
});
