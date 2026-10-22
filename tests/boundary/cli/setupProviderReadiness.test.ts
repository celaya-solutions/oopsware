import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { z } from "zod";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { writeFakeKuna } from "../providers/kuna/fakeKuna.js";

cliTest.skipIf(process.platform === "win32").for(["blocked", "ready"] as const)(
  "setup dry-run advertises Kuna only with a %s cache",
  async (cache, { cli }) => {
    const root = await createTestTempDirectory("rea-setup-provider-readiness-");
    const home = join(root, "home");
    await mkdir(home);
    const command = await writeFakeKuna(root);
    const cachePath = join(root, "cache");
    if (cache === "blocked") await writeFile(cachePath, "not a directory");
    else await mkdir(cachePath);

    const result = await cli.run({
      arguments: ["setup", "--client", "claude_code", "--dry-run", "--json"],
      environment: {
        HOME: home,
        USERPROFILE: home,
        HOPPER_LAUNCHER_PATH: join(root, "missing-hopper"),
        GHIDRA_INSTALL_DIR: join(root, "missing-ghidra"),
        REA_KUNA_COMMAND: command,
        REA_KUNA_CACHE_DIR: cachePath,
      },
      timeoutMs: 20_000,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.json).toMatchObject({
      status: "planned",
      doctor: {
        providerInspections: expect.arrayContaining([
          expect.objectContaining({
            id: "kuna",
            available: true,
            checks: expect.arrayContaining([
              expect.objectContaining({
                name: "cache",
                ok: cache === "ready",
              }),
            ]),
          }),
        ]),
      },
    });
    const summary = z
      .object({
        doctor: z.object({ availableProviders: z.array(z.string()) }),
      })
      .parse(result.json);
    expect(summary.doctor.availableProviders.includes("kuna")).toBe(
      cache === "ready",
    );
    await expect(access(join(home, ".claude.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);
