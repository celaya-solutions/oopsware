import { useEffect, useState } from "react";
import {
  ArrowLeft,
  FileCode2,
  FileText,
  Folder,
  Play,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { Button } from "../components/ui/button";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../components/ui/tabs";
import { api, pretty, resultValue, runResponseSchema, type Run } from "../api";
import { RunGraphs } from "../graphs/RunGraphs";
import { Report } from "../Report";
import { ReportsTab } from "../reports/ReportsTab";
import { RunReportButtons } from "../reports/RunReportButtons";
import { BookmarksTab, NotesTab, RenamesTab } from "./ProjectItems";
import {
  ProjectConflictReload,
  addProjectTarget,
  editProject,
  getProject,
  planApply,
  type ApplyPlan,
  type Project,
  type ProjectEdit,
  type ProjectTarget,
} from "./projectApi";

const when = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString(undefined, {
        dateStyle: "short",
        timeStyle: "short",
      })
    : "—";

/** One open project: its runs, files, notes, bookmarks and names. */
export function ProjectView({
  project,
  setProject,
  workspace,
  onBack,
  onClose,
  openInResults,
  runTool,
  task,
  fail,
}: {
  project: Project;
  setProject: (project: Project) => void;
  workspace: string;
  onBack: () => void;
  onClose: () => void;
  openInResults: (runId: string) => void;
  runTool: (tool: string, args: Record<string, unknown>) => Promise<Run>;
  task: (label: string, fn: () => Promise<void>) => Promise<void>;
  fail: (message: string) => void;
}) {
  const [tab, setTab] = useState("runs");
  const [title, setTitle] = useState(project.title);
  const [viewing, setViewing] = useState<{ workspace: string; run: Run }>();
  const [description, setDescription] = useState(project.description);
  useEffect(() => setTitle(project.title), [project.title]);
  useEffect(() => setDescription(project.description), [project.description]);

  const save = async (label: string, edit: ProjectEdit) => {
    let saved = false;
    await task(label, async () => {
      try {
        setProject(await editProject(project, edit));
        saved = true;
      } catch (cause) {
        if (cause instanceof ProjectConflictReload) {
          setProject(cause.project);
          fail(cause.message);
          return;
        }
        throw cause;
      }
    });
    return saved;
  };

  return (
    <section
      className="card project-view"
      aria-label={`Project ${project.title}`}
    >
      <div className="project-view-head">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft size={14} /> All projects
        </Button>
        <input
          className="project-title-input"
          aria-label="Project title"
          maxLength={200}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => {
            if (title.trim() && title !== project.title)
              void save("Renaming project", {
                kind: "set_title",
                title: title.trim(),
              });
          }}
        />
        <Button
          variant="ghost"
          size="sm"
          aria-label="Reload project"
          onClick={() =>
            void task("Reloading project", async () =>
              setProject(await getProject(project.id)),
            )
          }
        >
          <RefreshCw size={14} />
        </Button>
        <Button variant="outline" size="sm" onClick={() => setTab("reports")}>
          <FileText size={14} /> Report
        </Button>
        <Button variant="outline" size="sm" onClick={onClose}>
          <X size={14} /> Close project
        </Button>
      </div>
      <textarea
        className="project-description"
        aria-label="Project description"
        placeholder="What is this project about? (optional)"
        rows={2}
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        onBlur={() => {
          if (description !== project.description)
            void save("Saving description", {
              kind: "set_description",
              description,
            });
        }}
      />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList variant="line" aria-label="Project parts">
          <TabsTrigger value="runs">
            Runs <span className="badge">{project.runs.length}</span>
          </TabsTrigger>
          <TabsTrigger value="notes">
            Notes <span className="badge">{project.notes.length}</span>
          </TabsTrigger>
          <TabsTrigger value="bookmarks">
            Bookmarks <span className="badge">{project.bookmarks.length}</span>
          </TabsTrigger>
          <TabsTrigger value="renames">
            Names <span className="badge">{project.renames.length}</span>
          </TabsTrigger>
          <TabsTrigger value="targets">
            Files <span className="badge">{project.targets.length}</span>
          </TabsTrigger>
          <TabsTrigger value="reports">
            Reports <span className="badge">{project.reports.length}</span>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="runs">
          <RunsTab
            project={project}
            setProject={setProject}
            workspace={workspace}
            viewing={viewing}
            setViewing={setViewing}
            openInResults={openInResults}
            task={task}
            fail={fail}
          />
        </TabsContent>
        <TabsContent value="notes">
          <NotesTab project={project} save={save} />
        </TabsContent>
        <TabsContent value="bookmarks">
          <BookmarksTab project={project} save={save} />
        </TabsContent>
        <TabsContent value="renames">
          <RenamesTab project={project} save={save} />
        </TabsContent>
        <TabsContent value="targets">
          <TargetsTab
            project={project}
            setProject={setProject}
            workspace={workspace}
            save={save}
            runTool={runTool}
            task={task}
            fail={fail}
          />
        </TabsContent>
        <TabsContent value="reports">
          <ReportsTab
            project={project}
            setProject={setProject}
            task={task}
            fail={fail}
          />
        </TabsContent>
      </Tabs>
    </section>
  );
}

function RunsTab({
  project,
  setProject,
  workspace,
  viewing,
  setViewing,
  openInResults,
  task,
  fail,
}: {
  project: Project;
  setProject: (project: Project) => void;
  workspace: string;
  viewing: { workspace: string; run: Run } | undefined;
  setViewing: (value: { workspace: string; run: Run } | undefined) => void;
  openInResults: (runId: string) => void;
  task: (label: string, fn: () => Promise<void>) => Promise<void>;
  fail: (message: string) => void;
}) {
  const nameOf = (id: string | null) =>
    project.targets.find((item) => item.id === id)?.name ?? "—";
  if (project.runs.length === 0)
    return (
      <p className="subtle project-empty">
        No runs yet. Tools you run while this project is open are saved here.
      </p>
    );
  return (
    <div className="project-runs">
      <div className="result-table">
        <table>
          <thead>
            <tr>
              <th>Tool</th>
              <th>Status</th>
              <th>File</th>
              <th>Started</th>
            </tr>
          </thead>
          <tbody>
            {[...project.runs].reverse().map((link) => (
              <tr
                key={`${link.workspace_id}/${link.run_id}`}
                className={link.status === "missing" ? "muted" : ""}
              >
                <td>
                  {link.status === "missing" ? (
                    pretty(link.tool)
                  ) : (
                    <button
                      className="link-button"
                      onClick={() =>
                        void task("Loading run", async () => {
                          const reply = await api(
                            `/api/workspace/${link.workspace_id}/runs/${link.run_id}`,
                            undefined,
                            runResponseSchema,
                          );
                          setViewing({
                            workspace: link.workspace_id,
                            run: reply.run,
                          });
                        })
                      }
                    >
                      {pretty(link.tool)}
                    </button>
                  )}
                </td>
                <td>
                  {link.status === "missing"
                    ? "Run archive not found"
                    : link.status}
                </td>
                <td>{nameOf(link.target_id)}</td>
                <td>{when(link.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {viewing && (
        <div className="project-run-view">
          <div className="project-view-head">
            <strong>{pretty(viewing.run.tool)}</strong>
            <span className="subtle">{viewing.run.status}</span>
            <span className="inline-actions">
              <RunReportButtons
                workspace={viewing.workspace}
                runId={viewing.run.id}
                disabled={
                  viewing.run.status === "queued" ||
                  viewing.run.status === "running"
                }
                task={task}
                fail={fail}
              />
            </span>
            {viewing.workspace === workspace && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => openInResults(viewing.run.id)}
              >
                Open in Results
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              aria-label="Close run"
              onClick={() => setViewing(undefined)}
            >
              <X size={14} />
            </Button>
          </div>
          <RunGraphs
            key={`${viewing.workspace}/${viewing.run.id}`}
            tool={viewing.run.tool}
            value={resultValue(viewing.run)}
            project={project}
            setProject={setProject}
          />
          <Report value={resultValue(viewing.run)} />
        </div>
      )}
    </div>
  );
}

function TargetsTab({
  project,
  setProject,
  workspace,
  save,
  runTool,
  task,
  fail,
}: {
  project: Project;
  setProject: (project: Project) => void;
  workspace: string;
  save: (label: string, edit: ProjectEdit) => void;
  runTool: (tool: string, args: Record<string, unknown>) => Promise<Run>;
  task: (label: string, fn: () => Promise<void>) => Promise<void>;
  fail: (message: string) => void;
}) {
  const [path, setPath] = useState("");
  const [plan, setPlan] = useState<{
    target: ProjectTarget;
    plan: ApplyPlan;
  }>();
  const apply = (current: { target: ProjectTarget; plan: ApplyPlan }) =>
    void task("Applying to the open session", async () => {
      if (!current.plan.ok) return;
      const failures: string[] = [];
      for (const call of current.plan.calls)
        await runTool(call.tool, call.arguments).catch((cause: unknown) =>
          failures.push(cause instanceof Error ? cause.message : String(cause)),
        );
      setPlan(undefined);
      setProject(await getProject(project.id));
      if (failures.length)
        fail(`${failures.length} change(s) did not hold: ${failures[0]}`);
    });
  return (
    <div className="project-items">
      <form
        className="project-add project-add-row"
        onSubmit={(event) => {
          event.preventDefault();
          if (!path.trim()) return;
          void task("Adding file", async () => {
            setProject(await addProjectTarget(project, path.trim()));
            setPath("");
          });
        }}
      >
        <input
          aria-label="File or folder path"
          placeholder="Add a file or folder by path…"
          value={path}
          onChange={(event) => setPath(event.target.value)}
        />
        <Button type="submit" size="sm" disabled={!path.trim()}>
          <Upload size={14} /> Add file
        </Button>
      </form>
      {project.targets.length === 0 && <p className="subtle">No files yet.</p>}
      <ul className="project-item-list">
        {project.targets.map((target) => (
          <li key={target.id} className="project-item">
            <div className="project-item-head">
              {target.kind === "file" ? (
                <FileCode2 size={14} />
              ) : (
                <Folder size={14} />
              )}
              <strong>{target.name}</strong>
              {target.format && <span className="badge">{target.format}</span>}
            </div>
            <code className="project-path">{target.path}</code>
            <small className="subtle">
              SHA-256{" "}
              {target.sha256 ?? "unknown (folders and bundles are not hashed)"}
            </small>
            <div className="project-item-actions">
              {target.sha256 && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!workspace}
                  onClick={() =>
                    void task("Checking the open session", async () =>
                      setPlan({
                        target,
                        plan: await planApply(
                          project,
                          target.sha256 ?? "",
                          workspace,
                        ),
                      }),
                    )
                  }
                >
                  <Play size={14} /> Apply to session
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Remove ${target.name}`}
                onClick={() =>
                  save("Removing file", {
                    kind: "remove_target",
                    id: target.id,
                  })
                }
              >
                <Trash2 size={14} />
              </Button>
            </div>
            {plan?.target.id === target.id && (
              <ApplyPanel
                plan={plan.plan}
                onApply={() => apply(plan)}
                onCancel={() => setPlan(undefined)}
              />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ApplyPanel({
  plan,
  onApply,
  onCancel,
}: {
  plan: ApplyPlan;
  onApply: () => void;
  onCancel: () => void;
}) {
  if (!plan.ok)
    return (
      <div className="project-apply caution" role="status">
        <p>{plan.reason}</p>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          OK
        </Button>
      </div>
    );
  const count = (tool: string) =>
    plan.calls
      .filter((call) => call.tool === tool)
      .reduce(
        (sum, call) =>
          sum +
          (tool === "set_addresses_names" &&
          typeof call.arguments.names === "object" &&
          call.arguments.names !== null
            ? Object.keys(call.arguments.names).length
            : 1),
        0,
      );
  const names = count("set_addresses_names");
  const comments = count("set_comment") + count("set_inline_comment");
  const bookmarks = count("set_bookmark");
  return (
    <div className="project-apply" role="status">
      <p>
        {plan.calls.length === 0
          ? "Nothing in this project to put back for this file."
          : `Put back ${names} name${names === 1 ? "" : "s"}, ${comments} comment${comments === 1 ? "" : "s"} and ${bookmarks} bookmark${bookmarks === 1 ? "" : "s"}.`}
      </p>
      {plan.skipped.map((item) => (
        <p key={item.kind} className="subtle">
          Skipping {item.count}: {item.reason}
        </p>
      ))}
      <div className="project-item-actions">
        <Button size="sm" disabled={plan.calls.length === 0} onClick={onApply}>
          Apply
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
