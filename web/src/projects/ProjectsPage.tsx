import { useEffect, useState } from "react";
import {
  FolderKanban,
  FolderOpen,
  Plus,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  type Project,
  type ProjectRow,
} from "./projectApi";

const when = (iso: string) =>
  iso
    ? new Date(iso).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "—";

/** Every saved project, newest first, with create, open and delete. */
export function ProjectsPage({
  openId,
  onOpen,
  onDeleted,
  task,
}: {
  openId: string | undefined;
  onOpen: (project: Project) => void;
  onDeleted: (id: string) => void;
  task: (label: string, fn: () => Promise<void>) => Promise<void>;
}) {
  const [rows, setRows] = useState<ProjectRow[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [title, setTitle] = useState("");
  const [doomed, setDoomed] = useState<ProjectRow>();

  const load = async (cursor?: string) => {
    const page = await listProjects(cursor);
    setRows((previous) =>
      cursor ? [...previous, ...page.projects] : page.projects,
    );
    setNext(page.nextCursor);
    setTotal(page.total);
  };
  useEffect(() => {
    void task("Loading projects", () => load());
  }, []);

  return (
    <section className="card projects-page" aria-label="Projects">
      <div className="section-title">
        <FolderKanban size={19} />
        <h2>Projects</h2>
        <span className="badge">{total}</span>
      </div>
      <p className="subtle projects-lede">
        A project keeps the files you looked at, your notes, bookmarks and
        names, and the runs behind them, so you can come back to it later.
      </p>
      <form
        className="project-create"
        onSubmit={(event) => {
          event.preventDefault();
          const name = title.trim();
          if (!name) return;
          void task("Creating project", async () => {
            const project = await createProject(name);
            setTitle("");
            await load();
            onOpen(project);
          });
        }}
      >
        <input
          aria-label="New project title"
          placeholder="Name a new project…"
          maxLength={200}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <Button type="submit" size="sm" disabled={!title.trim()}>
          <Plus size={14} />
          New project
        </Button>
      </form>
      {rows.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">
            <FolderKanban size={28} />
          </div>
          <h2>No projects yet</h2>
          <p>
            Name one above. Runs you start while it is open are saved to it.
          </p>
        </div>
      ) : (
        <ul className="project-list">
          {rows.map((row) => (
            <li
              key={row.id}
              className={
                row.id === openId ? "project-row active" : "project-row"
              }
            >
              <div className="project-row-main">
                <strong>{row.title}</strong>
                <small className="subtle">
                  {row.unreadable ??
                    `Updated ${when(row.updatedAt)} · ${row.targets} file${row.targets === 1 ? "" : "s"} · ${row.runs} run${row.runs === 1 ? "" : "s"}`}
                </small>
                {row.recovered && (
                  <span
                    className="badge caution"
                    title="The main file was damaged; the last good copy was opened."
                  >
                    <TriangleAlert size={12} /> Recovered
                  </span>
                )}
              </div>
              <div className="project-row-actions">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={row.unreadable !== undefined}
                  onClick={() =>
                    void task("Opening project", async () =>
                      onOpen(await getProject(row.id)),
                    )
                  }
                >
                  <FolderOpen size={14} />
                  Open
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Delete ${row.title}`}
                  disabled={row.unreadable !== undefined}
                  onClick={() => setDoomed(row)}
                >
                  <Trash2 size={14} />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {next && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void task("Loading projects", () => load(next))}
        >
          Show more projects
        </Button>
      )}
      <Dialog
        open={doomed !== undefined}
        onOpenChange={(open) => !open && setDoomed(undefined)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete “{doomed?.title}”?</DialogTitle>
            <DialogDescription>
              This removes the project, its notes, bookmarks, names and saved
              reports. The runs themselves stay in their workspaces.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDoomed(undefined)}>
              Keep it
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const row = doomed;
                if (!row) return;
                setDoomed(undefined);
                void task("Deleting project", async () => {
                  await deleteProject(await getProject(row.id));
                  onDeleted(row.id);
                  await load();
                });
              }}
            >
              Delete project
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
