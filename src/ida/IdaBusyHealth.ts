import { setTimeout as sleep } from "node:timers/promises";
import { AnalysisTimeoutError } from "../domain/analysisErrorCore.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { IdaMcpConnection } from "./IdaMcpConnection.js";
import { busyHealthSchema } from "./IdaProtocolValues.js";

/** Pause between health reads while a freshly opened worker reports itself busy. */
const BUSY_HEALTH_RETRY_MS = 100;
/** Only a tool-name-shaped value is repeated; other producer text is not echoed into errors. */
const BUSY_TOOL_NAME = /^[A-Za-z0-9_.:-]{1,64}$/u;

/** Time source and pause used by the wait; tests substitute a virtual clock. */
export interface BusyHealthClock {
  now(): number;
  delay(ms: number, signal: AbortSignal | undefined): Promise<void>;
}

const monotonicClock: BusyHealthClock = {
  now: () => performance.now(),
  delay: (ms, signal) => sleep(ms, undefined, { signal }),
};

const busyToolName = (tool: string | undefined): string =>
  tool !== undefined && BUSY_TOOL_NAME.test(tool) ? tool : "unknown";

const isBusyStatus = (raw: JsonValue): boolean =>
  typeof raw === "object" &&
  raw !== null &&
  !Array.isArray(raw) &&
  raw["status"] === "busy";

interface LastBusyHealth {
  readonly raw: JsonValue;
  readonly operation: string;
}

/**
 * Reads `server_health` until the worker stops reporting a transient busy
 * state. The wait ends when the worker answers, the caller aborts, or the
 * registration's request deadline has elapsed; once it has elapsed no further
 * read is started and the last busy observation is reported. Any other payload
 * is returned for the caller's strict parse, except an invalid busy payload,
 * which keeps its own diagnostic.
 */
export const readSettledHealth = async (
  connection: IdaMcpConnection,
  {
    database,
    timeoutMs,
    signal,
    clock = monotonicClock,
  }: {
    readonly database: string;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal | undefined;
    readonly clock?: BusyHealthClock;
  },
): Promise<JsonValue> => {
  const started = clock.now();
  const remaining = (): number => timeoutMs - (clock.now() - started);
  let lastBusy: LastBusyHealth | undefined;
  for (;;) {
    const budgetMs = remaining();
    if (budgetMs <= 0)
      throw lastBusy === undefined
        ? new AnalysisTimeoutError("server_health", timeoutMs)
        : busyTimeout(lastBusy, timeoutMs);
    const requestTimeoutMs = Math.min(timeoutMs, Math.ceil(budgetMs));
    let raw: JsonValue;
    try {
      raw = await connection.call(
        "server_health",
        { database },
        { timeoutMs: requestTimeoutMs },
      );
    } catch (cause: unknown) {
      if (
        lastBusy !== undefined &&
        cause instanceof AnalysisTimeoutError &&
        cause.timeoutMs === requestTimeoutMs &&
        requestTimeoutMs < timeoutMs
      ) {
        throw new AnalysisTimeoutError(lastBusy.operation, timeoutMs, {
          cause: lastBusy.raw,
          capturedOutput: cause.capturedOutput,
          diagnostics: {
            health_request_operation: cause.operation,
            health_request_timeout_ms: cause.timeoutMs,
          },
        });
      }
      throw cause;
    }
    const busy = busyHealthSchema.safeParse(raw);
    if (!busy.success) {
      if (isBusyStatus(raw)) throw busy.error;
      return raw;
    }
    const observedBusy = {
      raw,
      operation: `server_health: headless worker still busy in ${busyToolName(busy.data.busy_tool)}`,
    };
    lastBusy = observedBusy;
    const expired = (): AnalysisTimeoutError =>
      busyTimeout(observedBusy, timeoutMs);
    if (remaining() <= 0) throw expired();
    await clock.delay(Math.min(BUSY_HEALTH_RETRY_MS, remaining()), signal);
    signal?.throwIfAborted();
    if (remaining() <= 0) throw expired();
  }
};

const busyTimeout = (
  lastBusy: LastBusyHealth,
  timeoutMs: number,
): AnalysisTimeoutError =>
  new AnalysisTimeoutError(lastBusy.operation, timeoutMs, {
    cause: lastBusy.raw,
  });
