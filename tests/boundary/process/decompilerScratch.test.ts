import { randomUUID } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, expect, it } from "vitest";
import {
  decompilerCleanupFailure,
  withDecompilerScratch,
} from "../../../src/jvm/decompilerScratch.js";
import { OwnedCommandFailure } from "../../../src/process/OwnedCommand.js";
import { spawnOwnedProviderProcess } from "../../../src/process/ProviderProcess.js";
import { cleanupOwnedProcessGroup } from "../../../src/process/ProcessOwnership.js";
import { prepareProcessOwnershipInspection } from "../../../src/process/ProcessOwnershipObservation.js";
import { AnalysisCancelledError } from "../../../src/domain/analysisErrorCore.js";

beforeAll(() => prepareProcessOwnershipInspection());

it("retains scratch and exact process ownership through refused cleanup and retries before new work", async () => {
  let denied = true;
  let scratch = "";
  const controller = new AbortController();
  let mapped: ReturnType<typeof decompilerCleanupFailure> = null;
  try {
    const failure = await withDecompilerScratch(
      "test-decompiler",
      async (path, run) => {
        scratch = path;
        await writeFile(join(path, "evidence"), "keep until stopped");
        return run(
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
                    controller.abort("cancel during cleanup");
                    return { cleaned: false, reason: "controlled refusal" };
                  }
                  return cleanupOwnedProcessGroup(acquired.ownership);
                },
              };
            },
          },
        );
      },
    ).catch((cause: unknown) => cause);
    expect(await readFile(join(scratch, "evidence"), "utf8")).toBe(
      "keep until stopped",
    );
    mapped = decompilerCleanupFailure(
      failure,
      "decompile_dex_class",
      (primary) => {
        expect(primary).toBeInstanceOf(OwnedCommandFailure);
        return new AnalysisCancelledError("decompile_dex_class", {
          cause: primary,
        });
      },
    );
    expect(mapped?.cleanupIncomplete).toBe(true);
    expect(mapped?.cleanupResources).toContain(scratch);
    let ran = false;
    await expect(
      withDecompilerScratch("test-decompiler", async () => {
        ran = true;
      }),
    ).rejects.toThrow("cleanup is incomplete");
    expect(ran).toBe(false);
    expect(await readFile(join(scratch, "evidence"), "utf8")).toBe(
      "keep until stopped",
    );
  } finally {
    denied = false;
    await withDecompilerScratch("test-decompiler", async () => undefined);
  }
  await expect(access(scratch)).rejects.toMatchObject({ code: "ENOENT" });
  expect(mapped?.cleanupIncomplete).toBe(false);
});
