import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { HostedStore } from "./Store.js";
import { AnalysisQueue } from "./Queue.js";
import { previewFile } from "./analysis.js";
import {
  readDocumentIndex,
  readDocumentNodes,
  readDocumentSegment,
} from "./documentView.js";
import {
  readWasmFunctions,
  readWasmIndex,
  WASM_TEXT_OUTPUT_ID,
  wasmTextOutput,
} from "./wasmView.js";
import { HostedError, publicSubmission, type Submission } from "./types.js";
import { CATEGORIES, categoryFor } from "./catalog.js";
import {
  Budget,
  clientKey,
  DEFAULT_LIMITS,
  type HostedLimits,
} from "./Limits.js";

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
};
const readJson = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw)
      ? raw
      : Buffer.from(z.string().parse(raw));
    length += chunk.length;
    if (length > 1024 ** 2)
      throw new HostedError(413, "Request exceeds 1 MiB.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HostedError(400, "Send valid JSON.");
  }
};
const token = (req: IncomingMessage) =>
  req.headers.authorization?.replace(/^Bearer /, "");
const integer = (value: string | null, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce
    .number()
    .int()
    .min(0)
    .max(max)
    .parse(value ?? 0);
const filePath = (store: HostedStore, submission: Submission, id: string) => {
  const file = submission.files.find((entry) => entry.id === id);
  if (!file) throw new HostedError(404, "File not found.");
  const root = store.path(submission.id);
  const path = resolve(root, file.relative);
  if (!path.startsWith(root + sep))
    throw new HostedError(404, "File not found.");
  return { file, path };
};
/** Throw a 429 carrying Retry-After when a budget refused the request. */
const refuse = (retryAfter: number | null, message: string) => {
  if (retryAfter !== null) throw new HostedError(429, message, retryAfter);
};
const ACTIVE_STATUSES = new Set(["uploading", "queued", "analyzing"]);
/** Constant-time match of a bearer token against the configured operator token. */
const matchesOperator = (
  provided: string | undefined,
  operator: string | undefined,
): boolean => {
  if (!provided || !operator) return false;
  // Hash both sides so the comparison is fixed-length and reveals no length.
  return timingSafeEqual(
    createHash("sha256").update(provided).digest(),
    createHash("sha256").update(operator).digest(),
  );
};
/** Publishable PostHog config from the environment; null disables analytics entirely. */
const readAnalytics = (): { key: string; host: string } | null => {
  const key = process.env.OOPSWARE_POSTHOG_KEY?.trim();
  if (!key) return null;
  const raw =
    process.env.OOPSWARE_POSTHOG_HOST?.trim() || "https://eu.i.posthog.com";
  let host: URL;
  try {
    host = new URL(raw);
  } catch {
    return null;
  }
  if (host.protocol !== "https:") return null;
  return { key, host: host.origin };
};

// Static pages served as bundled HTML; the library keeps its dedicated app.js.
const PAGES: Record<string, string> = {
  "/": "index.html",
  "/formats": "formats.html",
  "/privacy": "privacy.html",
  "/terms": "terms.html",
  "/report": "report.html",
  "/about": "about.html",
};
// Static assets served verbatim with their content types.
const STATIC_ASSETS: Record<string, string> = {
  "/app.js": "text/javascript; charset=utf-8",
  "/site.js": "text/javascript; charset=utf-8",
  "/formats.js": "text/javascript; charset=utf-8",
  "/styles.css": "text/css; charset=utf-8",
  "/site.css": "text/css; charset=utf-8",
};

const streamFile = async (
  res: ServerResponse,
  path: string,
  name: string,
  charge: (bytes: number) => void,
  mime = "application/octet-stream",
) => {
  const info = await stat(path);
  charge(info.size);
  res.writeHead(200, {
    "Content-Type": mime,
    "Content-Length": info.size,
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name).replaceAll("'", "%27")}`,
  });
  await pipeline(createReadStream(path), res);
};

/** Dedicated public adapter: no arbitrary paths, commands, runtime tools, or shared keys. */
export const startHostedServer = async (options: {
  directory: string;
  port?: number;
  host?: string;
  worker?: string;
  assets?: string;
  limits?: Partial<HostedLimits>;
  /** Shared secret that lets an operator remove any submission; defaults to OOPSWARE_OPERATOR_TOKEN. */
  operatorToken?: string;
}) => {
  const store = new HostedStore(resolve(options.directory));
  await store.initialize();
  const queue = new AnalysisQueue(store, options.worker);
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  // Takedowns: when this secret is set, a Bearer match removes any submission. Off (no removal) when unset.
  const operatorToken =
    options.operatorToken ??
    (process.env.OOPSWARE_OPERATOR_TOKEN?.trim() || undefined);
  const uploads = new Budget(limits.uploadsPerHour, 60 * 60_000);
  const requests = new Budget(limits.requestsPerMinute, 60_000);
  const downloads = new Budget(limits.downloadBytesPerHour, 60 * 60_000);
  // Which visitor started each recent upload, in memory only, to cap uploads waiting per visitor.
  const owners = new Map<string, string>();
  const statusOf = (id: string) =>
    store.get(id).then(
      (value) => value.status,
      () => undefined,
    );
  const activeUploads = async (client: string) => {
    let count = 0;
    for (const [id, owner] of owners) {
      if (owner !== client) continue;
      const status = await statusOf(id);
      if (status && ACTIVE_STATUSES.has(status)) count += 1;
      else owners.delete(id);
    }
    return count;
  };
  const pruneOwners = async () => {
    for (const id of owners.keys()) {
      const status = await statusOf(id);
      if (!status || !ACTIVE_STATUSES.has(status)) owners.delete(id);
    }
  };
  // Admissions run one at a time so the free-space reservation stays exact; later visitors wait instead of failing.
  let admissions: Promise<unknown> = Promise.resolve();
  const admit = <T>(action: () => Promise<T>): Promise<T> => {
    const run = admissions.then(async () => {
      store.busy.add("create");
      try {
        return await action();
      } finally {
        store.busy.delete("create");
      }
    });
    admissions = run.catch(() => undefined);
    return run;
  };
  const assets =
    options.assets ?? fileURLToPath(new URL("./public/", import.meta.url));
  const analytics = readAnalytics();
  // Only the analytics host is added to connect-src, and only when configured.
  const csp = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    // PostHog fetches remote config from a sibling "-assets" host; allow both when configured.
    `connect-src 'self'${analytics ? ` ${analytics.host} ${analytics.host.replace(/^(https:\/\/[^.]+)\./, "$1-assets.")}` : ""}`,
    "font-src 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join("; ");
  let closing = false;
  const server = createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", csp);
    // Browsers honor HSTS only over HTTPS, so local HTTP runs are unaffected.
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    );
    void dispatch(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof HostedError && error.retryAfter !== undefined)
        res.setHeader("Retry-After", String(error.retryAfter));
      json(
        res,
        error instanceof HostedError
          ? error.status
          : error instanceof z.ZodError
            ? 400
            : 500,
        {
          error:
            error instanceof HostedError
              ? error.message
              : error instanceof z.ZodError
                ? "Invalid request parameters."
                : "The request could not be completed. Please try again.",
        },
      );
    });
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 15_000;
  server.maxHeadersCount = 40;

  const mutate = async (key: string, action: () => Promise<unknown>) => {
    if (store.busy.has(key))
      throw new HostedError(
        409,
        "Another request is updating this upload. Please retry.",
      );
    store.busy.add(key);
    try {
      return await action();
    } finally {
      store.busy.delete(key);
    }
  };

  async function dispatch(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (closing)
      throw new HostedError(
        503,
        "The server is restarting. Please try again shortly.",
      );
    const url = new URL(req.url ?? "/", "http://hosted.invalid");
    const method = req.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      if (req.headers["sec-fetch-site"] === "cross-site")
        throw new HostedError(403, "Use this site's upload form.");
      const origin = req.headers.origin;
      // An opaque ("null") or malformed origin is never this site.
      if (
        origin &&
        (!URL.canParse(origin) || new URL(origin).host !== req.headers.host)
      )
        throw new HostedError(403, "Cross-origin writes are not allowed.");
    }
    const client = clientKey(req);
    // Upload chunks are already bounded by their upload token and declared size.
    const chunk =
      method === "PUT" &&
      /^\/api\/submissions\/[^/]+\/chunk$/.test(url.pathname);
    if (url.pathname.startsWith("/api/") && !chunk)
      refuse(
        requests.spend(client),
        "Too many requests from your network. Please wait a minute and try again.",
      );
    const download = (bytes: number) =>
      refuse(
        downloads.spend(client, bytes),
        "Your network has downloaded a lot from the library in the last hour. Please try again later.",
      );
    if (url.pathname === "/health" && method === "GET") {
      json(res, 200, { status: "ok", mode: "public-static" });
      return;
    }
    if (method === "GET" || method === "HEAD") {
      // Inline SVG site mark; avoids a favicon 404 without shipping a binary.
      if (url.pathname === "/favicon.ico" || url.pathname === "/favicon.svg") {
        const svg =
          "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'>" +
          "<rect width='32' height='32' fill='#fbf9f4'/>" +
          "<text x='16' y='24' font-family='monospace' font-size='22' fill='#d1432b' text-anchor='middle'>::</text></svg>";
        res.writeHead(200, {
          "Content-Type": "image/svg+xml",
          "Cache-Control": "public, max-age=86400",
        });
        res.end(method === "HEAD" ? undefined : svg);
        return;
      }
      // Publishable analytics config, or an inert stub when analytics is off.
      if (url.pathname === "/config.js") {
        const body = analytics
          ? `window.OOPSWARE_ANALYTICS=${JSON.stringify(analytics)};`
          : "window.OOPSWARE_ANALYTICS=null;";
        res.writeHead(200, {
          "Content-Type": "text/javascript; charset=utf-8",
        });
        res.end(method === "HEAD" ? undefined : body);
        return;
      }
      // Self-hosted variable fonts, cached hard; names are restricted to our files.
      const font = /^\/fonts\/([a-z0-9-]+\.woff2)$/.exec(url.pathname);
      if (font?.[1]) {
        const data = await readFile(join(assets, "fonts", font[1])).catch(
          (cause: unknown) => {
            if (
              cause instanceof Error &&
              "code" in cause &&
              cause.code === "ENOENT"
            )
              throw new HostedError(404, "Not found.");
            throw cause;
          },
        );
        res.writeHead(200, {
          "Content-Type": "font/woff2",
          "Cache-Control": "public, max-age=31536000, immutable",
        });
        res.end(method === "HEAD" ? undefined : data);
        return;
      }
      const page = PAGES[url.pathname];
      if (page) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          method === "HEAD" ? undefined : await readFile(join(assets, page)),
        );
        return;
      }
      const assetMime = STATIC_ASSETS[url.pathname];
      if (assetMime) {
        res.writeHead(200, { "Content-Type": assetMime });
        res.end(
          method === "HEAD"
            ? undefined
            : await readFile(join(assets, url.pathname.slice(1))),
        );
        return;
      }
    }
    if (url.pathname === "/api/submissions") {
      if (method === "POST") {
        // Read the body before queueing, so a slow sender cannot hold up other visitors.
        const input = await readJson(req);
        json(
          res,
          201,
          await admit(async () => {
            if ((await activeUploads(client)) >= limits.activeUploads)
              throw new HostedError(
                429,
                "You already have uploads in progress or waiting for inspection. Try again when one finishes.",
                30,
              );
            refuse(
              uploads.spend(client),
              "Many uploads have started from your network in the last hour. Please try again later.",
            );
            const admission = await store.create(input);
            owners.set(admission.id, client);
            return admission;
          }),
        );
        return;
      }
      if (method === "GET") {
        const query = (url.searchParams.get("q") ?? "")
          .slice(0, 200)
          .toLowerCase();
        const category = z
          .enum(["all", ...CATEGORIES])
          .parse(url.searchParams.get("category") ?? "all");
        const status = z
          .enum(["all", "ready", "processing", "failed"])
          .parse(url.searchParams.get("status") ?? "all");
        const sort = z
          .enum(["newest", "oldest", "name", "size"])
          .parse(url.searchParams.get("sort") ?? "newest");
        const published = (await store.list()).filter(
          (entry) => entry.status !== "uploading",
        );
        const matches = published.filter(
          (entry) =>
            entry.name.toLowerCase().includes(query) &&
            (status === "all" ||
              (status === "processing"
                ? ["queued", "analyzing"].includes(entry.status)
                : entry.status === status)),
        );
        const categories = Object.fromEntries(
          CATEGORIES.map((key) => [
            key,
            matches.filter((entry) => categoryFor(entry.name) === key).length,
          ]),
        );
        const all = matches.filter(
          (entry) => category === "all" || categoryFor(entry.name) === category,
        );
        all.sort((a, b) => {
          const order =
            sort === "name"
              ? a.name.localeCompare(b.name)
              : sort === "size"
                ? b.size - a.size
                : sort === "oldest"
                  ? a.createdAt.localeCompare(b.createdAt)
                  : b.createdAt.localeCompare(a.createdAt);
          return order || a.id.localeCompare(b.id);
        });
        const offset = integer(url.searchParams.get("offset"));
        json(res, 200, {
          // Cards need only the original; the item endpoint returns every file.
          items: all.slice(offset, offset + 30).map((entry) => {
            const item = publicSubmission(entry);
            return {
              ...item,
              fileCount: item.files.length,
              files: item.files.filter((file) => file.id === entry.id),
            };
          }),
          total: all.length,
          archiveTotal: published.length,
          matchingTotal: matches.length,
          categories,
          nextOffset: offset + 30 < all.length ? offset + 30 : null,
        });
        return;
      }
    }
    const match = /^\/api\/submissions\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
    if (match?.[1]) {
      const id = z.string().uuid().parse(match[1]);
      const action = match[2] ?? "";
      if (
        ["chunk", "complete", ""].includes(action) &&
        ["PUT", "POST", "DELETE"].includes(method)
      ) {
        const operator =
          action === "" &&
          method === "DELETE" &&
          matchesOperator(token(req), operatorToken);
        // A takedown must not wait for, or be undone by, a worker still writing into the folder.
        if (operator) await queue.cancel(id);
        const value = await mutate(id, async () => {
          const submission = await store.get(id);
          // An operator takedown carries the operator secret, not this upload's token.
          if (!operator) store.authorize(submission, token(req));
          if (action === "chunk" && method === "PUT")
            await store.append(
              submission,
              integer(url.searchParams.get("offset")),
              req,
            );
          else if (action === "complete" && method === "POST") {
            await store.finish(submission);
            queue.enqueue(id);
          } else if (action === "" && method === "DELETE") {
            if (operator) await store.remove(submission);
            else await store.discard(submission);
            return { removed: true };
          } else throw new HostedError(405, "Method not allowed.");
          return publicSubmission(await store.get(id));
        });
        json(res, 200, value);
        return;
      }
      const submission = await store.get(id);
      if (submission.status === "uploading")
        store.authorize(submission, token(req));
      if (!action && method === "GET") {
        json(res, 200, publicSubmission(submission));
        return;
      }
      if (action === "report" && method === "GET") {
        await streamFile(
          res,
          join(store.path(id), "report.json"),
          "analysis.json",
          download,
          "application/json",
        );
        return;
      }
      // Structured-text views exist only for the uploaded original, by fixed IDs.
      if (action === "structure" && method === "GET") {
        json(res, 200, await readDocumentIndex(store.path(id)));
        return;
      }
      const nodesMatch = /^structure\/nodes\/(\d{1,6})$/.exec(action);
      if (nodesMatch?.[1] && method === "GET") {
        json(
          res,
          200,
          await readDocumentNodes(store.path(id), Number(nodesMatch[1])),
        );
        return;
      }
      const segmentMatch = /^previews\/segment-(\d{1,6})$/.exec(action);
      if (segmentMatch?.[1] && method === "GET") {
        const { path } = filePath(store, submission, submission.id);
        json(
          res,
          200,
          await readDocumentSegment(
            store.path(id),
            path,
            Number(segmentMatch[1]),
          ),
        );
        return;
      }
      // WebAssembly views and the derived WAT exist only for the original, by fixed IDs.
      if (action === "wasm" && method === "GET") {
        json(res, 200, await readWasmIndex(store.path(id)));
        return;
      }
      const functionsMatch = /^wasm\/functions\/(\d{1,6})$/.exec(action);
      if (functionsMatch?.[1] && method === "GET") {
        json(
          res,
          200,
          await readWasmFunctions(store.path(id), Number(functionsMatch[1])),
        );
        return;
      }
      if (action === `outputs/${WASM_TEXT_OUTPUT_ID}` && method === "GET") {
        const output = await wasmTextOutput(store.path(id), submission.name);
        await streamFile(
          res,
          output.path,
          output.name,
          download,
          "text/plain; charset=utf-8",
        );
        return;
      }
      const fileMatch = /^files\/([^/]+)(?:\/(preview))?$/.exec(action);
      if (fileMatch?.[1] && method === "GET") {
        const { file, path } = filePath(store, submission, fileMatch[1]);
        if (fileMatch[2])
          json(
            res,
            200,
            await previewFile(path, integer(url.searchParams.get("offset"))),
          );
        else await streamFile(res, path, file.name, download);
        return;
      }
    }
    throw new HostedError(404, "Not found.");
  }

  await queue.recover();
  await store.sweepExpired();
  // Enforce auto-delete and drop abandoned uploads while the server runs; forget stale visitor counts.
  const sweeper = setInterval(() => {
    void store.sweepExpired().catch(() => undefined);
    void pruneOwners().catch(() => undefined);
    for (const budget of [uploads, requests, downloads]) budget.prune();
  }, 10 * 60_000);
  sweeper.unref();
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 8080, options.host ?? "0.0.0.0", () => {
      server.off("error", reject);
      accept();
    });
  });
  return {
    server,
    store,
    close: async () => {
      closing = true;
      clearInterval(sweeper);
      queue.close();
      server.closeAllConnections();
      await new Promise<void>((accept) => server.close(() => accept()));
    },
  };
};
