import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { getHeapStatistics } from "node:v8";
import { withArtifactFileHandle } from "../artifacts/ArtifactFileOperation.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { jsonParts } from "../domain/jsonSerialization.js";
import type { IncludedScript } from "../domain/webBundleAnalyzerInspection.js";
import {
  webBundleScriptAnalysisSchema,
  type WebBundleScriptAnalysis,
} from "../domain/webBundleScriptAnalysis.js";
import { javaScriptRuntime } from "../domain/runtimeVersion.js";
import { readStableArtifact } from "../artifacts/readStableArtifact.js";
import {
  WEB_BUNDLE_WORKER_LIMITS as LIMITS,
  includedWebScriptSchema,
  webBundleWorkerRequestSchema,
  webBundleWorkerMessageSchema,
  type WebBundleWorkerMessage,
} from "./WebBundleAnalysisWorkerProtocol.js";

export interface WebBundleScriptAnalyzer {
  (script: IncludedScript): WebBundleScriptAnalysis;
}

class WebBundleWorkerInputError extends Error {}
class WebBundleWorkerOutputError extends Error {}

const send = async (input: WebBundleWorkerMessage): Promise<void> => {
  const value = webBundleWorkerMessageSchema.parse(input);
  const frame = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(frame) > LIMITS.protocolBytes)
    throw new RangeError(
      "Web bundle worker control frame exceeds its byte budget",
    );
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(frame, (error) =>
      error === null || error === undefined ? resolve() : reject(error),
    );
  });
};

async function* boundedControlLines(): AsyncGenerator<string> {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  for await (const chunk of process.stdin) {
    const decoded = decoder.write(chunk);
    let start = 0;
    for (;;) {
      const newline = decoded.indexOf("\n", start);
      if (newline < 0) {
        pending += decoded.slice(start);
        if (Buffer.byteLength(pending) > LIMITS.protocolBytes)
          throw new RangeError(
            "Web bundle worker request exceeds its byte budget",
          );
        break;
      }
      const line = `${pending}${decoded.slice(start, newline)}`.replace(
        /\r$/u,
        "",
      );
      pending = "";
      if (Buffer.byteLength(line) > LIMITS.protocolBytes)
        throw new RangeError(
          "Web bundle worker request exceeds its byte budget",
        );
      yield line;
      start = newline + 1;
    }
  }
  pending += decoder.end();
  if (pending !== "") {
    if (Buffer.byteLength(pending) > LIMITS.protocolBytes)
      throw new RangeError("Web bundle worker request exceeds its byte budget");
    yield pending;
  }
}

/** Serve sequential script jobs from the private root owned by the worker runtime. */
export const serveWebBundleAnalysisWorker = async (
  analyze: WebBundleScriptAnalyzer,
): Promise<void> => {
  const root = process.cwd();
  const resources = new ArtifactResourceScope();
  const requests = boundedControlLines();
  await send({
    kind: "ready",
    heap_limit_bytes:
      javaScriptRuntime(process.versions).id === "node"
        ? getHeapStatistics().heap_size_limit
        : null,
  });
  try {
    for (;;) {
      const next = await requests.next();
      if (next.done) break;
      if (Buffer.byteLength(next.value) > LIMITS.protocolBytes)
        throw new RangeError(
          "Web bundle worker request exceeds its byte budget",
        );
      const raw: unknown = JSON.parse(next.value);
      const request = webBundleWorkerRequestSchema.parse(raw);
      const continueServing = await analyzeJob(
        root,
        request,
        analyze,
        resources,
      );
      if (!continueServing) break;
      if (
        process.memoryUsage().heapUsed >
        getHeapStatistics().heap_size_limit / 2
      )
        global.gc?.();
    }
  } finally {
    await requests.return(undefined);
  }
};

const analyzeJob = async (
  root: string,
  request: ReturnType<typeof webBundleWorkerRequestSchema.parse>,
  analyze: WebBundleScriptAnalyzer,
  resources: ArtifactResourceScope,
): Promise<boolean> => {
  try {
    const sourcePath = join(root, `${request.id}.source`);
    const source = await readStableArtifact(
      sourcePath,
      LIMITS.sourceBytes,
      undefined,
      undefined,
      resources,
    );
    if (
      source.bytes.length !== request.source.bytes ||
      source.sha256 !== request.source.sha256
    )
      throw new WebBundleWorkerInputError(
        "Web bundle worker source descriptor does not match its file",
      );
    let script: IncludedScript;
    try {
      const decoded: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(source.bytes),
      );
      script = includedWebScriptSchema.parse(decoded);
    } catch (cause) {
      throw new WebBundleWorkerInputError(
        `Web bundle worker source is not a valid included script: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    await send({ kind: "phase", id: request.id, phase: "analyze" });
    let result: WebBundleScriptAnalysis;
    try {
      result = webBundleScriptAnalysisSchema.parse(analyze(script));
    } catch (cause) {
      throw new WebBundleWorkerOutputError(
        `Web bundle analyzer returned an invalid result: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    if (result.status !== "analyzed")
      throw new WebBundleWorkerOutputError(
        "Web bundle analyzer did not produce a completed per-script result",
      );
    const resultPath = join(root, `${request.id}.result`);
    const file = await open(resultPath, "wx", 0o600);
    const hash = createHash("sha256");
    let bytes = 0;
    await withArtifactFileHandle(
      resultPath,
      file,
      resources,
      undefined,
      async (handle) => {
        for (const part of jsonParts(result)) {
          const chunk = Buffer.from(part);
          bytes += chunk.length;
          if (bytes > request.result_budget_bytes)
            throw new RangeError(
              "Web bundle worker result exceeds its admitted byte budget",
            );
          hash.update(chunk);
          let offset = 0;
          while (offset < chunk.length) {
            const written = await handle.write(
              chunk,
              offset,
              chunk.length - offset,
            );
            if (written.bytesWritten === 0)
              throw new Error(
                "Web bundle worker result write made no progress",
              );
            offset += written.bytesWritten;
          }
        }
      },
    );
    await send({
      kind: "complete",
      id: request.id,
      result: { bytes, sha256: hash.digest("hex") },
    });
    return true;
  } catch (cause: unknown) {
    const resource = cause instanceof RangeError;
    const input = cause instanceof WebBundleWorkerInputError;
    const fatalCleanupFailure =
      cause instanceof ArtifactReaderFailure &&
      cause.cleanupLeases !== undefined &&
      cause.cleanupLeases.length > 0;
    const rawMessage = cause instanceof Error ? cause.message : String(cause);
    await send({
      kind: "failure",
      id: request.id,
      reason: resource
        ? "resource"
        : input
          ? "input"
          : cause instanceof WebBundleWorkerOutputError ||
              cause instanceof TypeError
            ? "output"
            : "io",
      message:
        rawMessage.length > 2048 ? `${rawMessage.slice(0, 2048)}…` : rawMessage,
    });
    return !fatalCleanupFailure;
  }
};
