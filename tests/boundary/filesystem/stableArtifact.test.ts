import {
  lstat,
  open,
  rename,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { expect, it, onTestFinished } from "vitest";
import { readStableArtifact } from "../../../src/artifacts/readStableArtifact.js";
import {
  ArtifactFileCleanupFailure,
  ArtifactFileCancelled,
  withArtifactFileHandle,
} from "../../../src/artifacts/ArtifactFileOperation.js";
import { ArtifactResourceScope } from "../../../src/artifacts/ArtifactResourceScope.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("reads exact binary and empty bytes and rejects symlink/size/cancellation boundaries", async () => {
  const root = await createTestTempDirectory("rea-stable-artifact-");
  const path = join(root, "source.bin");
  await writeFile(path, Buffer.from([0, 255, 254]));
  expect((await readStableArtifact(path, 3)).bytes).toEqual(
    Buffer.from([0, 255, 254]),
  );
  await expect(readStableArtifact(path, 2)).rejects.toMatchObject({
    reason: "limit",
  });
  await writeFile(path, "");
  expect((await readStableArtifact(path, 0)).bytes.length).toBe(0);
  const real = join(root, "original.bin");
  await rename(path, real);
  await symlink(real, path);
  await expect(readStableArtifact(path, 3)).rejects.toMatchObject({
    reason: "path",
  });
  const controller = new AbortController();
  controller.abort();
  await expect(
    readStableArtifact(real, 3, controller.signal),
  ).rejects.toMatchObject({
    reason: "cancelled",
    cause: controller.signal.reason,
  });
});

const checkChange = async (
  stage: "before-open" | "after-read" | "symlink-replacement",
): Promise<void> => {
  const root = await createTestTempDirectory("rea-stable-read-");
  const path = join(root, "selected");
  await writeFile(path, "original evidence");
  let inspected = 0;
  const reading = readStableArtifact(path, 1024, undefined, {
    async lstat(selected) {
      inspected++;
      if (stage === "after-read" && inspected === 2) await unlink(selected);
      const metadata = await lstat(selected, { bigint: true });
      if (inspected === 1 && stage !== "after-read") {
        await unlink(selected);
        if (stage === "symlink-replacement") await symlink("missing", selected);
      }
      return metadata;
    },
    open,
  });
  await expect(reading).rejects.toMatchObject({ reason: "integrity" });
};

it.each(["before-open", "after-read"] as const)(
  "retains an actual post-validation %s change as integrity failure",
  checkChange,
);

it.skipIf(process.platform === "win32")(
  "retains a post-validation symlink replacement as an integrity failure",
  () => checkChange("symlink-replacement"),
);

it("keeps initially missing inputs distinguishable from later changes", async () => {
  const root = await createTestTempDirectory("rea-stable-missing-");
  await expect(
    readStableArtifact(join(root, "missing"), 1024),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

const heldDescriptor = async () => {
  const root = await createTestTempDirectory("rea-stable-close-owner-");
  const path = join(root, "selected.bin");
  const bytes = Buffer.from([0, 255, 1, 254]);
  await writeFile(path, bytes);
  const handle = await open(path, "r");
  const nativeClose = handle.close.bind(handle);
  const closeFailure = new Error("controlled descriptor close failure");
  let allowClose = false;
  handle.close = async () => {
    if (!allowClose) throw closeFailure;
    await nativeClose();
  };
  onTestFinished(async () => {
    if (handle.fd >= 0) await nativeClose();
  });
  return {
    path,
    bytes,
    handle,
    nativeClose,
    closeFailure,
    release: () => {
      allowClose = true;
    },
    fileSystem: {
      lstat: (selected: string) => lstat(selected, { bigint: true }),
      open: async () => handle,
    },
  };
};

it.each(["scoped", "transferred"])(
  "retains exact completed bytes and descriptor cleanup under %s ownership",
  async (ownership) => {
    const file = await heldDescriptor();
    const scope =
      ownership === "scoped" ? new ArtifactResourceScope() : undefined;
    const failure = await readStableArtifact(
      file.path,
      1024,
      undefined,
      file.fileSystem,
      scope,
    ).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(ArtifactFileCleanupFailure);
    if (!(failure instanceof ArtifactFileCleanupFailure))
      throw new Error("Missing descriptor owner");
    expect(failure.fileCleanupFailure.owner.handle).toBe(file.handle);
    expect(failure.fileCleanupFailure.cleanupCause).toBe(file.closeFailure);
    expect(failure.fileCleanupFailure.outcome).toEqual({
      kind: "completed",
      value: {
        bytes: file.bytes,
        sha256: createHash("sha256").update(file.bytes).digest("hex"),
      },
    });
    expect(file.handle.fd).toBeGreaterThanOrEqual(0);
    expect(failure.cleanup?.resources).toEqual([file.path]);
    expect(scope?.hasPending ?? false).toBe(ownership === "scoped");
    file.release();
    if (scope !== undefined) await scope.close();
    else await failure.cleanupLease.release();
    expect(file.handle.fd).toBe(-1);
  },
);

it.each([new Error("primary read failure"), undefined, null])(
  "preserves the explicit failed read outcome %j through close rejection",
  async (primary) => {
    const file = await heldDescriptor();
    file.handle.stat = async () => {
      throw primary;
    };
    const scope = new ArtifactResourceScope();
    const failure = await readStableArtifact(
      file.path,
      1024,
      undefined,
      file.fileSystem,
      scope,
    ).catch((cause: unknown) => cause);
    if (!(failure instanceof ArtifactFileCleanupFailure))
      throw new Error("Missing typed read outcome");
    expect(failure.fileCleanupFailure.outcome).toEqual({
      kind: "failed",
      cause: primary,
    });
    expect(failure.fileCleanupFailure.cleanupCause).toBe(file.closeFailure);
    file.release();
    await scope.close();
    expect(file.handle.fd).toBe(-1);
  },
);

it("retains physical read facts and the caller's reason when cancellation arrives during successful close", async () => {
  const file = await heldDescriptor();
  const controller = new AbortController();
  const reason = new Error("cancelled during descriptor finalization");
  file.handle.close = async () => {
    controller.abort(reason);
    await file.nativeClose();
  };
  const failure = await readStableArtifact(
    file.path,
    1024,
    controller.signal,
    file.fileSystem,
  ).catch((cause: unknown) => cause);
  if (!(failure instanceof ArtifactFileCancelled))
    throw new Error("Missing late cancellation");
  expect(failure.cause).toBe(reason);
  expect(failure.fileCancellation.outcome.value.bytes).toEqual(file.bytes);
  expect(file.handle.fd).toBe(-1);
});

it("retains a completed read and failed cleanup when cancellation arrives during close rejection", async () => {
  const file = await heldDescriptor();
  const controller = new AbortController();
  const reason = new Error("cancelled during failed close");
  file.handle.close = async () => {
    controller.abort(reason);
    throw file.closeFailure;
  };
  const failure = await readStableArtifact(
    file.path,
    1024,
    controller.signal,
    file.fileSystem,
  ).catch((cause: unknown) => cause);
  if (!(failure instanceof ArtifactFileCleanupFailure))
    throw new Error("Missing cleanup ownership");
  expect(failure.fileCleanupFailure.outcome).toMatchObject({
    kind: "completed",
    value: { bytes: file.bytes },
  });
  expect(controller.signal.reason).toBe(reason);
  file.handle.close = file.nativeClose;
  await failure.cleanupLease.release();
  expect(file.handle.fd).toBe(-1);
});

it("transfers the exact owner even when the caller's retention boundary rejects it", async () => {
  const file = await heldDescriptor();
  const retentionFailure = new Error("controlled owner-retention failure");
  class RejectingScope extends ArtifactResourceScope {
    override retain(): void {
      throw retentionFailure;
    }
  }
  const failure = await readStableArtifact(
    file.path,
    1024,
    undefined,
    file.fileSystem,
    new RejectingScope(),
  ).catch((cause: unknown) => cause);
  if (!(failure instanceof ArtifactFileCleanupFailure))
    throw new Error("Lost cleanup capability after retention failure");
  expect(failure.fileCleanupFailure.retention).toEqual({
    kind: "callback_threw",
    cause: retentionFailure,
  });
  expect(failure.fileCleanupFailure.cleanupCause).toBe(file.closeFailure);
  expect(failure.fileCleanupFailure.owner.handle).toBe(file.handle);
  file.release();
  await failure.cleanupLease.release();
  expect(file.handle.fd).toBe(-1);
});

it("does not turn a retention callback abort into completed-file cancellation", async () => {
  const file = await heldDescriptor();
  const controller = new AbortController();
  class AbortingScope extends ArtifactResourceScope {
    override retain(
      owner: Parameters<ArtifactResourceScope["retain"]>[0],
    ): void {
      controller.abort(null);
      super.retain(owner);
    }
  }
  const scope = new AbortingScope();
  try {
    const failure: unknown = await withArtifactFileHandle(
      file.path,
      file.handle,
      scope,
      controller.signal,
      async () => file.bytes,
    ).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(ArtifactFileCleanupFailure);
    if (!(failure instanceof ArtifactFileCleanupFailure))
      throw new Error("Missing file cleanup owner");
    expect(failure.fileCleanupFailure.outcome).toEqual({
      kind: "completed",
      value: file.bytes,
    });
    expect(failure.fileCleanupFailure.completionCancellation).toBeUndefined();
    expect(failure.reason).not.toBe("cancelled");
    file.release();
    await failure.cleanupLease.release();
    expect(file.handle.fd).toBe(-1);
  } finally {
    file.release();
    await scope.close();
  }
});
