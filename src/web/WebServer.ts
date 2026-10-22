import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, mkdir, rm, open } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Workspace } from "./Workspace.js";
import { OpenAiConnection } from "./providers/OpenAiConnection.js";
import {
  ModelConnections,
  modelProviderSchema,
  type ModelEndpoints,
} from "./providers/ModelConnections.js";
import {
  downloadModel,
  downloadRequestSchema,
  searchCatalog,
} from "./providers/ModelDownloads.js";
import { messageSchema, streamInference } from "./providers/Inference.js";
import { WebFailure } from "./WebFailure.js";
import { ToolWorkspace } from "./ToolWorkspace.js";
import { createWebToolRoutes } from "./WebToolRoutes.js";
import { REPORT_PAGE_POLICY } from "./ReportRoutes.js";
import { wireProjects } from "./projectWiring.js";
import { MaintenanceService } from "./MaintenanceService.js";

const MAX_UPLOAD = 128 * 1024 * 1024;
const pathSchema = z.object({
  path: z.string().min(1).max(4096),
  offset: z.number().int().nonnegative().default(0),
});
const chatSchema = z.object({
  provider: modelProviderSchema,
  model: z.string().min(1).max(300),
  messages: z.array(messageSchema).min(1).max(40),
  context: z.string().max(80_000).default(""),
});
const json = (res: ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
};
const dataDirectory = () => join(homedir(), ".config", "rea", "web");

/** Start Oopsware's own loopback-only web interface, backed by the shared analysis workflows. */
export const startReaWeb = async (
  options: {
    port?: number;
    directory?: string;
    environment?: Readonly<Record<string, string | undefined>>;
    ollamaUrl?: string;
    modelEndpoints?: Partial<ModelEndpoints>;
    authEndpoints?: ConstructorParameters<typeof OpenAiConnection>[2];
  } = {},
) => {
  const token = randomBytes(32).toString("base64url");
  const workspace = new Workspace(options.environment ?? process.env);
  const directory = options.directory ?? dataDirectory();
  const controllers = new Set<AbortController>();
  const tools = new ToolWorkspace(
    join(directory, "workspaces"),
    options.environment ?? process.env,
  );
  const projects = wireProjects(
    directory,
    tools,
    options.environment ?? process.env,
  );
  const routeTools = createWebToolRoutes(tools, projects.hooks);
  const routeProjects = projects.routes;
  const maintenance = new MaintenanceService(
    options.environment ?? process.env,
  );
  let connections: ModelConnections;
  let origin = "";
  let closing = false;
  const server = createServer((req, res) => {
    void dispatch(req, res).catch((error) => reportError(res, error));
  });
  server.requestTimeout = 180_000;
  server.headersTimeout = 15_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 4097, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (typeof address !== "object" || address === null)
    throw new Error("Oopsware web listener has no address.");
  origin = `http://127.0.0.1:${address.port}`;
  connections = new ModelConnections(
    new OpenAiConnection(
      directory,
      `${origin}/auth/callback`,
      options.authEndpoints,
    ),
    {
      endpoints: {
        ...options.modelEndpoints,
        ...(options.ollamaUrl ? { ollama: options.ollamaUrl } : {}),
      },
      environment: options.environment ?? process.env,
    },
  );
  try {
    await connections.initialize();
  } catch (error) {
    server.close();
    throw error;
  }

  async function dispatch(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (closing)
      throw new WebFailure(503, "server_closing", "Oopsware is shutting down.");
    const host = req.headers.host;
    if (host !== new URL(origin).host)
      throw new WebFailure(403, "host_denied", `Open Oopsware at ${origin}.`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self' data:; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    const url = new URL(req.url ?? "/", origin);
    if (url.pathname === "/auth/callback" && req.method === "GET") {
      await connections.openai.complete(url.searchParams);
      res.writeHead(303, {
        Location: "/?connected=openai",
        "Cache-Control": "no-store",
      });
      res.end();
      return;
    }
    if (url.pathname === "/health" && req.method === "GET") {
      json(res, 200, { app: "Oopsware", ready: true });
      return;
    }
    if (
      req.method === "GET" &&
      [
        "/",
        "/app.js",
        "/styles.css",
        "/dashboard.js",
        "/dashboard.css",
      ].includes(url.pathname)
    ) {
      const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const file = await readFile(
        new URL(`../../web/${name}`, import.meta.url),
        "utf8",
      );
      const content =
        name === "index.html" ? file.replace("__REA_TOKEN__", token) : file;
      res.writeHead(200, {
        "Content-Type": name.endsWith("html")
          ? "text/html; charset=utf-8"
          : name.endsWith("css")
            ? "text/css; charset=utf-8"
            : "text/javascript; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(content);
      return;
    }
    const viewTicket = /^\/report-view\/([A-Za-z0-9_-]{43})$/.exec(
      url.pathname,
    )?.[1];
    if (viewTicket !== undefined && req.method === "GET") {
      // A one-time link stands in for the page token: a new tab cannot send it.
      const file = await projects.reports.view(viewTicket);
      if (!file)
        throw new WebFailure(
          404,
          "report_not_found",
          "This report link has expired. Open the report again.",
        );
      res.setHeader("Content-Security-Policy", REPORT_PAGE_POLICY);
      res.writeHead(200, {
        "Content-Type": file.type,
        "Content-Disposition": `inline; filename="${file.name}"`,
        "Cache-Control": "no-store",
      });
      res.end(file.bytes);
      return;
    }
    if (req.headers.origin !== undefined && req.headers.origin !== origin)
      throw new WebFailure(
        403,
        "origin_denied",
        "Requests must come from this Oopsware window.",
      );
    if (req.headers["x-rea-token"] !== token)
      throw new WebFailure(
        403,
        "session_required",
        "Reload the Oopsware page to reconnect.",
      );
    const toolRoute = await routeTools(
      `${url.pathname}${url.search}`,
      req.method,
      () => readJson(req),
    );
    if (toolRoute) {
      json(res, toolRoute.status, toolRoute.body);
      return;
    }
    const reportRoute = await projects.reports.route(
      `${url.pathname}${url.search}`,
      req.method,
      () => readJson(req),
    );
    if (reportRoute && "file" in reportRoute) {
      res.writeHead(reportRoute.status, {
        "Content-Type": reportRoute.file.type,
        "Content-Disposition": `attachment; filename="${reportRoute.file.name}"`,
        "Cache-Control": "no-store",
      });
      res.end(reportRoute.file.bytes);
      return;
    }
    if (reportRoute) {
      json(res, reportRoute.status, reportRoute.body);
      return;
    }
    const projectRoute = await routeProjects(
      `${url.pathname}${url.search}`,
      req.method,
      () => readJson(req),
    );
    if (projectRoute) {
      json(res, projectRoute.status, projectRoute.body);
      return;
    }
    if (url.pathname === "/api/maintenance") {
      if (req.method === "GET") {
        json(res, 200, maintenance.describe());
        return;
      }
      if (req.method === "POST") {
        json(res, 200, await maintenance.execute(await readJson(req)));
        return;
      }
    }
    if (url.pathname === "/api/status" && req.method === "GET") {
      json(res, 200, {
        app: "Oopsware",
        platform: process.platform,
        home: homedir(),
        cwd: process.cwd(),
        ...(await connections.status()),
      });
      return;
    }
    if (url.pathname === "/api/models" && req.method === "GET") {
      json(
        res,
        200,
        await connections.models(
          modelProviderSchema.parse(url.searchParams.get("provider")),
        ),
      );
      return;
    }
    if (url.pathname === "/api/models/discover" && req.method === "GET") {
      json(res, 200, await connections.discover());
      return;
    }
    if (url.pathname === "/api/models/catalog" && req.method === "GET") {
      json(
        res,
        200,
        await searchCatalog(
          connections,
          z
            .enum(["ollama-cloud", "huggingface"])
            .parse(url.searchParams.get("source")),
          z
            .string()
            .max(120)
            .parse(url.searchParams.get("q") ?? ""),
        ),
      );
      return;
    }
    if (req.method !== "POST")
      throw new WebFailure(
        404,
        "not_found",
        "This Oopsware route does not exist.",
      );
    if (url.pathname === "/api/upload") {
      json(res, 200, await upload(req, url, directory, workspace));
      return;
    }
    const body = await readJson(req);
    if (url.pathname === "/api/sample") {
      json(
        res,
        200,
        await workspace.view(
          fileURLToPath(new URL("../../web/sample.js", import.meta.url)),
        ),
      );
      return;
    }
    if (url.pathname === "/api/auth/openai") {
      json(res, 200, connections.openai.start());
      return;
    }
    if (url.pathname === "/api/auth/ollama") {
      json(res, 200, await connections.connectOllama());
      return;
    }
    if (url.pathname === "/api/auth/claude") {
      await connections.connectClaude(
        z.object({ apiKey: z.string().min(1).max(4096) }).parse(body).apiKey,
      );
      json(res, 200, { connected: true });
      return;
    }
    if (
      url.pathname === "/api/auth/huggingface" ||
      url.pathname === "/api/auth/openrouter"
    ) {
      const input = z
        .object({
          apiKey: z.string().trim().min(1).max(4096).optional(),
          disconnect: z.literal(true).optional(),
        })
        .parse(body);
      const provider =
        url.pathname === "/api/auth/huggingface" ? "huggingface" : "openrouter";
      if (input.disconnect) {
        // A key from the environment or the hf CLI stays in use after a saved key is removed.
        json(res, 200, await connections.disconnect(provider));
        return;
      }
      if (!input.apiKey)
        throw new WebFailure(400, "key_required", "Paste a key first.");
      if (provider === "huggingface")
        json(res, 200, {
          connected: true,
          ...(await connections.connectHuggingFace(input.apiKey)),
        });
      else {
        await connections.connectOpenRouter(input.apiKey);
        json(res, 200, { connected: true });
      }
      return;
    }
    if (url.pathname === "/api/browse" || url.pathname === "/api/open") {
      const input = pathSchema.parse(body);
      json(
        res,
        200,
        await (url.pathname === "/api/browse"
          ? workspace.browse(input.path, input.offset)
          : workspace.view(input.path, input.offset)),
      );
      return;
    }
    if (url.pathname === "/api/inspect") {
      json(res, 200, await workspace.inspect(pathSchema.parse(body).path));
      return;
    }
    const controller = new AbortController();
    controllers.add(controller);
    const cancel = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.once("close", cancel);
    try {
      if (url.pathname === "/api/analyze") {
        const input = z
          .object({
            path: z.string().min(1),
            mode: z.enum(["binary", "javascript"]),
          })
          .parse(body);
        json(
          res,
          200,
          await workspace.analyze(input.path, input.mode, controller.signal),
        );
        return;
      }
      if (url.pathname === "/api/models/download") {
        const request = downloadRequestSchema.parse(body);
        res.writeHead(200, {
          "Content-Type": "application/x-ndjson",
          "Cache-Control": "no-store",
        });
        res.flushHeaders();
        try {
          await downloadModel({
            connections,
            request,
            signal: controller.signal,
            emit: (progress) => {
              res.write(
                `${JSON.stringify({ type: "progress", ...progress })}\n`,
              );
            },
          });
          res.end(`${JSON.stringify({ type: "done" })}\n`);
        } catch (error) {
          if (!res.destroyed)
            res.end(
              `${JSON.stringify({ type: "error", message: errorMessage(error) })}\n`,
            );
        }
        return;
      }
      if (url.pathname === "/api/chat") {
        const input = chatSchema.parse(body);
        res.writeHead(200, {
          "Content-Type": "application/x-ndjson",
          "Cache-Control": "no-store",
        });
        res.flushHeaders();
        try {
          await streamInference({
            ...input,
            connections,
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(300_000),
            ]),
            emit: (text) => {
              res.write(`${JSON.stringify({ type: "delta", text })}\n`);
            },
          });
          res.end(`${JSON.stringify({ type: "done" })}\n`);
        } catch (error) {
          if (!res.destroyed)
            res.end(
              `${JSON.stringify({ type: "error", message: errorMessage(error) })}\n`,
            );
        }
        return;
      }
      throw new WebFailure(
        404,
        "not_found",
        "This Oopsware route does not exist.",
      );
    } finally {
      controllers.delete(controller);
      res.off("close", cancel);
    }
  }
  return {
    url: origin,
    server,
    close: async () => {
      closing = true;
      const listenerClosed = new Promise<void>((resolve) =>
        server.close(() => resolve()),
      );
      for (const controller of controllers) controller.abort();
      try {
        await Promise.all([tools.close(), maintenance.close()]);
      } finally {
        server.closeAllConnections();
        await listenerClosed;
      }
    },
  };
};

const readJson = async (req: IncomingMessage): Promise<unknown> => {
  if (!req.headers["content-type"]?.startsWith("application/json"))
    throw new WebFailure(415, "json_required", "Send JSON for this action.");
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(z.string().parse(chunk));
    length += data.length;
    if (length > 2 * 1024 * 1024)
      throw new WebFailure(
        413,
        "request_too_large",
        "This request exceeds the 2 MiB limit. Use a shorter conversation or smaller inspection context.",
      );
    chunks.push(data);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new WebFailure(400, "invalid_json", "The request is not valid JSON.");
  }
};
const upload = async (
  req: IncomingMessage,
  url: URL,
  directory: string,
  workspace: Workspace,
) => {
  const name = z.string().min(1).max(255).parse(url.searchParams.get("name"));
  if (
    basename(name) !== name ||
    name === "." ||
    name === ".." ||
    /[\\\0]/.test(name)
  )
    throw new WebFailure(
      400,
      "invalid_filename",
      "Upload a file with a plain filename.",
    );
  const folder = join(directory, "uploads", randomUUID());
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const path = join(folder, name);
  const file = await open(path, "wx", 0o600);
  let size = 0;
  try {
    for await (const chunk of req) {
      const bytes = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(z.string().parse(chunk));
      size += bytes.length;
      if (size > MAX_UPLOAD)
        throw new WebFailure(
          413,
          "upload_too_large",
          "Uploads are limited to 128 MiB. Use Open path for larger local files.",
        );
      await file.writeFile(bytes);
    }
  } catch (error) {
    await file.close();
    await rm(folder, { recursive: true, force: true });
    throw error;
  }
  await file.close();
  return workspace.view(path);
};
const errorMessage = (error: unknown): string => {
  if (error instanceof WebFailure) return error.message;
  if (error instanceof z.ZodError)
    return error.issues
      .map((issue) => `${issue.path.join(".") || "Input"}: ${issue.message}`)
      .join("; ");
  if (typeof error === "object" && error !== null && "code" in error) {
    if (error.code === "ENOENT")
      return "That path does not exist. Check the full path and try again.";
    if (error.code === "EACCES" || error.code === "EPERM")
      return "macOS denied access to that path. Choose a readable file or grant filesystem access to the terminal running Oopsware.";
  }
  if (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  )
    return "The operation stopped or timed out. Partial output is preserved.";
  return "The operation failed. Check the selected file or provider, then retry.";
};
const reportError = (res: ServerResponse, error: unknown) => {
  if (res.destroyed) return;
  if (res.headersSent) {
    res.end();
    return;
  }
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? error.code
      : undefined;
  const status =
    error instanceof WebFailure
      ? error.status
      : error instanceof z.ZodError
        ? 400
        : code === "ENOENT"
          ? 404
          : code === "EACCES" || code === "EPERM"
            ? 403
            : 500;
  json(res, status, {
    error: error instanceof WebFailure ? error.code : "request_failed",
    message: errorMessage(error),
  });
};
