import type { FileHandle } from "node:fs/promises";
import { RegularFileOperationCancelled } from "../filesystem/RegularFile.js";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import {
  withOwnedFileHandle,
  withOwnedRegularFile,
  RegularFileCancelled,
  RegularFileCleanupFailure,
} from "../filesystem/OwnedRegularFile.js";
import {
  ArtifactReaderFailure,
  artifactPrimaryCleanupLeases,
} from "./ArtifactReader.js";
import type {
  ArtifactResourceOwner,
  ArtifactResourceScope,
} from "./ArtifactResourceScope.js";
import {
  AnalysisCleanupLease,
  AnalysisCleanupLeaseGroup,
} from "./AnalysisCleanupLease.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";

/** Artifact projection plus the exact descriptor owner and physical operation outcome. */
export class ArtifactFileCleanupFailure<
  Value = unknown,
> extends ArtifactReaderFailure {
  override readonly cleanupLeases: readonly AnalysisCleanupLease[] | undefined;
  readonly fileCleanupFailure: RegularFileCleanupFailure<Value>;
  constructor(
    fileCleanupFailure: RegularFileCleanupFailure<Value>,
    readonly cleanupLease: AnalysisCleanupLease,
  ) {
    const outcome = fileCleanupFailure.outcome;
    if (
      outcome.kind === "failed" &&
      outcome.cause instanceof RegularFileOperationCancelled
    )
      fileCleanupFailure = new RegularFileCleanupFailure(
        fileCleanupFailure.path,
        fileCleanupFailure.owner,
        { kind: "failed", cause: artifactOperationCause(outcome.cause) },
        fileCleanupFailure.cleanupCause,
        fileCleanupFailure.retention,
        fileCleanupFailure.completionCancellation,
      );
    const completionCancellation = fileCleanupFailure.completionCancellation;
    const primary =
      fileCleanupFailure.outcome.kind === "failed"
        ? fileCleanupFailure.outcome.cause
        : completionCancellation === undefined
          ? fileCleanupFailure.cleanupCause
          : new ArtifactReaderFailure(
              "cancelled",
              "Artifact read cancelled during close",
              {
                cause: completionCancellation.reason,
              },
            );
    const projected = ArtifactReaderFailure.withCleanup(
      primary,
      ArtifactReaderFailure.cleanupObservation(
        fileCleanupFailure.cleanupCause,
        fileCleanupFailure.path,
      ),
    );
    super(
      projected.reason,
      projected.message,
      {
        cause: fileCleanupFailure,
        cleanup: projected.cleanup,
        partialObservation: projected.partialObservation,
        cancellation: projected.cancellation,
        ...(projected.boundary === undefined
          ? {}
          : { boundary: projected.boundary }),
      },
      projected.details,
    );
    this.fileCleanupFailure = fileCleanupFailure;
    const inherited =
      fileCleanupFailure.outcome.kind === "failed"
        ? artifactPrimaryCleanupLeases(fileCleanupFailure.outcome.cause)
        : [];
    this.cleanupLeases =
      inherited === undefined
        ? undefined
        : [...new Set([cleanupLease, ...inherited])];
  }
}

/** Normalize the physical primary failure without replacing its exact cleanup owner. */
export const mapArtifactFileFailure = (
  cause: unknown,
  classify: (cause: unknown) => unknown,
): unknown => {
  if (!(cause instanceof ArtifactFileCleanupFailure)) return classify(cause);
  const physical = cause.fileCleanupFailure;
  if (physical.outcome.kind !== "failed") return cause;
  const primary =
    physical.outcome.cause instanceof ArtifactFileCleanupFailure
      ? mapArtifactFileFailure(physical.outcome.cause, classify)
      : classify(physical.outcome.cause);
  if (primary === physical.outcome.cause) return cause;
  return new ArtifactFileCleanupFailure(
    new RegularFileCleanupFailure(
      physical.path,
      physical.owner,
      { kind: "failed", cause: primary },
      physical.cleanupCause,
      physical.retention,
      physical.completionCancellation,
    ),
    cause.cleanupLease,
  );
};

/** Read only the physical outcomes carried by known nested file owners. */
export const artifactFilePrimaryFailure = (cause: unknown): unknown => {
  while (
    cause instanceof ArtifactFileCleanupFailure &&
    cause.fileCleanupFailure.outcome.kind === "failed"
  )
    cause = cause.fileCleanupFailure.outcome.cause;
  return cause;
};

/** Cancellation after confirmed close retains the completed physical operation. */
export class ArtifactFileCancelled<
  Value = unknown,
> extends ArtifactReaderFailure {
  constructor(
    readonly fileCancellation: Pick<
      RegularFileCancelled<Value>,
      "reason" | "outcome"
    >,
  ) {
    super("cancelled", "Artifact read cancelled", {
      cause: fileCancellation.reason,
    });
  }
}

/** Bind a translated failure to its exact descriptor leases, including failed retries. */
export const bindArtifactFileCleanup = (
  cause: unknown,
  error: AnalysisError,
): void => {
  const leases =
    cause instanceof ArtifactReaderFailure ? cause.cleanupLeases : undefined;
  if (leases !== undefined) new AnalysisCleanupLeaseGroup(error, leases);
};

/** Interpret this owner's typed cancellation, preserving an undefined reason. */
export const artifactFileCancellationCause = (
  cause: ArtifactReaderFailure,
): unknown => {
  return cause.cancellation === undefined
    ? cause.cause
    : cause.cancellation.reason;
};

/** Report cancellation at the read stage that actually observed the caller signal. */
export const assertArtifactReadActive = (
  signal: AbortSignal | undefined,
): void => {
  if (signal?.aborted)
    throw new ArtifactReaderFailure("cancelled", "Artifact read cancelled", {
      cause: signal.reason,
    });
};

/** Admit a regular file without blocking on pipes, retaining failed admission closes. */
export const withArtifactRegularFile = async <Value>(
  path: string,
  resources: {
    retain(
      owner: Extract<ArtifactResourceOwner, { readonly kind: "lease" }>,
    ): void;
  },
  signal: AbortSignal | undefined,
  operation: (file: FileHandle) => Promise<Value>,
  symlinks: "follow" | "reject" = "reject",
): Promise<Value> => {
  let cleanupLease: AnalysisCleanupLease | undefined;
  assertArtifactReadActive(signal);
  try {
    const value = await withOwnedRegularFile(
      path,
      {
        symlinks,
        ...(signal === undefined ? {} : { signal }),
        retainFailedClose: (owner) => {
          cleanupLease = new AnalysisCleanupLease(() => owner.close(), [path]);
          resources.retain({
            kind: "lease",
            resource: path,
            lease: cleanupLease,
          });
        },
      },
      async (file) => {
        assertArtifactReadActive(signal);
        return await operation(file);
      },
    );
    return value;
  } catch (cause: unknown) {
    if (
      cause instanceof RegularFileCleanupFailure &&
      cleanupLease !== undefined
    )
      throw new ArtifactFileCleanupFailure(cause, cleanupLease);
    if (cause instanceof RegularFileCancelled)
      throw new ArtifactFileCancelled(cause);
    throw artifactOperationCause(cause);
  }
};

/** Keep admission, operation outcome, final close and failed-owner transfer together. */
export const withArtifactFileHandle = async <Value>(
  path: string,
  file: FileHandle,
  resources: ArtifactResourceScope | undefined,
  signal: AbortSignal | undefined,
  operation: (file: FileHandle) => Promise<Value>,
): Promise<Value> => {
  const owner = new OwnedFileHandle(file);
  const cleanupLease = new AnalysisCleanupLease(() => owner.close(), [path]);
  try {
    return await withOwnedFileHandle(
      path,
      owner,
      {
        ...(signal === undefined ? {} : { signal }),
        retainFailedClose: () =>
          resources?.retain({
            kind: "lease",
            resource: path,
            lease: cleanupLease,
          }),
      },
      operation,
    );
  } catch (cause: unknown) {
    if (cause instanceof RegularFileCleanupFailure)
      throw new ArtifactFileCleanupFailure(cause, cleanupLease);
    if (cause instanceof RegularFileCancelled)
      throw new ArtifactFileCancelled(cause);
    throw artifactOperationCause(cause);
  }
};

const artifactOperationCause = (cause: unknown): unknown =>
  cause instanceof RegularFileOperationCancelled
    ? new ArtifactReaderFailure(
        "cancelled",
        "Artifact file operation cancelled",
        { cause: cause.reason },
      )
    : cause;
