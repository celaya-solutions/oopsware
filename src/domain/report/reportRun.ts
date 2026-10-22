import { extractGraphs } from "../graph/graphAdapters.js";
import { layoutGraph } from "../graph/graphLayout.js";
import type { GraphJson } from "../graph/graphModel.js";
import { renderGraphSvg } from "../graph/graphSvg.js";
import { DEFAULT_GRAPH_VIEW, selectGraphView } from "../graph/graphView.js";
import type { ProjectRunRecord } from "../project/annotationCapture.js";
import {
  collectLimits,
  isEvidenceEnvelope,
  isLimitField,
  type LimitItem,
} from "./reportLimits.js";

/** A stored run as a report reads it; `WebToolRun` satisfies it structurally. */
export interface ReportRunRecord extends ProjectRunRecord {
  readonly startedAt?: string | undefined;
  readonly error?: string | undefined;
}

/** One run picked for a report, with what its project link says about it. */
export interface ReportRun {
  readonly workspace_id: string;
  readonly run_id: string;
  readonly tool: string;
  /** Record status, or the link's when the record is gone ("missing"). */
  readonly status: string;
  /** Null when the run archive could not be found. */
  readonly record: ReportRunRecord | null;
  /** Where the full run record lives on this machine. */
  readonly archivePath: string;
  /** Why the project could not copy this run's file or changes, if it could not. */
  readonly problem: string | null;
}

export interface RunGraphPicture {
  readonly title: string;
  readonly svg: string;
  readonly hiddenNodes: number;
  readonly hiddenEdges: number;
  readonly cut: boolean;
  readonly notDrawn: readonly { label: string; reason: string }[];
}

/** Everything a findings block shows, read from the stored record only. */
export interface RunFindings {
  readonly value: GraphJson;
  readonly isError: boolean;
  readonly target: string | null;
  readonly headline: readonly (readonly [string, GraphJson])[];
  readonly headlineOmitted: number;
  readonly graphs: readonly RunGraphPicture[];
  readonly limits: readonly LimitItem[];
  readonly sweepStoppedAfter: number | null;
  readonly evidence: readonly {
    id: string;
    provider: string | null;
    version: string | null;
  }[];
}

const HEADLINE_FACTS = 40;

const isObject = (
  value: GraphJson | undefined,
): value is { [key: string]: GraphJson } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isScalar = (value: GraphJson) =>
  value === null || typeof value !== "object";

/** The value the dashboard shows for a run: structured content, else its text, else the error. */
export function deliveredValue(record: ReportRunRecord): {
  value: GraphJson;
  isError: boolean;
} {
  const result = record.result as
    | { structuredContent?: unknown; content?: unknown; isError?: boolean }
    | undefined;
  if (!result || typeof result !== "object")
    return { value: record.error ?? null, isError: record.error !== undefined };
  const isError = result.isError === true;
  if (isObject(result.structuredContent as GraphJson))
    return { value: result.structuredContent as GraphJson, isError };
  const text = Array.isArray(result.content)
    ? result.content
        .filter(
          (item): item is { type: string; text: unknown } =>
            isObject(item as GraphJson) &&
            (item as { type?: unknown }).type === "text",
        )
        .map((item) => String(item.text))
        .join("\n")
    : "";
  return { value: text || (record.error ?? null), isError };
}

/** Top-level scalar facts of the normalized result; envelope fields are not findings. */
function headlineFacts(value: GraphJson) {
  const base = isEvidenceEnvelope(value)
    ? (value.normalized_result ?? null)
    : value;
  if (isScalar(base)) return { facts: [["result", base] as const], omitted: 0 };
  if (!isObject(base)) return { facts: [], omitted: 0 };
  const facts = Object.entries(base).filter(
    ([key, item]) => isScalar(item) && !isLimitField(key),
  );
  return {
    facts: facts.slice(0, HEADLINE_FACTS),
    omitted: Math.max(0, facts.length - HEADLINE_FACTS),
  };
}

function evidenceIds(value: GraphJson) {
  if (!isEvidenceEnvelope(value)) return [];
  const provider = isObject(value.provider) ? value.provider : {};
  return [
    {
      id: String(value.evidence_id),
      provider: typeof provider.name === "string" ? provider.name : null,
      version: typeof provider.version === "string" ? provider.version : null,
    },
  ];
}

/** The run's target as stored: Evidence subject path, else the declared path. */
function runTarget(record: ReportRunRecord, value: GraphJson): string | null {
  if (isEvidenceEnvelope(value) && isObject(value.subject)) {
    const path = value.subject.local_path;
    if (typeof path === "string") return path;
  }
  return record.targetPath ?? null;
}

/** Read one stored run into the facts its findings block shows. */
export function runFindings(record: ReportRunRecord, key: string): RunFindings {
  const { value, isError } = deliveredValue(record);
  const { facts, omitted } = isError
    ? { facts: [], omitted: 0 }
    : headlineFacts(value);
  const limits = collectLimits(value);
  const graphs = isError
    ? []
    : extractGraphs(record.tool, value).map((graph, i) => {
        const view = selectGraphView(graph, DEFAULT_GRAPH_VIEW);
        return {
          title: graph.title,
          svg: renderGraphSvg(
            graph.title,
            view,
            layoutGraph(view.nodes, view.edges),
            { idPrefix: `${key}-g${i}` },
          ),
          hiddenNodes: view.hiddenNodes,
          hiddenEdges: view.hiddenEdges,
          cut: view.cut,
          notDrawn: graph.not_drawn,
        };
      });
  return {
    value,
    isError,
    target: runTarget(record, value),
    headline: facts,
    headlineOmitted: omitted,
    graphs,
    limits: limits.items,
    sweepStoppedAfter: limits.stoppedAfter,
    evidence: evidenceIds(value),
  };
}
