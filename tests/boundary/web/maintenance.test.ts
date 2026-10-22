import { afterEach, expect, it } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MaintenanceService } from "../../../src/web/MaintenanceService.js";
import { startReaWeb } from "../../../src/web/WebServer.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const connect = async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-maintenance-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const app = await startReaWeb({
    port: 0,
    directory: join(root, "web"),
    environment: { HOME: root },
  });
  cleanup.push(app.close);
  const html = await (await fetch(app.url)).text();
  const token = /name="rea-token" content="([^"]+)"/.exec(html)?.[1];
  if (!token) throw new Error("No browser session token");
  const post = (body: unknown, credential = token) =>
    fetch(`${app.url}/api/maintenance`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-rea-token": credential,
        Origin: app.url,
      },
      body: JSON.stringify(body),
    });
  return { root, app, post, token };
};

it("serves real command help and completion exports behind the authenticated boundary", async () => {
  const { post, app, token } = await connect();
  expect((await post({ action: "help" }, "wrong")).status).toBe(403);
  const info = await fetch(`${app.url}/api/maintenance`, {
    headers: { "x-rea-token": token },
  });
  expect(info.status).toBe(200);
  expect(await info.json()).toMatchObject({
    clients: expect.any(Array),
    commands: expect.arrayContaining(["setup", "doctor"]),
  });
  const help = await post({ action: "help", command: "setup" });
  expect(help.status).toBe(200);
  expect(await help.json()).toMatchObject({
    result: { text: expect.stringContaining("--dry-run") },
  });
  const shell = await post({ action: "completions", shell: "zsh" });
  expect(shell.status).toBe(200);
  expect(await shell.json()).toMatchObject({
    result: { text: expect.stringContaining("oopsware") },
  });
});

it("rejects arbitrary commands, unsupported clients and unreviewed setup before changing user files", async () => {
  const { root, post } = await connect();
  const before = await readdir(root);
  expect(
    (
      await post({
        action: "execute",
        command: "touch",
        args: [join(root, "unwanted")],
      })
    ).status,
  ).toBe(400);
  expect(
    (await post({ action: "setup-preview", clients: ["--arbitrary-command"] }))
      .status,
  ).toBe(400);
  expect(
    (
      await post({
        action: "setup-apply",
        planId: "12345678-1234-4234-9234-123456789abc",
      })
    ).status,
  ).toBe(409);
  expect(await readdir(root)).toEqual(before);
});

it("rejects new filesystem actions as soon as shutdown begins", async () => {
  const service = new MaintenanceService({});
  const closed = service.close();
  await expect(
    service.execute({ action: "setup-preview", clients: [] }),
  ).rejects.toMatchObject({ status: 503 });
  await closed;
});
