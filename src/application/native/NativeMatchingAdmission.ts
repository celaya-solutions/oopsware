import { setImmediate } from "node:timers/promises";
import { AnalysisResourceConstraintError } from "../../domain/analysisErrorCore.js";

const NATIVE_MATCHING_REPRESENTATION_BYTES = 96 * 1024 * 1024;

/** Budget the actual selected observations, before cloning or index allocation. */
export class NativeMatchingAdmission {
  #remaining = NATIVE_MATCHING_REPRESENTATION_BYTES;
  #work = 0;
  readonly #seen = new WeakSet<object>();
  constructor(
    readonly operation: string,
    readonly signal?: AbortSignal,
  ) {}
  readonly checkpoint = async (bytes = 0): Promise<void> => {
    this.#remaining -= bytes;
    if (this.#remaining < 0)
      throw new AnalysisResourceConstraintError(
        this.operation,
        "capacity",
        "Native function matching exceeds representation capacity",
        { maximum_bytes: NATIVE_MATCHING_REPRESENTATION_BYTES },
      );
    this.signal?.throwIfAborted();
    if (++this.#work % 256 === 0)
      await setImmediate(
        undefined,
        this.signal === undefined ? {} : { signal: this.signal },
      );
  };
  async admit(root: unknown): Promise<void> {
    const pending: Iterator<unknown>[] = [[root][Symbol.iterator]()];
    while (pending.length) {
      const next = pending[pending.length - 1]!.next();
      if (next.done) {
        pending.pop();
        continue;
      }
      const value = next.value;
      if (typeof value === "object" && value !== null) {
        if (this.#seen.has(value)) continue;
        this.#seen.add(value);
        await this.checkpoint(128);
        // Iterator traversal avoids a second width-sized array of child values.
        pending.push(
          (function* () {
            for (const key in value)
              if (Object.hasOwn(value, key)) {
                yield key;
                yield (value as Record<string, unknown>)[key];
              }
          })(),
        );
      } else
        await this.checkpoint(
          typeof value === "string" ? 64 + value.length * 4 : 128,
        );
    }
  }
}
