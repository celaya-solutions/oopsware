import {
  applyCaptures,
  captureAnnotations,
  targetFromRun,
  type ProjectRunRecord,
} from "../../domain/project/annotationCapture.js";
import {
  planApplyToSession,
  type ApplyPlan,
  type SessionIdentity,
} from "../../domain/project/applyPlan.js";
import {
  applyProjectEdit,
  createProject,
  limit,
  withTarget,
  type ProjectEdit,
} from "../../domain/project/projectEdits.js";
import {
  PROJECT_LIMITS,
  ProjectEditError,
  projectSchema,
  type Project,
  type ProjectListRow,
  type ProjectReportEntry,
  type ProjectRunLink,
} from "../../domain/project/projectSchema.js";

/** Storage a project service needs; the filesystem store satisfies it. */
export interface ProjectStorePort {
  list(
    cursor?: string,
    limit?: number,
  ): Promise<{
    projects: ProjectListRow[];
    total: number;
    nextCursor: string | null;
  }>;
  read(
    id: string,
  ): Promise<{ project: Project; recovered: boolean } | undefined>;
  write(project: Project): Promise<void>;
  remove(id: string): Promise<boolean>;
  writeReport(id: string, file: string, bytes: Uint8Array): Promise<void>;
  readReport(id: string, file: string): Promise<Uint8Array | undefined>;
  removeReport(id: string, file: string): Promise<void>;
}

/** Read one stored run by its workspace; undefined when its archive is gone. */
export type RunReader = (
  workspaceId: string,
  runId: string,
) => Promise<ProjectRunRecord | undefined>;

/** Describe a local path for a hand-added target. */
export type FileIdentityReader = (
  path: string,
  signal?: AbortSignal,
) => Promise<{
  name: string;
  kind: "file" | "folder" | "bundle";
  size: number | null;
  sha256: string | null;
}>;

export class ProjectNotFound extends Error {
  readonly _tag = "ProjectNotFound";
  constructor() {
    super("This project does not exist.");
  }
}

export class ProjectConflict extends Error {
  readonly _tag = "ProjectConflict";
  constructor() {
    super("This project changed in another tab. Reload it.");
  }
}

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const linkStatus = (status: string): ProjectRunLink["status"] =>
  status === "queued" || status === "running" || TERMINAL.has(status)
    ? (status as ProjectRunLink["status"])
    : "failed";

/** Own project revisions, one writer per project, and run linking. */
export class ProjectService {
  readonly #queues = new Map<string, Promise<unknown>>();
  private readonly clock: () => string;
  private readonly runExists: (
    workspaceId: string,
    runId: string,
  ) => Promise<boolean>;

  constructor(
    private readonly store: ProjectStorePort,
    private readonly readRun: RunReader,
    private readonly identify: FileIdentityReader,
    options: {
      readonly clock?: () => string;
      /** False only when a linked run's archive is known to be gone. */
      readonly runExists?: (
        workspaceId: string,
        runId: string,
      ) => Promise<boolean>;
    } = {},
  ) {
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.runExists = options.runExists ?? (async () => true);
  }

  /** Run one read-modify-write at a time per project. */
  #serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(id) ?? Promise.resolve();
    const next = previous.then(work, work);
    const settled = next.catch(() => undefined);
    this.#queues.set(id, settled);
    void settled.then(() => {
      if (this.#queues.get(id) === settled) this.#queues.delete(id);
    });
    return next;
  }

  async #load(id: string): Promise<Project> {
    const found = await this.store.read(id);
    if (!found) throw new ProjectNotFound();
    return found.project;
  }

  async #mutate(
    id: string,
    revision: number | undefined,
    change: (project: Project, now: string) => Project,
  ): Promise<Project> {
    return this.#serial(id, async () => {
      const project = await this.#load(id);
      if (revision !== undefined && revision !== project.revision)
        throw new ProjectConflict();
      const now = this.clock();
      const changed = change(project, now);
      // Nothing changed (a late snapshot, a repeated link): keep the revision.
      if (JSON.stringify(changed) === JSON.stringify(project)) return project;
      const next = projectSchema.parse({
        ...changed,
        revision: project.revision + 1,
        updatedAt: now,
      });
      await this.store.write(next);
      return next;
    });
  }

  async create(input: {
    title: string;
    description?: string | undefined;
  }): Promise<Project> {
    const project = createProject(
      {
        id: crypto.randomUUID(),
        title: input.title,
        ...(input.description === undefined
          ? {}
          : { description: input.description }),
      },
      this.clock(),
    );
    await this.store.write(project);
    return project;
  }

  list(cursor?: string, limit?: number) {
    return this.store.list(cursor, limit);
  }

  async get(id: string): Promise<{ project: Project; recovered: boolean }> {
    const found = await this.store.read(id);
    if (!found) throw new ProjectNotFound();
    return found;
  }

  edit(id: string, revision: number, edit: ProjectEdit): Promise<Project> {
    return this.#mutate(id, revision, (project, now) => {
      const result = applyProjectEdit(project, edit, now);
      if (!result.ok) throw result.error;
      return result.value;
    });
  }

  /** Delete a project and its saved reports, only from its current revision. */
  async remove(id: string, revision: number): Promise<void> {
    await this.#serial(id, async () => {
      const project = await this.#load(id);
      if (project.revision !== revision) throw new ProjectConflict();
      if (!(await this.store.remove(id))) throw new ProjectNotFound();
    });
  }

  async addTarget(
    id: string,
    revision: number,
    path: string,
  ): Promise<Project> {
    const identity = await this.identify(path);
    return this.#mutate(id, revision, (project, now) =>
      withTarget(project, {
        id: crypto.randomUUID(),
        name: identity.name,
        path,
        kind: identity.kind,
        size: identity.size,
        sha256: identity.sha256,
        format: null,
        architecture: null,
        addedAt: now,
        source: "manual",
      }),
    );
  }

  /** Link or refresh one run; a settled run adds its target and copies its annotations. */
  linkRun(
    id: string,
    workspaceId: string,
    run: ProjectRunRecord,
  ): Promise<Project> {
    return this.#mutate(id, undefined, (project, now) =>
      this.#withRun(project, workspaceId, run, now),
    );
  }

  #withRun(
    project: Project,
    workspaceId: string,
    run: ProjectRunRecord,
    now: string,
  ): Project {
    const existing = project.runs.find(
      (link) => link.workspace_id === workspaceId && link.run_id === run.id,
    );
    if (!existing) limit(project.runs.length, PROJECT_LIMITS.runs, "run links");
    // A settled link is final: later snapshots (accept-time, repeats) change nothing.
    if (existing && TERMINAL.has(existing.status)) return project;
    const status = linkStatus(run.status);
    const settled = TERMINAL.has(status)
      ? this.#settle(project, workspaceId, run, now)
      : { project, targetId: undefined, problems: [] };
    const next = settled.project;
    const targetId = settled.targetId ?? existing?.target_id ?? null;
    const problems = settled.problems;
    const link: ProjectRunLink = {
      workspace_id: workspaceId,
      run_id: run.id,
      tool: run.tool,
      status,
      createdAt: run.createdAt,
      completedAt: run.completedAt ?? null,
      target_id: targetId,
      linkedAt: existing?.linkedAt ?? now,
      problem: problems.length ? problems.join(" ").slice(0, 1000) : null,
    };
    return {
      ...next,
      runs: existing
        ? next.runs.map((item) =>
            item.workspace_id === workspaceId && item.run_id === run.id
              ? link
              : item,
          )
        : [...next.runs, link],
    };
  }

  /**
   * Add a settled run's file and copy its annotations. A refused file or
   * capture becomes a problem on the link instead of blocking the project.
   */
  #settle(
    project: Project,
    workspaceId: string,
    run: ProjectRunRecord,
    now: string,
  ): {
    project: Project;
    targetId: string | null | undefined;
    problems: string[];
  } {
    let next = project;
    let targetId: string | null | undefined;
    const problems: string[] = [];
    const target = targetFromRun(run, now);
    if (target) {
      try {
        next = withTarget(next, target);
      } catch (cause) {
        if (!(cause instanceof ProjectEditError)) throw cause;
        problems.push(`File not added: ${cause.message}`);
      }
      targetId =
        next.targets.find((item) =>
          target.sha256 === null
            ? item.sha256 === null && item.path === target.path
            : item.sha256 === target.sha256,
        )?.id ?? null;
    }
    const captured = applyCaptures(
      next,
      captureAnnotations(run, workspaceId),
      now,
    );
    if (captured.ok) next = captured.value;
    else problems.push(`Changes not copied: ${captured.error.message}`);
    return { project: next, targetId, problems };
  }

  /** Link a run that already exists in a workspace's history. */
  async linkStoredRun(
    id: string,
    workspaceId: string,
    runId: string,
  ): Promise<Project> {
    const run = await this.readRun(workspaceId, runId);
    if (!run)
      throw new ProjectEditError(
        "That run is not in that workspace's history.",
      );
    return this.linkRun(id, workspaceId, run);
  }

  /** Settle links left queued or running, e.g. after a restart; gone archives become missing. */
  async refreshRuns(id: string): Promise<Project> {
    const project = await this.#load(id);
    const pending = project.runs.filter(
      (link) => link.status === "queued" || link.status === "running",
    );
    const gone = await this.#goneArchives(project);
    if (pending.length === 0 && gone.size === 0) return project;
    // A read that fails (busy disk, closing server) leaves the link as it is;
    // only an archive that is really gone becomes "missing".
    const reads = await Promise.all(
      pending.map(async (link) => {
        try {
          return {
            link,
            read: true,
            run: await this.readRun(link.workspace_id, link.run_id),
          };
        } catch {
          return { link, read: false, run: undefined };
        }
      }),
    );
    if (reads.every((item) => !item.read) && gone.size === 0) return project;
    const key = (link: ProjectRunLink) => `${link.workspace_id}/${link.run_id}`;
    return this.#mutate(id, undefined, (current, now) =>
      reads.reduce(
        (next, { link, read, run }) => {
          if (!read) return next;
          if (run) return this.#withRun(next, link.workspace_id, run, now);
          return {
            ...next,
            runs: next.runs.map((item) =>
              item.workspace_id === link.workspace_id &&
              item.run_id === link.run_id
                ? { ...item, status: "missing" as const }
                : item,
            ),
          };
        },
        {
          ...current,
          runs: current.runs.map((item) =>
            gone.has(key(item))
              ? { ...item, status: "missing" as const }
              : item,
          ),
        },
      ),
    );
  }

  /** Settled links whose run archive is known to be gone; unknown stays as is. */
  async #goneArchives(project: Project): Promise<Set<string>> {
    const settled = project.runs.filter((link) => TERMINAL.has(link.status));
    const checks = await Promise.all(
      settled.map(async (link) => ({
        link,
        exists: await this.runExists(link.workspace_id, link.run_id).catch(
          () => true,
        ),
      })),
    );
    return new Set(
      checks
        .filter((item) => !item.exists)
        .map(({ link }) => `${link.workspace_id}/${link.run_id}`),
    );
  }

  /** Save a built report: the file first, then its entry; a failed entry removes the file. */
  async addReport(
    id: string,
    entry: ProjectReportEntry,
    bytes: Uint8Array,
  ): Promise<Project> {
    limit(
      (await this.#load(id)).reports.length,
      PROJECT_LIMITS.reports,
      "reports",
    );
    await this.store.writeReport(id, entry.file, bytes);
    try {
      return await this.#mutate(id, undefined, (project) => {
        limit(project.reports.length, PROJECT_LIMITS.reports, "reports");
        return { ...project, reports: [...project.reports, entry] };
      });
    } catch (cause) {
      await this.store.removeReport(id, entry.file).catch(() => undefined);
      throw cause;
    }
  }

  /** Remove a saved report's entry, then its file. */
  async removeReport(
    id: string,
    revision: number,
    reportId: string,
  ): Promise<Project> {
    let file: string | undefined;
    const project = await this.#mutate(id, revision, (current) => {
      file = current.reports.find((item) => item.id === reportId)?.file;
      if (file === undefined)
        throw new ProjectEditError("No report with that id in this project.");
      return {
        ...current,
        reports: current.reports.filter((item) => item.id !== reportId),
      };
    });
    if (file !== undefined) await this.store.removeReport(id, file);
    return project;
  }

  /** A saved report's entry and bytes; undefined when either is gone. */
  async readReport(
    id: string,
    reportId: string,
  ): Promise<{ entry: ProjectReportEntry; bytes: Uint8Array } | undefined> {
    const entry = (await this.#load(id)).reports.find(
      (item) => item.id === reportId,
    );
    if (!entry) return undefined;
    const bytes = await this.store.readReport(id, entry.file);
    return bytes ? { entry, bytes } : undefined;
  }

  async planApply(
    id: string,
    targetSha256: string,
    session: SessionIdentity,
  ): Promise<ApplyPlan> {
    return planApplyToSession(await this.#load(id), targetSha256, session);
  }
}

export { ProjectEditError };
