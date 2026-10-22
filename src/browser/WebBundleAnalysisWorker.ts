import { createHash, randomUUID } from "node:crypto";
import { open, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { getHeapStatistics } from "node:v8";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import {
  AnalysisCleanupLease,
  AnalysisCleanupLeaseGroup,
} from "../artifacts/AnalysisCleanupLease.js";
import {
  ArtifactFileCancelled,
  ArtifactFileCleanupFailure,
  artifactFileCancellationCause,
  withArtifactFileHandle,
} from "../artifacts/ArtifactFileOperation.js";
import { readStableArtifact } from "../artifacts/readStableArtifact.js";
import type { StableArtifactSnapshot } from "../artifacts/readStableArtifact.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisCancelledError,
  AnalysisTimeoutError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { jsonParts, bufferedJsonParts } from "../domain/jsonSerialization.js";
import { javaScriptRuntime } from "../domain/runtimeVersion.js";
import { err, ok, type Result } from "../domain/result.js";
import type { IncludedScript } from "../domain/webBundleAnalyzerInspection.js";
import {
  webBundleScriptAnalysisSchema,
  type WebBundleScriptAnalysis,
} from "../domain/webBundleScriptAnalysis.js";
import { OwnedWorkerRuntime } from "../process/OwnedWorkerRuntime.js";
import { PrivateRuntimeRootUnavailableError } from "../process/PrivateRuntimeRootUnavailableError.js";
import { spawnOwnedProviderProcess } from "../process/ProviderProcess.js";
import { ProviderStartupDeadline } from "../process/ProviderDeadline.js";
import { prepareProcessOwnershipInspection } from "../process/ProcessOwnershipObservation.js";
import { javaScriptWorkerMemoryLimitBytes } from "../process/JavaScriptWorkerMemoryLimit.js";
import {
  WEB_BUNDLE_WORKER_LIMITS,
  webBundleWorkerMessageSchema,
  webBundleWorkerRequestSchema,
  type WebBundleWorkerMessage,
} from "./WebBundleAnalysisWorkerProtocol.js";

const OPERATION = "analyze_web_bundle";
const PROVIDER = "web-bundle-static-analysis";
const MIB = 1024 * 1024;
/** Source/result buffers, decoded strings, parsed objects and validation copies. */
const RESULT_EXPANSION = 16;

type WebBundleResultDescriptor = Extract<
  WebBundleWorkerMessage,
  { readonly kind: "complete" }
>["result"];

type WebBundleObservedFailure =
  | { readonly kind: "input"; readonly cause: Error }
  | { readonly kind: "protocol"; readonly cause: unknown }
  | { readonly kind: "incomplete-output" }
  | {
      readonly kind: "frame";
      readonly frame: Extract<
        WebBundleWorkerMessage,
        { readonly kind: "failure" }
      >;
      readonly resultBudgetBytes: number;
    }
  | {
      readonly kind: "exit";
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly heapExhaustion: boolean;
    };

type WebBundleActiveJob = {
  readonly id: string;
  readonly resultBudgetBytes: number;
};

const stableSnapshotValue = (
  value: unknown,
): StableArtifactSnapshot | undefined => {
  if (
    value === null ||
    typeof value !== "object" ||
    !("bytes" in value) ||
    !Buffer.isBuffer(value.bytes) ||
    !("sha256" in value) ||
    typeof value.sha256 !== "string"
  )
    return undefined;
  return { bytes: value.bytes, sha256: value.sha256 };
};

export interface WebBundleScriptAnalysisFailure {
  readonly error: AnalysisError;
  readonly completed: WebBundleScriptAnalysis | null;
  readonly continuation?: "result_capacity_exhausted";
}

/** Sequential inert-source analysis; only bounded completed facts cross into the host. */
export class WebBundleAnalysisWorker {
  static readonly #pendingCleanup = new Set<WebBundleAnalysisWorker>();
  readonly #runtime: OwnedWorkerRuntime;
  readonly #files = new ArtifactResourceScope();
  readonly #cleanup: AnalysisCleanupLease;
  #decoder = new StringDecoder("utf8");
  #pending = "";
  #frames: WebBundleWorkerMessage[] = [];
  #protocolFailure: unknown;
  #observedFailure: WebBundleObservedFailure | undefined;
  #activeDeadline: ProviderStartupDeadline | undefined;
  #activeJob: WebBundleActiveJob | undefined;
  #activeTerminalResponseObserved = false;
  readonly #frameWaiters = new Set<(outcome: "frame" | "failure") => void>();
  #retainedResultBytes = 0;
  #ready = false;
  readonly #stdout = (chunk: Buffer | string): void => {
    if (this.#activeDeadline?.interruption !== undefined) return;
    if (this.#protocolFailure !== undefined) return;
    try {
      // Refuse the chunk before appending it to any retained control text.
      if (
        Buffer.byteLength(chunk) + Buffer.byteLength(this.#pending) >
        WEB_BUNDLE_WORKER_LIMITS.protocolBytes
      )
        throw new RangeError("Web analyzer exceeded its control-frame budget");
      this.#pending +=
        typeof chunk === "string" ? chunk : this.#decoder.write(chunk);
      for (;;) {
        const end = this.#pending.indexOf("\n");
        if (end < 0) break;
        if (this.#frames.length >= 16)
          throw new RangeError("Web analyzer exceeded its control-frame queue");
        this.#frames.push(
          webBundleWorkerMessageSchema.parse(
            JSON.parse(this.#pending.slice(0, end)),
          ),
        );
        this.#observeFrame(this.#frames.at(-1)!);
        this.#pending = this.#pending.slice(end + 1);
      }
      this.#wakeFrameWaiters("frame");
    } catch (cause) {
      this.#pending = "";
      this.#protocolFailure = cause;
      this.#latchFailure({ kind: "protocol", cause });
      this.#wakeFrameWaiters("failure");
    }
  };

  constructor(
    readonly heapMb = 1024,
    launcher: typeof spawnOwnedProviderProcess = spawnOwnedProviderProcess,
  ) {
    if (!Number.isSafeInteger(heapMb) || heapMb < 128 || heapMb > 16_384)
      throw new RangeError(
        "Web analyzer heap must be an integer from 128 through 16384 MiB",
      );
    this.#runtime = new OwnedWorkerRuntime({
      rootPrefix: "rea-web-bundle-analysis-",
      launcher,
      retryCleanup: () => this.close(),
      onInputFailure: (cause) => {
        if (this.#activeDeadline?.interruption !== undefined) return;
        this.#latchFailure({ kind: "input", cause });
        this.#wakeFrameWaiters("failure");
      },
      supervisorOptions: {
        captureStdout: false,
        maxDiagnosticBytes: 256 * 1024,
        onDiagnostic: (event) => {
          if (this.#activeDeadline?.interruption !== undefined) return;
          if (
            event.type === "exit" &&
            (event.code !== 0 || event.signal !== null)
          ) {
            const stderr = event.snapshot.stderr.text;
            this.#latchFailure({
              kind: "exit",
              code: event.code,
              signal: event.signal,
              heapExhaustion:
                event.snapshot.memoryLimitReached === true ||
                /heap out of memory|heap limit|allocation failed/iu.test(
                  stderr,
                ),
            });
          } else if (event.type === "output-close") {
            if (
              this.#activeDeadline !== undefined &&
              (this.#activeJob === undefined ||
                !this.#activeTerminalResponseObserved)
            )
              this.#latchFailure({ kind: "incomplete-output" });
            this.#wakeFrameWaiters("failure");
          } else if (event.type === "output") {
            const failure = this.#observedFailure;
            if (
              failure?.kind === "exit" &&
              (this.#runtime.supervisor?.snapshot().memoryLimitReached ===
                true ||
                (event.stream === "stderr" &&
                  /heap out of memory|heap limit|allocation failed/iu.test(
                    this.#runtime.supervisor?.snapshot().stderr.text ?? "",
                  )))
            )
              this.#observedFailure = { ...failure, heapExhaustion: true };
          }
        },
      },
    });
    const owner = this;
    this.#cleanup = new AnalysisCleanupLease(() => this.#release(), {
      get cleanupResources() {
        return [
          ...owner.#files.cleanupResources,
          ...(owner.#runtime.cleanupResources ?? []),
        ];
      },
    });
  }

  static async retryPending(): Promise<void> {
    for (const worker of [...this.#pendingCleanup]) await worker.close();
    await OwnedWorkerRuntime.retryPending();
  }

  async analyze(
    script: IncludedScript,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Result<WebBundleScriptAnalysis, WebBundleScriptAnalysisFailure>> {
    let deadline: ProviderStartupDeadline | undefined;
    const id = randomUUID();
    this.#observedFailure = undefined;
    this.#activeJob = undefined;
    this.#activeTerminalResponseObserved = false;
    let result: Result<WebBundleScriptAnalysis, AnalysisError>;
    let completed: WebBundleScriptAnalysis | null = null;
    let continuation: "result_capacity_exhausted" | undefined;
    let resultDescriptor: WebBundleResultDescriptor | undefined;
    const failed = (
      error: AnalysisError,
    ): Result<WebBundleScriptAnalysis, WebBundleScriptAnalysisFailure> =>
      err({
        error,
        completed,
        ...(continuation === undefined ? {} : { continuation }),
      });
    try {
      if (signal?.aborted)
        throw new AnalysisCancelledError(OPERATION, { cause: signal.reason });
      const resultBudget = Math.min(
        WEB_BUNDLE_WORKER_LIMITS.resultBytes - this.#retainedResultBytes,
        Math.max(
          0,
          Math.floor(
            (getHeapStatistics().heap_size_limit -
              process.memoryUsage().heapUsed -
              64 * MIB) /
              RESULT_EXPANSION,
          ),
        ),
      );
      if (resultBudget <= 0) {
        continuation = "result_capacity_exhausted";
        throw new AnalysisResourceConstraintError(
          OPERATION,
          "memory",
          "The host has no remaining reserved web-analysis result capacity",
          { result_bytes: WEB_BUNDLE_WORKER_LIMITS.resultBytes },
        );
      }
      await prepareProcessOwnershipInspection(signal);
      deadline = new ProviderStartupDeadline(timeoutMs, signal);
      this.#activeDeadline = deadline;
      await this.#start(deadline);
      if (this.#frames.length > 0 || this.#pending !== "")
        throw new AnalysisOutputError(
          OPERATION,
          "Web analyzer emitted unsolicited control data",
        );
      const root = this.#runtime.rootPath;
      const supervisor = this.#runtime.supervisor;
      if (root === undefined || supervisor === undefined)
        throw new TypeError("Web analyzer resources were not acquired");
      supervisor.resetOutput();
      const source = await this.#files.run(() =>
        this.#writeSource(join(root, `${id}.source`), script, deadline!.signal),
      );
      const request = webBundleWorkerRequestSchema.parse({
        kind: "analyze",
        id,
        source,
        result_budget_bytes: resultBudget,
      });
      const frame = `${JSON.stringify(request)}\n`;
      const stdin = supervisor.launch.process.stdin;
      if (stdin === null || stdin === undefined)
        throw new TypeError("Web analyzer request stream is unavailable");
      this.#activeJob = { id, resultBudgetBytes: resultBudget };
      this.#activeTerminalResponseObserved = false;
      await new Promise<void>((resolve, reject) =>
        stdin.write(frame, (error) =>
          error == null ? resolve() : reject(error),
        ),
      );
      let response: WebBundleWorkerMessage;
      do {
        response = await this.#next(deadline);
        if (response.kind === "ready" || response.id !== id)
          throw new AnalysisOutputError(
            OPERATION,
            "Web analyzer response names another request",
          );
      } while (response.kind === "phase");
      if (response.kind === "failure") {
        if (response.reason === "resource")
          throw new AnalysisResourceConstraintError(
            OPERATION,
            "memory",
            response.message,
            { result_budget_bytes: resultBudget },
          );
        throw new AnalysisOutputError(
          OPERATION,
          `Web script analysis failed (${response.reason}): ${response.message}`,
        );
      }
      if (response.kind !== "complete")
        throw new AnalysisOutputError(
          OPERATION,
          "Web analyzer did not complete a result",
        );
      const descriptor = response.result;
      resultDescriptor = descriptor;
      // Reserve expansion before reading bytes, decoding JSON or schema validation.
      if (
        descriptor.bytes > resultBudget ||
        descriptor.bytes * RESULT_EXPANSION + 64 * MIB >
          getHeapStatistics().heap_size_limit - process.memoryUsage().heapUsed
      )
        throw new AnalysisResourceConstraintError(
          OPERATION,
          "memory",
          "Completed script facts exceed the host's remaining reserved result capacity",
          { result_budget_bytes: resultBudget },
        );
      const stored = await this.#files.run(() =>
        readStableArtifact(
          join(root, `${id}.result`),
          descriptor.bytes,
          deadline!.signal,
          undefined,
          this.#files,
        ),
      );
      const facts = this.#validateCompletedResult(stored, descriptor, script);
      this.#retainedResultBytes += descriptor.bytes;
      completed = facts;
      result = ok(facts);
    } catch (cause) {
      const snapshot = this.#completedSnapshot(cause);
      if (snapshot !== undefined && resultDescriptor !== undefined) {
        try {
          completed = this.#validateCompletedResult(
            snapshot,
            resultDescriptor,
            script,
          );
          this.#retainedResultBytes += resultDescriptor.bytes;
        } catch {
          // The physical read completed, but only validated facts are retained.
        }
      }
      const cancellationCause = this.#completedReadCancellation(cause);
      const interrupted =
        deadline?.interruption === "timeout"
          ? new AnalysisTimeoutError(OPERATION, timeoutMs, { cause })
          : cancellationCause !== undefined
            ? new AnalysisCancelledError(OPERATION, {
                cause: cancellationCause.reason,
              })
            : deadline?.interruption === "cancelled" || signal?.aborted
              ? new AnalysisCancelledError(OPERATION, {
                  cause: signal?.aborted
                    ? signal.reason
                    : deadline?.signal.reason,
                })
              : undefined;
      const observedFailure =
        this.#observedFailure === undefined
          ? undefined
          : this.#projectObservedFailure();
      if (observedFailure !== undefined && interrupted !== undefined)
        observedFailure.retainSecondaryFailure(interrupted);
      const failure =
        cause instanceof ArtifactFileCleanupFailure &&
        cause.fileCleanupFailure.outcome.kind === "completed"
          ? this.#cleanupFailure(cause, interrupted)
          : interrupted !== undefined && observedFailure !== undefined
            ? observedFailure
            : (interrupted ??
              (cause instanceof PrivateRuntimeRootUnavailableError
                ? new AnalysisCapabilityUnavailableError(
                    PROVIDER,
                    OPERATION,
                    cause.message,
                    { cause, retryable: cause.retryable },
                  )
                : cause instanceof AnalysisError
                  ? cause
                  : new AnalysisOutputError(
                      OPERATION,
                      "Owned web-script analysis failed",
                      { cause },
                    )));
      result = err(failure);
      try {
        const stopped = await this.#runtime.stop();
        if (stopped.status === "incomplete") throw new Error(stopped.reason);
        this.#reset();
      } catch (cleanupCause) {
        result = err(this.#cleanupFailure(cleanupCause, failure));
      }
    } finally {
      this.#activeDeadline = undefined;
      deadline?.dispose();
      this.#activeJob = undefined;
      this.#activeTerminalResponseObserved = false;
    }
    // Never remove job files while a failed descriptor or child remains owned.
    if (!result.ok && result.error.cleanupIncomplete)
      return failed(result.error);
    if (this.#files.hasPending)
      return failed(
        this.#cleanupFailure(
          new Error("Web analyzer artifact cleanup is incomplete"),
          result.ok ? undefined : result.error,
        ),
      );
    try {
      const root = this.#runtime.rootPath;
      if (root !== undefined) {
        await rm(join(root, `${id}.source`), { force: true });
        await rm(join(root, `${id}.result`), { force: true });
      }
    } catch (cause) {
      return failed(
        this.#cleanupFailure(cause, result.ok ? undefined : result.error),
      );
    }
    if (signal?.aborted && result.ok)
      return failed(
        new AnalysisCancelledError(OPERATION, { cause: signal.reason }),
      );
    return result.ok ? result : failed(result.error);
  }

  async #writeSource(
    path: string,
    script: IncludedScript,
    signal: AbortSignal,
  ): Promise<{ bytes: number; sha256: string }> {
    const digest = createHash("sha256");
    let bytes = 0;
    const file = await open(path, "wx", 0o600);
    await withArtifactFileHandle(
      path,
      file,
      this.#files,
      signal,
      async (handle) => {
        for (const part of bufferedJsonParts(jsonParts(script))) {
          signal.throwIfAborted();
          const chunk = Buffer.from(part, "utf8");
          if (chunk.length > WEB_BUNDLE_WORKER_LIMITS.sourceBytes - bytes)
            throw new AnalysisResourceConstraintError(
              OPERATION,
              "transport",
              "Captured script metadata and source exceed the worker transfer budget",
              { source_bytes: WEB_BUNDLE_WORKER_LIMITS.sourceBytes },
            );
          await handle.writeFile(chunk);
          bytes += chunk.length;
          digest.update(chunk);
        }
      },
    );
    return { bytes, sha256: digest.digest("hex") };
  }

  async #start(deadline: ProviderStartupDeadline): Promise<void> {
    if (this.#ready && this.#runtime.supervisor !== undefined) return;
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      UV_THREADPOOL_SIZE: "1",
    };
    delete environment.NODE_OPTIONS;
    const memoryLimitBytes = javaScriptWorkerMemoryLimitBytes(this.heapMb);
    await this.#runtime.start(
      {
        command: process.execPath,
        arguments: [
          `--max-old-space-size=${String(this.heapMb)}`,
          "--max-semi-space-size=8",
          "--v8-pool-size=1",
          "--expose-gc",
          "--stack_size=2048",
          fileURLToPath(import.meta.resolve("#web-bundle-analysis-worker")),
        ],
        runId: `rea-web-bundle-analysis-${randomUUID()}`,
        hostEnvironment: environment,
        stdin: "pipe",
        signal: deadline.signal,
        ...(memoryLimitBytes === null ? {} : { memoryLimitBytes }),
      },
      async () => {
        this.#runtime.onStdout(this.#stdout);
        const ready = await this.#next(deadline);
        if (
          ready.kind !== "ready" ||
          (ready.heap_limit_bytes === null) ===
            (javaScriptRuntime(process.versions).id === "node")
        )
          throw new AnalysisOutputError(
            OPERATION,
            "Web analyzer ready frame has an incompatible runtime heap limit",
          );
        this.#ready = true;
      },
    );
  }

  async #next(
    deadline: ProviderStartupDeadline,
  ): Promise<WebBundleWorkerMessage> {
    for (;;) {
      if (deadline.interruption === "timeout")
        throw new AnalysisTimeoutError(OPERATION, deadline.timeoutMs);
      if (deadline.interruption === "cancelled")
        throw new AnalysisCancelledError(OPERATION, {
          cause: deadline.signal.reason,
        });
      deadline.signal.throwIfAborted();
      const frame = this.#frames.shift();
      if (frame !== undefined) return frame;
      if (this.#runtime.inputFailure !== undefined)
        this.#latchFailure({
          kind: "input",
          cause: this.#runtime.inputFailure,
        });
      if (this.#protocolFailure !== undefined)
        this.#latchFailure({ kind: "protocol", cause: this.#protocolFailure });
      if (
        this.#observedFailure !== undefined &&
        this.#observedFailure.kind !== "exit"
      )
        throw this.#projectObservedFailure();
      const supervisor = this.#runtime.supervisor;
      const snapshot = supervisor?.snapshot();
      if (
        snapshot !== undefined &&
        (snapshot.exitCode !== undefined || snapshot.signal !== undefined)
      ) {
        if (supervisor === undefined) continue;
        const outcome = await this.#waitForFrameOrOutputClose(
          supervisor,
          deadline,
        );
        if (outcome === "interrupted") {
          const completedFrame = this.#frames.shift();
          if (completedFrame !== undefined) return completedFrame;
          throw deadline.interruption === "timeout"
            ? new AnalysisTimeoutError(OPERATION, deadline.timeoutMs)
            : new AnalysisCancelledError(OPERATION, {
                cause: deadline.signal.reason,
              });
        }
        const completedFrame = this.#frames.shift();
        if (completedFrame !== undefined) return completedFrame;
        if (outcome === "failure") throw this.#projectObservedFailure();
        if (outcome === "frame") continue;
        if (this.#observedFailure !== undefined)
          throw this.#projectObservedFailure();
        throw new AnalysisOutputError(
          OPERATION,
          "Owned web analyzer exited before completing this script",
          { capturedOutput: this.#capturedOutput() },
        );
      }
      await deadline.wait(10);
    }
  }

  #latchFailure(failure: WebBundleObservedFailure): void {
    if (
      this.#observedFailure === undefined &&
      this.#activeDeadline?.interruption === undefined
    )
      this.#observedFailure = failure;
  }

  #observeFrame(frame: WebBundleWorkerMessage): void {
    if (
      this.#activeDeadline?.interruption !== undefined ||
      this.#activeJob === undefined ||
      frame.kind === "ready" ||
      frame.id !== this.#activeJob.id
    )
      return;
    if (frame.kind === "complete" || frame.kind === "failure")
      this.#activeTerminalResponseObserved = true;
    if (frame.kind !== "failure") return;
    this.#latchFailure({
      kind: "frame",
      frame,
      resultBudgetBytes: this.#activeJob.resultBudgetBytes,
    });
  }

  #projectObservedFailure(): AnalysisError {
    const failure = this.#observedFailure;
    if (failure === undefined)
      return new AnalysisOutputError(
        OPERATION,
        "Owned web analyzer exited before completing this script",
        { capturedOutput: this.#capturedOutput() },
      );
    const capturedOutput = this.#capturedOutput();
    switch (failure.kind) {
      case "input":
        return new AnalysisOutputError(
          OPERATION,
          "Web analyzer request stream failed",
          { cause: failure.cause, capturedOutput },
        );
      case "protocol":
        return new AnalysisOutputError(
          OPERATION,
          "Invalid web analyzer control frame",
          { cause: failure.cause, capturedOutput },
        );
      case "incomplete-output":
        return new AnalysisOutputError(
          OPERATION,
          "Owned web analyzer output closed before completing this script",
          { capturedOutput },
        );
      case "frame":
        return failure.frame.reason === "resource"
          ? new AnalysisResourceConstraintError(
              OPERATION,
              "memory",
              failure.frame.message,
              {
                result_budget_bytes: failure.resultBudgetBytes,
              },
              { capturedOutput },
            )
          : new AnalysisOutputError(
              OPERATION,
              `Web script analysis failed (${failure.frame.reason}): ${failure.frame.message}`,
              { capturedOutput },
            );
      case "exit":
        if (failure.heapExhaustion)
          return new AnalysisResourceConstraintError(
            OPERATION,
            "memory",
            "Owned web analyzer exhausted its configured memory limit",
            {
              worker_heap_limit_mb: this.heapMb,
              worker_process_memory_limit_bytes:
                javaScriptWorkerMemoryLimitBytes(this.heapMb),
            },
            { capturedOutput },
          );
        return new AnalysisOutputError(
          OPERATION,
          "Owned web analyzer exited before completing this script",
          { capturedOutput },
        );
    }
  }

  #capturedOutput() {
    const supervisor = this.#runtime.supervisor;
    const snapshot = supervisor?.snapshot();
    return {
      stdout: "",
      stderr: snapshot?.stderr.text ?? "",
      truncated:
        snapshot?.diagnosticTruncated === true ||
        snapshot?.outputIncomplete === true ||
        (supervisor !== undefined && !supervisor.observedOutputClose()),
      exit_code: snapshot?.exitCode ?? null,
      signal: snapshot?.signal ?? null,
    };
  }

  #wakeFrameWaiters(outcome: "frame" | "failure"): void {
    for (const wake of this.#frameWaiters) wake(outcome);
    this.#frameWaiters.clear();
  }

  async #waitForFrameOrOutputClose(
    supervisor: NonNullable<OwnedWorkerRuntime["supervisor"]>,
    deadline: ProviderStartupDeadline,
  ): Promise<"frame" | "failure" | "closed" | "interrupted"> {
    if (this.#frames.length > 0) return "frame";
    let wakeFrame!: (outcome: "frame" | "failure") => void;
    const frameAvailable = new Promise<"frame" | "failure">((resolve) => {
      wakeFrame = resolve;
      this.#frameWaiters.add(wakeFrame);
    });
    const outputCloseController = new AbortController();
    const interruptOutputClose = () =>
      outputCloseController.abort(deadline.signal.reason);
    if (deadline.signal.aborted) interruptOutputClose();
    else
      deadline.signal.addEventListener("abort", interruptOutputClose, {
        once: true,
      });
    try {
      const outputClose = supervisor
        .waitForOutputClose(undefined, outputCloseController.signal)
        .then((closed): "closed" | "interrupted" =>
          closed ? "closed" : "interrupted",
        );
      return await Promise.race([frameAvailable, outputClose]);
    } finally {
      outputCloseController.abort();
      deadline.signal.removeEventListener("abort", interruptOutputClose);
      this.#frameWaiters.delete(wakeFrame);
    }
  }

  #completedSnapshot(cause: unknown): StableArtifactSnapshot | undefined {
    if (cause instanceof ArtifactFileCancelled)
      return stableSnapshotValue(cause.fileCancellation.outcome.value);
    if (
      cause instanceof ArtifactFileCleanupFailure &&
      cause.fileCleanupFailure.outcome.kind === "completed"
    )
      return stableSnapshotValue(cause.fileCleanupFailure.outcome.value);
    return undefined;
  }

  #completedReadCancellation(
    cause: unknown,
  ): { readonly reason: unknown } | undefined {
    if (cause instanceof ArtifactFileCancelled)
      return { reason: artifactFileCancellationCause(cause) };
    if (
      cause instanceof ArtifactFileCleanupFailure &&
      cause.fileCleanupFailure.outcome.kind === "completed"
    )
      return cause.fileCleanupFailure.completionCancellation;
    return undefined;
  }

  #validateCompletedResult(
    stored: StableArtifactSnapshot,
    descriptor: WebBundleResultDescriptor,
    script: IncludedScript,
  ): WebBundleScriptAnalysis {
    if (
      stored.bytes.length !== descriptor.bytes ||
      stored.sha256 !== descriptor.sha256
    )
      throw new AnalysisOutputError(
        OPERATION,
        "Web analyzer result differs from its descriptor",
      );
    const facts = webBundleScriptAnalysisSchema.parse(
      JSON.parse(stored.bytes.toString("utf8")),
    );
    if (facts.status !== "analyzed" || facts.script_key !== script.script_key)
      throw new AnalysisOutputError(
        OPERATION,
        "Web analyzer facts name another script",
      );
    return facts;
  }

  #reset(): void {
    this.#ready = false;
    this.#frames = [];
    this.#pending = "";
    this.#decoder = new StringDecoder("utf8");
    this.#protocolFailure = undefined;
    this.#observedFailure = undefined;
    this.#activeDeadline = undefined;
    this.#activeJob = undefined;
    this.#activeTerminalResponseObserved = false;
    this.#wakeFrameWaiters("failure");
  }

  #cleanupFailure(cause: unknown, primary?: AnalysisError): AnalysisError {
    WebBundleAnalysisWorker.#pendingCleanup.add(this);
    this.#runtime.retainForCleanup();
    const cleanup = new ProviderCleanupError(
      PROVIDER,
      this.#cleanup.cleanupResources ?? [],
      { reason: "Owned web analyzer cleanup remains incomplete" },
      { operation: OPERATION, cause },
    );
    new AnalysisCleanupLeaseGroup(cleanup, [this.#cleanup]);
    return primary === undefined
      ? cleanup
      : analysisErrorWithCleanupFailure(
          primary,
          cleanup,
          OPERATION,
        ).bindCleanupDependencies([primary, cleanup]);
  }

  async close(): Promise<void> {
    try {
      await this.#cleanup.release();
    } catch (cause) {
      throw this.#cleanupFailure(cause);
    }
  }

  async #release(): Promise<void> {
    try {
      const stopped = await this.#runtime.stop();
      if (stopped.status === "incomplete") throw new Error(stopped.reason);
      await this.#files.close();
      await this.#runtime.close();
      this.#reset();
      WebBundleAnalysisWorker.#pendingCleanup.delete(this);
    } catch (cause) {
      WebBundleAnalysisWorker.#pendingCleanup.add(this);
      this.#runtime.retainForCleanup();
      throw cause;
    }
  }
}
