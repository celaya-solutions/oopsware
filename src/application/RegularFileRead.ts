import type { Stats } from "node:fs";
import { lstat, stat, type FileHandle } from "node:fs/promises";

import {
  sameRegularFileState,
  RegularFileChangedError,
  RegularFileOperationCancelled,
  assertRegularFileActive,
} from "../filesystem/RegularFile.js";
import {
  RegularFileCleanupFailure,
  RegularFileCancelled,
  withOwnedRegularFile,
  type RegularFileOperationOutcome,
} from "../filesystem/OwnedRegularFile.js";
import { readBoundedFileBytes } from "../process/BoundedFileBytes.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import type { AnalysisCleanupObservation } from "../domain/analysisErrorBase.js";

/** Filesystem admission policy for one selected regular input. */
export interface RegularFileReadOptions {
  readonly signal?: AbortSignal | undefined;
  readonly symlinks?: "follow" | "reject";
  readonly resources?: ArtifactResourceScope;
  /** Runs on the opened file's own state before any byte is read; throw to refuse the read. */
  readonly admit?: (state: Stats) => void;
}

export class InvalidUtf8FileError extends TypeError {
  readonly _tag = "InvalidUtf8FileError";
  constructor(
    readonly path: string,
    cause: unknown,
  ) {
    super(`File is not valid UTF-8: ${path}`, { cause });
    this.name = this._tag;
  }
}

export { RegularFileCleanupFailure } from "../filesystem/OwnedRegularFile.js";

export type RegularFileReadOutcome<Value> = RegularFileOperationOutcome<Value>;

/** Retry a failed close through its retained owner and report any remaining cleanup. */
export const retryRegularFileCleanup = async <Value>(
  failure: RegularFileCleanupFailure<Value>,
  resources: ArtifactResourceScope,
  signal?: AbortSignal,
): Promise<{
  readonly outcome: RegularFileReadOutcome<Value>;
  readonly cleanup?: AnalysisCleanupObservation;
}> => {
  const outcome: RegularFileReadOutcome<Value> =
    failure.outcome.kind === "failed" &&
    failure.outcome.cause instanceof RegularFileOperationCancelled &&
    !(signal?.aborted === true && failure.outcome.cause === signal.reason)
      ? { kind: "failed", cause: failure.outcome.cause.reason }
      : failure.outcome;
  const released = await resources.release({
    kind: "file-handle",
    handle: failure.owner,
    resource: failure.path,
  });
  if (released.kind === "released") return { outcome };
  return {
    outcome,
    cleanup: {
      reason: `${failureMessage(failure.cleanupCause)}; retry: ${failureMessage(released.cause)}`,
      resources: [failure.path],
    },
  };
};

/** Retry every explicit nested operation owner; close rejection values grant no authority. */
export const retryRegularFileCleanupFailures = async (
  failure: RegularFileCleanupFailure,
  resources: ArtifactResourceScope,
): Promise<{
  readonly primary: unknown;
  readonly failures: readonly RegularFileCleanupFailure[];
  readonly cleanup?: AnalysisCleanupObservation;
}> => {
  const failures: RegularFileCleanupFailure[] = [];
  const observations: AnalysisCleanupObservation[] = [];
  let current = failure;
  let primary: unknown;
  for (;;) {
    failures.push(current);
    const retried = await retryRegularFileCleanup(current, resources);
    if (retried.cleanup !== undefined) observations.push(retried.cleanup);
    primary =
      retried.outcome.kind === "failed"
        ? retried.outcome.cause
        : current.cleanupCause;
    const nested =
      current.outcome.kind === "failed" ? current.outcome.cause : undefined;
    if (!(nested instanceof RegularFileCleanupFailure)) break;
    current = nested;
  }
  return {
    primary,
    failures,
    ...(observations.length === 0
      ? {}
      : {
          cleanup: {
            reason: observations.map(({ reason }) => reason).join("; "),
            resources: observations.flatMap(({ resources }) => resources),
          },
        }),
  };
};

const failureMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** Admit one regular-file handle, retain it through the consumer, and always close it. */
export const withRegularFile = async <Value>(
  path: string,
  read: (handle: FileHandle, stats: Stats) => Promise<Value>,
  options: RegularFileReadOptions = {},
): Promise<Value> => {
  const { signal, resources } = options;
  let admitted: FileHandle | undefined;
  const operation = async () => {
    try {
      return await withOwnedRegularFile(
        path,
        {
          ...(signal === undefined ? {} : { signal }),
          symlinks: options.symlinks ?? "follow",
        },
        async (handle) => {
          admitted = handle;
          const stats = await handle.stat();
          assertRegularFileActive(signal);
          const value = await read(handle, stats);
          assertRegularFileActive(signal);
          const [opened, currentPath] = await Promise.all([
            handle.stat(),
            options.symlinks === "reject" ? lstat(path) : stat(path),
          ]);
          if (
            !sameRegularFileState(stats, opened) ||
            !sameRegularFileState(stats, currentPath)
          )
            throw new RegularFileChangedError(path);
          assertRegularFileActive(signal);
          return value;
        },
      );
    } catch (cause: unknown) {
      // Caller reasons are opaque, including objects shaped like file failures.
      // They do not transfer ownership of any descriptor to this operation.
      if (signal?.aborted === true && cause === signal.reason) throw cause;
      if (cause instanceof RegularFileOperationCancelled) throw cause.reason;
      if (
        cause instanceof RegularFileCancelled &&
        cause.owner.handle === admitted
      )
        throw cause.reason;
      if (
        !(cause instanceof RegularFileCleanupFailure) ||
        resources === undefined
      )
        throw cause;
      const retry = await retryRegularFileCleanup(cause, resources, signal);
      if (retry.cleanup !== undefined) throw cause;
      if (retry.outcome.kind === "failed") throw retry.outcome.cause;
      return retry.outcome.value;
    }
  };
  const value = await (resources === undefined
    ? operation()
    : resources.run(operation));
  // A retained close may have recovered after the descriptor owner's outcome
  // was captured. Include that retry and the scope's finalization in cancellation.
  signal?.throwIfAborted();
  return value;
};

/** Admit a regular file without waiting for a pipe, then read its verified handle. */
export const readRegularFile = (
  path: string,
  options: RegularFileReadOptions = {},
): Promise<Buffer> => readRegularFileContent(path, (bytes) => bytes, options);

/** Read valid UTF-8 without replacing source bytes or stripping an initial BOM. */
export const readRegularFileText = (
  path: string,
  options: RegularFileReadOptions = {},
): Promise<string> =>
  readRegularFileContent(path, (bytes) => decodeFileText(path, bytes), options);

/** Retain the read owner's verified file state together with its decoded text. */
export const readRegularFileTextSnapshot = (
  path: string,
  options: RegularFileReadOptions = {},
): Promise<{ readonly text: string; readonly state: Stats }> =>
  readRegularFileContent(
    path,
    (bytes, state) => ({
      text: decodeFileText(path, bytes),
      state,
    }),
    options,
  );

const decodeFileText = (path: string, bytes: Buffer): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch (cause: unknown) {
    if (!(cause instanceof TypeError)) throw cause;
    throw new InvalidUtf8FileError(path, cause);
  }
};

const readRegularFileContent = <Value>(
  path: string,
  decode: (bytes: Buffer, state: Stats) => Value,
  options: RegularFileReadOptions,
): Promise<Value> =>
  withRegularFile(
    path,
    async (handle, stats) => {
      options.admit?.(stats);
      const bytes = await readBoundedFileBytes(
        handle,
        stats.size,
        options.signal,
      );
      if (bytes === undefined || bytes.length !== stats.size)
        throw new RegularFileChangedError(path);
      return decode(bytes, stats);
    },
    options,
  );
