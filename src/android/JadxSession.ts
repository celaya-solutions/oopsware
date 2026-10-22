import { throwIfJadxInterrupted } from "./JadxInterruption.js";
import { Client } from "@modelcontextprotocol/client";
import {
  createAnalysisExecution,
  type AnalysisExecution,
} from "../application/AnalysisProvider.js";
import type { AndroidRequest } from "../domain/android/androidAnalysis.js";
import type { AndroidPartialObservation } from "../domain/android/androidPartialObservation.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import type { OwnedProviderProcessSpawnOptions } from "../process/ProviderProcess.js";
import { analyzeJadxRequest, type JadxToolPort } from "./JadxAnalysis.js";
import { JadxMcpTransport, type JadxLauncher } from "./JadxMcpTransport.js";
import {
  jadxLoadSchema,
  parseJadxFailure,
  jadxRuntimeSchema,
  parseJadxEnvelope,
  parseJadxJson,
} from "./JadxProtocol.js";
import {
  JADX_BRIDGE_IDENTITY,
  JADX_RELEASE,
  JADX_PROVIDER_IDENTITY,
  JADX_LIMITATIONS,
} from "./JadxRelease.js";

/** One owned engine connection; its wire protocol stays inside the Android adapter. */
export class JadxSession {
  readonly transport: JadxMcpTransport;
  readonly #client = new Client({ name: "rea-android-adapter", version: "1" });
  #loaded: ReturnType<typeof jadxLoadSchema.parse> | undefined;
  #connected = false;
  #partialContext:
    | {
        readonly operation: AndroidRequest["operation"];
        readonly selectedPath: string;
        readonly target: BinaryTarget;
        readonly jarHash: string;
        readonly bridgeHash: string;
      }
    | undefined;
  #observedCalls: {
    readonly operation: string;
    readonly input: Readonly<Record<string, JsonValue>>;
    readonly response: JsonValue;
  }[] = [];
  #serverName: string | null = null;
  #serverVersion: string | null = null;
  #engineVersion: string | null = null;

  constructor(
    options: Omit<OwnedProviderProcessSpawnOptions, "runId" | "stdin">,
    launcher?: JadxLauncher,
  ) {
    this.transport = new JadxMcpTransport(options, launcher);
  }

  /** Analyze one admitted immutable APK, checking producer identity and selectors. */
  async execute(context: {
    readonly request: AndroidRequest;
    readonly target: BinaryTarget;
    readonly snapshot: string;
    readonly jarHash: string;
    readonly bridgeHash: string;
    readonly signal: AbortSignal;
    /** Selected whole-operation deadline; also bounds each upstream call. */
    readonly timeoutMs: number;
  }): Promise<AnalysisExecution> {
    const { request, target, snapshot, jarHash, signal, timeoutMs } = context;
    this.#partialContext = {
      operation: request.operation,
      selectedPath: request.input.path,
      target,
      jarHash,
      bridgeHash: context.bridgeHash,
    };
    this.#observedCalls = [];
    this.#serverName = null;
    this.#serverVersion = null;
    this.#engineVersion = null;
    const abort = () => {
      void this.transport.interrupt(signal.reason).catch(() => undefined);
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (signal.aborted) abort();
      throwIfJadxInterrupted(signal);
      this.transport.beginOperation();
      if (!this.#connected) {
        await this.#client.connect(this.transport, { timeout: 30_000 });
        this.#connected = true;
      }
      const server = this.#client.getServerVersion();
      this.#serverName = server?.name ?? null;
      this.#serverVersion = server?.version ?? null;
      if (
        server?.name !== JADX_BRIDGE_IDENTITY.name ||
        server.version !== JADX_BRIDGE_IDENTITY.version
      )
        throw new AnalysisCapabilityUnavailableError(
          "jadx",
          request.operation,
          `Expected ${JADX_BRIDGE_IDENTITY.name} ${JADX_BRIDGE_IDENTITY.version}; server reported ${server?.name ?? "unknown"} ${server?.version ?? "unknown"}.`,
        );
      const tools = this.#tools(request, target, signal, timeoutMs);
      const runtime = jadxRuntimeSchema.parse(
        await tools.json("rea_jvm_status", {}),
      );
      this.#engineVersion = runtime.engine_reported_version;
      if (runtime.engine_reported_version !== JADX_RELEASE.version)
        throw new AnalysisCapabilityUnavailableError(
          "jadx",
          request.operation,
          `Expected engine ${JADX_RELEASE.version}; JAR reported ${runtime.engine_reported_version}.`,
        );
      const loaded =
        this.#loaded ??
        jadxLoadSchema.parse(
          await tools.json("load_apk", {
            path: snapshot,
            threads: 1,
            resources: "full",
          }),
        );
      if (loaded.apk_path !== snapshot)
        throw new AnalysisOutputError(
          request.operation,
          "JADX loaded a different APK path than the admitted snapshot",
        );
      this.#loaded = loaded;
      const engine = {
        name: "jadx-headless-mcp",
        version: runtime.engine_reported_version,
        artifact_sha256: jarHash,
        source_revision:
          jarHash === JADX_RELEASE.sha256 ? JADX_RELEASE.revision : null,
        worker_count: 1,
        heap_limit_mib:
          Math.floor(runtime.max_heap_bytes / (1024 * 1024)) || null,
      } as const;
      const result = await analyzeJadxRequest(tools, request, loaded, engine);
      return createAnalysisExecution(result, JADX_PROVIDER_IDENTITY, {
        rawResult: {
          server,
          bridge_sha256: context.bridgeHash,
          jar_sha256: jarHash,
          loaded,
          calls: this.#observedCalls,
        },
        subject: target,
        limitations: JADX_LIMITATIONS,
        locations:
          request.operation === "inspect_android_package"
            ? [{ kind: "artifact-path", path: "AndroidManifest.xml" }]
            : [],
      });
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  /** Facts and upstream replies retained if a later request step fails. */
  partialObservation(): AndroidPartialObservation | undefined {
    const context = this.#partialContext;
    if (context === undefined) return undefined;
    return {
      provider_id: "jadx",
      operation: context.operation,
      target: {
        selected_path: context.selectedPath,
        path: context.target.path,
        sha256: context.target.sha256,
        format: "apk",
      },
      provider_facts: {
        jar_sha256: context.jarHash,
        bridge_sha256: context.bridgeHash,
        bridge_name: JADX_BRIDGE_IDENTITY.name,
        bridge_version: JADX_BRIDGE_IDENTITY.version,
        server_name: this.#serverName,
        server_version: this.#serverVersion,
        engine_version: this.#engineVersion,
      },
      calls: this.#observedCalls,
    };
  }

  /** Whether the selected Java runtime established the Oopsware bridge protocol. */
  initialized(): boolean {
    return this.#connected;
  }

  /** Join owned cleanup even if SDK connection teardown itself fails. */
  async close(): Promise<void> {
    try {
      await this.#client.close();
    } finally {
      await this.transport.close();
    }
  }

  #tools(
    request: AndroidRequest,
    target: BinaryTarget,
    signal: AbortSignal,
    timeoutMs: number,
  ): JadxToolPort {
    const call = async (
      name: string,
      input: Readonly<Record<string, JsonValue>>,
    ): Promise<string> => {
      throwIfJadxInterrupted(signal);
      // Keep an explicit bound: omitting it falls back to the SDK's 60-second default.
      const response = await this.#client.callTool(
        { name, arguments: input },
        { timeout: timeoutMs, signal },
      );
      const observedResponse = jsonValueSchema.parse(response);
      const call = { operation: name, input, response: observedResponse };
      this.#observedCalls.push(call);
      const envelope = parseJadxEnvelope(response, request.operation);
      if (envelope.failed) {
        const failure = parseJadxFailure(envelope.text);
        if (failure !== undefined) {
          if (name === "load_apk" && failure.kind === "jvm-memory-failure")
            throw new AnalysisResourceConstraintError(
              request.operation,
              "memory",
              `The JADX JVM could not allocate memory during ${name}${failure.message ? `: ${failure.message}` : ""}`,
              {
                observed_max_heap_bytes: failure.max_heap_bytes,
                memory_area: failure.memory_area,
              },
              {
                retryable: false,
                remediationAction:
                  failure.memory_area === "heap"
                    ? "Increase REA_JADX_HEAP_MIB (MiB) in the environment that starts REA, within the host or container memory budget. Review JAVA_TOOL_OPTIONS and other JVM heap overrides. The observed heap is this run's limit, not the heap the APK requires."
                    : "Review the JVM allocation failure and the host or container memory limits. The observed maximum heap does not establish which memory region was exhausted; increasing heap alone may not help.",
                diagnostics: {
                  upstream_operation: name,
                  reason: failure.message ?? null,
                  exception_type: failure.exception_type,
                  target_path: target.path,
                  target_sha256: target.sha256,
                },
              },
            );
          if (failure.kind === "invalid-input")
            throw new AnalysisInputError(request.operation, undefined, [
              {
                path: [failure.field],
                reason: "invalid_value",
                message: failure.message,
              },
            ]);
        }
        throw new ProviderAdapterError("jadx", request.operation, {
          diagnostics: {
            upstream_operation: name,
            reason: envelope.text,
            target_path: target.path,
            target_sha256: target.sha256,
          },
        });
      }
      return envelope.text;
    };
    return {
      text: call,
      json: async (name, input) =>
        parseJadxJson(await call(name, input), request.operation),
    };
  }
}
