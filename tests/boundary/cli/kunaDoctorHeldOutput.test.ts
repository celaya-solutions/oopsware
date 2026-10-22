import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect } from "vitest";
import { z } from "zod";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import {
  cleanupOwnedProcessGroup,
  type OwnedProcessGroup,
} from "../../../src/process/ProcessOwnership.js";
import { observeOwnedProcessGroups } from "../../../src/process/ProcessOwnershipObservation.js";

cliTest.skipIf(!["darwin", "linux"].includes(process.platform))(
  "doctor returns bounded Kuna version diagnostics when an exited probe's descendant holds its output pipe",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-kuna-doctor-held-output-");
    const home = join(root, "home");
    const executable = join(root, "kuna");
    const marker = join(root, "probe-owner.json");
    await mkdir(home);
    await writeFile(
      executable,
      `#!${process.execPath}
const fs = require("node:fs");
const { spawn } = require("node:child_process");
if (process.argv[2] !== "--version") process.exit(7);
const child = spawn(process.execPath, ["-e", ${JSON.stringify(
        `process.on("SIGTERM", () => {}); setTimeout(() => process.exit(0), 28000);`,
      )}], { stdio: "inherit" });
fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
  leaderPid: process.pid,
  descendantPid: child.pid,
  runId: process.env.REA_PROCESS_RUN_ID,
}));
process.stdout.write("kuna 1.833\\n");
process.stderr.write("probe stderr\\n");
process.exit(0);
`,
      { mode: 0o700 },
    );
    await chmod(executable, 0o700);

    const pending = cli.run({
      arguments: ["doctor", "--provider", "kuna", "--json"],
      environment: {
        HOME: home,
        USERPROFILE: home,
        HOPPER_LAUNCHER_PATH: join(root, "missing-hopper"),
        GHIDRA_INSTALL_DIR: join(root, "missing-ghidra"),
        REA_KUNA_COMMAND: executable,
        REA_KUNA_CACHE_DIR: join(root, "kuna-cache"),
        REA_LOG_LEVEL: "silent",
      },
      // Leave room for the production probe deadline, while still bounding a
      // regression that waits for the descendant's finite fallback expiry.
      timeoutMs: 20_000,
    });
    let ownership: OwnedProcessGroup | undefined;
    const startedAt = Date.now();
    try {
      let markerContents: string | undefined;
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          markerContents = await readFile(marker, "utf8");
          break;
        } catch (cause: unknown) {
          if (
            !(
              cause instanceof Error &&
              "code" in cause &&
              cause.code === "ENOENT"
            )
          )
            throw cause;
        }
        await delay(50);
      }
      expect(markerContents, "fake Kuna probe did not start").toBeDefined();
      const observed = z
        .strictObject({
          leaderPid: z.number().int().positive(),
          descendantPid: z.number().int().positive(),
          runId: z.string().min(1),
        })
        .parse(JSON.parse(markerContents!));
      ownership = {
        leaderPid: observed.leaderPid,
        processGroupId: observed.leaderPid,
        runId: observed.runId,
      };

      const result = await pending;
      expect(Date.now() - startedAt).toBeLessThan(16_000);
      expect(result.exitCode, result.stderr).toBe(1);
      expect(result.json).toMatchObject({
        providerInspections: expect.arrayContaining([
          expect.objectContaining({
            id: "kuna",
            available: false,
            checks: expect.arrayContaining([
              expect.objectContaining({
                name: "installation",
                ok: false,
                code: "version_unresolved",
                details: expect.objectContaining({
                  probe_failure_reason: "timeout",
                  exit_code: 0,
                  signal: null,
                  stdout: "kuna 1.833\n",
                  stderr: "probe stderr\n",
                  stdout_bytes: 11,
                  stdout_observed_bytes: 11,
                  stderr_bytes: 13,
                  stderr_observed_bytes: 13,
                  diagnostic_truncated: false,
                  output_incomplete: false,
                  output_truncated: false,
                  deadline_ms: 10_000,
                }),
              }),
            ]),
          }),
        ]),
      });
      const groups = await observeOwnedProcessGroups(ownership.runId, [
        ownership.processGroupId,
      ]);
      expect(groups.get(ownership.processGroupId)).toEqual({ state: "empty" });
    } finally {
      if (ownership !== undefined) {
        expect((await cleanupOwnedProcessGroup(ownership)).cleaned).toBe(true);
      }
      await pending;
    }
  },
);
