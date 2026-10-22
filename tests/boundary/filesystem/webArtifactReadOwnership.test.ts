import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";

const injected = vi.hoisted(() => ({
  sourcePath: undefined as string | undefined,
  abortController: undefined as AbortController | undefined,
  failClose: false,
  closeAttempts: 0,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (args[0] !== injected.sourcePath) return handle;
      const createReadStream = handle.createReadStream.bind(handle);
      handle.createReadStream = (options) => {
        injected.abortController?.abort();
        return createReadStream(options);
      };
      const close = handle.close.bind(handle);
      handle.close = async () => {
        injected.closeAttempts += 1;
        if (injected.failClose) throw new Error("fixture close refusal");
        await close();
      };
      return handle;
    },
  };
});

import { WebModuleTraceService } from "../../../src/application/WebModuleTraceService.js";
import { finishAnalysisCommand } from "../../../src/cli/finishAnalysisCommand.js";
import { LocalWebModuleArtifacts } from "../../../src/browser/modules/WebModuleArtifacts.js";
import { ProviderCleanupError } from "../../../src/domain/providerCleanupError.js";
import { AnalysisCancelledError } from "../../../src/domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { webModuleArtifactsFixture } from "../../fixtures/webModuleTrace.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("retains cancelled source read ownership until service close retries it", async () => {
  const root = await createTestTempDirectory("rea-web-artifact-read-owner-");
  onTestFinished(async () => {
    injected.sourcePath = undefined;
    injected.abortController = undefined;
    injected.failClose = false;
    injected.closeAttempts = 0;
    await rm(root, { recursive: true, force: true });
  });
  const source = 'import "./dep.js";';
  const fixture = webModuleArtifactsFixture(source);
  const manifestPath = join(root, "manifest.json");
  const sourcePath = join(root, "files", "modules", "main.js");
  await mkdir(join(root, "files", "modules"), { recursive: true });
  await writeFile(sourcePath, source);
  await writeFile(manifestPath, JSON.stringify(fixture.manifest));

  injected.sourcePath = sourcePath;
  injected.failClose = true;
  const controller = new AbortController();
  injected.abortController = controller;
  const resolver = {
    resolve: vi.fn(),
    close: vi.fn(async () => undefined),
  };
  const service = new WebModuleTraceService(
    new LocalWebModuleArtifacts(),
    resolver,
  );
  const input = { manifest_path: manifestPath, script_index: 0 };

  const cancelled = await service.trace(input, { signal: controller.signal });
  expect(cancelled.ok).toBe(false);
  if (cancelled.ok) throw new Error("Expected cancelled source read");
  expect(cancelled.error.cleanupIncomplete).toBe(true);
  expect(cancelled.error.cleanupResources).toContain(sourcePath);
  expect(resolver.resolve).not.toHaveBeenCalled();

  injected.abortController = undefined;
  const blocked = await service.trace(input);
  expect(blocked.ok).toBe(false);
  if (blocked.ok) throw new Error("Expected retained cleanup to block load");
  expect(blocked.error.cleanupIncomplete).toBe(true);
  expect(injected.closeAttempts).toBe(2);

  let cleanupFailure: unknown;
  try {
    await service.close();
  } catch (cause) {
    cleanupFailure = cause;
  }
  expect(cleanupFailure).toBeInstanceOf(ProviderCleanupError);
  expect(cleanupFailure).toMatchObject({
    operation: "trace_web_module_imports",
    cleanupResources: [sourcePath],
    diagnostics: { reason: expect.stringContaining("fixture close refusal") },
  });
  expect((cleanupFailure as ProviderCleanupError).cause).toBeInstanceOf(Error);
  expect(resolver.close).toHaveBeenCalledTimes(1);
  expect(injected.closeAttempts).toBe(3);

  const finalized = await finishAnalysisCommand(
    () => service.trace(input),
    service,
    "web-module-artifacts",
    "trace_web_module_imports",
    new AbortController().signal,
  );
  expect(finalized).toMatchObject({
    code: "cleanup_incomplete",
    details: { resources: [sourcePath] },
  });
  expect(resolver.close).toHaveBeenCalledTimes(2);

  injected.failClose = false;
  const attemptsBeforeRetry = injected.closeAttempts;
  await service.close();
  expect(injected.closeAttempts).toBeGreaterThan(attemptsBeforeRetry);
  expect(resolver.close).toHaveBeenCalledTimes(3);
});

it("preserves both web cleanup owners' resources, diagnostics and recovery actions", async () => {
  const artifacts = new ProviderCleanupError(
    "web-artifacts",
    ["artifact-root", "shared-resource"],
    { reason: "artifact cleanup denied" },
    { remediationAction: "Release the retained artifact lease." },
  );
  const resolver = new AnalysisCancelledError("web-resolution", {
    cleanup: {
      reason: "resolver shutdown unconfirmed",
      resources: ["resolver-root", "shared-resource"],
    },
  });
  const service = new WebModuleTraceService(
    {
      load: vi.fn(),
      close: async () => {
        throw artifacts;
      },
    },
    {
      resolve: vi.fn(),
      close: async () => {
        throw resolver;
      },
    },
  );
  const projected = [artifacts, resolver].map(projectAnalysisError);
  await expect(service.close()).rejects.toMatchObject({
    cleanupResources: ["artifact-root", "shared-resource", "resolver-root"],
    diagnostics: { failures: projected },
    remediationAction: projected
      .map(({ remediation }) => remediation.action)
      .join("; "),
  });
});
