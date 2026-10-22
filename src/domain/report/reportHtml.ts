import { GRAPH_CAPTION, type GraphJson } from "../graph/graphModel.js";
import type {
  Anchor,
  ProjectBookmark,
  ProjectNote,
  ProjectRename,
} from "../project/projectSchema.js";
import {
  runFindings,
  type ReportRun,
  type ReportRunRecord,
  type RunFindings,
} from "./reportRun.js";

/**
 * Builds one self-contained report page: inline CSS, no script, no remote
 * fetch, a strict CSP. Every value is escaped. Runs are added one at a time
 * so a large project never holds every record at once.
 */

export type TargetCheck =
  | "same"
  | "changed"
  | "missing"
  | "not_hashed"
  | "unreadable";

export interface ReportTarget {
  readonly name: string;
  readonly path: string;
  readonly kind: string;
  readonly size: number | null;
  readonly sha256: string | null;
  readonly format: string | null;
  readonly check: TargetCheck;
  readonly currentSha256: string | null;
}

export interface ReportHeader {
  readonly title: string;
  readonly description: string;
  readonly generatedAt: string;
  readonly version: string;
  readonly format: "html" | "pdf";
  /** Only a PDF may leave the appendix out. */
  readonly includeAppendix: boolean;
  /** Linked completed runs the analyst left unticked. */
  readonly leftOut: number;
}

export interface ReportAnnotations {
  readonly notes: readonly ProjectNote[];
  readonly bookmarks: readonly ProjectBookmark[];
  readonly renames: readonly ProjectRename[];
}

/** Per-run appendix cap (spec C.2.7) and a whole-report ceiling for memory. */
export const APPENDIX_RUN_BYTES = 4 * 1024 * 1024;
export const APPENDIX_TOTAL_BYTES = 128 * 1024 * 1024;
// One limit value is shown up to this size; the appendix keeps the rest.
const LIMIT_VALUE_BYTES = 64 * 1024;
const INPUT_BYTES = 64 * 1024;

const BIDI = /[\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/** Escape untrusted text for HTML; hidden direction marks become U+FFFD. */
export const escapeHtml = (value: string) =>
  value
    .replace(BIDI, "\ufffd")
    // eslint-disable-next-line no-control-regex -- C0 controls are hidden in reports
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "\ufffd")
    .replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c]!,
    );

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Cut text to a byte budget; reports how many bytes were left out. */
export function capBytes(
  text: string,
  max: number,
): { text: string; omitted: number } {
  const bytes = encoder.encode(text);
  if (bytes.length <= max) return { text, omitted: 0 };
  return {
    text: decoder.decode(bytes.subarray(0, max)),
    omitted: bytes.length - max,
  };
}

const pretty = (value: unknown) => JSON.stringify(value, null, 2) ?? "null";
const scalar = (value: GraphJson) =>
  typeof value === "string" ? value : JSON.stringify(value);
const bytesLabel = (n: number) => `${n.toLocaleString("en-US")} bytes`;

const CSS = `
:root{color-scheme:light}
body{margin:0;background:#fff;color:#1c1917;font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:28px;margin:0 0 4px}h2{font-size:20px;margin:40px 0 8px;border-bottom:2px solid #e7e5e4;padding-bottom:4px}
h3{font-size:16px;margin:24px 0 6px}
.meta{color:#57534e}.mono,code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px}
pre{white-space:pre-wrap;word-break:break-word;background:#fafaf9;border:1px solid #e7e5e4;padding:8px;margin:4px 0}
table{border-collapse:collapse;width:100%;margin:6px 0}th,td{border:1px solid #e7e5e4;padding:4px 6px;text-align:left;vertical-align:top;overflow-wrap:break-word}
code,pre{overflow-wrap:anywhere}
th{background:#f5f5f4;font-weight:600}
.run{border:1px solid #d6d3d1;border-radius:6px;padding:4px 14px 12px;margin:16px 0;break-inside:auto}
.limits{background:#fff7ed;border:1px solid #fdba74;border-radius:6px;padding:6px 12px;margin:10px 0}
.status-failed,.status-cancelled,.status-missing,.check-changed,.check-missing,.check-unreadable{color:#b91c1c;font-weight:600}
.graph{overflow:auto;border:1px solid #e7e5e4;margin:6px 0}.graph svg{max-width:100%;height:auto}
.note{color:#57534e;font-size:13px}
details summary{cursor:pointer;font-weight:600}
@media screen and (max-width:760px){table{display:block;overflow-x:auto}.run{padding:4px 8px 10px}}
@media print{main{max-width:none;padding:0}.run{break-inside:auto}h2{break-after:avoid}.graph{overflow:visible}}
`;

interface CollectedLimit {
  readonly source: string;
  readonly anchor: string | null;
  readonly what: string;
  readonly value: string;
  readonly how: string;
}

const anchorText = (anchor: Anchor | null): string => {
  if (!anchor) return "Project";
  const where = anchor.location;
  const place = !where
    ? "Whole file"
    : where.kind === "address"
      ? `Address ${where.address}`
      : where.kind === "symbol"
        ? `Symbol ${where.symbol}`
        : where.kind === "member_path"
          ? `Member ${where.path}`
          : where.kind === "graph_node"
            ? `Graph node ${where.label}`
            : `Run ${where.run_id}`;
  return anchor.target_sha256
    ? `${place} · file ${anchor.target_sha256.slice(0, 12)}`
    : place;
};

const CHECK_TEXT: Record<TargetCheck, string> = {
  same: "Same as when added",
  changed: "Changed since it was added",
  missing: "Missing at report time",
  not_hashed: "Not rechecked (folder, bundle or never hashed)",
  unreadable: "Could not be read at report time",
};

const table = (head: readonly string[], rows: readonly string[][]) =>
  `<table><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows
    .map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`)
    .join("")}</tbody></table>`;

type Limit = (what: string, value: string, how: string) => void;

function runTable(
  label: string,
  run: ReportRun,
  record: ReportRunRecord,
  target: string | null,
) {
  const started = record.startedAt ?? record.createdAt;
  const duration =
    record.completedAt === undefined
      ? Number.NaN
      : Date.parse(record.completedAt) - Date.parse(started);
  return table(
    ["Field", "Value"],
    [
      ["Tool", escapeHtml(label)],
      ["Target", target ? `<code>${escapeHtml(target)}</code>` : "None stated"],
      [
        "Status",
        `<span class="status-${escapeHtml(run.status)}">${escapeHtml(run.status)}</span>`,
      ],
      ["Created", escapeHtml(record.createdAt)],
      ["Completed", escapeHtml(record.completedAt ?? "Not completed")],
      [
        "Duration",
        Number.isNaN(duration)
          ? "Unknown"
          : `${(duration / 1000).toFixed(2)} s`,
      ],
      ["Run id", `<code>${escapeHtml(run.run_id)}</code>`],
    ],
  );
}

function inputsHtml(record: ReportRunRecord) {
  const inputs = capBytes(pretty(record.arguments), INPUT_BYTES);
  return [
    `<p><strong>Inputs as stored</strong></p><pre>${escapeHtml(inputs.text)}</pre>`,
    inputs.omitted
      ? `<p class="note">${bytesLabel(inputs.omitted)} of inputs not shown here.</p>`
      : "",
    record.error
      ? `<p><strong>Error</strong></p><pre>${escapeHtml(record.error)}</pre>`
      : "",
  ].join("");
}

function headlineHtml(findings: RunFindings) {
  if (findings.headline.length === 0) return "";
  return [
    `<p><strong>Headline facts</strong> <span class="note">(top-level values the tool returned, verbatim)</span></p>`,
    table(
      ["Field", "Value"],
      findings.headline.map(([key, value]) => [
        `<code>${escapeHtml(key)}</code>`,
        escapeHtml(capBytes(scalar(value), 2048).text),
      ]),
    ),
    findings.headlineOmitted
      ? `<p class="note">${findings.headlineOmitted} more top-level values are in the appendix.</p>`
      : "",
  ].join("");
}

/** Each graph picture with its caption; anything not drawn is also a limit. */
function graphsHtml(findings: RunFindings, limit: Limit) {
  const parts: string[] = [];
  for (const graph of findings.graphs) {
    parts.push(
      `<p><strong>${escapeHtml(graph.title)}</strong></p><p class="note">${escapeHtml(GRAPH_CAPTION)}</p><div class="graph">${graph.svg}</div>`,
    );
    if (graph.cut || graph.hiddenNodes > 0 || graph.hiddenEdges > 0) {
      const text = `${graph.hiddenNodes} nodes and ${graph.hiddenEdges} edges of "${graph.title}" are not drawn${graph.cut ? " (drawing limit reached)" : ""}. Hidden is not absent.`;
      parts.push(`<p class="note">${escapeHtml(text)}</p>`);
      limit("Graph not fully drawn", text, "graph view");
    }
    for (const item of graph.notDrawn)
      limit(
        `Not drawn in "${graph.title}"`,
        `${item.label}: ${item.reason}`,
        "graph view",
      );
  }
  return parts.join("");
}

/** The run's own limits box; each item also goes to the collected section. */
function ownLimitsHtml(findings: RunFindings, limit: Limit) {
  const own: string[] = [];
  for (const item of findings.limits) {
    const shown = capBytes(pretty(item.value), LIMIT_VALUE_BYTES);
    const value = shown.omitted
      ? `${shown.text}\n\u2026 ${bytesLabel(shown.omitted)} more in the appendix`
      : shown.text;
    const how =
      item.how === "evidence" ? "Evidence envelope" : "collected by field name";
    limit(item.path, value, how);
    own.push(
      `<p><code>${escapeHtml(item.path)}</code> <span class="note">${how}</span></p><pre>${escapeHtml(value)}</pre>`,
    );
  }
  if (findings.sweepStoppedAfter !== null) {
    const text = `The limit sweep stopped after ${findings.sweepStoppedAfter.toLocaleString("en-US")} values; the rest of this result was not searched.`;
    limit("Limit sweep", text, "collected by field name");
    own.push(`<p>${escapeHtml(text)}</p>`);
  }
  return `<div class="limits"><p><strong>Limits, unknowns and coverage for this run</strong></p>${
    own.length
      ? own.join("")
      : "<p>This run's result names none. That is not proof it has none.</p>"
  }</div>`;
}

function evidenceHtml(findings: RunFindings) {
  if (findings.evidence.length === 0) return "";
  return `<p><strong>Evidence</strong></p>${table(
    ["Evidence id", "Provider", "Version"],
    findings.evidence.map((item) => [
      `<code>${escapeHtml(item.id)}</code>`,
      escapeHtml(item.provider ?? "Unknown"),
      escapeHtml(item.version ?? "Unknown"),
    ]),
  )}`;
}

function targetsHtml(targets: readonly ReportTarget[]) {
  return targets.length
    ? table(
        ["Name", "Path", "Size", "SHA-256", "Format", "Check at report time"],
        targets.map((t) => [
          escapeHtml(t.name),
          `<code>${escapeHtml(t.path)}</code>`,
          t.size === null ? "Unknown" : bytesLabel(t.size),
          t.sha256 ? `<code>${t.sha256}</code>` : "Not hashed",
          escapeHtml(t.format ?? "Unknown"),
          `<span class="check-${t.check}">${CHECK_TEXT[t.check]}</span>${
            t.check === "changed" && t.currentSha256
              ? `<br><code>${t.currentSha256}</code>`
              : ""
          }`,
        ]),
      )
    : "<p>No files are recorded.</p>";
}

function annotationsHtml({ notes, bookmarks, renames }: ReportAnnotations) {
  return [
    `<h3>Notes (${notes.length})</h3>`,
    notes.length
      ? table(
          ["Note", "Kind", "Anchor", "Updated"],
          notes.map((note) => [
            `<pre>${escapeHtml(note.text)}</pre>`,
            escapeHtml(note.kind),
            escapeHtml(anchorText(note.anchor)),
            escapeHtml(note.updatedAt),
          ]),
        )
      : "<p>None.</p>",
    `<h3>Bookmarks (${bookmarks.length})</h3>`,
    bookmarks.length
      ? table(
          ["Label", "Anchor", "Updated"],
          bookmarks.map((mark) => [
            escapeHtml(mark.label),
            escapeHtml(anchorText(mark.anchor)),
            escapeHtml(mark.updatedAt),
          ]),
        )
      : "<p>None.</p>",
    `<h3>Renames (${renames.length})</h3>`,
    renames.length
      ? table(
          ["Address", "Name", "File", "Updated"],
          renames.map((item) => [
            `<code>${escapeHtml(item.address)}</code>`,
            escapeHtml(item.name),
            `<code>${item.target_sha256.slice(0, 12)}</code>`,
            escapeHtml(item.updatedAt),
          ]),
        )
      : "<p>None.</p>",
  ].join("");
}

/** Accumulates a report run by run, then returns the finished page. */
export class ReportBuilder {
  readonly #runs: string[] = [];
  readonly #appendix: string[] = [];
  readonly #limits: CollectedLimit[] = [];
  readonly #statuses = new Map<string, number>();
  readonly #tools = new Map<string, number>();
  #appendixBytes = 0;
  #count = 0;

  constructor(
    private readonly header: ReportHeader,
    private readonly targets: readonly ReportTarget[],
    private readonly annotations: ReportAnnotations,
    private readonly toolTitle: (tool: string) => string | null,
  ) {
    for (const target of targets)
      if (target.check !== "same")
        this.#limits.push({
          source: "Targets",
          anchor: "targets",
          what: target.name,
          value: CHECK_TEXT[target.check],
          how: "target check",
        });
  }

  #label(tool: string) {
    const title = this.toolTitle(tool);
    return title ? `${title} (${tool})` : tool;
  }

  /** A linked run that is not in the findings: failed, cancelled and missing ones still count as limits. */
  addUnselected(run: ReportRun) {
    if (!["failed", "cancelled", "missing"].includes(run.status)) return;
    this.#limits.push({
      source: `Not included: ${this.#label(run.tool)}`,
      anchor: null,
      what: `Run ${run.run_id}`,
      value:
        run.status === "missing"
          ? "Its run record is missing."
          : `The run ${run.status}${run.record?.error ? `: ${run.record.error}` : "."}`,
      how: "run status",
    });
  }

  /** Add one picked run's findings block and appendix entry. */
  addRun(run: ReportRun) {
    const n = ++this.#count;
    const id = `run-${n}`;
    const label = this.#label(run.tool);
    const source = `Run ${n} · ${label}`;
    this.#statuses.set(run.status, (this.#statuses.get(run.status) ?? 0) + 1);
    this.#tools.set(run.tool, (this.#tools.get(run.tool) ?? 0) + 1);
    const limit = (what: string, value: string, how: string) =>
      this.#limits.push({ source, anchor: id, what, value, how });
    if (run.status === "failed" || run.status === "cancelled")
      limit("Run status", `The run ${run.status}.`, "run status");
    if (run.problem) limit("Project copy", run.problem, "run status");
    const parts: string[] = [
      `<section class="run" id="${id}"><h3>Run ${n}: ${escapeHtml(label)}</h3>`,
    ];
    if (!run.record) {
      limit(
        "Run record",
        "The run record is missing; nothing from it is shown.",
        "archive",
      );
      parts.push(
        `<p class="status-missing">The run record is missing. Expected at <code>${escapeHtml(run.archivePath)}</code>.</p></section>`,
      );
      this.#runs.push(parts.join(""));
      return;
    }
    const record = run.record;
    const findings = runFindings(record, id);
    if (findings.isError)
      limit(
        "Tool error",
        "The tool returned an error; no findings are shown.",
        "run status",
      );
    parts.push(
      runTable(label, run, record, findings.target),
      inputsHtml(record),
      headlineHtml(findings),
      graphsHtml(findings, limit),
      ownLimitsHtml(findings, limit),
      evidenceHtml(findings),
    );
    parts.push(`</section>`);
    this.#runs.push(parts.join(""));
    this.#addAppendix(n, label, run, record.result ?? record.error ?? null);
  }

  #addAppendix(n: number, label: string, run: ReportRun, stored: unknown) {
    if (this.header.format === "pdf" && !this.header.includeAppendix) return;
    const room = Math.max(0, APPENDIX_TOTAL_BYTES - this.#appendixBytes);
    const full = pretty(stored);
    const shown = capBytes(full, Math.min(APPENDIX_RUN_BYTES, room));
    this.#appendixBytes += encoder.encode(shown.text).length;
    const omitted = shown.omitted
      ? `<p class="note">${bytesLabel(shown.omitted)} left out here. The full record is at <code>${escapeHtml(run.archivePath)}</code>.</p>`
      : "";
    this.#appendix.push(
      `<details><summary>Run ${n}: ${escapeHtml(label)}</summary>${omitted}<pre>${escapeHtml(shown.text)}</pre></details>`,
    );
  }

  /** The finished page. */
  html(): string {
    const { header } = this;
    const runCount = [...this.#statuses.values()].reduce((a, b) => a + b, 0);
    const appendixNote =
      header.format === "pdf" && !header.includeAppendix
        ? "<p><strong>This PDF leaves out the JSON appendix.</strong> The HTML report carries each run's complete stored result.</p>"
        : "";
    const cover = `<header><h1>${escapeHtml(header.title)}</h1>
<p class="meta">Generated ${escapeHtml(header.generatedAt)} by Oopsware ${escapeHtml(header.version)}.</p>
${header.description ? `<pre>${escapeHtml(header.description)}</pre>` : ""}
<p class="meta">This report shows only what the runs delivered, with what they could not establish. It adds no analysis.</p>
${appendixNote}${
      header.leftOut
        ? `<p>${header.leftOut} completed linked run${header.leftOut === 1 ? " was" : "s were"} left out of this report by choice.</p>`
        : ""
    }</header>`;
    const targets = targetsHtml(this.targets);
    const summary = `<p>${runCount} run${runCount === 1 ? "" : "s"} in this report: ${
      [...this.#statuses].map(([s, c]) => `${c} ${escapeHtml(s)}`).join(", ") ||
      "none"
    }.</p>${table(
      ["Tool", "Runs"],
      [...this.#tools].map(([tool, c]) => [
        escapeHtml(this.#label(tool)),
        String(c),
      ]),
    )}<p><a href="#limits">${this.#limits.length} limit${this.#limits.length === 1 ? "" : "s"}</a> collected below.</p>`;
    const annotations = annotationsHtml(this.annotations);
    const limits = this.#limits.length
      ? table(
          ["Where", "What", "Detail", "How it was found"],
          this.#limits.map((item) => [
            item.anchor
              ? `<a href="#${item.anchor}">${escapeHtml(item.source)}</a>`
              : escapeHtml(item.source),
            `<code>${escapeHtml(item.what)}</code>`,
            `<pre>${escapeHtml(item.value)}</pre>`,
            escapeHtml(item.how),
          ]),
        )
      : "<p>No run, file or result in this report names a limit. That is not proof there are none.</p>";
    const appendix =
      header.format === "pdf" && !header.includeAppendix
        ? "<p>Left out of this PDF.</p>"
        : this.#appendix.join("") || "<p>No runs.</p>";
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(header.title)}</title><style>${CSS}</style></head>
<body><main>${cover}
<h2 id="targets">Targets</h2>${targets}
<h2>Summary</h2>${summary}
<h2>Notes, bookmarks and renames</h2>${annotations}
<h2>Findings</h2>${this.#runs.join("\n") || "<p>No runs were picked.</p>"}
<h2 id="limits">What this report could not establish</h2>${limits}
<h2>Appendix: stored results</h2>${appendix}
</main></body></html>`;
  }
}
