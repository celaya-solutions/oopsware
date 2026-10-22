import { expect, it } from "vitest";
import {
  artifactEvidence,
  completeCoverage,
  fixtureNode,
} from "./javascriptApplicationGraph.fixture.js";
import {
  createJavaScriptApplicationEdge,
  createJavaScriptApplicationGraph,
  type JavaScriptApplicationGraph,
} from "./javascriptApplicationGraph.js";
import { compareJavaScriptApplicationVersions } from "./javascriptApplicationVersionComparison.js";
import { applicationVersionComparisonResultSchema } from "./javascriptApplicationVersionComparisonSchemas.js";

const graph = (
  sha: string,
  offset: number,
  coverage: JavaScriptApplicationGraph["coverage"],
  options: {
    content?: string;
    permission?: string;
    relation?: "handles" | "invokes";
  } = {},
) => {
  const evidence = {
    ...artifactEvidence(sha, "main.js"),
    location: {
      available: true as const,
      value: {
        kind: "file-offset-range" as const,
        start: offset,
        end: offset + 10,
      },
    },
  };
  const module = fixtureNode(
    "javascript-module",
    {
      strategy: "artifact-local-key",
      stability: "artifact-version",
      artifact_sha256: sha,
      namespace: "webpack-module",
      key: "11",
    },
    "module",
    {
      source_sha256: options.content ?? "c".repeat(64),
      structural_fingerprint_sha256: "d".repeat(64),
      structural_fingerprint_algorithm: "fixture",
    },
    evidence,
  );
  const channel = fixtureNode(
    "ipc-channel",
    {
      strategy: "artifact-local-key",
      stability: "artifact-version",
      artifact_sha256: sha,
      namespace: "ipc",
      key: "unchanged-channel",
    },
    "unchanged-channel",
    {
      channel: "unchanged-channel",
      ...(options.permission === undefined
        ? {}
        : { permission: options.permission }),
    },
    evidence,
  );
  return createJavaScriptApplicationGraph({
    schema: "JavaScriptApplicationGraph",
    root_node_ids: [module.node_id],
    nodes: [module, channel],
    edges: [
      createJavaScriptApplicationEdge({
        source_node_id: module.node_id,
        target_node_id: channel.node_id,
        relation: options.relation ?? "handles",
        properties: {},
        evidence,
      }),
    ],
    coverage,
    limitations:
      coverage.status === "complete"
        ? []
        : [
            "Controlled incomplete inventory; unobserved relationships remain unknown.",
          ],
  });
};
const compare = (
  left: JavaScriptApplicationGraph,
  right: JavaScriptApplicationGraph,
) =>
  compareJavaScriptApplicationVersions({
    left: {
      evidenceId: `ev_${"1".repeat(64)}`,
      rootArtifactSha256: "a".repeat(64),
      graph: left,
    },
    right: {
      evidenceId: `ev_${"2".repeat(64)}`,
      rootArtifactSha256: "b".repeat(64),
      graph: right,
    },
    leftNativeEvidence: [],
    rightNativeEvidence: [],
  });
const partialCoverage: JavaScriptApplicationGraph["coverage"] = {
  ...completeCoverage,
  status: "partial",
  omitted_count: null,
};

it("keeps relocated exact modules and inferred channels unchanged while retaining both coordinates", () => {
  const left = graph("a".repeat(64), 10, completeCoverage),
    right = graph("b".repeat(64), 50, completeCoverage);
  const result = applicationVersionComparisonResultSchema.parse(
    JSON.parse(JSON.stringify(compare(left, right))),
  );
  expect(result.summary).toEqual({
    unchanged: 2,
    changed: 0,
    added: 0,
    removed: 0,
    unknown: 0,
  });
  expect(result.items).toHaveLength(2);
  for (const item of result.items)
    expect(item).toMatchObject({
      status: "unchanged",
      dimensions: ["location"],
    });
  expect(result.matching).toMatchObject({
    exact_module_source_digest: 1,
    semantic_key: 1,
  });
  expect(result.graph.nodes).toHaveLength(4);
  expect(
    result.graph.nodes.map((node) => node.observations[0]?.evidence.location),
  ).toEqual(
    expect.arrayContaining([
      left.nodes[0]?.observations[0]?.evidence.location,
      right.nodes[0]?.observations[0]?.evidence.location,
    ]),
  );
  expect(
    result.graph.edges.filter((edge) => edge.relation === "changed_from"),
  ).toEqual([]);
});

it.each([false, true])(
  "keeps relocation and uncertain relationships unknown under incomplete coverage (relationship change: %s)",
  (changeRelation) => {
    const result = compare(
      graph("a".repeat(64), 10, completeCoverage),
      graph("b".repeat(64), 50, partialCoverage, {
        relation: changeRelation ? "invokes" : "handles",
      }),
    );
    expect(result.summary).toEqual({
      unchanged: 0,
      changed: 0,
      added: 0,
      removed: 0,
      unknown: 2,
    });
    for (const item of result.items)
      expect(item).toMatchObject({
        status: "unknown",
        dimensions: changeRelation
          ? ["location", "relationships", "coverage"]
          : ["location", "coverage"],
      });
  },
);

it("still classifies complete relationship changes beside relocation as changed", () => {
  const result = compare(
    graph("a".repeat(64), 10, completeCoverage),
    graph("b".repeat(64), 50, completeCoverage, { relation: "invokes" }),
  );
  expect(result.summary.changed).toBe(2);
  for (const item of result.items)
    expect(item.dimensions).toEqual(["location", "relationships"]);
});

it("retains definite content changes under partial coverage alongside relocation", () => {
  const result = compare(
    graph("a".repeat(64), 10, completeCoverage),
    graph("b".repeat(64), 50, partialCoverage, { content: "e".repeat(64) }),
  );
  expect(
    result.items.find((item) => item.node_kind === "javascript-module"),
  ).toMatchObject({
    status: "changed",
    dimensions: ["content", "location", "properties"],
  });
  expect(
    result.items.find((item) => item.node_kind === "ipc-channel")?.status,
  ).toBe("unknown");
});

it("retains definite property changes beside relocation", () => {
  const result = compare(
    graph("a".repeat(64), 10, completeCoverage),
    graph("b".repeat(64), 50, partialCoverage, { permission: "changed" }),
  );
  expect(
    result.items.find((item) => item.node_kind === "ipc-channel"),
  ).toMatchObject({
    status: "changed",
    dimensions: ["location", "properties"],
  });
  expect(
    result.items.find((item) => item.node_kind === "javascript-module")?.status,
  ).toBe("unknown");
});
