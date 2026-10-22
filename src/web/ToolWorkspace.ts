import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { CallToolResultSchema } from "@modelcontextprotocol/core";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { parseConfig } from "../config/parseConfig.js";
import { createBinarySession } from "../composition/binary.js";
import {
  createOptionalObservationFactories,
  loadOptionalObservationProviders,
} from "../composition/optionalObservationProviders.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { silentLogger } from "../logger.js";
import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import { createServer } from "../server/createServer.js";
import { createToolResultDelivery } from "../server/toolResult.js";
import { TOOL_CONTRACTS, toolContract } from "../contracts/toolContracts.js";
import { createDirectAnalysis } from "../composition/directAnalysis.js";
import { jsonObjectSchema } from "../domain/jsonValue.js";
import { parseEvidence } from "../domain/evidence.js";
import { ok } from "../domain/result.js";
import { analysisCliErrorEnvelopeSchema } from "../contracts/errorSchemas.js";
import {
  RunHistory,
  runSchema,
  type WebToolRun,
  type WebRunSummary,
} from "./RunHistory.js";
import { WebFailure } from "./WebFailure.js";
import {
  redactWebRunValue,
  redactWebToolResult,
  webRunSensitiveValues,
} from "./WebRunPrivacy.js";

const uuid = z.uuid();
const inputSchema = z.strictObject({
  tool: z.string(),
  arguments: z.record(z.string(), z.unknown()),
  targetPath: z
    .string()
    .refine(isAbsolute, "targetPath must be an absolute local path")
    .optional(),
});
const failure = (message: string): CallToolResult => ({
  isError: true,
  content: [{ type: "text", text: message }],
});
const message = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

const connect = async (environment: Readonly<NodeJS.ProcessEnv>) => {
  const config = parseConfig(environment);
  if (!config.ok) throw new Error(projectAnalysisError(config.error).message);
  const session = createBinarySession(config.value, silentLogger, environment);
  const optional = await loadOptionalObservationProviders(
    createOptionalObservationFactories(environment),
  );
  const server = createServer(
    { kind: "session", session },
    {
      environment,
      logger: silentLogger,
      ...optional,
      delivery: createToolResultDelivery(config.value.mcpMaxResponseBytes),
    },
  );
  const client = new Client({ name: "rea-web-workspace", version: "1" });
  const close = async () => {
    const results = await Promise.allSettled([
      client.close(),
      server.close(),
      session.close(),
    ]);
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    const binary = results[2];
    if (binary?.status === "fulfilled" && binary.value && !binary.value.ok)
      errors.push(projectAnalysisError(binary.value.error).message);
    if (errors.length)
      throw new AggregateError(errors, "Workspace cleanup failed");
  };
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b);
    await client.connect(a);
    return {
      client,
      close,
      expectToolExecution: (token: string) => server.expectToolExecution(token),
      waitForToolExecution: (token: string) =>
        server.waitForToolExecution(token),
      inspectArtifact: async (
        targetPath: string,
        arguments_: Record<string, unknown>,
        signal: AbortSignal,
      ): Promise<CallToolResult> => {
        const contract = toolContract("inspect_artifact");
        const output = await createDirectAnalysis(
          environment,
        ).runProviderAnalysis(
          targetPath,
          "inspect_artifact",
          jsonObjectSchema.parse(arguments_),
          silentLogger,
          signal,
        );
        if (analysisCliErrorEnvelopeSchema.safeParse(output).success) {
          return {
            ...server.delivery.toCallToolResult(ok(output), contract),
            isError: true,
          };
        }
        const evidence = parseEvidence(output);
        return server.delivery.toEvidenceToolResult(
          evidence,
          contract,
          session.recordEvidence(evidence),
        );
      },
    };
  } catch (cause) {
    await close();
    throw cause;
  }
};
type Connection = Awaited<ReturnType<typeof connect>>;
interface WorkspaceState {
  id: string;
  runs: WebRunSummary[];
  live: Map<string, WebToolRun>;
  connection?: Promise<Connection>;
  writes: Promise<void>;
}

/** Own independent MCP sessions and durable history for browser tabs. */
export class ToolWorkspace {
  private readonly states = new Map<string, Promise<WorkspaceState>>();
  private readonly active = new Map<
    string,
    { controller: AbortController; done: Promise<void> }
  >();
  private readonly environment: Readonly<NodeJS.ProcessEnv>;
  private closed = false;
  private readonly history: RunHistory;
  /** Per-run callbacks told once after a run's final state is saved. */
  private readonly observers = new Map<string, (run: WebToolRun) => void>();
  constructor(directory: string, environment: Readonly<NodeJS.ProcessEnv>) {
    this.environment = snapshotEnvironment(environment);
    this.history = new RunHistory(directory);
  }
  private settled(run: WebToolRun) {
    const observer = this.observers.get(run.id);
    this.observers.delete(run.id);
    try {
      observer?.(run);
    } catch (cause) {
      silentLogger.error(
        { error: message(cause) },
        "Web run settle observer failed",
      );
    }
  }
  /** Create or reconnect a tab. Unknown caller-selected IDs cannot create files. */
  async workspace(input: unknown) {
    const { id } = z.strictObject({ id: uuid.optional() }).parse(input);
    if (this.closed)
      throw new WebFailure(503, "closing", "Oopsware is shutting down.");
    const selected = id ?? randomUUID();
    const state = await this.state(selected, id === undefined);
    return this.history.page(state.id, state.runs, {});
  }
  private async state(id: string, create = false): Promise<WorkspaceState> {
    uuid.parse(id);
    let state = this.states.get(id);
    if (!state) {
      state = this.load(id, create);
      this.states.set(id, state);
      void state.catch(() => this.states.delete(id));
    }
    return state;
  }
  /** Read session status without recording a background check as an analysis run. */
  async session(id: string) {
    if (this.closed)
      throw new WebFailure(503, "closing", "Oopsware is shutting down.");
    const state = await this.state(id);
    if (this.closed)
      throw new WebFailure(503, "closing", "Oopsware is shutting down.");
    state.connection ??= connect(this.environment).catch((cause) => {
      delete state.connection;
      throw cause;
    });
    const connection = await state.connection;
    if (this.closed)
      throw new WebFailure(503, "closing", "Oopsware is shutting down.");
    return {
      result: CallToolResultSchema.parse(
        await connection.client.callTool({
          name: "binary_session",
          arguments: {},
        }),
      ),
    };
  }
  private async load(id: string, create: boolean): Promise<WorkspaceState> {
    const runs = await this.history.load(id, create);
    const state: WorkspaceState = {
      id,
      runs,
      live: new Map(),
      writes: Promise.resolve(),
    };
    // Recover only formerly live jobs. Completed evidence stays on disk.
    for (const summary of runs) {
      if (summary.status !== "running" && summary.status !== "queued") continue;
      let run: WebToolRun;
      try {
        run = await this.history.read(id, summary.id);
      } catch {
        // A damaged run must not prevent reading other runs or overwrite evidence.
        summary.status = "failed";
        summary.completedAt = new Date().toISOString();
        await this.history.writeIndex(
          id,
          JSON.stringify({ version: 1, id, runs }),
        );
        continue;
      }
      if (run.status === "running" || run.status === "queued") {
        run.status = "failed";
        run.completedAt = new Date().toISOString();
        run.error =
          "Oopsware restarted before this run finished. The saved run is not a live job; retry explicitly.";
        run.result = failure(run.error);
      }
      await this.save(state, run);
    }
    return state;
  }
  private save(state: WorkspaceState, run: WebToolRun): Promise<void> {
    const summary = this.history.summary(run);
    const index = state.runs.findIndex((candidate) => candidate.id === run.id);
    if (index < 0) state.runs.push(summary);
    else state.runs[index] = summary;
    state.live.set(run.id, run);
    const serialized = JSON.stringify(run);
    const summaries = JSON.stringify({
      version: 1,
      id: state.id,
      runs: state.runs,
    });
    const write = state.writes
      .catch(() => undefined)
      .then(async () => {
        await this.history.writeRun(state.id, run.id, serialized);
        await this.history.writeIndex(state.id, summaries);
        if (run.status !== "running" && run.status !== "queued")
          state.live.delete(run.id);
      });
    state.writes = write;
    return write;
  }
  /** List a bounded page of summaries, newest first, without reading results. */
  async listRuns(id: string, input: unknown) {
    const state = await this.state(id);
    return this.history.page(id, state.runs, input);
  }
  /** Read live status without loading or transmitting full evidence. */
  async getSummary(id: string, runId: string) {
    uuid.parse(runId);
    const state = await this.state(id);
    const run = state.live.get(runId);
    const summary = run
      ? this.history.summary(run)
      : state.runs.find((candidate) => candidate.id === runId);
    if (!summary)
      throw new WebFailure(
        404,
        "run_not_found",
        "This run does not belong to this workspace.",
      );
    return { run: summary };
  }
  /** Validate at the canonical boundary and return a durable job immediately. */
  /** Start a run; `onSettled` (if given) is attached before it can finish and never fails it. */
  async run(id: string, input: unknown, onSettled?: (run: WebToolRun) => void) {
    if (this.closed)
      throw new WebFailure(503, "closing", "Oopsware is shutting down.");
    const parsed = inputSchema.parse(input);
    const contract = TOOL_CONTRACTS.find((tool) => tool.name === parsed.tool);
    if (!contract)
      throw new WebFailure(
        400,
        "unknown_tool",
        `Unknown Oopsware tool: ${parsed.tool}`,
      );
    contract.inputSchema.parse(parsed.arguments);
    if (parsed.targetPath !== undefined && parsed.tool !== "inspect_artifact") {
      throw new WebFailure(
        400,
        "invalid_target_path",
        "targetPath is supported only for inspect_artifact.",
      );
    }
    const state = await this.state(id);
    const sensitive = webRunSensitiveValues(
      parsed.tool,
      parsed.arguments,
      this.environment,
    );
    const safeArguments = z
      .record(z.string(), z.unknown())
      .parse(redactWebRunValue(parsed.arguments, sensitive));
    if (
      parsed.tool === "capture_process_scenario" &&
      Array.isArray(parsed.arguments.events)
    ) {
      safeArguments.events = parsed.arguments.events.map((value) => {
        const event = z.record(z.string(), z.unknown()).parse(value);
        return {
          ...z
            .record(z.string(), z.unknown())
            .parse(redactWebRunValue(event, sensitive)),
          type: event.type,
        };
      });
    }
    const run: WebToolRun = {
      id: randomUUID(),
      ...parsed,
      arguments: safeArguments,
      status: "queued",
      createdAt: new Date().toISOString(),
    };
    if (onSettled) this.observers.set(run.id, onSettled);
    try {
      await this.save(state, run);
    } catch (cause) {
      this.observers.delete(run.id);
      state.runs = state.runs.filter((candidate) => candidate.id !== run.id);
      state.live.delete(run.id);
      throw cause;
    }
    const controller = new AbortController();
    if (this.closed) controller.abort(new Error("Oopsware is shutting down"));
    const done = this.execute(state, run, {
      controller,
      arguments_: parsed.arguments,
      sensitive,
    })
      .catch((cause: unknown) => {
        run.status = controller.signal.aborted ? "cancelled" : "failed";
        run.completedAt = new Date().toISOString();
        run.error =
          "Run finalization failed. The operation has stopped; retry explicitly.";
        run.result = failure(run.error);
        state.live.set(run.id, run);
        const index = state.runs.findIndex(
          (candidate) => candidate.id === run.id,
        );
        if (index >= 0) state.runs[index] = this.history.summary(run);
        silentLogger.error(
          { error: message(cause) },
          "Web run finalization failed",
        );
        this.settled(run);
      })
      .finally(() => this.active.delete(run.id));
    this.active.set(run.id, { controller, done });
    return { run };
  }
  private async execute(
    state: WorkspaceState,
    run: WebToolRun,
    {
      controller,
      arguments_,
      sensitive,
    }: {
      controller: AbortController;
      arguments_: Record<string, unknown>;
      sensitive: readonly string[];
    },
  ) {
    let connection: Connection | undefined;
    try {
      controller.signal.throwIfAborted();
      state.connection ??= connect(this.environment).catch((cause) => {
        delete state.connection;
        throw cause;
      });
      connection = await state.connection;
      controller.signal.throwIfAborted();
      run.status = "running";
      run.startedAt = new Date().toISOString();
      await this.save(state, run);
      if (run.targetPath === undefined) connection.expectToolExecution(run.id);
      run.result =
        run.targetPath !== undefined
          ? await connection.inspectArtifact(
              run.targetPath,
              arguments_,
              controller.signal,
            )
          : await connection.client.callTool(
              {
                name: run.tool,
                arguments: arguments_,
                _meta: { "rea.local_execution": run.id },
              },
              {
                signal: controller.signal,
                // Oopsware operations own their deadlines. Avoid the SDK's short default.
                timeout: 24 * 60 * 60 * 1000,
                onprogress: (update) => {
                  run.progress = runSchema.shape.progress.parse(
                    redactWebRunValue(update, sensitive),
                  );
                },
              },
            );
      run.status = controller.signal.aborted
        ? "cancelled"
        : run.result.isError
          ? "failed"
          : "completed";
    } catch (cause) {
      run.status = controller.signal.aborted ? "cancelled" : "failed";
      run.error = message(cause);
      run.result ??= failure(run.error);
    }
    const terminalStatus = run.status;
    run.status = "running";
    // MCP abort rejects the client immediately. Handler settlement is the
    // authority for Stop: providers may still be releasing owned resources.
    const settled = await connection?.waitForToolExecution(run.id);
    if (controller.signal.aborted && settled?.result)
      run.result = settled.result;
    if (controller.signal.aborted && settled?.error !== undefined) {
      run.error = message(settled.error);
      run.result = failure(run.error);
    }
    run.status = terminalStatus;
    try {
      if (run.result)
        run.result = CallToolResultSchema.parse(
          redactWebToolResult(run.result, sensitive),
        );
      if (run.error)
        run.error = z.string().parse(redactWebRunValue(run.error, sensitive));
    } catch {
      run.status = "failed";
      run.error =
        "The operation stopped, but its result could not be safely prepared. Retry explicitly.";
      run.result = failure(run.error);
    }
    run.completedAt = new Date().toISOString();
    try {
      await this.save(state, run);
    } catch (cause) {
      run.error = `History could not be saved: ${message(cause)}`;
    }
    this.settled(run);
  }
  /** Read one run only within its owning workspace. */
  async getRun(id: string, runId: string) {
    uuid.parse(runId);
    const state = await this.state(id);
    const summary = state.runs.find((candidate) => candidate.id === runId);
    if (!summary)
      throw new WebFailure(
        404,
        "run_not_found",
        "This run does not belong to this workspace.",
      );
    return {
      run: state.live.get(runId) ?? (await this.history.read(id, runId)),
    };
  }
  /** Forward Stop to MCP and preserve the terminal result. */
  async cancel(id: string, runId: string) {
    await this.getSummary(id, runId);
    const active = this.active.get(runId);
    if (active) {
      active.controller.abort(new Error("Stopped by the user"));
      await active.done;
    }
    return this.getRun(id, runId);
  }
  /** Stop jobs and release every MCP and binary-provider session. */
  async close() {
    this.closed = true;
    for (const active of this.active.values())
      active.controller.abort(new Error("Oopsware is shutting down"));
    await Promise.allSettled(
      [...this.active.values()].map((active) => active.done),
    );
    const results = await Promise.allSettled(
      [...this.states.values()].map(async (pending) => {
        const state = await pending;
        if (state.connection) await (await state.connection).close();
        await state.writes;
      }),
    );
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length)
      throw new AggregateError(errors, "Workspace shutdown failed");
  }
}
