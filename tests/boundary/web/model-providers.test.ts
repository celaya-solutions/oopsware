import { afterEach, describe, expect, it } from "vitest";
import {
  chmod,
  mkdtemp,
  mkdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { startReaWeb } from "../../../src/web/WebServer.js";
import { parseOpenAiModels } from "../../../src/web/providers/ModelConnections.js";
import {
  ggufQuantizations,
  lmStudioDownloadBody,
  ollamaCloudPullName,
} from "../../../src/web/providers/ModelDownloads.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

type Route = (
  req: IncomingMessage,
  res: ServerResponse,
  body: string,
) => void | Promise<void>;
/** One fixture server standing in for every provider, keyed by "METHOD /path". */
const fixture = async (routes: Record<string, Route>) => {
  const seen: { method: string; path: string; body: string; auth?: string }[] =
    [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      const path = new URL(req.url ?? "/", "http://fixture").pathname;
      seen.push({
        method: req.method ?? "",
        path,
        body,
        ...(req.headers.authorization
          ? { auth: req.headers.authorization }
          : {}),
      });
      const route =
        routes[`${req.method} ${path}`] ??
        Object.entries(routes).find(
          ([key]) =>
            key.endsWith("*") &&
            `${req.method} ${path}`.startsWith(key.slice(0, -1)),
        )?.[1];
      if (!route) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      void route(req, res, body);
    });
  });
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
  return { url: `http://127.0.0.1:${address.port}`, seen };
};
const sendJson = (res: ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
};
const closedUrl = async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No listener");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${address.port}`;
};

const makeApp = async (
  url: string,
  environment: Record<string, string> = {},
) => {
  const directory = await mkdtemp(join(tmpdir(), "rea-models-test-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const app = await startReaWeb({
    port: 0,
    directory,
    environment: {
      PATH: process.env.PATH,
      HOME: directory,
      HF_HOME: join(directory, "hf-home"),
      LMSTUDIO_MODELS_DIR: join(directory, "lmstudio-models"),
      ...environment,
    },
    modelEndpoints: {
      ollama: url,
      ollamaCloud: url,
      lmStudio: url,
      huggingFace: url,
      huggingFaceRouter: `${url}/router`,
      openRouter: url,
      openai: url,
      anthropic: url,
    },
  });
  cleanup.push(app.close);
  const html = await (await fetch(app.url)).text();
  const token = /name="rea-token" content="([^"]+)"/.exec(html)?.[1];
  if (!token) throw new Error("Oopsware page did not carry a session token");
  const headers = {
    "Content-Type": "application/json",
    "x-rea-token": token,
    Origin: app.url,
  };
  return {
    ...app,
    directory,
    post: (path: string, body: unknown) =>
      fetch(`${app.url}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
    fetchGet: (path: string) => fetch(`${app.url}${path}`, { headers }),
    get: async (path: string) =>
      (await fetch(`${app.url}${path}`, { headers })).json(),
  };
};
const lines = (text: string) =>
  text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
const chat = (provider: string, model: string) => ({
  provider,
  model,
  messages: [{ role: "user", content: "hello" }],
});
const sse = (res: ServerResponse, events: unknown[], done = true) => {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.write(": keep-alive comment\n\n");
  for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
  if (done) res.write("data: [DONE]\n\n");
  res.end();
};

describe("Ollama downloads", () => {
  it("streams pull progress, reports Ollama's own errors and refuses unfinished pulls", async () => {
    let mode: "ok" | "error" | "cut" | "rejected" = "ok";
    const server = await fixture({
      "POST /api/pull": (_req, res) => {
        if (mode === "rejected") {
          sendJson(res, 400, { error: "invalid model name" });
          return;
        }
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        res.write(`${JSON.stringify({ status: "pulling manifest" })}\n`);
        res.write(
          `${JSON.stringify({ status: "pulling abc", completed: 50, total: 100 })}\n`,
        );
        if (mode === "error")
          res.write(
            `${JSON.stringify({ error: "pull model manifest: file does not exist" })}\n`,
          );
        if (mode === "ok")
          res.write(`${JSON.stringify({ status: "success" })}\n`);
        res.end();
      },
    });
    const app = await makeApp(server.url);
    const pull = async (body: unknown) =>
      lines(await (await app.post("/api/models/download", body)).text());
    const ok = await pull({
      target: "ollama",
      model: "hf.co/owner/repo",
      quantization: "Q4_K_M",
    });
    expect(ok).toEqual([
      { type: "progress", status: "pulling manifest" },
      { type: "progress", status: "pulling abc", completed: 50, total: 100 },
      { type: "progress", status: "success" },
      { type: "done" },
    ]);
    expect(JSON.parse(server.seen.at(-1)?.body ?? "")).toEqual({
      model: "hf.co/owner/repo:Q4_K_M",
      stream: true,
    });
    mode = "error";
    expect((await pull({ target: "ollama", model: "missing" })).at(-1)).toEqual(
      {
        type: "error",
        message:
          "Ollama could not download missing: pull model manifest: file does not exist",
      },
    );
    mode = "cut";
    expect(
      (await pull({ target: "ollama", model: "cut" })).at(-1),
    ).toMatchObject({
      type: "error",
      message: expect.stringContaining("stopped before the download finished"),
    });
    mode = "rejected";
    expect((await pull({ target: "ollama", model: "bad" })).at(-1)).toEqual({
      type: "error",
      message: "Ollama could not download bad: invalid model name",
    });
    const invalid = await app.post("/api/models/download", {
      target: "ollama",
      model: "../etc/passwd",
    });
    expect(invalid.status).toBe(400);
  });

  it("lists the Ollama cloud catalog with Ollama's cloud pull names and labels installed cloud models", async () => {
    const server = await fixture({
      "GET /api/tags": (_req, res) =>
        sendJson(res, 200, {
          models: [
            { name: "glm-5.3", details: { parameter_size: "753B" } },
            { name: "deepseek-v4-pro:0813", remote_model: "deepseek-v4-pro" },
          ],
        }),
    });
    const app = await makeApp(server.url);
    expect(
      await app.get("/api/models/catalog?source=ollama-cloud&q=glm"),
    ).toEqual([
      { id: "glm-5.3", name: "glm-5.3", pull: "glm-5.3:cloud", detail: "753B" },
    ]);
    expect(ollamaCloudPullName("deepseek-v4-pro:0813")).toBe(
      "deepseek-v4-pro:0813-cloud",
    );
    expect(await app.get("/api/models?provider=ollama")).toEqual([
      { id: "glm-5.3", name: "glm-5.3" },
      {
        id: "deepseek-v4-pro:0813",
        name: "deepseek-v4-pro:0813 · cloud",
        cloud: true,
      },
    ]);
  });
});

describe("LM Studio", () => {
  it("lists downloaded LLMs, falls back to /v1/models, chats and tracks downloads", async () => {
    let native = true;
    let polls = 0;
    const server = await fixture({
      "GET /api/v1/models": (_req, res) =>
        native
          ? sendJson(res, 200, {
              models: [
                {
                  key: "qwen/qwen3-0.6b",
                  display_name: "Qwen3 0.6B",
                  type: "llm",
                },
                { key: "nomic-embed", type: "embedding" },
              ],
            })
          : sendJson(res, 404, { error: "unknown route" }),
      "GET /v1/models": (_req, res) =>
        sendJson(res, 200, { data: [{ id: "legacy-model" }] }),
      "POST /v1/chat/completions": (_req, res) =>
        sse(res, [
          { choices: [{ delta: { content: "local " } }] },
          {
            choices: [{ delta: { content: "answer" }, finish_reason: "stop" }],
          },
        ]),
      "POST /api/v1/models/download": (_req, res) =>
        sendJson(res, 200, {
          job_id: "job_1",
          status: "downloading",
          total_size_bytes: 10,
          downloaded_bytes: 0,
        }),
      "GET /api/v1/models/download/status/job_1": (_req, res) => {
        polls += 1;
        sendJson(res, 200, {
          job_id: "job_1",
          status: polls > 1 ? "completed" : "downloading",
          total_size_bytes: 10,
          downloaded_bytes: polls > 1 ? 10 : 5,
        });
      },
    });
    const app = await makeApp(server.url);
    expect(await app.get("/api/models?provider=lmstudio")).toEqual([
      { id: "qwen/qwen3-0.6b", name: "Qwen3 0.6B" },
    ]);
    native = false;
    expect(await app.get("/api/models?provider=lmstudio")).toEqual([
      { id: "legacy-model", name: "legacy-model" },
    ]);
    const reply = lines(
      await (
        await app.post("/api/chat", chat("lmstudio", "legacy-model"))
      ).text(),
    );
    expect(reply).toEqual([
      { type: "delta", text: "local " },
      { type: "delta", text: "answer" },
      { type: "done" },
    ]);
    const sent = JSON.parse(
      server.seen.find((s) => s.path === "/v1/chat/completions")?.body ?? "",
    );
    expect(sent).toMatchObject({ model: "legacy-model", stream: true });
    expect(sent.messages[0].role).toBe("system");
    const download = lines(
      await (
        await app.post("/api/models/download", {
          target: "lmstudio",
          model: "hf.co/owner/repo-GGUF",
          quantization: "Q4_K_M",
        })
      ).text(),
    );
    expect(download.map((l) => l.status ?? l.type)).toEqual([
      "downloading",
      "downloading",
      "completed",
      "done",
    ]);
    expect(
      JSON.parse(
        server.seen.find((s) => s.path === "/api/v1/models/download")?.body ??
          "",
      ),
    ).toEqual({
      model: "https://huggingface.co/owner/repo-GGUF",
      quantization: "Q4_K_M",
    });
  });

  it("passes the quantization tag of an hf.co/owner/repo:QUANT name to LM Studio", () => {
    expect(
      lmStudioDownloadBody({
        target: "lmstudio",
        model: "hf.co/owner/repo-GGUF:Q8_0",
      }),
    ).toEqual({
      model: "https://huggingface.co/owner/repo-GGUF",
      quantization: "Q8_0",
    });
    expect(
      lmStudioDownloadBody({
        target: "lmstudio",
        model: "hf.co/owner/repo-GGUF:Q8_0",
        quantization: "Q4_K_M",
      }),
    ).toEqual({
      model: "https://huggingface.co/owner/repo-GGUF",
      quantization: "Q4_K_M",
    });
    expect(
      lmStudioDownloadBody({ target: "lmstudio", model: "openai/gpt-oss-20b" }),
    ).toEqual({ model: "openai/gpt-oss-20b" });
  });

  it("says how to start LM Studio when its server is off", async () => {
    const app = await makeApp(await closedUrl());
    const response = await app.fetchGet("/api/models?provider=lmstudio");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: "lmstudio_unavailable",
      message: expect.stringContaining("lms server start"),
    });
  });
});

describe("Hugging Face", () => {
  it("checks a token with whoami, saves it privately, lists hosted and Ollama models and routes chat by model", async () => {
    const server = await fixture({
      "GET /api/whoami-v2": (req, res) =>
        req.headers.authorization === "Bearer hf_good"
          ? sendJson(res, 200, {
              name: "fixture-user",
              email: "private@x.test",
            })
          : sendJson(res, 401, { error: "Invalid credentials" }),
      "GET /api/tags": (_req, res) =>
        sendJson(res, 200, {
          models: [
            { name: "local:latest" },
            { name: "hf.co/owner/repo:Q4_K_M" },
          ],
        }),
      "GET /router/v1/models": (_req, res) =>
        sendJson(res, 200, { data: [{ id: "meta/llama-x" }] }),
      "POST /router/v1/chat/completions": (_req, res) =>
        sse(res, [
          {
            choices: [{ delta: { content: "hosted" }, finish_reason: "stop" }],
          },
        ]),
      "POST /api/chat": (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        res.end(
          `${JSON.stringify({ message: { content: "via ollama" } })}\n${JSON.stringify({ done: true })}\n`,
        );
      },
    });
    const app = await makeApp(server.url);
    expect(await app.get("/api/models?provider=huggingface")).toEqual([
      { id: "hf.co/owner/repo:Q4_K_M", name: "hf.co/owner/repo:Q4_K_M" },
    ]);
    const hostedBefore = lines(
      await (
        await app.post("/api/chat", chat("huggingface", "meta/llama-x"))
      ).text(),
    );
    expect(hostedBefore.at(-1)).toMatchObject({
      type: "error",
      message: expect.stringContaining("Hugging Face token"),
    });
    const rejected = await app.post("/api/auth/huggingface", {
      apiKey: "hf_bad",
    });
    expect(rejected.status).toBe(401);
    expect(await rejected.json()).toMatchObject({
      error: "huggingface_token_rejected",
    });
    expect(
      await (
        await app.post("/api/auth/huggingface", { apiKey: "hf_good" })
      ).json(),
    ).toEqual({ connected: true, name: "fixture-user" });
    expect(
      (await stat(join(app.directory, "huggingface.json"))).mode & 0o777,
    ).toBe(0o600);
    expect(await app.get("/api/status")).toMatchObject({
      huggingface: {
        connected: true,
        tokenSource: "saved",
        name: "fixture-user",
      },
    });
    expect(await app.get("/api/models?provider=huggingface")).toEqual([
      {
        id: "hf.co/owner/repo:Q4_K_M",
        name: "hf.co/owner/repo:Q4_K_M · local Ollama",
      },
      { id: "meta/llama-x", name: "meta/llama-x · HF Inference", cloud: true },
    ]);
    const hosted = lines(
      await (
        await app.post("/api/chat", chat("huggingface", "meta/llama-x"))
      ).text(),
    );
    expect(hosted).toEqual([
      { type: "delta", text: "hosted" },
      { type: "done" },
    ]);
    expect(
      server.seen.find((s) => s.path === "/router/v1/chat/completions")?.auth,
    ).toBe("Bearer hf_good");
    const local = lines(
      await (
        await app.post(
          "/api/chat",
          chat("huggingface", "hf.co/owner/repo:Q4_K_M"),
        )
      ).text(),
    );
    expect(local).toEqual([
      { type: "delta", text: "via ollama" },
      { type: "done" },
    ]);
    expect(
      await (
        await app.post("/api/auth/huggingface", { disconnect: true })
      ).json(),
    ).toEqual({ connected: false });
    expect(await app.get("/api/status")).toMatchObject({
      huggingface: { connected: false },
    });
  });
});

describe("Hugging Face tokens and search", () => {
  it("reuses an existing hf CLI login without copying it", async () => {
    const server = await fixture({
      "GET /api/whoami-v2": (_req, res) =>
        sendJson(res, 200, { name: "cli-user" }),
    });
    const home = await mkdtemp(join(tmpdir(), "rea-hf-home-"));
    cleanup.push(() => rm(home, { recursive: true, force: true }));
    await writeFile(join(home, "token"), "hf_cli\n");
    const app = await makeApp(server.url, { HF_HOME: home });
    expect(await app.get("/api/status")).toMatchObject({
      huggingface: {
        connected: true,
        tokenSource: "huggingface-cli",
        name: "cli-user",
      },
    });
    await expect(
      stat(join(app.directory, "huggingface.json")),
    ).rejects.toThrow();
  });

  it("falls back to the hf CLI login after a saved key is removed and keeps Ollama models when HF Inference rejects the token", async () => {
    const server = await fixture({
      "GET /api/whoami-v2": (req, res) =>
        sendJson(res, 200, {
          name:
            req.headers.authorization === "Bearer hf_saved"
              ? "saved-user"
              : "cli-user",
        }),
      "GET /api/tags": (_req, res) =>
        sendJson(res, 200, {
          models: [{ name: "hf.co/owner/repo:Q4_K_M" }],
        }),
      "GET /router/v1/models": (_req, res) =>
        sendJson(res, 401, { error: "Invalid credentials in Authorization" }),
    });
    const home = await mkdtemp(join(tmpdir(), "rea-hf-home-"));
    cleanup.push(() => rm(home, { recursive: true, force: true }));
    await writeFile(join(home, "token"), "hf_cli\n");
    const app = await makeApp(server.url, { HF_HOME: home });
    expect(
      await (
        await app.post("/api/auth/huggingface", { apiKey: "hf_saved" })
      ).json(),
    ).toEqual({ connected: true, name: "saved-user" });
    expect(await app.get("/api/models?provider=huggingface")).toEqual([
      { id: "hf.co/owner/repo:Q4_K_M", name: "hf.co/owner/repo:Q4_K_M" },
    ]);
    expect(
      await (
        await app.post("/api/auth/huggingface", { disconnect: true })
      ).json(),
    ).toEqual({ connected: true, source: "huggingface-cli" });
    expect(await app.get("/api/status")).toMatchObject({
      huggingface: {
        connected: true,
        tokenSource: "huggingface-cli",
        name: "cli-user",
      },
    });
  });

  it("searches GGUF repositories and reads quantizations from file names", async () => {
    const server = await fixture({
      "GET /api/models": (req, res) => {
        const query = new URL(req.url ?? "/", "http://x").searchParams;
        expect(query.get("filter")).toBe("gguf");
        expect(query.get("search")).toBe("qwen3");
        sendJson(res, 200, [
          {
            id: "owner/Qwen3-GGUF",
            downloads: 1234,
            siblings: [
              { rfilename: "Qwen3.Q4_K_M.gguf" },
              { rfilename: "Qwen3-Q8_0.gguf" },
              { rfilename: "mmproj-Qwen3-F16.gguf" },
              { rfilename: "README.md" },
            ],
          },
        ]);
      },
    });
    const app = await makeApp(server.url);
    expect(
      await app.get("/api/models/catalog?source=huggingface&q=qwen3"),
    ).toEqual([
      {
        id: "owner/Qwen3-GGUF",
        name: "owner/Qwen3-GGUF",
        pull: "hf.co/owner/Qwen3-GGUF",
        detail: "1,234 downloads",
        quantizations: ["Q4_K_M", "Q8_0"],
      },
    ]);
    expect(
      ggufQuantizations([
        "m-IQ2_M.gguf",
        "m-BF16-00001-of-00002.gguf",
        "notes.txt",
      ]),
    ).toEqual(["BF16", "IQ2_M"]);
  });
});

describe("OpenRouter", () => {
  it("lists the public catalog, checks and saves the key, and streams replies", async () => {
    const server = await fixture({
      "GET /api/v1/models": (_req, res) =>
        sendJson(res, 200, {
          data: [
            { id: "z/model", name: "Z Model" },
            { id: "a/model", name: "A Model" },
          ],
        }),
      "GET /api/v1/key": (req, res) =>
        req.headers.authorization === "Bearer sk-or-good"
          ? sendJson(res, 200, { data: { label: "fixture" } })
          : sendJson(res, 401, {
              error: { message: "No auth credentials found" },
            }),
      "POST /api/v1/chat/completions": (req, res) => {
        if (req.headers.authorization !== "Bearer sk-or-good") {
          sendJson(res, 402, { error: { message: "Insufficient credits" } });
          return;
        }
        sse(res, [
          { choices: [{ delta: { content: "routed" } }] },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ]);
      },
    });
    const app = await makeApp(server.url);
    expect(await app.get("/api/models?provider=openrouter")).toEqual([
      { id: "a/model", name: "A Model", cloud: true },
      { id: "z/model", name: "Z Model", cloud: true },
    ]);
    expect(
      lines(
        await (
          await app.post("/api/chat", chat("openrouter", "a/model"))
        ).text(),
      ).at(-1),
    ).toMatchObject({
      type: "error",
      message: expect.stringContaining("OpenRouter API key"),
    });
    expect(
      (await app.post("/api/auth/openrouter", { apiKey: "sk-or-bad" })).status,
    ).toBe(401);
    expect(
      await (
        await app.post("/api/auth/openrouter", { apiKey: "sk-or-good" })
      ).json(),
    ).toEqual({ connected: true });
    expect(
      (await stat(join(app.directory, "openrouter.json"))).mode & 0o777,
    ).toBe(0o600);
    expect(
      lines(
        await (
          await app.post("/api/chat", chat("openrouter", "a/model"))
        ).text(),
      ),
    ).toEqual([{ type: "delta", text: "routed" }, { type: "done" }]);
  });

  it("shows the provider's reason when it rejects a reply", async () => {
    const server = await fixture({
      "POST /api/chat": (_req, res) =>
        sendJson(res, 403, {
          error: "ollama cloud is disabled: remote model is unavailable",
        }),
    });
    const app = await makeApp(server.url);
    expect(
      lines(
        await (
          await app.post("/api/chat", chat("ollama", "glm-5.3:cloud"))
        ).text(),
      ),
    ).toEqual([
      {
        type: "error",
        message:
          "The model returned HTTP 403 (ollama cloud is disabled: remote model is unavailable). Check model availability and account usage, then retry.",
      },
    ]);
  });
});

describe("OpenAI model lists", () => {
  it("accepts both the public API shape and the ChatGPT-account shape", () => {
    expect(
      parseOpenAiModels({
        object: "list",
        data: [
          { id: "gpt-5.1" },
          { id: "text-embedding-3-small" },
          { id: "gpt-image-1" },
          { id: "o4-mini" },
          { id: "dall-e-3" },
        ],
      }),
    ).toEqual([
      { id: "gpt-5.1", name: "gpt-5.1" },
      { id: "o4-mini", name: "o4-mini" },
    ]);
    expect(
      parseOpenAiModels({
        models: [
          { slug: "gpt-5", display_name: "GPT-5", visibility: "list" },
          { slug: "hidden", display_name: "Hidden", visibility: "hide" },
        ],
      }),
    ).toEqual([{ id: "gpt-5", name: "GPT-5" }]);
  });
});

describe("Models on this computer", () => {
  it("finds Hugging Face cache and LM Studio folders without following snapshot links", async () => {
    const server = await fixture({
      "GET /api/tags": (_req, res) =>
        sendJson(res, 200, { models: [{ name: "qwen3:0.6b" }] }),
    });
    const app = await makeApp(server.url);
    const hub = join(app.directory, "hf-home", "hub");
    const repo = join(hub, "models--owner--name");
    await mkdir(join(repo, "blobs"), { recursive: true });
    await mkdir(join(repo, "snapshots", "abc"), { recursive: true });
    await writeFile(join(repo, "blobs", "sha"), Buffer.alloc(2048));
    await symlink(
      join(repo, "blobs", "sha"),
      join(repo, "snapshots", "abc", "model.safetensors"),
    );
    await mkdir(join(hub, "datasets--owner--data"), { recursive: true });
    await mkdir(join(hub, "models--tokenizer--only", "snapshots", "x"), {
      recursive: true,
    });
    const lm = join(
      app.directory,
      "lmstudio-models",
      "community",
      "Qwen3-GGUF",
    );
    await mkdir(lm, { recursive: true });
    await writeFile(join(lm, "Qwen3-Q4_K_M.gguf"), Buffer.alloc(1000));
    const locked = join(
      app.directory,
      "lmstudio-models",
      "community",
      "Locked",
    );
    await mkdir(join(locked, "private"), { recursive: true });
    await writeFile(join(locked, "Locked-Q8_0.gguf"), Buffer.alloc(10));
    await chmod(join(locked, "private"), 0o000);
    cleanup.push(() => chmod(join(locked, "private"), 0o700));
    const found = await app.get("/api/models/discover");
    expect(found).toMatchObject({
      ollama: {
        running: true,
        models: [{ id: "qwen3:0.6b", name: "qwen3:0.6b" }],
      },
      lmstudio: { running: false },
      lmStudioFolder: {
        found: true,
        models: [
          {
            id: "community/Locked",
            formats: ["gguf"],
            sizeBytes: 10,
            weights: true,
            error: expect.stringContaining("could not be read"),
          },
          {
            id: "community/Qwen3-GGUF",
            formats: ["gguf"],
            sizeBytes: 1000,
            weights: true,
          },
        ],
      },
      huggingFaceCache: {
        found: true,
        models: [
          {
            id: "owner/name",
            formats: ["safetensors"],
            sizeBytes: 2048,
            weights: true,
          },
          { id: "tokenizer/only", formats: [], weights: false },
        ],
      },
    });
  });
});
