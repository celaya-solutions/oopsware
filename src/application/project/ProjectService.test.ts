import { describe, expect, it } from "vitest";
import { createEvidence } from "../../domain/evidence.js";
import type { ProjectRunRecord } from "../../domain/project/annotationCapture.js";
import type {
  Project,
  ProjectListRow,
} from "../../domain/project/projectSchema.js";
import {
  ProjectConflict,
  ProjectNotFound,
  ProjectService,
  type ProjectStorePort,
} from "./ProjectService.js";

const SHA = "a".repeat(64);
const WORKSPACE = "3d1f6a2c-7b8e-4c5d-9e0f-112233445566";

class MemoryStore implements ProjectStorePort {
  readonly saved = new Map<string, Project>();
  writes = 0;
  async list() {
    const projects: ProjectListRow[] = [...this.saved.values()].map((p) => ({
      id: p.id,
      title: p.title,
      updatedAt: p.updatedAt,
      targets: p.targets.length,
      runs: p.runs.length,
      recovered: false,
    }));
    return { projects, total: projects.length, nextCursor: null };
  }
  async read(id: string) {
    const project = this.saved.get(id);
    return project
      ? { project: structuredClone(project), recovered: false }
      : undefined;
  }
  async write(project: Project) {
    // Yield so overlapping callers would interleave without the service's queue.
    await new Promise((resolve) => setTimeout(resolve, 5));
    this.writes += 1;
    this.saved.set(project.id, structuredClone(project));
  }
  async remove(id: string) {
    return this.saved.delete(id);
  }
  readonly reports = new Map<string, Uint8Array>();
  async writeReport(id: string, file: string, bytes: Uint8Array) {
    this.reports.set(`${id}/${file}`, bytes);
  }
  async readReport(id: string, file: string) {
    return this.reports.get(`${id}/${file}`);
  }
  async removeReport(id: string, file: string) {
    this.reports.delete(`${id}/${file}`);
  }
}

const annotationRun = (status = "completed"): ProjectRunRecord => ({
  id: "00000000-0000-4000-8000-000000000001",
  tool: "set_address_name",
  arguments: { address: "0x1000", name: "decrypt" },
  status,
  createdAt: "2026-10-21T10:00:00.000Z",
  ...(status === "completed"
    ? {
        completedAt: "2026-10-21T10:00:01.000Z",
        result: {
          content: [],
          structuredContent: createEvidence(
            { path: "/tmp/Calculator", sha256: SHA, format: "mach-o" },
            { id: "hopper", name: "Hopper", version: "6.0.0" },
            {
              operation: "set_address_name",
              parameters: { address: "0x1000", name: "decrypt" },
              result: true,
            },
          ),
        },
      }
    : {}),
});

const setup = (runs = new Map<string, ProjectRunRecord>()) => {
  const store = new MemoryStore();
  let tick = 0;
  const service = new ProjectService(
    store,
    async (_workspace, runId) => runs.get(runId),
    async (path) => ({
      name: path.split("/").pop() ?? path,
      kind: path.endsWith("/") ? "folder" : "file",
      size: null,
      sha256: null,
    }),
    {
      clock: () => `2026-10-21T11:00:${String(tick++).padStart(2, "0")}.000Z`,
    },
  );
  return { store, service, runs };
};

describe("ProjectService", () => {
  it("refuses a stale revision and writes nothing", async () => {
    const { store, service } = setup();
    const project = await service.create({ title: "P" });
    await service.edit(project.id, 0, { kind: "add_note", text: "one" });
    const writes = store.writes;
    await expect(
      service.edit(project.id, 0, { kind: "add_note", text: "two" }),
    ).rejects.toBeInstanceOf(ProjectConflict);
    expect(store.writes).toBe(writes);
    expect((await service.get(project.id)).project.notes).toHaveLength(1);
  });

  it("serializes a settling run and an analyst edit on one project", async () => {
    const { service } = setup();
    const project = await service.create({ title: "P" });
    await Promise.all([
      service.linkRun(project.id, WORKSPACE, annotationRun()),
      service.edit(project.id, 0, { kind: "add_note", text: "mine" }).catch(
        // The run may land first; an analyst retry with the new revision follows.
        async (cause: unknown) => {
          if (!(cause instanceof ProjectConflict)) throw cause;
          return service.edit(project.id, 1, {
            kind: "add_note",
            text: "mine",
          });
        },
      ),
    ]);
    const { project: saved } = await service.get(project.id);
    expect(saved.revision).toBe(2);
    expect(saved.renames.map((r) => r.name)).toEqual(["decrypt"]);
    expect(saved.notes.map((n) => n.text)).toEqual(["mine"]);
  });

  it("links a run once and captures it when it settles", async () => {
    const { service } = setup();
    const project = await service.create({ title: "P" });
    await service.linkRun(project.id, WORKSPACE, annotationRun("queued"));
    await service.linkRun(project.id, WORKSPACE, annotationRun());
    const saved = await service.linkRun(project.id, WORKSPACE, annotationRun());
    expect(saved.runs).toHaveLength(1);
    expect(saved.runs[0]).toMatchObject({
      status: "completed",
      completedAt: "2026-10-21T10:00:01.000Z",
      tool: "set_address_name",
    });
    expect(saved.renames).toHaveLength(1);
    expect(saved.targets.map((t) => t.sha256)).toEqual([SHA]);
    expect(saved.runs[0]?.target_id).toBe(saved.targets[0]?.id);
  });

  it("never moves a settled link back to queued", async () => {
    const { service } = setup();
    const project = await service.create({ title: "P" });
    await service.linkRun(project.id, WORKSPACE, annotationRun());
    const late = await service.linkRun(
      project.id,
      WORKSPACE,
      annotationRun("queued"),
    );
    expect(late.runs[0]?.status).toBe("completed");
    expect(late.renames).toHaveLength(1);
  });

  it("missing run archive", async () => {
    const { service } = setup();
    const project = await service.create({ title: "P" });
    await service.linkRun(project.id, WORKSPACE, annotationRun("queued"));
    const refreshed = await service.refreshRuns(project.id);
    expect(refreshed.runs[0]?.status).toBe("missing");
  });

  it("keeps a link pending when its run cannot be read right now", async () => {
    const store = new MemoryStore();
    const service = new ProjectService(
      store,
      async () => {
        throw new Error("disk busy");
      },
      async () => ({ name: "x", kind: "file", size: null, sha256: null }),
    );
    const project = await service.create({ title: "P" });
    await service.linkRun(project.id, WORKSPACE, annotationRun("running"));
    const refreshed = await service.refreshRuns(project.id);
    expect(refreshed.runs[0]?.status).toBe("running");
  });

  it("refresh settles non-terminal links", async () => {
    const runs = new Map<string, ProjectRunRecord>();
    const { service } = setup(runs);
    const project = await service.create({ title: "P" });
    await service.linkRun(project.id, WORKSPACE, annotationRun("running"));
    runs.set(annotationRun().id, annotationRun());
    const refreshed = await service.refreshRuns(project.id);
    expect(refreshed.runs[0]?.status).toBe("completed");
    expect(refreshed.targets).toHaveLength(1);
  });

  it("adds a folder target with an unknown digest", async () => {
    const { service } = setup();
    const project = await service.create({ title: "P" });
    const saved = await service.addTarget(project.id, 0, "/tmp/folder/");
    expect(saved.targets[0]).toMatchObject({
      kind: "folder",
      sha256: null,
      source: "manual",
    });
  });

  it("links an existing stored run by id and refuses an unknown one", async () => {
    const runs = new Map([[annotationRun().id, annotationRun()]]);
    const { service } = setup(runs);
    const project = await service.create({ title: "P" });
    const saved = await service.linkStoredRun(
      project.id,
      WORKSPACE,
      annotationRun().id,
    );
    expect(saved.runs.map((link) => link.status)).toEqual(["completed"]);
    await expect(
      service.linkStoredRun(project.id, WORKSPACE, crypto.randomUUID()),
    ).rejects.toThrow(/not in that workspace/);
  });

  it("refuses to delete a project from a stale revision", async () => {
    const { service } = setup();
    const project = await service.create({ title: "P" });
    await service.edit(project.id, 0, { kind: "add_note", text: "kept" });
    await expect(service.remove(project.id, 0)).rejects.toBeInstanceOf(
      ProjectConflict,
    );
    await service.remove(project.id, 1);
    await expect(service.get(project.id)).rejects.toBeInstanceOf(
      ProjectNotFound,
    );
  });
});

describe("ProjectService settling", () => {
  it("records a settled run even when its file cannot be added", async () => {
    const { store, service } = setup();
    const project = await service.create({ title: "P" });
    const full = {
      ...(await service.get(project.id)).project,
      targets: Array.from({ length: 200 }, (_, index) => ({
        id: crypto.randomUUID(),
        name: `f${index}`,
        path: `/tmp/f${index}`,
        kind: "file" as const,
        size: null,
        sha256: index.toString(16).padStart(64, "0"),
        format: null,
        architecture: null,
        addedAt: "2026-10-21T10:00:00.000Z",
        source: "manual" as const,
      })),
    };
    await store.write(full);
    await service.linkRun(project.id, WORKSPACE, annotationRun("running"));
    const saved = await service.linkRun(project.id, WORKSPACE, annotationRun());
    expect(saved.runs[0]?.status).toBe("completed");
    expect(saved.runs[0]?.problem).toMatch(/200 targets/);
    expect(saved.renames).toHaveLength(1);
    await expect(service.refreshRuns(project.id)).resolves.toBeDefined();
  });

  it("does not write when a link changes nothing", async () => {
    const { store, service } = setup();
    const project = await service.create({ title: "P" });
    await service.linkRun(project.id, WORKSPACE, annotationRun());
    const writes = store.writes;
    const late = await service.linkRun(
      project.id,
      WORKSPACE,
      annotationRun("queued"),
    );
    expect(store.writes).toBe(writes);
    expect(late.revision).toBe(1);
  });

  it("marks a settled link missing when its archive is gone", async () => {
    const store = new MemoryStore();
    const service = new ProjectService(
      store,
      async () => undefined,
      async () => ({ name: "x", kind: "file", size: null, sha256: null }),
      {
        clock: () => "2026-10-21T11:00:00.000Z",
        runExists: async () => false,
      },
    );
    const project = await service.create({ title: "P" });
    await service.linkRun(project.id, WORKSPACE, annotationRun());
    const refreshed = await service.refreshRuns(project.id);
    expect(refreshed.runs[0]?.status).toBe("missing");
    expect(refreshed.renames).toHaveLength(1);
  });

  it("reports a missing project", async () => {
    const { service } = setup();
    await expect(service.get(crypto.randomUUID())).rejects.toBeInstanceOf(
      ProjectNotFound,
    );
  });
});
