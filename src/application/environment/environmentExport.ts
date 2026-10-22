import { getHeapStatistics } from "node:v8";

import { AnalysisError } from "../../domain/analysisErrorBase.js";
import { analysisErrorWithCleanupFailure } from "../../domain/analysisErrorCleanup.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
  type AnalysisInputIssue,
} from "../../domain/analysisErrorCore.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { err, ok, type Result } from "../../domain/result.js";
import { RegularFileChangedError } from "../../filesystem/RegularFile.js";
import {
  bindArtifactFileCleanup,
  ArtifactFileCleanupFailure,
} from "../../artifacts/ArtifactFileOperation.js";
import { AnalysisCleanupLease } from "../../artifacts/AnalysisCleanupLease.js";
import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { RegularFileCleanupFailure } from "../../filesystem/OwnedRegularFile.js";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import { writeEnvironmentBundle } from "./environmentBundleWrite.js";
import { sealOwnedJsonInput } from "../OwnedJsonInput.js";
import { nativeJsonParseRequiredBytes } from "../JsonInputFile.js";
import { readRegularFile } from "../RegularFileRead.js";
import {
  JSON_INPUT_RESOURCE_REMEDIATION,
  parseUtf8Json,
} from "../Utf8JsonInput.js";
import {
  ENVIRONMENT_EXPORT_OPERATION,
  planEnvironmentBundle,
  registryPackageSource,
  type EnvironmentPackageSource,
} from "./environmentBundle.js";
import type { EnvironmentSource } from "./environmentSource.js";

/** One input file read once: the bytes the bundle copies and the value they parse to. */
export interface EnvironmentExportFile {
  readonly path: string;
  readonly bytes: Buffer;
  readonly value: unknown;
}

/** The manifest and capture files as read for authentication and copying. */
export interface EnvironmentExportInputs {
  readonly manifest: EnvironmentExportFile;
  readonly evidence: EnvironmentExportFile;
}

export interface EnvironmentExportInput extends EnvironmentExportInputs {
  /** The authenticated pair the bundle replays, loaded from the parsed values of the two files. */
  readonly source: EnvironmentSource;
  /** Absolute bundle root; absent or empty. */
  readonly directory: string;
  readonly name?: string | undefined;
  /** Absolute path of a packed CLI tarball the Dockerfile installs instead of the registry package. */
  readonly packageTarball?: string | undefined;
}

/** One written file with its size, as the command reports it. */
export interface WrittenBundleFile {
  readonly path: string;
  readonly bytes: number;
}

export interface EnvironmentExportResult {
  readonly status: "exported";
  readonly directory: string;
  readonly name: string;
  readonly tool_count: number;
  readonly evidence_id: string;
  readonly manifest_evidence_id: string;
  readonly package_source: JsonValue;
  readonly files: readonly WrittenBundleFile[];
}

const inputError = (
  issue: AnalysisInputIssue,
  userMessage: string,
): AnalysisInputError =>
  new AnalysisInputError(ENVIRONMENT_EXPORT_OPERATION, { userMessage }, [
    issue,
  ]);

const systemCode = (cause: unknown): string | undefined =>
  cause instanceof Error && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : undefined;

const accessDeniedError = (
  cause: unknown,
  path: string,
): AnalysisAccessDeniedError | undefined => {
  const seen = new Set<Error>();
  let current = cause;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const code = systemCode(current);
    if (code === "EACCES" || code === "EPERM") {
      const error = new AnalysisAccessDeniedError(
        ENVIRONMENT_EXPORT_OPERATION,
        path,
        code,
        {
          cause,
          ...(cause instanceof ArtifactReaderFailure &&
          cause.cleanup !== undefined
            ? { cleanup: cause.cleanup }
            : {}),
        },
      );
      bindArtifactFileCleanup(cause, error);
      return error;
    }
    current = current.cause;
  }
  return undefined;
};

/** Host permission failures retain their typed cause; unexpected failures propagate. */
const rethrowUnlessDenied = (cause: unknown, path: string): never => {
  throw accessDeniedError(cause, path) ?? cause;
};

/** A path that is not a readable regular file, including inline JSON text offered as one. */
const NOT_A_FILE_CODES = new Set([
  "ENOENT",
  "EISDIR",
  "ENOTFILE",
  "ENOTDIR",
  "ENAMETOOLONG",
]);

/** Refuse a whole read, native parse and owned snapshot traversal that cannot fit live heap headroom. */
const headroomRefusal = (
  path: string,
  inputBytes: number,
): AnalysisResourceConstraintError | undefined => {
  const heap = getHeapStatistics();
  const requiredBytes = nativeJsonParseRequiredBytes(inputBytes, true);
  return requiredBytes <= heap.total_available_size
    ? undefined
    : new AnalysisResourceConstraintError(
        ENVIRONMENT_EXPORT_OPERATION,
        "memory",
        "Insufficient heap headroom to read, parse and seal the complete JSON file",
        {
          input_path: path,
          input_file_bytes: inputBytes,
          required_heap_bytes: requiredBytes,
          available_heap_bytes: heap.total_available_size,
          heap_size_limit_bytes: heap.heap_size_limit,
        },
        { remediationAction: JSON_INPUT_RESOURCE_REMEDIATION },
      );
};

/** Read one input once: the same bytes are parsed for authentication and copied into the bundle. */
const readInput = async (
  role: "manifest" | "evidence",
  path: string,
): Promise<Result<EnvironmentExportFile, AnalysisError>> => {
  const resources = new ArtifactResourceScope();
  let bytes: Buffer;
  try {
    // Admit the whole read against the opened file's own size, before materializing the
    // exact bytes the bundle copies.
    bytes = await readRegularFile(path, {
      resources,
      admit: (state) => {
        const refused = headroomRefusal(path, state.size);
        if (refused !== undefined) throw refused;
      },
    });
  } catch (cause: unknown) {
    if (cause instanceof RegularFileCleanupFailure) {
      const failure = new ArtifactFileCleanupFailure(
        cause,
        AnalysisCleanupLease.forCloseOwner(cause.owner, path),
      );
      const cleanup = new AnalysisOutputError(
        ENVIRONMENT_EXPORT_OPERATION,
        `Could not confirm closing the ${role} input file.`,
        {
          cause: failure,
          cleanup: failure.cleanup,
          diagnostics: { input_path: path, input_role: role },
        },
      );
      bindArtifactFileCleanup(failure, cleanup);
      const primary =
        cause.outcome.kind === "failed" ? cause.outcome.cause : undefined;
      return err(
        primary instanceof AnalysisError
          ? analysisErrorWithCleanupFailure(
              primary,
              cleanup,
              ENVIRONMENT_EXPORT_OPERATION,
            ).bindCleanupDependencies([primary, cleanup])
          : cleanup,
      );
    }
    if (cause instanceof AnalysisResourceConstraintError) return err(cause);
    if (cause instanceof RegularFileChangedError)
      return err(
        inputError(
          {
            path: [role],
            reason: "invalid_value",
            expected: "one stable regular file snapshot",
            message: `The ${role} file changed while it was read.`,
          },
          `${path} changed while being read; retry with stable input files.`,
        ),
      );
    if (NOT_A_FILE_CODES.has(systemCode(cause) ?? ""))
      return err(
        inputError(
          {
            path: [role],
            reason: "invalid_value",
            message: `The ${role} argument must be a readable file path; inline JSON cannot be exported.`,
          },
          `${path} could not be read as the ${role} file.`,
        ),
      );
    return rethrowUnlessDenied(cause, path);
  }
  let parsed: ReturnType<typeof parseUtf8Json>;
  try {
    parsed = parseUtf8Json(bytes, ENVIRONMENT_EXPORT_OPERATION, path);
  } catch (cause: unknown) {
    if (cause instanceof AnalysisResourceConstraintError) return err(cause);
    throw cause;
  }
  if (!parsed.ok)
    return err(
      inputError(
        {
          path: [role],
          reason: "invalid_format",
          expected: "JSON",
          message: parsed.error,
        },
        `${path} is not valid JSON: ${parsed.error}`,
      ),
    );
  const snapshot = await sealOwnedJsonInput(
    parsed.value,
    ENVIRONMENT_EXPORT_OPERATION,
  );
  if (!snapshot.ok) return snapshot;
  return ok({ path, bytes, value: snapshot.value });
};

/** Read both files once; the caller authenticates the parsed values and the export copies the same bytes. */
export const readEnvironmentExportInputs = async (
  manifestPath: string,
  evidencePath: string,
): Promise<Result<EnvironmentExportInputs, AnalysisError>> => {
  const manifest = await readInput("manifest", manifestPath);
  if (!manifest.ok) return manifest;
  const evidence = await readInput("evidence", evidencePath);
  if (!evidence.ok) return evidence;
  return ok({ manifest: manifest.value, evidence: evidence.value });
};

const packageSourceValue = (source: EnvironmentPackageSource): JsonValue =>
  source.kind === "registry"
    ? { kind: "registry", specifier: source.specifier }
    : { kind: "tarball", path: source.path };

/** Export the authenticated pair as an agent environment bundle folder. */
export const exportEnvironmentBundle = async (
  input: EnvironmentExportInput,
): Promise<Result<EnvironmentExportResult, AnalysisError>> => {
  const packageSource: EnvironmentPackageSource =
    input.packageTarball === undefined
      ? registryPackageSource()
      : { kind: "tarball", path: input.packageTarball };
  const plan = planEnvironmentBundle(input.source, {
    name: input.name,
    packageSource,
  });
  if (!plan.ok) return plan;
  let files: readonly WrittenBundleFile[];
  try {
    files = await writeEnvironmentBundle(input, plan.value);
  } catch (cause: unknown) {
    if (cause instanceof AnalysisError) return err(cause);
    const denied = accessDeniedError(cause, input.directory);
    if (denied !== undefined) return err(denied);
    if (cause instanceof RegularFileChangedError)
      return err(
        new AnalysisArtifactChangedError(
          ENVIRONMENT_EXPORT_OPERATION,
          cause.path,
          cause.message,
          { cause },
        ),
      );
    if (cause instanceof ArtifactReaderFailure) {
      if (cause.reason === "path" && cause.cleanup === undefined)
        return err(
          inputError(
            {
              path: ["directory"],
              reason: "invalid_value",
              message: cause.message,
            },
            cause.message,
          ),
        );
      const error = new AnalysisOutputError(
        ENVIRONMENT_EXPORT_OPERATION,
        cause.message,
        {
          cause,
          ...(cause.cleanup === undefined ? {} : { cleanup: cause.cleanup }),
        },
      );
      bindArtifactFileCleanup(cause, error);
      return err(error);
    }
    if (cause instanceof Error && systemCode(cause) !== undefined)
      return err(
        new AnalysisOutputError(ENVIRONMENT_EXPORT_OPERATION, cause.message, {
          cause,
        }),
      );
    throw cause;
  }
  return ok({
    status: "exported",
    directory: input.directory,
    name: plan.value.name,
    tool_count: plan.value.toolCount,
    evidence_id: input.source.evidenceId,
    manifest_evidence_id: input.source.manifestEvidenceId,
    package_source: packageSourceValue(plan.value.packageSource),
    files,
  });
};
