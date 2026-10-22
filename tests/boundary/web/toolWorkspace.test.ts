import { afterEach, expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  copyFile,
  stat,
  rename,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { CallToolResultSchema } from "@modelcontextprotocol/core";
import { startReaWeb } from "../../../src/web/WebServer.js";
import { TOOL_CONTRACTS } from "../../../src/contracts/toolContracts.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const runEnvelope = z.object({
  run: z
    .object({
      id: z.string(),
      status: z.string(),
      result: z.unknown().optional(),
      error: z.string().optional(),
    })
    .passthrough(),
});
const workspaceEnvelope = z.object({
  id: z.string(),
  runs: z.array(runEnvelope.shape.run),
});
const start = async (directory?: string) => {
  const root = directory ?? (await mkdtemp(join(tmpdir(), "rea-tool-web-")));
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
  const workspace = async () =>
    workspaceEnvelope.parse(await (await request("/api/workspace", {})).json())
      .id;
  const run = async (
    id: string,
    tool: string,
    args: unknown,
    targetPath?: string,
  ) => {
    const response = await request(`/api/workspace/${id}/run`, {
      tool,
      arguments: args,
      ...(targetPath === undefined ? {} : { targetPath }),
    });
    expect(response.status).toBe(202);
    const queued = runEnvelope.parse(await response.json()).run;
    let result = queued;
    await expect
      .poll(
        async () => {
          result = runEnvelope.parse(
            await (
              await request(`/api/workspace/${id}/runs/${queued.id}`)
            ).json(),
          ).run;
          return result.status;
        },
        { timeout: 30_000, interval: 25 },
      )
      .not.toMatch(/^(queued|running)$/);
    return result;
  };
  return { ...app, close, root, request, workspace, run };
};

it("reads session context without adding background checks to history", async () => {
  const app = await start();
  const id = await app.workspace();
  const route = `/api/workspace/${id}/session`;
  const unauthenticated = await fetch(`${app.url}${route}`);
  expect(unauthenticated.status).toBe(403);
  const before = await (await app.request(`/api/workspace/${id}`)).json();
  for (let index = 0; index < 2; index += 1) {
    const response = await app.request(route);
    expect(response.status).toBe(200);
    const body = z
      .object({ result: CallToolResultSchema })
      .parse(await response.json());
    expect(body.result.isError).not.toBe(true);
    expect(JSON.stringify(body.result)).toContain('"open":false');
  }
  expect(await (await app.request(`/api/workspace/${id}`)).json()).toEqual(
    before,
  );
  const source = join(app.root, "session-context.js");
  await writeFile(source, "export const answer = 42;\n");
  expect((await app.run(id, "open_binary", { path: source })).status).toBe(
    "completed",
  );
  const status = await (await app.request(route)).text();
  expect(status).toContain(source);
  const other = await app.workspace();
  expect(
    await (await app.request(`/api/workspace/${other}/session`)).text(),
  ).not.toContain(source);
  const history = workspaceEnvelope.parse(
    await (await app.request(`/api/workspace/${id}`)).json(),
  );
  expect(history.runs).toHaveLength(1);
});

it("advertises every SDK schema and keeps live target and evidence state isolated across tabs and reloads", async () => {
  const app = await start();
  const catalog = z
    .object({
      tools: z.array(
        z.object({
          name: z.string(),
          inputSchema: z.object({}).passthrough(),
          outputSchema: z.object({}).passthrough(),
          examples: z.array(z.unknown()),
        }),
      ),
    })
    .parse(await (await app.request("/api/tools")).json());
  expect(catalog.tools.map((tool) => tool.name)).toEqual(
    TOOL_CONTRACTS.map((tool) => tool.name),
  );
  const a = await app.workspace();
  const b = await app.workspace();
  const source = join(app.root, "fixture.js");
  await writeFile(source, "export function answer() { return 42; }\n");
  const opened = await app.run(a, "open_binary", { path: source });
  expect(opened.status, JSON.stringify(opened)).toBe("completed");
  const statusA = await app.run(a, "binary_session", {});
  const statusB = await app.run(b, "binary_session", {});
  expect(JSON.stringify(statusA.result)).toContain(source);
  expect(JSON.stringify(statusB.result)).not.toContain(source);
  const reloaded = workspaceEnvelope.parse(
    await (await app.request("/api/workspace", { id: a })).json(),
  );
  expect(reloaded.runs.map((run) => run.id)).toContain(opened.id);
  expect(
    JSON.stringify((await app.run(a, "binary_session", {})).result),
  ).toContain(source);
  expect(
    (await app.request(`/api/workspace/${b}/runs/${opened.id}`)).status,
  ).toBe(404);
  expect(
    (
      await app.request(`/api/workspace/${a}/run`, {
        tool: "open_binary",
        arguments: { path: "relative.js" },
      })
    ).status,
  ).toBe(400);
  const bundle = join(app.root, "evidence.json");
  expect(
    (await app.run(a, "export_evidence_bundle", { path: bundle })).status,
  ).toBe("completed");
  expect(JSON.parse(await readFile(bundle, "utf8"))).toBeTruthy();
  const absent = await app.run(b, "open_binary", {
    path: join(app.root, "missing.js"),
  });
  expect(absent.status).toBe("failed");
  expect(absent.result).toMatchObject({
    isError: true,
    content: expect.any(Array),
  });
}, 60_000);

it("runs real package inventory, persists complete results and recovers interrupted history without rerunning", async () => {
  const app = await start();
  const id = await app.workspace();
  const bundle = join(app.root, "Fixture.app");
  await mkdir(join(bundle, "Contents", "Resources"), { recursive: true });
  await writeFile(
    join(bundle, "Contents", "Info.plist"),
    '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>test.fixture</string><key>CFBundleExecutable</key><string>Fixture</string></dict></plist>',
  );
  await mkdir(join(bundle, "Contents", "MacOS"));
  await copyFile("/bin/echo", join(bundle, "Contents", "MacOS", "Fixture"));
  await writeFile(
    join(bundle, "Contents", "Resources", "sample.txt"),
    "hello inventory",
  );
  const source = join(app.root, "active.js");
  await writeFile(source, "export const kept = true;");
  expect((await app.run(id, "open_binary", { path: source })).status).toBe(
    "completed",
  );
  const direct = await app.run(
    id,
    "inspect_artifact",
    { integrity_policy: "record-and-continue" },
    bundle,
  );
  expect(direct.status, JSON.stringify(direct)).toBe("completed");
  expect(direct.targetPath).toBe(bundle);
  expect(JSON.stringify(direct.result)).toContain("sample.txt");
  expect(
    JSON.stringify((await app.run(id, "binary_session", {})).result),
  ).toContain(source);
  expect(
    JSON.stringify((await app.run(id, "get_evidence_bundle", {})).result),
  ).toContain("sample.txt");
  expect(
    (
      await app.request(`/api/workspace/${id}/run`, {
        tool: "binary_session",
        arguments: {},
        targetPath: bundle,
      })
    ).status,
  ).toBe(400);
  const openedBundle = await app.run(id, "open_binary", { path: bundle });
  expect(openedBundle.status, JSON.stringify(openedBundle)).toBe("completed");
  const inventory = await app.run(id, "inspect_artifact", {});
  expect(inventory.status, JSON.stringify(inventory)).toBe("completed");
  expect(JSON.stringify(inventory.result)).toContain("sample.txt");
  await app.close();
  const file = join(app.root, "workspaces", `${id}.json`);
  const saved = workspaceEnvelope.parse({ id, runs: [direct, inventory] });
  await rm(join(app.root, "workspaces", id), { recursive: true });
  saved.runs.push({
    id: crypto.randomUUID(),
    status: "running",
    tool: "binary_session",
    arguments: {},
    createdAt: new Date().toISOString(),
  });
  await writeFile(file, JSON.stringify(saved));
  const restarted = await start(app.root);
  const history = workspaceEnvelope.parse(
    await (await restarted.request(`/api/workspace/${id}`)).json(),
  );
  expect(
    runEnvelope.parse(
      await (
        await restarted.request(`/api/workspace/${id}/runs/${inventory.id}`)
      ).json(),
    ).run.result,
  ).toEqual(inventory.result);
  const recovered = runEnvelope.parse(
    await (
      await restarted.request(
        `/api/workspace/${id}/runs/${history.runs[0]?.id}`,
      )
    ).json(),
  ).run;
  expect(recovered).toMatchObject({
    status: "failed",
    error: expect.stringContaining("not a live job"),
  });
  expect(
    JSON.stringify((await restarted.run(id, "binary_session", {})).result),
  ).not.toContain(bundle);
}, 60_000);

it("forwards Stop to a running process capture and keeps the workspace usable", async () => {
  const app = await start();
  const id = await app.workspace();
  const marker = join(app.root, "ready");
  const script = join(app.root, "wait.mjs");
  await writeFile(
    script,
    `import {writeFileSync} from 'node:fs'; process.stdout.write('captured-before-stop\\n'); writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);`,
  );
  const queued = runEnvelope.parse(
    await (
      await app.request(`/api/workspace/${id}/run`, {
        tool: "capture_process_scenario",
        arguments: {
          executable: process.execPath,
          arguments: [script],
          timeout_ms: 30_000,
          idle_timeout_ms: 30_000,
        },
      })
    ).json(),
  ).run;
  await expect
    .poll(
      async () => {
        try {
          return await readFile(marker, "utf8");
        } catch {
          return "";
        }
      },
      { timeout: 20_000, interval: 30 },
    )
    .not.toBe("");
  const pid = Number(await readFile(marker, "utf8"));
  const stopped = runEnvelope.parse(
    await (
      await app.request(`/api/workspace/${id}/runs/${queued.id}/cancel`, {})
    ).json(),
  ).run;
  expect(stopped.status).toBe("cancelled");
  const stoppedResult = CallToolResultSchema.parse(stopped.result);
  expect(stoppedResult.isError).toBe(true);
  const stoppedText = stoppedResult.content.find(
    (content) => content.type === "text",
  );
  if (stoppedText?.type !== "text")
    throw new Error("Missing cancelled diagnostic");
  expect(JSON.parse(stoppedText.text)).toMatchObject({
    error: {
      code: "cancelled",
      details: {
        operation: "process_capture",
        cleanup: "complete",
        partial_observation: expect.any(Object),
      },
    },
  });
  expect(JSON.stringify(stoppedResult)).toContain("captured-before-stop");
  expect(() => process.kill(pid, 0)).toThrow();
  expect((await app.run(id, "binary_session", {})).status).toBe("completed");
  await delay(10);
}, 60_000);

it("retains caller evidence but excludes explicit sensitive input and ambient environment from history", async () => {
  const app = await start();
  const id = await app.workspace();
  const selectedPath = join(app.root, "API_SECRET-public-evidence.txt");
  await writeFile(selectedPath, "public");
  const result = await app.run(id, "capture_process_scenario", {
    executable: process.execPath,
    arguments: [
      "-e",
      "process.stdin.setRawMode(true); process.stdin.once('data', () => process.exit(0));",
    ],
    events: [
      {
        type: "input",
        at_ms: 400,
        data: "explicit-sensitive-input",
        sensitive: true,
      },
    ],
    working_directory: app.root,
    timeout_ms: 5000,
    idle_timeout_ms: 5000,
  });
  expect(result.status, JSON.stringify(result)).toBe("completed");
  expect(JSON.stringify(result)).not.toContain("explicit-sensitive-input");
  const missing = await app.run(id, "open_binary", { path: selectedPath });
  expect(JSON.stringify(missing)).toContain(selectedPath);
  const history = (
    await Promise.all(
      ["index.json", `runs/${result.id}.json`, `runs/${missing.id}.json`].map(
        (file) => readFile(join(app.root, "workspaces", id, file), "utf8"),
      ),
    )
  ).join("\n");
  expect(history).not.toContain("explicit-sensitive-input");
  expect(history).toContain(selectedPath);
  expect(history).not.toContain('"PATH":');
}, 30_000);

it.each(["text", "content", "input"])(
  "keeps MCP protocol valid when an explicit sensitive payload is %s",
  async (sensitive) => {
    const app = await start();
    const id = await app.workspace();
    const run = await app.run(id, "capture_process_scenario", {
      executable: process.execPath,
      arguments: [
        "-e",
        "process.stdin.setRawMode(true); process.stdin.once('data', () => process.exit(0));",
      ],
      events: [{ type: "input", at_ms: 400, data: sensitive, sensitive: true }],
      timeout_ms: 5000,
      idle_timeout_ms: 5000,
    });
    expect(run.status, JSON.stringify(run)).toBe("completed");
    const result = CallToolResultSchema.parse(run.result);
    const text = result.content.find((content) => content.type === "text");
    expect(text?.type).toBe("text");
    if (text?.type !== "text") throw new Error("Missing text result");
    const payload = z
      .record(z.string(), z.unknown())
      .parse(JSON.parse(text.text));
    expect(payload).toHaveProperty("normalized_result");
    expect(payload).toEqual(result.structuredContent);
    const args = z
      .object({
        events: z.array(
          z.object({ type: z.literal("input"), data: z.string() }),
        ),
      })
      .parse(run.arguments);
    expect(args.events[0]?.data).not.toBe(sensitive);
    expect((await app.run(id, "binary_session", {})).status).toBe("completed");
  },
  30_000,
);

it("pages summaries without evidence, keeps cursors stable as new runs arrive, and loads complete migrated evidence on demand", async () => {
  const app = await start();
  const id = crypto.randomUUID();
  const runs = Array.from({ length: 105 }, (_, index) => ({
    id: crypto.randomUUID(),
    tool: "binary_session",
    arguments: { note: "caller evidence" },
    status: "completed",
    createdAt: new Date(1700000000000 + index).toISOString(),
    result: {
      content: [
        { type: "text", text: `evidence-${index}-` + "x".repeat(65536) },
      ],
    },
  }));
  const legacy = join(app.root, "workspaces", `${id}.json`);
  await mkdir(join(app.root, "workspaces"), { recursive: true });
  await writeFile(legacy, JSON.stringify({ id, runs }));
  const pageSchema = workspaceEnvelope.extend({
    nextCursor: z.string().nullable(),
    total: z.number(),
  });
  const first = pageSchema.parse(
    await (await app.request(`/api/workspace/${id}`)).json(),
  );
  expect(first.runs).toHaveLength(50);
  expect(first.runs.map((r) => r.id)).toEqual(
    runs
      .slice(-50)
      .reverse()
      .map((r) => r.id),
  );
  expect(first.total).toBe(105);
  expect(JSON.stringify(first)).not.toContain("evidence-");
  expect(JSON.stringify(first)).not.toContain("caller evidence");
  const other = await app.workspace();
  expect(
    (
      await app.request(
        `/api/workspace/${other}/runs?cursor=${first.nextCursor}`,
      )
    ).status,
  ).toBe(400);
  const selected = runs[23];
  if (!selected) throw new Error("Missing fixture");
  expect(
    runEnvelope.parse(
      await (
        await app.request(`/api/workspace/${id}/runs/${selected.id}`)
      ).json(),
    ).run,
  ).toEqual(selected);
  const evidencePath = join(
    app.root,
    "workspaces",
    id,
    "runs",
    `${selected.id}.json`,
  );
  const before = await readFile(evidencePath, "utf8");
  const beforeStat = await stat(evidencePath);
  await app.run(id, "binary_session", {});
  const second = pageSchema.parse(
    await (
      await app.request(
        `/api/workspace/${id}/runs?limit=50&cursor=${first.nextCursor}`,
      )
    ).json(),
  );
  expect(second.runs.map((r) => r.id)).toEqual(
    runs
      .slice(5, 55)
      .reverse()
      .map((r) => r.id),
  );
  const third = pageSchema.parse(
    await (
      await app.request(`/api/workspace/${id}/runs?cursor=${second.nextCursor}`)
    ).json(),
  );
  expect(third.runs.map((r) => r.id)).toEqual(
    runs
      .slice(0, 5)
      .reverse()
      .map((r) => r.id),
  );
  expect(third.nextCursor).toBeNull();
  expect(await readFile(evidencePath, "utf8")).toBe(before);
  expect((await stat(evidencePath)).ino).toBe(beforeStat.ino);
  expect((await stat(evidencePath)).mtimeMs).toBe(beforeStat.mtimeMs);
  expect(JSON.parse(await readFile(legacy, "utf8"))).toEqual({ id, runs });
  for (const query of [
    "limit=0",
    "limit=101",
    "limit=1.5",
    "limit=no",
    "limit=",
    "limit=1&limit=2",
    "cursor=../bad",
    `cursor=${crypto.randomUUID()}`,
    "unknown=1",
  ]) {
    expect(
      (await app.request(`/api/workspace/${id}/runs?${query}`)).status,
      query,
    ).toBe(400);
  }
  await writeFile(evidencePath, "interrupted/corrupt evidence");
  expect(
    (await app.request(`/api/workspace/${id}/runs/${selected.id}`)).status,
  ).toBe(500);
  expect(
    (await app.request(`/api/workspace/${id}/runs/${runs[0]?.id}`)).status,
  ).toBe(200);
  expect(
    pageSchema.parse(await (await app.request(`/api/workspace/${id}`)).json())
      .total,
  ).toBe(106);
}, 60_000);

it("retries an interrupted legacy migration without publishing a partial index or losing the original", async () => {
  const app = await start();
  const id = crypto.randomUUID(),
    runId = crypto.randomUUID();
  const legacy = JSON.stringify({
    id,
    runs: [
      {
        id: runId,
        tool: "binary_session",
        arguments: {},
        status: "completed",
        createdAt: "2026-10-13T00:00:00Z",
        result: { content: [{ type: "text", text: "original evidence" }] },
      },
    ],
  });
  const workspace = join(app.root, "workspaces", id);
  await mkdir(join(workspace, "runs"), { recursive: true });
  await writeFile(join(app.root, "workspaces", `${id}.json`), legacy);
  await mkdir(join(workspace, "runs", `${runId}.json`));
  expect((await app.request(`/api/workspace/${id}`)).status).toBe(500);
  await expect(readFile(join(workspace, "index.json"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(
    await readFile(join(app.root, "workspaces", `${id}.json`), "utf8"),
  ).toBe(legacy);
  await rm(join(workspace, "runs", `${runId}.json`), { recursive: true });
  await writeFile(
    join(workspace, "index.json.abandoned.tmp"),
    "interrupted write",
  );
  expect((await app.request(`/api/workspace/${id}`)).status).toBe(200);
  expect(
    JSON.stringify(
      await (await app.request(`/api/workspace/${id}/runs/${runId}`)).json(),
    ),
  ).toContain("original evidence");
});

it("preserves terminal results when the index write fails, then recovers the evidence after restart", async () => {
  const app = await start();
  const id = await app.workspace();
  const script = join(app.root, "gated.mjs"),
    ready = join(app.root, "ready"),
    finish = join(app.root, "finish");
  await writeFile(
    script,
    `import {existsSync, writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(ready)}, 'ready'); const timer = setInterval(() => { if (existsSync(${JSON.stringify(finish)})) { clearInterval(timer); console.log('preserved result'); } }, 20);`,
  );
  const queued = runEnvelope.parse(
    await (
      await app.request(`/api/workspace/${id}/run`, {
        tool: "capture_process_scenario",
        arguments: {
          executable: process.execPath,
          arguments: [script],
          timeout_ms: 15000,
          idle_timeout_ms: 15000,
        },
      })
    ).json(),
  ).run;
  await expect
    .poll(async () => readFile(ready, "utf8").catch(() => ""), {
      timeout: 10000,
    })
    .toBe("ready");
  const index = join(app.root, "workspaces", id, "index.json");
  await rename(index, `${index}.backup`);
  await mkdir(index);
  await writeFile(finish, "finish");
  let completed = queued;
  await expect
    .poll(
      async () => {
        completed = runEnvelope.parse(
          await (
            await app.request(`/api/workspace/${id}/runs/${queued.id}`)
          ).json(),
        ).run;
        return completed.error;
      },
      { timeout: 10000 },
    )
    .toContain("History could not be saved");
  expect(completed.status).toBe("completed");
  expect(JSON.stringify(completed.result)).toContain("preserved result");
  expect(
    runEnvelope.parse(
      await (
        await app.request(`/api/workspace/${id}/runs/${queued.id}/summary`)
      ).json(),
    ).run.status,
  ).toBe("completed");
  await rm(index, { recursive: true });
  await rename(`${index}.backup`, index);
  await expect(app.close()).rejects.toThrow("Workspace shutdown failed");
  const restarted = await start(app.root);
  const recovered = runEnvelope.parse(
    await (
      await restarted.request(`/api/workspace/${id}/runs/${queued.id}`)
    ).json(),
  ).run;
  expect(recovered.status).toBe("completed");
  expect(recovered.result).toEqual(completed.result);
}, 30000);

it("rejects mismatched evidence identity without damaging other runs or hiding the history", async () => {
  const app = await start();
  const id = await app.workspace();
  const first = await app.run(id, "binary_session", {});
  const second = await app.run(id, "binary_session", {});
  await writeFile(
    join(app.root, "workspaces", id, "runs", `${first.id}.json`),
    JSON.stringify(second),
  );
  expect(
    (await app.request(`/api/workspace/${id}/runs/${first.id}`)).status,
  ).toBe(500);
  expect(
    runEnvelope.parse(
      await (
        await app.request(`/api/workspace/${id}/runs/${second.id}`)
      ).json(),
    ).run,
  ).toEqual(second);
  expect(
    workspaceEnvelope
      .parse(await (await app.request(`/api/workspace/${id}`)).json())
      .runs.map((run) => run.id),
  ).toEqual([second.id, first.id]);
});
