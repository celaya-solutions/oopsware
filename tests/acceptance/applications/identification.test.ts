import { Client } from "@modelcontextprotocol/client";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Ajv2020 } from "ajv/dist/2020.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { artifactIdentificationSchema } from "../../../src/domain/identification/identification.js";
import { BSDTAR, GZIP } from "../../fixtures/archiveProducers.js";
import { produceTarGz } from "../../fixtures/identificationProducers.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest.skipIf(GZIP === null)(
  "answers what a nested archive and a folder are through the compiled CLI and real stdio MCP with identical evidence",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-identify-acceptance-");
    const stage = join(root, "stage");
    await mkdir(join(stage, "inner"), { recursive: true });
    await writeFile(join(stage, "inner", "data.csv"), "a,b\n1,2\n");
    await writeFile(join(stage, "notes.md"), "# Notes\n");
    await produceTarGz(stage, join(root, "inner.tar.gz"), ["inner"]);
    await produceTarGz(root, join(root, "outer.tar.gz"), [
      "inner.tar.gz",
      "stage/notes.md",
    ]);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("scripts/rea.mjs"), "mcp"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "", REA_LOG_LEVEL: "silent" },
      stderr: "pipe",
    });
    const client = new Client({ name: "identify-acceptance", version: "1" });
    const contract = toolContract("identify_artifact");
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    try {
      await client.connect(transport);
      const advertised = (await client.listTools()).tools.find(
        (tool) => tool.name === "identify_artifact",
      );
      if (advertised?.outputSchema === undefined)
        throw new Error("identify_artifact must publish both schemas");
      const outputSchema: Record<string, unknown> = advertised.outputSchema;
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
          name: "identify_artifact",
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
        return artifactIdentificationSchema.parse(mcp.normalized_result);
      };

      const outer = join(root, "outer.tar.gz");
      const archive = await both(["identify-artifact", outer], { path: outer });
      expect(archive.answer.format).toBe("gzip");
      expect(archive.coverage.containers_opened).toBe(2);
      const csv = archive.pieces.find(
        (piece) => piece.path === "inner.tar.gz/inner/data.csv",
      );
      expect(csv).toMatchObject({
        depth: 2,
        format: "csv",
        headline: { tool: "inspect_document", title: "CSV document" },
      });
      expect(archive.next_steps).toContainEqual(
        expect.objectContaining({
          tool: "extract_artifact",
          open_first: outer,
        }),
      );

      const folder = await both(
        ["identify-artifact", stage, "--depth", "1", "--limit", "2"],
        { path: stage, depth: 1, limit: 2 },
      );
      expect(folder.subject.kind).toBe("directory");
      expect(folder.page).toMatchObject({ start: 0, returned: 2, next: 2 });
      expect(folder.formats.map(({ label }) => label)).toEqual(
        expect.arrayContaining(["Markdown", "CSV"]),
      );
    } finally {
      await client.close();
    }
  },
  240_000,
);

cliTest.skipIf(BSDTAR === null)(
  "identifies ISO members through compiled CLI and stdio MCP with matching evidence",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-iso-acceptance-");
    await writeFile(join(root, "data.csv"), "a,b\n1,2\n");
    const path = join(root, "disc.iso");
    await promisify(execFile)(BSDTAR!, [
      "-cf",
      path,
      "--format",
      "iso9660",
      "-C",
      root,
      "data.csv",
    ]);
    const result = await cli.run({
      arguments: ["identify-artifact", path, "--json"],
    });
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    const contract = toolContract("identify_artifact");
    const evidence = contract.outputSchema.parse(result.json);
    const identified = artifactIdentificationSchema.parse(
      evidence.normalized_result,
    );
    expect(identified.answer.format).toBe("iso");
    expect(identified.pieces).toContainEqual(
      expect.objectContaining({ path: "data.csv", format: "csv" }),
    );
    const client = new Client({ name: "iso-acceptance", version: "1" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("scripts/rea.mjs"), "mcp"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "", REA_LOG_LEVEL: "silent" },
      stderr: "pipe",
    });
    try {
      await client.connect(transport);
      const response = await client.callTool({
        name: "identify_artifact",
        arguments: { path },
      });
      expect(response.isError).not.toBe(true);
      const mcp = contract.outputSchema.parse(response.structuredContent);
      expect(mcp.evidence_id).toBe(evidence.evidence_id);
      expect(mcp.normalized_result).toEqual(evidence.normalized_result);
    } finally {
      await client.close();
    }
  },
);
