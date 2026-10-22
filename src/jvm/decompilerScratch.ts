import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AnalysisCleanupLease,
  AnalysisCleanupLeaseGroup,
} from "../artifacts/AnalysisCleanupLease.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import {
  OwnedCommandFailure,
  runOwnedCommand,
} from "../process/OwnedCommand.js";
import type { ProviderProcessSupervisor } from "../process/ProviderProcess.js";

const pending = new Set<DecompilerCleanupFailure>();

/** Keeps the exact process owner and scratch together until a later call can release both. */
class DecompilerCleanupFailure extends Error {
  constructor(
    readonly lease: AnalysisCleanupLease,
    readonly tool: string,
    cause: unknown,
  ) {
    super(`${tool} cleanup is incomplete; its scratch directory is retained.`, {
      cause,
    });
  }
}

export const decompilerCleanupFailure = (
  cause: unknown,
  operation: string,
  mapPrimary: (cause: unknown) => AnalysisError | null,
): AnalysisError | null => {
  if (!(cause instanceof DecompilerCleanupFailure)) return null;
  const cleanup = new ProviderCleanupError(
    cause.tool,
    cause.lease.cleanupResources ?? [],
    { reason: cause.message },
    { operation, cause },
  );
  new AnalysisCleanupLeaseGroup(cleanup, [cause.lease]);
  const primary = mapPrimary(cause.cause);
  return primary === null
    ? cleanup
    : analysisErrorWithCleanupFailure(
        primary,
        cleanup,
        operation,
      ).bindCleanupDependencies([primary, cleanup]);
};

export const withDecompilerScratch = async <T>(
  tool: string,
  work: (scratch: string, run: typeof runOwnedCommand) => Promise<T>,
): Promise<T> => {
  for (const failure of pending) {
    try {
      await failure.lease.release();
    } catch {
      throw failure;
    }
    pending.delete(failure);
  }
  const scratch = await mkdtemp(join(tmpdir(), `oopsware-${tool}-`));
  let owner: ProviderProcessSupervisor | undefined;
  let resources: readonly string[] = [scratch];
  const lease = new AnalysisCleanupLease(
    async () => {
      if (owner !== undefined) {
        const stopped = await owner.stop();
        if (stopped.status === "incomplete") throw new Error(stopped.reason);
        owner = undefined;
        resources = [scratch];
      }
      await rm(scratch, { recursive: true, force: true });
    },
    {
      get cleanupResources() {
        return resources;
      },
    },
  );
  const run: typeof runOwnedCommand = async (...args) => {
    try {
      return await runOwnedCommand(...args);
    } catch (cause) {
      if (
        cause instanceof OwnedCommandFailure &&
        cause.cleanupOwner !== undefined
      ) {
        owner = cause.cleanupOwner;
        resources = [...new Set([scratch, ...cause.resources])];
      }
      throw cause;
    }
  };
  let primary: unknown;
  try {
    return await work(scratch, run);
  } catch (cause) {
    primary = cause;
    throw cause;
  } finally {
    try {
      await lease.release();
    } catch (cause) {
      const failure = new DecompilerCleanupFailure(
        lease,
        tool,
        primary ?? cause,
      );
      pending.add(failure);
      throw failure;
    }
  }
};
