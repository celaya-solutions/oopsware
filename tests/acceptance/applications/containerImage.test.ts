import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Ajv2020 } from "ajv/dist/2020.js";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { containerImageReportSchema } from "../../../src/domain/containerImage/containerImage.js";
import {
  archiveOf,
  buildImage,
  ociLayoutFiles,
  writeLayout,
} from "../../fixtures/containerImageProducers.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "reads an OCI layout and a multi-platform archive through the compiled CLI and real stdio MCP with identical evidence",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-image-acceptance-");
    const amd = buildImage({
      layers: [
        { entries: [{ name: "app", data: "amd" }] },
        {
          compression: "zstd",
          entries: [{ name: ".wh.app" }, { name: "new", data: "n" }],
        },
      ],
    });
    const arm = buildImage({
      layers: [{ entries: [{ name: "app", data: "arm" }] }],
      platform: { os: "linux", architecture: "arm64", variant: "v8" },
    });
    const layout = join(root, "layout");
    await writeLayout(layout, ociLayoutFiles([amd]));
    const archive = join(root, "multi.tar");
    await writeFile(archive, archiveOf(ociLayoutFiles([amd, arm])));

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("scripts/rea.mjs"), "mcp"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "", REA_LOG_LEVEL: "silent" },
      stderr: "pipe",
    });
    const client = new Client({ name: "image-acceptance", version: "1" });
    try {
      await client.connect(transport);
      const ajv = new Ajv2020({ strict: false, validateFormats: false });
      const contract = toolContract("inspect_container_image");
      const advertised = (await client.listTools()).tools.find(
        (tool) => tool.name === contract.name,
      );
      if (advertised?.outputSchema === undefined)
        throw new Error("inspect_container_image must publish both schemas");
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
        return containerImageReportSchema.parse(mcp.normalized_result);
      };

      const single = await both(["inspect-container-image", layout], {
        path: layout,
      });
      expect(single.files.map((file) => file.path)).toEqual(["new"]);
      expect(single.layers.map((layer) => layer.removed_from_lower)).toEqual([
        0, 1,
      ]);

      const ambiguous = await both(["inspect-container-image", archive], {
        path: archive,
      });
      expect(ambiguous.selection.state).toBe("ambiguous");

      const arm64 = await both(
        ["inspect-container-image", archive, "--platform", "linux/arm64"],
        { path: archive, platform: "linux/arm64" },
      );
      expect(arm64.selection).toMatchObject({
        state: "selected",
        by: "platform",
      });
      expect(arm64.files.map((file) => file.path)).toEqual(["app"]);

      const layerOne = await both(
        ["inspect-container-image", layout, "--layer", "1"],
        { path: layout, layer: 1 },
      );
      expect(layerOne.files.map((file) => file.type)).toEqual([
        "whiteout",
        "file",
      ]);
    } finally {
      await client.close();
    }
  },
  240_000,
);
