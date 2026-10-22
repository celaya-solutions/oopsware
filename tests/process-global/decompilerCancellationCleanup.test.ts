import { randomUUID } from "node:crypto";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

const fault = vi.hoisted(() => ({
  work: async (): Promise<never> => {
    throw new Error("not configured");
  },
}));
vi.mock("../../src/androidPackage/decompile.js", async (original) => ({
  ...(await original<typeof import("../../src/androidPackage/decompile.js")>()),
  decompileDexClass: () => fault.work(),
}));
vi.mock("../../src/jvm/decompile.js", async (original) => ({
  ...(await original<typeof import("../../src/jvm/decompile.js")>()),
  decompileClass: () => fault.work(),
}));

import { AndroidPackageProvider } from "../../src/androidPackage/AndroidPackageProvider.js";
import { JvmProvider } from "../../src/jvm/JvmProvider.js";
import { withDecompilerScratch } from "../../src/jvm/decompilerScratch.js";
import { decompileDexClassInputSchema } from "../../src/domain/android/androidArtifact.js";
import { decompileJvmClassInputSchema } from "../../src/domain/jvm/jvm.js";
import { spawnOwnedProviderProcess } from "../../src/process/ProviderProcess.js";
import { cleanupOwnedProcessGroup } from "../../src/process/ProcessOwnership.js";
import {
  ANDROID_TOOLS,
  buildAndroidFixtures,
  type AndroidFixtures,
} from "../fixtures/androidProducers.js";
import {
  buildJvmFixtures,
  JDK_HOME,
  type JvmFixtures,
} from "../fixtures/jvmProducers.js";
import { resolveDex2jar } from "../../src/androidPackage/dex2jar.js";
import { resolveVineflower } from "../../src/jvm/vineflower.js";
import { removeTestWorkspace } from "../support/workspace/workspaceFixture.js";

const available =
  ANDROID_TOOLS !== null &&
  JDK_HOME !== null &&
  (await Promise.all([resolveDex2jar(), resolveVineflower()]).then(
    () => true,
    () => false,
  ));
let root: string;
let android: AndroidFixtures;
let jvm: JvmFixtures;
beforeAll(async () => {
  if (!available) return;
  root = await mkdtemp(join(tmpdir(), "rea-decompiler-cancel-"));
  android = await buildAndroidFixtures(join(root, "android"));
  jvm = await buildJvmFixtures(join(root, "jvm"));
}, 180_000);
afterAll(async () => {
  if (root) await removeTestWorkspace(root);
});

it.skipIf(!available).each(["dex", "jvm"])(
  "preserves %s cleanup ownership when cancellation arrives after decompilation",
  async (kind) => {
    let denied = true;
    let scratch = "";
    const controller = new AbortController();
    fault.work = () =>
      withDecompilerScratch(
        "cancel-fixture",
        async (path, run): Promise<never> => {
          scratch = path;
          await run(
            {
              command: process.execPath,
              arguments: ["-e", "process.exit(2)"],
              runId: randomUUID(),
              cwd: path,
            },
            { timeoutMs: 5000, diagnosticBytes: 1024 },
            {
              signal: controller.signal,
              launcher: async (input) => {
                const acquired = await spawnOwnedProviderProcess(input);
                return {
                  ...acquired,
                  cleanup: async () => {
                    if (denied) {
                      controller.abort("late cancellation");
                      return {
                        cleaned: false,
                        reason: "controlled cleanup refusal",
                      };
                    }
                    return cleanupOwnedProcessGroup(acquired.ownership);
                  },
                };
              },
            },
          );
          throw new Error("expected command failure");
        },
      );
    try {
      const result =
        kind === "dex"
          ? await new AndroidPackageProvider().decompileClass(
              decompileDexClassInputSchema.parse({
                path: android.dex,
                class: "com.example.oops.DataProvider",
              }),
              { signal: controller.signal },
            )
          : await new JvmProvider().decompileClass(
              decompileJvmClassInputSchema.parse({
                path: jvm.app,
                class: "demo.Shapes",
              }),
              { signal: controller.signal },
            );
      expect(controller.signal.aborted).toBe(true);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected cleanup failure");
      expect(result.error.cleanupIncomplete).toBe(true);
      expect(result.error.cleanupResources).toContain(scratch);
      await access(scratch);
      denied = false;
      await withDecompilerScratch("retry-fixture", async () => undefined);
      expect(result.error.cleanupIncomplete).toBe(false);
      await expect(access(scratch)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      denied = false;
      await withDecompilerScratch("retry-fixture", async () => undefined);
    }
  },
);
