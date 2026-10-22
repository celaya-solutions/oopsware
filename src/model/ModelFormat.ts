/** Format failures stay separate from filesystem, capacity and cancellation failures. */
export class ModelFormatFailure extends Error {
  constructor(
    readonly kind: "format" | "unsupported" | "capacity",
    message: string,
  ) {
    super(message);
    this.name = "ModelFormatFailure";
  }
}

export function rejectModel(message: string): never {
  throw new ModelFormatFailure("format", message);
}

// Safetensors' format ceiling is 100,000,000 bytes. The reader additionally
// bounds retained rows/text independently of that input ceiling.
export const MODEL_HEADER_BYTES = 100_000_000;
export const MODEL_REPORT_BYTES = 32 * 1024 * 1024;
export const MODEL_ARRAY_PREVIEW = 8;

/** Charge representation growth before retaining rows or decoding long strings. */
export class ModelReportBudget {
  #remaining = MODEL_REPORT_BYTES;
  charge(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.#remaining)
      throw new ModelFormatFailure(
        "capacity",
        "Model facts exceed the 32 MiB retained representation budget",
      );
    this.#remaining -= bytes;
  }
}
