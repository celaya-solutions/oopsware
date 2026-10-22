import { execFileSync } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest.skipIf(process.platform === "win32")(
  "doctor rejects an IDA registration FIFO without waiting for a writer",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-ida-doctor-fifo-");
    const registration = join(root, "registration.json");
    execFileSync("mkfifo", [registration], { timeout: 5_000 });
    const result = await cli.run({
      arguments: ["doctor", "--provider", "ida", "--json"],
      environment: { HOME: root, REA_IDA_MCP_CONFIG: registration },
      timeoutMs: 10_000,
    });
    expect(result.exitCode, result.stderr).toBe(1);
    expect(result.json).toMatchObject({
      providerInspections: expect.arrayContaining([
        expect.objectContaining({
          id: "ida",
          available: false,
          checks: expect.arrayContaining([
            expect.objectContaining({
              name: "registration",
              ok: false,
              detail: expect.stringContaining("regular JSON file"),
            }),
          ]),
        }),
      ]),
    });
  },
);

cliTest.skipIf(process.platform !== "darwin").for([true, false])(
  "doctor checks the IDA workspace parent without creating entries (usable=%s)",
  async (usable, { cli }) => {
    const root = await createTestTempDirectory("rea-ida-doctor-parent-");
    const parent = join(root, "parent");
    await mkdir(parent);
    // Keep the caller's unnormalized spelling; allocation normalizes it too.
    const workspaceRoot = usable
      ? `${parent}/missing/../.`
      : join(parent, "absent");
    const registration = join(root, "registration.json");
    await writeFile(
      registration,
      JSON.stringify({
        command: join(root, "provider-must-not-launch"),
        mode: "headless",
        workspaceRoot,
      }),
    );
    const result = await cli.run({
      arguments: ["doctor", "--provider", "ida", "--json"],
      environment: { HOME: root, REA_IDA_MCP_CONFIG: registration },
      timeoutMs: 10_000,
    });
    expect(result.exitCode, result.stderr).toBe(usable ? 0 : 1);
    expect(result.json).toMatchObject({
      providerInspections: expect.arrayContaining([
        expect.objectContaining({
          id: "ida",
          available: usable,
          checks: expect.arrayContaining([
            expect.objectContaining({
              name: "private_workspace",
              ok: usable,
              detail: expect.stringContaining(workspaceRoot),
            }),
          ]),
        }),
      ]),
    });
    expect(await readdir(parent)).toEqual([]);
  },
);
