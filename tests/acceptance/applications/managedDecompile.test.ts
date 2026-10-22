import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Ajv2020 } from "ajv/dist/2020.js";
import { resolve } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { managedDecompilationSchema } from "../../../src/domain/managed/managedDecompilation.js";
import { resolveIlspy } from "../../../src/dotnet/ilspy/ilspycmd.js";
import {
  buildDotnetFixtures,
  dotnetSdk,
} from "../../fixtures/dotnetProducers.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const sdk = await dotnetSdk();
const ilspy = await resolveIlspy().then(
  () => true,
  () => false,
);

cliTest.skipIf(sdk === null || !ilspy)(
  "reconstructs SDK-built C# through the compiled CLI and real stdio MCP with identical evidence",
  async ({ cli }) => {
    if (sdk === null) return;
    const root = await createTestTempDirectory("rea-ilspy-acceptance-");
    const fixtures = await buildDotnetFixtures(sdk, root);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("scripts/rea.mjs"), "mcp"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "", REA_LOG_LEVEL: "silent" },
      stderr: "pipe",
    });
    const client = new Client({ name: "ilspy-acceptance", version: "1" });
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    try {
      await client.connect(transport);
      const name = "decompile_managed_type";
      const contract = toolContract(name);
      const advertised = (await client.listTools()).tools.find(
        (tool) => tool.name === name,
      );
      if (advertised?.outputSchema === undefined)
        throw new Error(`${name} must publish both schemas`);
      const inputSchema: Record<string, unknown> = advertised.inputSchema;
      const outputSchema: Record<string, unknown> = advertised.outputSchema;
      expect(ajv.validateSchema(inputSchema)).toBe(true);
      expect(ajv.validateSchema(outputSchema)).toBe(true);
      const result = await cli.run({
        arguments: [
          "decompile-managed-type",
          fixtures.uses,
          "--type",
          "Uses.Gallery",
          "--reference",
          fixtures.shapesDirectory,
          "--json",
        ],
      });
      expect(result.exitCode).toBe(0);
      const evidence = contract.outputSchema.parse(result.json);
      const response = await client.callTool({
        name,
        arguments: {
          path: fixtures.uses,
          type: "Uses.Gallery",
          reference_paths: [fixtures.shapesDirectory],
        },
      });
      expect(response.isError).not.toBe(true);
      expect(
        ajv.validate(outputSchema, response.structuredContent),
        JSON.stringify(ajv.errors),
      ).toBe(true);
      const mcp = contract.outputSchema.parse(response.structuredContent);
      expect(mcp.evidence_id).toBe(evidence.evidence_id);
      expect(mcp.normalized_result).toEqual(evidence.normalized_result);
      expect(mcp.confidence).toBe("inferred");
      const report = managedDecompilationSchema.parse(mcp.normalized_result);
      expect(report.checks.every((check) => check.state === "passed")).toBe(
        true,
      );

      // A relative path, an unknown argument and an unknown type are explicit errors.
      for (const arguments_ of [
        { path: "relative.dll" },
        { path: fixtures.shapes, extra: true },
        { path: fixtures.shapes, type: "Demo.Missing" },
      ]) {
        const rejected = await client.callTool({ name, arguments: arguments_ });
        expect(rejected.isError, JSON.stringify(arguments_)).toBe(true);
      }
    } finally {
      await client.close();
    }
  },
  300_000,
);
