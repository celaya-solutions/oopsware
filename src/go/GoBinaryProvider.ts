import { readStableArtifact } from "../artifacts/readStableArtifact.js";
import {
  ArtifactFileCleanupFailure,
  assertArtifactReadActive,
  bindArtifactFileCleanup,
  artifactFileCancellationCause,
} from "../artifacts/ArtifactFileOperation.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import type { GoBinaryPort } from "../application/go/GoBinaryPort.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
  AnalysisUnsupportedTargetError,
} from "../domain/analysisErrorCore.js";
import {
  goBinarySchema,
  type GoBinary,
  type GoModuleMetadata,
  type InspectGoBinaryInput,
} from "../domain/go/goBinary.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  readGoBinaryImage,
  GoBinaryFormatFailure,
  GoBinaryResourceFailure,
} from "./GoBinaryImage.js";
import { parseGoModuleBytes, parseGoModuleText } from "./GoModuleText.js";

/** Bundled format reader identity; embedded compiler versions are separate observed facts. */
export const GO_BINARY_PROVIDER_IDENTITY = {
  id: "go-build-info",
  name: "REA Go build-information reader",
  version: "1",
} as const;
const OPERATION = "inspect_go_binary";
const INPUT_BYTES = 256 * 1024 * 1024;
const OUTPUT_BYTES = 8 * 1024 * 1024;

const failureForPrimary = (cause: unknown, path: string): AnalysisError => {
  if (cause instanceof AnalysisError) return cause;
  if (cause instanceof ArtifactReaderFailure && cause.reason === "integrity")
    return new AnalysisArtifactChangedError(OPERATION, path, cause.message, {
      cause,
    });
  if (cause instanceof ArtifactReaderFailure && cause.reason === "cancelled")
    return new AnalysisCancelledError(OPERATION, {
      cause: artifactFileCancellationCause(cause),
    });
  if (cause instanceof GoBinaryResourceFailure)
    return new AnalysisResourceConstraintError(
      OPERATION,
      cause.boundary === "search" ? "cpu" : "memory",
      `Selected artifact ${path}: ${cause.message}`,
      { boundary: cause.boundary, maximum_bytes: cause.maximum_bytes },
      { cause },
    );
  if (cause instanceof GoBinaryFormatFailure)
    return cause.kind === "unsupported"
      ? new AnalysisUnsupportedTargetError(OPERATION, path, cause.message, {
          cause,
        })
      : new AnalysisInputError(OPERATION, { cause }, [
          {
            path: ["path"],
            reason: "invalid_format",
            message: `Selected artifact ${path}: ${cause.message}`,
          },
        ]);
  if (cause instanceof ArtifactReaderFailure) {
    if (cause.reason === "limit")
      return new AnalysisResourceConstraintError(
        OPERATION,
        "file-size",
        cause.message,
        { maximum_input_bytes: INPUT_BYTES },
        {
          cause,
          remediationAction:
            "Select a suitable stable artifact within the reported input byte allowance. Do not truncate required bytes; retrying the unchanged oversized input will fail again.",
        },
      );
    if (cause.reason === "path")
      return new AnalysisInputError(OPERATION, { cause }, [
        { path: ["path"], reason: "invalid_format", message: cause.message },
      ]);
  }
  if (cause instanceof Error && "code" in cause) {
    if (cause.code === "EACCES" || cause.code === "EPERM")
      return new AnalysisAccessDeniedError(OPERATION, path, cause.code, {
        cause,
      });
    if (
      ["ENOENT", "ENOTDIR", "ELOOP", "ENAMETOOLONG"].includes(
        String(cause.code),
      )
    )
      return new AnalysisInputError(OPERATION, { cause }, [
        {
          path: ["path"],
          reason: "invalid_value",
          message: `Selected artifact could not be read (${String(cause.code)}): ${path}.`,
        },
      ]);
  }
  return new ProviderAdapterError(GO_BINARY_PROVIDER_IDENTITY.id, OPERATION, {
    cause,
    diagnostics: {
      path,
      reason: cause instanceof Error ? cause.message : String(cause),
    },
  });
};

const failureFor = (
  cause: unknown,
  path: string,
  signal?: AbortSignal,
): AnalysisError => {
  const primary =
    cause instanceof ArtifactFileCleanupFailure &&
    cause.fileCleanupFailure.outcome.kind === "failed"
      ? failureForPrimary(cause.fileCleanupFailure.outcome.cause, path)
      : cause instanceof ArtifactFileCleanupFailure && signal?.aborted
        ? new AnalysisCancelledError(OPERATION, { cause: signal.reason })
        : failureForPrimary(cause, path);
  if (!(cause instanceof ArtifactReaderFailure) || cause.cleanup === undefined)
    return primary;
  const cleanup = new ProviderCleanupError(
    GO_BINARY_PROVIDER_IDENTITY.id,
    cause.cleanup.resources,
    { reason: cause.cleanup.reason },
    { operation: OPERATION, cause },
  );
  const error = analysisErrorWithCleanupFailure(primary, cleanup, OPERATION);
  bindArtifactFileCleanup(cause, error);
  return error;
};

const outputLimit = (path: string) =>
  new AnalysisResourceConstraintError(
    OPERATION,
    "transport",
    `Complete Go metadata for ${path} exceeds the inline output budget; no partial success is returned.`,
    { maximum_output_bytes: OUTPUT_BYTES },
  );

/** Fixed reader boundaries plus unknowns left by the observed metadata. */
const limitationsFor = (
  info: { go_version: string | null; module_text: string | null } | null,
  module: GoModuleMetadata | null,
): string[] => [
  "Embedded build metadata is observed file content, not proof of compiler identity, dependency authenticity or runtime behavior.",
  "Only Go build information is inspected; function names, source mappings, type metadata and decompiled code are not recovered.",
  "Resource guards bound stable artifact reads and cumulative header searches to 256 MiB each, aggregate embedded strings to 1 MiB, structural table decoding to 16 MiB and complete metadata payloads to 8 MiB; these are not operating-system memory or CPU limits.",
  ...(info !== null && (info.go_version === null || info.module_text === null)
    ? [
        "Some embedded Go strings contain non-UTF8 bytes; undecodable text is null and exact source bytes are preserved as base64.",
      ]
    : []),
  ...(info === null
    ? [
        "No recognized Go build-info record was found in the inspected image; absent metadata does not establish that the binary is not Go.",
      ]
    : []),
  ...(module !== null && module.main === null
    ? [
        "Dependency coverage is unknown because no main-module record was decoded from the embedded module information, as in GOPATH-mode builds. Decoded dependency records remain visible; an empty list does not establish the absence of dependencies.",
      ]
    : []),
  ...(module?.complete === false
    ? [
        "Some embedded module-text records could not be parsed completely; their original lines are preserved and additional metadata remains unknown.",
      ]
    : []),
];

/** Stable in-process metadata inspection without subprocesses, temporary files or Go installation. */
export class GoBinaryProvider implements GoBinaryPort {
  readonly identity = GO_BINARY_PROVIDER_IDENTITY;
  readonly #resources = new ArtifactResourceScope();

  async close(): Promise<void> {
    try {
      await this.#resources.close();
    } catch (cause: unknown) {
      if (
        !(cause instanceof ArtifactReaderFailure) ||
        cause.cleanup === undefined
      )
        throw cause;
      const error = new ProviderCleanupError(
        GO_BINARY_PROVIDER_IDENTITY.id,
        cause.cleanup.resources,
        { reason: cause.cleanup.reason },
        { cause, operation: OPERATION },
      );
      bindArtifactFileCleanup(cause, error);
      throw error;
    }
  }

  /** Read complete compiler/module metadata while preserving original byte identity and source ranges. */
  async inspect(
    input: Omit<InspectGoBinaryInput, "detail">,
    options?: ExecutionOptions,
  ): Promise<Result<GoBinary, AnalysisError>> {
    try {
      return await this.#resources.run(async () => {
        const snapshot = await readStableArtifact(
          input.path,
          INPUT_BYTES,
          options?.signal,
          undefined,
          this.#resources,
        );
        assertArtifactReadActive(options?.signal);
        const image = readGoBinaryImage(snapshot.bytes);
        const info = image.build_info;
        if (
          info !== null &&
          ((info.module_text !== null &&
            Buffer.byteLength(info.module_text) > OUTPUT_BYTES) ||
            Buffer.byteLength(info.module_bytes_base64) > OUTPUT_BYTES)
        )
          throw outputLimit(input.path);
        const module =
          info === null
            ? null
            : info.module_text === null
              ? parseGoModuleBytes(
                  Buffer.from(info.module_bytes_base64, "base64").subarray(
                    16,
                    -16,
                  ),
                )
              : parseGoModuleText(info.module_text);
        const report = {
          ...image,
          artifact: {
            path: input.path,
            sha256: snapshot.sha256,
            bytes: snapshot.bytes.length,
          },
          build_info: info === null ? null : { ...info, module },
          limitations: limitationsFor(info, module),
        };
        if (Buffer.byteLength(JSON.stringify(report), "utf8") > OUTPUT_BYTES)
          throw outputLimit(input.path);
        const parsed = goBinarySchema.safeParse(report);
        if (!parsed.success)
          throw new AnalysisOutputError(
            OPERATION,
            "Go reader produced invalid source ranges or report values.",
            { cause: parsed.error },
          );
        assertArtifactReadActive(options?.signal);
        return ok(parsed.data);
      });
    } catch (cause: unknown) {
      return err(failureFor(cause, input.path, options?.signal));
    }
  }
}
