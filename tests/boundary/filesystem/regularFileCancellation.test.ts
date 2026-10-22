import type { FileHandle } from "node:fs/promises";
import { open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

import {
  withRegularFile,
  retryRegularFileCleanup,
} from "../../../src/application/RegularFileRead.js";
import { ArtifactResourceScope } from "../../../src/artifacts/ArtifactResourceScope.js";
import { RegularFileOperationCancelled } from "../../../src/filesystem/RegularFile.js";
import { OwnedFileHandle } from "../../../src/filesystem/OwnedFileHandle.js";
import {
  RegularFileCleanupFailure,
  RegularFileCancelled,
  withOwnedRegularFile,
} from "../../../src/filesystem/OwnedRegularFile.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it.each(
  (["checkpoint", "completion", "cleanup"] as const).flatMap((kind) =>
    ["before admission", "during read"].flatMap((stage) =>
      [
        { scoped: false, retryClose: false },
        { scoped: true, retryClose: false },
        ...(stage === "during read"
          ? [{ scoped: true, retryClose: true }]
          : []),
      ].map((scenario) => ({ kind, stage, ...scenario })),
    ),
  ),
)(
  "keeps a $kind caller reason opaque $stage with scope=$scoped, close retry=$retryClose",
  async ({ kind, stage, scoped, retryClose }) => {
    const root = await createTestTempDirectory("rea-file-caller-reason-");
    const path = join(root, "input.txt");
    await writeFile(path, "fixture bytes");
    const callerOwner = new OwnedFileHandle(await open(path, "r"));
    const close = vi.spyOn(callerOwner, "close");
    const nestedReason = new Error("nested reason");
    const outcome = { kind: "completed", value: "caller-owned value" } as const;
    const reason =
      kind === "checkpoint"
        ? new RegularFileOperationCancelled(nestedReason)
        : kind === "completion"
          ? new RegularFileCancelled("/caller-selected-path", callerOwner, {
              outcome,
              reason: nestedReason,
            })
          : new RegularFileCleanupFailure(
              "/caller-selected-path",
              callerOwner,
              outcome,
              nestedReason,
            );
    const controller = new AbortController();
    if (stage === "before admission") controller.abort(reason);
    const resources = scoped ? new ArtifactResourceScope() : undefined;
    let admitted: FileHandle | undefined;
    const read = vi.fn(async (handle: FileHandle) => {
      admitted = handle;
      await handle.readFile();
      if (retryClose)
        vi.spyOn(handle, "close").mockRejectedValueOnce(
          new Error("transient descriptor close failure"),
        );
      controller.abort(reason);
      controller.signal.throwIfAborted();
      return "unexpected";
    });
    try {
      await expect(
        withRegularFile(path, read, {
          signal: controller.signal,
          ...(resources === undefined ? {} : { resources }),
        }),
      ).rejects.toBe(reason);
      expect(read).toHaveBeenCalledTimes(stage === "during read" ? 1 : 0);
      if (admitted !== undefined) expect(admitted.fd).toBe(-1);
      expect(close).not.toHaveBeenCalled();
      expect(callerOwner.handle.fd).toBeGreaterThanOrEqual(0);
      expect(resources?.hasPending ?? false).toBe(false);
    } finally {
      await resources?.close();
      close.mockRestore();
      await callerOwner.close();
    }
  },
);

it.each([false, true])(
  "preserves a nested read cancellation with the same signal=%s",
  async (sameSignal) => {
    const root = await createTestTempDirectory("rea-nested-file-cancel-");
    const path = join(root, "input.txt");
    const bytes = Buffer.from("nested read bytes");
    await writeFile(path, bytes);
    const outer = new AbortController();
    const inner = sameSignal ? outer : new AbortController();
    const reason = new Error("nested caller cancellation");
    let outerHandle: FileHandle | undefined;
    let innerHandle: FileHandle | undefined;
    try {
      const failure: unknown = await withRegularFile(
        path,
        async (handle) => {
          outerHandle = handle;
          return withOwnedRegularFile(
            path,
            { signal: inner.signal },
            async (nested) => {
              innerHandle = nested;
              const value = await nested.readFile();
              const close = nested.close.bind(nested);
              vi.spyOn(nested, "close").mockImplementation(async () => {
                await close();
                inner.abort(reason);
              });
              return value;
            },
          );
        },
        { signal: outer.signal },
      ).catch((cause: unknown) => cause);
      expect(failure).toBeInstanceOf(RegularFileCancelled);
      if (!(failure instanceof RegularFileCancelled))
        throw new Error(
          "Expected the nested operation's completed observations",
        );
      expect(failure.path).toBe(path);
      expect(failure.reason).toBe(reason);
      expect(failure.outcome).toEqual({ kind: "completed", value: bytes });
      expect(failure.owner.handle).toBe(innerHandle);
      expect(outerHandle?.fd).toBe(-1);
      expect(innerHandle?.fd).toBe(-1);
    } finally {
      vi.restoreAllMocks();
    }
  },
);

it.each(
  (["metadata", "close"] as const).flatMap((stage) =>
    [false, true].map((scoped) => ({ stage, scoped })),
  ),
)(
  "observes cancellation after $stage with scope=$scoped",
  async ({ stage, scoped }) => {
    const root = await createTestTempDirectory("rea-file-finalization-");
    const path = join(root, "input.txt");
    const bytes = Buffer.from("unchanged fixture bytes");
    await writeFile(path, bytes);
    const controller = new AbortController();
    const reason = new Error("cancel during file finalization");
    const resources = scoped ? new ArtifactResourceScope() : undefined;
    let admitted: FileHandle | undefined;
    try {
      await expect(
        withRegularFile(
          path,
          async (handle) => {
            admitted = handle;
            const value = await handle.readFile();
            if (stage === "metadata") {
              const stat = handle.stat.bind(handle);
              vi.spyOn(handle, "stat").mockImplementation(async () => {
                const metadata = await stat();
                controller.abort(reason);
                return metadata;
              });
            } else {
              const close = handle.close.bind(handle);
              vi.spyOn(handle, "close").mockImplementation(async () => {
                await close();
                controller.abort(reason);
              });
            }
            return value;
          },
          { signal: controller.signal, ...(resources ? { resources } : {}) },
        ),
      ).rejects.toBe(reason);
      expect(admitted?.fd).toBe(-1);
      expect(resources?.hasPending ?? false).toBe(false);
      await resources?.retryCleanup();
      expect(await readFile(path)).toEqual(bytes);
    } finally {
      vi.restoreAllMocks();
      await resources?.close();
    }
  },
);

it("observes cancellation during a recovered descriptor close", async () => {
  const root = await createTestTempDirectory("rea-file-retry-cancel-");
  const path = join(root, "input.txt");
  await writeFile(path, "fixture bytes");
  const controller = new AbortController();
  const reason = new Error("cancel during close retry");
  const resources = new ArtifactResourceScope();
  const nativeClose = OwnedFileHandle.prototype.close;
  let attempts = 0;
  const close = vi
    .spyOn(OwnedFileHandle.prototype, "close")
    .mockImplementation(async function (this: OwnedFileHandle) {
      if (++attempts === 1) throw new Error("transient close failure");
      await nativeClose.call(this);
      controller.abort(reason);
    });
  try {
    await expect(
      withRegularFile(path, (handle) => handle.readFile(), {
        signal: controller.signal,
        resources,
      }),
    ).rejects.toBe(reason);
    expect(attempts).toBe(2);
    expect(resources.hasPending).toBe(false);
    await resources.retryCleanup();
  } finally {
    close.mockRestore();
    await resources.close();
  }
});

it.each(["completed", "failed"] as const)(
  "retains the physical read outcome when close fails after cancellation: %s",
  async (outcome) => {
    const root = await createTestTempDirectory("rea-file-close-cancel-");
    const path = join(root, "input.txt");
    await writeFile(path, "fixture bytes");
    const controller = new AbortController();
    const reason = new Error("cancel during failed close");
    const primary = new Error("existing read failure");
    const cleanupCause = new Error("injected close failure");
    const retained: OwnedFileHandle[] = [];
    const close = vi
      .spyOn(OwnedFileHandle.prototype, "close")
      .mockImplementationOnce(async () => {
        controller.abort(reason);
        throw cleanupCause;
      });
    try {
      let failure: unknown;
      try {
        await withOwnedRegularFile(
          path,
          {
            signal: controller.signal,
            retainFailedClose: (owner) => retained.push(owner),
          },
          async (handle) => {
            const bytes = await handle.readFile();
            if (outcome === "failed") throw primary;
            return bytes;
          },
        );
      } catch (cause: unknown) {
        failure = cause;
      }
      expect(failure).toBeInstanceOf(RegularFileCleanupFailure);
      if (!(failure instanceof RegularFileCleanupFailure))
        throw new Error("Expected the retained close owner");
      expect(failure.outcome).toEqual(
        outcome === "failed"
          ? { kind: "failed", cause: primary }
          : { kind: "completed", value: Buffer.from("fixture bytes") },
      );
      expect(controller.signal.reason).toBe(reason);
      expect(failure.cleanupCause).toBe(cleanupCause);
      expect(retained).toEqual([failure.owner]);
      expect(failure.owner.handle.fd).toBeGreaterThanOrEqual(0);
    } finally {
      close.mockRestore();
      await retained[0]?.close();
    }
    expect(retained[0]?.handle.fd).toBe(-1);
  },
);

it.each(
  [
    null,
    "caller stopped",
    new Error("caller stopped"),
    new RegularFileOperationCancelled(new Error("nested reason")),
  ].flatMap((reason) =>
    [false, true].map((retryFails) => ({ reason, retryFails })),
  ),
)(
  "projects the exact checkpoint reason after application cleanup retry fails=$retryFails ($reason)",
  async ({ reason, retryFails }) => {
    const root = await createTestTempDirectory("rea-file-retry-reason-");
    const path = join(root, "input.bin");
    await writeFile(path, "file bytes");
    const controller = new AbortController();
    const resources = new ArtifactResourceScope();
    const nativeClose = OwnedFileHandle.prototype.close;
    let allowClose = false;
    const close = vi
      .spyOn(OwnedFileHandle.prototype, "close")
      .mockImplementation(async function (this: OwnedFileHandle) {
        if (!allowClose) throw new Error("close unavailable");
        await nativeClose.call(this);
      });
    let failure: unknown;
    try {
      failure = await withRegularFile(
        path,
        async () => {
          controller.abort(reason);
          return "completed callback";
        },
        { signal: controller.signal },
      ).catch((cause: unknown) => cause);
      if (!(failure instanceof RegularFileCleanupFailure))
        throw new Error("Missing checkpoint cleanup owner");
      allowClose = !retryFails;
      const retried = await retryRegularFileCleanup(failure, resources);
      expect(retried.outcome.kind).toBe("failed");
      if (retried.outcome.kind !== "failed")
        throw new Error("Lost cancellation outcome");
      expect(retried.outcome.cause).toBe(reason);
      expect(retried.cleanup !== undefined).toBe(retryFails);
      expect(resources.hasPending).toBe(retryFails);
    } finally {
      allowClose = true;
      await resources.close();
      if (failure instanceof RegularFileCleanupFailure)
        await failure.owner.close();
      close.mockRestore();
    }
  },
);
