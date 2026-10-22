import { claimWorkspace, ownWorkspace, mergeRuns } from "./workspaceState";
import {
  objectSchema,
  jsonSchema,
  workspaceSchema,
  summaryResponseSchema,
  toolsSchema,
  runResponseSchema,
  targetSchema,
  browseSchema,
} from "./api";
import { Chat } from "./Chat";
import { OllamaAccount } from "./OllamaAccount";
import { ModelLibrary } from "./ModelLibrary";
import { JsonView, Report } from "./Report";
import { ProjectsPage } from "./projects/ProjectsPage";
import { ProjectView } from "./projects/ProjectView";
import { RunGraphs } from "./graphs/RunGraphs";
import { RunReportButtons } from "./reports/RunReportButtons";
import {
  addProjectTarget,
  getProject,
  type Project,
} from "./projects/projectApi";
import { IdentificationCard, type IdentificationStep } from "./Identification";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  Box,
  Braces,
  ChevronRight,
  CircleHelp,
  Cpu,
  FileCode2,
  FileText,
  Files,
  FolderKanban,
  Folder,
  FolderOpen,
  GitCompareArrows,
  HardDrive,
  History,
  Layers3,
  Moon,
  Play,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  PanelRight,
  Square,
  Sun,
  Terminal,
  Upload,
  X,
  Zap,
} from "lucide-react";
import {
  api,
  category,
  download,
  object,
  pretty,
  resultValue,
  token,
  type Json,
  type Obj,
  type Run,
  type RunSummary,
  type Target,
  type Tool,
} from "./api";
import { SchemaField } from "./SchemaForm";
import { Maintenance } from "./Maintenance";
import { Button } from "./components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "./components/ui/dialog";
import { FileSupport } from "./components/FileSupport";
import { targetArguments, targetSupport } from "./targetSupport";
import { Hint, HelpHint, HintProvider } from "./components/Hint";
import "@fontsource-variable/geist-mono/wght.css";
import "./styles.css";
const sections = [
  { name: "Workspace", icon: Layers3 },
  { name: "Tools", icon: Braces },
  { name: "Runs", icon: Activity },
  { name: "Evidence", icon: Files },
  { name: "Compare", icon: GitCompareArrows },
  { name: "Connections", icon: Cpu },
  { name: "Settings", icon: Settings2 },
];
const bytes = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1048576
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1048576).toFixed(1)} MB`;
const active = (r: { status: string }) =>
  r.status === "running" || r.status === "queued";
function IconButton({
  children,
  label,
  onClick,
  disabled = false,
}: {
  children: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Hint content={label}>
      <button
        className="icon-button"
        aria-label={label}
        onClick={onClick}
        disabled={disabled}
      >
        {children}
      </button>
    </Hint>
  );
}
function App() {
  const [workspaceTab, setWorkspaceTab] = useState("preview");
  const [openProject, setOpenProjectState] = useState<Project | null>(null);
  const [projectList, setProjectList] = useState(false);
  function setOpenProject(project: Project | null) {
    setOpenProjectState(project);
    if (project) sessionStorage.setItem("rea-open-project", project.id);
    else sessionStorage.removeItem("rea-open-project");
  }
  useEffect(() => {
    const saved = sessionStorage.getItem("rea-open-project");
    if (saved)
      getProject(saved)
        .then(setOpenProjectState)
        .catch(() => sessionStorage.removeItem("rea-open-project"));
  }, []);
  const [showOpener, setShowOpener] = useState(false);
  const [dragging, setDragging] = useState(false);
  const drafts = useRef(
    new Map<string, { input: Obj; raw: string; error: string }>(),
  );
  function showWorkspace(tab: string) {
    setPage("Workspace");
    setWorkspaceTab(tab);
  }
  const [session, setSession] = useState<Obj | null>(null);
  const [leftPath, setLeftPath] = useState(""),
    [rightPath, setRightPath] = useState("");
  const [page, setPage] = useState("Workspace"),
    [tools, setTools] = useState<Tool[]>([]),
    [workspace, setWorkspace] = useState(""),
    [runs, setRuns] = useState<RunSummary[]>([]),
    [nextCursor, setNextCursor] = useState<string | null>(null),
    [historyTotal, setHistoryTotal] = useState(0),
    [historyLoading, setHistoryLoading] = useState(false),
    [detail, setDetail] = useState<{ workspace: string; run: Run }>(),
    [detailError, setDetailError] = useState(""),
    [targets, setTargets] = useState<Target[]>([]),
    [target, setTarget] = useState<Target>(),
    [selectedRun, setSelectedRun] = useState<string>(),
    [selectedTool, setSelectedTool] = useState<Tool>(),
    [args, setArgs] = useState<Obj>({}),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(""),
    [query, setQuery] = useState(""),
    [filter, setFilter] = useState("All tools"),
    [command, setCommand] = useState(false),
    [assistant, setAssistant] = useState(false),
    [preview, setPreview] = useState("Text"),
    [theme, setTheme] = useState(localStorage.getItem("rea-theme") ?? "dark"),
    [status, setStatus] = useState<Obj>({}),
    [path, setPath] = useState(""),
    [browser, setBrowser] = useState<{
      path: string;
      parent: string;
      entries: {
        name: string;
        path: string;
        directory: boolean;
        application: boolean;
      }[];
      offset: number;
      total: number;
      nextOffset: number | null;
    }>(),
    [browserOpen, setBrowserOpen] = useState(false),
    [jsonMode, setJsonMode] = useState(false),
    [raw, setRaw] = useState("{}"),
    [jsonError, setJsonError] = useState("");
  const upload = useRef<HTMLInputElement>(null);
  const sessionRun = useRef("");
  const selectedSummary = runs.find((r) => r.id === selectedRun);
  const run =
    detail?.workspace === workspace && detail.run.id === selectedRun
      ? detail.run
      : undefined;
  const selection = useRef(selectedRun);
  selection.current = selectedRun;
  const current = useRef({ workspace, runs });
  current.current = { workspace, runs };
  const fail = (e: unknown) =>
    setError(e instanceof Error ? e.message : String(e));
  const task = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError("");
    try {
      await fn();
    } catch (e) {
      fail(e);
    } finally {
      setBusy("");
    }
  };
  const refreshStatus = async () =>
    setStatus(await api("/api/status", undefined, objectSchema));
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem("rea-theme", theme);
  }, [theme]);
  useEffect(() => {
    let releaseOwnership = () => {};
    void task("Connecting workspace", async () => {
      const ownership = await claimWorkspace(
        sessionStorage.getItem("rea-workspace"),
      );
      const id = ownership.id;
      releaseOwnership = ownership.close;
      let w;
      try {
        w = await api("/api/workspace", id ? { id } : {}, workspaceSchema);
      } catch (e) {
        if (!String(e).includes("not found")) throw e;
        w = await api("/api/workspace", {}, workspaceSchema);
      }
      sessionStorage.setItem("rea-workspace", w.id);
      if (w.id !== id) {
        releaseOwnership();
        releaseOwnership = ownWorkspace(w.id);
      }
      current.current = { workspace: w.id, runs: w.runs };
      setWorkspace(w.id);
      setRuns(mergeRuns([], w.runs));
      setNextCursor(w.nextCursor);
      setHistoryTotal(w.total);
      setTools((await api("/api/tools", undefined, toolsSchema)).tools);
      await refreshStatus();
      await refreshSession(w.id);
      const savedPath = sessionStorage.getItem("rea-target-path");
      if (savedPath) {
        const restored = await api(
          "/api/open",
          { path: savedPath },
          targetSchema,
        );
        add(restored);
      }
    });
    return () => releaseOwnership();
  }, []);
  useEffect(() => {
    let polling = false,
      stopped = false;
    const tick = setInterval(() => {
      const { workspace: id, runs: list } = current.current;
      if (!id || !list.some(active) || polling) return;
      polling = true;
      void Promise.all(
        list.filter(active).map(async (row) => {
          const response = await api(
            `/api/workspace/${id}/runs/${row.id}/summary`,
            undefined,
            summaryResponseSchema,
          );
          if (!stopped && current.current.workspace === id)
            setRuns((previous) => mergeRuns(previous, [response.run]));
        }),
      )
        .catch((e) => {
          if (!stopped && current.current.workspace === id) fail(e);
        })
        .finally(() => {
          polling = false;
        });
    }, 1000);
    return () => {
      stopped = true;
      clearInterval(tick);
    };
  }, []);
  useEffect(() => {
    setDetail(undefined);
    setDetailError("");
    if (!workspace || !selectedRun) return;
    let stopped = false,
      polling = false;
    const load = async () => {
      if (polling) return;
      polling = true;
      try {
        const response = await api(
          `/api/workspace/${workspace}/runs/${selectedRun}`,
          undefined,
          runResponseSchema,
        );
        if (
          !stopped &&
          current.current.workspace === workspace &&
          selection.current === selectedRun
        ) {
          setDetail((previous) => {
            if (
              previous?.workspace === workspace &&
              previous.run.id === selectedRun &&
              !active(previous.run) &&
              active(response.run)
            )
              return previous;
            return { workspace, run: response.run };
          });
          setRuns((previous) => mergeRuns(previous, [response.run]));
        }
      } catch (e) {
        if (
          !stopped &&
          current.current.workspace === workspace &&
          selection.current === selectedRun
        ) {
          setDetailError(e instanceof Error ? e.message : String(e));
          fail(e);
        }
      } finally {
        polling = false;
      }
    };
    void load();
    const timer =
      selectedSummary && active(selectedSummary)
        ? setInterval(() => void load(), 1000)
        : undefined;
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [workspace, selectedRun, selectedSummary?.status]);
  async function loadOlderRuns() {
    if (!nextCursor || historyLoading) return;
    const id = workspace;
    setHistoryLoading(true);
    try {
      const response = await api(
        `/api/workspace/${id}/runs?cursor=${encodeURIComponent(nextCursor)}`,
        undefined,
        workspaceSchema,
      );
      if (current.current.workspace !== id) return;
      setRuns((previous) => mergeRuns(previous, response.runs));
      setNextCursor(response.nextCursor);
      setHistoryTotal((total) => Math.max(total, response.total));
    } finally {
      if (current.current.workspace === id) setHistoryLoading(false);
    }
  }
  function acceptRun(id: string, value: Run) {
    if (current.current.workspace !== id) return;
    setRuns((previous) => mergeRuns(previous, [value]));
    if (selection.current === value.id)
      setDetail((previous) => {
        if (
          previous?.workspace === id &&
          previous.run.id === value.id &&
          !active(previous.run) &&
          active(value)
        )
          return previous;
        return { workspace: id, run: value };
      });
  }
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setCommand((x) => !x);
      }
      if (e.key === "Escape") {
        setCommand(false);
        setBrowserOpen(false);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  useEffect(() => {
    const changed = [...runs]
      .reverse()
      .find(
        (r) =>
          (r.tool === "open_binary" || r.tool === "close_binary") && !active(r),
      );
    if (!workspace || !changed || sessionRun.current === changed.id) return;
    sessionRun.current = changed.id;
    void refreshSession(workspace).catch(fail);
  }, [runs, workspace]);
  function selectTool(t: Tool, input?: Obj) {
    if (selectedTool)
      drafts.current.set(selectedTool.name, {
        input: args,
        raw,
        error: jsonError,
      });
    const draft = input === undefined ? drafts.current.get(t.name) : undefined;
    const next = draft?.input ?? targetArguments(t, target, input);
    setSelectedTool(t);
    setArgs(next);
    setRaw(draft?.raw ?? JSON.stringify(next, null, 2));
    setJsonError(draft?.error ?? "");
    showWorkspace("tools");
    setCommand(false);
  }
  async function start(
    t: string,
    input: Obj,
    targetPath?: string,
    stay = false,
  ) {
    if (!workspace) throw new Error("Workspace is still connecting.");
    const id = workspace;
    const response = await api(
      `/api/workspace/${id}/run`,
      {
        tool: t,
        arguments: input,
        ...(targetPath ? { targetPath } : {}),
        ...(openProject ? { project: openProject.id } : {}),
      },
      runResponseSchema,
    );
    if (current.current.workspace === id) {
      acceptRun(id, response.run);
      setHistoryTotal((total) => total + 1);
      setSelectedRun(response.run.id);
      if (!stay) showWorkspace("results");
    }
    // Linking the run moved the project's revision; refresh this tab's copy.
    if (openProject) reloadProject(openProject.id);
    return response.run;
  }
  /** Reload the open project, ignoring a late reply for a project no longer open. */
  function reloadProject(id: string) {
    getProject(id)
      .then((fresh) =>
        setOpenProjectState((current) =>
          current?.id === fresh.id && current.revision <= fresh.revision
            ? fresh
            : current,
        ),
      )
      .catch(() => {});
  }
  const settledRun = run && !active(run) ? run.id : undefined;
  useEffect(() => {
    if (!settledRun || !openProject) return;
    reloadProject(openProject.id);
    // Only a newly settled run should trigger a reload.
  }, [settledRun]);
  function add(t: Target) {
    sessionStorage.setItem("rea-target-path", t.path);
    setTargets((list) => [t, ...list.filter((x) => x.path !== t.path)]);
    setTarget(t);
    setPath(t.path);
    setPreview(t.preview?.text === null ? "Hex" : "Text");
    setPage("Workspace");
    setWorkspaceTab("preview");
    setSelectedRun(undefined);
    setShowOpener(false);
  }
  const open = async (p: string) => {
    add(await api("/api/open", { path: p }, targetSchema));
    setBrowserOpen(false);
  };
  const browse = async (p: string, offset = 0) => {
    setBrowser(await api("/api/browse", { path: p, offset }, browseSchema));
    setBrowserOpen(true);
  };
  async function refreshSession(id: string) {
    const response = await api(
      `/api/workspace/${id}/session`,
      undefined,
      objectSchema,
    );
    if (current.current.workspace !== id) return;
    const value = resultValue({
      result: object(response.result) ? response.result : {},
    });
    setSession(
      object(value) && object(value.result)
        ? value.result
        : object(value)
          ? value
          : { error: "Session status unavailable" },
    );
  }
  async function waitForRun(initial: Run): Promise<Run> {
    const id = workspace;
    let latest = initial;
    while (active(latest)) {
      await new Promise<void>((resolve) => setTimeout(resolve, 700));
      latest = (
        await api(
          `/api/workspace/${id}/runs/${latest.id}`,
          undefined,
          runResponseSchema,
        )
      ).run;
      acceptRun(id, latest);
    }
    if (latest.status !== "completed" || latest.result?.isError === true) {
      if (current.current.workspace === id) setSelectedRun(latest.id);
      throw new Error(
        latest.error ??
          `${pretty(latest.tool)} ${latest.status}. Review the preserved result below.`,
      );
    }
    return latest;
  }
  /** Run a "What is this?" next step, opening its file first when it needs one. */
  function runStep(step: IdentificationStep) {
    const tool = tools.find((t) => t.name === step.tool);
    if (!tool) {
      setError(`${step.tool} is not available in this workspace.`);
      return;
    }
    if (step.requires !== null && step.open_first === null) {
      selectTool(tool, step.arguments);
      return;
    }
    void task(step.label, async () => {
      showWorkspace("results");
      if (step.open_first === null) {
        await start(step.tool, step.arguments);
        return;
      }
      if (step.tool === "inspect_artifact") {
        await start(step.tool, step.arguments, step.open_first);
        return;
      }
      const opened = await waitForRun(
        await start("open_binary", { path: step.open_first }),
      );
      if (opened.status !== "completed")
        throw new Error(
          `Opening ${step.open_first} did not complete; ${step.tool} was not run.`,
        );
      await start(step.tool, step.arguments);
    });
  }
  function identify() {
    if (!target) return;
    const selected = target;
    void task("Identifying target", async () => {
      showWorkspace("results");
      await start("identify_artifact", { path: selected.path, limit: 200 });
    });
  }
  function identifyPage(path: string, offset: number) {
    void task("Loading more pieces", async () => {
      showWorkspace("results");
      await start("identify_artifact", { path, start: offset, limit: 200 });
    });
  }
  function quick(name: string) {
    if (!target) return;
    const selected = target;
    void task("Analyzing target", async () => {
      showWorkspace("results");
      if (name === "analyze_javascript_application") {
        if (selected.directory || /\.asar$/i.test(selected.path)) {
          await start(name, { input_path: selected.path });
        } else {
          await start(
            "inspect_artifact",
            { integrity_policy: "record-and-continue" },
            selected.path,
          );
        }
        return;
      }
      if (name === "inspect_android_package") {
        await start(name, { path: selected.path });
        return;
      }
      if (name === "open_binary") {
        await waitForRun(await start("open_binary", { path: selected.path }));
        await start("binary_overview", {});
        return;
      }
      const inspected = await waitForRun(
        await start(
          "inspect_artifact",
          { integrity_policy: "record-and-continue" },
          selected.path,
        ),
      );
      if (name === "inspect_artifact") return;
      const evidence = inventoryEvidence(resultValue(inspected));
      if (!evidence.length)
        throw new Error(
          "The inspection did not deliver completed inventory evidence. Review its result and limits before projecting an application graph.",
        );
      await start(name, { inventory_evidence: evidence });
    });
  }
  async function uploadFiles(files: File[]) {
    const failures: string[] = [];
    for (const file of files) {
      try {
        if (file.size > 128 * 1024 * 1024)
          throw new Error(
            `${file.name} exceeds 128 MiB. Open its local path instead.`,
          );
        const response = await fetch(
          `/api/upload?name=${encodeURIComponent(file.name)}`,
          {
            method: "POST",
            headers: {
              "x-rea-token": token,
              "Content-Type": "application/octet-stream",
            },
            body: file,
          },
        );
        const data: unknown = await response.json();
        if (!response.ok)
          throw new Error(
            object(data) && typeof data.message === "string"
              ? data.message
              : `Could not open ${file.name}`,
          );
        add(targetSchema.parse(data));
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (failures.length) throw new Error(failures.join(" "));
  }
  const firstPage = targets.find(
    (item) => item.path === target?.path && item.modified === target.modified,
  );
  const support = target ? targetSupport(firstPage ?? target) : undefined;
  const filtered = tools.filter(
    (t) =>
      (filter === "All tools" || category(t) === filter) &&
      `${t.name} ${t.description} ${category(t)}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const nav = (name: string) => {
    const views: Record<string, string> = {
      Tools: "tools",
      Runs: "results",
      Evidence: "evidence",
      Compare: "compare",
      "File support": "support",
    };
    const tab = views[name];
    if (tab) showWorkspace(tab);
    else setPage(name);
  };
  return (
    <div
      className={`app ${assistant ? "with-assistant" : ""} ${target && page === "Workspace" ? "with-target" : ""}`}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(event) => {
        if (
          !(
            event.relatedTarget instanceof Node &&
            event.currentTarget.contains(event.relatedTarget)
          )
        )
          setDragging(false);
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDragging(false);
        if (
          [...event.dataTransfer.items].some(
            (item) => item.webkitGetAsEntry()?.isDirectory,
          )
        ) {
          setError(
            "Open folders and app bundles with their local path or Browse computer.",
          );
          setShowOpener(true);
          return;
        }
        const files = Array.from(event.dataTransfer.files);
        void task("Opening dropped files", () => uploadFiles(files));
      }}
    >
      {dragging && (
        <div className="drop-overlay">
          <Upload size={32} />
          <strong>Drop files into your workspace</strong>
          <span>For folders and app bundles, use a local path.</span>
        </div>
      )}
      <aside className="sidebar" aria-label="Primary navigation">
        <Hint content="Oopsware workspace" side="right">
          <a
            href="#"
            className="brand"
            aria-label="Oopsware workspace"
            onClick={(e) => {
              e.preventDefault();
              nav("Workspace");
            }}
          >
            <span className="brand-monogram">
              o<span>!</span>
            </span>
          </a>
        </Hint>
        <Hint
          content={
            <>
              Find a tool <kbd>⌘ K</kbd>
            </>
          }
          side="right"
        >
          <button
            className="rail-search"
            aria-label="Find a tool"
            onClick={() => {
              setQuery("");
              setCommand(true);
            }}
          >
            <Search size={18} />
          </button>
        </Hint>
        <nav aria-label="Workspace">
          {[sections[0], { name: "File support", icon: Box }]
            .filter((item) => item !== undefined)
            .map(({ name, icon: Icon }) => (
              <Hint key={name} content={name} side="right">
                <button
                  aria-label={name}
                  aria-current={
                    page === "Workspace" &&
                    (name === "File support"
                      ? workspaceTab === "support"
                      : workspaceTab !== "support")
                      ? "page"
                      : undefined
                  }
                  className={
                    page === "Workspace" &&
                    (name === "File support"
                      ? workspaceTab === "support"
                      : workspaceTab !== "support")
                      ? "nav-item selected"
                      : "nav-item"
                  }
                  onClick={() => nav(name)}
                >
                  <Icon size={19} />
                </button>
              </Hint>
            ))}
          <Hint content="Projects" side="right">
            <button
              aria-label="Projects"
              aria-current={page === "Projects" ? "page" : undefined}
              className={page === "Projects" ? "nav-item selected" : "nav-item"}
              onClick={() => nav("Projects")}
            >
              <FolderKanban size={19} />
            </button>
          </Hint>
        </nav>
        <nav className="rail-bottom" aria-label="Preferences">
          {sections.slice(5).map(({ name, icon: Icon }) => (
            <Hint key={name} content={name} side="right">
              <button
                aria-label={name}
                aria-current={page === name ? "page" : undefined}
                className={page === name ? "nav-item selected" : "nav-item"}
                onClick={() => nav(name)}
              >
                <Icon size={19} />
              </button>
            </Hint>
          ))}
          <Hint
            content={
              theme === "light"
                ? "Switch to dark appearance"
                : "Switch to light appearance"
            }
            side="right"
          >
            <button
              className="nav-item"
              aria-label="Toggle color theme"
              onClick={() =>
                setTheme((x) => (x === "light" ? "dark" : "light"))
              }
            >
              {theme === "light" ? <Moon size={18} /> : <Sun size={18} />}
            </button>
          </Hint>
        </nav>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <span className="app-name">Oopsware</span>
            <span className="maker-mark" title="Celaya Solutions">
              CSR
            </span>
            <span className="breadcrumb-divider" />
            <h1>{page}</h1>
            {openProject && (
              <button
                className="project-chip"
                aria-label={`Open project ${openProject.title}`}
                onClick={() => {
                  setProjectList(false);
                  setPage("Projects");
                }}
              >
                <FolderKanban size={13} />
                {openProject.title}
              </button>
            )}
          </div>
          <div className="top-actions">
            <Hint content="Search all tools · ⌘ K">
              <button
                className="command-launch"
                onClick={() => {
                  setQuery("");
                  setCommand(true);
                }}
              >
                <Search size={14} />
                <span>Find a tool</span>
                <kbd>⌘ K</kbd>
              </button>
            </Hint>
            <Hint content="Toggle analysis assistant">
              <button
                aria-label="Assistant"
                aria-pressed={assistant}
                className={
                  assistant ? "assistant-toggle selected" : "assistant-toggle"
                }
                onClick={() => setAssistant(!assistant)}
              >
                <PanelRight size={16} />
                <span>Assistant</span>
              </button>
            </Hint>
          </div>
        </header>
        <main id="workspace-content">
          {error && (
            <div role="alert" className="error-banner">
              <CircleHelp size={18} />
              <span>{error}</span>
              <IconButton label="Dismiss error" onClick={() => setError("")}>
                <X size={16} />
              </IconButton>
            </div>
          )}
          {busy && (
            <div className="busy-bar" role="status">
              <span className="spinner" />
              {busy}…
            </div>
          )}
          <Tabs
            className="workspace-root"
            value={workspaceTab}
            onValueChange={setWorkspaceTab}
          >
            {page === "Workspace" && (
              <>
                {(!target || showOpener) && (
                  <section className="card target-opener">
                    <div className="section-title">
                      <FolderOpen size={19} />
                      <h2>Open target</h2>
                      <HelpHint label="Supported target inputs">
                        Open a local file, application bundle, archive, or
                        project folder. You can also drop individual files into
                        the workspace.
                      </HelpHint>
                      {target && (
                        <IconButton
                          label="Close target opener"
                          onClick={() => setShowOpener(false)}
                        >
                          <X size={15} />
                        </IconButton>
                      )}
                    </div>
                    <form
                      className="path-form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void task("Opening target", () => open(path));
                      }}
                    >
                      <div className="input-icon">
                        <Terminal size={16} />
                        <input
                          aria-label="Target path"
                          placeholder="Enter a file or folder path…"
                          value={path}
                          onChange={(e) => setPath(e.target.value)}
                        />
                      </div>
                      <button className="primary" disabled={!path || !!busy}>
                        Open path
                        <ArrowRight size={15} />
                      </button>
                    </form>
                    <div className="open-options">
                      <button
                        onClick={() =>
                          void task("Browsing computer", () =>
                            browse(
                              typeof status.home === "string"
                                ? status.home
                                : "~",
                            ),
                          )
                        }
                      >
                        <HardDrive size={16} />
                        Browse computer
                      </button>
                      <button
                        onClick={() =>
                          void task("Browsing applications", () =>
                            browse(
                              status.platform === "darwin"
                                ? "/Applications"
                                : typeof status.home === "string"
                                  ? status.home
                                  : "~",
                            ),
                          )
                        }
                      >
                        <Box size={16} />
                        Applications
                      </button>
                      <button onClick={() => upload.current?.click()}>
                        <Upload size={16} />
                        Upload files
                      </button>
                      <button
                        onClick={() =>
                          void task("Opening sample", async () =>
                            add(await api("/api/sample", {}, targetSchema)),
                          )
                        }
                      >
                        <FileCode2 size={16} />
                        Open sample
                        <ArrowRight size={13} />
                      </button>
                    </div>
                  </section>
                )}
                {targets.length > 0 && (
                  <div className="target-strip" aria-label="Open targets">
                    <Button
                      className="add-target"
                      variant="outline"
                      size="sm"
                      onClick={() => setShowOpener((value) => !value)}
                      aria-expanded={showOpener}
                    >
                      <Plus size={14} />
                      Open target
                    </Button>
                    {targets.map((item) => (
                      <Hint key={item.path} content={item.path} side="bottom">
                        <Button
                          variant={
                            target?.path === item.path ? "secondary" : "ghost"
                          }
                          size="sm"
                          aria-pressed={target?.path === item.path}
                          onClick={() => add(item)}
                        >
                          {item.directory ? (
                            <Folder size={14} />
                          ) : (
                            <FileCode2 size={14} />
                          )}
                          {item.name}
                        </Button>
                      </Hint>
                    ))}
                  </div>
                )}
                {target && support && (
                  <section
                    className="target-context"
                    aria-label="Selected target"
                  >
                    <div className="target-identity">
                      <div>
                        <div className="target-title">
                          <span className="target-family">
                            {support.family}
                          </span>
                          <span className="subtle">
                            {target.directory ? "Folder" : bytes(target.size)}
                          </span>
                        </div>
                        <Hint content={target.path}>
                          <code tabIndex={0}>{target.path}</code>
                        </Hint>
                      </div>
                    </div>
                    <div className="target-toolbar">
                      {tools.some(
                        (tool) => tool.name === "identify_artifact",
                      ) && (
                        <Button
                          variant="default"
                          size="sm"
                          disabled={!!busy || !workspace}
                          onClick={identify}
                        >
                          <Search size={14} />
                          What is this?
                        </Button>
                      )}
                      {support.actions
                        .filter((action) =>
                          tools.some((tool) => tool.name === action.tool),
                        )
                        .map((action, index) => (
                          <Button
                            key={action.tool}
                            variant={
                              index === 0 &&
                              !tools.some(
                                (tool) => tool.name === "identify_artifact",
                              )
                                ? "default"
                                : "outline"
                            }
                            size="sm"
                            disabled={!!busy || !workspace}
                            onClick={() => quick(action.tool)}
                          >
                            {index === 0 ? (
                              <Search size={14} />
                            ) : (
                              <Play size={14} />
                            )}
                            {action.label}
                          </Button>
                        ))}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setFilter("All tools");
                          setQuery("");
                          showWorkspace("tools");
                        }}
                      >
                        All tools <ArrowRight size={14} />
                      </Button>
                      <Hint
                        content={
                          openProject
                            ? `Add this file to ${openProject.title}`
                            : "Open a project first"
                        }
                      >
                        <span>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={!openProject || !!busy}
                            onClick={() =>
                              openProject &&
                              void task("Adding to project", async () =>
                                setOpenProject(
                                  await addProjectTarget(
                                    openProject,
                                    target.path,
                                  ),
                                ),
                              )
                            }
                          >
                            <FolderKanban size={14} /> Add to project
                          </Button>
                        </span>
                      </Hint>
                    </div>
                    <HelpHint label="Target format and analysis coverage">
                      {support.note}
                      <br />
                      {support.basis}
                    </HelpHint>
                  </section>
                )}
                <div className="workspace-tabs">
                  <TabsList variant="line" aria-label="Workspace views">
                    <TabsTrigger value="preview">
                      <FileCode2 size={14} />
                      Preview
                    </TabsTrigger>
                    <TabsTrigger value="results">
                      <Activity size={14} />
                      Results {runs.some(active) && <i className="live-dot" />}
                    </TabsTrigger>
                    <TabsTrigger value="tools">
                      <Braces size={14} />
                      Tools <span className="tab-count">{tools.length}</span>
                    </TabsTrigger>
                    <TabsTrigger value="compare">
                      <GitCompareArrows size={14} />
                      Compare
                    </TabsTrigger>
                    <TabsTrigger value="evidence">
                      <ShieldCheck size={14} />
                      Evidence
                    </TabsTrigger>
                    <TabsTrigger value="support">
                      <Box size={14} />
                      File support
                    </TabsTrigger>
                  </TabsList>
                </div>
                <TabsContent value="preview">
                  {target && (
                    <section
                      className="card preview-card"
                      aria-label="File preview"
                    >
                      {target.applicationError && (
                        <JsonView value={target.applicationError} />
                      )}
                      <div className="tabbar">
                        {["Text", "Hex", "Strings", "Details"].map((t) => (
                          <button
                            className={preview === t ? "active" : ""}
                            key={t}
                            onClick={() => setPreview(t)}
                          >
                            {t}
                          </button>
                        ))}
                        <span>
                          {target.preview
                            ? `${bytes(target.preview.bytes)} · byte ${target.preview.offset.toLocaleString()}`
                            : "Folder selected"}
                        </span>
                      </div>
                      {preview === "Details" ? (
                        <JsonView value={jsonSchema.parse(target)} />
                      ) : !target.preview ? (
                        <div className="empty-inline">
                          <Folder size={24} />
                          <p>
                            This folder is ready for package inventory or
                            application analysis.
                          </p>
                        </div>
                      ) : preview === "Text" ? (
                        <pre className="file-preview">
                          {target.preview.text ??
                            "Binary content. Choose Hex or Strings to inspect these bytes."}
                        </pre>
                      ) : preview === "Hex" ? (
                        <pre className="file-preview hex">
                          {hex(target.preview.hex, target.preview.offset)}
                        </pre>
                      ) : (
                        <div className="strings-table">
                          {target.preview.strings.length ? (
                            target.preview.strings.map((s, i) => (
                              <div key={i}>
                                <code>
                                  {s.offset.toString(16).padStart(8, "0")}
                                </code>
                                <span>{s.text}</span>
                              </div>
                            ))
                          ) : (
                            <p>No printable strings in this page.</p>
                          )}
                        </div>
                      )}
                      {target.preview && (
                        <div className="pagination">
                          <span>Preview page · source bytes are unchanged</span>
                          <button
                            disabled={target.preview.offset === 0}
                            onClick={() =>
                              void task("Loading previous page", () =>
                                openPage(
                                  Math.max(
                                    0,
                                    (target.preview?.offset ?? 0) - 65536,
                                  ),
                                ),
                              )
                            }
                          >
                            <ArrowLeft size={14} />
                            Previous
                          </button>
                          <button
                            disabled={!target.preview.hasMore}
                            onClick={() =>
                              void task("Loading next page", () =>
                                openPage(
                                  (target.preview?.offset ?? 0) +
                                    (target.preview?.bytes ?? 0),
                                ),
                              )
                            }
                          >
                            Next
                            <ArrowRight size={14} />
                          </button>
                        </div>
                      )}
                    </section>
                  )}
                  {!target && (
                    <Empty
                      icon={<FileCode2 size={26} />}
                      title="What makes it tick?"
                      body="Bring something puzzling. Open a file, drop one here, or pick a tool and follow a clue."
                    />
                  )}
                </TabsContent>
                <TabsContent value="support">
                  <FileSupport
                    explore={(query) => {
                      setQuery(query);
                      setFilter("All tools");
                      showWorkspace("tools");
                    }}
                  />
                </TabsContent>
              </>
            )}
            {page === "Workspace" && (
              <TabsContent value="tools">
                <div className="tool-layout">
                  <section className="card catalog">
                    <div className="catalog-search input-icon">
                      <Search size={16} />
                      <input
                        aria-label="Search tools"
                        placeholder="Search tools or questions…"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                      />
                    </div>
                    <select
                      aria-label="Tool category"
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                    >
                      {["All tools", ...new Set(tools.map(category))].map(
                        (c) => (
                          <option key={c}>{c}</option>
                        ),
                      )}
                    </select>
                    <div className="catalog-count">{filtered.length} tools</div>
                    <div className="tool-list">
                      {filtered.map((t) => (
                        <Hint key={t.name} content={t.description} side="right">
                          <button
                            aria-label={pretty(t.name)}
                            className={
                              selectedTool?.name === t.name
                                ? "tool-item active"
                                : "tool-item"
                            }
                            onClick={() => selectTool(t)}
                          >
                            <span className="tool-kind">{category(t)}</span>
                            <strong>{pretty(t.name)}</strong>
                          </button>
                        </Hint>
                      ))}
                      {!filtered.length && (
                        <div className="empty-inline">
                          No tools match this search.
                        </div>
                      )}
                    </div>
                  </section>
                  <section className="card tool-detail">
                    {selectedTool ? (
                      <>
                        <div className="card-heading">
                          <div>
                            <span className="eyebrow">
                              {category(selectedTool)}
                            </span>
                            <h2>{pretty(selectedTool.name)}</h2>
                            <code className="subtle">{selectedTool.name}</code>
                          </div>
                          <HelpHint label="About this tool">
                            {selectedTool.description}
                          </HelpHint>
                        </div>
                        {selectedTool.effects && (
                          <details className="effects">
                            <summary>Authority, effects & availability</summary>
                            <JsonView value={selectedTool.effects} />
                          </details>
                        )}
                        {!!selectedTool.examples?.length && (
                          <label className="example-picker">
                            Start with an example
                            <select
                              aria-label="Tool example"
                              value=""
                              onChange={(e) => {
                                const example =
                                  selectedTool.examples?.[
                                    Number(e.target.value)
                                  ];
                                if (example) {
                                  setArgs(example.input);
                                  setRaw(
                                    JSON.stringify(example.input, null, 2),
                                  );
                                  setJsonError("");
                                }
                              }}
                            >
                              <option value="">Choose an example…</option>
                              {selectedTool.examples.map((e, i) => (
                                <option key={i} value={i}>
                                  {e.title}
                                </option>
                              ))}
                            </select>
                          </label>
                        )}
                        <div className="form-tabs">
                          <button
                            className={!jsonMode ? "active" : ""}
                            onClick={() => setJsonMode(false)}
                          >
                            Input fields
                          </button>
                          <button
                            className={jsonMode ? "active" : ""}
                            onClick={() => {
                              setRaw(JSON.stringify(args, null, 2));
                              setJsonMode(true);
                            }}
                          >
                            JSON editor
                          </button>
                        </div>
                        {jsonMode ? (
                          <>
                            <textarea
                              className="json-input arguments"
                              aria-label="Tool arguments JSON"
                              value={raw}
                              onChange={(e) => {
                                setRaw(e.target.value);
                                try {
                                  const v: unknown = JSON.parse(e.target.value);
                                  if (!object(v))
                                    throw new Error(
                                      "Arguments must be a JSON object.",
                                    );
                                  setArgs(v);
                                  setJsonError("");
                                } catch (e) {
                                  setJsonError(
                                    e instanceof Error
                                      ? e.message
                                      : "Invalid JSON",
                                  );
                                }
                              }}
                            />
                            {jsonError && (
                              <p className="error-text">{jsonError}</p>
                            )}
                          </>
                        ) : (
                          <SchemaField
                            key={`${selectedTool.name}:${JSON.stringify(selectedTool.examples?.find((e) => e.input === args)?.title)}`}
                            schema={selectedTool.inputSchema}
                            root={selectedTool.inputSchema}
                            value={args}
                            change={(v) => {
                              if (object(v)) setArgs(v);
                            }}
                            name="Arguments"
                          />
                        )}
                        <div className="run-footer">
                          <HelpHint label="About tool inputs">
                            Only included fields are sent. The tool checks the
                            inputs before running.
                          </HelpHint>
                          <button
                            className="primary"
                            disabled={!!jsonError || !workspace || !!busy}
                            onClick={() =>
                              void task("Starting analysis", async () => {
                                const invalid =
                                  document.querySelector<HTMLTextAreaElement>(
                                    ".tool-detail textarea:invalid",
                                  );
                                if (invalid) {
                                  invalid.reportValidity();
                                  throw new Error(
                                    "Correct the invalid JSON field before running.",
                                  );
                                }
                                await start(
                                  selectedTool.name,
                                  args,
                                  selectedTool.name === "inspect_artifact"
                                    ? target?.path
                                    : undefined,
                                );
                                showWorkspace("results");
                              })
                            }
                          >
                            <Play size={15} />
                            Run tool
                          </button>
                        </div>
                      </>
                    ) : (
                      <Empty
                        icon={<Braces size={32} />}
                        title="Select a tool"
                        body="Search or choose from the list."
                      />
                    )}
                  </section>
                </div>
              </TabsContent>
            )}
            {page === "Workspace" && (
              <TabsContent value="results">
                <div className="runs-layout">
                  <section className="card run-list">
                    <div className="card-heading">
                      <h2>History</h2>
                      <span className="badge">{historyTotal}</span>
                    </div>
                    {[...runs].reverse().map((r) => (
                      <button
                        key={r.id}
                        className={
                          selectedRun === r.id ? "run-item active" : "run-item"
                        }
                        onClick={() => setSelectedRun(r.id)}
                      >
                        <span className={`status-dot ${r.status}`} />
                        <span>
                          <strong>{pretty(r.tool)}</strong>
                          <small>
                            {new Date(r.createdAt).toLocaleString()}
                          </small>
                        </span>
                        <span className={`status ${r.status}`}>{r.status}</span>
                      </button>
                    ))}
                    {nextCursor && (
                      <button
                        disabled={historyLoading}
                        onClick={() =>
                          void task("Loading older runs", loadOlderRuns)
                        }
                      >
                        {historyLoading ? "Loading…" : "Load older runs"}
                      </button>
                    )}
                    {!runs.length && (
                      <Empty
                        icon={<History size={28} />}
                        title="No runs"
                        body="Run a tool to begin."
                      />
                    )}
                  </section>
                  <section className="card result-panel">
                    {run ? (
                      <>
                        <div className="card-heading">
                          <div>
                            <span
                              className={`status ${run.status}`}
                              role="status"
                            >
                              {run.status}
                            </span>
                            <h2>{pretty(run.tool)}</h2>
                          </div>
                          <div className="inline-actions">
                            {active(run) ? (
                              <button
                                onClick={() =>
                                  void task("Stopping run", async () => {
                                    const { run: r } = await api(
                                      `/api/workspace/${workspace}/runs/${run.id}/cancel`,
                                      {},
                                      runResponseSchema,
                                    );
                                    acceptRun(workspace, r);
                                  })
                                }
                              >
                                <Square size={14} />
                                Stop
                              </button>
                            ) : (
                              <button
                                onClick={() =>
                                  void task("Retrying run", async () => {
                                    if (
                                      JSON.stringify(run.arguments).includes(
                                        "[REDACTED]",
                                      )
                                    ) {
                                      const t = tools.find(
                                        (t) => t.name === run.tool,
                                      );
                                      if (t) selectTool(t, run.arguments);
                                      setError(
                                        "Re-enter the explicitly sensitive values before running again.",
                                      );
                                      return;
                                    }
                                    await start(
                                      run.tool,
                                      run.arguments,
                                      run.targetPath,
                                    );
                                  })
                                }
                              >
                                <Play size={14} />
                                Retry
                              </button>
                            )}
                            <button
                              disabled={!run.result}
                              onClick={() =>
                                download(`rea-${run.tool}-${run.id}.json`, run)
                              }
                            >
                              <ArrowDownToLine size={15} />
                              Export run JSON
                            </button>
                            <RunReportButtons
                              workspace={workspace}
                              runId={run.id}
                              disabled={active(run)}
                              task={task}
                              fail={setError}
                            />
                          </div>
                        </div>
                        {(run.targetPath ||
                          typeof run.arguments.path === "string" ||
                          typeof run.arguments.input_path === "string") && (
                          <p className="run-target mono">
                            Run target:{" "}
                            {run.targetPath ??
                              String(
                                run.arguments.path ?? run.arguments.input_path,
                              )}
                          </p>
                        )}
                        {active(run) && (
                          <div className="progress-panel">
                            <span className="spinner" />
                            <div>
                              <strong>
                                {run.progress?.message ??
                                  "Analysis in progress"}
                              </strong>
                              <p>
                                {run.progress
                                  ? `${run.progress.progress}${run.progress.total ? ` / ${run.progress.total}` : ""}`
                                  : "The provider is working. You can continue exploring."}
                              </p>
                            </div>
                          </div>
                        )}
                        {run.error && (
                          <p className="error-banner">{run.error}</p>
                        )}
                        <details className="input-details">
                          <summary>
                            Invocation inputs ·{" "}
                            {new Date(run.createdAt).toLocaleString()}
                          </summary>
                          <JsonView value={run.arguments} />
                        </details>
                        {run.result && run.tool === "identify_artifact" && (
                          <IdentificationCard
                            value={resultValue(run)}
                            busy={!!busy || !workspace}
                            onStep={runStep}
                            onPage={identifyPage}
                          />
                        )}
                        {run.result && run.tool === "identify_artifact" && (
                          <details className="raw-result">
                            <summary>All facts</summary>
                            <Report value={resultValue(run)} />
                          </details>
                        )}
                        {run.result && (
                          <>
                            <RunGraphs
                              key={run.id}
                              tool={run.tool}
                              value={resultValue(run)}
                              project={openProject}
                              setProject={setOpenProject}
                            />
                            {run.tool !== "identify_artifact" && (
                              <Report value={resultValue(run)} />
                            )}
                            <details className="raw-result">
                              <summary>Complete delivered MCP result</summary>
                              <JsonView value={run.result} />
                            </details>
                          </>
                        )}
                      </>
                    ) : (
                      <Empty
                        icon={<Activity size={30} />}
                        title={
                          detailError
                            ? "Run could not be loaded"
                            : selectedRun
                              ? "Loading run…"
                              : "Inspect an analysis run"
                        }
                        body={
                          detailError ||
                          "Select a run to review its inputs, progress, results, and evidence."
                        }
                      />
                    )}
                  </section>
                </div>
              </TabsContent>
            )}
            {page === "Workspace" && (
              <TabsContent value="evidence">
                <>
                  <div className="action-cards">
                    {[
                      {
                        name: "export_evidence_bundle",
                        label: "Export evidence",
                        icon: ArrowDownToLine,
                      },
                      {
                        name: "import_evidence_bundle",
                        label: "Import evidence",
                        icon: Upload,
                      },
                      {
                        name: "list_unknowns",
                        label: "Inspect unknowns",
                        icon: CircleHelp,
                      },
                    ].map(({ name, label, icon: Icon }) => (
                      <button
                        className="card action-card"
                        key={name}
                        onClick={() => {
                          const t =
                            tools.find((t) => t.name === name) ||
                            tools.find((t) =>
                              t.name.includes(name.replace("list_", "")),
                            );
                          if (t) selectTool(t);
                          else {
                            showWorkspace("tools");
                            setQuery(
                              name.includes("unknown") ? "unknown" : "evidence",
                            );
                            setFilter("All tools");
                          }
                        }}
                      >
                        <Icon size={22} />
                        <strong>{label}</strong>
                        <ArrowRight size={16} />
                      </button>
                    ))}
                  </div>
                  <section className="card">
                    <div className="card-heading">
                      <h2>Collected analysis</h2>
                      <span className="subtle">
                        Source results, observations, and limits
                      </span>
                    </div>
                    {runs.filter((r) => r.hasResult).length ? (
                      [...runs]
                        .reverse()
                        .filter((r) => r.hasResult)
                        .map((r) => (
                          <button
                            className="evidence-entry evidence-link"
                            key={r.id}
                            onClick={() => {
                              setSelectedRun(r.id);
                              showWorkspace("results");
                            }}
                          >
                            <FileText size={18} />
                            <strong>{pretty(r.tool)}</strong>
                            <span className={`status ${r.status}`}>
                              {r.status}
                            </span>
                            <span>
                              {new Date(r.createdAt).toLocaleTimeString()}
                            </span>
                            <ArrowRight size={14} />
                          </button>
                        ))
                    ) : (
                      <Empty
                        icon={<ShieldCheck size={30} />}
                        title="No evidence yet"
                        body="Inspect a target to collect evidence."
                      />
                    )}
                    {nextCursor && (
                      <button
                        disabled={historyLoading}
                        onClick={() =>
                          void task("Loading older runs", loadOlderRuns)
                        }
                      >
                        {historyLoading ? "Loading…" : "Load older runs"}
                      </button>
                    )}
                  </section>
                </>
              </TabsContent>
            )}
            {page === "Workspace" && (
              <TabsContent value="compare">
                <>
                  <section className="card pair-compare">
                    <div className="card-heading">
                      <h2>Compare artifacts</h2>
                      <HelpHint label="About artifact comparison">
                        Inspect both local artifacts and compare the evidence.
                        Incomplete inventories remain marked as unknown.
                      </HelpHint>
                    </div>
                    <div className="paired-inputs">
                      <label>
                        Left artifact
                        <input
                          aria-label="Left artifact path"
                          list="workspace-targets"
                          placeholder="Original file or package path"
                          value={leftPath}
                          onChange={(e) => setLeftPath(e.target.value)}
                        />
                      </label>
                      <GitCompareArrows size={20} />
                      <label>
                        Right artifact
                        <input
                          aria-label="Right artifact path"
                          list="workspace-targets"
                          placeholder="Updated file or package path"
                          value={rightPath}
                          onChange={(e) => setRightPath(e.target.value)}
                        />
                      </label>
                      <datalist id="workspace-targets">
                        {targets.map((t) => (
                          <option key={t.path} value={t.path}>
                            {t.name}
                          </option>
                        ))}
                      </datalist>
                    </div>
                    <div className="run-footer">
                      <span>Both inspections are saved in history.</span>
                      <button
                        className="primary"
                        disabled={!leftPath || !rightPath || !!busy}
                        onClick={() =>
                          void task("Comparing artifacts", async () => {
                            showWorkspace("results");
                            const leftRun = await waitForRun(
                              await start(
                                "inspect_artifact",
                                { integrity_policy: "record-and-continue" },
                                leftPath,
                              ),
                            );
                            const rightRun = await waitForRun(
                              await start(
                                "inspect_artifact",
                                { integrity_policy: "record-and-continue" },
                                rightPath,
                              ),
                            );
                            const left = inventoryEvidence(
                                resultValue(leftRun),
                              ),
                              right = inventoryEvidence(resultValue(rightRun));
                            if (
                              left.length !== 1 ||
                              right.length !== 1 ||
                              !left[0] ||
                              !right[0]
                            )
                              throw new Error(
                                "Comparison requires one completed inventory from each artifact. Review the preserved inspection results.",
                              );
                            await start("compare_artifacts", {
                              left: left[0],
                              right: right[0],
                            });
                          })
                        }
                      >
                        <GitCompareArrows size={15} />
                        Compare artifacts
                      </button>
                    </div>
                  </section>
                  <div className="comparison-grid">
                    {tools
                      .filter((t) => /compare/.test(t.name))
                      .map((t) => (
                        <Hint key={t.name} content={t.description}>
                          <button
                            className="card comparison-card"
                            onClick={() => selectTool(t)}
                          >
                            <span className="section-icon">
                              <GitCompareArrows size={18} />
                            </span>
                            <h3>{pretty(t.name)}</h3>
                            <ArrowRight size={14} />
                          </button>
                        </Hint>
                      ))}
                  </div>
                </>
              </TabsContent>
            )}
          </Tabs>
          {page === "Projects" &&
            (openProject && !projectList ? (
              <ProjectView
                project={openProject}
                setProject={setOpenProject}
                workspace={workspace}
                onBack={() => setProjectList(true)}
                onClose={() => {
                  setOpenProject(null);
                  setProjectList(true);
                }}
                openInResults={(runId) => {
                  setSelectedRun(runId);
                  showWorkspace("results");
                }}
                runTool={async (tool, args) =>
                  waitForRun(
                    await start(
                      tool,
                      objectSchema.parse(args),
                      undefined,
                      true,
                    ),
                  )
                }
                task={task}
                fail={setError}
              />
            ) : (
              <ProjectsPage
                openId={openProject?.id}
                onOpen={(project) => {
                  setOpenProject(project);
                  setProjectList(false);
                }}
                onDeleted={(id) => {
                  if (openProject?.id === id) setOpenProject(null);
                }}
                task={task}
              />
            ))}
          {page === "Connections" && (
            <>
              <Connections
                status={status}
                refresh={() =>
                  void task("Refreshing connections", refreshStatus)
                }
                task={task}
              />
              <ModelLibrary
                refresh={() =>
                  void task("Refreshing connections", refreshStatus)
                }
              />
              <Maintenance
                sessionTools={
                  <section className="provider-tools">
                    <div className="card-heading">
                      <h2>Analysis sessions & capabilities</h2>
                      <HelpHint label="About analysis sessions">
                        Availability depends on your installed providers and
                        active session. Opening a file preview does not start a
                        provider.
                      </HelpHint>
                    </div>
                    <div className="inline-actions">
                      {[
                        "binary_session",
                        "list_providers",
                        "get_capabilities",
                        "doctor",
                      ].map((name) => {
                        const t = tools.find((t) => t.name === name);
                        return t ? (
                          <button key={name} onClick={() => selectTool(t)}>
                            {pretty(name)}
                            <ArrowRight size={14} />
                          </button>
                        ) : null;
                      })}
                      <button
                        onClick={() => {
                          showWorkspace("tools");
                          setQuery("capabilit");
                          setFilter("All tools");
                        }}
                      >
                        Find capability tools
                        <ArrowRight size={14} />
                      </button>
                    </div>
                  </section>
                }
              />
            </>
          )}
          {page === "Settings" && (
            <>
              <section className="card project-credit">
                <div>
                  <span className="maker-mark">CSR</span>
                  <h2>Oopsware</h2>
                </div>
                <p>The implementation details appear to have fallen out.</p>
                <p>
                  Made by Celaya Solutions. Built on{" "}
                  <a
                    href="https://github.com/morluto/rea"
                    target="_blank"
                    rel="noreferrer"
                  >
                    REA by morluto and its contributors
                  </a>
                  .
                </p>
                <p>
                  New CSR work is free for noncommercial use under PolyForm
                  Noncommercial. Original MIT code keeps its rights, including
                  commercial use. Third-party tools keep their own licenses.
                </p>
              </section>
              <section className="card appearance">
                <div>
                  <h2>Appearance</h2>
                </div>
                <button
                  onClick={() => setTheme("light")}
                  className={theme === "light" ? "selected" : ""}
                >
                  <Sun size={17} />
                  Light
                </button>
                <button
                  onClick={() => setTheme("dark")}
                  className={theme === "dark" ? "selected" : ""}
                >
                  <Moon size={17} />
                  Dark
                </button>
              </section>
              <Maintenance />
            </>
          )}
        </main>
        <footer className="statusbar">
          <span className="connection-status">
            <i className={workspace ? "live-dot" : "status-dot"} />
            {workspace ? "Connected" : "Connecting…"}
          </span>
          <span className="status-separator" />
          <Cpu size={12} />
          <span className="session-state">
            {session === null
              ? "Checking session…"
              : session.open === true
                ? String(session.path ?? "Active analysis session")
                : session.open === false
                  ? "No binary session"
                  : "Session unavailable"}
          </span>
          <IconButton
            label="Refresh analysis session"
            disabled={!workspace || !!busy}
            onClick={() =>
              void task("Refreshing active session", () =>
                refreshSession(workspace),
              )
            }
          >
            <Activity size={12} />
          </IconButton>
          <span className="statusbar-end">{tools.length} tools</span>
          <Hint content="Files are analyzed on this computer. Models receive context only when you send a request.">
            <span tabIndex={0} className="local-status">
              <ShieldCheck size={12} />
              Local
            </span>
          </Hint>
        </footer>
      </div>
      {assistant && (
        <Chat target={target} run={run} close={() => setAssistant(false)} />
      )}
      <input
        ref={upload}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          void task("Opening files", () => uploadFiles(files));
          e.target.value = "";
        }}
      />
      <Dialog open={browserOpen} onOpenChange={setBrowserOpen}>
        <DialogContent className="file-browser" showCloseButton={false}>
          <DialogTitle className="sr-only">Browse local files</DialogTitle>
          <DialogDescription className="sr-only">
            Choose a file or folder on this computer.
          </DialogDescription>
          <div className="card-heading">
            <h2>Browse local files</h2>
            <IconButton
              label="Close browser"
              onClick={() => setBrowserOpen(false)}
            >
              <X size={18} />
            </IconButton>
          </div>
          <form
            className="path-form"
            onSubmit={(e) => {
              e.preventDefault();
              void task("Browsing", () => browse(path));
            }}
          >
            <input
              aria-label="Browse path"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="Folder path"
            />
            <button type="submit">Go</button>
          </form>
          <div className="browser-location">
            <button
              onClick={() =>
                browser &&
                void task("Opening parent", () => browse(browser.parent))
              }
            >
              <ArrowLeft size={15} />
              Up
            </button>
            <code>{browser?.path}</code>
            <button
              onClick={() =>
                browser &&
                void task("Selecting folder", () => open(browser.path))
              }
            >
              Select this folder
            </button>
          </div>
          <div className="browser-entries">
            {browser?.entries.map((e) => (
              <div className="browser-entry" key={e.path}>
                <button
                  onClick={() =>
                    void task("Opening", () =>
                      e.directory && !e.application
                        ? browse(e.path)
                        : open(e.path),
                    )
                  }
                >
                  {e.directory ? <Folder size={18} /> : <FileText size={18} />}
                  <span>{e.name}</span>
                  <span className="subtle">
                    {e.application
                      ? "Application"
                      : e.directory
                        ? "Folder"
                        : "File"}
                  </span>
                </button>
                {e.directory && (
                  <button
                    onClick={() =>
                      void task("Browsing folder", () => browse(e.path))
                    }
                  >
                    Browse
                  </button>
                )}
              </div>
            ))}
          </div>
          <div className="pagination">
            <span>{browser?.total} entries</span>
            <button
              disabled={!browser?.offset}
              onClick={() =>
                browser &&
                void task("Previous files", () =>
                  browse(browser.path, Math.max(0, browser.offset - 300)),
                )
              }
            >
              Previous
            </button>
            <button
              disabled={browser?.nextOffset == null}
              onClick={() =>
                browser?.nextOffset != null &&
                void task("More files", () =>
                  browse(browser.path, browser.nextOffset ?? 0),
                )
              }
            >
              Next
            </button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={command} onOpenChange={setCommand}>
        <DialogContent className="command-menu" showCloseButton={false}>
          <DialogTitle className="sr-only">Command search</DialogTitle>
          <DialogDescription className="sr-only">
            Search tools and workspace views.
          </DialogDescription>
          <div className="command-input">
            <Search size={20} />
            <input
              autoFocus
              aria-label="Search commands and tools"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Where do you want to go?"
            />
            <kbd>ESC</kbd>
          </div>
          <div className="command-results">
            {sections
              .filter((s) => s.name.toLowerCase().includes(query.toLowerCase()))
              .map(({ name, icon: Icon }) => (
                <button
                  key={name}
                  onClick={() => {
                    nav(name);
                    setCommand(false);
                  }}
                >
                  <Icon size={17} />
                  <span>{name}</span>
                  <small>Navigate</small>
                </button>
              ))}
            {tools
              .filter((t) =>
                `${t.name} ${t.description}`
                  .toLowerCase()
                  .includes(query.toLowerCase()),
              )
              .slice(0, 40)
              .map((t) => (
                <button key={t.name} onClick={() => selectTool(t)}>
                  <Braces size={17} />
                  <span>{pretty(t.name)}</span>
                  <small>{category(t)}</small>
                </button>
              ))}
          </div>
          <div className="command-footer">
            Search the complete tool catalog · ⌘K to toggle
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
  async function openPage(offset: number) {
    if (!target) return;
    const t = await api(
      "/api/open",
      { path: target.path, offset },
      targetSchema,
    );
    setTarget(t);
  }
}
function hex(value: string, offset: number) {
  return (value.match(/.{1,32}/g) ?? [])
    .map(
      (line, i) =>
        `${(offset + i * 16).toString(16).padStart(8, "0")}   ${(line.match(/../g) ?? []).join(" ").padEnd(48)}  ${String.fromCharCode(...(line.match(/../g) ?? []).map((x) => parseInt(x, 16))).replace(/[^\x20-\x7e]/g, ".")}`,
    )
    .join("\n");
}
function Empty({
  icon,
  title,
  body,
}: {
  icon: ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <h2>{title}</h2>
      <p>{body}</p>
    </div>
  );
}
function Connections({
  status,
  refresh,
  task,
}: {
  status: Obj;
  refresh: () => void;
  task: (label: string, fn: () => Promise<void>) => Promise<void>;
}) {
  const [keys, setKeys] = useState<Record<string, string>>({});
  const keyForm = (
    provider: "claude" | "huggingface" | "openrouter",
    placeholder: string,
    label: string,
  ) => (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void task(`Connecting ${label}`, async () => {
          await api(
            `/api/auth/${provider}`,
            { apiKey: keys[provider] ?? "" },
            jsonSchema,
          );
          setKeys({ ...keys, [provider]: "" });
          refresh();
        });
      }}
    >
      <input
        type="password"
        aria-label={`${label} key`}
        autoComplete="off"
        value={keys[provider] ?? ""}
        onChange={(e) => setKeys({ ...keys, [provider]: e.target.value })}
        placeholder={placeholder}
      />
      <button disabled={!keys[provider]}>Connect {label}</button>
    </form>
  );
  const forget = (provider: "huggingface" | "openrouter", label: string) => (
    <button
      onClick={() =>
        void task(`Removing ${label} key`, async () => {
          await api(`/api/auth/${provider}`, { disconnect: true }, jsonSchema);
          refresh();
        })
      }
    >
      Remove saved key
    </button>
  );
  return (
    <section className="card connections">
      <div className="card-heading">
        <h2>Model connections</h2>
        <button onClick={refresh}>Refresh</button>
      </div>
      <p>
        Cloud models receive content only when you send a message. Ollama and LM
        Studio run models on this Mac; OpenAI, Claude, OpenRouter, Hugging Face
        Inference and Ollama cloud models run remotely.
      </p>
      <div className="connection-grid">
        {[
          "ollama",
          "lmstudio",
          "huggingface",
          "openai",
          "claude",
          "openrouter",
        ].map((provider) => {
          const value = status[provider];
          const connection = object(value) ? value : {};
          const models = Array.isArray(connection.models)
            ? connection.models
            : null;
          const state =
            connection.pending === true
              ? "Sign-in pending"
              : connection.connected === true
                ? "Connected"
                : connection.connected === false
                  ? "Not connected"
                  : "Status not reported";
          return (
            <div className="connection" key={provider}>
              <div className="connection-heading">
                <span className="connection-logo" aria-hidden="true">
                  {provider === "claude" ? (
                    <Zap size={20} />
                  ) : (
                    <Cpu size={20} />
                  )}
                </span>
                <h3>{providerLabel(provider)}</h3>
                <span
                  className="connection-state"
                  data-connected={connection.connected === true}
                >
                  {state}
                </span>
              </div>
              <p className="connection-summary">
                {typeof connection.error === "string"
                  ? connection.error
                  : typeof connection.email === "string"
                    ? connection.email
                    : provider === "huggingface"
                      ? `${
                          connection.connected === true
                            ? typeof connection.name === "string"
                              ? `Signed in as ${connection.name}${connection.tokenSource === "huggingface-cli" ? " (hf CLI token)" : connection.tokenSource === "environment" ? " (HF_TOKEN)" : ""}. `
                              : "Token saved. "
                            : "Paste a token for HF Inference models, or run hf auth login. "
                        }${models?.length ?? 0} Hugging Face ${models?.length === 1 ? "model is" : "models are"} installed in Ollama.`
                      : models
                        ? `${models.length} ${models.length === 1 ? "model" : "models"} found${provider === "lmstudio" ? " in LM Studio" : " in Ollama"}`
                        : provider === "claude"
                          ? connection.connected === true
                            ? "Your Anthropic API key is saved."
                            : "Connect with your Anthropic API key."
                          : provider === "openrouter"
                            ? connection.connected === true
                              ? `Your OpenRouter key is ${connection.keySource === "environment" ? "read from OPENROUTER_API_KEY" : "saved"}.`
                              : "The model list is public. Add a key to chat."
                            : "Connect with your OpenAI account."}
              </p>
              {provider === "openai" && (
                <button
                  onClick={() =>
                    void task("Connecting OpenAI", async () => {
                      const r = await api("/api/auth/openai", {}, objectSchema);
                      if (typeof r.url === "string")
                        window.location.assign(r.url);
                      else throw new Error("Connection URL was not returned.");
                    })
                  }
                >
                  Connect OpenAI
                  <ArrowRight size={14} />
                </button>
              )}
              {provider === "ollama" && <OllamaAccount refresh={refresh} />}
              {provider === "claude" &&
                keyForm("claude", "Anthropic API key", "Claude")}
              {provider === "huggingface" &&
                keyForm(
                  "huggingface",
                  "Hugging Face token (hf_…)",
                  "Hugging Face",
                )}
              {provider === "huggingface" &&
                connection.tokenSource === "saved" &&
                forget("huggingface", "Hugging Face")}
              {provider === "openrouter" &&
                keyForm("openrouter", "OpenRouter key (sk-or-…)", "OpenRouter")}
              {provider === "openrouter" &&
                connection.keySource === "saved" &&
                forget("openrouter", "OpenRouter")}
              <details className="connection-details">
                <summary>
                  Connection details{models ? ` · ${models.length} models` : ""}
                </summary>
                <JsonView value={value ?? "Status not reported"} />
              </details>
            </div>
          );
        })}
      </div>
    </section>
  );
}
function providerLabel(provider: string): string {
  return (
    {
      openai: "OpenAI",
      huggingface: "Hugging Face",
      lmstudio: "LM Studio",
      openrouter: "OpenRouter",
    }[provider] ?? pretty(provider)
  );
}
const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <HintProvider>
      <App />
    </HintProvider>,
  );

function inventoryEvidence(value: Json): Obj[] {
  const found = new Map<string, Obj>();
  const visit = (node: Json) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!object(node)) return;
    if (
      node.operation === "inventory_artifact" &&
      node.status === "completed" &&
      object(node.evidence) &&
      typeof node.evidence.evidence_id === "string"
    )
      found.set(node.evidence.evidence_id, node.evidence);
    Object.values(node).forEach(visit);
  };
  visit(value);
  return [...found.values()];
}
