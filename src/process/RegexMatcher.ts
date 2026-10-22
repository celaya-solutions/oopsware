import { Worker } from "node:worker_threads";

import { z } from "zod";

import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import { err, ok, type Result } from "../domain/result.js";

const MATCHING_DEADLINE_MS = 5_000;
const WORKER_HEAP_MIB = 128;
/** Shared capability text for the supervised ECMAScript matching boundary. */
export const REGEX_MATCHING_LIMITATION = `Regex mode uses ECMAScript Unicode semantics in a cancellable worker with a ${String(MATCHING_DEADLINE_MS / 1000)}-second matching deadline; matching failure leaves the service available.`;
const replySchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("matched"),
    indices: z.array(z.number().int().nonnegative()),
  }),
  z.strictObject({ status: z.literal("invalid_pattern"), reason: z.string() }),
]);

// Code is constant; caller patterns and target strings cross only workerData.
const WORKER_SOURCE = String.raw`
(async () => {
const { parentPort, workerData } = await import("node:worker_threads");
let expression;
try {
  expression = new RegExp(workerData.pattern, workerData.caseSensitive ? "u" : "iu");
} catch (cause) {
  parentPort.postMessage({ status: "invalid_pattern", reason: cause instanceof Error ? cause.message : String(cause) });
}
if (expression !== undefined) {
  const indices = [];
  for (const [index, value] of workerData.values.entries())
    if (expression.test(value)) indices.push(index);
  parentPort.postMessage({ status: "matched", indices });
}
})();
`;

/** Match an inventory off the service thread, and prove worker exit before returning. */
export const matchRegexValues = async (input: {
  readonly operation: string;
  readonly pattern: string;
  readonly caseSensitive: boolean;
  readonly values: readonly string[];
  readonly signal?: AbortSignal | undefined;
  readonly invalidPattern?: (reason: string) => AnalysisError;
}): Promise<Result<readonly number[], AnalysisError>> => {
  if (input.signal?.aborted)
    return err(new AnalysisCancelledError(input.operation));
  let worker: Worker;
  try {
    worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        pattern: input.pattern,
        caseSensitive: input.caseSensitive,
        values: input.values,
      },
      resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MIB },
    });
  } catch (cause: unknown) {
    return err(
      new AnalysisOutputError(input.operation, "Cannot start regex worker", {
        cause,
      }),
    );
  }
  try {
    return await new Promise((resolve) => {
      let settled = false;
      const finish = (result: Result<readonly number[], AnalysisError>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const onAbort = () =>
        finish(err(new AnalysisCancelledError(input.operation)));
      const timer = setTimeout(
        () =>
          finish(
            err(
              new AnalysisResourceConstraintError(
                input.operation,
                "cpu",
                "Regex matching exceeded its supervised deadline; the service remains available.",
                { matching_deadline_ms: MATCHING_DEADLINE_MS },
                {
                  remediationAction:
                    "Simplify the ECMAScript Unicode regex or use literal mode, then retry in the same session.",
                },
              ),
            ),
          ),
        MATCHING_DEADLINE_MS,
      );
      input.signal?.addEventListener("abort", onAbort, { once: true });
      if (input.signal?.aborted) onAbort();
      worker.once("message", (message: unknown) => {
        const reply = replySchema.safeParse(message);
        if (!reply.success)
          return finish(
            err(
              new AnalysisOutputError(
                input.operation,
                "Regex worker reply is malformed",
              ),
            ),
          );
        if (reply.data.status === "invalid_pattern")
          return finish(
            err(
              input.invalidPattern?.(reply.data.reason) ??
                new AnalysisInputError(input.operation, {
                  userMessage: `Invalid regex pattern: ${reply.data.reason}`,
                }),
            ),
          );
        if (
          reply.data.indices.some(
            (index, position, indices) =>
              index >= input.values.length ||
              (position > 0 && index <= (indices[position - 1] ?? -1)),
          )
        )
          return finish(
            err(
              new AnalysisOutputError(
                input.operation,
                "Regex worker returned invalid inventory indices",
              ),
            ),
          );
        finish(ok(reply.data.indices));
      });
      worker.once("error", (cause: Error & { code?: string }) =>
        finish(
          err(
            cause.code === "ERR_WORKER_OUT_OF_MEMORY"
              ? new AnalysisResourceConstraintError(
                  input.operation,
                  "memory",
                  "Regex worker exhausted its heap budget",
                  { worker_heap_mib: WORKER_HEAP_MIB },
                  { cause },
                )
              : new AnalysisOutputError(
                  input.operation,
                  `Regex worker failed: ${cause.message}`,
                  { cause },
                ),
          ),
        ),
      );
      worker.once("exit", (code) =>
        finish(
          err(
            new AnalysisOutputError(
              input.operation,
              `Regex worker exited without a result (${String(code)})`,
            ),
          ),
        ),
      );
    });
  } finally {
    await worker.terminate();
  }
};
