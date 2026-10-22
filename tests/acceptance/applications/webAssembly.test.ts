import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Ajv2020 } from "ajv/dist/2020.js";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import {
  wasmCConversionSchema,
  wasmFunctionReportSchema,
  wasmModuleReportSchema,
  wasmTextConversionSchema,
} from "../../../src/domain/wasm/webAssembly.js";
import { assembleWat } from "../../../src/wasm/wabt.js";
import { resolveWasm2c } from "../../../src/wasm/wasm2c.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest, type TestCli } from "../../support/cli/cliFixture.js";

/** Assembled at test time by wabt.js; no binary fixture is committed. */
const SOURCE = `(module $shapes
  (import "host" "report" (func $report (param i32)))
  (type $area (func (param i32) (result i32)))
  (memory (export "memory") 1)
  (data (i32.const 64) "shapes")
  (table 2 funcref)
  (elem (i32.const 0) $square $double)
  (func $square (type $area) local.get 0 local.get 0 i32.mul)
  (func $double (type $area) local.get 0 i32.const 2 i32.mul)
  (func $area_of (export "area_of") (param $kind i32) (param $size i32) (result i32)
    local.get $size
    local.get $kind
    call_indirect (type $area)
    call $square
    drop
    local.get $size
    call $report
    i32.const 0))`;

const sha256 = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

/** The derived WAT is written once, with its own digest; the original is untouched. */
const expectDerivedText = async (
  cli: TestCli,
  client: Client,
  root: string,
  wasm: string,
  module: Uint8Array,
) => {
  const output = join(root, "rendered.wat");
  const converted = await cli.run({
    arguments: ["convert-wasm-to-text", wasm, output, "--json"],
  });
  expect(converted.exitCode).toBe(0);
  const conversion = wasmTextConversionSchema.parse(
    toolContract("convert_wasm_to_text").outputSchema.parse(converted.json)
      .normalized_result,
  );
  const rendered = await readFile(output);
  expect(conversion.output).toMatchObject({
    sha256: sha256(rendered),
    derived_from: sha256(module),
    names: "name-section",
  });
  expect(rendered.toString("utf8")).toContain("call_indirect");
  expect(sha256(await readFile(wasm))).toBe(sha256(module));
  const again = await client.callTool({
    name: "convert_wasm_to_text",
    arguments: { path: wasm, output_path: output },
  });
  expect(again.isError).toBe(true);
  expect(JSON.stringify(again.structuredContent ?? again.content)).toMatch(
    /never overwritten/u,
  );
  expect(sha256(await readFile(output))).toBe(conversion.output.sha256);
};

/** wasm2c is bring-your-own; without an admitted build the call is skipped. */
const expectCTranslation = async (
  translate: () => Promise<{ confidence?: string; normalized_result: unknown }>,
  module: Uint8Array,
) => {
  if (
    !(await resolveWasm2c().then(
      () => true,
      () => false,
    ))
  )
    return;
  const translated = await translate();
  const c = wasmCConversionSchema.parse(translated.normalized_result);
  expect(translated.confidence).toBe("derived");
  expect(c.module_name).toBe("shapes");
  expect(c.c.derived_from).toEqual([sha256(module)]);
  expect(c.header.text).toContain("w2c_shapes_area_of(w2c_shapes*");
  expect(c.exports).toMatchObject({ module: 1, declared: 1 });
  expect(c.checks.find((check) => check.id === "exports_match")?.state).toBe(
    "passed",
  );
};

/** Unresolved format, relative path, unknown argument and a missing function are explicit errors. */
const expectExplicitErrors = async (
  client: Client,
  root: string,
  wasm: string,
) => {
  const unnamed = join(root, "notes.bin");
  await writeFile(unnamed, "x");
  for (const [name, arguments_] of [
    ["inspect_wasm_module", { path: unnamed }],
    ["inspect_wasm_module", { path: "relative.wasm" }],
    ["inspect_wasm_module", { path: wasm, extra: true }],
    ["inspect_wasm_function", { path: wasm, function_index: 9 }],
  ] as const) {
    const rejected = await client.callTool({ name, arguments: arguments_ });
    expect(rejected.isError, JSON.stringify(arguments_)).toBe(true);
  }
};

cliTest(
  "decodes WebAssembly through the compiled CLI and real stdio MCP with identical evidence",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-wasm-acceptance-");
    const wat = join(root, "shapes.wat");
    const wasm = join(root, "shapes.wasm");
    await writeFile(wat, SOURCE);
    const module = await assembleWat(
      "shapes.wat",
      new TextEncoder().encode(SOURCE),
    );
    await writeFile(wasm, module);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("scripts/rea.mjs"), "mcp"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "", REA_LOG_LEVEL: "silent" },
      stderr: "pipe",
    });
    const client = new Client({ name: "wasm-acceptance", version: "1" });
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    try {
      await client.connect(transport);
      const tools = (await client.listTools()).tools;
      /** CLI and MCP must return the same Evidence for the same request. */
      const both = async (
        name:
          | "inspect_wasm_module"
          | "inspect_wasm_function"
          | "convert_wasm_to_c",
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
        "inspect_wasm_module",
        ["inspect-wasm-module", wasm],
        { path: wasm },
      );
      expect(inventory.subject?.digest.sha256).toBe(sha256(module));
      const report = wasmModuleReportSchema.parse(inventory.normalized_result);
      expect(report.validation.state).toBe("valid");
      expect(report.summary).toMatchObject({
        functions: 4,
        imported_functions: 1,
        direct_call_edges: 2,
        indirect_call_sites: 1,
      });
      expect(report.exports.map((entry) => entry.name)).toEqual([
        "memory",
        "area_of",
      ]);

      const call = await both(
        "inspect_wasm_function",
        ["inspect-wasm-function", wasm, "3", "--limit", "4"],
        { path: wasm, function_index: 3, limit: 4 },
      );
      const fn = wasmFunctionReportSchema.parse(call.normalized_result);
      expect(fn.function.name).toBe("area_of");
      expect(fn.page).toEqual({ start: 0, limit: 4, returned: 4, next: 4 });
      expect(fn.indirect_calls[0]?.targets).toMatchObject({
        state: "static",
        candidates: [
          { index: 1, name: "square" },
          { index: 2, name: "double" },
        ],
      });
      expect(fn.calls.map((entry) => entry.target.name)).toEqual([
        "square",
        "report",
      ]);

      // A WAT input is assembled into a separate derived module.
      const text = await client.callTool({
        name: "inspect_wasm_module",
        arguments: { path: wat },
      });
      const fromText = wasmModuleReportSchema.parse(
        toolContract("inspect_wasm_module").outputSchema.parse(
          text.structuredContent,
        ).normalized_result,
      );
      expect(fromText.artifact.sha256).toBe(sha256(SOURCE));
      expect(fromText.source).toMatchObject({
        format: "text",
        basis: "name-hint",
        derived_binary: { sha256: sha256(module) },
      });

      // An explicit choice reads text under any name; the CLI spells it --read-as.
      const renamed = join(root, "shapes.txt");
      await writeFile(renamed, SOURCE);
      const requested = await cli.run({
        arguments: [
          "inspect-wasm-module",
          renamed,
          "--read-as",
          "text",
          "--json",
        ],
      });
      expect(requested.exitCode).toBe(0);
      expect(
        wasmModuleReportSchema.parse(
          toolContract("inspect_wasm_module").outputSchema.parse(requested.json)
            .normalized_result,
        ).source,
      ).toMatchObject({ format: "text", basis: "requested" });

      await expectCTranslation(
        () =>
          both("convert_wasm_to_c", ["convert-wasm-to-c", wasm], {
            path: wasm,
          }),
        module,
      );
      await expectDerivedText(cli, client, root, wasm, module);
      await expectExplicitErrors(client, root, wasm);
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
