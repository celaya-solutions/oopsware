import type { AnalysisPartialObservation } from "../domain/analysisErrorBase.js";
import type { JavaScriptSourceAnalysisPort } from "../domain/javascript/javascriptSourceAnalysis.js";
import type { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import type { OwnedDirectoryHandle } from "../filesystem/OwnedDirectoryHandle.js";
import type { OwnedStagedOutput } from "../filesystem/OwnedStagedOutput.js";

import type { ArtifactReader } from "./ArtifactReader.js";
import {
  ArtifactReaderFailure,
  artifactPrimaryCleanupLeases,
} from "./ArtifactReader.js";
import type { SafeOutputTree } from "./SafeOutputTree.js";
import type { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";
import { AnalysisCleanupLease } from "./AnalysisCleanupLease.js";

/** One artifact resource and the capability that owns its cleanup. */
export type ArtifactResourceOwner =
  | {
      readonly kind: "lease";
      readonly resource: string;
      readonly lease: { release(): Promise<void> };
    }
  | {
      readonly kind: "javascript-source-analysis";
      readonly resource: string;
      readonly analysis: JavaScriptSourceAnalysisPort;
    }
  | {
      readonly kind: "directory-handle";
      readonly resource: string;
      readonly handle: OwnedDirectoryHandle;
    }
  | {
      readonly kind: "reader";
      readonly resource: string;
      readonly reader: ArtifactReader;
    }
  | {
      readonly kind: "file-handle";
      readonly resource: string;
      readonly handle: OwnedFileHandle;
    }
  | {
      readonly kind: "output-tree";
      readonly resource: string;
      readonly tree: SafeOutputTree;
    }
  | {
      readonly kind: "staged-output";
      readonly resource: string;
      readonly output: OwnedStagedOutput;
    }
  | {
      readonly kind: "private-runtime-root";
      readonly resource: string;
      readonly root: Pick<PrivateRuntimeRoot, "path" | "close">;
    };

export type ArtifactCleanupAttempt =
  | { readonly kind: "released" }
  | {
      readonly kind: "failed";
      readonly cause: unknown;
      readonly owner: ArtifactResourceOwner;
      readonly lease: AnalysisCleanupLease;
    };

/** Retry failure carrying the exact retained owners that did not release. */
export class ArtifactResourceRetryFailure extends ArtifactReaderFailure {
  readonly failedOwners: readonly ArtifactResourceOwner[];
  override readonly cleanupLeases: readonly AnalysisCleanupLease[];
  constructor(
    failures: readonly {
      readonly owner: ArtifactResourceOwner;
      readonly lease: AnalysisCleanupLease;
    }[],
    message: string,
    options: ConstructorParameters<typeof ArtifactReaderFailure>[2],
  ) {
    super("unavailable", message, options);
    this.failedOwners = failures.map(({ owner }) => owner);
    this.cleanupLeases = [...new Set(failures.map(({ lease }) => lease))];
  }
}

/** Caller-owned scope that retains failed artifact cleanup for a later close. */
export class ArtifactResourceScope {
  readonly #pending = new Set<ArtifactResourceOwner>();
  readonly #leases = new WeakMap<
    ArtifactResourceOwner,
    {
      readonly lease: AnalysisCleanupLease;
      resources: readonly string[];
    }
  >();
  readonly #active = new Set<Promise<unknown>>();
  #draining: Promise<void> | undefined;
  #closed = false;

  get hasPending(): boolean {
    return this.#pending.size > 0;
  }

  /** Labels come from the exact retained owners, never from diagnostic text. */
  get cleanupResources(): readonly string[] {
    return [
      ...new Set(
        [...this.#pending].flatMap((owner) => {
          const lease = this.#lease(owner);
          return lease.released
            ? []
            : (lease.cleanupResources ?? [owner.resource]);
        }),
      ),
    ];
  }

  /** Admit a resource operation while the scope remains open. */
  async run<T>(operation: () => Promise<T>): Promise<T> {
    while (true) {
      if (this.#closed)
        throw new ArtifactReaderFailure(
          "unavailable",
          "Artifact resource scope is closed",
        );
      if (this.#draining !== undefined) await this.#draining;
      if (this.#closed)
        throw new ArtifactReaderFailure(
          "unavailable",
          "Artifact resource scope is closed",
        );
      if (this.#pending.size > 0) {
        await this.retryCleanup();
        continue;
      }
      const running = Promise.resolve().then(operation);
      this.#active.add(running);
      try {
        return await running;
      } finally {
        this.#active.delete(running);
      }
    }
  }

  /** Attempt cleanup now and retain the same owner if it fails. */
  async release(owner: ArtifactResourceOwner): Promise<ArtifactCleanupAttempt> {
    try {
      await this.#lease(owner).release();
      this.#pending.delete(owner);
      return { kind: "released" };
    } catch (cause: unknown) {
      this.#pending.add(owner);
      this.#observeCleanupFailure(owner, cause);
      return { kind: "failed", cause, owner, lease: this.#lease(owner) };
    }
  }

  /** Compose initial cleanup authority without confusing it with an independent primary. */
  cleanupFailure(
    outcome:
      | { readonly kind: "completed" }
      | { readonly kind: "failed"; readonly cause: unknown },
    failures: readonly [
      Extract<ArtifactCleanupAttempt, { readonly kind: "failed" }>,
      ...Extract<ArtifactCleanupAttempt, { readonly kind: "failed" }>[],
    ],
    partialObservation?: AnalysisPartialObservation,
  ): ArtifactReaderFailure {
    const observations = failures.map(({ cause, owner }) =>
      ArtifactReaderFailure.cleanupObservation(cause, owner.resource),
    );
    const primary =
      outcome.kind === "failed" ? outcome.cause : failures[0].cause;
    const inherited =
      outcome.kind === "failed" ? artifactPrimaryCleanupLeases(primary) : [];
    return ArtifactReaderFailure.withCleanup(
      primary,
      {
        reason: observations.map(({ reason }) => reason).join("; "),
        resources: [
          ...new Set(observations.flatMap(({ resources }) => resources)),
        ],
      },
      partialObservation,
      inherited === undefined
        ? undefined
        : [...new Set([...inherited, ...failures.map(({ lease }) => lease)])],
    );
  }

  /** Adopt an owner after another boundary's cleanup attempt failed. */
  retain(owner: ArtifactResourceOwner): void {
    this.#pending.add(owner);
  }

  /** Retry retained owners without closing resource admission. */
  retryCleanup(): Promise<void> {
    if (this.#draining !== undefined) return this.#draining;
    this.#draining = this.#drainAndRetry().finally(() => {
      this.#draining = undefined;
    });
    return this.#draining;
  }

  /** Stop admission, wait for active operations, and retry every retained owner. */
  close(): Promise<void> {
    this.#closed = true;
    return this.retryCleanup();
  }

  async #drainAndRetry(): Promise<void> {
    while (this.#active.size > 0) await Promise.allSettled(this.#active);
    const failures: {
      readonly owner: ArtifactResourceOwner;
      readonly cause: unknown;
    }[] = [];
    for (const owner of this.#pending) {
      try {
        await this.#lease(owner).release();
        this.#pending.delete(owner);
      } catch (cause: unknown) {
        this.#observeCleanupFailure(owner, cause);
        failures.push({ owner, cause });
      }
    }
    if (failures.length === 0) return;
    const observations = failures.map(({ owner, cause }) =>
      ArtifactReaderFailure.cleanupObservation(
        cause,
        owner.kind === "lease" && owner.lease instanceof AnalysisCleanupLease
          ? (owner.lease.cleanupResources ?? owner.resource)
          : owner.resource,
      ),
    );
    const resources = [
      ...new Set(observations.flatMap(({ resources }) => resources)),
    ];
    throw new ArtifactResourceRetryFailure(
      failures.map(({ owner }) => ({ owner, lease: this.#lease(owner) })),
      `Artifact cleanup remains incomplete: ${resources.join(", ")}`,
      {
        cause: new AggregateError(
          failures.map(({ cause }) => cause),
          "One or more artifact resources remain owned",
        ),
        cleanup: {
          reason: observations.map(({ reason }) => reason).join("; "),
          resources,
        },
      },
    );
  }

  /** This boundary owns the latest parsed child cleanup facts for a composite owner. */
  #observeCleanupFailure(owner: ArtifactResourceOwner, cause: unknown): void {
    const retained = this.#leases.get(owner);
    if (retained !== undefined)
      retained.resources = [
        ...ArtifactReaderFailure.cleanupObservation(cause, owner.resource)
          .resources,
      ];
  }

  #lease(owner: ArtifactResourceOwner): AnalysisCleanupLease {
    if (owner.kind === "lease" && owner.lease instanceof AnalysisCleanupLease)
      return owner.lease;
    const previous = this.#leases.get(owner);
    if (previous !== undefined) return previous.lease;
    const retained: {
      readonly lease: AnalysisCleanupLease;
      resources: readonly string[];
    } = {
      resources: [owner.resource],
      lease: new AnalysisCleanupLease(() => cleanup(owner), {
        get cleanupResources() {
          return retained.resources;
        },
      }),
    };
    this.#leases.set(owner, retained);
    return retained.lease;
  }
}

const cleanup = async (owner: ArtifactResourceOwner): Promise<void> => {
  switch (owner.kind) {
    case "lease":
      await owner.lease.release();
      return;
    case "javascript-source-analysis":
      await owner.analysis.close();
      return;
    case "reader":
      await owner.reader.close();
      return;
    case "file-handle":
    case "directory-handle":
      await owner.handle.close();
      return;
    case "output-tree":
      await owner.tree.rollback();
      return;
    case "staged-output":
      await owner.output.close();
      return;
    case "private-runtime-root":
      await owner.root.close();
  }
};
