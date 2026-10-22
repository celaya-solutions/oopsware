import { lstat } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { HopperApplicationLauncher } from "../../../../src/hopper/BridgeLauncher.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

it.each(["failed", "cancelled"] as const)(
  "removes the token-bearing bootstrap and releases the lease after a %s launch",
  async (outcome) => {
    const directory = await createTestTempDirectory("rea-bootstrap-cleanup-");
    const controller = new AbortController();
    if (outcome === "cancelled") controller.abort();
    let releases = 0;
    const launcher = new HopperApplicationLauncher(
      {
        environment: {},
        launcherPath: join(directory, "nonexistent-hopper"),
        targetPath: join(directory, "test-binary"),
        targetKind: "executable",
        loaderArgs: [],
        bridgeScriptPath: join(directory, "bridge.py"),
        launchMode: "native",
      },
      {
        platform: "darwin",
        acquireTargetLease: async () => ({
          acquired: true,
          lease: {
            release: async () => {
              releases++;
            },
          },
        }),
      },
    );
    const result = await launcher.launch(
      {
        directory,
        socketPath: join(directory, "bridge.sock"),
        token: "fixture-token",
        runId: "bootstrap-cleanup",
      },
      { signal: controller.signal },
    );
    expect(result.ok).toBe(false);
    if (outcome === "cancelled")
      expect(result).toMatchObject({
        ok: false,
        error: { _tag: "HopperCancelledError" },
      });
    await expect(lstat(join(directory, "bootstrap.py"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(releases).toBe(1);
  },
);
