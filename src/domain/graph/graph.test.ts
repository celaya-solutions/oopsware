import { describe, expect, it } from "vitest";

import { callPathResultSchema } from "../callPathSchemas.js";
import { extractGraphs } from "./graphAdapters.js";
import { layoutGraph } from "./graphLayout.js";
import type { GraphEdge, GraphNode, NormalizedGraph } from "./graphModel.js";
import { renderGraphSvg } from "./graphSvg.js";
import {
  DEFAULT_GRAPH_VIEW,
  findGraphNodes,
  selectGraphView,
} from "./graphView.js";

const node = (id: string, kind = "procedure"): GraphNode => ({
  id,
  label: id,
  kind,
  address: id,
  symbol: null,
  details: {},
});
const edge = (from: string, to: string, relation = "calls"): GraphEdge => ({
  from,
  to,
  relation,
  candidate: false,
});
const graphOf = (
  nodes: GraphNode[],
  edges: GraphEdge[],
  roots = [nodes[0]!.id],
): NormalizedGraph => ({
  tool: "get_call_graph",
  title: "Test",
  nodes,
  edges,
  roots,
  coverage: null,
  limitations: [],
  evidence_ids: [],
  not_drawn: [],
});

/** A chain 0 -> 1 -> ... -> n-1 with a back edge to close a cycle. */
const chain = (count: number) =>
  graphOf(
    Array.from({ length: count }, (_, i) => node(`n${i}`)),
    [
      ...Array.from({ length: count - 1 }, (_, i) =>
        edge(`n${i}`, `n${i + 1}`),
      ),
      edge(`n${count - 1}`, "n0"),
    ],
  );

describe("graph layout", () => {
  it("is deterministic and keeps nodes in a layer apart", () => {
    const graph = graphOf(
      ["a", "b", "c", "d", "e"].map((id) => node(id)),
      [
        edge("a", "b"),
        edge("a", "c"),
        edge("b", "d"),
        edge("c", "d"),
        edge("a", "e"),
        edge("d", "a"),
      ],
    );
    const first = layoutGraph(graph.nodes, graph.edges);
    expect(layoutGraph(graph.nodes, graph.edges)).toEqual(first);
    const rows = new Map<number, { x: number; width: number }[]>();
    for (const placed of first.nodes)
      rows.set(placed.y, [...(rows.get(placed.y) ?? []), placed]);
    for (const row of rows.values()) {
      const sorted = row.sort((p, q) => p.x - q.x);
      for (let i = 1; i < sorted.length; i++)
        expect(sorted[i]!.x).toBeGreaterThanOrEqual(
          sorted[i - 1]!.x + sorted[i - 1]!.width,
        );
    }
    // a is above d even though d -> a closes a cycle.
    const y = (id: string) => first.nodes.find((placed) => placed.id === id)!.y;
    expect(y("a")).toBeLessThan(y("d"));
    expect(first.edges).toHaveLength(6);
  });

  it("bends long edges through the layers they cross", () => {
    const graph = graphOf(
      ["a", "b", "c"].map((id) => node(id)),
      [edge("a", "b"), edge("b", "c"), edge("a", "c")],
    );
    const long = layoutGraph(graph.nodes, graph.edges).edges[2]!;
    expect(long.points).toHaveLength(3);
  });

  it("lays out a dense 300-node graph quickly", () => {
    const nodes = Array.from({ length: 300 }, (_, i) => node(`d${i}`));
    // Each node calls three pseudo-random others: long edges and cycles.
    const edges = nodes.flatMap((_, i) =>
      [7, 31, 113].map((step) => edge(`d${i}`, `d${(i * step + 1) % 300}`)),
    );
    const started = performance.now();
    const layout = layoutGraph(nodes, edges);
    expect(performance.now() - started).toBeLessThan(3000);
    expect(layoutGraph(nodes, edges)).toEqual(layout);
  });

  it("lays out 300 nodes quickly", () => {
    const graph = chain(300);
    const started = performance.now();
    const layout = layoutGraph(graph.nodes, graph.edges);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(layout.nodes).toHaveLength(300);
  });
});

describe("graph view", () => {
  it("cuts at the draw limit and counts what is hidden", () => {
    const view = selectGraphView(chain(450), DEFAULT_GRAPH_VIEW);
    expect(view.nodes).toHaveLength(300);
    expect(view.hiddenNodes).toBe(150);
    expect(view.hiddenEdges).toBe(450 - 299);
    expect(view.cut).toBe(true);
  });

  it("focuses by depth and direction", () => {
    const graph = chain(10);
    const callees = selectGraphView(graph, {
      ...DEFAULT_GRAPH_VIEW,
      root: "n5",
      depth: 2,
      direction: "callees",
    });
    expect(callees.nodes.map(({ id }) => id)).toEqual(["n5", "n6", "n7"]);
    const both = selectGraphView(graph, {
      ...DEFAULT_GRAPH_VIEW,
      root: "n5",
      depth: 1,
    });
    expect(both.nodes.map(({ id }) => id)).toEqual(["n4", "n5", "n6"]);
    expect(both.cut).toBe(false);
    expect(both.hiddenNodes).toBe(7);
  });

  it("filters kinds and relations and finds by label", () => {
    const graph = graphOf(
      [node("a"), node("b", "failed"), node("c")],
      [edge("a", "b"), edge("a", "c", "imports")],
    );
    const view = selectGraphView(graph, {
      ...DEFAULT_GRAPH_VIEW,
      hiddenKinds: ["failed"],
      hiddenRelations: ["imports"],
    });
    expect(view.nodes.map(({ id }) => id)).toEqual(["a", "c"]);
    expect(view.edges).toHaveLength(0);
    expect(findGraphNodes(graph, "B").map(({ id }) => id)).toEqual(["b"]);
  });
});

describe("graph SVG", () => {
  it("escapes hostile labels and draws candidates dashed", () => {
    const hostile = { ...node("x"), label: '<script>alert("x")</script>&' };
    const graph = graphOf(
      [node("a"), hostile],
      [{ ...edge("a", "x", "<b>"), candidate: true }],
    );
    const view = selectGraphView(graph, DEFAULT_GRAPH_VIEW);
    const svg = renderGraphSvg(
      'T"<',
      view,
      layoutGraph(view.nodes, view.edges),
    );
    expect(svg).not.toContain("<script");
    expect(svg).not.toContain("<b>");
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).toContain('stroke-dasharray="5 4"');
    expect(svg).toContain('aria-label="T&quot;&lt;"');
  });
});

describe("graph adapters", () => {
  const ev = "ev_" + "a".repeat(64);
  it("merges build_call_path paths by address", () => {
    const result = callPathResultSchema.parse({
      start: "0x1",
      goal: "0x3",
      status: "found",
      shortest_hops: 2,
      explored: { nodes: 4, edges: 4, depth_reached: 2 },
      search_scope: { exhaustive: true },
      evidence_links: [ev],
      limitations: [],
      paths: [
        ["0x1", "0x2", "0x3"],
        ["0x1", "0x4", "0x3"],
      ].map((addresses) => ({
        hops: 2,
        evidence_links: [ev],
        nodes: addresses.map((address) => ({
          address,
          name: address === "0x1" ? "main" : null,
          evidence_links: [ev],
        })),
        edges: addresses.slice(1).map((target, i) => ({
          source: addresses[i]!,
          target,
          evidence_links: [ev],
        })),
      })),
    });
    const [graph] = extractGraphs("build_call_path", {
      evidence_id: ev,
      normalized_result: result,
    });
    expect(
      graph!.nodes.map(({ id, kind, label }) => [id, kind, label]),
    ).toEqual([
      ["0x1", "start", "main"],
      ["0x3", "goal", "0x3"],
      ["0x2", "procedure", "0x2"],
      ["0x4", "procedure", "0x4"],
    ]);
    expect(graph!.edges).toHaveLength(4);
    expect(graph!.evidence_ids).toEqual([ev]);
  });

  it("yields nothing for errors and unknown tools", () => {
    expect(extractGraphs("get_call_graph", { error: { code: "x" } })).toEqual(
      [],
    );
    expect(extractGraphs("list_strings", { normalized_result: ["a"] })).toEqual(
      [],
    );
    expect(
      extractGraphs("get_call_graph", { normalized_result: { graph: [] } }),
    ).toEqual([]);
  });
});

it("lists each limitation once", () => {
  const line = "Parsed as inert text.";
  const [graph] = extractGraphs("analyze_javascript_application", {
    limitations: [line],
    normalized_result: {
      limitations: [line],
      graph: {
        schema: "JavaScriptApplicationGraph",
        root_node_ids: ["jag_node_a"],
        nodes: [
          {
            node_id: "jag_node_a",
            kind: "artifact",
            identity: {},
            observations: [],
          },
        ],
        edges: [],
        coverage: null,
        limitations: [line],
      },
    },
  });
  expect(graph!.limitations).toEqual([line]);
});

describe("review cases", () => {
  it("draws self-loops, handles an empty view and a filtered-out focus", () => {
    const graph = graphOf(
      [node("a"), node("b", "failed")],
      [edge("a", "a"), edge("a", "b")],
    );
    const view = selectGraphView(graph, DEFAULT_GRAPH_VIEW);
    const layout = layoutGraph(view.nodes, view.edges);
    expect(layout.edges.map((placed) => placed.index).sort()).toEqual([0, 1]);
    expect(renderGraphSvg("t", view, layout)).toContain('data-edge-index="0"');

    const empty = layoutGraph([], []);
    expect(empty.height).toBeGreaterThan(0);

    const hiddenRoot = selectGraphView(graph, {
      ...DEFAULT_GRAPH_VIEW,
      root: "b",
      hiddenKinds: ["failed"],
    });
    expect(hiddenRoot.root).toBeNull();
    expect(hiddenRoot.filtered).toBe(true);
  });

  it("strips XML-illegal control characters", () => {
    const view = selectGraphView(
      graphOf([{ ...node("a"), label: "x\u0001y" }], []),
      DEFAULT_GRAPH_VIEW,
    );
    expect(
      renderGraphSvg("t", view, layoutGraph(view.nodes, view.edges)),
    ).not.toContain("\u0001");
  });

  it("counts edges to unlisted nodes instead of inventing nodes", () => {
    const [graph] = extractGraphs("trace_call_path", {
      normalized_result: {
        start: "0x1",
        nodes: [{ address: "0x1", depth: 0 }],
        edges: [{ source_address: "0x1", target_address: "0x9" }],
      },
    });
    expect(graph!.nodes.map(({ id }) => id)).toEqual(["0x1"]);
    expect(graph!.limitations.at(-1)).toMatch(/^1 edge\(s\) point at nodes/);
  });
});
