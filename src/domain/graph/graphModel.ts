/**
 * One graph shape for every graph-producing tool, so the dashboard and
 * reports draw them the same way. Pure data: no DOM, no Node.
 */

/** A JSON value as stored in a run result. */
export type GraphJson =
  | string
  | number
  | boolean
  | null
  | GraphJson[]
  | { [key: string]: GraphJson };

export interface GraphNode {
  readonly id: string;
  readonly label: string;
  readonly kind: string;
  /** Provider address text, kept as given. */
  readonly address: string | null;
  readonly symbol: string | null;
  /** Facts shown in the node panel, verbatim from the source. */
  readonly details: Readonly<Record<string, GraphJson>>;
}

export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly relation: string;
  /** A candidate the tool did not confirm (drawn dashed). */
  readonly candidate: boolean;
}

export interface NormalizedGraph {
  /** Tool that produced the graph, and a short title for the picker. */
  readonly tool: string;
  readonly title: string;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly roots: readonly string[];
  /** The source's own coverage value, unchanged (null when it has none). */
  readonly coverage: GraphJson;
  readonly limitations: readonly string[];
  readonly evidence_ids: readonly string[];
  /** Items the source listed but the picture does not draw, with why. */
  readonly not_drawn: readonly {
    readonly label: string;
    readonly reason: string;
  }[];
}

/** Fixed caption shown above every graph picture (spec B.9). */
export const GRAPH_CAPTION =
  "Edges show what the tool observed. A missing edge is not proof that no call or link exists.";

/** Most nodes drawn at once (spec B.5). */
export const GRAPH_DRAW_LIMIT = 300;
