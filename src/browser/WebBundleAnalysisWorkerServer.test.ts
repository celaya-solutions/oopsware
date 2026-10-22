import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { expect, it } from "vitest";

import { createWebTextArtifact } from "../domain/webContentArtifact.js";
import type { IncludedScript } from "../domain/webBundleAnalyzerInspection.js";
import {
  webBundleWorkerMessageSchema,
  type WebBundleWorkerMessage,
} from "./WebBundleAnalysisWorkerProtocol.js";
import { WEB_BUNDLE_WORKER_LIMITS } from "./WebBundleAnalysisWorkerProtocol.js";

const makeScript = (text: string): IncludedScript => ({
  script_key: `scr_${createHash("sha256").update(text).digest("hex")}`,
  frame_id: "frame-1",
  url: "https://app.example.test/app.js",
  origin: "https://app.example.test",
  cdp_hash: null,
  length: Buffer.byteLength(text),
  is_module: false,
  language: "JavaScript",
  source_map_url: null,
  resource_reconciliation: {
    status: "unmatched",
    reason: "no_exact_sanitized_url",
  },
  source: {
    included: true,
    artifact: createWebTextArtifact(text, "application/javascript"),
  },
});

const sourceDescriptor = (script: IncludedScript) => {
  const bytes = Buffer.from(JSON.stringify(script));
  return {
    bytes,
    descriptor: {
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
};

const writeSource = async (
  root: string,
  id: string,
  bytes: Buffer,
): Promise<void> => {
  await writeFile(join(root, `${id}.source`), bytes, {
    flag: "wx",
    mode: 0o600,
  });
};

const startServer = async (
  root: string,
): Promise<{
  readonly process: ChildProcessWithoutNullStreams;
  readonly next: () => Promise<WebBundleWorkerMessage>;
}> => {
  const loader = import.meta.resolve("tsx");
  const serverUrl = new URL(
    "./WebBundleAnalysisWorkerServer.ts",
    import.meta.url,
  ).href;
  const analyzerUrl = new URL("../domain/webBundleAnalyzer.ts", import.meta.url)
    .href;
  const program = `
    const { serveWebBundleAnalysisWorker } = await import(${JSON.stringify(serverUrl)});
    const { analyzeCapturedWebScript } = await import(${JSON.stringify(analyzerUrl)});
    await serveWebBundleAnalysisWorker(analyzeCapturedWebScript);
  `;
  const child = spawn(
    process.execPath,
    [
      "--max-old-space-size=128",
      "--import",
      loader,
      "--input-type=module",
      "-e",
      program,
    ],
    { cwd: root, stdio: ["pipe", "pipe", "pipe"] },
  );
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  return {
    process: child,
    next: async () => {
      const line = await iterator.next();
      if (line.done) {
        const stderr = await readStream(child.stderr);
        throw new Error(`Worker exited before a control frame: ${stderr}`);
      }
      const raw: unknown = JSON.parse(line.value);
      return webBundleWorkerMessageSchema.parse(raw);
    },
  };
};

const readStream = async (stream: NodeJS.ReadableStream): Promise<string> => {
  let output = "";
  for await (const chunk of stream) output += String(chunk);
  return output;
};

const send = async (
  worker: ChildProcessWithoutNullStreams,
  request: unknown,
): Promise<void> => {
  const frame = `${JSON.stringify(request)}\n`;
  await new Promise<void>((resolve, reject) => {
    worker.stdin.write(frame, (error) =>
      error === null || error === undefined ? resolve() : reject(error),
    );
  });
};

it("bounds and binds per-script worker jobs, then reuses one worker for the next script", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-web-worker-server-test-"));
  let worker: ChildProcessWithoutNullStreams | undefined;
  try {
    const server = await startServer(root);
    worker = server.process;
    const ready = await server.next();
    expect(ready).toMatchObject({ kind: "ready" });
    if (ready.kind !== "ready") throw new Error("Expected worker ready frame");
    expect(ready.heap_limit_bytes).not.toBeNull();
    expect(ready.heap_limit_bytes).toBeLessThan(512 * 1024 * 1024);
    expect(WEB_BUNDLE_WORKER_LIMITS).toMatchObject({
      protocolBytes: 64 * 1024,
      sourceBytes: 8 * 32 * 1024 * 1024,
      resultBytes: 8 * 1024 * 1024,
    });

    const script = makeScript("fetch('/users');");
    const input = sourceDescriptor(script);
    const missingId = randomUUID();
    await writeSource(root, randomUUID(), input.bytes);
    await send(worker, {
      kind: "analyze",
      id: missingId,
      source: input.descriptor,
      result_budget_bytes: WEB_BUNDLE_WORKER_LIMITS.resultBytes,
    });
    const missing = await server.next();
    expect(missing).toMatchObject({
      kind: "failure",
      id: missingId,
      reason: "io",
    });

    const digestId = randomUUID();
    await writeSource(root, digestId, input.bytes);
    await send(worker, {
      kind: "analyze",
      id: digestId,
      source: { ...input.descriptor, sha256: "0".repeat(64) },
      result_budget_bytes: WEB_BUNDLE_WORKER_LIMITS.resultBytes,
    });
    expect(await server.next()).toMatchObject({
      kind: "failure",
      id: digestId,
      reason: "input",
    });

    const budgetId = randomUUID();
    await writeSource(root, budgetId, input.bytes);
    await send(worker, {
      kind: "analyze",
      id: budgetId,
      source: input.descriptor,
      result_budget_bytes: 1,
    });
    expect(await server.next()).toMatchObject({
      kind: "phase",
      id: budgetId,
      phase: "analyze",
    });
    expect(await server.next()).toMatchObject({
      kind: "failure",
      id: budgetId,
      reason: "resource",
    });

    const nextScript = makeScript("fetch('/orders');");
    const nextInput = sourceDescriptor(nextScript);
    const nextId = randomUUID();
    await writeSource(root, nextId, nextInput.bytes);
    await send(worker, {
      kind: "analyze",
      id: nextId,
      source: nextInput.descriptor,
      result_budget_bytes: WEB_BUNDLE_WORKER_LIMITS.resultBytes,
    });
    expect(await server.next()).toMatchObject({
      kind: "phase",
      id: nextId,
      phase: "analyze",
    });
    const complete = await server.next();
    expect(complete).toMatchObject({ kind: "complete", id: nextId });
    if (complete.kind !== "complete")
      throw new Error("Expected result descriptor");
    const result = await readFile(join(root, `${nextId}.result`));
    expect(result.length).toBe(complete.result.bytes);
    expect(createHash("sha256").update(result).digest("hex")).toBe(
      complete.result.sha256,
    );
    expect(JSON.parse(result.toString("utf8"))).toMatchObject({
      status: "analyzed",
      script_key: nextScript.script_key,
    });
  } finally {
    if (worker !== undefined) {
      worker.stdin.end();
      if (worker.exitCode === null && worker.signalCode === null) {
        const exited = once(worker, "exit");
        const timeout = setTimeout(() => worker?.kill("SIGKILL"), 2_000);
        await exited;
        clearTimeout(timeout);
      }
    }
    await rm(root, { recursive: true, force: true });
  }
});
