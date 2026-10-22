import type { NormalizedGraph } from "../../../src/domain/graph/graphModel";
import type { GraphView } from "../../../src/domain/graph/graphView";

/** The drawn nodes and edges as tables: the keyboard and narrow-screen path. */
export function GraphList({
  graph,
  view,
  selected,
  onSelect,
}: {
  graph: NormalizedGraph;
  view: GraphView;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const label = new Map(graph.nodes.map((node) => [node.id, node.label]));
  return (
    <div className="graph-list">
      <div className="result-table">
        <table>
          <caption>Nodes ({view.nodes.length})</caption>
          <thead>
            <tr>
              <th>Label</th>
              <th>Kind</th>
              <th>Address</th>
            </tr>
          </thead>
          <tbody>
            {view.nodes.map((node) => (
              <tr key={node.id} aria-selected={node.id === selected}>
                <td>
                  <button
                    className="link-button"
                    onClick={() => onSelect(node.id)}
                  >
                    {node.label}
                  </button>
                </td>
                <td>{node.kind}</td>
                <td className="mono">{node.address ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="result-table">
        <table>
          <caption>Edges ({view.edges.length})</caption>
          <thead>
            <tr>
              <th>From</th>
              <th>Relation</th>
              <th>To</th>
            </tr>
          </thead>
          <tbody>
            {view.edges.map((edge, i) => (
              <tr key={i}>
                <td>{label.get(edge.from) ?? edge.from}</td>
                <td>
                  {edge.relation}
                  {edge.candidate && " (candidate)"}
                </td>
                <td>{label.get(edge.to) ?? edge.to}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
