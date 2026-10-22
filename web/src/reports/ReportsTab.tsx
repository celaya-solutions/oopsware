import { useEffect, useRef, useState } from "react";
import { Download, ExternalLink, FileText, Trash2 } from "lucide-react";
import { pretty } from "../api";
import { Button } from "../components/ui/button";
import { ProjectRequestError, type Project } from "../projects/projectApi";
import {
  buildProjectReport,
  deleteReport,
  downloadReport,
  openReport,
  pdfStatus,
  type PdfStatus,
  type ReportFormat,
} from "./reportApi";

const key = (link: { workspace_id: string; run_id: string }) =>
  `${link.workspace_id}/${link.run_id}`;
const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    dateStyle: "short",
    timeStyle: "short",
  });
const size = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** Build a whole-project report and keep the saved ones. */
export function ReportsTab({
  project,
  setProject,
  task,
  fail,
}: {
  project: Project;
  setProject: (project: Project) => void;
  task: (label: string, fn: () => Promise<void>) => Promise<void>;
  fail: (message: string) => void;
}) {
  const completed = project.runs.filter((link) => link.status === "completed");
  const [picked, setPicked] = useState(
    () => new Set(completed.map((link) => key(link))),
  );
  const [format, setFormat] = useState<ReportFormat>("html");
  const [appendix, setAppendix] = useState(false);
  const [pdf, setPdf] = useState<PdfStatus>();
  useEffect(() => {
    void pdfStatus()
      .then(setPdf)
      .catch(() =>
        setPdf({ available: false, reason: "PDF status could not be read." }),
      );
  }, []);
  // Runs that complete later start ticked; an untick by the analyst stays.
  const seen = useRef(new Set(completed.map((link) => key(link))));
  useEffect(() => {
    const fresh = project.runs
      .filter((link) => link.status === "completed")
      .map((link) => key(link))
      .filter((id) => !seen.current.has(id));
    if (fresh.length === 0) return;
    for (const id of fresh) seen.current.add(id);
    setPicked((current) => new Set([...current, ...fresh]));
  }, [project.runs]);

  const toggle = (id: string) =>
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const build = () =>
    task(
      format === "pdf" ? "Printing PDF report" : "Building report",
      async () => {
        try {
          setProject(
            await buildProjectReport(project, {
              format,
              includeAppendix: format === "pdf" && appendix,
              runs: project.runs
                .filter((link) => picked.has(key(link)))
                .map(({ workspace_id, run_id }) => ({ workspace_id, run_id })),
            }),
          );
        } catch (cause) {
          if (cause instanceof ProjectRequestError) fail(cause.message);
          else throw cause;
        }
      },
    );

  return (
    <div className="report-tab">
      <fieldset className="report-build">
        <legend>New report</legend>
        <p className="subtle">
          A report shows only what the runs delivered, with every limit they
          name. Failed, cancelled and missing runs are always listed among the
          limits.
        </p>
        {project.runs.length === 0 ? (
          <p className="subtle">
            No runs yet; the report will list notes, bookmarks, names and files.
          </p>
        ) : (
          <RunPicker runs={project.runs} picked={picked} toggle={toggle} />
        )}
        <div className="report-format" role="radiogroup" aria-label="Format">
          <label>
            <input
              type="radio"
              name="report-format"
              checked={format === "html"}
              onChange={() => setFormat("html")}
            />
            HTML (one file, with every stored result)
          </label>
          <label>
            <input
              type="radio"
              name="report-format"
              checked={format === "pdf"}
              disabled={pdf?.available !== true}
              onChange={() => setFormat("pdf")}
            />
            PDF
          </label>
          {format === "pdf" && (
            <label>
              <input
                type="checkbox"
                checked={appendix}
                onChange={(event) => setAppendix(event.target.checked)}
              />
              Include the JSON appendix
            </label>
          )}
        </div>
        {pdf && !pdf.available && <p className="subtle">{pdf.reason}</p>}
        <div>
          <Button size="sm" onClick={() => void build()}>
            <FileText size={14} /> Build report
          </Button>
        </div>
      </fieldset>
      <SavedReports
        project={project}
        setProject={setProject}
        task={task}
        fail={fail}
      />
    </div>
  );
}

const unusable = (status: string) =>
  status === "failed" || status === "cancelled" || status === "missing";

function RunPicker({
  runs,
  picked,
  toggle,
}: {
  runs: Project["runs"];
  picked: ReadonlySet<string>;
  toggle: (id: string) => void;
}) {
  return (
    <ul className="report-runs">
      {runs.map((link) => (
        <li key={key(link)}>
          <label>
            <input
              type="checkbox"
              checked={picked.has(key(link))}
              disabled={link.status === "missing"}
              onChange={() => toggle(key(link))}
            />
            <span>{pretty(link.tool)}</span>
            <span className="subtle">
              {unusable(link.status)
                ? `${link.status}, listed among the limits`
                : link.status}{" "}
              · {when(link.createdAt)}
            </span>
          </label>
        </li>
      ))}
    </ul>
  );
}

function SavedReports({
  project,
  setProject,
  task,
  fail,
}: {
  project: Project;
  setProject: (project: Project) => void;
  task: (label: string, fn: () => Promise<void>) => Promise<void>;
  fail: (message: string) => void;
}) {
  return (
    <>
      <h3 className="report-saved-title">Saved reports</h3>
      {project.reports.length === 0 ? (
        <p className="subtle">None yet.</p>
      ) : (
        <ul className="report-saved">
          {[...project.reports].reverse().map((report) => (
            <li key={report.id}>
              <span>
                {report.format.toUpperCase()} · {when(report.createdAt)} ·{" "}
                {report.run_ids.length} run
                {report.run_ids.length === 1 ? "" : "s"} · {size(report.bytes)}
              </span>
              <span className="report-actions">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void task("Opening report", () =>
                      openReport(project, report.id),
                    )
                  }
                >
                  <ExternalLink size={14} /> Open
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void task("Downloading report", () =>
                      downloadReport(project, report.id),
                    )
                  }
                >
                  <Download size={14} /> Download
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="Delete report"
                  onClick={() =>
                    void task("Deleting report", async () => {
                      try {
                        setProject(await deleteReport(project, report.id));
                      } catch (cause) {
                        if (cause instanceof ProjectRequestError)
                          fail(cause.message);
                        else throw cause;
                      }
                    })
                  }
                >
                  <Trash2 size={14} />
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
