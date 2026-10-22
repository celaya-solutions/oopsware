import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Ajv2020 } from "ajv/dist/2020.js";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import {
  structuredTextDocumentSchema,
  type StructuredTextDocument,
} from "../../../src/domain/document/structuredText.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const FILES: Readonly<Record<string, string>> = {
  "config.json": '{\n  "id": 12345678901234567890,\n  "id": 2\n}\n',
  "events.jsonl": '{"n":1}\n{"n":\n{"n":3}\n',
  "xxe.xml":
    '<?xml version="1.0"?>\n<!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]>\n<r>&x;</r>\n',
  "laughs.yaml": "a: &a [x, x]\nb: &b [*a, *a]\nc: [*b, *b]\n",
  "table.csv": 'name,note\n"a,b","two\nlines"\n"=1+1",x,extra\n',
  "README.md": "# Title\n\n[bad](javascript:alert(1)) <script>x</script>\n",
};

/** Format-specific findings that both adapters must report identically. */
const expectHostileReadings = (
  readings: ReadonlyMap<string, StructuredTextDocument>,
): void => {
  const json = readings.get("config.json");
  expect(
    json?.nodes.filter(({ path }) => path === "/id").map(({ value }) => value),
  ).toEqual(["12345678901234567890", "2"]);
  expect(json?.diagnostics[0]).toMatchObject({
    code: "json_duplicate_key",
    location: { line: 3, column: 3, offset: 34 },
  });
  const jsonl = readings.get("events.jsonl");
  expect(jsonl?.parse).toMatchObject({ status: "partial", records: 3 });
  expect(
    jsonl?.diagnostics.find(({ severity }) => severity === "error"),
  ).toMatchObject({
    record: 2,
    location: { line: 2 },
  });
  const xml = readings.get("xxe.xml");
  expect(xml?.diagnostics.map(({ code }) => code)).toContain(
    "xml_dtd_internal_subset_refused",
  );
  expect(JSON.stringify(xml?.nodes)).not.toContain("root:");
  expect(
    readings.get("laughs.yaml")?.nodes.filter(({ kind }) => kind === "alias"),
  ).toHaveLength(4);
  expect(readings.get("table.csv")?.nodes[1]?.fields).toEqual([
    "a,b",
    "two\nlines",
  ]);
  expect(
    readings.get("README.md")?.nodes.find(({ kind }) => kind === "link")
      ?.details,
  ).toMatchObject({ rendered_as_link: false });
};

cliTest(
  "reads structured text through the compiled CLI and real stdio MCP with identical evidence",
  async ({ cli }) => {
    const root = await createTestTempDirectory(
      "rea-structured-text-acceptance-",
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("scripts/rea.mjs"), "mcp"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "", REA_LOG_LEVEL: "silent" },
      stderr: "pipe",
    });
    const client = new Client({
      name: "structured-text-acceptance",
      version: "1",
    });
    const contract = toolContract("inspect_document");
    try {
      await client.connect(transport);
      const advertised = (await client.listTools()).tools.find(
        ({ name }) => name === contract.name,
      );
      if (advertised?.outputSchema === undefined)
        throw new Error("inspect_document must publish both schemas");
      const ajv = new Ajv2020({ strict: false, validateFormats: false });
      const inputSchema: Record<string, unknown> = advertised.inputSchema;
      const outputSchema: Record<string, unknown> = advertised.outputSchema;
      expect(ajv.validateSchema(inputSchema)).toBe(true);
      expect(ajv.validateSchema(outputSchema)).toBe(true);
      expect(
        ajv.validate(inputSchema, { path: "/x.csv", delimiter: ";" }),
      ).toBe(true);
      expect(ajv.validate(inputSchema, { path: "/x.csv", extra: 1 })).toBe(
        false,
      );
      const readings = new Map<
        string,
        ReturnType<typeof structuredTextDocumentSchema.parse>
      >();
      for (const [name, content] of Object.entries(FILES)) {
        const path = join(root, name);
        await writeFile(path, content);
        const result = await cli.run({
          arguments: ["inspect-document", path, "--json"],
        });
        expect(result.exitCode, name).toBe(0);
        const evidence = contract.outputSchema.parse(result.json);
        expect(evidence.subject?.digest.sha256).toBe(
          createHash("sha256").update(content).digest("hex"),
        );
        const response = await client.callTool({
          name: contract.name,
          arguments: { path },
        });
        expect(response.isError, name).not.toBe(true);
        expect(
          ajv.validate(outputSchema, response.structuredContent),
          JSON.stringify(ajv.errors),
        ).toBe(true);
        const mcp = contract.outputSchema.parse(response.structuredContent);
        expect(mcp.evidence_id).toBe(evidence.evidence_id);
        expect(mcp.normalized_result).toEqual(evidence.normalized_result);
        readings.set(
          name,
          structuredTextDocumentSchema.parse(mcp.normalized_result),
        );
        // Reading never rewrites the original.
        expect(await readFile(path, "utf8")).toBe(content);
      }
      expectHostileReadings(readings);

      // Paging, explicit format and delimiter through the CLI.
      const semi = join(root, "export.txt");
      await writeFile(semi, "a;b\n1;2\n3;4\n");
      const paged = await cli.run({
        arguments: [
          "inspect-document",
          semi,
          "--parse-as",
          "csv",
          "--delimiter",
          ";",
          "--start",
          "1",
          "--limit",
          "1",
          "--json",
        ],
      });
      expect(paged.exitCode).toBe(0);
      const page = structuredTextDocumentSchema.parse(
        contract.outputSchema.parse(paged.json).normalized_result,
      );
      expect(page.nodes.map(({ fields }) => fields)).toEqual([["1", "2"]]);
      expect(page.page).toEqual({ start: 1, limit: 1, returned: 1, next: 2 });

      // Unresolved profile, relative path and unknown arguments are explicit errors.
      const unnamed = join(root, "notes.bin");
      await writeFile(unnamed, "x");
      for (const arguments_ of [
        { path: unnamed },
        { path: "relative.json" },
        { path: unnamed, format: "json", extra: true },
        { path: unnamed, format: "json", delimiter: ";" },
      ]) {
        const rejected = await client.callTool({
          name: contract.name,
          arguments: arguments_,
        });
        expect(rejected.isError, JSON.stringify(arguments_)).toBe(true);
        expect(
          contract.outputSchema.safeParse(rejected.structuredContent).success,
        ).toBe(false);
      }
      await client.ping();
    } finally {
      try {
        await client.close();
      } finally {
        await transport.close();
      }
    }
  },
  30_000,
);
