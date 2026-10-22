import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Ajv2020 } from "ajv/dist/2020.js";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import {
  pythonArtifactReportSchema,
  pythonCodeReportSchema,
  pythonDecompilationSchema,
  pythonModuleReportSchema,
} from "../../../src/domain/python/python.js";
import { resolvePycdc } from "../../../src/python/pycdc.js";
import {
  admittedProducers,
  buildWheel,
  compileSample,
  minorOf,
  buildZipapp,
  wheelProducer,
} from "../../fixtures/pythonProducers.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

type PythonTool =
  | "inspect_python_artifact"
  | "inspect_python_module"
  | "inspect_python_code"
  | "decompile_python_code";

const builder = await wheelProducer();
const producers = await admittedProducers();
const producer = producers[0];
/** Reconstruction needs the host's admitted pycdc and a release it reads cleanly. */
const decompiler = (await resolvePycdc().then(
  () => true,
  () => false,
))
  ? producers.find((interpreter) => minorOf(interpreter) <= 12)
  : undefined;

type Both = (
  name: PythonTool,
  cliArguments: string[],
  mcpArguments: Record<string, unknown>,
) => Promise<{ confidence?: string; normalized_result: unknown }>;

/** pycdc reconstruction of a freshly compiled module, and refusal of source. */
const checkDecompile = async (
  both: Both,
  client: Client,
  interpreter: NonNullable<typeof decompiler>,
  root: string,
  wheel: string,
) => {
  const pyc = await compileSample(
    interpreter,
    join(root, "decompile"),
    "decompile_tiny.py",
  );
  const reconstructed = await both(
    "decompile_python_code",
    ["decompile-python-code", pyc],
    { path: pyc },
  );
  expect(reconstructed.confidence).toBe("inferred");
  const decompiled = pythonDecompilationSchema.parse(
    reconstructed.normalized_result,
  );
  expect(decompiled.bytecode.release).toBe(interpreter.version);
  expect(decompiled.checks.every((check) => check.state === "passed")).toBe(
    true,
  );
  const refused = await client.callTool({
    name: "decompile_python_code",
    arguments: { path: wheel, entry: "oopsdemo/cli.py" },
  });
  expect(refused.isError).toBe(true);
};

cliTest.skipIf(builder === null || producer === undefined)(
  "reads pip-built wheels and zipapp-built applications through the compiled CLI and real stdio MCP with identical evidence",
  async ({ cli }) => {
    if (builder === null || producer === undefined) return;
    const root = await createTestTempDirectory("rea-python-acceptance-");
    const wheel = await buildWheel(builder, root, "project");
    const app = await buildZipapp(producer, join(root, "zipapp"));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("scripts/rea.mjs"), "mcp"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "", REA_LOG_LEVEL: "silent" },
      stderr: "pipe",
    });
    const client = new Client({ name: "python-acceptance", version: "1" });
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    try {
      await client.connect(transport);
      const tools = (await client.listTools()).tools;
      /** CLI and MCP must return the same Evidence for the same request. */
      const both = async (
        name: PythonTool,
        cliArguments: string[],
        mcpArguments: Record<string, unknown>,
      ) => {
        const contract = toolContract(name);
        const advertised = tools.find((tool) => tool.name === name);
        if (advertised?.outputSchema === undefined)
          throw new Error(`${name} must publish both schemas`);
        const inputSchema: Record<string, unknown> = advertised.inputSchema;
        const outputSchema: Record<string, unknown> = advertised.outputSchema;
        expect(ajv.validateSchema(inputSchema)).toBe(true);
        expect(ajv.validateSchema(outputSchema)).toBe(true);
        const result = await cli.run({
          arguments: [...cliArguments, "--json"],
        });
        expect(result.exitCode, cliArguments.join(" ")).toBe(0);
        const evidence = contract.outputSchema.parse(result.json);
        const response = await client.callTool({
          name,
          arguments: mcpArguments,
        });
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

      const inventory = await both(
        "inspect_python_artifact",
        ["inspect-python-artifact", wheel],
        { path: wheel },
      );
      expect(inventory.subject?.digest.sha256).toBe(
        sha256(await readFile(wheel)),
      );
      const report = pythonArtifactReportSchema.parse(
        inventory.normalized_result,
      );
      expect(report.container.kind).toBe("wheel");
      expect(report.wheel?.metadata?.name).toBe("oopsdemo");
      expect(report.wheel?.record?.mismatched).toEqual([]);

      const parsed = await both(
        "inspect_python_module",
        [
          "inspect-python-module",
          wheel,
          "--entry",
          "oopsdemo/cli.py",
          "--python",
          producer.version,
        ],
        { path: wheel, entry: "oopsdemo/cli.py", python: producer.version },
      );
      const source = pythonModuleReportSchema.parse(parsed.normalized_result);
      expect(source.source?.parser.release).toBe(producer.release);
      expect(source.source?.imports.items.map((item) => item.module)).toEqual([
        "importlib",
        "sys",
      ]);

      const listing = pythonArtifactReportSchema.parse(
        (
          await both(
            "inspect_python_artifact",
            ["inspect-python-artifact", app],
            {
              path: app,
            },
          )
        ).normalized_result,
      );
      const entry =
        listing.modules.find((item) => item.kind === "bytecode")?.entry ?? "";
      const decoded = await both(
        "inspect_python_code",
        [
          "inspect-python-code",
          app,
          "--entry",
          entry,
          "--code",
          "Child.fetch",
          "--limit",
          "5",
        ],
        { path: app, entry, code: "Child.fetch", limit: 5 },
      );
      const fetch = pythonCodeReportSchema.parse(decoded.normalized_result);
      expect(fetch.page).toMatchObject({ start: 0, limit: 5, returned: 5 });
      expect(fetch.profile.release).toBe(producer.release);
      expect(fetch.code.qualname).toBe("Child.fetch");

      if (decompiler !== undefined)
        await checkDecompile(both, client, decompiler, root, wheel);

      // A relative path, an unknown argument, a missing member and an absent code object are explicit errors.
      for (const [name, arguments_] of [
        ["inspect_python_artifact", { path: "relative.whl" }],
        ["inspect_python_artifact", { path: wheel, extra: true }],
        [
          "inspect_python_module",
          { path: wheel, entry: "oopsdemo/missing.py" },
        ],
        ["inspect_python_code", { path: app, entry, code: "Missing.method" }],
      ] as const) {
        const rejected = await client.callTool({ name, arguments: arguments_ });
        expect(rejected.isError, JSON.stringify(arguments_)).toBe(true);
      }
    } finally {
      await client.close();
    }
  },
  240_000,
);
