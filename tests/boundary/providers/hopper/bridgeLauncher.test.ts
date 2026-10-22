import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { access, chmod, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

import {
  HopperApplicationLauncher,
  type HopperApplicationLauncherOptions,
  linuxDemoLaunch,
  usesLinuxDemo,
} from "../../../../src/hopper/BridgeLauncher.js";

import { ProviderProcessSupervisor } from "../../../../src/process/ProviderProcess.js";
import { err, ok } from "../../../../src/domain/result.js";

import { HopperReleaseError } from "../../../../src/application/HopperReleaseFeed.js";
import { projectAnalysisError } from "../../../../src/domain/analysisErrorProjection.js";
import { ArtifactResourceScope } from "../../../../src/artifacts/ArtifactResourceScope.js";
import { PrivateRuntimeRoot } from "../../../../src/process/PrivateRuntimeRoot.js";
import { HopperClient } from "../../../../src/hopper/HopperClient.js";

const readyDirectDisplay = async () =>
  ({
    ok: true,
    strategy: "direct",
    diagnostic: {
      component: "hopper_private_display",
      operation: "probe",
      status: "ready",
      failure_code: null,
      reason: "ready",
      socket_directory: "/tmp/.X11-unix",
      socket_directory_mode: "1777",
      mount_read_only: false,
      effective_socket_directory_mode: "1777",
      effective_mount_read_only: false,
      wsl: false,
      strategy: "direct",
      fallback_reason: null,
      xvfb_stderr_bytes: 0,
    },
  }) as const;

const execFileAsync = promisify(execFile);
const verifiedSha256 = "0".repeat(64);
const demoHelperPath = fileURLToPath(
  new URL("../../../../scripts/hopper-demo-x11.py", import.meta.url),
);

const options = (launcherPath: string): HopperApplicationLauncherOptions => ({
  environment: {},
  launcherPath,
  targetPath: "/target",
  targetKind: "executable",
  loaderArgs: [],
  bridgeScriptPath: "/rea/hopper_bridge.py",
  launchMode: "verified_linux_demo",
  demoHelperPath: "/rea/hopper-demo-x11.py",
});

it("retains cancelled verification cleanup through client shutdown and retries it", async () => {
  const directory = await createTestTempDirectory("rea-publisher-cancel-");
  const targetPath = join(directory, "target");
  await writeFile(targetPath, "source-owned target");
  const root = await PrivateRuntimeRoot.create({
    prefix: "rea-publisher-pending-",
  });
  const resources = new ArtifactResourceScope();
  let allowCleanup = false;
  expect(
    await resources.release({
      kind: "private-runtime-root",
      resource: root.path,
      root: {
        path: root.path,
        close: async () => {
          if (!allowCleanup)
            throw new Error("Fixture publisher cleanup denied");
          await root.close();
        },
      },
    }),
  ).toMatchObject({ kind: "failed" });
  const controller = new AbortController();
  const verify = vi.fn(async () => {
    controller.abort();
    return err(
      new HopperReleaseError(
        "cleanup_failed",
        "Publisher cleanup remains owned",
      ),
    );
  });
  const launcher = new HopperApplicationLauncher(
    {
      ...options(process.execPath),
      targetPath,
    },
    {
      verifyLinuxLauncher: verify,
      retryPublisherCleanup: () => resources.close(),
      selectPrivateDisplay: readyDirectDisplay,
    },
  );
  const client = new HopperClient({ launcher, startupTimeoutMs: 5_000 });
  try {
    const started = await client.start(controller.signal);
    expect(started).toMatchObject({
      ok: false,
      error: { cleanupIncomplete: true, cleanupResources: [root.path] },
    });
    if (started.ok)
      throw new Error("Expected cancelled startup with pending cleanup");
    expect(projectAnalysisError(started.error)).toMatchObject({
      code: "cleanup_incomplete",
      details: {
        diagnostics: { primary_error: { code: "cancelled" } },
        resources: [root.path],
      },
    });
    expect(await client.start()).toMatchObject({
      ok: false,
      error: { cleanupIncomplete: true },
    });
    expect(verify).toHaveBeenCalledOnce();
    expect(await client.close()).toMatchObject({
      ok: false,
      error: { cleanupIncomplete: true },
    });
    await access(root.path);
    allowCleanup = true;
    expect(await client.close()).toEqual({ ok: true, value: null });
    await expect(access(root.path)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    allowCleanup = true;
    await client.close();
    await resources.close();
  }
});

describe("Hopper bridge launcher selection", () => {
  it.each([
    "/opt/hopper/bin/Hopper",
    "/usr/local/bin/hopper",
    "/workspace/bin/hopper-wrapper",
  ])(
    "routes launcher spelling %s through the explicitly selected demo adapter",
    (path) => {
      expect(usesLinuxDemo(options(path))).toBe(true);
    },
  );

  it("does not infer demo behavior from a native launcher's basename", () => {
    expect(
      usesLinuxDemo({
        environment: {},
        launcherPath: "/opt/hopper/bin/Hopper",
        targetPath: "/target",
        targetKind: "executable",
        loaderArgs: [],
        bridgeScriptPath: "/rea/hopper_bridge.py",
        launchMode: "native",
      }),
    ).toBe(false);
  });

  it("builds the namespace launch without sudo or a shell command", () => {
    const launch = linuxDemoLaunch(
      options("/opt/hopper/bin/Hopper"),
      {
        directory: "/tmp/rea-fixture",
        socketPath: "/tmp/rea-fixture/bridge.sock",
        token: "not-forwarded",
        runId: "fixture-run",
      },
      ["--analysis"],
      "user-mount-namespace",
      verifiedSha256,
    );

    expect(launch).toMatchObject({
      command: "/usr/bin/unshare",
      ownershipCommand: "/usr/bin/python3",
      args: [
        "--user",
        "--map-root-user",
        "--mount",
        "--propagation",
        "private",
        "/usr/bin/python3",
        "/rea/hopper-demo-x11.py",
        "--owner-stdin",
        "--strategy",
        "user-mount-namespace",
        "--mount-private-x11",
        "--hopper",
        "/opt/hopper/bin/Hopper",
        "--expected-launcher-sha256",
        verifiedSha256,
        "--socket",
        "/tmp/rea-fixture/bridge.sock",
        "--",
        "/opt/hopper/bin/Hopper",
        "--analysis",
      ],
    });
    expect(launch?.args).not.toContain("sudo");
    expect(launch?.args).not.toContain("-c");
  });

  it("keeps an ordinary Linux launch on the direct Python adapter", () => {
    expect(
      linuxDemoLaunch(
        options("/opt/hopper/bin/Hopper"),
        {
          directory: "/tmp/rea-fixture",
          socketPath: "/tmp/rea-fixture/bridge.sock",
          token: "not-forwarded",
          runId: "fixture-run",
        },
        [],
        "direct",
        verifiedSha256,
      ),
    ).toMatchObject({
      command: "/usr/bin/python3",
      args: [
        "/rea/hopper-demo-x11.py",
        "--owner-stdin",
        "--strategy",
        "direct",
        "--hopper",
        "/opt/hopper/bin/Hopper",
        "--expected-launcher-sha256",
        verifiedSha256,
        "--socket",
        "/tmp/rea-fixture/bridge.sock",
        "--",
        "/opt/hopper/bin/Hopper",
      ],
    });
  });

  it("rejects launcher bytes changed since publisher verification before executing them", async () => {
    const directory = await createTestTempDirectory("rea-hopper-wrapper-");
    const wrapper = join(directory, "hopper-wrapper");
    const marker = join(directory, "executed");
    try {
      await writeFile(wrapper, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
      await chmod(wrapper, 0o700);
      await expect(
        execFileAsync(
          "python3",
          [
            demoHelperPath,
            "--hopper",
            wrapper,
            "--expected-launcher-sha256",
            verifiedSha256,
            "--socket",
            join(directory, "bridge.sock"),
            "--",
            wrapper,
          ],
          { timeout: 3_000 },
        ),
      ).rejects.toMatchObject({
        code: 72,
        stderr: expect.stringContaining(
          '"failure_code":"unsupported_hopper_build"',
        ),
      });
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

it("launches Hopper helpers with the caller-selected environment without restoring ambient values", async () => {
  const directory = await createTestTempDirectory("rea-hopper-selected-env-");
  const targetPath = join(directory, "target");
  await writeFile(targetPath, "fixture target");
  const launcher = new HopperApplicationLauncher({
    environment: { REA_SELECTED_VALUE: "caller-value" },
    launcherPath: process.execPath,
    targetPath,
    targetKind: "executable",
    loaderArgs: [
      "-e",
      "process.stdout.write(JSON.stringify({ selected: process.env.REA_SELECTED_VALUE ?? null, home: process.env.HOME ?? null }))",
      "--",
    ],
    bridgeScriptPath: "/rea/unused-bridge.py",
    launchMode: "native",
  });
  const launched = await launcher.launch({
    directory,
    socketPath: join(directory, "bridge.sock"),
    token: "fixture-token",
    runId: randomUUID(),
  });
  if (!launched.ok) throw launched.error;
  const supervisor = new ProviderProcessSupervisor(launched.value);
  try {
    expect(await supervisor.waitForOutputClose(5_000)).toBe(true);
    expect(JSON.parse(supervisor.snapshot().stdout.text)).toEqual({
      selected: "caller-value",
      home: null,
    });
    expect(await supervisor.stop()).toMatchObject({
      status: "verified-cleanup",
    });
  } finally {
    await supervisor.stop();
    await launched.value.releaseLease?.();
  }
});

it.skipIf(process.platform !== "linux")(
  "gives the demo helper a live owner stream through Node's actual stdio transport",
  async () => {
    const directory = await createTestTempDirectory("rea-hopper-owner-stdio-");
    const selectPrivateDisplay = vi.fn(readyDirectDisplay);
    const launcher = new HopperApplicationLauncher(
      {
        ...options(process.execPath),
        launchMode: "verified_linux_demo",
        demoHelperPath: fileURLToPath(
          new URL("../../../fixtures/hopperLifetimeLaunch.py", import.meta.url),
        ),
      },
      {
        verifyLinuxLauncher: async () =>
          ok({
            sha256: verifiedSha256,
            version: "fixture",
            primaryFingerprint: "0".repeat(40),
            signingFingerprint: "1".repeat(40),
            source: "signed_package_cache",
          }),
        selectPrivateDisplay,
      },
    );
    const launched = await launcher.launch({
      directory,
      socketPath: join(directory, "bridge.sock"),
      token: "fixture-token",
      runId: randomUUID(),
    });
    if (!launched.ok) throw launched.error;
    expect(selectPrivateDisplay).toHaveBeenCalledOnce();
    const supervisor = new ProviderProcessSupervisor(launched.value);
    try {
      expect(await supervisor.waitForOutputClose(5_000)).toBe(true);
      expect(supervisor.snapshot().exitCode).toBe(0);
      expect(JSON.parse(supervisor.snapshot().stdout.text)).toEqual({
        owner_alive: true,
      });
    } finally {
      await supervisor.stop();
      await launched.value.releaseLease?.();
    }
  },
);

it.skipIf(process.platform !== "linux")(
  "preserves a publisher rejection through the public error without inventing a helper exit",
  async () => {
    const directory = await createTestTempDirectory("rea-publisher-rejection-");
    const targetPath = join(directory, "target");
    await writeFile(targetPath, "fixture target");
    const rejected = new HopperReleaseError(
      "unsupported_hopper_build",
      "Fixture launcher is outside verified releases",
    );
    const selectPrivateDisplay = vi.fn(readyDirectDisplay);
    const launcher = new HopperApplicationLauncher(
      { ...options("/unused/Hopper"), targetPath },
      {
        selectPrivateDisplay,
        verifyLinuxLauncher: async () => err(rejected),
      },
    );
    const result = await launcher.launch({
      directory,
      socketPath: join(directory, "bridge.sock"),
      token: "fixture-token",
      runId: randomUUID(),
    });
    if (result.ok) throw new Error("Unverified launcher started");
    const projected = projectAnalysisError(result.error);
    expect(projected).toMatchObject({
      code: "provider_unavailable",
      details: {
        stage: "launch",
        launch_rejection: {
          boundary: "publisher_verification",
          reason: rejected.reason,
        },
      },
    });
    expect(projected.details).not.toHaveProperty("exit_code");
    expect(projected.details).not.toHaveProperty("launcher");
    expect(selectPrivateDisplay).not.toHaveBeenCalled();
  },
);
