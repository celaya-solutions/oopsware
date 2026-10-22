import { expect, it, onTestFinished, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { ArtifactFileCleanupFailure } from "../artifacts/ArtifactFileOperation.js";
import { ArtifactAnalysisResources } from "./ArtifactAnalysisResources.js";
import { readStableArtifact } from "../artifacts/readStableArtifact.js";
import { ok } from "../domain/result.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import {
  BOUNDED_PRODUCER_LIMITS,
  clampLinuxResourceLimits,
  prlimitArgumentVector,
  readLinuxResourceLimits,
} from "./LinuxResourceLimits.js";

const kernel = vi.hoisted(() => ({ path: "", denied: false, opens: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const filesystem = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...filesystem,
    open: async (...args: Parameters<typeof filesystem.open>) => {
      if (args[0] !== "/proc/self/limits" || kernel.path === "")
        return filesystem.open(...args);
      const file = await filesystem.open(kernel.path, args[1], args[2]);
      kernel.opens += 1;
      const close = file.close.bind(file);
      // Keep fixture ownership even when an assertion interrupts retry checks.
      onTestFinished(close);
      file.close = async () => {
        if (kernel.denied) throw new Error("Kernel descriptor close denied");
        await close();
      };
      return file;
    },
  };
});
const configured = {
  address_space_bytes: 1073741824,
  file_bytes: 67108864,
  cpu_seconds: 30,
};
const report = (
  memory: string,
  file = "unlimited unlimited",
  cpu = "unlimited unlimited",
) =>
  `Limit Soft Limit Hard Limit Units\nMax address space ${memory} bytes\nMax file size ${file} bytes\nMax cpu time ${cpu} seconds\n`;
it("keeps configured ceilings below unlimited or larger inherited limits", () => {
  expect(
    clampLinuxResourceLimits(configured, report("unlimited unlimited")),
  ).toEqual(configured);
  expect(
    clampLinuxResourceLimits(
      configured,
      report("18446744073709551615 18446744073709551615"),
    ),
  ).toEqual(configured);
});
it("preserves stricter soft limits and lower hard ceilings, including zero", () => {
  expect(
    clampLinuxResourceLimits(
      configured,
      report("268435456 2147483648", "0 1048576", "10 20"),
    ),
  ).toEqual({ address_space_bytes: 268435456, file_bytes: 0, cpu_seconds: 10 });
  expect(
    clampLinuxResourceLimits(configured, report("268435456 536870912")),
  ).toMatchObject({ address_space_bytes: 268435456 });
});
it("refuses missing, ambiguous or malformed kernel limits before launch", () => {
  for (const value of [
    "",
    report("invalid unlimited"),
    report("unlimited unlimited") + "Max address space 1 2 bytes\n",
  ])
    expect(() => clampLinuxResourceLimits(configured, value)).toThrow();
});
it("pins the shared producer budget in one place", () => {
  expect(BOUNDED_PRODUCER_LIMITS).toEqual({
    input_bytes: 33554432,
    output_bytes: 4194304,
    command_timeout_ms: 30000,
    address_space_bytes: 1073741824,
    file_bytes: 67108864,
    cpu_seconds: 30,
  });
});
it("pairs each effective ceiling with itself before the producer argv", () => {
  expect(
    prlimitArgumentVector(BOUNDED_PRODUCER_LIMITS, "/bin/producer"),
  ).toEqual([
    "--as=1073741824:1073741824",
    "--fsize=67108864:67108864",
    "--cpu=30:30",
    "--core=0:0",
    "--",
    "/bin/producer",
  ]);
  expect(
    prlimitArgumentVector(
      clampLinuxResourceLimits(BOUNDED_PRODUCER_LIMITS, report("10 20")),
      "/bin/producer",
    ),
  ).toEqual([
    "--as=10:10",
    "--fsize=67108864:67108864",
    "--cpu=30:30",
    "--core=0:0",
    "--",
    "/bin/producer",
  ]);
});

it.each([
  ["completed", true],
  ["failed", true],
  ["completed", false],
  ["failed", false],
] as const)(
  "retains exact cleanup ownership after a %s read (scoped=%s)",
  async (outcome, scoped) => {
    const directory = await createTestTempDirectory("rea-kernel-limits-");
    kernel.path = join(directory, "limits");
    kernel.denied = true;
    const scope = new ArtifactResourceScope();
    onTestFinished(async () => {
      kernel.denied = false;
      await scope.close();
      kernel.path = "";
    });
    await writeFile(
      kernel.path,
      outcome === "completed" ? report("unlimited unlimited") : "invalid",
    );
    const failure: unknown = await readLinuxResourceLimits(
      configured,
      scoped ? scope : undefined,
    ).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(ArtifactFileCleanupFailure);
    if (!(failure instanceof ArtifactFileCleanupFailure))
      throw new Error("Expected exact descriptor cleanup ownership");
    const physical = failure.fileCleanupFailure;
    expect(physical.outcome.kind).toBe(outcome);
    if (physical.outcome.kind === "completed")
      expect(physical.outcome.value).toEqual(configured);
    else
      expect(physical.outcome.cause).toMatchObject({
        message: "Cannot establish inherited Linux limit: Max address space",
      });
    expect(physical.owner.handle.fd).toBeGreaterThanOrEqual(0);
    if (scoped)
      await expect(scope.retryCleanup()).rejects.toMatchObject({
        cleanupLeases: [failure.cleanupLease],
      });
    else
      await expect(failure.cleanupLease.release()).rejects.toThrow(
        "Kernel descriptor close denied",
      );
    kernel.denied = false;
    if (scoped) await scope.retryCleanup();
    else await failure.cleanupLease.release();
    expect(failure.cleanupLease.released).toBe(true);
    expect(physical.owner.handle.fd).toBe(-1);
    expect(scope.hasPending).toBe(false);
    expect(failure.fileCleanupFailure).toBe(physical);
  },
);

it("readmits analysis and resolves the original cleanup error after kernel descriptor recovery", async () => {
  const directory = await createTestTempDirectory("rea-kernel-admission-");
  kernel.path = join(directory, "limits");
  kernel.denied = true;
  const resources = new ArtifactAnalysisResources(
    "kernel-test",
    "read-limits",
    readStableArtifact,
    readLinuxResourceLimits,
    { message: "busy", details: {} },
  );
  onTestFinished(async () => {
    kernel.denied = false;
    await resources.close();
    kernel.path = "";
  });
  await writeFile(kernel.path, report("unlimited unlimited"));
  const read = () =>
    resources.run(async () => ok(await resources.readLimits(configured)));
  const first = await read();
  if (first.ok) throw new Error("Expected denied descriptor cleanup");
  expect(first.error.cleanupIncomplete).toBe(true);
  const opened = kernel.opens;
  const blocked = await read();
  expect(blocked.ok).toBe(false);
  expect(kernel.opens).toBe(opened);
  kernel.denied = false;
  const recovered = await read();
  expect(recovered).toEqual(ok(configured));
  expect(kernel.opens).toBe(opened + 1);
  expect(first.error.cleanupIncomplete).toBe(false);
  if (!blocked.ok) expect(blocked.error.cleanupIncomplete).toBe(false);
});
