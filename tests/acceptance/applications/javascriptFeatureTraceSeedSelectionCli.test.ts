import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect } from "vitest";
import { z } from "zod";

import { toolContract } from "../../../src/contracts/toolContracts.js";
import {
  applicationFeatureSeedSchema,
  applicationFeatureTraceResultSchema,
} from "../../../src/domain/javascript/javascriptFeatureTraceSchemas.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest, type TestCli } from "../../support/cli/cliFixture.js";

type FeatureSeed = z.input<typeof applicationFeatureSeedSchema>;
type Trace = z.infer<typeof applicationFeatureTraceResultSchema>;
type SeedScenario = {
  readonly name: string;
  readonly seed: FeatureSeed;
  readonly expected: {
    readonly nodeId: string;
    readonly basis: "node-id" | "property";
  } | null;
};

const createSeedScenarios = (
  graph: z.infer<typeof javascriptApplicationAnalysisResultSchema>["graph"],
): SeedScenario[] => {
  const notificationRoute = graph.nodes.find(
    (node) =>
      node.kind === "endpoint" &&
      node.observations.some(
        ({ properties }) =>
          properties.endpoint_kind === "route" &&
          properties.value === "/accounts/preferences/notifications",
      ),
  );
  const tinyRoute = graph.nodes.find(
    (node) =>
      node.kind === "endpoint" &&
      node.observations.some(
        ({ properties }) =>
          properties.endpoint_kind === "route" && properties.value === "/tiny",
      ),
  );
  const labeledNode = graph.nodes.find((node) =>
    node.observations.some(
      ({ label }) => label !== null && label !== node.node_id,
    ),
  );
  if (notificationRoute === undefined || tinyRoute === undefined)
    throw new Error(
      "Expected literal route endpoints in the application graph",
    );
  if (labeledNode === undefined)
    throw new Error("Expected a labeled node in the application graph");
  const label = labeledNode.observations.find(
    ({ label: value }) => value !== null && value !== labeledNode.node_id,
  )?.label;
  if (label === undefined || label === null)
    throw new Error("Expected the selected graph node to have a display label");

  const id = labeledNode.node_id;
  return [
    {
      name: "node ID contains prefix",
      seed: { kind: "node-id", value: id.slice(0, 24), match: "contains" },
      expected: { nodeId: id, basis: "node-id" },
    },
    {
      name: "node ID exact ignores case by default",
      seed: { kind: "node-id", value: id.toUpperCase(), match: "exact" },
      expected: { nodeId: id, basis: "node-id" },
    },
    {
      name: "node ID exact can be case sensitive",
      seed: {
        kind: "node-id",
        value: id.toUpperCase(),
        match: "exact",
        case_sensitive: true,
      },
      expected: null,
    },
    {
      name: "node ID never falls back to a display label",
      seed: { kind: "node-id", value: label, match: "exact" },
      expected: null,
    },
    {
      name: "generated route label exact",
      seed: {
        kind: "route",
        value: "route endpoint",
        match: "exact",
        case_sensitive: true,
      },
      expected: null,
    },
    {
      name: "generated route label substring",
      seed: { kind: "route", value: "route", match: "contains" },
      expected: null,
    },
    {
      name: "preserved long route exact",
      seed: {
        kind: "route",
        value: "/accounts/preferences/notifications",
        match: "exact",
      },
      expected: { nodeId: notificationRoute.node_id, basis: "property" },
    },
    {
      name: "preserved route substring",
      seed: {
        kind: "route",
        value: "/accounts/preferences",
        match: "contains",
      },
      expected: { nodeId: notificationRoute.node_id, basis: "property" },
    },
    {
      name: "short preserved route exact",
      seed: { kind: "route", value: "/tiny", match: "exact" },
      expected: { nodeId: tinyRoute.node_id, basis: "property" },
    },
  ];
};

const analyzeFixture = async (cli: TestCli, root: string) => {
  const response = await cli.run({
    arguments: [
      "analyze-javascript-application",
      root,
      "--artifact-format",
      "directory",
      "--json",
    ],
  });
  expect(response.exitCode).toBe(0);
  const evidence = toolContract(
    "analyze_javascript_application",
  ).outputSchema.parse(response.json);
  return {
    evidence,
    result: javascriptApplicationAnalysisResultSchema.parse(
      evidence.normalized_result,
    ),
  };
};

const traceThroughCli = async (
  cli: TestCli,
  application: unknown,
  scenario: SeedScenario,
): Promise<Trace> => {
  const response = await cli.run({
    arguments: [
      "trace-application-feature",
      JSON.stringify({
        application,
        seed: scenario.seed,
        direction: "both",
      }),
      "--json",
    ],
  });
  expect(response.exitCode, `${scenario.name} via CLI`).toBe(0);
  const evidence = toolContract("trace_application_feature").outputSchema.parse(
    response.json,
  );
  return applicationFeatureTraceResultSchema.parse(evidence.normalized_result);
};

const traceThroughMcp = async (
  client: Client,
  application: unknown,
  scenario: SeedScenario,
): Promise<Trace> => {
  const response = await client.callTool({
    name: "trace_application_feature",
    arguments: {
      application,
      seed: scenario.seed,
      direction: "both",
    },
  });
  expect(response.isError, `${scenario.name} via MCP`).not.toBe(true);
  const evidence = toolContract("trace_application_feature").outputSchema.parse(
    response.structuredContent,
  );
  return applicationFeatureTraceResultSchema.parse(evidence.normalized_result);
};

const expectTrace = (trace: Trace, scenario: SeedScenario): void => {
  if (scenario.expected === null) {
    expect(trace.seed_matches).toEqual([]);
    expect(trace.summary.matched_seeds).toBe(0);
    expect(trace.coverage.status).toBe("no-match");
    return;
  }
  expect(trace.seed_matches).toHaveLength(1);
  expect(trace.seed_matches[0]).toMatchObject({
    node_id: scenario.expected.nodeId,
    basis: scenario.expected.basis,
  });
  expect(trace.summary.matched_seeds).toBe(1);
  expect(trace.coverage.status).toBe("complete-within-source");
  if (scenario.seed.kind === "node-id")
    expect(trace.seed_matches[0]).toMatchObject({
      basis: "node-id",
      field: "node_id",
    });
  else
    expect(trace.seed_matches[0]?.field).toMatch(
      /\.properties\.(value|path)$/u,
    );
};

cliTest(
  "matches feature seeds against node IDs and preserved route values through CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-feature-seed-selection-");
    await writeFile(
      join(root, "routes.js"),
      `const notificationRoute = { path: "/accounts/preferences/notifications" };\nconst tinyRoute = { path: "/tiny" };\nmodule.exports = { notificationRoute, tinyRoute };\n`,
    );
    const { evidence, result } = await analyzeFixture(cli, root);
    const client = new Client({ name: "feature-seed-selection", version: "1" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("scripts/rea.mjs"), "mcp"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "", REA_LOG_LEVEL: "silent" },
      stderr: "pipe",
    });
    transport.stderr?.on("data", () => undefined);
    try {
      await client.connect(transport);
      for (const scenario of createSeedScenarios(result.graph)) {
        const cliTrace = await traceThroughCli(cli, evidence, scenario);
        const mcpTrace = await traceThroughMcp(client, evidence, scenario);
        expectTrace(cliTrace, scenario);
        expectTrace(mcpTrace, scenario);
        expect(mcpTrace.seed_matches).toEqual(cliTrace.seed_matches);
        expect(mcpTrace.coverage).toEqual(cliTrace.coverage);
      }
    } finally {
      await client.close();
      await transport.close();
    }
  },
);
