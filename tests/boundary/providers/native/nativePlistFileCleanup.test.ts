import { open, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi, onTestFinished } from "vitest";
import { NativeMacOSProvider } from "../../../../src/native/NativeMacOSProvider.js";
import { ArtifactFileCleanupFailure } from "../../../../src/artifacts/ArtifactFileOperation.js";
import {
  NativeFixtureRunner,
  nativeMachoTarget,
} from "../../../fixtures/nativeCommands.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import { OwnedFileHandle } from "../../../../src/filesystem/OwnedFileHandle.js";
import { ProviderCleanupError } from "../../../../src/domain/providerCleanupError.js";
import { resolvedAnalysisError } from "../../../../src/domain/analysisErrorBase.js";
import { AnalysisCleanupLease } from "../../../../src/artifacts/AnalysisCleanupLease.js";
import { ArtifactReaderFailure } from "../../../../src/artifacts/ArtifactReader.js";
import { err, ok } from "../../../../src/domain/result.js";
import { projectAnalysisError } from "../../../../src/domain/analysisErrorProjection.js";

const fixture = async () => {
  const root = await createTestTempDirectory("rea-native-plist-lifetime-");
  const path = join(root, "selected.plist");
  await writeFile(path, "<plist><string>value</string></plist>");
  const probe = await open(path, "r");
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  await probe.close();
  const runner = new NativeFixtureRunner({
    file: "ASCII text",
    plutil: '"value"',
  });
  const client = new NativeMacOSProvider({}, runner, "darwin").createClient(
    nativeMachoTarget(join(root, "target")),
  );
  onTestFinished(async () => {
    await client.close();
  });
  return { path, prototype, runner, client };
};

it("does not adopt a command's arbitrary thrown cleanup marker as a file owner", async () => {
  const { client, path, runner } = await fixture();
  const foreign = ArtifactReaderFailure.withCleanup(
    new Error("opaque command failure"),
    { resources: ["unowned"], reason: "foreign marker" },
  );
  const run = vi.spyOn(runner, "run").mockRejectedValueOnce(foreign);
  onTestFinished(() => run.mockRestore());
  const result = await client.execute("inspect_plist", { path });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected opaque command failure");
  expect(result.error.cause).toBe(foreign);
  expect(result.error.cleanupIncomplete).toBe(false);
  expect(result.error.cleanupResources).toEqual([]);
});

it("keeps mixed client cleanup live until both file and tracer owners resolve", async () => {
  const root = await createTestTempDirectory("rea-native-mixed-close-");
  const path = join(root, "selected.plist");
  await writeFile(path, "<plist><string>value</string></plist>");
  const probe = await open(path, "r");
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  await probe.close();
  const traceFailure = new ProviderCleanupError(
    "native-macos",
    ["trace-owner"],
    {},
  );
  const traceLease = new AnalysisCleanupLease(async () => {}, ["trace-owner"]);
  traceLease.bindCleanupError(traceFailure);
  let traceAttempts = 0;
  const client = new NativeMacOSProvider(
    {},
    new NativeFixtureRunner({ file: "ASCII text", plutil: '"value"' }),
    "darwin",
    () => ({
      trace: async () => {
        throw new Error("Trace not requested");
      },
      close: async () => {
        traceAttempts += 1;
        if (traceAttempts < 3) return err(traceFailure);
        await traceLease.release();
        return ok(null);
      },
    }),
  ).createClient(nativeMachoTarget(join(root, "target")));
  let release: (() => Promise<void>) | undefined;
  const original = prototype.read;
  let fileAttempts = 0;
  const read = vi
    .spyOn(prototype, "read")
    .mockImplementationOnce(async function (
      this: FileHandle,
      ...args: Parameters<FileHandle["read"]>
    ) {
      release = this.close.bind(this);
      this.close = async () => {
        fileAttempts += 1;
        if (fileAttempts < 3) throw new Error("file close failed");
        await release!();
      };
      return Reflect.apply(original, this, args);
    });
  onTestFinished(async () => {
    read.mockRestore();
    await release?.();
    await traceLease.release();
    await client.close();
  });
  expect((await client.execute("inspect_plist", { path })).ok).toBe(false);
  const first = await client.close();
  expect(first.ok).toBe(false);
  if (first.ok) throw new Error("Expected both pending owners");
  expect(new Set(first.error.cleanupResources)).toEqual(
    new Set([path, "trace-owner"]),
  );
  expect((await client.close()).ok).toBe(false);
  expect(first.error.cleanupIncomplete).toBe(true);
  expect(first.error.cleanupResources).toEqual(["trace-owner"]);
  expect((await client.close()).ok).toBe(true);
  expect(first.error.cleanupIncomplete).toBe(false);
  expect(first.error.cleanupResources).toEqual([]);
});

it.for(["path-input", "target"] as const)(
  "retains %s prefix read and close failures through repeated client cleanup",
  async (selection, { onTestFinished }) => {
    const root = await createTestTempDirectory("rea-native-plist-close-");
    const path = join(root, "selected.plist");
    await writeFile(path, "<plist><string>value</string></plist>");
    const probe = await open(path, "r");
    const prototype = Object.getPrototypeOf(probe) as FileHandle;
    await probe.close();
    const primary = Object.assign(new Error("controlled prefix read failure"), {
      code: "EIO",
    });
    const cleanup = new Error("controlled prefix close failure");
    let attempts = 0;
    let release: (() => Promise<void>) | undefined;
    const read = vi
      .spyOn(prototype, "read")
      .mockImplementationOnce(async function (this: FileHandle) {
        release = this.close.bind(this);
        this.close = async () => {
          attempts += 1;
          if (attempts <= 2) throw cleanup;
          await release!();
        };
        throw primary;
      });
    onTestFinished(async () => {
      read.mockRestore();
      await release?.();
    });
    const client = new NativeMacOSProvider(
      {},
      new NativeFixtureRunner({ file: "ASCII text", plutil: '"value"' }),
      "darwin",
    ).createClient(
      selection === "target"
        ? { kind: "artifact", format: "plist", path, sha256: "0".repeat(64) }
        : nativeMachoTarget(join(root, "target")),
    );
    onTestFinished(async () => {
      await client.close();
    });
    const result = await client.execute(
      "inspect_plist",
      selection === "target" ? {} : { path },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected retained cleanup failure");
    expect(result.error).toMatchObject({
      cleanupIncomplete: true,
      operation: "inspect_plist",
    });
    expect(result.error.cleanupResources).toContain(path);
    expect(result.error.capturedOutput?.stdout).toBe('"value"');
    const projected = projectAnalysisError(result.error);
    expect(JSON.stringify(projected).match(/captured_output/gu)).toHaveLength(
      1,
    );
    expect(result.error.cause).toBeInstanceOf(ArtifactFileCleanupFailure);
    const failure = result.error.cause as ArtifactFileCleanupFailure;
    expect(failure.fileCleanupFailure.outcome).toEqual({
      kind: "failed",
      cause: primary,
    });
    expect(failure.fileCleanupFailure.cleanupCause).toBe(cleanup);
    const first = await client.close();
    expect(first.ok).toBe(false);
    expect(attempts).toBe(2);
    const retried = await client.close();
    expect(retried.ok).toBe(true);
    expect(attempts).toBe(3);
    expect(result.error.cleanupIncomplete).toBe(false);
    expect(resolvedAnalysisError(result.error).cause).toBe(primary);
    expect(resolvedAnalysisError(result.error).capturedOutput?.stdout).toBe(
      '"value"',
    );
    if (!first.ok) expect(first.error.cleanupIncomplete).toBe(false);
  },
);

for (const readFails of [false, true])
  it(`retains a ${readFails ? "failed" : "completed"} read when cancellation and close failure coincide`, async () => {
    const { client, path, prototype } = await fixture();
    const controller = new AbortController();
    const primary = new Error("physical read failed before cancellation");
    const cleanup = new Error("physical close failed");
    const reason = { caller: "final-close" };
    const original = prototype.read;
    let release: (() => Promise<void>) | undefined;
    let attempts = 0;
    const read = vi
      .spyOn(prototype, "read")
      .mockImplementationOnce(async function (
        this: FileHandle,
        ...args: Parameters<FileHandle["read"]>
      ) {
        release = this.close.bind(this);
        this.close = async () => {
          attempts += 1;
          if (attempts === 1) {
            controller.abort(reason);
            throw cleanup;
          }
          await release!();
        };
        if (readFails) throw primary;
        return Reflect.apply(original, this, args);
      });
    onTestFinished(async () => {
      read.mockRestore();
      await release?.();
    });
    const result = await client.execute(
      "inspect_plist",
      { path },
      { signal: controller.signal },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected retained close failure");
    const failure = result.error.cause;
    expect(failure).toBeInstanceOf(ArtifactFileCleanupFailure);
    if (!(failure instanceof ArtifactFileCleanupFailure))
      throw new Error("Expected physical owner");
    expect(failure.fileCleanupFailure.outcome).toEqual(
      readFails
        ? { kind: "failed", cause: primary }
        : { kind: "completed", value: "xml" },
    );
    expect(result.error.cleanupIncomplete).toBe(true);
    expect((await client.close()).ok).toBe(true);
    expect(result.error.cleanupIncomplete).toBe(false);
    expect(resolvedAnalysisError(result.error).cause).toBe(
      readFails ? primary : reason,
    );
  });

it.each([null, 0, new ProviderCleanupError("foreign", ["unowned"], {})])(
  "preserves pre-admission abort reason %s without adopting its resource authority",
  async (reason) => {
    const { client, path, runner } = await fixture();
    const run = vi.spyOn(runner, "run");
    onTestFinished(() => run.mockRestore());
    const controller = new AbortController();
    controller.abort(reason);
    const result = await client.execute(
      "inspect_plist",
      { path },
      { signal: controller.signal },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected pre-admission cancellation");
    expect(result.error.cause).toBe(reason);
    expect(result.error.cleanupIncomplete).toBe(false);
    expect(result.error.cleanupResources).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  },
);

it("retains a failed admission close before any native command", async () => {
  const { client, path, runner } = await fixture();
  const run = vi.spyOn(runner, "run");
  const close = vi
    .spyOn(OwnedFileHandle.prototype, "close")
    .mockRejectedValueOnce(new Error("controlled admission close failure"));
  onTestFinished(() => {
    close.mockRestore();
    run.mockRestore();
  });
  const result = await client.execute("inspect_plist", { path });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected failed admission close");
  expect(result.error.cleanupResources).toContain(path);
  expect(result.error.cleanupIncomplete).toBe(true);
  expect(run).not.toHaveBeenCalled();
  expect((await client.close()).ok).toBe(true);
  expect(result.error.cleanupIncomplete).toBe(false);
});

it("preserves an opaque cancellation observed during successful prefix close", async () => {
  const { client, path, prototype } = await fixture();
  const controller = new AbortController();
  const reason = new ProviderCleanupError("foreign", ["unowned-resource"], {});
  const original = prototype.read;
  const read = vi
    .spyOn(prototype, "read")
    .mockImplementationOnce(async function (
      this: FileHandle,
      ...args: Parameters<FileHandle["read"]>
    ) {
      const closed = this.close.bind(this);
      this.close = async () => {
        await closed();
        controller.abort(reason);
      };
      return Reflect.apply(original, this, args);
    });
  onTestFinished(() => read.mockRestore());
  const result = await client.execute(
    "inspect_plist",
    { path },
    { signal: controller.signal },
  );
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected late cancellation");
  expect(result.error).toMatchObject({
    operation: "inspect_plist",
    cause: reason,
    cleanupIncomplete: false,
  });
  expect(result.error.cleanupResources).not.toContain("unowned-resource");
  expect((await client.close()).ok).toBe(true);
});

it("joins an admitted prefix read when client close starts concurrently", async () => {
  const { client, path, prototype } = await fixture();
  let enter!: () => void;
  let resume!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const original = prototype.read;
  const read = vi
    .spyOn(prototype, "read")
    .mockImplementationOnce(async function (
      this: FileHandle,
      ...args: Parameters<FileHandle["read"]>
    ) {
      enter();
      await gate;
      return Reflect.apply(original, this, args);
    });
  onTestFinished(() => {
    resume();
    read.mockRestore();
  });
  const inspecting = client.execute("inspect_plist", { path });
  await entered;
  let finished = false;
  const closing = client.close().then((result) => {
    finished = true;
    return result;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(finished).toBe(false);
  resume();
  expect((await inspecting).ok).toBe(true);
  expect((await closing).ok).toBe(true);
});
