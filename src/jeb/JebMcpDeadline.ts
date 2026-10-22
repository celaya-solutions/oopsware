import { SdkError, SdkErrorCode } from "@modelcontextprotocol/client";
import {
  AnalysisCancelledError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import { ProviderStartupDeadline } from "../process/ProviderDeadline.js";

/** SDK 2.3.1 preserves an SdkError abort reason by identity. */
export class JebMcpDeadline {
  readonly #deadline: ProviderStartupDeadline;
  readonly #controller = new AbortController();
  readonly #interruption = new SdkError(
    SdkErrorCode.RequestTimeout,
    "JEB MCP interrupted",
  );
  readonly #onAbort = (): void => this.#controller.abort(this.#interruption);

  constructor(
    readonly timeoutMs: number,
    signal?: AbortSignal,
  ) {
    this.#deadline = new ProviderStartupDeadline(timeoutMs, signal);
    if (this.#deadline.signal.aborted) this.#onAbort();
    else
      this.#deadline.signal.addEventListener("abort", this.#onAbort, {
        once: true,
      });
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }
  remainingMs(): number {
    return this.#deadline.remainingMs();
  }

  /** Classify only the rejection produced by this deadline's exact abort. */
  failure(operation: string, cause: unknown): unknown {
    if (cause === this.#interruption) {
      return this.#deadline.interruption === "timeout"
        ? new AnalysisTimeoutError(operation, this.timeoutMs, {
            cause: this.#deadline.signal.reason,
          })
        : new AnalysisCancelledError(operation, {
            cause: this.#deadline.signal.reason,
          });
    }
    if (cause instanceof SdkError && cause.code === SdkErrorCode.RequestTimeout)
      return new AnalysisTimeoutError(operation, this.timeoutMs, { cause });
    return cause;
  }

  dispose(): void {
    this.#deadline.signal.removeEventListener("abort", this.#onAbort);
    this.#deadline.dispose();
  }
}
