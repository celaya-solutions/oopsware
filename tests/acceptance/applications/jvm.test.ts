import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Ajv2020 } from "ajv/dist/2020.js";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import {
  jvmDecompilationSchema,
  jvmArtifactReportSchema,
  jvmClassReportSchema,
  jvmMethodReportSchema,
} from "../../../src/domain/jvm/jvm.js";
import { resolveVineflower } from "../../../src/jvm/vineflower.js";
import { buildJvmFixtures, JDK_HOME } from "../../fixtures/jvmProducers.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

type JvmTool =
  | "inspect_jvm_artifact"
  | "inspect_jvm_class"
  | "inspect_jvm_method"
  | "decompile_jvm_class";

/** Reconstruction needs the host's admitted Vineflower; the other tools do not. */
const VINEFLOWER = await resolveVineflower().then(
  () => true,
  () => false,
);

cliTest.skipIf(JDK_HOME === null)(
  "reads JDK-built classes, JARs and AARs through the compiled CLI and real stdio MCP with identical evidence",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-jvm-acceptance-");
    const fixtures = await buildJvmFixtures(root);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("scripts/rea.mjs"), "mcp"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "", REA_LOG_LEVEL: "silent" },
      stderr: "pipe",
    });
    const client = new Client({ name: "jvm-acceptance", version: "1" });
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    try {
      await client.connect(transport);
      const tools = (await client.listTools()).tools;
      /** CLI and MCP must return the same Evidence for the same request. */
      const both = async (
        name: JvmTool,
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
        "inspect_jvm_artifact",
        ["inspect-jvm-artifact", fixtures.app],
        { path: fixtures.app },
      );
      expect(inventory.subject?.digest.sha256).toBe(
        sha256(await readFile(fixtures.app)),
      );
      const jar = jvmArtifactReportSchema.parse(inventory.normalized_result);
      expect(jar.container.kind).toBe("jar");
      expect(jar.manifest?.main_class).toBe("demo.Task");
      expect(jar.modules[0]?.name).toBe("demo.shapes");
      expect(jar.signatures[0]?.signer).toBe("FIXTURE");

      const variant = await both(
        "inspect_jvm_class",
        [
          "inspect-jvm-class",
          fixtures.multiRelease,
          "--class",
          "mr.Version",
          "--release",
          "11",
        ],
        { path: fixtures.multiRelease, class: "mr.Version", release: 11 },
      );
      const chosen = jvmClassReportSchema.parse(variant.normalized_result);
      expect(chosen.selection).toMatchObject({
        basis: "release",
        release: 11,
        entry: "META-INF/versions/11/mr/Version.class",
      });
      expect(chosen.selection.variants).toHaveLength(3);

      const decoded = await both(
        "inspect_jvm_method",
        [
          "inspect-jvm-method",
          fixtures.aar,
          "run",
          "--class",
          "demo.Task",
          "--limit",
          "3",
        ],
        { path: fixtures.aar, class: "demo.Task", method: "run", limit: 3 },
      );
      const run = jvmMethodReportSchema.parse(decoded.normalized_result);
      expect(run.selection.container).toBe("classes.jar");
      expect(run.page).toMatchObject({ start: 0, limit: 3, returned: 3 });
      expect(
        run.references.invocations.map(
          (entry) => `${entry.target.owner ?? ""}.${entry.target.name ?? ""}`,
        ),
      ).toEqual(["demo/Shapes.dense", "java/io/PrintStream.println"]);
      expect(run.references.fields[0]?.target).toMatchObject({
        owner: "java/lang/System",
        name: "out",
      });

      if (VINEFLOWER) {
        const reconstructed = await both(
          "decompile_jvm_class",
          ["decompile-jvm-class", fixtures.app, "--class", "demo.Task"],
          { path: fixtures.app, class: "demo.Task" },
        );
        expect(reconstructed.confidence).toBe("inferred");
        const source = jvmDecompilationSchema.parse(
          reconstructed.normalized_result,
        );
        expect(source.source.text).toMatch(
          /public final class Task implements Runnable/u,
        );
        expect(source.decompiler.id).toBe("vineflower");
      }

      // A relative path, an unknown argument, an overload and an absent class are explicit errors.
      for (const [name, arguments_] of [
        ["inspect_jvm_artifact", { path: "relative.jar" }],
        ["inspect_jvm_artifact", { path: fixtures.app, extra: true }],
        [
          "inspect_jvm_method",
          {
            path: join(fixtures.classes, "demo", "Shapes.class"),
            method: "area",
          },
        ],
        ["inspect_jvm_class", { path: fixtures.app, class: "demo.Missing" }],
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
