import type { AnalysisError } from "../../../src/domain/analysisErrorBase.js";
import type { ExecutionOptions } from "../../../src/application/AnalysisProvider.js";
import { NativeModuleResolver } from "../../../src/browser/modules/NativeModuleResolver.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it, onTestFinished } from "vitest";
import { WebModuleTraceService } from "../../../src/application/WebModuleTraceService.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { ok } from "../../../src/domain/result.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import {
  webModuleArtifactsFixture,
  completedModuleResolverLauncher,
  webModuleResolverFixture,
} from "../../fixtures/webModuleTrace.js";

it("publishes valid SDK schemas and records the named module trace without a binary target", async () => {
  const artifacts = webModuleArtifactsFixture();
  const service = new WebModuleTraceService(
    { load: () => Promise.resolve(ok(artifacts)) },
    webModuleResolverFixture,
  );
  const session = createTestBinarySession(() => {
    throw new Error("binary provider must not start");
  });
  const server = createServer(
    { kind: "session", session },
    { webModuleTrace: service },
  );
  const client = new Client({ name: "module-contract", version: "1" });
  onTestFinished(async () => {
    await client.close();
    await server.close();
    await session.close();
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const advertised = (await client.listTools()).tools.find(
    (tool) => tool.name === "trace_web_module_imports",
  );
  if (advertised?.outputSchema === undefined)
    throw new Error("module trace must advertise both schemas");
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  const inputSchema: Record<string, unknown> = advertised.inputSchema;
  const outputSchema: Record<string, unknown> = advertised.outputSchema;
  const args = { manifest_path: "/analysis/manifest.json", script_index: 0 };
  expect(ajv.validate(inputSchema, args)).toBe(true);
  const response = await client.callTool({
    name: "trace_web_module_imports",
    arguments: args,
  });
  expect(response.isError).not.toBe(true);
  expect(
    ajv.validate(outputSchema, response.structuredContent),
    JSON.stringify(ajv.errors),
  ).toBe(true);
  const parsed = toolContract("trace_web_module_imports").outputSchema.parse(
    response.structuredContent,
  );
  const evidence = parseEvidence(parsed);
  expect(evidence.normalized_result).toMatchObject({
    importer: {
      url: artifacts.manifest.scripts[0]?.url,
      basis: "reported-source-url",
    },
    imports: [
      {
        resolution: { state: "resolved", url: "https://app.test/dep.js" },
        execution: "unknown",
      },
      {
        resolution: { state: "unknown", reason: "computed-specifier" },
        execution: "unknown",
      },
    ],
  });
  expect(session.evidenceById(evidence.evidence_id)).toEqual(evidence);
  const invalid = await client.callTool({
    name: "trace_web_module_imports",
    arguments: { ...args, manifest_path: "relative.json" },
  });
  expect(invalid.isError).toBe(true);
});

it("retains the module resolver cleanup owner across failed server shutdown", async () => {
  let closes = 0;
  const service = new WebModuleTraceService(
    { load: () => Promise.resolve(ok(webModuleArtifactsFixture())) },
    {
      ...webModuleResolverFixture,
      close: async () => {
        closes += 1;
        if (closes === 1) throw new Error("fixture browser close failed");
      },
    },
  );
  const session = createTestBinarySession(() => {
    throw new Error("binary provider must not start");
  });
  const server = createServer(
    { kind: "session", session },
    { webModuleTrace: service },
  );
  onTestFinished(async () => {
    await server.close();
    await session.close();
  });
  await expect(server.close()).rejects.toBeInstanceOf(AggregateError);
  await server.close();
  await server.close();
  expect(closes).toBe(2);
});

it.each([false, true])(
  "retains completed module Evidence over SDK MCP through final close cancellation (close fails: %s)",
  async (cleanupFails) => {
    const artifacts = webModuleArtifactsFixture();
    const importerUrl = artifacts.manifest.scripts[0]?.url;
    if (importerUrl === undefined)
      throw new Error("fixture source URL missing");
    const controller = new AbortController();
    const reason = { request: "controlled finalization cancellation" };
    let allowClose = !cleanupFails;
    let launches = 0;
    const launcher = completedModuleResolverLauncher(
      { importerUrl, importMap: null, specifiers: ["./dep.js"] },
      async () => {
        controller.abort(reason);
        if (!allowClose) throw new Error("controlled close refusal");
      },
    );
    const resolver = new NativeModuleResolver(
      { REA_BROWSER_EXECUTABLE: "/browser" },
      (options) => {
        launches += 1;
        return launcher(options);
      },
    );
    let original: AnalysisError | undefined;
    class ControlledCancellationService extends WebModuleTraceService {
      override async trace(input: unknown, options?: ExecutionOptions) {
        const result = await super.trace(input, {
          ...options,
          signal: controller.signal,
        });
        if (!result.ok) original = result.error;
        return result;
      }
    }
    const service = new ControlledCancellationService(
      { load: async () => ok(artifacts) },
      resolver,
    );
    const session = createTestBinarySession(() => {
      throw new Error("no binary acquisition");
    });
    const server = createServer(
      { kind: "session", session },
      { webModuleTrace: service },
    );
    const client = new Client({ name: "module-finalization", version: "1" });
    onTestFinished(async () => {
      allowClose = true;
      await client.close();
      await server.close();
      await session.close();
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const response = await client.callTool({
      name: "trace_web_module_imports",
      arguments: {
        manifest_path: "/analysis/manifest.json",
        script_index: 0,
      },
    });
    expect(response.isError).toBe(true);
    if (original === undefined) throw new Error("expected original failure");
    const evidence = parseEvidence(original.partialObservation);
    expect(parseMcpToolError(response)).toMatchObject({
      error: {
        code: cleanupFails ? "cleanup_incomplete" : "cancelled",
        details: {
          partial_observation: {
            kind: "retained-evidence",
            evidence_id: evidence.evidence_id,
          },
        },
      },
    });
    expect(evidence).toMatchObject({
      operation: "trace_web_module_imports",
      confidence: "derived",
      normalized_result: {
        source: artifacts.sourceFile,
        imports: [
          {
            resolution: { state: "resolved", url: "https://app.test/dep.js" },
            execution: "unknown",
          },
          {
            resolution: { state: "unknown", reason: "computed-specifier" },
            execution: "unknown",
          },
        ],
      },
    });
    expect(session.evidenceById(evidence.evidence_id)).toEqual(evidence);
    expect((original.cleanupPrimary ?? original).cause).toBe(reason);
    if (cleanupFails) {
      await expect(server.close()).rejects.toBeInstanceOf(AggregateError);
      expect(original.cleanupIncomplete).toBe(true);
      allowClose = true;
    }
    await server.close();
    expect(original.cleanupIncomplete).toBe(false);
    expect(original.cleanupResources).toEqual([]);
    expect(projectAnalysisError(original).code).toBe("cancelled");
    expect(launches).toBe(1);
  },
);
