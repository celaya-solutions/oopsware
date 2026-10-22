import {
  GRAPH_DRAW_LIMIT,
  type GraphEdge,
  type GraphNode,
  type NormalizedGraph,
} from "./graphModel.js";

export type GraphDirection = "callers" | "callees" | "both";

export interface GraphViewOptions {
  /** Focus node; null shows the whole graph (cut at the limit from the roots). */
  readonly root: string | null;
  /** 1 to 5 hops from the focus node. */
  readonly depth: number;
  readonly direction: GraphDirection;
  /** Node kinds and edge relations left out; empty means none. */
  readonly hiddenKinds: readonly string[];
  readonly hiddenRelations: readonly string[];
  readonly limit?: number;
}

export interface GraphView {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  /** Nodes and edges of the source not drawn in this view. Hidden is not absent. */
  readonly hiddenNodes: number;
  readonly hiddenEdges: number;
  /** True when kind or relation filters left something out. */
  readonly filtered: boolean;
  /** The focus actually used; null when none, or when a filter hid it. */
  readonly root: string | null;
  /** True when the draw limit cut the view. */
  readonly cut: boolean;
}

export const DEFAULT_GRAPH_VIEW: GraphViewOptions = {
  root: null,
  depth: 2,
  direction: "both",
  hiddenKinds: [],
  hiddenRelations: [],
};

/** Picks the nodes and edges to draw. Deterministic: follows source order. */
export function selectGraphView(
  graph: NormalizedGraph,
  options: GraphViewOptions,
): GraphView {
  const limit = options.limit ?? GRAPH_DRAW_LIMIT;
  const kinds = new Set(options.hiddenKinds);
  const relations = new Set(options.hiddenRelations);
  const allowed = new Set(
    graph.nodes.filter((node) => !kinds.has(node.kind)).map((node) => node.id),
  );
  const edges = graph.edges.filter(
    (edge) =>
      !relations.has(edge.relation) &&
      allowed.has(edge.from) &&
      allowed.has(edge.to),
  );
  const out = adjacency(edges, "from", "to");
  const into = adjacency(edges, "to", "from");
  const neighbors = (id: string, direction: GraphDirection) => [
    ...(direction === "callers" ? [] : (out.get(id) ?? [])),
    ...(direction === "callees" ? [] : (into.get(id) ?? [])),
  ];

  const picked = new Set<string>();
  let cut = false;
  const walk = (
    starts: readonly string[],
    depth: number,
    direction: GraphDirection,
  ) => {
    let frontier = starts.filter((id) => allowed.has(id));
    for (let hop = 0; hop <= depth && frontier.length; hop++) {
      const next: string[] = [];
      for (const id of frontier) {
        if (picked.has(id)) continue;
        if (picked.size >= limit) {
          cut = true;
          return;
        }
        picked.add(id);
        next.push(...neighbors(id, direction));
      }
      frontier = next;
    }
  };

  const root =
    options.root !== null && allowed.has(options.root) ? options.root : null;
  if (root !== null) {
    walk([root], clampDepth(options.depth), options.direction);
  } else {
    walk(graph.roots, Number.POSITIVE_INFINITY, "callees");
    walk(
      graph.nodes.map((node) => node.id),
      0,
      "callees",
    );
  }

  const nodes = graph.nodes.filter((node) => picked.has(node.id));
  const drawn = edges.filter(
    (edge) => picked.has(edge.from) && picked.has(edge.to),
  );
  return {
    nodes,
    edges: drawn,
    hiddenNodes: graph.nodes.length - nodes.length,
    hiddenEdges: graph.edges.length - drawn.length,
    filtered:
      allowed.size < graph.nodes.length || edges.length < graph.edges.length,
    root,
    cut,
  };
}

/** Nodes whose label, address or symbol contains the text (case-insensitive). */
export function findGraphNodes(
  graph: NormalizedGraph,
  text: string,
  max = 50,
): GraphNode[] {
  const needle = text.trim().toLowerCase();
  if (!needle) return [];
  return graph.nodes
    .filter((node) =>
      [node.label, node.address, node.symbol].some((value) =>
        value?.toLowerCase().includes(needle),
      ),
    )
    .slice(0, max);
}

const clampDepth = (depth: number) =>
  Math.min(5, Math.max(1, Math.trunc(depth) || 1));

function adjacency(
  edges: readonly GraphEdge[],
  key: "from" | "to",
  other: "from" | "to",
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const edge of edges) {
    const list = map.get(edge[key]);
    if (list) list.push(edge[other]);
    else map.set(edge[key], [edge[other]]);
  }
  return map;
}
