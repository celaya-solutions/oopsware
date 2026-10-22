import { z } from "zod";

import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import { analysisStringSchema } from "../domain/hopperValues.js";
import { HopperRemoteError } from "../domain/hopperErrors.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import { analysisSearchInput } from "../contracts/analysisSearchContract.js";
import type { HopperClient } from "./HopperClient.js";
import { matchRegexValues } from "../process/RegexMatcher.js";
import { analysisClientFailureForOperation } from "../providers/AnalysisClientFailure.js";

const inputSchema = z.strictObject({
  ...analysisSearchInput,
  mode: z.literal("regex"),
});
/** Match collected native facts off Hopper's API thread, with cancellable lifetime. */
export class HopperRegexSearch {
  readonly #active = new Map<
    AbortController,
    Promise<Result<JsonValue, AnalysisError>>
  >();

  constructor(private readonly client: Pick<HopperClient, "callTool">) {}

  execute(
    operation: "search_strings" | "search_procedures",
    parameters: Readonly<Record<string, JsonValue>>,
    options?: ExecutionOptions,
  ): Promise<Result<JsonValue, AnalysisError>> {
    const controller = new AbortController();
    const signal =
      options?.signal === undefined
        ? controller.signal
        : AbortSignal.any([controller.signal, options.signal]);
    const pending = this.#execute(operation, parameters, {
      ...options,
      signal,
    });
    this.#active.set(controller, pending);
    void pending.then(
      () => this.#active.delete(controller),
      () => this.#active.delete(controller),
    );
    return pending;
  }

  /** Abort matching workers before their provider session closes. */
  async close(): Promise<void> {
    for (const controller of this.#active.keys()) controller.abort();
    await Promise.all(this.#active.values());
  }

  async #execute(
    operation: "search_strings" | "search_procedures",
    parameters: Readonly<Record<string, JsonValue>>,
    options: ExecutionOptions,
  ): Promise<Result<JsonValue, AnalysisError>> {
    const input = inputSchema.safeParse(parameters);
    if (!input.success)
      return err(
        new HopperRemoteError(
          -32000,
          `Invalid search arguments: ${input.error.message}`,
          { diagnosticType: "invalid_request", operation },
        ),
      );
    const inventoryOptions: ExecutionOptions = {
      ...options,
      ...(options.progress === undefined
        ? {}
        : {
            progress: {
              report: (update) =>
                options.progress?.report({
                  ...update,
                  completed:
                    update.total === null || update.total === 0
                      ? 0
                      : Math.min(0.5, update.completed / update.total / 2),
                  total: 1,
                }) ?? Promise.resolve(),
            },
          }),
    };
    const inventory = await this.client.callTool(
      operation === "search_strings" ? "list_strings" : "list_procedures",
      input.data.document === undefined
        ? {}
        : { document: input.data.document },
      inventoryOptions,
    );
    if (!inventory.ok)
      return err(
        analysisClientFailureForOperation(inventory.error, "hopper", operation),
      );
    const parsed = z.array(analysisStringSchema).safeParse(inventory.value);
    if (!parsed.success)
      return err(
        new AnalysisOutputError(
          operation,
          "Hopper search inventory is malformed",
        ),
      );
    if (options.signal?.aborted)
      return err(
        new AnalysisCancelledError(operation, { cause: options.signal.reason }),
      );
    await options.progress
      ?.report({
        phase: "hopper_regex",
        completed: 0.5,
        total: 1,
        message: "Matching inventory in cancellable regex worker",
      })
      .catch(() => undefined);
    if (options.signal?.aborted)
      return err(
        new AnalysisCancelledError(operation, { cause: options.signal.reason }),
      );
    const matched = await matchRegexValues({
      operation,
      pattern: input.data.pattern,
      caseSensitive: input.data.case_sensitive,
      values: parsed.data.map((item) => item.value),
      signal: options.signal,
      invalidPattern: (reason) =>
        new HopperRemoteError(-32000, `Invalid regex pattern: ${reason}`, {
          diagnosticType: "invalid_request",
          operation,
        }),
    });
    if (!matched.ok) return matched;
    const selected = new Set(matched.value);
    return ok(parsed.data.filter((_, index) => selected.has(index)));
  }
}
