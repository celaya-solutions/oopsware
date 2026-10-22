import { afterEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { startReaWeb } from "../../../src/web/WebServer.js";
import { sessionIdentityFrom } from "../../../src/web/ProjectRoutes.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

const projectBody = z.object({
  project: z
    .object({
      id: z.string(),
      title: z.string(),
      revision: z.number(),
      notes: z.array(z.object({ text: z.string() }).passthrough()),
      targets: z.array(
        z
          .object({ path: z.string(), sha256: z.string().nullable() })
          .passthrough(),
      ),
      runs: z.array(
        z
          .object({ run_id: z.string(), status: z.string(), tool: z.string() })
          .passthrough(),
      ),
    })
    .passthrough(),
});
const errorBody = z.object({ error: z.string(), message: z.string() });

const start = async (directory?: string) => {
  const root =
    directory ?? (await mkdtemp(join(tmpdir(), "rea-projects-web-")));
  if (!directory)
    cleanups.push(() => rm(root, { recursive: true, force: true }));
  const app = await startReaWeb({ port: 0, directory: root });
  let closed = false;
  const close = async () => {
    if (!closed) {
      closed = true;
      await app.close();
    }
  };
  cleanups.push(close);
  const html = await (await fetch(app.url)).text();
  const token = /name="rea-token" content="([^"]+)"/.exec(html)?.[1];
  if (!token) throw new Error("Missing page token");
  const request = (path: string, body?: unknown) =>
    fetch(`${app.url}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "x-rea-token": token,
        Origin: app.url,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const create = async (title: string) => {
    const response = await request("/api/projects", { title });
    expect(response.status).toBe(201);
    return projectBody.parse(await response.json()).project;
  };
  const get = async (id: string) =>
    projectBody.parse(await (await request(`/api/projects/${id}`)).json())
      .project;
  return { root, close, request, create, get };
};

it("creates, lists, reads and deletes a project", async () => {
  const app = await start();
  const project = await app.create("Calculator study");
  const listed = z
    .object({
      projects: z.array(z.object({ id: z.string(), title: z.string() })),
    })
    .parse(await (await app.request("/api/projects")).json());
  expect(listed.projects).toEqual([
    expect.objectContaining({ id: project.id, title: "Calculator study" }),
  ]);
  expect((await app.get(project.id)).title).toBe("Calculator study");
  const deleted = await app.request(`/api/projects/${project.id}/delete`, {
    revision: 0,
  });
  expect(deleted.status).toBe(200);
  expect((await app.request(`/api/projects/${project.id}`)).status).toBe(404);
});

it("stale revision is refused", async () => {
  const app = await start();
  const project = await app.create("Two tabs");
  const edit = (text: string) =>
    app.request(`/api/projects/${project.id}/edit`, {
      revision: 0,
      edit: { kind: "add_note", text },
    });
  expect((await edit("first tab")).status).toBe(200);
  const second = await edit("second tab");
  expect(second.status).toBe(409);
  expect(errorBody.parse(await second.json()).error).toBe("project_conflict");
  expect((await app.get(project.id)).notes.map((note) => note.text)).toEqual([
    "first tab",
  ]);
});

it("oversize body", async () => {
  const app = await start();
  const project = await app.create("Big note");
  const response = await app.request(`/api/projects/${project.id}/edit`, {
    revision: 0,
    edit: { kind: "add_note", text: "x".repeat(70 * 1024) },
  });
  expect(response.status).toBe(400);
  expect(errorBody.parse(await response.json()).message).toMatch(/64 KiB/);
});

it("links a run started with a project and keeps it across a restart", async () => {
  const app = await start();
  const project = await app.create("Linked runs");
  const sample = join(app.root, "echo");
  await copyFile("/bin/echo", sample);
  const sha256 = createHash("sha256")
    .update(await readFile(sample))
    .digest("hex");
  const workspace = z
    .object({ id: z.string() })
    .parse(await (await app.request("/api/workspace", {})).json()).id;
  const queued = await app.request(`/api/workspace/${workspace}/run`, {
    tool: "inspect_artifact",
    arguments: {},
    targetPath: sample,
    project: project.id,
  });
  expect(queued.status).toBe(202);
  await expect
    .poll(async () => (await app.get(project.id)).runs[0]?.status, {
      timeout: 30_000,
      interval: 50,
    })
    .toBe("completed");
  const linked = await app.get(project.id);
  expect(linked.runs).toHaveLength(1);
  expect(linked.targets).toEqual([
    expect.objectContaining({ path: sample, sha256 }),
  ]);
  await app.close();
  const restarted = await start(app.root);
  const reopened = await restarted.get(project.id);
  expect(reopened.runs.map((run) => run.run_id)).toEqual(
    linked.runs.map((run) => run.run_id),
  );
  expect(reopened.targets).toHaveLength(1);
});

it("refuses a run for a project that does not exist", async () => {
  const app = await start();
  const workspace = z
    .object({ id: z.string() })
    .parse(await (await app.request("/api/workspace", {})).json()).id;
  const response = await app.request(`/api/workspace/${workspace}/run`, {
    tool: "binary_session",
    arguments: {},
    project: crypto.randomUUID(),
  });
  expect(response.status).toBe(404);
});

it("answers 404 for unknown and malformed project ids", async () => {
  const app = await start();
  const unknown = await app.request(
    `/api/projects/${crypto.randomUUID()}/edit`,
    {
      revision: 0,
      edit: { kind: "add_note", text: "x" },
    },
  );
  expect(unknown.status).toBe(404);
  expect((await app.request("/api/projects/not-a-uuid")).status).toBe(404);
});

it("adds a target by path with its digest", async () => {
  const app = await start();
  const project = await app.create("Targets");
  const file = join(app.root, "app.bin");
  await writeFile(file, "binary bytes");
  const response = await app.request(`/api/projects/${project.id}/targets`, {
    revision: 0,
    path: file,
  });
  expect(response.status).toBe(200);
  expect(projectBody.parse(await response.json()).project.targets).toEqual([
    expect.objectContaining({
      path: file,
      sha256: createHash("sha256").update("binary bytes").digest("hex"),
    }),
  ]);
});

it("reads identity, provider, profile and capabilities from an open session", () => {
  const capability = (operations: string[]) => ({
    provider: { id: "hopper", name: "Hopper", version: "6" },
    shared_limitations: [],
    groups: [
      {
        operations,
        available: true,
        reason: null,
        availability_code: "available",
        effects: [],
        limitations: [],
      },
    ],
  });
  const identity = sessionIdentityFrom({
    structuredContent: {
      result: {
        open: true,
        sha256: "b".repeat(64),
        capabilities: [capability(["set_addresses_names", "set_comment"])],
        analysis_provider_binding: {
          provider: { id: "hopper", name: "Hopper", version: "6" },
          analysis_profile: { digest: "d".repeat(64) },
        },
      },
    },
  });
  expect(identity).toMatchObject({
    sha256: "b".repeat(64),
    provider_id: "hopper",
    profile_digest: "d".repeat(64),
  });
});

it("refuses an apply plan when no native session is open", async () => {
  const app = await start();
  const project = await app.create("Apply");
  const workspace = z
    .object({ id: z.string() })
    .parse(await (await app.request("/api/workspace", {})).json()).id;
  const response = await app.request(`/api/projects/${project.id}/apply-plan`, {
    targetSha256: "a".repeat(64),
    workspaceId: workspace,
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    plan: { ok: false, reason: "The open session's identity is unknown." },
  });
});
