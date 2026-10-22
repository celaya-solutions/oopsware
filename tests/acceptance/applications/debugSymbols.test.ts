import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Ajv2020 } from "ajv/dist/2020.js";
import { resolve } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { debugSymbolsReportSchema } from "../../../src/domain/debugSymbols/debugSymbols.js";
import {
  SYMBOL_TOOLS,
  buildElf,
  buildMacho,
} from "../../fixtures/debugSymbolProducers.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest.skipIf(SYMBOL_TOOLS === null)(
  "reads a dSYM and a split ELF debug file through the compiled CLI and real stdio MCP with identical evidence",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-symbols-acceptance-");
    const macho = await buildMacho(root, "app", { dwarf: 5 });
    const elf = await buildElf(root, "goapp", {
      buildId: "00112233445566778899aabbccddeeff",
    });

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("scripts/rea.mjs"), "mcp"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "", REA_LOG_LEVEL: "silent" },
      stderr: "pipe",
    });
    const client = new Client({ name: "symbols-acceptance", version: "1" });
    try {
      await client.connect(transport);
      const ajv = new Ajv2020({ strict: false, validateFormats: false });
      const contract = toolContract("inspect_debug_symbols");
      const advertised = (await client.listTools()).tools.find(
        (tool) => tool.name === contract.name,
      );
      if (advertised?.outputSchema === undefined)
        throw new Error("inspect_debug_symbols must publish both schemas");
      const inputSchema: Record<string, unknown> = advertised.inputSchema;
      const outputSchema: Record<string, unknown> = advertised.outputSchema;
      expect(ajv.validateSchema(inputSchema)).toBe(true);
      expect(ajv.validateSchema(outputSchema)).toBe(true);

      const both = async (
        cliArguments: string[],
        mcpArguments: Record<string, unknown>,
      ) => {
        const result = await cli.run({
          arguments: [...cliArguments, "--json"],
        });
        expect(result.exitCode, cliArguments.join(" ")).toBe(0);
        const evidence = contract.outputSchema.parse(result.json);
        const response = await client.callTool({
          name: contract.name,
          arguments: mcpArguments,
        });
        expect(response.isError).not.toBe(true);
        expect(
          ajv.validate(outputSchema, response.structuredContent),
          JSON.stringify(ajv.errors),
        ).toBe(true);
        const mcp = contract.outputSchema.parse(response.structuredContent);
        expect(mcp.evidence_id).toBe(evidence.evidence_id);
        expect(mcp.normalized_result).toEqual(evidence.normalized_result);
        return debugSymbolsReportSchema.parse(mcp.normalized_result);
      };

      const units = await both(["inspect-debug-symbols", macho.dsym], {
        path: macho.dsym,
      });
      expect(units.units.map((unit) => unit.name)).toEqual([
        "app-a.cpp",
        "app-b.cpp",
      ]);

      const paired = await both(
        [
          "inspect-debug-symbols",
          macho.dsym,
          "--binary",
          macho.binary,
          "--view",
          "functions",
        ],
        { path: macho.dsym, binary: macho.binary, view: "functions" },
      );
      expect(paired.images[0]!.pairing).toMatchObject({
        verdict: "matched",
        strength: "strong",
      });
      expect(paired.functions.map((row) => row.name).sort()).toEqual([
        "area",
        "geo_helper",
        "main",
        "perimeter",
      ]);

      const split = await both(
        [
          "inspect-debug-symbols",
          elf.debug,
          "--binary",
          elf.stripped,
          "--limit",
          "2",
        ],
        { path: elf.debug, binary: elf.stripped, limit: 2 },
      );
      expect(split.images[0]!.pairing).toMatchObject({
        verdict: "matched",
        enrichment_allowed: true,
      });
      expect(split.page).toMatchObject({ returned: 2 });

      const lines = await both(
        ["inspect-debug-symbols", macho.dsym, "--view", "lines", "--unit", "0"],
        { path: macho.dsym, view: "lines", unit: 0 },
      );
      expect(lines.lines.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  },
  240_000,
);
