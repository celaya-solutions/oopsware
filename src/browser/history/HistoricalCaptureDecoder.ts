import {
  decodeCaptureProtobuf,
  prepareCaptureProtobuf,
} from "./protobuf/ProtobufCapture.js";
import { CaptureFormatError } from "./CaptureFormatError.js";
import {
  CAPTURE_PROCESS_MEMORY_LIMIT_REASON,
  historicalCaptureFailure,
  captureMemoryFailure,
  withCaptureReaderCleanup,
} from "./CaptureFailures.js";
import {
  NODE_CAPTURE_HEAP_ENFORCED,
  NODE_CAPTURE_HEAP_LIMITS,
  NODE_CAPTURE_PROCESS_MEMORY_LIMIT_BYTES,
} from "./CaptureRelease.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import type { HistoricalCaptureFormatAdapter } from "./HistoricalCaptureFormatAdapter.js";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ExecutionOptions } from "../../application/AnalysisProvider.js";
import { readStableArtifact } from "../../artifacts/readStableArtifact.js";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import {
  ArtifactResourceScope,
  type ArtifactCleanupAttempt,
} from "../../artifacts/ArtifactResourceScope.js";
import { AnalysisCleanupLeaseGroup } from "../../artifacts/AnalysisCleanupLease.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
} from "../../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import { analysisErrorWithCleanupFailure } from "../../domain/analysisErrorCleanup.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  WEB_NETWORK_CAPTURE_LIMITS,
  webNetworkCapturePayloadSchema,
  type InspectWebNetworkCaptureInput,
  type WebNetworkCapture,
} from "../../domain/webNetworkCapture.js";
import { runOwnedCommand } from "../../process/OwnedCommand.js";
import { PrivateRuntimeRoot } from "../../process/PrivateRuntimeRoot.js";
import { redactExplicitFailure } from "../../domain/explicitSensitiveFailure.js";

const OPERATION = "inspect_web_network_capture";
const replySchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    value: webNetworkCapturePayloadSchema,
  }),
  z.strictObject({
    ok: z.literal(false),
    reason: z.enum([
      "format",
      "unsupported",
      "input-limit",
      "expanded-limit",
      "resource-limit",
      "decoder",
      "limit",
    ]),
    message: z.string(),
    pointer: z.string(),
  }),
]);

/** One owned snapshot/process/root lifecycle for replaceable historical format decoders. */
export class HistoricalCaptureDecoder {
  readonly #resources: ArtifactResourceScope;

  constructor(
    readonly adapters: readonly HistoricalCaptureFormatAdapter[],
    readonly environment: Readonly<NodeJS.ProcessEnv>,
    readonly createRuntime: () => Promise<
      Pick<PrivateRuntimeRoot, "path" | "close">
    > = () => PrivateRuntimeRoot.create({ prefix: "rea-web-capture-" }),
    resources = new ArtifactResourceScope(),
  ) {
    this.#resources = resources;
  }

  /** Retry retained readers and private roots at service shutdown. */
  close(): Promise<void> {
    return this.#resources.close();
  }

  /** Snapshot the selected artifact, decode it offline, and release private credentials and processes. */
  async inspect(
    input: InspectWebNetworkCaptureInput,
    options?: ExecutionOptions,
  ): Promise<Result<WebNetworkCapture, AnalysisError>> {
    try {
      return await this.#resources.run(() =>
        this.inspectAdmitted(input, options),
      );
    } catch (cause: unknown) {
      const error = historicalCaptureFailure(
        input,
        cause,
        "capture-read",
        options,
      );
      return err(
        redactExplicitFailure(
          withCaptureReaderCleanup(error, cause),
          input.sensitive_values,
        ),
      );
    }
  }

  private async inspectAdmitted(
    input: InspectWebNetworkCaptureInput,
    options?: ExecutionOptions,
  ): Promise<Result<WebNetworkCapture, AnalysisError>> {
    let runtime: Pick<PrivateRuntimeRoot, "path" | "close"> | undefined;
    let result: Result<WebNetworkCapture, AnalysisError>;
    let phase: "capture-read" | "decoder" = "capture-read";
    let encodedReplyBytes = 0;
    try {
      const adapter = this.adapters.find(
        (candidate) => candidate.format === input.format,
      );
      if (adapter === undefined)
        throw new AnalysisCapabilityUnavailableError(
          input.format,
          OPERATION,
          "No adapter is configured for the selected capture format.",
        );
      const snapshot = await readStableArtifact(
        input.capture_path,
        WEB_NETWORK_CAPTURE_LIMITS.inputBytes,
        options?.signal,
        undefined,
        this.#resources,
      );
      phase = "decoder";
      runtime = await this.createRuntime();
      const snapshotPath = join(runtime.path, "capture.snapshot");
      const requestPath = join(runtime.path, "request.json");
      const replyPath = join(runtime.path, "reply.json");
      await writeFile(snapshotPath, snapshot.bytes, {
        mode: 0o600,
        flag: "wx",
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      });
      await writeFile(
        requestPath,
        JSON.stringify({
          snapshot_path: snapshotPath,
          reply_path: replyPath,
          sensitive_values: input.sensitive_values,
        }),
        { mode: 0o600, flag: "wx" },
      );
      const command = await adapter.command(requestPath, runtime.path);
      const environment: NodeJS.ProcessEnv = {
        ...this.environment,
        UV_THREADPOOL_SIZE: "1",
      };
      delete environment.NODE_OPTIONS;
      const completed = await runOwnedCommand(
        {
          ...command,
          runId: `rea-web-capture-${randomUUID()}`,
          cwd: runtime.path,
          hostEnvironment: environment,
        },
        {
          timeoutMs: WEB_NETWORK_CAPTURE_LIMITS.timeoutMs,
          diagnosticBytes: 1024 * 1024,
        },
        options?.signal === undefined ? {} : { signal: options.signal },
      );
      // A decoder that survived a failed allocation may still reply; its
      // reply is not trusted as complete once the limit was reached.
      if (completed.memoryLimitReached === true)
        throw captureMemoryFailure(input, CAPTURE_PROCESS_MEMORY_LIMIT_REASON);
      let reply: z.output<typeof replySchema>;
      try {
        const replyFile = await readStableArtifact(
          replyPath,
          WEB_NETWORK_CAPTURE_LIMITS.outputBytes,
          options?.signal,
          undefined,
          this.#resources,
        );
        encodedReplyBytes = replyFile.bytes.length;
        reply = replySchema.parse(JSON.parse(replyFile.bytes.toString("utf8")));
      } catch (cause: unknown) {
        if (cause instanceof ArtifactReaderFailure) throw cause;
        if (
          options?.signal?.aborted === true &&
          (cause === options.signal.reason ||
            (cause instanceof Error &&
              cause.name === "AbortError" &&
              "code" in cause &&
              cause.code === "ABORT_ERR"))
        )
          throw cause;
        throw new AnalysisOutputError(
          OPERATION,
          `Owned capture decoder reply failed for ${input.capture_path}: ${replyFailureReason(cause)}`,
          { cause },
        );
      }
      if (!reply.ok) {
        if (reply.reason === "format")
          throw new AnalysisInputError(OPERATION, undefined, [
            {
              path: ["capture_path", reply.pointer],
              reason: "invalid_format",
              message: reply.message,
            },
          ]);
        if (reply.reason === "input-limit")
          throw new AnalysisInputError(OPERATION, undefined, [
            {
              path: ["capture_path", reply.pointer],
              reason: "out_of_range",
              message: reply.message,
              expected: {
                maximum_capture_nesting: WEB_NETWORK_CAPTURE_LIMITS.depth,
              },
            },
          ]);
        if (reply.reason === "expanded-limit")
          throw new AnalysisInputError(OPERATION, undefined, [
            {
              path: ["capture_path", reply.pointer],
              reason: "out_of_range",
              message: reply.message,
              expected: {
                maximum_expanded_capture_bytes:
                  WEB_NETWORK_CAPTURE_LIMITS.inputBytes,
              },
            },
          ]);
        if (reply.reason === "resource-limit")
          throw captureMemoryFailure(input, reply.message);
        if (reply.reason === "decoder")
          throw new ProviderAdapterError(input.format, OPERATION, {
            diagnostics: {
              phase: "decoder",
              failure_kind: reply.reason,
              reason: reply.message,
              pointer: reply.pointer,
            },
          });
        if (reply.reason === "unsupported")
          throw new AnalysisCapabilityUnavailableError(
            input.format,
            OPERATION,
            reply.message,
          );
        throw new AnalysisOutputError(OPERATION, reply.message);
      }
      if (
        reply.value.decoder.id !== adapter.identity.id ||
        reply.value.decoder.name !== adapter.identity.name ||
        reply.value.decoder.version !== adapter.identity.version
      )
        throw new AnalysisOutputError(
          OPERATION,
          "Capture decoder changed the selected upstream profile identity.",
        );
      const common = {
        artifact: {
          path: input.capture_path,
          sha256: snapshot.sha256,
          bytes: snapshot.bytes.length,
        },

        runtime_attribution: "unknown" as const,
        limitations: [
          ...(adapter.limitations ?? []),
          "This is retained producer evidence, without live browser transaction IDs, scenario provenance, execution attribution or deployment authenticity. Recorded URLs are never fetched.",
          "Every record is decoded before selection; no partial success is returned on malformed input or a resource limit.",
          "Known authentication headers/cookies and explicitly marked literal values are excluded. Unknown extension names do not establish sensitivity.",
          `A 32 MiB input, 96 MiB reply and 64-level nesting budget bound complete evidence. ${nodeMemoryLimitation()}; mitmproxy decoding uses a 768 MiB Linux address-space limit. Each owned command has a 30-second deadline with independent cleanup.`,
        ],
      };
      if (input.format === "qlog") {
        if (!("qlog" in reply.value))
          throw new AnalysisOutputError(
            OPERATION,
            "Capture decoder omitted qlog transport facts.",
          );
        result = ok({ ...reply.value, ...common, format: "qlog" });
      } else {
        if ("qlog" in reply.value)
          throw new AnalysisOutputError(
            OPERATION,
            "Capture decoder supplied inapplicable qlog transport facts.",
          );
        result = ok({ ...reply.value, ...common, format: input.format });
      }
      if (result.ok) {
        let safePartialSource = false;
        try {
          const prepared = await prepareCaptureProtobuf(
            result.value,
            input,
            options?.signal,
          );
          safePartialSource = true;
          await decodeCaptureProtobuf(
            result.value,
            input,
            this.#resources,
            prepared,
            options?.signal,
            encodedReplyBytes + Buffer.byteLength(JSON.stringify(common)) + 16,
          );
        } catch (cause) {
          const error =
            cause instanceof CaptureFormatError && cause.reason === "limit"
              ? new AnalysisResourceConstraintError(
                  OPERATION,
                  "capacity",
                  cause.message,
                  {
                    maximum_encoded_capture_bytes:
                      WEB_NETWORK_CAPTURE_LIMITS.outputBytes,
                  },
                  {
                    retryable: false,
                    remediationAction:
                      "Select smaller records, or inspect the retained original source bytes.",
                  },
                )
              : cause instanceof CaptureFormatError
                ? new AnalysisInputError(OPERATION, undefined, [
                    {
                      path: ["protobuf"],
                      reason: "invalid_format",
                      message: cause.message,
                    },
                  ])
                : historicalCaptureFailure(input, cause, phase, options);
          if (safePartialSource) error.retainPartialObservation(result.value);
          throw error;
        }
      }
    } catch (cause: unknown) {
      const error = historicalCaptureFailure(input, cause, phase, options);
      result = err(
        redactExplicitFailure(
          withCaptureReaderCleanup(error, cause),
          input.sensitive_values,
        ),
      );
    }
    const completedCapture = result.ok ? result.value : undefined;
    let cleanupFailure:
      | Extract<ArtifactCleanupAttempt, { readonly kind: "failed" }>
      | undefined;
    if (runtime !== undefined) {
      const cleanup = await this.#resources.release({
        kind: "private-runtime-root",
        resource: runtime.path,
        root: runtime,
      });
      if (cleanup.kind === "failed") cleanupFailure = cleanup;
    }
    if (result.ok && options?.signal?.aborted)
      result = err(
        new AnalysisCancelledError(OPERATION, {
          cause: options.signal.reason,
        }),
      );
    if (cleanupFailure !== undefined) {
      const cleanupError = new ProviderCleanupError(
        input.format,
        [cleanupFailure.owner.resource],
        {
          capture_path: input.capture_path,
          reason:
            cleanupFailure.cause instanceof Error
              ? cleanupFailure.cause.message
              : String(cleanupFailure.cause),
        },
        {
          operation: OPERATION,
          cause: cleanupFailure.cause,
        },
      );
      const failure = result.ok
        ? cleanupError
        : analysisErrorWithCleanupFailure(
            result.error,
            cleanupError,
            OPERATION,
          );
      if (completedCapture !== undefined)
        failure.retainPartialObservation(completedCapture);
      new AnalysisCleanupLeaseGroup(cleanupError, [cleanupFailure.lease]);
      const redacted = redactExplicitFailure(failure, input.sensitive_values);
      if (!result.ok)
        redacted.bindCleanupDependencies([result.error, cleanupError]);
      new AnalysisCleanupLeaseGroup(redacted, [cleanupFailure.lease]);
      return err(redacted);
    }
    if (!result.ok && completedCapture !== undefined)
      result.error.retainPartialObservation(completedCapture);
    return result;
  }
}

/** The Node capture decoder runs on this executable; only Node.js enforces its V8 heap flags. */
const nodeMemoryLimitation = (): string => {
  if (NODE_CAPTURE_HEAP_ENFORCED)
    return `HAR/SAZ/qlog use a ${String(NODE_CAPTURE_HEAP_LIMITS.oldGenerationMiB)} MiB Node old-generation heap`;
  return NODE_CAPTURE_PROCESS_MEMORY_LIMIT_BYTES === null
    ? "HAR/SAZ/qlog run on Bun, which does not enforce REA's V8 heap flags"
    : `HAR/SAZ/qlog run on Bun, which does not enforce REA's V8 heap flags, under a ${String(NODE_CAPTURE_PROCESS_MEMORY_LIMIT_BYTES)}-byte Windows Job Object commit limit`;
};

const replyFailureReason = (cause: unknown): string => {
  if (cause instanceof ArtifactReaderFailure) return cause.message;
  if (cause instanceof z.ZodError)
    return `Reply violates its schema at ${cause.issues[0]?.path.map(String).join(".") ?? "root"}.`;
  if (cause instanceof SyntaxError) return "Reply is malformed JSON.";
  if (cause instanceof Error && "code" in cause)
    return `Reply file could not be read (${String(cause.code)}).`;
  return "Reply could not be validated.";
};
