import type {
  GraphEdge,
  GraphJson,
  GraphNode,
  NormalizedGraph,
} from "./graphModel.js";

/**
 * Turns a stored run result into the graphs it holds. Native call tools are
 * chosen by tool name, never by guessing key names; the JavaScript application
 * graph is found by its named schema anywhere in the result. A result that is
 * not the expected shape yields no graph rather than a guessed one.
 */
export function extractGraphs(
  tool: string,
  result: GraphJson,
): NormalizedGraph[] {
  if (!isObject(result) || "error" in result) return [];
  const envelope = evidenceEnvelope(result);
  const adapter = NATIVE_ADAPTERS[tool];
  const native = adapter ? adapter(envelope) : null;
  const application = findApplicationGraphs(result).map((graph, i, all) =>
    applicationGraph(tool, graph, envelope, all.length > 1 ? i + 1 : null),
  );
  return [...(native ? [native] : []), ...application];
}

type JsonObject = { [key: string]: GraphJson };

interface Envelope {
  readonly normalized: GraphJson;
  readonly parameters: JsonObject;
  readonly limitations: string[];
  readonly coverage: GraphJson;
  readonly evidenceIds: string[];
}

const isObject = (value: GraphJson | undefined): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const list = (value: GraphJson | undefined): GraphJson[] =>
  Array.isArray(value) ? value : [];
const text = (value: GraphJson | undefined): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;
const texts = (value: GraphJson | undefined): string[] =>
  list(value).flatMap((item) => text(item) ?? []);

/** Reads the Evidence envelope; a bare result is its own normalized value. */
function evidenceEnvelope(result: JsonObject): Envelope {
  const evidence = "normalized_result" in result;
  const normalized = evidence ? (result.normalized_result ?? null) : result;
  const inner = isObject(normalized) ? normalized : {};
  return {
    normalized,
    parameters: isObject(result.parameters) ? result.parameters : {},
    limitations: [...texts(inner.limitations), ...texts(result.limitations)],
    coverage: result.relationship_coverage ?? null,
    evidenceIds: unique([
      ...(text(result.evidence_id) ? [text(result.evidence_id)!] : []),
      ...texts(inner.evidence_links),
      ...texts(inner.source_evidence_ids),
    ]),
  };
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/** Collects nodes and de-duplicated edges in first-seen order. */
class GraphBuilder {
  readonly nodes = new Map<string, GraphNode>();
  readonly edges = new Map<string, GraphEdge>();

  node(id: string, fields: Partial<Omit<GraphNode, "id">> = {}): string {
    const known = this.nodes.get(id);
    this.nodes.set(id, {
      id,
      label: fields.label ?? known?.label ?? id,
      kind: fields.kind ?? known?.kind ?? "procedure",
      address: fields.address ?? known?.address ?? null,
      symbol: fields.symbol ?? known?.symbol ?? null,
      details: { ...known?.details, ...fields.details },
    });
    return id;
  }

  /** Edges whose ends the source never listed as nodes. */
  dangling = 0;

  /** An edge between nodes the source listed; anything else is counted, not invented. */
  listedEdge(from: string, to: string, relation: string) {
    if (this.nodes.has(from) && this.nodes.has(to))
      this.edge(from, to, relation);
    else this.dangling++;
  }

  edge(from: string, to: string, relation: string, candidate = false) {
    this.node(from);
    this.node(to);
    const key = JSON.stringify([from, to, relation]);
    if (!this.edges.has(key))
      this.edges.set(key, { from, to, relation, candidate });
  }

  graph(
    tool: string,
    title: string,
    roots: readonly string[],
    envelope: Envelope,
    extra: Partial<NormalizedGraph> = {},
  ): NormalizedGraph {
    return {
      tool,
      title,
      nodes: [...this.nodes.values()],
      edges: [...this.edges.values()],
      roots: roots.filter((id) => this.nodes.has(id)),
      coverage: envelope.coverage,
      evidence_ids: envelope.evidenceIds,
      not_drawn: [],
      ...extra,
      // The same line often sits on the graph, the result and the envelope.
      limitations: unique([
        ...(extra.limitations ?? envelope.limitations),
        ...(this.dangling
          ? [
              `${this.dangling} edge(s) point at nodes the result does not list; they are not drawn.`,
            ]
          : []),
      ]),
    };
  }
}

const addressNode = (b: GraphBuilder, address: string, details = {}) =>
  b.node(address, { label: address, address, details });

const NATIVE_ADAPTERS: Readonly<
  Record<string, (envelope: Envelope) => NormalizedGraph | null>
> = {
  get_call_graph: callGraph,
  procedure_callers: (e) => directCalls(e, "callers"),
  procedure_callees: (e) => directCalls(e, "callees"),
  trace_call_path: traceCallPath,
  build_call_path: buildCallPath,
  project_android_application_graph: (e) =>
    mobileGraph(e, "project_android_application_graph"),
  project_apple_application_graph: (e) =>
    mobileGraph(e, "project_apple_application_graph"),
  project_harmony_application_graph: (e) =>
    mobileGraph(e, "project_harmony_application_graph"),
};

/** `graph` maps depth to entries; `calls` holds callers when direction is backward. */
function callGraph(envelope: Envelope): NormalizedGraph | null {
  const normalized = envelope.normalized;
  if (!isObject(normalized) || !isObject(normalized.graph)) return null;
  const backward = envelope.parameters.direction === "backward";
  const b = new GraphBuilder();
  const depths = Object.keys(normalized.graph)
    .filter((key) => /^\d+$/.test(key))
    .sort((x, y) => Number(x) - Number(y));
  let partial = 0;
  const roots: string[] = [];
  for (const depth of depths)
    for (const entry of list(normalized.graph[depth])) {
      if (!isObject(entry)) continue;
      const address = text(entry.address);
      if (!address) continue;
      if (depth === depths[0]) roots.push(address);
      const coverage = entry.relationship_coverage ?? null;
      if (isObject(coverage) && coverage.status !== "complete") partial++;
      b.node(address, {
        label: address,
        address,
        kind: entry.status === "error" ? "failed" : "procedure",
        details: {
          depth: Number(depth),
          status: entry.status ?? null,
          relationship_coverage: coverage,
          ...(entry.limitations ? { limitations: entry.limitations } : {}),
          ...(entry.error ? { error: entry.error } : {}),
        },
      });
      for (const call of texts(entry.calls)) {
        addressNode(b, call);
        if (backward) b.edge(call, address, "calls");
        else b.edge(address, call, "calls");
      }
    }
  const limitations = [...envelope.limitations];
  if (partial)
    limitations.push(
      `${partial} node(s) report partial or unknown call coverage; open a node to see its coverage.`,
    );
  return b.graph(
    "get_call_graph",
    backward ? "Call graph (callers)" : "Call graph (callees)",
    roots,
    envelope,
    { limitations },
  );
}

function directCalls(
  envelope: Envelope,
  relation: "callers" | "callees",
): NormalizedGraph | null {
  const procedure = text(envelope.parameters.procedure);
  if (!procedure || !Array.isArray(envelope.normalized)) return null;
  const b = new GraphBuilder();
  addressNode(b, procedure, { queried: true });
  for (const address of texts(envelope.normalized)) {
    addressNode(b, address);
    if (relation === "callees") b.edge(procedure, address, "calls");
    else b.edge(address, procedure, "calls");
  }
  return b.graph(
    `procedure_${relation}`,
    relation === "callees" ? "Direct callees" : "Direct callers",
    [procedure],
    envelope,
  );
}

/** Edges are already in call direction (source calls target). */
function traceCallPath(envelope: Envelope): NormalizedGraph | null {
  const n = envelope.normalized;
  if (!isObject(n) || !Array.isArray(n.nodes)) return null;
  const b = new GraphBuilder();
  const path = new Set(texts(n.traversal_path));
  const failures = new Map(
    list(n.failures).flatMap((failure) =>
      isObject(failure) && text(failure.address)
        ? [[text(failure.address)!, failure.error ?? null] as const]
        : [],
    ),
  );
  const coverage = isObject(n.relationship_coverage)
    ? n.relationship_coverage
    : {};
  for (const node of list(n.nodes)) {
    if (!isObject(node) || !text(node.address)) continue;
    const address = text(node.address)!;
    b.node(address, {
      label: address,
      address,
      kind: failures.has(address)
        ? "failed"
        : address === n.goal
          ? "goal"
          : address === n.start
            ? "start"
            : "procedure",
      details: {
        depth: node.depth ?? null,
        on_shortest_path: path.has(address),
        relationship_coverage: coverage[address] ?? null,
        ...(failures.has(address) ? { error: failures.get(address)! } : {}),
      },
    });
  }
  for (const edge of list(n.edges))
    if (
      isObject(edge) &&
      text(edge.source_address) &&
      text(edge.target_address)
    )
      b.listedEdge(
        text(edge.source_address)!,
        text(edge.target_address)!,
        "calls",
      );
  const limitations = [
    ...envelope.limitations,
    ...texts(n.residual_unknowns).map((line) => `Unknown: ${line}`),
    ...(n.truncated === true
      ? ["The trace stopped before the graph was exhausted (truncated)."]
      : []),
    ...(text(n.goal_status) && n.goal_status !== "not_requested"
      ? [`Goal status: ${String(n.goal_status)}.`]
      : []),
  ];
  return b.graph(
    "trace_call_path",
    "Call path trace",
    texts([n.start ?? null]),
    envelope,
    {
      coverage: n.relationship_coverage ?? envelope.coverage,
      limitations,
    },
  );
}

/** Every shortest path; nodes repeat across paths and are merged by address. */
function buildCallPath(envelope: Envelope): NormalizedGraph | null {
  const n = envelope.normalized;
  if (!isObject(n) || !text(n.start)) return null;
  const b = new GraphBuilder();
  const start = text(n.start)!;
  const goal = text(n.goal);
  addressNode(b, start);
  if (goal) addressNode(b, goal);
  for (const path of list(n.paths)) {
    if (!isObject(path)) continue;
    for (const node of list(path.nodes))
      if (isObject(node) && text(node.address))
        b.node(text(node.address)!, {
          label: text(node.name) ?? text(node.address)!,
          address: text(node.address)!,
          symbol: text(node.name),
          details: { evidence_links: node.evidence_links ?? [] },
        });
    for (const edge of list(path.edges))
      if (isObject(edge) && text(edge.source) && text(edge.target))
        b.edge(text(edge.source)!, text(edge.target)!, "calls");
  }
  b.node(start, { kind: "start" });
  if (goal) b.node(goal, { kind: "goal" });
  const limitations = [...envelope.limitations];
  if (n.status !== "found")
    limitations.push(
      `Path status: ${String(n.status ?? "unknown")}; no path is drawn.`,
    );
  return b.graph("build_call_path", "Call paths", [start], envelope, {
    coverage: {
      status: n.status ?? null,
      explored: n.explored ?? null,
      search_scope: n.search_scope ?? null,
    },
    limitations,
  });
}

/**
 * Containment tree (application → component group → component) plus each
 * bridge candidate as a dashed candidate edge labelled with its basis.
 * Unavailable components are listed, not drawn.
 */
function mobileGraph(envelope: Envelope, tool: string): NormalizedGraph | null {
  const n = envelope.normalized;
  if (!isObject(n) || !isObject(n.components)) return null;
  const b = new GraphBuilder();
  const root = b.node("application", {
    label: `Application (${text(n.root_format) ?? "unknown format"})`,
    kind: "application",
    details: {
      root_sha256: n.root_sha256 ?? null,
      root_format: n.root_format ?? null,
      ...(n.platforms ? { platforms: n.platforms } : {}),
      ...(n.runtime_families ? { runtime_families: n.runtime_families } : {}),
    },
  });
  const byPath = new Map<string, string>();
  for (const [group, members] of Object.entries(n.components)) {
    const items = list(members).filter(isObject);
    if (!items.length) continue;
    const groupId = b.node(`group:${group}`, {
      label: group.replaceAll("_", " "),
      kind: "component group",
      details: { components: items.length },
    });
    b.edge(root, groupId, "contains");
    for (const item of items) {
      const path = text(item.path);
      if (!path) continue;
      const id = b.node(`component:${group}:${path}`, {
        label: path.split("/").at(-1) || path,
        kind: group,
        details: item,
      });
      b.edge(groupId, id, "contains");
      if (!byPath.has(path)) byPath.set(path, id);
    }
  }
  for (const candidate of list(n.bridge_candidates)) {
    if (!isObject(candidate)) continue;
    // Android and Harmony name the managed side `managed_path`; Apple `source_path`.
    const from = text(candidate.managed_path) ?? text(candidate.source_path);
    const to = text(candidate.native_path);
    if (!from || !to) continue;
    const ends = [from, to].map(
      (path) =>
        byPath.get(path) ??
        b.node(`path:${path}`, {
          label: path,
          kind: "path",
          details: { path },
        }),
    );
    b.edge(ends[0]!, ends[1]!, text(candidate.basis) ?? "candidate", true);
  }
  return b.graph(tool, "Application components", [root], envelope, {
    coverage: {
      coverage: n.coverage ?? null,
      bridge_candidate_coverage: n.bridge_candidate_coverage ?? null,
    },
    not_drawn: list(n.unavailable_components).flatMap((item) =>
      isObject(item)
        ? [
            {
              label: text(item.path) ?? "unnamed component",
              reason: "unavailable component (listed by the tool, not drawn)",
            },
          ]
        : [],
    ),
  });
}

/** Objects with the named application-graph schema, anywhere in the result. */
function findApplicationGraphs(result: GraphJson): JsonObject[] {
  const found: JsonObject[] = [];
  const stack: GraphJson[] = [result];
  while (stack.length) {
    const value = stack.pop()!;
    if (Array.isArray(value)) stack.push(...value);
    else if (isObject(value)) {
      if (
        value.schema === "JavaScriptApplicationGraph" &&
        Array.isArray(value.nodes) &&
        Array.isArray(value.edges)
      )
        found.push(value);
      else stack.push(...Object.values(value).reverse());
    }
  }
  return found;
}

function applicationGraph(
  tool: string,
  graph: JsonObject,
  envelope: Envelope,
  number: number | null,
): NormalizedGraph {
  const b = new GraphBuilder();
  for (const node of list(graph.nodes)) {
    if (!isObject(node) || !text(node.node_id)) continue;
    const observations = list(node.observations).filter(isObject);
    const labels = observations.flatMap((o) => text(o.label) ?? []);
    const identity = isObject(node.identity) ? node.identity : {};
    b.node(text(node.node_id)!, {
      label:
        labels[0] ??
        text(identity.path) ??
        text(identity.original_source) ??
        text(node.kind) ??
        "node",
      kind: text(node.kind) ?? "node",
      details: {
        identity,
        labels,
        observations: observations.length,
        evidence_ids: unique(
          observations.flatMap((o) =>
            isObject(o.evidence) ? texts(o.evidence.evidence_ids) : [],
          ),
        ),
        properties: observations[0]?.properties ?? {},
      },
    });
  }
  for (const edge of list(graph.edges))
    if (
      isObject(edge) &&
      text(edge.source_node_id) &&
      text(edge.target_node_id)
    )
      b.listedEdge(
        text(edge.source_node_id)!,
        text(edge.target_node_id)!,
        text(edge.relation) ?? "related",
      );
  return b.graph(
    tool,
    number ? `Application graph ${number}` : "Application graph",
    texts(graph.root_node_ids),
    envelope,
    {
      coverage: graph.coverage ?? null,
      limitations: [...texts(graph.limitations), ...envelope.limitations],
    },
  );
}
