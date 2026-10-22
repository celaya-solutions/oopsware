import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  TextReader,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipWriter,
} from "@zip.js/zip.js";
import { afterEach, describe, expect, it } from "vitest";

import { createAnalysisExecution } from "../../../src/application/AnalysisProvider.js";
import { createDirectAnalysis } from "../../../src/composition/directAnalysis.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { extractGraphs } from "../../../src/domain/graph/graphAdapters.js";
import type { GraphJson } from "../../../src/domain/graph/graphModel.js";
import { ok } from "../../../src/domain/result.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { closeEnhancedToolResources, connect } from "./enhancedToolsHarness.js";

afterEach(closeEnhancedToolResources);

// 0x1 -> 0x2 -> 0x3, 0x1 -> 0x3, and 0x3 -> 0x1 (a cycle).
const CALLEES: Readonly<Record<string, string[]>> = {
  "0x1": ["0x2", "0x3"],
  "0x2": ["0x3"],
  "0x3": ["0x1"],
};
const CALLERS: Readonly<Record<string, string[]>> = {
  "0x1": ["0x3"],
  "0x2": ["0x1"],
  "0x3": ["0x1", "0x2"],
};

const execution = (result: unknown) =>
  ok(
    createAnalysisExecution(
      result,
      { id: "fixture", name: "Fixture analysis provider", version: "1" },
      { limitations: [], relationshipCoverage: { status: "complete" } },
    ),
  );

const callClient = () =>
  connect({
    execute: async (name, arguments_) => {
      const procedure = String(arguments_.procedure);
      if (name === "procedure_address") return execution(procedure);
      if (name === "procedure_callees")
        return execution(CALLEES[procedure] ?? []);
      if (name === "procedure_callers")
        return execution(CALLERS[procedure] ?? []);
      throw new Error(`Unexpected operation: ${name}`);
    },
  });

const graphOf = async (
  client: Client,
  name: string,
  arguments_: Record<string, unknown>,
) => {
  const result = await client.callTool({ name, arguments: arguments_ });
  if (result.isError === true) throw new Error(JSON.stringify(result));
  const graphs = extractGraphs(name, result.structuredContent as GraphJson);
  expect(graphs).toHaveLength(1);
  return graphs[0]!;
};

const edgeSet = (graph: { edges: readonly { from: string; to: string }[] }) =>
  graph.edges.map(({ from, to }) => `${from}>${to}`).sort();

describe("graph adapters on delivered MCP results", () => {
  it("draws get_call_graph edges in call direction both ways", async () => {
    const client = await callClient();
    const forward = await graphOf(client, "get_call_graph", {
      address: "0x1",
      direction: "forward",
    });
    expect(forward.roots).toEqual(["0x1"]);
    expect(edgeSet(forward)).toEqual([
      "0x1>0x2",
      "0x1>0x3",
      "0x2>0x3",
      "0x3>0x1",
    ]);
    expect(forward.evidence_ids[0]).toMatch(/^ev_/);

    const backward = await graphOf(client, "get_call_graph", {
      address: "0x3",
      direction: "backward",
    });
    expect(backward.roots).toEqual(["0x3"]);
    // Callers are stored in `calls`; edges still point caller -> callee.
    expect(edgeSet(backward)).toEqual([
      "0x1>0x2",
      "0x1>0x3",
      "0x2>0x3",
      "0x3>0x1",
    ]);
  });

  it("draws direct callers and callees around the queried procedure", async () => {
    const client = await callClient();
    const callees = await graphOf(client, "procedure_callees", {
      procedure: "0x2",
    });
    expect(edgeSet(callees)).toEqual(["0x2>0x3"]);
    expect(callees.coverage).toEqual({ status: "complete" });
    const callers = await graphOf(client, "procedure_callers", {
      procedure: "0x3",
    });
    expect(edgeSet(callers)).toEqual(["0x1>0x3", "0x2>0x3"]);
    expect(callers.roots).toEqual(["0x3"]);
  });

  it("draws trace_call_path nodes, edges and the goal", async () => {
    const client = await callClient();
    const trace = await graphOf(client, "trace_call_path", {
      start: "0x1",
      goal: "0x3",
    });
    expect(trace.roots).toEqual(["0x1"]);
    expect(trace.nodes.find((node) => node.id === "0x3")?.kind).toBe("goal");
    expect(edgeSet(trace)).toContain("0x1>0x3");
    expect(trace.limitations).toContain("Goal status: reached.");
  });
});

describe("mobile application graphs", () => {
  const resources: Array<{ close(): Promise<unknown> }> = [];
  afterEach(async () => {
    for (const resource of resources.splice(0)) await resource.close();
  });

  const mobileClient = async () => {
    const session = createTestBinarySession(() => {
      throw new Error("mobile graph projection must not launch a provider");
    });
    const server = createServer({ kind: "session", session });
    const client = new Client({ name: "graph-extraction-test", version: "1" });
    resources.push(client, server, session);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await client.connect(a);
    return client;
  };

  const zip = async (
    path: string,
    members: Record<string, Uint8Array | string>,
  ) => {
    const writer = new ZipWriter(new Uint8ArrayWriter());
    for (const [name, value] of Object.entries(members))
      await writer.add(
        name,
        typeof value === "string"
          ? new TextReader(value)
          : new Uint8ArrayReader(value),
      );
    await writeFile(path, await writer.close());
    return path;
  };

  it("draws the containment tree and dashed bridge candidates", async () => {
    const { runProviderAnalysis } = createDirectAnalysis({});
    const root = await createTestTempDirectory("rea-graph-extraction-");
    const apk = await zip(join(root, "Fixture.apk"), {
      "AndroidManifest.xml": Uint8Array.from([3, 0, 8, 0]),
      "classes.dex": Uint8Array.from([
        0x64, 0x65, 0x78, 0x0a, 0x30, 0x33, 0x35, 0,
      ]),
      "lib/arm64-v8a/libfixture.so": Uint8Array.from([
        0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0,
      ]),
    });
    const inventory = parseEvidence(
      await runProviderAnalysis(apk, "inventory_artifact", {}),
    );
    const graph = await graphOf(
      await mobileClient(),
      "project_android_application_graph",
      {
        inventory_evidence: [inventory],
      },
    );
    expect(graph.roots).toEqual(["application"]);
    const groups = graph.nodes.filter(
      (node) => node.kind === "component group",
    );
    expect(groups.map((node) => node.label)).toEqual(
      expect.arrayContaining(["manifests", "dex", "native libraries"]),
    );
    const candidates = graph.edges.filter((edge) => edge.candidate);
    expect(candidates.length).toBeGreaterThan(0);
    for (const edge of candidates) {
      expect(graph.nodes.find((node) => node.id === edge.from)?.kind).toBe(
        "dex",
      );
      expect(graph.nodes.find((node) => node.id === edge.to)?.kind).toBe(
        "native_libraries",
      );
    }
  });
});
