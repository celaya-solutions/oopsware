import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Ajv2020 } from "ajv/dist/2020.js";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { linuxPackageReportSchema } from "../../../src/domain/linuxPackage/linuxPackage.js";
import {
  buildLinuxFixtures,
  LINUX_TOOLS,
  PACKAGE,
  SCRIPT_TEXT,
} from "../../fixtures/linuxProducers.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest, type TestCli } from "../../support/cli/cliFixture.js";

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

type LinuxTool = "inspect_linux_package";

type Listed = Awaited<ReturnType<Client["listTools"]>>["tools"];

/** CLI and MCP must return the same Evidence for the same request. */
const comparer =
  (client: Client, tools: Listed, cli: TestCli) =>
  async (
    name: LinuxTool,
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

cliTest.skipIf(LINUX_TOOLS === null)(
  "reads dpkg-deb, rpmbuild and AppImage-runtime-built packages through the compiled CLI and real stdio MCP with identical evidence",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-linux-acceptance-");
    const fixtures = await buildLinuxFixtures(root);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("scripts/rea.mjs"), "mcp"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "", REA_LOG_LEVEL: "silent" },
      stderr: "pipe",
    });
    const client = new Client({ name: "linux-acceptance", version: "1" });
    try {
      await client.connect(transport);
      const both = comparer(client, (await client.listTools()).tools, cli);

      const debEvidence = await both(
        "inspect_linux_package",
        ["inspect-linux-package", fixtures.deb.xz],
        { path: fixtures.deb.xz },
      );
      expect(debEvidence.subject?.digest.sha256).toBe(
        sha256(await readFile(fixtures.deb.xz)),
      );
      const deb = linuxPackageReportSchema.parse(debEvidence.normalized_result);
      expect(deb.package.kind).toBe("deb");
      expect(deb.identity).toMatchObject({
        name: PACKAGE,
        version: "1.2.3",
        release: "1",
      });
      expect(
        deb.scripts.find((script) => script.name === "postinst")?.text,
      ).toBe(SCRIPT_TEXT);
      expect(deb.deb?.md5sums?.mismatched).toEqual([]);

      const rpmEvidence = await both(
        "inspect_linux_package",
        ["inspect-linux-package", fixtures.rpm.zstd, "--limit", "3"],
        { path: fixtures.rpm.zstd, limit: 3 },
      );
      const rpm = linuxPackageReportSchema.parse(rpmEvidence.normalized_result);
      expect(rpm.package.kind).toBe("rpm");
      expect(rpm.page).toMatchObject({ start: 0, limit: 3, returned: 3 });
      expect(rpm.rpm?.payload.digest?.valid).toBe(true);
      expect(rpm.dependencies.some((entry) => entry.rich)).toBe(true);

      const appEvidence = await both(
        "inspect_linux_package",
        ["inspect-linux-package", fixtures.appimage.aarch64],
        { path: fixtures.appimage.aarch64 },
      );
      const app = linuxPackageReportSchema.parse(appEvidence.normalized_result);
      expect(app.package.kind).toBe("appimage");
      expect(app.appimage).toMatchObject({
        type: 2,
        runtime: { machine: "aarch64" },
      });
      expect(app.files.some((file) => file.path === "/AppRun")).toBe(true);
    } finally {
      await client.close();
    }
  },
  240_000,
);
