import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";

import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { err, ok, type Result } from "../domain/result.js";
import { ABORTED, waitForAbortable } from "../process/AbortablePromise.js";
import type { KunaProject } from "./KunaProjectCache.js";
import {
  scanKunaAssembly,
  type KunaAssemblyIndex,
  type KunaProjectFunction,
} from "./KunaProjectFiles.js";
import { KUNA_PROVIDER_ID } from "./KunaRelease.js";
import { KUNA_FUNCTION_TEXT_BYTES } from "./KunaLimits.js";
import { kunaUnavailable } from "./KunaUnavailable.js";

/** The exact producing range for one facet, including a failed C block. */
export interface KunaProjectFileSpan {
  readonly facet: "pseudocode" | "assembly";
  readonly path: string;
  readonly byteOffset: number;
  readonly byteLength: number;
}

export interface KunaProjectText {
  readonly result: string | null;
  readonly files?: readonly KunaProjectFileSpan[];
  readonly limitations: readonly string[];
}

const readSpan = async (
  operation: string,
  path: string,
  offset: number,
  length: number,
): Promise<Result<string, AnalysisError>> => {
  if (length > KUNA_FUNCTION_TEXT_BYTES)
    return err(
      new AnalysisResourceConstraintError(
        operation,
        "capacity",
        "Kuna's function text exceeds the buffered source-facet capacity; the complete export remains accessible locally.",
        {
          limit_bytes: KUNA_FUNCTION_TEXT_BYTES,
          requested_bytes: length,
          file: path,
          byte_offset: offset,
        },
      ),
    );
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    if (bytesRead !== length)
      throw new Error(`${path} is shorter than its recorded span`);
    return ok(buffer.toString("utf8"));
  } finally {
    await handle.close();
  }
};

/** One immutable export owns both its text ranges and its parsed label indexes. */
export class KunaProjectReader {
  #blocks: ReadonlyMap<string, KunaProjectFunction> | undefined;
  #assembly: Promise<Result<KunaAssemblyIndex, string>> | undefined;

  constructor(
    readonly project: KunaProject,
    readonly lifetime: {
      readonly signal: AbortSignal;
      readonly own: <T>(work: Promise<T>) => Promise<T>;
    },
  ) {}

  async pseudocode(
    address: string,
    operation: string,
  ): Promise<Result<KunaProjectText, AnalysisError>> {
    this.#blocks ??= new Map(
      this.project.functions.map((block) => [block.address, block]),
    );
    const block = this.#blocks.get(address);
    if (block === undefined)
      return ok({
        result: null,
        limitations: [
          "Kuna's export decompiles code entries only; this inventory entry, such as an import slot, has no body.",
        ],
      });
    const files = [
      {
        facet: "pseudocode" as const,
        path: this.project.manifest.files.c.path,
        byteOffset: block.cOffset,
        byteLength: block.cLength,
      },
    ];
    if (block.error !== null)
      return ok({
        result: null,
        files,
        limitations: [`Kuna could not decompile this function: ${block.error}`],
      });
    const text = await readSpan(
      operation,
      join(this.project.directory, this.project.manifest.files.c.path),
      block.cOffset,
      block.cLength,
    );
    if (!text.ok) return text;
    return ok({
      result: text.value
        .slice(text.value.indexOf("\n") + 1)
        .replace(/\n+$/u, ""),
      files,
      limitations: [],
    });
  }

  async assembly(
    address: string,
    operation: string,
    signal?: AbortSignal,
  ): Promise<Result<KunaProjectText, AnalysisError>> {
    const index = await this.#index(operation, signal);
    if (!index.ok) return index;
    const span = index.value.code.get(address);
    if (span === undefined)
      return err(
        kunaUnavailable(
          operation,
          `Kuna's export lists no code at ${address}; import slots and data entries have no listing.`,
        ),
      );
    const text = await readSpan(
      operation,
      join(this.project.directory, this.project.manifest.files.asm.path),
      span.offset,
      span.length,
    );
    if (!text.ok) return text;
    return ok({
      result: text.value.replace(/\n+$/u, ""),
      files: [
        {
          facet: "assembly",
          path: this.project.manifest.files.asm.path,
          byteOffset: span.offset,
          byteLength: span.length,
        },
      ],
      limitations: [],
    });
  }

  async dataName(
    address: string,
    operation: string,
    signal?: AbortSignal,
  ): Promise<Result<string | null, AnalysisError>> {
    const index = await this.#index(operation, signal);
    return index.ok ? ok(index.value.data.get(address) ?? null) : index;
  }

  async #index(
    operation: string,
    signal: AbortSignal | undefined,
  ): Promise<Result<KunaAssemblyIndex, AnalysisError>> {
    this.#assembly ??= this.lifetime.own(
      scanKunaAssembly(
        createReadStream(
          join(this.project.directory, this.project.manifest.files.asm.path),
          { signal: this.lifetime.signal },
        ),
      ),
    );
    const index = await waitForAbortable(this.#assembly, signal);
    if (index === ABORTED) return err(new AnalysisCancelledError(operation));
    return index.ok
      ? index
      : err(
          new ProviderAdapterError(KUNA_PROVIDER_ID, operation, {
            userMessage: `Kuna's .asm cannot be indexed: ${index.error}`,
          }),
        );
  }
}
