import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";

import { MANAGED_STATIC_PROVIDER } from "../application/InvestigationProviders.js";
import { classifyBinaryTargetFilesystemFailure } from "../application/BinaryTargetResolver.js";
import {
  withRegularFile,
  RegularFileCleanupFailure,
  type RegularFileReadOptions,
} from "../application/RegularFileRead.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import { EvidenceIntegrityError } from "../domain/evidenceErrors.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { RegularFileChangedError } from "../filesystem/RegularFile.js";
import { readBoundedFileBytes } from "../process/BoundedFileBytes.js";

// Managed static inspection retains the complete PE snapshot in memory.
export const MAX_MANAGED_SNAPSHOT_BYTES = 128 * 1024 * 1024;

interface ManagedSourceObservation {
  readonly byteLength: number;
  readonly sha256: string;
  readonly bytes?: Buffer;
}

interface ManagedSnapshot extends ManagedSourceObservation {
  readonly bytes: Buffer;
}

const managedSnapshotCapacityError = (
  operation: string,
): AnalysisResourceConstraintError =>
  new AnalysisResourceConstraintError(
    operation,
    "memory",
    "Managed static inspection requires an eagerly retained PE snapshot within its input byte budget.",
    { max_snapshot_bytes: MAX_MANAGED_SNAPSHOT_BYTES },
  );

export const readManagedSnapshot = async (
  path: string,
  operation: string,
  options: RegularFileReadOptions = {},
): Promise<ManagedSnapshot> => {
  return readManagedFile(
    path,
    operation,
    async (handle, metadata) => {
      const signal = options.signal;
      if (metadata.size > MAX_MANAGED_SNAPSHOT_BYTES)
        throw managedSnapshotCapacityError(operation);
      const bytes = await readBoundedFileBytes(
        handle,
        MAX_MANAGED_SNAPSHOT_BYTES,
        signal,
      );
      if (bytes === undefined) throw managedSnapshotCapacityError(operation);
      signal?.throwIfAborted();
      return {
        byteLength: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes,
      };
    },
    options,
  );
};

export const hashManagedSource = async (
  path: string,
  operation: string,
  options: RegularFileReadOptions = {},
): Promise<ManagedSourceObservation> =>
  readManagedFile(
    path,
    operation,
    async (handle, metadata) => {
      const signal = options.signal;
      if (metadata.size > MAX_MANAGED_SNAPSHOT_BYTES)
        throw managedSnapshotCapacityError(operation);
      const digest = createHash("sha256");
      let byteLength = 0;
      const chunk = Buffer.allocUnsafe(64 * 1024);
      for (;;) {
        signal?.throwIfAborted();
        const { bytesRead } = await handle.read(
          chunk,
          0,
          Math.min(chunk.length, MAX_MANAGED_SNAPSHOT_BYTES - byteLength + 1),
          null,
        );
        signal?.throwIfAborted();
        if (bytesRead === 0) break;
        if (bytesRead > MAX_MANAGED_SNAPSHOT_BYTES - byteLength)
          throw managedSnapshotCapacityError(operation);
        byteLength += bytesRead;
        digest.update(chunk.subarray(0, bytesRead));
      }
      return { byteLength, sha256: digest.digest("hex") };
    },
    options,
  );

const readManagedFile = <Value>(
  path: string,
  operation: string,
  read: (handle: FileHandle, metadata: Stats) => Promise<Value>,
  options: RegularFileReadOptions,
): Promise<Value> =>
  withRegularFile(path, read, options).catch((cause: unknown) => {
    throw normalizeManagedReadFailure(cause, path, operation, options.signal);
  });

/** Keep cleanup ownership and the original typed read failure at this boundary. */
const normalizeManagedReadFailure = (
  cause: unknown,
  fallbackPath: string,
  operation: string,
  signal?: AbortSignal,
): unknown => {
  // An exact caller reason is opaque, even if it resembles a cleanup record.
  if (signal?.aborted === true && cause === signal.reason)
    return normalizeReadFailure(cause, fallbackPath, operation, signal);
  const cleanupError = managedCleanupError(
    cause,
    fallbackPath,
    operation,
    signal,
  );
  if (cleanupError !== undefined) return cleanupError;
  return normalizeReadFailure(cause, fallbackPath, operation, signal);
};

/** Project cleanup failures owned by managed file reads or their shared scope. */
export const managedCleanupError = (
  cause: unknown,
  fallbackPath: string,
  operation: string,
  signal?: AbortSignal,
): AnalysisError | undefined => {
  if (cause instanceof RegularFileCleanupFailure) {
    const cleanup = new ProviderCleanupError(
      MANAGED_STATIC_PROVIDER.id,
      [cause.path],
      { reason: "A managed input file handle could not be closed" },
      { cause, operation },
    );
    const failure =
      cause.outcome.kind === "failed"
        ? normalizeReadFailure(
            cause.outcome.cause,
            cause.path,
            operation,
            signal,
          )
        : undefined;
    return failure instanceof AnalysisError
      ? analysisErrorWithCleanupFailure(failure, cleanup, operation)
      : cleanup;
  }
  if (cause instanceof ArtifactReaderFailure && cause.cleanup !== undefined)
    return new ProviderCleanupError(
      MANAGED_STATIC_PROVIDER.id,
      cause.cleanup.resources.length > 0
        ? cause.cleanup.resources
        : [fallbackPath],
      { reason: cause.cleanup.reason },
      { cause, operation },
    );
  return undefined;
};

const normalizeReadFailure = (
  cause: unknown,
  path: string,
  operation: string,
  signal?: AbortSignal,
): unknown => {
  if (signal?.aborted === true && cause === signal.reason)
    return new AnalysisCancelledError(operation, { cause });
  if (cause instanceof RegularFileChangedError)
    return new EvidenceIntegrityError(
      `Managed source changed while ${operation} was reading ${path}.`,
      { cause },
    );
  if (cause instanceof AnalysisError) return cause;
  return (
    classifyBinaryTargetFilesystemFailure(path, cause) ??
    (signal?.aborted === true
      ? new AnalysisCancelledError(operation, { cause })
      : cause)
  );
};
