import { z } from "zod";
import { ArrowRight, Box, FileQuestion, Folder, Play } from "lucide-react";
import type { Json } from "./types";

/**
 * The parts of identify_artifact's named result the answer card shows. The
 * contract owns the full schema; unknown fields pass through untouched.
 */
const factSchema = z.object({ label: z.string(), value: z.string() });
const headlineSchema = z.object({
  tool: z.string(),
  title: z.string(),
  facts: z.array(factSchema),
});
const pieceSchema = z.object({
  id: z.string(),
  depth: z.number(),
  path: z.string(),
  name: z.string(),
  kind: z.string(),
  bytes: z.number().nullable(),
  label: z.string().nullable(),
  format_basis: z.string().nullable(),
  name_conflict: z.string().nullable(),
  container: z.object({
    state: z.string(),
    members: z.number().nullable(),
    reason: z.string().nullable(),
  }),
  reader: z.object({
    tool: z.string().nullable(),
    state: z.string(),
    reason: z.string().nullable(),
  }),
  headline: headlineSchema.nullable(),
});
const stepSchema = z.object({
  piece: z.string(),
  tool: z.string(),
  label: z.string(),
  arguments: z.record(z.string(), z.json()),
  requires: z.string().nullable(),
  open_first: z.string().nullable(),
  why: z.string(),
});
export const identificationSchema = z.object({
  operation: z.literal("identify_artifact"),
  normalized_result: z.object({
    subject: z.object({
      path: z.string(),
      kind: z.string(),
      bytes: z.number(),
    }),
    answer: z.object({
      summary: z.string(),
      label: z.string().nullable(),
      headline: headlineSchema.nullable(),
    }),
    formats: z.array(
      z.object({ label: z.string(), count: z.number(), bytes: z.number() }),
    ),
    piece_count: z.number(),
    page: z.object({
      start: z.number(),
      returned: z.number(),
      next: z.number().nullable(),
    }),
    unrecognized_extensions: z.array(
      z.object({ extension: z.string(), count: z.number() }),
    ),
    pieces: z.array(pieceSchema),
    next_steps: z.array(stepSchema),
    coverage: z.object({
      entries_examined: z.number(),
      entry_limit_reached: z.boolean(),
      containers_opened: z.number(),
      readers_run: z.number(),
      spool_limit_reached: z.boolean(),
      unreadable: z.number(),
    }),
  }),
});
export type IdentificationStep = z.infer<typeof stepSchema>;

const size = (n: number | null) =>
  n === null
    ? ""
    : n < 1024
      ? `${n} B`
      : n < 1024 ** 2
        ? `${(n / 1024).toFixed(1)} KiB`
        : n < 1024 ** 3
          ? `${(n / 1024 ** 2).toFixed(1)} MiB`
          : `${(n / 1024 ** 3).toFixed(1)} GiB`;

const pieceNote = (piece: z.infer<typeof pieceSchema>): string | null => {
  if (piece.headline !== null) return piece.headline.title;
  if (piece.name_conflict !== null) return piece.name_conflict;
  if (piece.container.state === "opened")
    return `Opened · ${String(piece.container.members ?? 0)} members`;
  if (piece.container.reason !== null) return piece.container.reason;
  if (piece.reader.state === "failed") return piece.reader.reason;
  return null;
};

type Report = z.infer<typeof identificationSchema>["normalized_result"];
type Piece = z.infer<typeof pieceSchema>;

function Facts({ report }: { report: Report }) {
  const { headline } = report.answer;
  const shown = report.formats.slice(0, 8);
  return (
    <>
      {headline !== null && headline.facts.length > 0 && (
        <dl className="identify-facts">
          {headline.facts.map((fact) => (
            <div key={fact.label}>
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {shown.length > 0 && (
        <div className="identify-formats" aria-label="Files by format">
          {shown.map((format) => (
            <span key={format.label} className="identify-chip">
              {format.label}
              <b>{format.count.toLocaleString()}</b>
            </span>
          ))}
          {report.formats.length > shown.length && (
            <span className="subtle">
              +{report.formats.length - shown.length} more
            </span>
          )}
          {report.unrecognized_extensions.length > 0 && (
            <span className="subtle">
              Unrecognized by name:{" "}
              {report.unrecognized_extensions
                .map(
                  ({ extension, count }) =>
                    `${extension === "" ? "no extension" : extension} ${count.toLocaleString()}`,
                )
                .join(" · ")}
            </span>
          )}
        </div>
      )}
    </>
  );
}

function Steps({
  steps,
  busy,
  onStep,
}: {
  steps: readonly IdentificationStep[];
  busy: boolean;
  onStep: (step: IdentificationStep) => void;
}) {
  if (steps.length === 0) return null;
  return (
    <div className="identify-steps">
      <h3>Next steps</h3>
      {steps.map((step, index) => (
        <div
          className="identify-step"
          key={`${step.piece}-${step.tool}-${String(index)}`}
        >
          <div>
            <strong>{step.label}</strong>{" "}
            <code className="mono">{step.tool}</code>
            <p>{step.why}</p>
            {step.requires !== null && (
              <p className="identify-requires">Needs: {step.requires}</p>
            )}
          </div>
          <button
            disabled={busy}
            onClick={() => onStep(step)}
            aria-label={`${step.label} with ${step.tool}`}
          >
            {step.requires === null || step.open_first !== null ? (
              <>
                <Play size={14} /> Run
              </>
            ) : (
              <>
                Open <ArrowRight size={14} />
              </>
            )}
          </button>
        </div>
      ))}
    </div>
  );
}

function PieceRow({ piece }: { piece: Piece }) {
  const note = pieceNote(piece);
  return (
    <li
      style={{
        paddingLeft: `${String(Math.min(piece.depth, 6) * 14 + 8)}px`,
      }}
    >
      {piece.kind === "directory" ? (
        <Folder size={13} />
      ) : piece.container.state === "opened" ? (
        <Box size={13} />
      ) : piece.label === null ? (
        <FileQuestion size={13} />
      ) : null}
      <span className="identify-name" title={piece.path}>
        {piece.name}
      </span>
      <span className="subtle">
        {piece.kind === "file" ? (piece.label ?? "Unrecognized") : piece.kind}
        {piece.format_basis === "name" ? " (from the name)" : ""}
        {piece.bytes === null ? "" : ` · ${size(piece.bytes)}`}
      </span>
      {note !== null && <span className="identify-note">{note}</span>}
    </li>
  );
}

function Pieces({
  report,
  busy,
  onPage,
}: {
  report: Report;
  busy: boolean;
  onPage: (start: number) => void;
}) {
  if (!report.pieces.some((piece) => piece.path !== "")) return null;
  return (
    <div className="identify-pieces">
      <h3>
        Inside{" "}
        <span className="badge">{report.piece_count.toLocaleString()}</span>
      </h3>
      <ul>
        {report.pieces
          .filter((piece) => piece.path !== "")
          .map((piece) => (
            <PieceRow key={piece.id} piece={piece} />
          ))}
      </ul>
      {report.page.next !== null && (
        <p className="subtle identify-pager">
          Showing {(report.page.start + 1).toLocaleString()}–
          {(report.page.start + report.page.returned).toLocaleString()} of{" "}
          {report.piece_count.toLocaleString()} pieces.{" "}
          <button
            disabled={busy}
            onClick={() => {
              if (report.page.next !== null) onPage(report.page.next);
            }}
          >
            Next page <ArrowRight size={14} />
          </button>
        </p>
      )}
    </div>
  );
}

function Coverage({ coverage }: { coverage: Report["coverage"] }) {
  return (
    <p className="subtle identify-coverage">
      Examined {coverage.entries_examined.toLocaleString()} entries ·{" "}
      {coverage.containers_opened} containers opened · {coverage.readers_run}{" "}
      readers run
      {coverage.unreadable > 0
        ? ` · ${String(coverage.unreadable)} unreadable`
        : ""}
      {coverage.entry_limit_reached ? " · stopped at max_entries" : ""}
      {coverage.spool_limit_reached
        ? " · some pieces too large to copy out"
        : ""}
    </p>
  );
}

/** The "What is this?" answer: summary first, then next steps, then what is inside. */
export function IdentificationCard({
  value,
  busy,
  onStep,
  onPage,
}: {
  value: Json;
  busy: boolean;
  onStep: (step: IdentificationStep) => void;
  onPage: (path: string, start: number) => void;
}) {
  const parsed = identificationSchema.safeParse(value);
  if (!parsed.success) return null;
  const report = parsed.data.normalized_result;
  return (
    <section className="identify-card" aria-label="What is this?">
      <p className="identify-summary">{report.answer.summary}</p>
      <Facts report={report} />
      <Steps steps={report.next_steps} busy={busy} onStep={onStep} />
      <Pieces
        report={report}
        busy={busy}
        onPage={(start) => onPage(report.subject.path, start)}
      />
      <Coverage coverage={report.coverage} />
    </section>
  );
}
