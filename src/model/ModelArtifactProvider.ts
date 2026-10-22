import { lstat, type FileHandle } from "node:fs/promises";
import type { ModelArtifactPort } from "../application/model/ModelArtifactPort.js";
import { createModelArtifactEvidence } from "../application/model/ModelArtifactEvidence.js";
import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import type {
  ModelArtifact,
  ModelArtifactInput,
} from "../domain/model/modelArtifact.js";
import { modelArtifactSchema } from "../domain/model/modelArtifact.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisArtifactChangedError,
  AnalysisAccessDeniedError,
  AnalysisCancelledError,
  AnalysisResourceConstraintError,
  AnalysisUnsupportedTargetError,
} from "../domain/analysisErrorCore.js";
import { BinaryTargetError } from "../domain/configurationErrors.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { err, ok, type Result } from "../domain/result.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import {
  withArtifactRegularFile,
  bindArtifactFileCleanup,
  artifactFilePrimaryFailure,
  artifactFileCancellationCause,
  ArtifactFileCancelled,
  ArtifactFileCleanupFailure,
} from "../artifacts/ArtifactFileOperation.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { ModelHeaderReader } from "./ModelHeaderReader.js";
import { GgufHeader } from "./GgufHeader.js";
import { readSafetensorsHeader } from "./SafetensorsHeader.js";
import {
  ModelFormatFailure,
  rejectModel,
  MODEL_REPORT_BYTES,
  MODEL_HEADER_BYTES,
} from "./ModelFormat.js";
import { safetensorsBits } from "./ModelTensorTypes.js";
import { jsonValueByteLength } from "../domain/jsonValueByteLength.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { sameRegularFileState } from "../filesystem/RegularFile.js";

export const MODEL_ARTIFACT_PROVIDER_IDENTITY = {
  id: "model-artifact",
  name: "REA model header reader",
  version: "1",
} as const;
const OPERATION = "inspect_model_artifact";

/** One admitted descriptor and bounded report at a time; retained cleanup blocks new work. */
export class ModelArtifactProvider implements ModelArtifactPort {
  readonly identity = MODEL_ARTIFACT_PROVIDER_IDENTITY;
  readonly #resources = new ArtifactResourceScope();
  #busy = false;

  async close(): Promise<void> {
    try {
      await this.#resources.close();
    } catch (cause) {
      const error = new ProviderCleanupError(
        this.identity.id,
        this.#resources.cleanupResources,
        {},
        { cause, operation: OPERATION },
      );
      bindArtifactFileCleanup(cause, error);
      throw error;
    }
  }

  async inspect(
    input: ModelArtifactInput,
    options?: ExecutionOptions,
  ): Promise<Result<ModelArtifact, AnalysisError>> {
    if (this.#busy)
      return err(
        new AnalysisResourceConstraintError(
          OPERATION,
          "capacity",
          "One model inspection is already active",
          { concurrent_inspections: 1 },
          { retryable: true },
        ),
      );
    this.#busy = true;
    try {
      return ok(
        await this.#resources.run(() =>
          withArtifactRegularFile(
            input.path,
            this.#resources,
            options?.signal,
            (file) => this.#read(file, input, options?.signal),
          ),
        ),
      );
    } catch (cause) {
      const primary = artifactFilePrimaryFailure(cause);
      let error: AnalysisError;
      if (primary instanceof AnalysisError) error = primary;
      else if (primary instanceof ModelFormatFailure) {
        error =
          primary.kind === "capacity"
            ? new AnalysisResourceConstraintError(
                OPERATION,
                "memory",
                primary.message,
                {
                  maximum_report_bytes: MODEL_REPORT_BYTES,
                  maximum_header_bytes: MODEL_HEADER_BYTES,
                  maximum_exact_offset: Number.MAX_SAFE_INTEGER,
                },
                { cause, retryable: false },
              )
            : primary.kind === "unsupported"
              ? new AnalysisUnsupportedTargetError(
                  OPERATION,
                  input.path,
                  primary.message,
                  { cause },
                )
              : new BinaryTargetError(input.path, primary.message, {
                  cause,
                  constraint: "file_format_rejected",
                });
      } else if (
        primary instanceof ArtifactReaderFailure &&
        primary.reason === "cancelled"
      )
        error = new AnalysisCancelledError(OPERATION, {
          cause: artifactFileCancellationCause(primary),
        });
      else if (primary instanceof ArtifactFileCancelled)
        error = new AnalysisCancelledError(OPERATION, {
          cause: primary.fileCancellation.reason,
        });
      else if (
        primary instanceof ArtifactReaderFailure &&
        primary.reason === "integrity"
      )
        error = new AnalysisArtifactChangedError(
          OPERATION,
          input.path,
          primary.message,
          { cause },
        );
      else if (
        primary instanceof Error &&
        "code" in primary &&
        (primary.code === "EACCES" || primary.code === "EPERM")
      )
        error = new AnalysisAccessDeniedError(
          OPERATION,
          input.path,
          primary.code,
          { cause: primary },
        );
      else if (
        primary instanceof ArtifactReaderFailure &&
        primary.reason === "limit"
      )
        error = new AnalysisResourceConstraintError(
          OPERATION,
          "memory",
          primary.message,
          {},
          { cause: primary },
        );
      else if (primary instanceof Error && "code" in primary)
        error = new BinaryTargetError(input.path, primary.message, { cause });
      else
        error = new ProviderAdapterError(this.identity.id, OPERATION, {
          cause,
          diagnostics: {
            path: input.path,
            reason:
              primary instanceof Error ? primary.message : String(primary),
          },
        });
      if (
        cause instanceof ArtifactReaderFailure &&
        cause.cleanup !== undefined
      ) {
        const cleanup = new ProviderCleanupError(
          this.identity.id,
          cause.cleanup.resources,
          { reason: cause.cleanup.reason },
          { cause, operation: OPERATION },
        );
        error = analysisErrorWithCleanupFailure(error, cleanup, OPERATION);
      }
      const completed =
        cause instanceof ArtifactFileCleanupFailure &&
        cause.fileCleanupFailure.outcome.kind === "completed"
          ? cause.fileCleanupFailure.outcome.value
          : cause instanceof ArtifactFileCancelled
            ? cause.fileCancellation.outcome.value
            : undefined;
      if (completed !== undefined) {
        // The descriptor owner retains observations even when its final close fails.
        const report = modelArtifactSchema.safeParse(completed);
        if (report.success)
          error.retainPartialObservation(
            createModelArtifactEvidence(report.data, this.identity, input),
          );
      }
      bindArtifactFileCleanup(cause, error);
      return err(error);
    } finally {
      this.#busy = false;
    }
  }

  async #read(
    file: FileHandle,
    input: ModelArtifactInput,
    signal?: AbortSignal,
  ): Promise<ModelArtifact> {
    const initial = await file.stat({ bigint: true });
    if (initial.size > BigInt(Number.MAX_SAFE_INTEGER))
      throw new ModelFormatFailure(
        "capacity",
        "Model file exceeds exact host offset precision",
      );
    const reader = new ModelHeaderReader(file, Number(initial.size), signal);
    const first = await reader.take(4);
    if (
      (first[0] === 0x80 && (first[1] ?? 0) >= 2 && (first[1] ?? 0) <= 5) ||
      first.equals(Buffer.from([0x50, 0x4b, 3, 4]))
    )
      throw new ModelFormatFailure(
        "unsupported",
        "PyTorch pickle/ZIP model deserialization is unsupported; supply GGUF or safetensors instead",
      );
    const format = first.equals(Buffer.from("GGUF")) ? "gguf" : "safetensors";
    const parsed =
      format === "gguf"
        ? await new GgufHeader(reader).read()
        : await readSafetensorsHeader(reader, first);
    const intervals = parsed.tensors
      .filter((row) => row.byte_length !== null)
      .sort((a, b) => a.file_offset - b.file_offset);
    let end = parsed.tensor_data_offset;
    for (const row of intervals) {
      if (row.file_offset < end && row.byte_length !== 0)
        rejectModel(`Overlapping tensor byte ranges at ${row.name}`);
      end = Math.max(end, row.file_offset + (row.byte_length ?? 0));
    }
    const header_length = reader.position;
    const hashes = await reader.finish(input.hash === "full");
    const after = await file.stat({ bigint: true });
    const named = await lstat(input.path, { bigint: true }).catch(
      (cause: unknown) => {
        if (
          cause instanceof Error &&
          "code" in cause &&
          ["ENOENT", "ENOTDIR", "ELOOP"].includes(String(cause.code))
        )
          throw new ArtifactReaderFailure(
            "integrity",
            "Selected model path changed during inspection",
            { cause },
          );
        throw cause;
      },
    );
    if ([after, named].some((stat) => !sameRegularFileState(initial, stat)))
      throw new ArtifactReaderFailure(
        "integrity",
        "Model file changed during inspection",
      );
    const groups = new Map<
      string,
      {
        type: string;
        tensors: number;
        parameter_count: bigint;
        bytes: number | null;
      }
    >();
    let parameters = 0n;
    let bytes: number | null = 0;
    for (const row of parsed.tensors) {
      const count = BigInt(row.parameter_count);
      parameters += count;
      bytes =
        bytes === null || row.byte_length === null
          ? null
          : bytes + row.byte_length;
      const group = groups.get(row.type) ?? {
        type: row.type,
        tensors: 0,
        parameter_count: 0n,
        bytes: 0,
      };
      group.tensors++;
      group.parameter_count += count;
      group.bytes =
        group.bytes === null || row.byte_length === null
          ? null
          : group.bytes + row.byte_length;
      groups.set(row.type, group);
    }
    const unknownTypes = [
      ...new Set(
        parsed.tensors
          .filter(
            (row) =>
              row.byte_length === null ||
              (format === "safetensors" &&
                safetensorsBits(row.type) === undefined),
          )
          .map((row) => row.type),
      ),
    ];
    const report = {
      artifact: {
        path: input.path,
        file_size: Number(initial.size),
        header_length,
        ...hashes,
        read_scope:
          input.hash === "full" ? ("full-file" as const) : ("header" as const),
      },
      format,
      ...parsed,
      totals: {
        confidence: "derived" as const,
        parameter_count: parameters.toString(),
        tensor_bytes: bytes,
        by_type: [...groups.values()].map((group) => ({
          ...group,
          parameter_count: group.parameter_count.toString(),
        })),
      },
      coverage: {
        header: "complete" as const,
        tensor_data: "not-interpreted" as const,
        array_values: parsed.metadata.every((row) => row.preview_complete)
          ? ("complete" as const)
          : ("preview" as const),
        storage_sizes: parsed.tensors.every(
          (row) => row.storage_validation === "consistent",
        )
          ? ("complete" as const)
          : ("partial" as const),
        tensor_ranges: parsed.tensors.every((row) => row.byte_length !== null)
          ? ("complete" as const)
          : ("partial" as const),
      },
      limitations: [
        "Facts are file declarations; model behavior, weight values and compatibility with an inference runtime were not verified.",
        "Header SHA-256 commits only to the recorded prefix; file size is a separate observation. Different weights may share these declarations.",
        ...(input.hash === "header"
          ? ["Full-file SHA-256 is unknown because tensor data was not read."]
          : [
              "Full-file SHA-256 required streaming the entire file, including tensor data, without interpreting it.",
            ]),
        ...(parsed.metadata.some((row) => !row.preview_complete)
          ? [
              "Metadata arrays retain at most eight elements per array; remaining values are omitted, with exact declared counts and source byte ranges.",
            ]
          : []),
        ...(unknownTypes.length
          ? [
              `Unknown tensor types prevent storage-size validation: ${unknownTypes.join(", ")}`,
            ]
          : []),
      ],
    };
    if (jsonValueByteLength(report, MODEL_REPORT_BYTES) > MODEL_REPORT_BYTES)
      throw new ModelFormatFailure("capacity", "Model report exceeds 32 MiB");
    return modelArtifactSchema.parse(report);
  }
}
