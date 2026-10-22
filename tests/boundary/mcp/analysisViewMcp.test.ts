import { advertisedMcpToolSchemas } from "../../fixtures/advertisedMcpTool.js";
import { API_SURFACE_EXAMPLE } from "../../../src/contracts/analysisViewApiSurfaceExample.js";
import { ENVIRONMENT_MANIFEST_EXAMPLE } from "../../../src/contracts/analysisViewEnvironmentManifestExample.js";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { WebNetworkCaptureService } from "../../../src/application/WebNetworkCaptureService.js";
import { decodeHarCapture } from "../../../src/browser/history/HarCapture.js";
import { join } from "node:path";
import {
  apiSurfaceHar,
  environmentManifestHar,
} from "../../fixtures/historicalHar.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/server";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";

import { BinaryLayoutService } from "../../../src/application/binaryDiagnostics/BinaryLayoutService.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { createEvidence, parseEvidence } from "../../../src/domain/evidence.js";
import { createAnalysisProfile } from "../../../src/domain/analysisProfile.js";
import { jsonObjectSchema } from "../../../src/domain/jsonValue.js";
import { functionDossierSchema } from "../../../src/domain/hopperValues.js";
import { ghidraFunctionDossier } from "../../../src/domain/ghidraValues.fixture.js";
import { ok } from "../../../src/domain/result.js";
import {
  createJavaScriptApplicationGraph,
  createJavaScriptApplicationNode,
} from "../../../src/domain/javascript/javascriptApplicationGraph.js";
import { createServer } from "../../../src/server/createServer.js";
import { connectGhidraMcp } from "./ghidraMcpHarness.js";
import {
  analysisViewJavaScriptEvidence,
  analysisViewJavaScriptAnalysisWithSource,
  analysisViewBindJavaScriptGraphs,
  analysisViewLayoutEvidence,
  analysisViewLayoutFixture,
  analysisViewCaptureFixture,
  analysisViewCaptureEvidence,
  analysisViewObjectDenseCapture,
  analysisViewNativeEvidence,
  environmentManifestCaptureFixture,
  environmentStateCaptureFixture,
} from "../../fixtures/analysisView.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { BINARY_LAYOUT_TEST_PROVIDER } from "../../fixtures/binaryDiagnostics/layout.js";
import { wasmArtifactFixture } from "../../fixtures/wasm/artifact.js";
import { evmInterfaceFixture } from "../../fixtures/evm/interface.js";
import type { RelationshipCoverage } from "../../../src/domain/relationshipCoverage.js";

const connect = async (
  binaryLayout?: BinaryLayoutService,
  webNetworkCapture?: WebNetworkCaptureService,
) => {
  const session = createTestBinarySession(() => {
    throw new Error("selected views must not start a deep provider");
  });
  const server = createServer(
    { kind: "session", session },
    {
      ...(binaryLayout === undefined ? {} : { binaryLayout }),
      ...(webNetworkCapture === undefined ? {} : { webNetworkCapture }),
    },
  );
  const client = new Client({ name: "analysis-view-mcp", version: "1" });
  onTestFinished(async () => {
    await client.close();
    await server.close();
    await session.close();
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, session };
};

it("preserves native relationship coverage through inline and retained MCP views", async () => {
  const { client, session } = await connect();
  const { ajv, outputSchema } = await advertisedMcpToolSchemas(
    client,
    "inspect_analysis_view",
  );
  const coverages: (RelationshipCoverage | undefined)[] = [
    {
      status: "partial",
      limited_directions: ["callees"],
      limitations: ["Callees: fixture read limit"],
      diagnostics: ["Fixture relationship diagnostic"],
    },
    { status: "partial", limitations: ["Historical read limit"] },
    {
      status: "unknown",
      limited_directions: ["callees"],
      reason: "Callees not measured",
      diagnostics: ["Unknown coverage diagnostic"],
    },
    {
      status: "complete",
      diagnostics: ["Only direct references are observed"],
    },
    { status: "complete" },
    undefined,
  ];
  for (const coverage of coverages) {
    const parent = analysisViewNativeEvidence(coverage);
    const parentBefore = JSON.stringify(parent);
    const recorded = session.recordEvidence(parent);
    if (!recorded.ok) throw recorded.error;
    const outputs = [];
    for (const source of [
      { kind: "inline", evidence: parent },
      { kind: "retained-evidence", evidence_id: parent.evidence_id },
    ]) {
      const response = await client.callTool({
        name: "inspect_analysis_view",
        arguments: {
          source,
          view: { kind: "native", facet: "callees", offset: 0, limit: 1 },
        },
      });
      expect(response.isError).not.toBe(true);
      expect(
        ajv.validate(outputSchema, response.structuredContent),
        JSON.stringify(ajv.errors),
      ).toBe(true);
      const evidence = parseEvidence(response.structuredContent);
      expect(evidence.relationship_coverage).toEqual(
        parent.relationship_coverage,
      );
      expect(evidence.normalized_result).toMatchObject({
        item: [],
        coverage: { total: 0, exhausted: true },
        limitations: expect.arrayContaining(["Fixture dossier caveat"]),
      });
      expect(session.evidenceById(evidence.evidence_id)).toEqual(evidence);
      outputs.push(evidence);
    }
    expect(outputs[0]).toEqual(outputs[1]);
    expect(JSON.stringify(parent)).toBe(parentBefore);
  }
});

it("advertises typed module references and preserves portable/retained Evidence parity", async () => {
  const { client, session } = await connect();
  const parent = analysisViewJavaScriptEvidence(
    analysisViewJavaScriptAnalysisWithSource(),
  );
  const recorded = session.recordEvidence(parent);
  if (!recorded.ok) throw recorded.error;
  const { ajv, inputSchema, outputSchema } = await advertisedMcpToolSchemas(
    client,
    "inspect_analysis_view",
  );
  const view = {
    kind: "javascript",
    collection: "modules",
    projection: "references",
    where: { path: "renderer.js" },
    limit: 1,
  };
  const outputs = [];
  for (const source of [
    { kind: "inline", evidence: parent },
    { kind: "retained-evidence", evidence_id: parent.evidence_id },
  ]) {
    expect(ajv.validate(inputSchema, { source, view })).toBe(true);
    expect(
      ajv.validate(inputSchema, {
        source,
        view: { ...view, where: { glob: "*" } },
      }),
    ).toBe(false);
    const response = await client.callTool({
      name: "inspect_analysis_view",
      arguments: { source, view },
    });
    expect(response.isError).not.toBe(true);
    expect(
      ajv.validate(outputSchema, response.structuredContent),
      JSON.stringify(ajv.errors),
    ).toBe(true);
    const evidence = parseEvidence(response.structuredContent);
    expect(evidence).toMatchObject({
      evidence_links: [parent.evidence_id],
      normalized_result: {
        kind: "javascript",
        rows: [
          {
            path: "renderer.js",
            identity: expect.any(Object),
            basis: expect.any(Array),
          },
        ],
        coverage: { exhausted: true },
      },
    });
    expect(session.evidenceById(evidence.evidence_id)).toEqual(evidence);
    outputs.push(evidence.normalized_result);
  }
  expect(outputs[0]).toEqual(outputs[1]);
});

it("projects opted-in query names identically from retained and portable MCP Evidence", async () => {
  const { client, session } = await connect();
  const capture = analysisViewCaptureFixture();
  capture.records = capture.records.slice(0, 2);
  capture.total_records = 2;
  capture.records.forEach((record, index) => {
    record.reported = {
      request: {
        method: "GET",
        url:
          index === 0
            ? "https://api.test/products?a+b=one&a%2Bb=two&=three&a+b=four"
            : "https://api.test/products?a+b=five&snow=six#ignored",
      },
    };
  });
  const parent = analysisViewCaptureEvidence(capture);
  const retained = session.recordEvidence(parent);
  if (!retained.ok) throw retained.error;
  const outputs = [];
  for (const source of [
    { kind: "inline", evidence: parent },
    { kind: "retained-evidence", evidence_id: parent.evidence_id },
  ]) {
    const response = await client.callTool({
      name: "inspect_analysis_view",
      arguments: {
        source,
        view: { kind: "api-surface", include_query_parameter_names: true },
      },
    });
    expect(response.isError).not.toBe(true);
    const evidence = parseEvidence(response.structuredContent);
    expect(evidence.normalized_result).toMatchObject({
      parent_evidence_id: parent.evidence_id,
      groups: [
        {
          query_parameter_names: [
            { name: "", record_ordinals: [0] },
            { name: "a b", record_ordinals: [0, 1] },
            { name: "a+b", record_ordinals: [0] },
            { name: "snow", record_ordinals: [1] },
          ],
        },
      ],
    });
    outputs.push(evidence.normalized_result);
  }
  expect(outputs[0]).toEqual(outputs[1]);
});

it("discovers an oversized native dossier by exact metadata and reads its retained view", async () => {
  const { client, session } = await connect();
  const advertised = (await client.listTools()).tools.find(
    (tool) => tool.name === "inspect_analysis_view",
  );
  expect(advertised?.description).toContain(
    'Native function Evidence requires kind native: view: {kind: "native", facet: "procedure"}',
  );
  const provider = { id: "ghidra", name: "Ghidra", version: "12.1.4" };
  const profile = createAnalysisProfile(provider, { language: "fixture" });
  const parent = createEvidence(
    { path: "/fixtures/large.exe", format: "pe", sha256: "a".repeat(64) },
    provider,
    {
      operation: "analyze_function",
      parameters: { procedure: "0x401000" },
      analysisProfile: profile,
      result: {
        ...jsonObjectSchema.parse(ghidraFunctionDossier()),
        pseudocode: "x".repeat(6 * 1024 * 1024),
      },
      rawResult: null,
    },
  );
  const other = createEvidence(
    { path: "/fixtures/other.exe", format: "pe", sha256: "b".repeat(64) },
    provider,
    {
      operation: "analyze_function",
      parameters: {},
      result: ghidraFunctionDossier(),
    },
  );
  for (const record of [parent, other]) {
    const retained = session.recordEvidence(record);
    if (!retained.ok) throw retained.error;
  }
  const unsupportedSummary = await client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source: { kind: "retained-evidence", evidence_id: parent.evidence_id },
      view: { kind: "summary" },
    },
  });
  expect(parseMcpToolError(unsupportedSummary).error).toMatchObject({
    code: "invalid_request",
    details: {
      issues: [
        {
          path: ["view"],
          message: "analyze_function Evidence requires a native view.",
        },
      ],
    },
  });
  const broad = await client.callTool({
    name: "get_evidence_bundle",
    arguments: {},
  });
  const broadError = parseMcpToolError(broad).error;
  expect(broadError.code).toBe("resource_constraint");
  expect(broadError.remediation?.action).toContain(
    "get_evidence_bundle and detail: summary",
  );
  const response = await client.callTool({
    name: "get_evidence_bundle",
    arguments: {
      detail: "summary",
      filters: {
        operation: "analyze_function",
        target_sha256: "a".repeat(64),
        analysis_profile_digest: profile.digest,
        procedure_address: "0x401000",
      },
    },
  });
  expect(response.isError).not.toBe(true);
  const result = toolContract("get_evidence_bundle").outputSchema.parse(
    response.structuredContent,
  ).result;
  expect(result).toMatchObject({
    kind: "evidence-bundle-summary",
    total_retained_records: 2,
    matching_records: 1,
    records: [
      {
        evidence_id: parent.evidence_id,
        analysis_profile_digest: profile.digest,
        retention: "complete-record",
        native_dossier: { available: true, procedure_address: "0x401000" },
      },
    ],
  });
  expect(JSON.stringify(response)).not.toContain("pseudocode");
  expect(
    JSON.parse(response.content.find((c) => c.type === "text")?.text ?? "null"),
  ).toEqual(response.structuredContent);
  const page = await client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source: { kind: "retained-evidence", evidence_id: parent.evidence_id },
      view: { kind: "native", facet: "pseudocode", offset: 0, limit: 32 },
    },
  });
  expect(page.isError).not.toBe(true);
  expect(
    toolContract("inspect_analysis_view").outputSchema.parse(
      page.structuredContent,
    ).normalized_result,
  ).toMatchObject({
    item: { text: "x".repeat(32) },
    coverage: { total: 6 * 1024 * 1024, exhausted: false },
  });
  const empty = await client.callTool({
    name: "get_evidence_bundle",
    arguments: {
      detail: "summary",
      filters: { evidence_id: `ev_${"e".repeat(64)}` },
    },
  });
  expect(
    toolContract("get_evidence_bundle").outputSchema.parse(
      empty.structuredContent,
    ).result,
  ).toMatchObject({ matching_records: 0, records: [] });
  await client.ping();
  const invalid = await client.callTool({
    name: "get_evidence_bundle",
    arguments: { filters: { operation: "analyze_function" } },
  });
  expect(parseMcpToolError(invalid).error.code).toBe("invalid_request");
});

it("advertises exact schemas and projects one layout section from retained Evidence", async () => {
  const layout = analysisViewLayoutFixture();
  const service = new BinaryLayoutService({
    inspectAndClose(input, options) {
      return this.inspect(input, options);
    },
    identity: BINARY_LAYOUT_TEST_PROVIDER,
    inspect: () => Promise.resolve(ok(layout)),
  });
  const { client, session } = await connect(service);
  const { ajv, inputSchema, outputSchema } = await advertisedMcpToolSchemas(
    client,
    "inspect_analysis_view",
  );
  expect(
    ajv.validate(inputSchema, {
      source: { kind: "inline", evidence: analysisViewLayoutEvidence() },
      view: { kind: "summary" },
    }),
  ).toBe(true);
  expect(
    ajv.validate(inputSchema, {
      source: { kind: "inline", evidence: {} },
      view: { kind: "summary" },
    }),
  ).toBe(false);
  expect(
    ajv.validate(inputSchema, {
      source: {
        kind: "retained-evidence",
        evidence_id: `ev_${"a".repeat(64)}`,
      },
      view: { kind: "summary", approval: true },
    }),
  ).toBe(false);
  const inspected = await client.callTool({
    name: "inspect_binary_layout",
    arguments: { path: layout.artifact.path },
  });
  expect(inspected.isError).not.toBe(true);
  const parent = toolContract("inspect_binary_layout").outputSchema.parse(
    inspected.structuredContent,
  );
  const response = await client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source: {
        kind: "retained-evidence",
        evidence_id: parent.evidence_id,
      },
      view: {
        kind: "item",
        collection: "sections",
        selector: { name: ".data" },
      },
    },
  });
  expect(response.isError).not.toBe(true);
  expect(
    ajv.validate(outputSchema, response.structuredContent),
    JSON.stringify(ajv.errors),
  ).toBe(true);
  const parsed = toolContract("inspect_analysis_view").outputSchema.parse(
    response.structuredContent,
  );
  expect(parsed.normalized_result).toMatchObject({
    kind: "item",
    parent_evidence_id: parent.evidence_id,
    item: { name: { display: ".data" } },
  });
  expect(session.evidenceById(parsed.evidence_id)).toEqual(
    parseEvidence(parsed),
  );
});

it("points omitted inline messages to the caller's parent without promising session recovery", async () => {
  const { client, session } = await connect();
  const messages = Array.from(
    { length: 65 },
    (_, index) => `Limitation ${String(index).padStart(2, "0")}`,
  ).concat("z".repeat(300_000));
  const parent = analysisViewLayoutEvidence({
    ...analysisViewLayoutFixture(),
    limitations: messages,
  });
  expect(session.evidenceById(parent.evidence_id)).toBeUndefined();
  const response = await client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source: { kind: "inline", evidence: parent },
      view: { kind: "summary" },
    },
  });
  expect(response.isError).not.toBe(true);
  const view = toolContract("inspect_analysis_view").outputSchema.parse(
    response.structuredContent,
  );
  const projected = z
    .object({ limitations: z.array(z.string()) })
    .parse(view.normalized_result);
  expect(projected.limitations).toEqual([
    ...messages.slice(0, 65),
    `1 additional limitations omitted from this view; consult source parent Evidence ${parent.evidence_id} for the complete list (the caller-supplied record, or its retaining session).`,
  ]);
  expect(session.evidenceById(parent.evidence_id)).toBeUndefined();
  expect(session.evidenceById(view.evidence_id)).toEqual(parseEvidence(view));
});

it("reports a tampered inline Evidence ID at its full MCP source path", async () => {
  const { client } = await connect();
  const parent = analysisViewLayoutEvidence();
  const response = await client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source: {
        kind: "inline",
        evidence: { ...parent, evidence_id: `ev_${"0".repeat(64)}` },
      },
      view: { kind: "summary" },
    },
  });

  expect(parseMcpToolError(response).error).toMatchObject({
    code: "invalid_request",
    category: "invalid_input",
    details: {
      issues: [
        {
          path: ["source", "evidence", "evidence_id"],
          reason: "invalid_value",
          message: "Evidence semantic identifier does not match its record",
        },
      ],
    },
  });
});

it("rejects self-contained WASM and EVM Evidence views when the subject format differs", async () => {
  const { client } = await connect();
  const wasm = wasmArtifactFixture();
  const evm = evmInterfaceFixture();
  const cases = [
    {
      evidence: createEvidence(
        {
          path: wasm.artifact.path,
          format: "elf",
          sha256: wasm.artifact.sha256,
        },
        { id: "fixture-wabt", name: "WABT", version: "1" },
        {
          operation: "inspect_wasm_artifact",
          parameters: { path: wasm.artifact.path },
          result: wasm,
        },
      ),
    },
    {
      evidence: createEvidence(
        {
          path: evm.artifact.path,
          format: "elf",
          sha256: evm.artifact.sha256,
        },
        { id: "fixture-evm", name: "EVMole", version: "1" },
        {
          operation: "inspect_evm_interface",
          parameters: { path: evm.artifact.path, encoding: "hex" },
          result: evm,
        },
      ),
    },
  ] as const;

  for (const { evidence } of cases) {
    const response = await client.callTool({
      name: "inspect_analysis_view",
      arguments: {
        source: { kind: "inline", evidence },
        view: { kind: "summary" },
      },
    });
    expect(parseMcpToolError(response).error).toMatchObject({
      code: "invalid_request",
      details: {
        issues: [
          expect.objectContaining({
            path: ["source", "subject"],
            reason: "invalid_value",
          }),
        ],
      },
    });
  }
});

it("admits portable captures before SDK Evidence parsing and preserves capture caveats", async () => {
  const { client } = await connect();
  const dense = analysisViewCaptureEvidence(analysisViewObjectDenseCapture());
  const refused = await client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source: { kind: "inline", evidence: dense },
      view: { kind: "api-surface" },
    },
  });
  expect(parseMcpToolError(refused).error).toMatchObject({
    code: "resource_constraint",
    details: { resource: "memory" },
  });
  await client.ping();

  const capture = analysisViewCaptureFixture();
  capture.records = capture.records.slice(0, 1);
  capture.total_records = 1;
  const caveat = "Producer omitted exchanges before capture startup.";
  capture.limitations = [caveat, caveat];
  capture.records[0]!.reported = {
    request: { method: "GET", url: "https://api.test/a" },
    response: { status: 200, content: { mimeType: "\u00a0text/plain\u00a0" } },
  };
  const parent = analysisViewCaptureEvidence(capture);
  expect(parent.limitations).not.toContain(caveat);
  const response = await client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source: { kind: "inline", evidence: parent },
      view: { kind: "api-surface" },
    },
  });
  const result = parseEvidence(response.structuredContent);
  expect(result.limitations.filter((value) => value === caveat)).toEqual([
    caveat,
  ]);
  expect(result.normalized_result).toMatchObject({
    groups: [{ content_types: [], flags: ["single-sample"] }],
    limitations: expect.arrayContaining([caveat]),
    unknowns: [
      "Some retained records have unavailable status or content type values.",
    ],
  });
});

it("rejects inconsistent portable coverage and accepts caller-ordered ordinal subsets", async () => {
  const { client } = await connect();
  for (const [total, ordinals] of [
    [0, [0]],
    [2, [0, 0]],
    [2, [2]],
  ] as const) {
    const capture = analysisViewCaptureFixture();
    capture.total_records = total;
    capture.records = ordinals.map((ordinal) => ({
      ...capture.records[0]!,
      ordinal,
    }));
    const response = await client.callTool({
      name: "inspect_analysis_view",
      arguments: {
        source: {
          kind: "inline",
          evidence: analysisViewCaptureEvidence(capture),
        },
        view: { kind: "api-surface" },
      },
    });
    expect(parseMcpToolError(response).error.code).toBe("invalid_request");
  }
  const capture = analysisViewCaptureFixture();
  capture.records = [capture.records[8]!, capture.records[1]!];
  const response = await client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source: {
        kind: "inline",
        evidence: analysisViewCaptureEvidence(capture),
      },
      view: { kind: "api-surface" },
    },
  });
  expect(
    parseEvidence(response.structuredContent).normalized_result,
  ).toMatchObject({
    records: { examined: 2, total: 15 },
    limitations: expect.arrayContaining([
      "Parent contains an ordinal subset; the surface covers only retained records.",
    ]),
  });
});

it("delivers a bounded native dossier view over MCP without a Ghidra provider or lost connection", async () => {
  const { client, session } = await connect();
  const original = functionDossierSchema.parse(ghidraFunctionDossier());
  const parent = createEvidence(
    {
      path: "/fixtures/oversized-native.exe",
      format: "pe",
      sha256: "b".repeat(64),
    },
    { id: "ghidra", name: "Ghidra", version: "12.1.4" },
    {
      operation: "analyze_function",
      parameters: { address: "0x401000" },
      result: { ...original, pseudocode: "X".repeat(11 * 1024 * 1024) },
    },
  );
  expect(session.recordEvidence(parent).ok).toBe(true);
  const advertised = (await client.listTools()).tools.find(
    (tool) => tool.name === "inspect_analysis_view",
  );
  if (advertised?.outputSchema === undefined)
    throw new Error("missing view schemas");
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  const inputSchema: Record<string, unknown> = advertised.inputSchema;
  const outputSchema: Record<string, unknown> = advertised.outputSchema;
  const arguments_ = {
    source: { kind: "retained-evidence", evidence_id: parent.evidence_id },
    view: { kind: "native", facet: "pseudocode", offset: 0, limit: 500 },
  };
  expect(ajv.validateSchema(inputSchema)).toBe(true);
  expect(ajv.validateSchema(outputSchema)).toBe(true);
  expect(
    ajv.validate(inputSchema, arguments_),
    JSON.stringify(ajv.errors),
  ).toBe(true);
  const response = await client.callTool({
    name: "inspect_analysis_view",
    arguments: arguments_,
  });
  expect(response.isError).not.toBe(true);
  expect(
    ajv.validate(outputSchema, response.structuredContent),
    JSON.stringify(ajv.errors),
  ).toBe(true);
  const parsed = toolContract("inspect_analysis_view").outputSchema.parse(
    response.structuredContent,
  );
  expect(parsed.normalized_result).toMatchObject({
    kind: "native",
    parent_evidence_id: parent.evidence_id,
    procedure_address: "0x401000",
    coverage: { examined: 500, next_offset: 500, total: 11 * 1024 * 1024 },
  });
  expect(parsed.evidence_links).toEqual([parent.evidence_id]);
  expect(parsed.locations).toEqual([
    { kind: "artifact-path", path: "/fixtures/oversized-native.exe" },
    { kind: "address", address: "0x401000" },
  ]);
  expect(JSON.stringify(response.structuredContent).length).toBeLessThan(12000);
  await client.ping();
});

it("retains an oversized selected observation and keeps subsequent views usable", async () => {
  const { client, session } = await connect();
  const analysis = analysisViewJavaScriptAnalysisWithSource();
  const original = analysis.graph.nodes[0];
  if (original === undefined) throw new Error("missing module");
  const source = "\0".repeat(1_000_000);
  const node = createJavaScriptApplicationNode({
    kind: original.kind,
    identity: original.identity,
    observations: original.observations.map((observation) => ({
      label: observation.label,
      properties: { ...observation.properties, source },
      evidence: observation.evidence,
    })),
  });
  const graph = createJavaScriptApplicationGraph({
    schema: "JavaScriptApplicationGraph",
    root_node_ids: [node.node_id],
    nodes: [node],
    edges: [],
    coverage: analysis.graph.coverage,
    limitations: analysis.graph.limitations,
  });
  const parent = analysisViewJavaScriptEvidence(
    analysisViewBindJavaScriptGraphs(analysis, graph),
  );
  expect(session.recordEvidence(parent).ok).toBe(true);
  const response = await client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source: { kind: "retained-evidence", evidence_id: parent.evidence_id },
      view: {
        kind: "item",
        collection: "modules",
        selector: { node_id: node.node_id },
      },
    },
  });
  expect(response.isError).toBe(true);
  const reference = z
    .object({
      error: z.object({
        details: z.object({
          reported_limits: z.object({
            evidence_reference: z.object({
              kind: z.literal("retained-evidence"),
              evidence_id: z.string(),
            }),
          }),
        }),
      }),
    })
    .parse(parseMcpToolError(response)).error.details
    .reported_limits.evidence_reference;
  expect(
    session.evidenceById(reference.evidence_id)?.normalized_result,
  ).toMatchObject({
    item: {
      observations: [
        expect.objectContaining({
          properties: expect.objectContaining({ source }),
        }),
      ],
    },
  });
  await client.ping();
  const summary = await client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source: { kind: "retained-evidence", evidence_id: parent.evidence_id },
      view: { kind: "summary" },
    },
  });
  expect(summary.isError).not.toBe(true);
});

it("retains an oversized native assembly row and permits a subsequent smaller view", async () => {
  const { client, session } = await connect();
  const row = "\0".repeat(1_000_000);
  const parent = createEvidence(
    { path: "/fixtures/large-row.exe", format: "pe", sha256: "c".repeat(64) },
    { id: "ghidra", name: "Ghidra", version: "12.1.4" },
    {
      operation: "analyze_function",
      parameters: {},
      result: {
        ...functionDossierSchema.parse(ghidraFunctionDossier()),
        assembly: [row],
      },
    },
  );
  expect(session.recordEvidence(parent).ok).toBe(true);
  const source = { kind: "retained-evidence", evidence_id: parent.evidence_id };
  const response = await client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source,
      view: { kind: "native", facet: "assembly", offset: 0, limit: 1 },
    },
  });
  expect(response.isError).toBe(true);
  const error = z
    .object({
      error: z.object({
        details: z.object({
          reported_limits: z.object({
            evidence_reference: z.object({
              kind: z.literal("retained-evidence"),
              evidence_id: z.string(),
            }),
          }),
        }),
      }),
    })
    .parse(parseMcpToolError(response));
  const retained = session.evidenceById(
    error.error.details.reported_limits.evidence_reference.evidence_id,
  );
  expect(retained?.normalized_result).toMatchObject({
    item: [row],
    parent_evidence_id: parent.evidence_id,
  });
  const next = await client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source,
      view: { kind: "native", facet: "pseudocode", offset: 0, limit: 12 },
    },
  });
  expect(next.isError).not.toBe(true);
  expect(
    toolContract("inspect_analysis_view").outputSchema.parse(
      next.structuredContent,
    ).normalized_result,
  ).toMatchObject({
    item: { text: "int fixture_" },
    parent_evidence_id: parent.evidence_id,
  });
  await client.ping();
});

it("reads successive native source pages directly from a completed-result transport error", async () => {
  const pseudocode = "int fixture_add(int a, int b) { return a + b; }\n".repeat(
    150_000,
  );
  const harness = await connectGhidraMcp(
    "native-continuation",
    async (operation) => {
      if (operation !== "analyze_function")
        throw new Error(`Unexpected provider operation: ${operation}`);
      return ok({
        value: {
          ...functionDossierSchema.parse(ghidraFunctionDossier()),
          pseudocode,
        },
        limitations: [],
      });
    },
  );
  onTestFinished(() => harness.close());
  const { mcp: client, session, calls } = harness;
  const failed = await client.callTool({
    name: "analyze_function",
    arguments: { procedure: "0x401000" },
  });
  expect(failed.isError).toBe(true);
  const limits = z
    .object({
      error: z.object({
        details: z.object({ reported_limits: jsonObjectSchema }),
      }),
    })
    .parse(parseMcpToolError(failed)).error.details.reported_limits;
  const reference = z
    .object({
      kind: z.literal("retained-evidence"),
      evidence_id: z.string(),
    })
    .parse(limits.evidence_reference);
  const parent = parseEvidence(session.evidenceById(reference.evidence_id));
  expect(parent.operation).toBe("analyze_function");
  expect(parent.parameters).toMatchObject({ procedure: "0x401000" });
  const call = z
    .object({
      name: z.literal("inspect_analysis_view"),
      arguments: toolContract("inspect_analysis_view").inputSchema,
    })
    .parse(limits.continuation);
  expect(call.arguments.source).toEqual({
    kind: "retained-evidence",
    evidence_id: parent.evidence_id,
  });
  const first = await client.callTool(call);
  expect(first.isError).not.toBe(true);
  const page = toolContract("inspect_analysis_view").outputSchema.parse(
    first.structuredContent,
  ).normalized_result;
  expect(page).toMatchObject({
    parent_evidence_id: parent.evidence_id,
    item: { text: pseudocode.slice(0, 64) },
    coverage: { examined: 64, next_offset: 64, exhausted: false },
  });
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(
    STDIO_DEFAULT_MAX_BUFFER_SIZE,
  );
  const second = await client.callTool({
    name: call.name,
    arguments: {
      ...call.arguments,
      view: {
        kind: "native",
        facet: "pseudocode",
        offset: page.coverage.next_offset,
        limit: 64,
      },
    },
  });
  expect(second.isError).not.toBe(true);
  expect(
    toolContract("inspect_analysis_view").outputSchema.parse(
      second.structuredContent,
    ).normalized_result,
  ).toMatchObject({ item: { text: pseudocode.slice(64, 128) } });
  expect(
    session.evidenceById(parent.evidence_id)?.normalized_result,
  ).toMatchObject({ pseudocode });
  await client.ping();
  expect(calls).toEqual(["analyze_function"]);
});

it("returns a JavaScript summary without graph payloads from a retained reference", async () => {
  const { client, session } = await connect();
  const parent = analysisViewJavaScriptEvidence();
  expect(session.recordEvidence(parent).ok).toBe(true);
  const response = await client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source: {
        kind: "retained-evidence",
        evidence_id: parent.evidence_id,
      },
      view: { kind: "summary" },
    },
  });
  expect(response.isError).not.toBe(true);
  const parsed = toolContract("inspect_analysis_view").outputSchema.parse(
    response.structuredContent,
  );
  expect(parsed.normalized_result).toMatchObject({
    kind: "summary",
    parent_operation: "analyze_javascript_application",
    summary: { format: "directory" },
  });
  expect(parsed.normalized_result).not.toHaveProperty("summary.semantic_graph");
  const stale = await client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source: {
        kind: "retained-evidence",
        evidence_id: `ev_${"e".repeat(64)}`,
      },
      view: { kind: "summary" },
    },
  });
  expect(parseMcpToolError(stale)).toMatchObject({
    error: { details: { reason: "missing" } },
  });
});

it("accepts a transport-constraint retained reference as the view source", async () => {
  const { client, session } = await connect();
  const parent = analysisViewJavaScriptEvidence();
  expect(session.recordEvidence(parent).ok).toBe(true);
  const evidenceReference = {
    kind: "retained-evidence" as const,
    evidence_id: parent.evidence_id,
  };
  const response = await client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source: evidenceReference,
      view: {
        kind: "page",
        collection: "modules",
        offset: 0,
        limit: 8,
      },
    },
  });
  expect(response.isError).not.toBe(true);
  const parsed = toolContract("inspect_analysis_view").outputSchema.parse(
    response.structuredContent,
  );
  expect(parsed.normalized_result).toMatchObject({
    kind: "page",
    parent_evidence_id: parent.evidence_id,
    coverage: { exhausted: true },
  });
  if (parsed.normalized_result.kind !== "page")
    throw new Error("expected page view");
  expect(parsed.normalized_result.items).toEqual([
    {
      node_id: expect.any(String),
      kind: "javascript-asset",
      path: "renderer.js",
    },
  ]);
});

it("projects an actual HAR capture retained by the public MCP workflow", async () => {
  const root = await createTestTempDirectory("rea-surface-mcp-");
  const path = join(root, "surface.har");
  await writeFile(path, JSON.stringify(apiSurfaceHar()));
  const service = new WebNetworkCaptureService({
    inspect: async (input) => {
      const bytes = await readFile(input.capture_path);
      return ok({
        ...decodeHarCapture(bytes.toString("utf8"), input.sensitive_values),
        artifact: {
          path: input.capture_path,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          bytes: bytes.length,
        },
        format: "har",
        runtime_attribution: "unknown",
        limitations: [],
      });
    },
  });
  const { client } = await connect(undefined, service);
  const captureResponse = await client.callTool({
    name: "inspect_web_network_capture",
    arguments: { capture_path: path, format: "har" },
  });
  expect(captureResponse.isError).not.toBe(true);
  const parent = parseEvidence(captureResponse.structuredContent);
  const response = await client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source: { kind: "retained-evidence", evidence_id: parent.evidence_id },
      view: { kind: "api-surface" },
    },
  });
  expect(response.isError).not.toBe(true);
  const evidence = parseEvidence(response.structuredContent);
  expect(evidence.confidence).toBe("inferred");
  expect(evidence.normalized_result).toMatchObject({
    records: { examined: 13, total: 13, excluded: 0 },
    coverage: { total: 12, exhausted: true },
    groups: expect.arrayContaining([
      expect.objectContaining({
        path_template: "/users/{numeric}",
        record_ordinals: [0, 1],
      }),
    ]),
  });
});

const PUBLISHED_EXAMPLES: readonly (readonly [
  name: string,
  example: {
    readonly input: {
      readonly source: { readonly evidence_id: string };
      readonly view: Record<string, unknown>;
    };
    readonly output: { readonly artifact: { readonly path: string } };
  },
  fixture: () => unknown,
])[] = [
  [
    "API surface",
    API_SURFACE_EXAMPLE,
    () => {
      const fixture = apiSurfaceHar();
      fixture.log.entries = fixture.log.entries.slice(0, 2);
      return fixture;
    },
  ],
  [
    "environment manifest",
    ENVIRONMENT_MANIFEST_EXAMPLE,
    () => {
      const fixture = environmentManifestHar();
      fixture.log.entries = [10, 20, 27].map(
        (index) => fixture.log.entries[index]!,
      );
      return fixture;
    },
  ],
];

it.each(PUBLISHED_EXAMPLES)(
  "reproduces the published %s example from decoded fixture bytes",
  async (_name, example, fixture) => {
    const bytes = Buffer.from(JSON.stringify(fixture()));
    const path = example.output.artifact.path;
    const service = new WebNetworkCaptureService({
      inspect: async () =>
        ok({
          ...decodeHarCapture(bytes.toString("utf8"), []),
          artifact: {
            path,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            bytes: bytes.length,
          },
          format: "har",
          runtime_attribution: "unknown",
          limitations: [],
        }),
    });
    const { client } = await connect(undefined, service);
    const capture = await client.callTool({
      name: "inspect_web_network_capture",
      arguments: { capture_path: path, format: "har" },
    });
    expect(parseEvidence(capture.structuredContent).evidence_id).toBe(
      example.input.source.evidence_id,
    );
    const response = await client.callTool({
      name: "inspect_analysis_view",
      arguments: example.input,
    });
    expect(parseEvidence(response.structuredContent).normalized_result).toEqual(
      example.output,
    );
  },
);

it("extracts an environment state identically from retained, portable and file MCP Evidence", async () => {
  const { client, session } = await connect();
  const { ajv, inputSchema, outputSchema } = await advertisedMcpToolSchemas(
    client,
    "inspect_analysis_view",
  );
  const capture = environmentStateCaptureFixture();
  const parent = analysisViewCaptureEvidence(capture);
  expect(session.recordEvidence(parent).ok).toBe(true);
  const evidencePath = join(
    await createTestTempDirectory("rea-state-file-mcp-"),
    "capture.json",
  );
  await writeFile(evidencePath, JSON.stringify(parent));
  const view = {
    kind: "environment-state",
    template_rules: ["after-uid-literal", "opaque-token", "sibling-variance"],
  };
  const outputs = [];
  for (const source of [
    { kind: "inline", evidence: parent },
    { kind: "retained-evidence", evidence_id: parent.evidence_id },
    { kind: "evidence-file", path: evidencePath },
  ]) {
    expect(ajv.validate(inputSchema, { source, view })).toBe(true);
    const response = await client.callTool({
      name: "inspect_analysis_view",
      arguments: { source, view },
    });
    expect(response.isError).not.toBe(true);
    expect(
      ajv.validate(outputSchema, response.structuredContent),
      JSON.stringify(ajv.errors),
    ).toBe(true);
    const evidence = parseEvidence(response.structuredContent);
    expect(evidence.confidence).toBe("inferred");
    expect(evidence.normalized_result).toMatchObject({
      kind: "environment-state",
      views: expect.arrayContaining([
        expect.objectContaining({
          tool: "get_folders_by_uid",
          shape: "item",
        }),
      ]),
    });
    expect(session.evidenceById(evidence.evidence_id)).toEqual(evidence);
    outputs.push(evidence.normalized_result);
  }
  expect(outputs[0]).toEqual(outputs[1]);
  expect(outputs[2]).toEqual(outputs[0]);
  const hidden = createEvidence(
    {
      path: capture.artifact.path,
      sha256: capture.artifact.sha256!,
      format: "file",
    },
    { id: "fixture", name: "fixture", version: "1" },
    {
      operation: "inspect_web_network_capture",
      parameters: { sensitive_value_count: 1 },
      result: capture,
      confidence: "observed",
    },
  );
  const refused = await client.callTool({
    name: "inspect_analysis_view",
    arguments: { source: { kind: "inline", evidence: hidden }, view },
  });
  expect(parseMcpToolError(refused).error.code).toBe("unsupported_target");
  expect(JSON.stringify(refused)).not.toContain("probe folder");
  await client.ping();
});

it("projects an environment manifest identically from retained, portable and file MCP Evidence", async () => {
  const { client, session } = await connect();
  const { ajv, inputSchema, outputSchema } = await advertisedMcpToolSchemas(
    client,
    "inspect_analysis_view",
  );
  const capture = environmentManifestCaptureFixture();
  const parent = analysisViewCaptureEvidence(capture);
  expect(session.recordEvidence(parent).ok).toBe(true);
  const evidencePath = join(
    await createTestTempDirectory("rea-evidence-file-mcp-"),
    "capture.json",
  );
  await writeFile(evidencePath, JSON.stringify(parent));
  const view = {
    kind: "environment-manifest",
    template_rules: ["after-uid-literal", "opaque-token", "sibling-variance"],
  };
  const outputs = [];
  for (const source of [
    { kind: "inline", evidence: parent },
    { kind: "retained-evidence", evidence_id: parent.evidence_id },
    { kind: "evidence-file", path: evidencePath },
  ]) {
    expect(ajv.validate(inputSchema, { source, view })).toBe(true);
    expect(
      ajv.validate(inputSchema, {
        source,
        view: { ...view, template_rules: ["glob"] },
      }),
    ).toBe(false);
    const response = await client.callTool({
      name: "inspect_analysis_view",
      arguments: { source, view },
    });
    expect(response.isError).not.toBe(true);
    expect(
      ajv.validate(outputSchema, response.structuredContent),
      JSON.stringify(ajv.errors),
    ).toBe(true);
    const evidence = parseEvidence(response.structuredContent);
    expect(evidence.confidence).toBe("inferred");
    expect(evidence.normalized_result).toMatchObject({
      kind: "environment-manifest",
      name: "grafana-example",
      templated_groups: 13,
      tools: expect.arrayContaining([
        expect.objectContaining({
          name: "get_plugins_settings_by_plugin_id",
          path_template: "/api/plugins/{plugin_id}/settings",
        }),
        expect.objectContaining({
          name: "get_folders_by_uid",
          path_template: "/api/folders/{uid}",
        }),
      ]),
    });
    expect(session.evidenceById(evidence.evidence_id)).toEqual(evidence);
    for (const value of ["probe folder", "Main Org", "JFIF", "console.log"])
      expect(JSON.stringify(response)).not.toContain(value);
    outputs.push(evidence.normalized_result);
  }
  expect(outputs[0]).toEqual(outputs[1]);
  expect(outputs[2]).toEqual(outputs[0]);
  // JSON Schema cannot express "absolute"; the tool refuses a relative path when called.
  const relative = await client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source: { kind: "evidence-file", path: "capture.json" },
      view,
    },
  });
  expect(parseMcpToolError(relative).error.code).toBe("invalid_request");
  await writeFile(evidencePath, JSON.stringify({ hello: 1 }));
  const invalidFile = await client.callTool({
    name: "inspect_analysis_view",
    arguments: { source: { kind: "evidence-file", path: evidencePath }, view },
  });
  expect(parseMcpToolError(invalidFile).error).toMatchObject({
    details: {
      path: evidencePath,
      reason: "wrong-kind",
      content_issues: expect.arrayContaining([
        {
          path: ["evidence_id"],
          reason: "missing_argument",
          expected: "string",
        },
      ]),
    },
  });
  const hidden = createEvidence(
    {
      path: capture.artifact.path,
      sha256: capture.artifact.sha256!,
      format: "file",
    },
    { id: "fixture", name: "fixture", version: "1" },
    {
      operation: "inspect_web_network_capture",
      parameters: { sensitive_value_count: 1 },
      result: capture,
      confidence: "observed",
    },
  );
  const refused = await client.callTool({
    name: "inspect_analysis_view",
    arguments: { source: { kind: "inline", evidence: hidden }, view },
  });
  expect(parseMcpToolError(refused).error.code).toBe("unsupported_target");
  expect(JSON.stringify(refused)).toContain("sensitive_values_unretained");
  expect(JSON.stringify(refused)).not.toContain("/api/folders");
  await client.ping();
});
