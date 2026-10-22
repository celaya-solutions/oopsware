import { useState } from "react";
import { Bookmark, Crosshair, StickyNote, X } from "lucide-react";
import type {
  GraphNode,
  NormalizedGraph,
} from "../../../src/domain/graph/graphModel";
import { Button } from "../components/ui/button";
import { JsonView } from "../Report";
import {
  editProject,
  ProjectConflictReload,
  type Anchor,
  type Project,
  type ProjectEdit,
} from "../projects/projectApi";

// Control and direction characters the project store refuses in a line.
const UNSAFE_LINE =
  /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
const line = (value: string, max: number) =>
  value.replace(UNSAFE_LINE, "\uFFFD").slice(0, max);

/** Where a graph node points, for a project note or bookmark (spec A.6, B.6). */
function nodeAnchor(
  node: GraphNode,
  subject: string | null,
  project: Project,
): Anchor {
  const path = node.details.path;
  return {
    target_sha256: subject,
    target_id:
      project.targets.find((t) => subject !== null && t.sha256 === subject)
        ?.id ?? null,
    // Tool text may carry characters the store refuses; they become U+FFFD.
    location:
      node.address && node.address.length <= 200
        ? { kind: "address", address: line(node.address, 200) }
        : node.symbol
          ? { kind: "symbol", symbol: line(node.symbol, 4096) }
          : typeof path === "string" && path
            ? { kind: "member_path", path: line(path, 4096) }
            : node.id.length <= 200
              ? {
                  kind: "graph_node",
                  node_id: line(node.id, 200),
                  label: line(node.label, 4096),
                }
              : null,
  };
}

export function GraphNodePanel({
  node,
  graph,
  subject,
  project,
  setProject,
  onFocus,
  onClose,
}: {
  node: GraphNode;
  graph: NormalizedGraph;
  subject: string | null;
  project: Project | null;
  setProject: (project: Project) => void;
  onFocus: () => void;
  onClose: () => void;
}) {
  const [note, setNote] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const evidence = [
    ...new Set([
      ...(Array.isArray(node.details.evidence_ids)
        ? node.details.evidence_ids.map(String)
        : []),
      ...graph.evidence_ids,
    ]),
  ];

  async function save(label: string, edit: ProjectEdit): Promise<boolean> {
    if (!project) return false;
    setBusy(true);
    setStatus(null);
    try {
      setProject(await editProject(project, edit));
      setStatus(`${label} saved to ${project.title}.`);
      return true;
    } catch (cause) {
      if (cause instanceof ProjectConflictReload) setProject(cause.project);
      setStatus(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const off = project ? null : "Open a project to keep bookmarks and notes.";
  return (
    <aside className="graph-node-panel" aria-label="Selected node">
      <div className="project-view-head">
        <strong>{node.label}</strong>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Close node"
          onClick={onClose}
        >
          <X />
        </Button>
      </div>
      <dl>
        <dt>Kind</dt>
        <dd>{node.kind}</dd>
        {node.address && (
          <>
            <dt>Address</dt>
            <dd className="mono">{node.address}</dd>
          </>
        )}
        {node.symbol && (
          <>
            <dt>Symbol</dt>
            <dd className="mono">{node.symbol}</dd>
          </>
        )}
        <dt>Node id</dt>
        <dd className="mono">{node.id}</dd>
        <dt>Evidence</dt>
        <dd className="mono">
          {evidence.length ? evidence.join(", ") : "none recorded"}
        </dd>
      </dl>
      {Object.keys(node.details).length > 0 && (
        <details>
          <summary>Observations</summary>
          <JsonView value={node.details as never} />
        </details>
      )}
      <div className="graph-node-actions">
        <Button size="sm" variant="outline" onClick={onFocus}>
          <Crosshair /> Focus here
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!project || busy}
          title={off ?? undefined}
          onClick={() =>
            project &&
            save("Bookmark", {
              kind: "add_bookmark",
              label: line(node.label, 200),
              anchor: nodeAnchor(node, subject, project),
            })
          }
        >
          <Bookmark /> Bookmark
        </Button>
      </div>
      <label className="graph-note">
        <span>Note on this node</span>
        <textarea
          rows={3}
          value={note}
          disabled={!project}
          onChange={(event) => setNote(event.target.value)}
        />
      </label>
      <Button
        size="sm"
        variant="outline"
        disabled={!project || busy || !note.trim()}
        title={off ?? undefined}
        onClick={async () => {
          if (
            project &&
            (await save("Note", {
              kind: "add_note",
              text: note,
              anchor: nodeAnchor(node, subject, project),
            }))
          )
            setNote("");
        }}
      >
        <StickyNote /> Add note
      </Button>
      {off && <p className="subtle">{off}</p>}
      {status && (
        <p className="subtle" role="status">
          {status}
        </p>
      )}
    </aside>
  );
}
