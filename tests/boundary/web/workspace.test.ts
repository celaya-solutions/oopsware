import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, stat, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request, type Server } from "node:http";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { z } from "zod";
import { startReaWeb } from "../../../src/web/WebServer.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const makeApp = async (options: Parameters<typeof startReaWeb>[0] = {}) => {
  const directory = await mkdtemp(join(tmpdir(), "rea-web-test-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const app = await startReaWeb({ port: 0, directory, ...options });
  cleanup.push(app.close);
  const html = await (await fetch(app.url)).text();
  const token = /name="rea-token" content="([^"]+)"/.exec(html)?.[1];
  if (!token) throw new Error("Oopsware page did not carry a session token");
  const post = (path: string, body: unknown) =>
    fetch(`${app.url}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-rea-token": token,
        Origin: app.url,
      },
      body: JSON.stringify(body),
    });
  return { ...app, directory, token, post, html };
};
const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No listener");
  return `http://127.0.0.1:${address.port}`;
};

describe("Oopsware app selection through HTTP", () => {
  it("selects app bundles and their links while keeping ordinary folders browsable", async () => {
    const app = await makeApp();
    const bundle = join(app.directory, "Example.app");
    await mkdir(join(bundle, "Contents", "MacOS"), { recursive: true });
    await writeFile(
      join(bundle, "Contents", "Info.plist"),
      '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Example</string></dict></plist>',
    );
    await writeFile(
      join(bundle, "Contents", "MacOS", "Example"),
      "example executable",
    );
    await mkdir(join(app.directory, "Folder"));
    await symlink(bundle, join(app.directory, "Linked.app"), "dir");
    const listing = await (
      await app.post("/api/browse", { path: app.directory })
    ).json();
    expect(listing).toMatchObject({
      entries: expect.arrayContaining([
        expect.objectContaining({
          name: "Example.app",
          directory: true,
          application: true,
        }),
        expect.objectContaining({
          name: "Linked.app",
          directory: true,
          application: true,
        }),
        expect.objectContaining({
          name: "Folder",
          directory: true,
          application: false,
        }),
      ]),
    });
    const opened = await (await app.post("/api/open", { path: bundle })).json();
    expect(opened).toMatchObject({
      path: bundle,
      application: true,
      executablePath: join(bundle, "Contents", "MacOS", "Example"),
      preview: { text: "example executable" },
    });
    const page = await (
      await app.post("/api/open", {
        path: join(app.directory, "Linked.app"),
        offset: 8,
      })
    ).json();
    expect(page).toMatchObject({
      path: bundle,
      originalPath: join(app.directory, "Linked.app"),
      application: true,
      preview: { offset: 8, text: "executable" },
    });
    const broken = join(app.directory, "Broken.app");
    await mkdir(broken);
    const invalid = await (
      await app.post("/api/open", { path: broken })
    ).json();
    expect(invalid).toMatchObject({
      application: true,
      preview: null,
      applicationError: { code: "target_unavailable" },
    });
    const contents = await (
      await app.post("/api/browse", { path: bundle })
    ).json();
    expect(contents).toMatchObject({
      entries: expect.arrayContaining([
        expect.objectContaining({
          name: "Contents",
          directory: true,
          application: false,
        }),
      ]),
    });
  });
});

describe("Oopsware web workspace through HTTP", () => {
  it("uploads, opens, pages, browses and inspects real files without executing their contents", async () => {
    const app = await makeApp();
    expect(app.html).toContain('id="root"');
    expect(app.html).toContain('src="/dashboard.js"');
    const source = "export const endpoint = 'https://example.invalid';\n";
    const uploaded = await fetch(`${app.url}/api/upload?name=sample.js`, {
      method: "POST",
      headers: { "x-rea-token": app.token },
      body: source,
    });
    expect(uploaded.status).toBe(200);
    const file = z
      .object({ path: z.string(), preview: z.object({ text: z.string() }) })
      .parse(await uploaded.json());
    expect(file.preview.text).toBe(source);
    expect((await stat(file.path)).mode & 0o777).toBe(0o600);
    const inspection = await app.post("/api/inspect", { path: file.path });
    expect(inspection.status).toBe(200);
    const report = await inspection.text();
    expect(report).toContain("sample.js");
    expect(report).toContain("evidence");
    const big = join(app.directory, "binary.bin");
    await writeFile(
      big,
      Buffer.concat([Buffer.alloc(65536, 0), Buffer.from("SECOND_PAGE")]),
    );
    const page = z
      .object({
        preview: z.object({
          offset: z.number(),
          text: z.string(),
          hasMore: z.boolean(),
        }),
      })
      .parse(
        await (
          await app.post("/api/open", { path: big, offset: 65536 })
        ).json(),
      );
    expect(page.preview).toMatchObject({
      offset: 65536,
      text: "SECOND_PAGE",
      hasMore: false,
    });
    const listing = z
      .object({ entries: z.array(z.object({ name: z.string() })) })
      .parse(
        await (await app.post("/api/browse", { path: app.directory })).json(),
      );
    expect(listing.entries.map((entry) => entry.name)).toContain("binary.bin");
    expect(
      (await app.post("/api/open", { path: join(app.directory, "absent") }))
        .status,
    ).not.toBe(200);
  });

  it("rejects cross-origin, unauthenticated, traversal uploads and malformed requests", async () => {
    const app = await makeApp();
    expect((await fetch(`${app.url}/api/status`)).status).toBe(403);
    expect(
      (
        await fetch(`${app.url}/api/status`, {
          headers: {
            "x-rea-token": app.token,
            Origin: "https://untrusted.invalid",
          },
        })
      ).status,
    ).toBe(403);
    const badHostStatus = await new Promise<number | undefined>(
      (resolve, reject) => {
        const req = request(
          `${app.url}/api/status`,
          { headers: { "x-rea-token": app.token, Host: "untrusted.invalid" } },
          (res) => {
            res.resume();
            resolve(res.statusCode);
          },
        );
        req.on("error", reject);
        req.end();
      },
    );
    expect(badHostStatus).toBe(403);
    expect(
      (
        await fetch(`${app.url}/api/upload?name=..%2Fescape`, {
          method: "POST",
          headers: { "x-rea-token": app.token },
          body: "x",
        })
      ).status,
    ).toBe(400);
    expect((await app.post("/api/open", { path: "" })).status).toBe(400);
    expect(
      (
        await fetch(`${app.url}/api/open`, {
          method: "POST",
          headers: {
            "x-rea-token": app.token,
            "Content-Type": "application/json",
          },
          body: "{",
        })
      ).status,
    ).toBe(400);
    const pending = await app.post("/api/auth/openai", {});
    expect(pending.status).toBe(200);
    expect(
      (
        await fetch(
          `${app.url}/auth/callback?state=wrong&code=x&client_id=oaiapp_test`,
        )
      ).status,
    ).toBe(400);
  });
});

describe("Oopsware model connection boundaries", () => {
  it("validates real signed OAuth callbacks and keeps credentials out of HTTP status", async () => {
    const keys = await generateKeyPair("RS256");
    const jwk = {
      ...(await exportJWK(keys.publicKey)),
      kid: "test-key",
      alg: "RS256",
      use: "sig",
    };
    let nonce = "";
    let issuer = "";
    let invalidNonce = true;
    const authServer = createServer((req, res) => {
      void (async () => {
        res.setHeader("Content-Type", "application/json");
        if (req.url === "/jwks") {
          res.end(JSON.stringify({ keys: [jwk] }));
          return;
        }
        const idToken = await new SignJWT({
          email: "test@example.invalid",
          nonce: invalidNonce ? "not-the-requested-nonce" : nonce,
        })
          .setProtectedHeader({ alg: "RS256", kid: "test-key" })
          .setIssuer(issuer)
          .setAudience("oaiapp_test")
          .setSubject("test-user")
          .setExpirationTime("5m")
          .sign(keys.privateKey);
        res.end(
          JSON.stringify({
            access_token: "private-access",
            refresh_token: "private-refresh",
            id_token: idToken,
            expires_in: 300,
            scope: "openid chatgpt.tokens.use.direct",
          }),
        );
      })().catch(() => {
        res.statusCode = 500;
        res.end();
      });
    });
    issuer = await listen(authServer);
    const app = await makeApp({
      authEndpoints: {
        issuer,
        authorize: `${issuer}/authorize`,
        token: `${issuer}/token`,
        jwks: `${issuer}/jwks`,
      },
    });
    const { url } = z
      .object({ url: z.string() })
      .parse(await (await app.post("/api/auth/openai", {})).json());
    const authorization = new URL(url);
    nonce = authorization.searchParams.get("nonce") ?? "";
    expect(authorization.searchParams.get("client_id")).toBe(
      "dynamic_agent_client",
    );
    expect(authorization.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    expect(authorization.searchParams.get("agent_name_hint")).toBe("Oopsware");
    const callback = new URL(`${app.url}/auth/callback`);
    callback.search = new URLSearchParams({
      state: authorization.searchParams.get("state") ?? "",
      code: "test-code",
      client_id: "oaiapp_test",
    }).toString();
    const rejected = await fetch(callback, { redirect: "manual" });
    expect(rejected.status).toBe(400);
    invalidNonce = false;
    const retry = z
      .object({ url: z.string() })
      .parse(await (await app.post("/api/auth/openai", {})).json());
    const retryUrl = new URL(retry.url);
    nonce = retryUrl.searchParams.get("nonce") ?? "";
    callback.searchParams.set(
      "state",
      retryUrl.searchParams.get("state") ?? "",
    );
    const response = await fetch(callback, { redirect: "manual" });
    expect(response.status).toBe(303);
    const status = await (
      await fetch(`${app.url}/api/status`, {
        headers: { "x-rea-token": app.token },
      })
    ).text();
    expect(status).toContain("test@example.invalid");
    expect(status).not.toContain("private-access");
    expect(status).not.toContain("private-refresh");
    expect((await stat(join(app.directory, "openai.json"))).mode & 0o777).toBe(
      0o600,
    );
    expect((await fetch(callback, { redirect: "manual" })).status).toBe(400);
    const returning = z
      .object({ url: z.string() })
      .parse(await (await app.post("/api/auth/openai", {})).json());
    expect(new URL(returning.url).searchParams.get("client_id")).toBe(
      "oaiapp_test",
    );
  });
});

describe("Oopsware installed model discovery", () => {
  it("uses Ollama's browser sign-in and limits the returned account fields", async () => {
    let status = 401;
    let account: unknown = {
      error: "unauthorized",
      signin_url: "https://ollama.com/connect?key=fixture",
    };
    const localUrl = await listen(
      createServer((req, res) => {
        expect(req.method).toBe("POST");
        expect(req.url).toBe("/api/me");
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(account));
      }),
    );
    const app = await makeApp({ ollamaUrl: localUrl });
    const connect = () => app.post("/api/auth/ollama", {});
    const unauthorized = await fetch(`${app.url}/api/auth/ollama`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(unauthorized.status).toBe(403);
    expect(await (await connect()).json()).toEqual({
      connected: false,
      url: "https://ollama.com/connect?key=fixture",
    });
    status = 200;
    account = {
      name: "fixture-user",
      email: "private@example.test",
      id: "private",
    };
    expect(await (await connect()).json()).toEqual({
      connected: true,
      name: "fixture-user",
    });
    status = 401;
    for (const url of [
      "https://example.test/connect",
      "https://ollama.com.evil.test/connect",
      "http://ollama.com/connect",
      "https://user:pass@ollama.com/connect",
      "https://ollama.com/other",
    ]) {
      account = { signin_url: url };
      const rejected = await connect();
      expect(rejected.status).toBe(502);
      expect(await rejected.json()).toMatchObject({
        error: "ollama_signin_url_invalid",
      });
    }
    status = 404;
    expect(await (await connect()).json()).toMatchObject({
      error: "ollama_signin_unavailable",
    });
    status = 401;
    account = { error: "unauthorized" };
    expect(await (await connect()).json()).toMatchObject({
      error: "ollama_signin_unavailable",
    });
    const offline = createServer();
    const offlineUrl = await listen(offline);
    await new Promise<void>((resolve) => offline.close(() => resolve()));
    const offlineApp = await makeApp({ ollamaUrl: offlineUrl });
    const unavailable = await offlineApp.post("/api/auth/ollama", {});
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({
      error: "ollama_unavailable",
    });
  });

  it("lists every installed Ollama model and reflects provider changes and failures", async () => {
    let models = [
      { name: "local-model:latest" },
      { name: "hf.co/team/model:Q4" },
    ];
    let available = true;
    const localUrl = await listen(
      createServer((req, res) => {
        expect(req.url).toBe("/api/tags");
        res.statusCode = available ? 200 : 503;
        res.end(JSON.stringify(available ? { models } : { error: "offline" }));
      }),
    );
    const app = await makeApp({ ollamaUrl: localUrl });
    const get = (path: string) =>
      fetch(`${app.url}${path}`, {
        headers: { "x-rea-token": app.token },
      });
    const choices = models.map(({ name }) => ({ id: name, name }));
    expect(await (await get("/api/models?provider=ollama")).json()).toEqual(
      choices,
    );
    expect(
      await (await get("/api/models?provider=huggingface")).json(),
    ).toEqual([choices[1]]);
    expect(await (await get("/api/status")).json()).toMatchObject({
      ollama: { connected: true, models: choices },
      huggingface: { models: [choices[1]] },
    });
    models = [{ name: "newly-installed:latest" }];
    expect(await (await get("/api/models?provider=ollama")).json()).toEqual([
      { id: "newly-installed:latest", name: "newly-installed:latest" },
    ]);
    models = [];
    expect(await (await get("/api/models?provider=ollama")).json()).toEqual([]);
    available = false;
    expect((await get("/api/models?provider=ollama")).ok).toBe(false);
  });
});

describe("Oopsware inference streams", () => {
  it("preserves partial model output and reports interrupted streams as failure", async () => {
    let finish = true;
    const modelServer = createServer((req, res) => {
      if (req.url === "/api/tags") {
        res.end(JSON.stringify({ models: [{ name: "test-local" }] }));
        return;
      }
      res.setHeader("Content-Type", "application/x-ndjson");
      res.write(
        `${JSON.stringify({ message: { content: "observed text" } })}\n`,
      );
      if (finish) res.write(`${JSON.stringify({ done: true })}\n`);
      res.end();
    });
    const localUrl = await listen(modelServer);
    const app = await makeApp({ ollamaUrl: localUrl });
    const body = {
      provider: "ollama",
      model: "test-local",
      messages: [{ role: "user", content: "hello" }],
    };
    const complete = await (await app.post("/api/chat", body)).text();
    expect(complete).toContain('"type":"done"');
    finish = false;
    const partial = await (await app.post("/api/chat", body)).text();
    expect(partial).toContain("observed text");
    expect(partial).toContain('"type":"error"');
    expect(partial).not.toContain('"type":"done"');
  });
});

describe("Oopsware model cancellation", () => {
  it("aborts the local provider connection when the browser stops the request", async () => {
    let stopped = () => {};
    const disconnected = new Promise<void>((resolve) => {
      stopped = resolve;
    });
    const modelServer = createServer((req, res) => {
      res.setHeader("Content-Type", "application/x-ndjson");
      res.write(`${JSON.stringify({ message: { content: "partial" } })}\n`);
      res.once("close", stopped);
    });
    const localUrl = await listen(modelServer);
    const app = await makeApp({ ollamaUrl: localUrl });
    const controller = new AbortController();
    const response = await fetch(`${app.url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-rea-token": app.token },
      body: JSON.stringify({
        provider: "ollama",
        model: "test",
        messages: [{ role: "user", content: "hello" }],
      }),
      signal: controller.signal,
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");
    expect((await reader.read()).done).toBe(false);
    controller.abort();
    await expect(disconnected).resolves.toBeUndefined();
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  });
});
