import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Ajv2020 } from "ajv/dist/2020.js";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { msixPackageReportSchema } from "../../../src/domain/windowsInstaller/msixPackage.js";
import { windowsInstallerReportSchema } from "../../../src/domain/windowsInstaller/windowsInstaller.js";
import {
  buildWindowsFixtures,
  PRODUCT_NAME,
  WINDOWS_TOOLS,
} from "../../fixtures/windowsProducers.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest, type TestCli } from "../../support/cli/cliFixture.js";

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

type WindowsTool = "inspect_windows_installer" | "inspect_msix_package";

type Listed = Awaited<ReturnType<Client["listTools"]>>["tools"];

/** CLI and MCP must return the same Evidence for the same request. */
const comparer =
  (client: Client, tools: Listed, cli: TestCli) =>
  async (
    name: WindowsTool,
    cliArguments: string[],
    mcpArguments: Record<string, unknown>,
  ) => {
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    const contract = toolContract(name);
    const advertised = tools.find((tool) => tool.name === name);
    if (advertised?.outputSchema === undefined)
      throw new Error(`${name} must publish both schemas`);
    const inputSchema: Record<string, unknown> = advertised.inputSchema;
    const outputSchema: Record<string, unknown> = advertised.outputSchema;
    expect(ajv.validateSchema(inputSchema)).toBe(true);
    expect(ajv.validateSchema(outputSchema)).toBe(true);
    const result = await cli.run({ arguments: [...cliArguments, "--json"] });
    expect(result.exitCode, cliArguments.join(" ")).toBe(0);
    const evidence = contract.outputSchema.parse(result.json);
    const response = await client.callTool({ name, arguments: mcpArguments });
    expect(response.isError, name).not.toBe(true);
    expect(
      ajv.validate(outputSchema, response.structuredContent),
      JSON.stringify(ajv.errors),
    ).toBe(true);
    const mcp = contract.outputSchema.parse(response.structuredContent);
    expect(mcp.evidence_id).toBe(evidence.evidence_id);
    expect(mcp.normalized_result).toEqual(evidence.normalized_result);
    return mcp;
  };

cliTest.skipIf(WINDOWS_TOOLS === null)(
  "reads wixl-built MSIs, a gcab companion cabinet and hand-assembled MSIX packages through the compiled CLI and real stdio MCP with identical evidence",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-windows-acceptance-");
    const fixtures = await buildWindowsFixtures(root);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("scripts/rea.mjs"), "mcp"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "", REA_LOG_LEVEL: "silent" },
      stderr: "pipe",
    });
    const client = new Client({ name: "windows-acceptance", version: "1" });
    try {
      await client.connect(transport);
      const both = comparer(client, (await client.listTools()).tools, cli);

      const msiEvidence = await both(
        "inspect_windows_installer",
        ["inspect-windows-installer", fixtures.msi],
        { path: fixtures.msi },
      );
      expect(msiEvidence.subject?.digest.sha256).toBe(
        sha256(await readFile(fixtures.msi)),
      );
      const msi = windowsInstallerReportSchema.parse(
        msiEvidence.normalized_result,
      );
      expect(msi.product.name).toBe(PRODUCT_NAME);
      expect(msi.files.every((file) => file.md5?.valid === true)).toBe(true);
      expect(msi.custom_actions.map((action) => action.id)).toContain(
        "RunTool",
      );

      const externalEvidence = await both(
        "inspect_windows_installer",
        [
          "inspect-windows-installer",
          fixtures.msiExternal,
          "--cabinets",
          fixtures.cabinet,
          "--limit",
          "1",
        ],
        { path: fixtures.msiExternal, cabinets: [fixtures.cabinet], limit: 1 },
      );
      const external = windowsInstallerReportSchema.parse(
        externalEvidence.normalized_result,
      );
      expect(external.page).toMatchObject({ returned: 1, next: 1 });
      expect(external.cabinets[0]).toMatchObject({
        source: "companion",
        sha256: sha256(await readFile(fixtures.cabinet)),
      });

      const bundleEvidence = await both(
        "inspect_msix_package",
        [
          "inspect-msix-package",
          fixtures.msixbundle,
          "--container",
          "Oops.Demo_1.2.3.0_arm64.msix",
        ],
        {
          path: fixtures.msixbundle,
          container: "Oops.Demo_1.2.3.0_arm64.msix",
        },
      );
      const bundle = msixPackageReportSchema.parse(
        bundleEvidence.normalized_result,
      );
      expect(bundle.package.kind).toBe("msixbundle");
      expect(bundle.bundle?.architectures).toEqual(["arm64", "x64"]);
      expect(bundle.parts?.manifest?.identity?.processor_architecture).toBe(
        "arm64",
      );
      expect(bundle.parts?.block_map?.verified).toBe(true);
    } finally {
      await client.close();
    }
  },
  240_000,
);
