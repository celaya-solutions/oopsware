import { afterEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ZipWriter, Uint8ArrayWriter, TextReader } from "@zip.js/zip.js";
import { z } from "zod";
import { startHostedServer } from "../../../src/hosted/Server.js";
import { assembleWat } from "../../../src/wasm/wabt.js";
import type { HostedLimits } from "../../../src/hosted/Limits.js";
import {
  createArchiveSourceTree,
  produceGzip,
  produceTar,
  produceXz,
  XZ,
} from "../../fixtures/archiveProducers.js";
import {
  buildLinuxFixtures,
  LINUX_TOOLS,
} from "../../fixtures/linuxProducers.js";
import {
  buildWindowsFixtures,
  WINDOWS_TOOLS,
} from "../../fixtures/windowsProducers.js";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});
const admissionSchema = z.object({ id: z.string(), token: z.string() });
const publicSchema = z.object({
  id: z.string(),
  status: z.string(),
  received: z.number(),
  expiresAt: z.string().nullable(),
  files: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      size: z.number(),
      sha256: z.string(),
    }),
  ),
});

/** The runtime's WebAssembly validator; this project's lib omits its types. */
const validateWasm = (bytes: Uint8Array): boolean =>
  (
    Reflect.get(globalThis, "WebAssembly") as {
      validate: (bytes: Uint8Array) => boolean;
    }
  ).validate(bytes);

const detectionReportSchema = z.object({
  format: z.string(),
  summary: z.string().optional(),
  format_detection: z.object({
    state: z.enum(["recognized", "unrecognized"]),
    candidates: z.array(
      z.object({
        format: z.string(),
        basis: z.string(),
        version: z.string().nullable(),
        evidence: z
          .object({
            offset: z.number(),
            length: z.number(),
            observed_hex: z.string(),
          })
          .nullable(),
      }),
    ),
    name_hint: z.object({
      extension: z.string().nullable(),
      formats: z.array(z.string()),
    }),
    contradictions: z.array(z.object({ hinted: z.array(z.string()) })),
    capabilities: z.array(
      z.object({
        format: z.string(),
        facets: z.record(
          z.string(),
          z.object({ state: z.string(), reason: z.string().nullable() }),
        ),
      }),
    ),
  }),
});

async function launch(
  limits?: Partial<HostedLimits>,
  operatorToken?: string,
  worker = resolve("dist-hosted/worker.mjs"),
) {
  const directory = await mkdtemp(join(tmpdir(), "rea-hosted-test-"));
  closers.push(() => rm(directory, { recursive: true, force: true }));
  const options = {
    directory,
    port: 0,
    host: "127.0.0.1",
    worker,
    assets: resolve("hosted/public"),
    ...(limits ? { limits } : {}),
    ...(operatorToken ? { operatorToken } : {}),
  };
  let app = await startHostedServer(options);
  closers.push(async () => {
    await app.close();
  });
  const origin = () => {
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    return `http://127.0.0.1:${address.port}`;
  };
  const request = (path: string, options?: RequestInit) =>
    fetch(`${origin()}${path}`, options);
  const post = (path: string, body: unknown) =>
    request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const upload = async (name: string, bytes: Uint8Array, autoDelete = true) => {
    const response = await post("/api/submissions", {
      name,
      size: bytes.length,
      agreement: true,
      autoDelete,
    });
    expect(response.status).toBe(201);
    const admitted = admissionSchema.parse(await response.json());
    const headers = { Authorization: `Bearer ${admitted.token}` };
    const path = `/api/submissions/${admitted.id}`;
    expect(
      (
        await request(`${path}/chunk?offset=0`, {
          method: "PUT",
          headers,
          body: Buffer.from(bytes),
        })
      ).status,
    ).toBe(200);
    expect(
      (await request(`${path}/complete`, { method: "POST", headers })).status,
    ).toBe(200);
    await expect
      .poll(
        async () =>
          publicSchema.parse(await (await request(path)).json()).status,
        { timeout: 20_000, interval: 100 },
      )
      .toBe("ready");
    return { ...admitted, path };
  };
  return {
    directory,
    request,
    post,
    upload,
    store: () => app.store,
    restart: async () => {
      await app.close();
      app = await startHostedServer(options);
    },
  };
}

it("publishes an archive, extracts exact bytes, keeps hostile markup inert, and survives restart", async () => {
  const app = await launch();
  const zip = new ZipWriter(new Uint8ArrayWriter());
  const source =
    "<script>globalThis.uploadExecuted=true</script>\nexport const answer = 42;";
  await zip.add("src/example.js", new TextReader(source));
  await zip.add(
    "README.txt",
    new TextReader("A public fixture, no personal data."),
  );
  const uploaded = await app.upload("example.zip", await zip.close());
  const response = await app.request(uploaded.path);
  const raw = await response.text();
  expect(raw).not.toContain(uploaded.token);
  expect(raw).not.toContain("tokenHash");
  expect(raw).not.toContain("relative");
  const item = publicSchema.parse(JSON.parse(raw));
  const child = item.files.find((file) => file.name === "src/example.js");
  expect(child).toBeDefined();
  if (!child) throw new Error("No extracted source");
  const download = await app.request(`${uploaded.path}/files/${child.id}`);
  expect(download.headers.get("content-type")).toBe("application/octet-stream");
  expect(download.headers.get("content-disposition")).toContain("attachment");
  expect(await download.text()).toBe(source);
  const preview = await app.request(
    `${uploaded.path}/files/${child.id}/preview`,
  );
  expect(z.object({ text: z.string() }).parse(await preview.json()).text).toBe(
    source,
  );
  expect([400, 404]).toContain(
    (await app.request(`${uploaded.path}/files/../../etc/passwd`)).status,
  );
  expect((await app.request("/api/browse?path=/etc/passwd")).status).toBe(404);
  expect((await app.post("/api/tools", { command: "whoami" })).status).toBe(
    404,
  );
  expect(
    (
      await app.request(`${uploaded.path}/chunk?offset=0`, {
        method: "PUT",
        body: "overwrite",
      })
    ).status,
  ).toBe(403);
  const report = z
    .object({
      sha256: z.string(),
      format: z.string(),
      files: z.array(z.unknown()),
    })
    .parse(await (await app.request(`${uploaded.path}/report`)).json());
  expect(report.format).toBe("zip");
  expect(report.sha256).toHaveLength(64);
  expect(report.files).toHaveLength(3);
  const detection = detectionReportSchema.parse(
    await (await app.request(`${uploaded.path}/report`)).json(),
  ).format_detection;
  expect(detection.state).toBe("recognized");
  expect(detection.candidates).toEqual([
    expect.objectContaining({
      format: "zip",
      basis: "byte-signature",
      evidence: { offset: 0, length: 4, observed_hex: "504b0304" },
    }),
  ]);
  expect(detection.contradictions).toEqual([]);
  expect(detection.capabilities[0]?.facets.extract?.state).toBe("complete");
  // The browse list carries only the original and a count; details carry every file.
  const listed = z
    .object({
      items: z.array(
        z.object({
          fileCount: z.number(),
          files: z.array(z.object({ id: z.string() })),
        }),
      ),
    })
    .parse(await (await app.request("/api/submissions")).json()).items[0];
  expect(listed?.fileCount).toBe(3);
  expect(listed?.files.map((file) => file.id)).toEqual([uploaded.id]);
  await app.restart();
  expect((await app.request(`${uploaded.path}/files/${child.id}`)).status).toBe(
    200,
  );
  expect(
    z
      .object({ total: z.number() })
      .parse(await (await app.request("/api/submissions")).json()).total,
  ).toBe(1);
});

it("requires agreement, enforces byte limits and upload ownership, and resumes committed offsets", async () => {
  const app = await launch();
  for (const input of [
    { name: "x", size: 1, agreement: false },
    { name: "../secret", size: 1, agreement: true },
    { name: "huge", size: 1024 ** 3 + 1, agreement: true },
  ])
    expect((await app.post("/api/submissions", input)).status).toBe(400);
  const accepted = admissionSchema.parse(
    await (
      await app.post("/api/submissions", {
        name: "resume.bin",
        size: 6,
        agreement: true,
      })
    ).json(),
  );
  const path = `/api/submissions/${accepted.id}`,
    headers = { Authorization: `Bearer ${accepted.token}` };
  expect((await app.request(path)).status).toBe(403);
  expect(
    (
      await app.request(`${path}/chunk?offset=0`, {
        method: "PUT",
        headers,
        body: "abc",
      })
    ).status,
  ).toBe(200);
  expect(
    (await app.request(`${path}/complete`, { method: "POST", headers })).status,
  ).toBe(409);
  expect(
    (
      await app.request(`${path}/chunk?offset=0`, {
        method: "PUT",
        headers,
        body: "abc",
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await app.request(`${path}/chunk?offset=3`, {
        method: "PUT",
        headers,
        body: "toolong",
      })
    ).status,
  ).toBe(413);
  await app.restart();
  expect(
    publicSchema.parse(await (await app.request(path, { headers })).json())
      .received,
  ).toBe(3);
  expect(
    (
      await app.request(`${path}/chunk?offset=3`, {
        method: "PUT",
        headers,
        body: "def",
      })
    ).status,
  ).toBe(200);
  expect(
    (await app.request(`${path}/complete`, { method: "POST", headers })).status,
  ).toBe(200);
  await expect
    .poll(
      async () =>
        publicSchema.parse(await (await app.request(path)).json()).status,
      { timeout: 20_000 },
    )
    .toBe("ready");
  expect(await (await app.request(`${path}/files/${accepted.id}`)).text()).toBe(
    "abcdef",
  );
  const crossOrigin = await app.request("/api/submissions", {
    method: "POST",
    headers: {
      Origin: "https://other.example",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: "x", size: 1, agreement: true }),
  });
  expect(crossOrigin.status).toBe(403);
});

it("retains malformed archive evidence without extracting traversal members", async () => {
  const app = await launch();
  const zip = new ZipWriter(new Uint8ArrayWriter());
  await zip.add("../outside.txt", new TextReader("not outside"));
  const uploaded = await app.upload("unsafe.zip", await zip.close());
  const item = publicSchema.parse(
    await (await app.request(uploaded.path)).json(),
  );
  expect(item.files).toHaveLength(1);
  expect(await readdir(app.directory)).toEqual([uploaded.id]);
  const report = z
    .object({ limitations: z.array(z.string()) })
    .parse(await (await app.request(`${uploaded.path}/report`)).json());
  expect(
    report.limitations.some(
      (text) =>
        text.includes("could not") || text.includes("could be inspected"),
    ),
  ).toBe(true);
});

it("browses all matching uploads, sorts before paging, and removes public inference routes", async () => {
  // Thirty-two quick uploads from one address exceed the production hourly allowance on purpose.
  const app = await launch({
    uploadsPerHour: Infinity,
    requestsPerMinute: Infinity,
  });
  const document = await app.upload(
    "guide.md",
    Buffer.from("# A readable guide\n\nHello **library**."),
  );
  const source = await app.upload(
    "example.js",
    Buffer.from("export const value = 42;"),
  );
  const listSchema = z.object({
    items: z.array(
      z.object({ name: z.string(), category: z.string(), summary: z.string() }),
    ),
    total: z.number(),
    archiveTotal: z.number(),
    nextOffset: z.number().nullable(),
    categories: z.record(z.string(), z.number()),
  });
  const documents = listSchema.parse(
    await (
      await app.request(
        "/api/submissions?category=documents&status=ready&sort=name",
      )
    ).json(),
  );
  expect(documents.items.map((item) => item.name)).toEqual(["guide.md"]);
  expect(documents.items[0]?.summary).toContain("Markdown");
  expect(documents.archiveTotal).toBe(2);
  expect(documents.categories.source).toBe(1);
  const search = listSchema.parse(
    await (
      await app.request("/api/submissions?q=EXAMPLE&category=source")
    ).json(),
  );
  expect(search.items.map((item) => item.name)).toEqual(["example.js"]);
  expect(
    listSchema.parse(
      await (await app.request("/api/submissions?status=processing")).json(),
    ).total,
  ).toBe(0);
  expect((await app.request("/api/submissions?category=invalid")).status).toBe(
    400,
  );
  for (const action of ["chat", "ai-reports"]) {
    expect(
      (
        await app.post(`${source.path}/${action}`, {
          provider: "openai",
          key: "unused",
          messages: [],
        })
      ).status,
    ).toBe(404);
  }
  expect((await app.request(`/api/ai-jobs/${source.id}`)).status).toBe(404);
  expect((await app.request(`${source.path}/ai-reports`)).status).toBe(404);
  expect(
    await (await app.request(`${document.path}/files/${document.id}`)).text(),
  ).toContain("# A readable guide");
  // Exercise the actual upload protocol past the 30-item response page.
  for (let index = 0; index < 30; index++)
    await app.upload(
      `z-${String(index).padStart(2, "0")}.txt`,
      Buffer.from("public fixture"),
    );
  const page = listSchema.parse(
    await (await app.request("/api/submissions?sort=name")).json(),
  );
  expect(page.total).toBe(32);
  expect(page.nextOffset).toBe(30);
  const tail = listSchema.parse(
    await (
      await app.request(`/api/submissions?sort=name&offset=${page.nextOffset}`)
    ).json(),
  );
  expect(tail.items.map((item) => item.name)).toEqual(["z-28.txt", "z-29.txt"]);
  const filtered = listSchema.parse(
    await (
      await app.request("/api/submissions?category=source&sort=name")
    ).json(),
  );
  expect(filtered.items.map((item) => item.name)).toEqual(["example.js"]);
}, 60_000);

it("auto-deletes an expired submission with its files and findings, and keeps a retained one", async () => {
  const app = await launch();
  const temporary = await app.upload(
    "temporary.txt",
    Buffer.from("deletes itself after a day"),
    true,
  );
  const kept = await app.upload(
    "kept.txt",
    Buffer.from("stays until removed"),
    false,
  );
  const temporaryPublic = publicSchema.parse(
    await (await app.request(temporary.path)).json(),
  );
  const keptPublic = publicSchema.parse(
    await (await app.request(kept.path)).json(),
  );
  expect(temporaryPublic.expiresAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  expect(keptPublic.expiresAt).toBeNull();

  // Sweep as if a day and change had passed; only the auto-delete upload goes.
  const removed = await app
    .store()
    .sweepExpired(Date.now() + 25 * 60 * 60 * 1000);
  expect(removed).toBe(1);
  expect((await app.request(temporary.path)).status).toBe(404);
  expect((await app.request(kept.path)).status).toBe(200);
  expect(await readdir(app.directory)).toEqual([kept.id]);
}, 60_000);

it("serves the static pages, shared assets, and an analytics-off config", async () => {
  const app = await launch();
  for (const [path, type] of [
    ["/", "text/html"],
    ["/formats", "text/html"],
    ["/privacy", "text/html"],
    ["/terms", "text/html"],
    ["/report", "text/html"],
    ["/about", "text/html"],
    ["/site.css", "text/css"],
    ["/styles.css", "text/css"],
    ["/site.js", "text/javascript"],
    ["/formats.js", "text/javascript"],
    ["/config.js", "text/javascript"],
  ] as const) {
    const response = await app.request(path);
    expect(response.status, path).toBe(200);
    expect(response.headers.get("content-type"), path).toContain(type);
  }
  // With no PostHog key configured, analytics is explicitly disabled and the CSP stays self-only.
  expect(await (await app.request("/config.js")).text()).toContain(
    "OOPSWARE_ANALYTICS=null",
  );
  expect(
    (await app.request("/")).headers.get("content-security-policy"),
  ).not.toContain("posthog");
  expect((await app.request("/fonts/missing.woff2")).status).toBe(404);
}, 60_000);

it("refuses opaque origins and disguised filenames, and sends hardening headers", async () => {
  const app = await launch();
  const start = (name: string, headers: Record<string, string> = {}) =>
    app.request("/api/submissions", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ name, size: 1, agreement: true }),
    });
  expect((await start("notes.txt", { Origin: "null" })).status).toBe(403);
  // A right-to-left override makes "invoice\u202Etxt.exe" display as "invoiceexe.txt".
  for (const name of [
    "invoice\u202Etxt.exe",
    "line\u2028break.txt",
    "   ",
    "é".repeat(121),
  ]) {
    const response = await start(name);
    expect(response.status, name).toBe(400);
    expect(
      z.object({ error: z.string() }).parse(await response.json()).error,
    ).toContain("Rename");
  }
  expect((await start("é".repeat(120))).status).toBe(201);
  for (const path of ["/", "/api/submissions"]) {
    const headers = (await app.request(path)).headers;
    expect(headers.get("strict-transport-security"), path).toContain(
      "max-age=",
    );
    expect(headers.get("cross-origin-opener-policy"), path).toBe("same-origin");
    expect(headers.get("cross-origin-resource-policy"), path).toBe(
      "same-origin",
    );
    expect(headers.get("permissions-policy"), path).toContain("camera=()");
  }
});

it("limits each network address without affecting other visitors", async () => {
  const app = await launch({
    uploadsPerHour: 2,
    activeUploads: 1,
    downloadBytesPerHour: 10,
  });
  const start = (client: string) =>
    app.request("/api/submissions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Real-IP": client },
      body: JSON.stringify({ name: "held.bin", size: 4, agreement: true }),
    });
  const discard = async (admission: { id: string; token: string }) =>
    (
      await app.request(`/api/submissions/${admission.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${admission.token}` },
      })
    ).status;
  const first = await start("203.0.113.1");
  expect(first.status).toBe(201);
  const held = admissionSchema.parse(await first.json());
  // The next upload from that address waits until the held one finishes.
  const busy = await start("203.0.113.1");
  expect(busy.status).toBe(429);
  expect(Number(busy.headers.get("retry-after"))).toBeGreaterThan(0);
  expect((await start("203.0.113.2")).status).toBe(201);
  expect(await discard(held)).toBe(200);
  const second = await start("203.0.113.1");
  expect(second.status).toBe(201);
  expect(await discard(admissionSchema.parse(await second.json()))).toBe(200);
  // The hourly allowance still holds after uploads are discarded.
  expect((await start("203.0.113.1")).status).toBe(429);

  // Downloads are charged in bytes per address.
  const file = await app.upload("six.txt", Buffer.from("sixsix"));
  const original = (client: string) =>
    app.request(`${file.path}/files/${file.id}`, {
      headers: { "X-Real-IP": client },
    });
  expect((await original("198.51.100.1")).status).toBe(200);
  expect((await original("198.51.100.1")).status).toBe(429);
  expect((await original("198.51.100.2")).status).toBe(200);

  const quiet = await launch({ requestsPerMinute: 3 });
  const statuses: number[] = [];
  for (let index = 0; index < 4; index++)
    statuses.push(
      (
        await quiet.request("/api/submissions", {
          headers: { "X-Real-IP": "192.0.2.1" },
        })
      ).status,
    );
  expect(statuses).toEqual([200, 200, 200, 429]);
  expect(
    (
      await quiet.request("/api/submissions", {
        headers: { "X-Real-IP": "192.0.2.2" },
      })
    ).status,
  ).toBe(200);
  // Pages stay reachable while the API budget refills.
  expect(
    (await quiet.request("/", { headers: { "X-Real-IP": "192.0.2.1" } }))
      .status,
  ).toBe(200);
}, 60_000);

it("discards an abandoned incomplete upload even when it was meant to be kept", async () => {
  const app = await launch();
  const admitted = admissionSchema.parse(
    await (
      await app.post("/api/submissions", {
        name: "stalled.bin",
        size: 8,
        agreement: true,
        autoDelete: false,
      })
    ).json(),
  );
  const headers = { Authorization: `Bearer ${admitted.token}` };
  const path = `/api/submissions/${admitted.id}`;
  expect(
    (
      await app.request(`${path}/chunk?offset=0`, {
        method: "PUT",
        headers,
        body: "half",
      })
    ).status,
  ).toBe(200);
  expect(await app.store().sweepExpired(Date.now() + 30 * 60_000)).toBe(0);
  expect(await app.store().sweepExpired(Date.now() + 2 * 60 * 60_000)).toBe(1);
  expect((await app.request(path, { headers })).status).toBe(404);
  expect(await readdir(app.directory)).toEqual([]);
});

it("stops retrying an inspection that keeps being interrupted", async () => {
  const app = await launch();
  const once = await app.upload("once.txt", Buffer.from("retry me"));
  const twice = await app.upload("twice.txt", Buffer.from("leave me"));
  // Simulate restarts that interrupted each inspection once and twice.
  for (const [item, attempts] of [
    [once, 1],
    [twice, 2],
  ] as const) {
    const value = await app.store().get(item.id);
    await app
      .store()
      .save({ ...value, status: "analyzing", analysisAttempts: attempts });
  }
  await app.restart();
  const statusOf = async (path: string) =>
    publicSchema.parse(await (await app.request(path)).json()).status;
  await expect
    .poll(() => statusOf(once.path), { timeout: 20_000, interval: 100 })
    .toBe("ready");
  expect(await statusOf(twice.path)).toBe("failed");
}, 60_000);

it("lets an operator remove any submission, and no one else", async () => {
  const app = await launch(undefined, "secret-operator-token");
  const published = await app.upload(
    "takedown.txt",
    Buffer.from("published, then taken down"),
  );
  const operator = (headers: Record<string, string>) =>
    app.request(published.path, { method: "DELETE", headers });
  // The upload's own token cannot delete a published submission.
  expect(
    (await operator({ Authorization: `Bearer ${published.token}` })).status,
  ).toBe(409);
  // A wrong operator token is refused.
  expect(
    (await operator({ Authorization: "Bearer not-the-operator-token" })).status,
  ).toBe(403);
  // The real operator token removes it, files and findings included.
  expect(
    (await operator({ Authorization: "Bearer secret-operator-token" })).status,
  ).toBe(200);
  expect((await app.request(published.path)).status).toBe(404);
  expect(await readdir(app.directory)).toEqual([]);

  // With no operator token configured, the operator path is off: nobody can remove a published item.
  const closed = await launch();
  const kept = await closed.upload("kept.txt", Buffer.from("stays"));
  expect(
    (
      await closed.request(kept.path, {
        method: "DELETE",
        headers: { Authorization: "Bearer secret-operator-token" },
      })
    ).status,
  ).toBe(403);
  expect((await closed.request(kept.path)).status).toBe(200);
});

/** An inspection that takes 2 s and then writes into the submission's folder, as the real worker does. */
const slowWorker = async () => {
  const directory = await mkdtemp(join(tmpdir(), "rea-slow-worker-"));
  closers.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "worker.mjs");
  await writeFile(
    path,
    `import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const [root, id] = process.argv.slice(2);
setTimeout(async () => {
  const folder = join(root, id);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "report.json"), "{}");
  process.exit(0);
}, 2000);
`,
  );
  return path;
};

/** Upload a small file and wait until the stand-in worker is running on it. */
const uploadUntilAnalyzing = async (
  app: Awaited<ReturnType<typeof launch>>,
) => {
  const bytes = Buffer.from("still being inspected");
  const admitted = admissionSchema.parse(
    await (
      await app.post("/api/submissions", {
        name: "slow.txt",
        size: bytes.length,
        agreement: true,
        autoDelete: true,
      })
    ).json(),
  );
  const headers = { Authorization: `Bearer ${admitted.token}` };
  const path = `/api/submissions/${admitted.id}`;
  await app.request(`${path}/chunk?offset=0`, {
    method: "PUT",
    headers,
    body: bytes,
  });
  await app.request(`${path}/complete`, { method: "POST", headers });
  await expect
    .poll(async () => (await app.store().get(admitted.id)).status, {
      timeout: 10_000,
      interval: 25,
    })
    .toBe("analyzing");
  return { ...admitted, path };
};

it("stops an inspection and leaves nothing behind when an operator takes the submission down", async () => {
  const app = await launch(
    undefined,
    "secret-operator-token",
    await slowWorker(),
  );
  const running = await uploadUntilAnalyzing(app);
  const removed = await app.request(running.path, {
    method: "DELETE",
    headers: { Authorization: "Bearer secret-operator-token" },
  });
  expect(removed.status).toBe(200);
  // The stand-in worker would write its report 2 s after it started.
  await new Promise((done) => setTimeout(done, 3000));
  expect(await readdir(app.directory)).toEqual([]);
}, 30_000);

it("keeps an expired submission until its inspection ends", async () => {
  const app = await launch(undefined, undefined, await slowWorker());
  const running = await uploadUntilAnalyzing(app);
  const later = Date.now() + 25 * 60 * 60 * 1000;
  expect(await app.store().sweepExpired(later)).toBe(0);
  // The stand-in worker exits without publishing, so wait for the queue to let go.
  await expect
    .poll(() => app.store().inspecting.has(running.id), {
      timeout: 10_000,
      interval: 50,
    })
    .toBe(false);
  expect(await app.store().sweepExpired(later)).toBe(1);
  expect(await readdir(app.directory)).toEqual([]);
}, 30_000);

it("names byte candidates and advertises only admitted facets", async () => {
  const app = await launch();
  // The smallest valid WebAssembly core module.
  const wasm = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
  expect(validateWasm(wasm)).toBe(true);
  const uploaded = await app.upload("module.wasm", wasm);
  const report = detectionReportSchema.parse(
    await (await app.request(`${uploaded.path}/report`)).json(),
  );
  // The artifact graph still records an unrecognized file, as before.
  expect(report.format).toBe("file");
  const detection = report.format_detection;
  expect(detection.candidates.map((candidate) => candidate.format)).toEqual([
    "wasm-binary",
    "wasm-module",
  ]);
  expect(detection.candidates[1]?.evidence).toEqual({
    offset: 0,
    length: 8,
    observed_hex: "0061736d01000000",
  });
  // F01 is admitted: identity and inspection are advertised, members and source are not.
  for (const capability of detection.capabilities) {
    expect(capability.facets.identify?.state).toBe("complete");
    expect(capability.facets.reconstruct?.state).toBe("unsupported");
  }
  const sqlite = await app.upload(
    "planned.sqlite",
    new TextEncoder().encode("SQLite format 3\0"),
  );
  const planned = detectionReportSchema.parse(
    await (await app.request(`${sqlite.path}/report`)).json(),
  ).format_detection;
  expect(planned.candidates.map((candidate) => candidate.format)).toContain(
    "sqlite",
  );
  for (const capability of planned.capabilities)
    for (const facet of Object.values(capability.facets)) {
      expect(facet.state).toBe("unsupported");
      expect(facet.reason).toMatch(/F07 is planned for milestone P4/u);
    }
  const item = publicSchema.parse(
    await (await app.request(uploaded.path)).json(),
  );
  expect(item.files).toHaveLength(1);
  const original = await app.request(`${uploaded.path}/files/${uploaded.id}`);
  expect(original.status).toBe(200);
  expect(new Uint8Array(await original.arrayBuffer())).toEqual(wasm);

  const mislabeled = await app.upload(
    "records.db",
    new TextEncoder().encode("not a database"),
  );
  const refuted = detectionReportSchema.parse(
    await (await app.request(`${mislabeled.path}/report`)).json(),
  ).format_detection;
  expect(refuted.state).toBe("unrecognized");
  expect(refuted.name_hint).toEqual({ extension: ".db", formats: ["sqlite"] });
  expect(refuted.contradictions.map((entry) => entry.hinted)).toEqual([
    ["sqlite"],
  ]);
});

const observedSchema = z.object({
  format: z.string(),
  limitations: z.array(z.string()),
  files: z.array(z.object({ name: z.string(), sha256: z.string() })),
});
const itemFormatSchema = z.object({
  observedFormat: z.object({ id: z.string(), label: z.string() }).nullable(),
});

it("extracts a real tar.gz in process and shows the observed format", async () => {
  const app = await launch();
  const root = await mkdtemp(join(tmpdir(), "rea-hosted-tgz-"));
  closers.push(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  await mkdir(source);
  const { files } = await createArchiveSourceTree(source);
  const tar = join(root, "bundle.tar");
  await produceTar(source, tar, ["a.txt", "dir", "tool.sh"], "pax");
  const archive = await readFile(await produceGzip(tar));

  const uploaded = await app.upload("bundle.tar.gz", archive);
  const report = observedSchema.parse(
    await (await app.request(`${uploaded.path}/report`)).json(),
  );
  expect(report.format).toBe("gzip");
  expect(report.limitations.join(" ")).toMatch(/Gzip input was decoded to/u);
  const detection = detectionReportSchema.parse(
    await (await app.request(`${uploaded.path}/report`)).json(),
  ).format_detection;
  expect(detection.capabilities[0]?.format).toBe("gzip");
  expect(detection.capabilities[0]?.facets.extract?.state).toBe("partial");

  const item = publicSchema
    .merge(itemFormatSchema)
    .parse(await (await app.request(uploaded.path)).json());
  expect(item.observedFormat).toEqual({ id: "gzip", label: "Gzip stream" });
  for (const name of ["a.txt", "dir/b.txt", "tool.sh"]) {
    const published = item.files.find((file) => file.name === name);
    expect(published, name).toBeDefined();
    if (published === undefined) continue;
    const download = await app.request(
      `${uploaded.path}/files/${published.id}`,
    );
    expect(download.headers.get("content-disposition")).toContain("attachment");
    const bytes = Buffer.from(await download.arrayBuffer());
    expect(bytes.toString("utf8")).toBe(files[name]);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      published.sha256,
    );
  }
  const original = await app.request(`${uploaded.path}/files/${uploaded.id}`);
  expect(Buffer.from(await original.arrayBuffer()).equals(archive)).toBe(true);
  const listed = z
    .object({ items: z.array(itemFormatSchema) })
    .parse(await (await app.request("/api/submissions")).json());
  expect(listed.items[0]?.observedFormat?.id).toBe("gzip");
});

it.skipIf(LINUX_TOOLS === null)(
  "lists Debian and RPM package contents in process and keeps xz members off the hosted surface",
  async () => {
    const app = await launch();
    const root = await mkdtemp(join(tmpdir(), "rea-hosted-deb-"));
    closers.push(() => rm(root, { recursive: true, force: true }));
    const fixtures = await buildLinuxFixtures(root);
    const elf = await readFile(fixtures.elf);
    const uploaded = await app.upload(
      "oops.deb",
      await readFile(fixtures.deb.zstd),
    );
    const report = observedSchema.parse(
      await (await app.request(`${uploaded.path}/report`)).json(),
    );
    expect(report.format).toBe("deb");
    expect(report.limitations.join(" ")).toMatch(
      /payload \(zstd\) was decoded/u,
    );
    const item = publicSchema
      .merge(itemFormatSchema)
      .parse(await (await app.request(uploaded.path)).json());
    expect(item.observedFormat?.id).toBe("deb");
    const helper = item.files.find(
      (file) => file.name === "usr/lib/oops/helper",
    );
    expect(helper?.sha256).toBe(createHash("sha256").update(elf).digest("hex"));

    const denied = await app.upload(
      "oops-xz.deb",
      await readFile(fixtures.deb.xz),
    );
    const deniedReport = observedSchema.parse(
      await (await app.request(`${denied.path}/report`)).json(),
    );
    expect(deniedReport.format).toBe("deb");
    expect(deniedReport.limitations.join(" ")).toMatch(/external xz program/u);

    const rpm = await app.upload("oops.rpm", await readFile(fixtures.rpm.zstd));
    const rpmItem = publicSchema
      .merge(itemFormatSchema)
      .parse(await (await app.request(rpm.path)).json());
    expect(rpmItem.observedFormat?.id).toBe("rpm");
    expect(
      rpmItem.files.find((file) => file.name === "usr/lib/oops/helper")?.sha256,
    ).toBe(createHash("sha256").update(elf).digest("hex"));
  },
);

it.skipIf(WINDOWS_TOOLS === null || LINUX_TOOLS === null)(
  "extracts an MSI's files at their target paths and lists, but does not extract, an AppImage",
  async () => {
    const app = await launch();
    const root = await mkdtemp(join(tmpdir(), "rea-hosted-msi-"));
    closers.push(() => rm(root, { recursive: true, force: true }));
    const windows = await buildWindowsFixtures(root);
    const payload = createHash("sha256")
      .update(await readFile(windows.payload))
      .digest("hex");
    const msi = await app.upload("oops.msi", await readFile(windows.msi));
    const msiItem = publicSchema
      .merge(itemFormatSchema)
      .parse(await (await app.request(msi.path)).json());
    expect(msiItem.observedFormat?.id).toBe("msi");
    expect(
      msiItem.files.find(
        (file) => file.name === "ProgramFiles64Folder/Oops/tool.exe",
      )?.sha256,
    ).toBe(payload);
    expect(msiItem.files.map((file) => file.name)).toContain("Binary/SetupDll");

    const linux = await buildLinuxFixtures(join(root, "linux"));
    const appimage = await app.upload(
      "Oops-x86_64.AppImage",
      await readFile(linux.appimage.x86_64),
    );
    const appItem = publicSchema
      .merge(itemFormatSchema)
      .parse(await (await app.request(appimage.path)).json());
    expect(appItem.observedFormat?.id).toBe("appimage");
    expect(appItem.files).toHaveLength(1);
    const appReport = observedSchema.parse(
      await (await app.request(`${appimage.path}/report`)).json(),
    );
    expect(appReport.limitations.join(" ")).toMatch(
      /members are listed in the report; the hosted service does not extract them/u,
    );
  },
);

it("keeps external decoders off the hosted surface and publishes reasons, not paths", async () => {
  const app = await launch();
  const root = await mkdtemp(join(tmpdir(), "rea-hosted-xz-"));
  closers.push(() => rm(root, { recursive: true, force: true }));
  if (XZ !== null) {
    const payload = join(root, "notes.txt");
    await writeFile(payload, "xz payload\n");
    const compressed = await readFile(await produceXz(payload));
    const uploaded = await app.upload("notes.txt.xz", compressed);
    const report = observedSchema.parse(
      await (await app.request(`${uploaded.path}/report`)).json(),
    );
    expect(report.format).toBe("xz");
    expect(report.files).toHaveLength(1);
    expect(report.limitations.join(" ")).toMatch(/external xz program/u);
  }

  const header = Buffer.alloc(512);
  header.write("../escape.txt", 0, "utf8");
  header.write("0000644\0", 100, "latin1");
  header.write("00000000004\0", 124, "latin1");
  header.write("0", 156, "latin1");
  header.write("ustar\0", 257, "latin1");
  header.write("00", 263, "latin1");
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
  const hostile = Buffer.concat([
    header,
    Buffer.from("bad\n"),
    Buffer.alloc(508 + 1024),
  ]);
  const uploaded = await app.upload("hostile.tar", hostile);
  const report = observedSchema.parse(
    await (await app.request(`${uploaded.path}/report`)).json(),
  );
  expect(report.files).toHaveLength(1);
  const reasons = report.limitations.join(" ");
  expect(reasons).toMatch(
    /Reason: Artifact path is not normalized: "\.\.\/escape\.txt"/u,
  );
  expect(reasons).not.toContain(app.directory);
});
const structureSchema = z.object({
  schema: z.literal("oopsware.structured-text.v1"),
  sha256: z.string(),
  format: z.object({ profile: z.string() }),
  encoding: z.object({
    name: z.string(),
    undecodable: z.array(z.object({ offset: z.number(), bytes: z.number() })),
  }),
  parse: z.object({ status: z.string(), records: z.number().nullable() }),
  diagnostics: z.array(
    z.object({
      code: z.string(),
      severity: z.string(),
      record: z.number().nullable(),
      location: z
        .object({ line: z.number(), column: z.number(), offset: z.number() })
        .nullable(),
    }),
  ),
  node_count: z.number(),
  stored_nodes: z.number(),
  node_pages: z.number(),
  segments: z.array(
    z.object({
      start: z.number(),
      end: z.number(),
      unit: z.string(),
      complete_units: z.boolean(),
    }),
  ),
});
const nodePageSchema = z.object({
  page: z.number(),
  pages: z.number(),
  nodes: z.array(
    z.object({
      index: z.number(),
      kind: z.string(),
      path: z.string(),
      name: z.string().nullable(),
      value: z.string().nullable(),
      fields: z.array(z.string()).nullable(),
      details: z.record(z.string(), z.unknown()),
    }),
  ),
});
const segmentSchema = z.object({
  segment: z.object({ start: z.number(), end: z.number() }),
  segments: z.number(),
  profile: z.string(),
  text: z.string(),
});

it("serves source-bound structure pages and record-aligned reading pages for structured text", async () => {
  const app = await launch({
    uploadsPerHour: Infinity,
    requestsPerMinute: Infinity,
  });
  const structure = async (path: string) => {
    const response = await app.request(`${path}/structure`);
    expect(response.status).toBe(200);
    return structureSchema.parse(await response.json());
  };
  const nodes = async (path: string, page = 0) =>
    nodePageSchema.parse(
      await (
        await app.request(`${path}/structure/nodes/${String(page)}`)
      ).json(),
    ).nodes;

  const json = Buffer.from(
    '{\n  "id": 12345678901234567890,\n  "id": 2,\n  "nested": {"list": [1.50, null]}\n}\n',
  );
  const uploaded = await app.upload("data.json", json);
  const view = await structure(uploaded.path);
  expect(view.format.profile).toBe("json");
  expect(view.parse.status).toBe("parsed");
  expect(view.diagnostics[0]).toMatchObject({
    code: "json_duplicate_key",
    location: { line: 3, column: 3, offset: 34 },
  });
  expect(
    (await nodes(uploaded.path))
      .filter(({ path }) => path === "/id")
      .map(({ value }) => value),
  ).toEqual(["12345678901234567890", "2"]);
  const segment = segmentSchema.parse(
    await (await app.request(`${uploaded.path}/previews/segment-0`)).json(),
  );
  expect(segment.text).toBe(json.toString("utf8"));
  const report = z
    .object({
      observations: z.array(z.string()),
      document: z.object({
        status: z.string(),
        profile: z.string(),
        capabilities: z.object({
          format: z.string(),
          facets: z.record(z.string(), z.object({ state: z.string() })),
        }),
      }),
      format_detection: detectionReportSchema.shape.format_detection,
    })
    .parse(await (await app.request(`${uploaded.path}/report`)).json());
  expect(report.document).toMatchObject({ status: "parsed", profile: "json" });
  expect(report.observations.join(" ")).toContain("Structured text: json");
  // No byte signature exists for JSON: the name hints it, the parse confirms it.
  expect(report.format_detection.name_hint.formats).toEqual(["json"]);
  expect(report.document.capabilities.facets.inspect?.state).toBe("partial");
  expect(report.document.capabilities.facets.extract?.state).toBe(
    "unsupported",
  );
  // Reading never rewrites the download.
  expect(
    Buffer.from(
      await (
        await app.request(`${uploaded.path}/files/${uploaded.id}`)
      ).arrayBuffer(),
    ),
  ).toEqual(json);

  const lines = await app.upload(
    "events.jsonl",
    Buffer.from('{"n":1}\n{"n":\n{"n":3}\n'),
  );
  const linesView = await structure(lines.path);
  expect(linesView.parse).toMatchObject({ status: "partial", records: 3 });
  expect(
    linesView.diagnostics.find(({ severity }) => severity === "error"),
  ).toMatchObject({ record: 2, location: { line: 2 } });

  const xxe = await app.upload(
    "xxe.xml",
    Buffer.from(
      '<!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd"><!ENTITY a "&a;">]>\n<r>&x;</r>',
    ),
  );
  expect(
    (await structure(xxe.path)).diagnostics.map(({ code }) => code),
  ).toContain("xml_dtd_internal_subset_refused");
  expect(JSON.stringify(await nodes(xxe.path))).not.toContain("root:");

  const yaml = await app.upload(
    "laughs.yaml",
    Buffer.from("a: &a [x, x]\nb: &b [*a, *a]\nc: [*b, *b]\n"),
  );
  expect(
    (await nodes(yaml.path)).filter(({ kind }) => kind === "alias"),
  ).toHaveLength(4);

  const csv = await app.upload(
    "table.csv",
    Buffer.from('name,note\n"a,b","two\nlines"\n"=1+1",x,extra\n'),
  );
  const rows = await nodes(csv.path);
  expect(rows[1]?.fields).toEqual(["a,b", "two\nlines"]);
  expect(rows[2]?.details.formula_like_cells).toBe(1);

  const markdown = Buffer.from(
    "# Title\n\n<script>alert(1)</script> [bad](javascript:alert(1))\n",
  );
  const readme = await app.upload("README.md", markdown);
  expect(
    (await nodes(readme.path)).find(({ kind }) => kind === "link")?.details
      .rendered_as_link,
  ).toBe(false);
  expect(
    segmentSchema.parse(
      await (await app.request(`${readme.path}/previews/segment-0`)).json(),
    ).text,
  ).toBe(markdown.toString("utf8"));

  // A large paged document: every reading page ends on a line, and together they are the file.
  const text = Array.from(
    { length: 4000 },
    (_, index) => `line ${String(index).padStart(5, "0")} ${"·".repeat(20)}`,
  ).join("\n");
  const large = await app.upload("large.txt", Buffer.from(text));
  const largeView = await structure(large.path);
  expect(largeView.segments.length).toBeGreaterThan(3);
  expect(largeView.node_pages).toBe(8);
  expect((await nodes(large.path, 7)).at(-1)?.value).toContain("line 03999");
  let joined = "";
  for (const [index, entry] of largeView.segments.entries()) {
    expect(entry).toMatchObject({ unit: "line", complete_units: true });
    joined += segmentSchema.parse(
      await (
        await app.request(`${large.path}/previews/segment-${String(index)}`)
      ).json(),
    ).text;
  }
  expect(joined).toBe(text);

  const latin = await app.upload(
    "latin.txt",
    Buffer.from([0x63, 0x61, 0x66, 0xe9]),
  );
  const latinView = await structure(latin.path);
  expect(latinView.encoding.undecodable).toEqual([{ offset: 3, bytes: 1 }]);
  expect(latinView.parse.status).toBe("partial");

  // Non-text uploads and out-of-range pages are explicit 404s.
  const binary = await app.upload("blob.bin", Buffer.from([0, 1, 2, 3]));
  expect((await app.request(`${binary.path}/structure`)).status).toBe(404);
  expect(
    (await app.request(`${uploaded.path}/structure/nodes/999`)).status,
  ).toBe(404);
  expect(
    (await app.request(`${uploaded.path}/previews/segment-999`)).status,
  ).toBe(404);
  expect(
    (await app.request(`${uploaded.path}/previews/segment-x`)).status,
  ).toBe(404);
}, 60_000);

it("keeps publishing a structured-text upload whose parse exceeds the service budget", async () => {
  const app = await launch({
    uploadsPerHour: Infinity,
    requestsPerMinute: Infinity,
  });
  const reportSchema = z.object({
    limitations: z.array(z.string()),
    document: z.object({ status: z.string(), reason: z.string() }),
  });
  // Exactly the 4 MiB Markdown cap: under the size limit, but a million list
  // items need more parser memory than the separate 384 MiB process has.
  const heavy = Buffer.from("- a\n".repeat(1024 ** 2));
  const uploaded = await app.upload("list.md", heavy);
  const report = reportSchema.parse(
    await (await app.request(`${uploaded.path}/report`)).json(),
  );
  expect(report.document.status).toBe("skipped");
  expect(report.document.reason).toContain("384 MiB");
  expect(report.limitations).toContain(report.document.reason);
  expect((await app.request(`${uploaded.path}/structure`)).status).toBe(404);
  expect(
    (await app.request(`${uploaded.path}/files/${uploaded.id}/preview`)).status,
  ).toBe(200);
  const leftovers = await readdir(join(app.directory, uploaded.id));
  expect(leftovers).not.toContain("document");
  expect(leftovers).not.toContain("document.staging");

  // Tree-building formats stop at 4 MiB before any parse starts.
  const large = await app.upload(
    "large.yaml",
    Buffer.alloc(4 * 1024 ** 2 + 1, "a"),
  );
  const largeReport = reportSchema.parse(
    await (await app.request(`${large.path}/report`)).json(),
  );
  expect(largeReport.document.status).toBe("skipped");
  expect(largeReport.document.reason).toContain("yaml is limited to 4 MiB");
}, 120_000);

const wasmIndexSchema = z.object({
  schema: z.literal("oopsware.webassembly.v1"),
  sha256: z.string(),
  report: z.object({
    artifact: z.object({ path: z.string() }),
    validation: z.object({ state: z.string() }),
    summary: z.object({
      functions: z.number(),
      imports: z.number(),
      exports: z.number(),
      indirect_call_sites: z.number(),
    }),
    exports: z.array(z.object({ name: z.string() })),
    data: z.array(z.object({ preview_text: z.string() })),
    coverage: z.array(z.object({ facet: z.string(), state: z.string() })),
  }),
  stored_functions: z.number(),
  function_pages: z.number(),
  wat: z
    .object({ id: z.string(), sha256: z.string(), derived_from: z.string() })
    .nullable(),
});
const wasmFunctionPageSchema = z.object({
  functions: z.array(
    z.object({
      index: z.number(),
      name: z.string().nullable(),
      direct_callees: z.array(z.number()),
      indirect_call_sites: z.number(),
    }),
  ),
});

it("decodes an uploaded WebAssembly module once and serves its structure and derived WAT", async () => {
  const app = await launch({
    uploadsPerHour: Infinity,
    requestsPerMinute: Infinity,
  });
  // Assembled at test time by wabt.js; the module is never instantiated.
  const module = await assembleWat(
    "upload.wat",
    new TextEncoder().encode(`(module
      (import "env" "tick" (func $tick))
      (type $op (func (param i32) (result i32)))
      (memory (export "memory") 1)
      (data (i32.const 8) "public-wasm")
      (table 1 funcref) (elem (i32.const 0) $neg)
      (func $neg (type $op) i32.const 0 local.get 0 i32.sub)
      (func $start call $tick)
      (start $start)
      (func (export "run") (param i32) (result i32)
        call $tick local.get 0 i32.const 0 call_indirect (type $op)))`),
  );
  const uploaded = await app.upload("sample.wasm", module);
  const response = await app.request(`${uploaded.path}/wasm`);
  expect(response.status).toBe(200);
  const raw = await response.text();
  // The stored view names the upload, never a storage path.
  expect(raw).not.toContain(app.directory);
  const view = wasmIndexSchema.parse(JSON.parse(raw));
  expect(view.report.artifact.path).toBe("sample.wasm");
  expect(view.report.validation.state).toBe("valid");
  expect(view.report.summary).toMatchObject({
    functions: 4,
    imports: 1,
    exports: 2,
    indirect_call_sites: 1,
  });
  expect(view.report.data[0]?.preview_text).toContain("public-wasm");
  expect(view.report.coverage[1]).toMatchObject({ state: "complete" });
  const page = wasmFunctionPageSchema.parse(
    await (await app.request(`${uploaded.path}/wasm/functions/0`)).json(),
  );
  expect(page.functions.map(({ name }) => name)).toEqual([
    "tick",
    "neg",
    "start",
    "run",
  ]);
  expect(page.functions[3]).toMatchObject({
    direct_callees: [0],
    indirect_call_sites: 1,
  });
  // The derived text is its own download, bound to the original's digest.
  const wat = await app.request(`${uploaded.path}/outputs/module.wat`);
  expect(wat.headers.get("content-disposition")).toContain(
    "sample.derived.wat",
  );
  const text = Buffer.from(await wat.arrayBuffer());
  expect(createHash("sha256").update(text).digest("hex")).toBe(
    view.wat?.sha256,
  );
  expect(view.wat?.derived_from).toBe(
    createHash("sha256").update(module).digest("hex"),
  );
  expect(text.toString("utf8")).toContain("call_indirect");
  const original = await app.request(`${uploaded.path}/files/${uploaded.id}`);
  expect(Buffer.from(await original.arrayBuffer())).toEqual(
    Buffer.from(module),
  );
  const report = z
    .object({
      observations: z.array(z.string()),
      wasm: z.object({ status: z.string(), function_count: z.number() }),
    })
    .parse(await (await app.request(`${uploaded.path}/report`)).json());
  expect(report.wasm).toMatchObject({ status: "decoded", function_count: 4 });
  expect(report.observations.join(" ")).toContain(
    "WebAssembly core module: 4 functions, validation valid",
  );

  // A truncated module is still published, with its decoded part and a partial facet.
  const truncated = await app.upload(
    "cut.wasm",
    module.subarray(0, module.length - 12),
  );
  const cut = wasmIndexSchema.parse(
    await (await app.request(`${truncated.path}/wasm`)).json(),
  );
  expect(cut.report.validation.state).toBe("invalid");
  expect(cut.report.coverage[1]).toMatchObject({ state: "partial" });
  expect(cut.report.summary.imports).toBe(1);

  // A component is identified only; non-WebAssembly uploads have no view.
  const component = await app.upload(
    "empty-component.wasm",
    Uint8Array.of(0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, 0x01, 0x00),
  );
  const identified = wasmIndexSchema.parse(
    await (await app.request(`${component.path}/wasm`)).json(),
  );
  expect(identified.wat).toBeNull();
  expect(identified.report.coverage[1]).toMatchObject({
    state: "unsupported",
  });
  expect(
    (await app.request(`${component.path}/outputs/module.wat`)).status,
  ).toBe(404);
  const text_ = await app.upload("notes.txt", Buffer.from("plain"));
  expect((await app.request(`${text_.path}/wasm`)).status).toBe(404);
  expect((await app.request(`${uploaded.path}/wasm/functions/9`)).status).toBe(
    404,
  );
  expect((await app.request(`${uploaded.path}/outputs/other.wat`)).status).toBe(
    404,
  );
}, 60_000);
