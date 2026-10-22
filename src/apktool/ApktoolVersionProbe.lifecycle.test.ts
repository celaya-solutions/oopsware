import { ApktoolCommandCleanup } from "./ApktoolCommandCleanup.js";
import { execFile } from "node:child_process";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";

import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { inspectApktoolClient } from "./ApktoolConfiguration.js";

/**
 * Only an exited process counts as stopped: it is gone, a zombie waiting to
 * be reaped, or absent from `ps`. A failed inspection is not proof of exit.
 */
const alive = async (pid: number): Promise<boolean> => {
  try {
    process.kill(pid, 0);
  } catch (cause: unknown) {
    if ((cause as NodeJS.ErrnoException).code === "ESRCH") return false;
    return true;
  }
  return promisify(execFile)("ps", ["-o", "stat=", "-p", `${pid}`]).then(
    ({ stdout }) => {
      const state = stdout.trim();
      return state !== "" && !state.startsWith("Z");
    },
    // `ps` exits 1 when no process matches; any other failure is unknown.
    (cause: unknown) => (cause as { code?: unknown }).code !== 1,
  );
};

const waitFor = async (check: () => Promise<boolean>, ms: number) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await delay(25);
  }
  return false;
};

const readPids = async (path: string): Promise<readonly number[]> =>
  readFile(path, "utf8")
    .then((text) => JSON.parse(text) as number[])
    .catch(() => []);

// The interpreter is the test runtime itself, so its environment (and the
// ownership run token) is readable on both Linux and macOS.
it.skipIf(process.platform === "win32")(
  "stops an interpreter launcher and its pipe-holding child when the probe is cancelled",
  async () => {
    const root = await createTestTempDirectory("rea-apktool-probe-");
    const pids = join(root, "pids.json");
    const launcher = join(root, "apktool");
    await writeFile(
      launcher,
      [
        `#!${process.execPath}`,
        'const { spawn } = require("node:child_process");',
        'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });',
        `require("node:fs").writeFileSync(${JSON.stringify(pids)}, JSON.stringify([process.pid, child.pid]));`,
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    await chmod(launcher, 0o755);
    const controller = new AbortController();
    const started = performance.now();
    const probe = inspectApktoolClient(
      { command: launcher, commandSource: "environment" },
      commands,
      { signal: controller.signal, environment: process.env },
    ).catch((cause: unknown) => cause);
    try {
      expect(
        await waitFor(async () => (await readPids(pids)).length === 2, 10_000),
      ).toBe(true);
      const launched = await readPids(pids);
      controller.abort();
      // A regressed probe never settles; bound the wait so cleanup still runs.
      const outcome = await Promise.race([
        probe,
        delay(15_000).then(() => "still pending"),
      ]);
      expect(outcome).toBeInstanceOf(AnalysisCancelledError);
      expect(performance.now() - started).toBeLessThan(15_000);
      expect(
        await waitFor(
          async () =>
            (await Promise.all(launched.map(alive))).every((live) => !live),
          5_000,
        ),
      ).toBe(true);
    } finally {
      // A failed assertion must not leave the fixture's processes running.
      controller.abort();
      await Promise.race([probe, delay(10_000)]);
      for (const pid of await readPids(pids))
        if (await alive(pid))
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // Already exited between the check and the signal.
          }
    }
  },
  30_000,
);

let commands = new ApktoolCommandCleanup();
afterEach(async () => {
  await commands.close();
  commands = new ApktoolCommandCleanup();
});
