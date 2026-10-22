import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it.skipIf(process.platform === "win32")(
  "rejects an exited fixture before returning a lease and removes its profile",
  async () => {
    const root = await createTestTempDirectory("rea-runtime-startup-failure-");
    const helper = new URL(
      "../../../scripts/lib/browser-runtime-fixture-lifecycle.mjs",
      import.meta.url,
    );
    const script = `
      const { startRuntimeFixtureBrowser } = await import(${JSON.stringify(helper.href)});
      // Node rejects Chrome's arguments immediately, exercising actual process exit.
      try {
        const fixture = await startRuntimeFixtureBrowser(process.execPath, 'http://127.0.0.1');
        await fixture.close();
        throw new Error('Expected startup failure');
      } catch (error) {
        if (error._tag !== 'BrowserStartupError') throw error;
        console.log(JSON.stringify({
          failure: error.failure,
          exitCode: error.exitCode,
          stderr: error.stderr,
        }));
      }
    `;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root },
        timeout: 10_000,
      },
    );
    expect(JSON.parse(stdout)).toEqual({
      failure: "exited",
      exitCode: expect.any(Number),
      stderr: expect.stringContaining("bad option"),
    });
    expect(await readdir(root)).toEqual([]);
  },
);
