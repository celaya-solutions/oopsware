import { useMemo, useState } from "react";
import { ArrowDownToLine, List, Network } from "lucide-react";
import { extractGraphs } from "../../../src/domain/graph/graphAdapters";
import { layoutGraph } from "../../../src/domain/graph/graphLayout";
import {
  GRAPH_CAPTION,
  GRAPH_DRAW_LIMIT,
  type GraphJson,
  type NormalizedGraph,
} from "../../../src/domain/graph/graphModel";
import { renderGraphSvg } from "../../../src/domain/graph/graphSvg";
import {
  DEFAULT_GRAPH_VIEW,
  findGraphNodes,
  selectGraphView,
  type GraphDirection,
  type GraphView,
  type GraphViewOptions,
} from "../../../src/domain/graph/graphView";
import { Button } from "../components/ui/button";
import type { Json } from "../api";
import type { Project } from "../projects/projectApi";
import { GraphCanvas } from "./GraphCanvas";
import { GraphList } from "./GraphList";
import { GraphNodePanel } from "./GraphNodePanel";

/** The run's graphs, if its result holds any; nothing otherwise. */
export function RunGraphs({
  tool,
  value,
  project,
  setProject,
}: {
  tool: string;
  value: Json;
  project: Project | null;
  setProject: (project: Project) => void;
}) {
  const graphs = useMemo(
    () => extractGraphs(tool, value as GraphJson),
    [tool, value],
  );
  const [index, setIndex] = useState(0);
  const graph = graphs[Math.min(index, graphs.length - 1)];
  if (!graph) return null;
  return (
    <section className="report-section run-graphs" aria-label="Graph">
      <h3>
        <Network size={15} /> Graph
        {graphs.length > 1 && (
          <select
            aria-label="Choose graph"
            value={index}
            onChange={(event) => setIndex(Number(event.target.value))}
          >
            {graphs.map((item, i) => (
              <option key={i} value={i}>
                {item.title}
              </option>
            ))}
          </select>
        )}
      </h3>
      <GraphBody
        key={`${tool}-${index}`}
        graph={graph}
        subject={subjectSha(value)}
        project={project}
        setProject={setProject}
      />
    </section>
  );
}

const subjectSha = (value: Json): string | null => {
  const subject =
    typeof value === "object" && value && !Array.isArray(value)
      ? value.subject
      : null;
  const digest =
    typeof subject === "object" && subject && !Array.isArray(subject)
      ? subject.digest
      : null;
  const sha =
    typeof digest === "object" && digest && !Array.isArray(digest)
      ? digest.sha256
      : null;
  return typeof sha === "string" ? sha : null;
};

/** Every cause that hid something in this view. */
function hiddenBy(view: GraphView): string {
  const causes = [
    ...(view.filtered ? ["the kind or relation filters"] : []),
    ...(view.root !== null ? ["the focus"] : []),
    ...(view.cut ? [`the ${GRAPH_DRAW_LIMIT}-node draw limit`] : []),
  ];
  // A node only reachable from nothing drawn is still hidden by the view itself.
  return causes.length ? causes.join(" and ") : "the view";
}

const narrow = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(max-width: 640px)").matches;

function GraphBody({
  graph,
  subject,
  project,
  setProject,
}: {
  graph: NormalizedGraph;
  subject: string | null;
  project: Project | null;
  setProject: (project: Project) => void;
}) {
  const [options, setOptions] = useState<GraphViewOptions>(DEFAULT_GRAPH_VIEW);
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<"picture" | "list">(
    narrow() ? "list" : "picture",
  );
  const [query, setQuery] = useState("");
  const view = useMemo(() => selectGraphView(graph, options), [graph, options]);
  const layout = useMemo(() => layoutGraph(view.nodes, view.edges), [view]);
  const svg = useMemo(
    () => renderGraphSvg(graph.title, view, layout, { selected }),
    [graph.title, view, layout, selected],
  );
  const kinds = useMemo(
    () => [...new Set(graph.nodes.map((n) => n.kind))],
    [graph],
  );
  const relations = useMemo(
    () => [...new Set(graph.edges.map((e) => e.relation))],
    [graph],
  );
  const matches = useMemo(
    () => findGraphNodes(graph, query, 12),
    [graph, query],
  );
  const node = graph.nodes.find((item) => item.id === selected) ?? null;
  const focus = (root: string | null) => setOptions((o) => ({ ...o, root }));
  const toggle = (key: "hiddenKinds" | "hiddenRelations", item: string) =>
    setOptions((o) => ({
      ...o,
      [key]: o[key].includes(item)
        ? o[key].filter((x) => x !== item)
        : [...o[key], item],
    }));

  return (
    <div className="graph-body">
      <p className="graph-caption">{GRAPH_CAPTION}</p>
      <p
        className={
          view.hiddenNodes || view.hiddenEdges
            ? "graph-hidden caution"
            : "graph-hidden"
        }
      >
        Showing {view.nodes.length} of {graph.nodes.length} nodes and{" "}
        {view.edges.length} of {graph.edges.length} edges.
        {(view.hiddenNodes > 0 || view.hiddenEdges > 0) &&
          ` ${view.hiddenNodes} nodes and ${view.hiddenEdges} edges are hidden by ${hiddenBy(view)}, not absent.`}
      </p>
      {(graph.limitations.length > 0 || graph.not_drawn.length > 0) && (
        <div className="report-section caution graph-limits">
          <strong>Limits the tool reported</strong>
          <ul>
            {graph.limitations.map((line, i) => (
              <li key={`l${i}`}>{line}</li>
            ))}
            {graph.not_drawn.map((item, i) => (
              <li key={`n${i}`}>
                {item.label}: {item.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      {graph.coverage !== null && (
        <details className="graph-coverage">
          <summary>Coverage as reported</summary>
          <pre>{JSON.stringify(graph.coverage, null, 2)}</pre>
        </details>
      )}
      <div className="graph-toolbar">
        <label className="graph-search">
          <span className="sr-only">Find a node</span>
          <input
            type="search"
            placeholder="Find a node by label or address"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label>
          Depth
          <select
            value={options.depth}
            onChange={(event) =>
              setOptions((o) => ({ ...o, depth: Number(event.target.value) }))
            }
          >
            {[1, 2, 3, 4, 5].map((d) => (
              <option key={d}>{d}</option>
            ))}
          </select>
        </label>
        <label>
          Direction
          <select
            value={options.direction}
            onChange={(event) =>
              setOptions((o) => ({
                ...o,
                direction: event.target.value as GraphDirection,
              }))
            }
          >
            <option value="both">Callers and callees</option>
            <option value="callees">Callees (outgoing)</option>
            <option value="callers">Callers (incoming)</option>
          </select>
        </label>
        {options.root !== null && (
          <Button size="sm" variant="outline" onClick={() => focus(null)}>
            Show whole graph
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={() => setMode(mode === "picture" ? "list" : "picture")}
        >
          {mode === "picture" ? <List /> : <Network />}
          {mode === "picture" ? "List" : "Picture"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            const a = document.createElement("a");
            a.href = URL.createObjectURL(
              new Blob([svg], { type: "image/svg+xml" }),
            );
            a.download = `${graph.tool}-graph.svg`;
            a.click();
          }}
        >
          <ArrowDownToLine /> Download SVG
        </Button>
      </div>
      {matches.length > 0 && (
        <ul className="graph-matches" aria-label="Matching nodes">
          {matches.map((match) => (
            <li key={match.id}>
              <button
                className="link-button"
                onClick={() => {
                  setSelected(match.id);
                  focus(match.id);
                }}
              >
                {match.label} <span className="subtle">{match.kind}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <details className="graph-filters">
        <summary>Filter kinds and relations</summary>
        <fieldset>
          <legend>Node kinds</legend>
          {kinds.map((kind) => (
            <label key={kind}>
              <input
                type="checkbox"
                checked={!options.hiddenKinds.includes(kind)}
                onChange={() => toggle("hiddenKinds", kind)}
              />
              {kind}
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend>Edge relations</legend>
          {relations.map((relation) => (
            <label key={relation}>
              <input
                type="checkbox"
                checked={!options.hiddenRelations.includes(relation)}
                onChange={() => toggle("hiddenRelations", relation)}
              />
              {relation}
            </label>
          ))}
        </fieldset>
      </details>
      {view.root !== null && (
        <p className="subtle">
          Focused on{" "}
          {graph.nodes.find((n) => n.id === view.root)?.label ?? view.root},{" "}
          {options.depth} step(s), {options.direction}.
        </p>
      )}
      <div className="graph-main">
        {mode === "picture" ? (
          <GraphCanvas
            svg={svg}
            width={layout.width}
            height={layout.height}
            onSelect={setSelected}
          />
        ) : (
          <GraphList
            graph={graph}
            view={view}
            selected={selected}
            onSelect={setSelected}
          />
        )}
        {node && (
          <GraphNodePanel
            key={node.id}
            node={node}
            graph={graph}
            subject={subject}
            project={project}
            setProject={setProject}
            onFocus={() => focus(node.id)}
            onClose={() => setSelected(null)}
          />
        )}
      </div>
    </div>
  );
}
