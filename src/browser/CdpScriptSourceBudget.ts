import { WEB_RUNTIME_LIMITS } from "../domain/webRuntime.js";
import { ProviderStartupDeadline } from "../process/ProviderDeadline.js";

const MIB = 1024 * 1024;

export const CDP_SCRIPT_SOURCE_BYTES_OMISSION_REASON = `script source was omitted because the aggregate ${String(WEB_RUNTIME_LIMITS.sourceBytes / MIB)} MiB source budget was exhausted`;
export const CDP_SCRIPT_SOURCE_DEADLINE_OMISSION_REASON = `script source was omitted because the ${String(WEB_RUNTIME_LIMITS.commandTimeoutMs / 1000)}-second source collection deadline elapsed`;

/** Shared admission for source text retained from passive CDP script reads. */
export class CdpScriptSourceBudget {
  readonly #deadline: ProviderStartupDeadline;
  #retainedBytes = 0;

  constructor(signal?: AbortSignal) {
    this.#deadline = new ProviderStartupDeadline(
      WEB_RUNTIME_LIMITS.commandTimeoutMs,
      signal,
    );
  }

  get signal(): AbortSignal {
    return this.#deadline.signal;
  }

  get timedOut(): boolean {
    return this.#deadline.interruption === "timeout";
  }

  /** Admit exact UTF-8 source bytes before building or retaining its artifact. */
  admit(text: string): boolean {
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > WEB_RUNTIME_LIMITS.sourceBytes - this.#retainedBytes)
      return false;
    this.#retainedBytes += bytes;
    return true;
  }

  dispose(): void {
    this.#deadline.dispose();
  }
}
