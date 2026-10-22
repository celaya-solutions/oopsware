import { afterEach, expect, it } from "vitest";
import { appendFile, copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { startReaWeb } from "../../../src/web/WebServer.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

const projectBody = z.object({
  project: z
    .object({
      id: z.string(),
      revision: z.number(),
      runs: z.array(
        z.object({ run_id: z.string(), status: z.string() }).passthrough(),
      ),
      reports: z.array(
        z
          .object({ id: z.string(), format: z.string(), bytes: z.number() })
          .passthrough(),
      ),
    })
    .passthrough(),
});
const errorBody = z.object({ error: z.string(), message: z.string() });

const start = async (
  directory?: string,
  environment: Record<string, string | undefined> = process.env,
) => {
  const root = directory ?? (await mkdtemp(join(tmpdir(), "rea-reports-web-")));
  if (!directory)
    cleanups.push(() => rm(root, { recursive: true, force: true }));
  const app = await startReaWeb({ port: 0, directory: root, environment });
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
  const get = async (id: string) =>
    projectBody.parse(await (await request(`/api/projects/${id}`)).json())
      .project;
  return { root, close, request, get };
};

/** A project with one completed inspect_artifact run on a copied file. */
const linkedProject = async (app: Awaited<ReturnType<typeof start>>) => {
  const created = await app.request("/api/projects", {
    title: "Echo <study>",
  });
  const project = projectBody.parse(await created.json()).project;
  const sample = join(app.root, "echo");
  await copyFile("/bin/echo", sample);
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
  const runId = (await app.get(project.id)).runs[0]!.run_id;
  return { project, sample, workspace, runId };
};

it("builds, saves, rechecks, downloads and deletes a project report", async () => {
  const app = await start();
  const { project, sample } = await linkedProject(app);
  const built = await app.request(`/api/projects/${project.id}/reports`, {
    format: "html",
  });
  expect(built.status).toBe(201);
  const saved = projectBody.parse(await built.json()).project;
  const entry = saved.reports[0]!;
  expect(entry).toEqual(expect.objectContaining({ format: "html" }));
  const file = await app.request(
    `/api/projects/${project.id}/reports/${entry.id}`,
  );
  expect(file.status).toBe(200);
  expect(file.headers.get("content-type")).toMatch(/^text\/html/);
  expect(file.headers.get("content-disposition")).toMatch(
    /^attachment; filename="oopsware-echo-study-\d{4}-\d\d-\d\d\.html"$/,
  );
  const html = await file.text();
  expect(html).toContain("Echo &lt;study&gt;");
  expect(html).toContain("Same as when added");
  expect(html).toContain("(inspect_artifact)");
  expect(Buffer.byteLength(html)).toBe(entry.bytes);

  // The target changes after it was added: the next report says so.
  await appendFile(sample, "changed");
  const second = await app.request(`/api/projects/${project.id}/reports`, {
    format: "html",
  });
  const again = projectBody.parse(await second.json()).project;
  const latest = again.reports[1]!;
  const changed = await (
    await app.request(`/api/projects/${project.id}/reports/${latest.id}`)
  ).text();
  expect(changed).toContain("Changed since it was added");

  // Saved reports survive a restart; deleting one removes its file.
  await app.close();
  const restarted = await start(app.root);
  expect((await restarted.get(project.id)).reports).toHaveLength(2);
  const deleted = await restarted.request(
    `/api/projects/${project.id}/reports/${entry.id}/delete`,
    { revision: again.revision },
  );
  expect(deleted.status).toBe(200);
  expect(
    (await restarted.request(`/api/projects/${project.id}/reports/${entry.id}`))
      .status,
  ).toBe(404);
});

it("builds a one-run report without saving it", async () => {
  const app = await start();
  const { project, workspace, runId } = await linkedProject(app);
  const response = await app.request("/api/reports/run", {
    workspaceId: workspace,
    runId,
    format: "html",
  });
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("<h2>Findings</h2>");
  expect((await app.get(project.id)).reports).toHaveLength(0);
  const unknown = await app.request("/api/reports/run", {
    workspaceId: workspace,
    runId: crypto.randomUUID(),
    format: "html",
  });
  expect(unknown.status).toBe(404);
});

it("refuses runs that are not linked and unknown reports", async () => {
  const app = await start();
  const { project, workspace } = await linkedProject(app);
  const foreign = await app.request(`/api/projects/${project.id}/reports`, {
    format: "html",
    runs: [{ workspace_id: workspace, run_id: crypto.randomUUID() }],
  });
  expect(foreign.status).toBe(400);
  expect(errorBody.parse(await foreign.json()).message).toMatch(/not linked/);
  expect(
    (await app.request(`/api/projects/${project.id}/reports/not-a-uuid`))
      .status,
  ).toBe(404);
});

it("says plainly when no browser can print a PDF", async () => {
  const app = await start(undefined, {
    ...process.env,
    REA_BROWSER_EXECUTABLE: "/nonexistent/chrome",
  });
  const status = z
    .object({ available: z.boolean(), reason: z.string() })
    .parse(await (await app.request("/api/reports/status")).json());
  expect(status).toEqual({
    available: false,
    reason: expect.stringContaining("REA_BROWSER_EXECUTABLE"),
  });
  const created = await app.request("/api/projects", { title: "No browser" });
  const project = projectBody.parse(await created.json()).project;
  const pdf = await app.request(`/api/projects/${project.id}/reports`, {
    format: "pdf",
  });
  expect(pdf.status).toBe(409);
  expect(errorBody.parse(await pdf.json()).error).toBe("pdf_unavailable");
  expect((await app.get(project.id)).reports).toHaveLength(0);
});

it.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
  "prints a PDF with an installed browser when there is one",
  async () => {
    const app = await start();
    const status = z
      .object({ available: z.boolean() })
      .parse(await (await app.request("/api/reports/status")).json());
    if (!status.available) return;
    const { project } = await linkedProject(app);
    const built = await app.request(`/api/projects/${project.id}/reports`, {
      format: "pdf",
    });
    expect(built.status).toBe(201);
    const entry = projectBody.parse(await built.json()).project.reports[0]!;
    const file = await app.request(
      `/api/projects/${project.id}/reports/${entry.id}`,
    );
    expect(file.headers.get("content-type")).toBe("application/pdf");
    const bytes = new Uint8Array(await file.arrayBuffer());
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe("%PDF-");
  },
  90_000,
);

it("opens a saved report once through a view link with its own policy", async () => {
  const app = await start();
  const created = await app.request("/api/projects", { title: "View link" });
  const project = projectBody.parse(await created.json()).project;
  const built = await app.request(`/api/projects/${project.id}/reports`, {
    format: "html",
  });
  const entry = projectBody.parse(await built.json()).project.reports[0]!;
  const reply = await app.request(
    `/api/projects/${project.id}/reports/${entry.id}/view`,
    {},
  );
  const { url } = z.object({ url: z.string() }).parse(await reply.json());
  const base = new URL(url, `http://${new URL(reply.url).host}`).toString();
  // A new tab carries no page token; the link alone opens the report.
  const first = await fetch(base);
  expect(first.status).toBe(200);
  expect(first.headers.get("content-security-policy")).toBe(
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  );
  expect(first.headers.get("content-disposition")).toMatch(/^inline;/);
  expect(await first.text()).toContain("<h1>View link</h1>");
  expect((await fetch(base)).status).toBe(404);
  expect(
    (await fetch(new URL(`/report-view/${"a".repeat(43)}`, base))).status,
  ).toBe(404);
});
