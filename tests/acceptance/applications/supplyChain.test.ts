import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import { Ajv } from "ajv";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const createSupplyChainInputs = async () => {
  const root = await createTestTempDirectory(
    "oopsware-supply-chain-acceptance-",
  );
  const project = join(root, "project");
  await mkdir(project);
  await writeFile(
    join(project, "package-lock.json"),
    JSON.stringify({
      name: "local-application",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: {
        "": {
          name: "local-application",
          version: "1.0.0",
          dependencies: { "example-dep": "1.2.3" },
        },
        "node_modules/example-dep": {
          name: "example-dep",
          version: "1.2.3",
          license: "MIT",
        },
      },
    }),
  );
  const database = join(root, "osv.json");
  await writeFile(
    database,
    JSON.stringify({
      schema: "oopsware-osv-snapshot-v1",
      generated_at: "2026-10-01T00:00:00Z",
      records: [
        {
          schema_version: "1.7.0",
          id: "LOCAL-TEST-001",
          modified: "2026-10-01T00:00:00Z",
          summary: "An inert test advisory",
          affected: [
            {
              package: { ecosystem: "npm", name: "example-dep" },
              ranges: [
                {
                  type: "SEMVER",
                  events: [{ introduced: "1.0.0" }, { fixed: "1.2.4" }],
                },
              ],
            },
          ],
        },
      ],
    }),
  );
  const wheel = join(root, "sample-1.0-py3-none-any.whl");
  const metadataPath = "sample-1.0.dist-info/METADATA";
  const metadata =
    "Metadata-Version: 2.4\nName: sample\nVersion: 1.0\nLicense-Expression: MIT\n";
  const record = `${metadataPath},sha256=${createHash("sha256").update(metadata).digest("base64url")},${Buffer.byteLength(metadata)}\nsample-1.0.dist-info/RECORD,,\n`;
  const writer = new ZipWriter(new Uint8ArrayWriter(), {
    useWebWorkers: false,
  });
  await writer.add(metadataPath, new TextReader(metadata));
  await writer.add("sample-1.0.dist-info/RECORD", new TextReader(record));
  await writeFile(wheel, await writer.close());
  const wheelDigest = createHash("sha256")
    .update(await readFile(wheel))
    .digest("hex");
  return { root, project, database, wheel, wheelDigest };
};

cliTest(
  "carries an SBOM through offline OSV checks and verifies an unsigned wheel through CLI and real MCP",
  async ({ cli }) => {
    const { root, project, database, wheel, wheelDigest } =
      await createSupplyChainInputs();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("scripts/rea.mjs"), "mcp"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "", REA_LOG_LEVEL: "silent" },
      stderr: "pipe",
    });
    const client = new Client({
      name: "supply-chain-acceptance",
      version: "1",
    });
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    const cyclone = new Ajv({ strict: false, validateFormats: false });
    for (const name of [
      "spdx.schema.json",
      "jsf-0.82.schema.json",
      "bom-1.6.schema.json",
    ])
      cyclone.addSchema(
        JSON.parse(
          await readFile(resolve("tests/fixtures/cyclonedx", name), "utf8"),
        ),
      );
    try {
      await client.connect(transport);
      const advertised = (await client.listTools()).tools;
      const sbomPath = join(root, "sbom-evidence.json");
      const cases = [
        {
          name: "generate_sbom",
          arguments: { path: project },
          cli: ["generate-sbom", project],
        },
        {
          name: "check_vulnerabilities",
          arguments: { path: sbomPath, database },
          cli: ["check-vulnerabilities", sbomPath, "--database", database],
        },
        {
          name: "verify_artifact_signature",
          arguments: { path: wheel, kind: "wheel" },
          cli: ["verify-artifact-signature", wheel, "--kind", "wheel"],
        },
      ] as const;
      for (const item of cases) {
        const contract = toolContract(item.name);
        const schema = advertised.find((tool) => tool.name === item.name);
        if (schema?.outputSchema === undefined)
          throw new Error(`${item.name} must advertise its output`);
        const inputSchema: Record<string, unknown> = schema.inputSchema;
        const outputSchema: Record<string, unknown> = schema.outputSchema;
        expect(ajv.validateSchema(inputSchema)).toBe(true);
        expect(ajv.validateSchema(outputSchema)).toBe(true);
        const output = await cli.run({ arguments: [...item.cli, "--json"] });
        expect(output.exitCode, JSON.stringify(output.json)).toBe(0);
        const evidence = contract.outputSchema.parse(output.json);
        const response = await client.callTool({
          name: item.name,
          arguments: item.arguments,
        });
        expect(response.isError, JSON.stringify(response)).not.toBe(true);
        expect(
          ajv.validate(outputSchema, response.structuredContent),
          JSON.stringify(ajv.errors),
        ).toBe(true);
        const mcp = contract.outputSchema.parse(response.structuredContent);
        expect(mcp.evidence_id).toBe(evidence.evidence_id);
        expect(mcp.normalized_result).toEqual(evidence.normalized_result);
        if (item.name === "generate_sbom") {
          const report =
            toolContract("generate_sbom").outputSchema.parse(
              evidence,
            ).normalized_result;
          expect(
            cyclone.validate(
              "http://cyclonedx.org/schema/bom-1.6.schema.json",
              report.sbom,
            ),
            JSON.stringify(cyclone.errors),
          ).toBe(true);
          expect(JSON.stringify(evidence.normalized_result)).toContain(
            "example-dep",
          );
          expect(JSON.stringify(evidence.normalized_result)).toContain("MIT");
          await writeFile(sbomPath, JSON.stringify(evidence));
        } else if (item.name === "check_vulnerabilities") {
          expect(evidence.normalized_result).toMatchObject({
            findings: [expect.objectContaining({ id: "LOCAL-TEST-001" })],
          });
        } else {
          expect(evidence.normalized_result).toMatchObject({
            artifact: { sha256: wheelDigest },
            integrity: { status: "unsigned" },
            revocation: { status: "not_checked" },
            notarization: { status: "not_checked" },
          });
        }
        for (const invalid of [
          { ...item.arguments, path: "relative" },
          { ...item.arguments, unexpected: true },
        ]) {
          expect(
            (await client.callTool({ name: item.name, arguments: invalid }))
              .isError,
          ).toBe(true);
        }
      }
      expect(
        (
          await client.callTool({
            name: "check_vulnerabilities",
            arguments: { path: sbomPath, database: "relative" },
          })
        ).isError,
      ).toBe(true);
    } finally {
      await client.close();
    }
  },
  120_000,
);
