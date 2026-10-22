import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { SignatureContext } from "./signaturesTools.js";
import { verifyArtifactSignatureInputSchema } from "../domain/supplyChain/signatures.js";
import { verifyArtifactSignature } from "./signatures.js";
import { OwnedCommandFailure } from "../process/OwnedCommand.js";
import type { ProviderProcessSupervisor } from "../process/ProviderProcess.js";

const state = vi.hoisted(() => ({
  failCleanup: false,
  missingTools: false,
  missingKeytool: false,
  mockJar: false,
  largeReport: false,
  abortOnCleanup: undefined as AbortController | undefined,
  scratch: "",
  commandFailure: undefined as unknown,
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    realpath: async (...args: Parameters<typeof actual.realpath>) => {
      if (state.missingTools && String(args[0]).endsWith("/codesign"))
        throw new Error("missing helper");
      if (state.missingKeytool && String(args[0]).endsWith("/keytool"))
        throw new Error("missing keytool");
      return actual.realpath(...args);
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (String(args[0]).includes("oopsware-signature-")) {
        state.abortOnCleanup?.abort("late caller reason");
        if (state.failCleanup) throw new Error("scratch busy");
      }
      return actual.rm(...args);
    },
  };
});
vi.mock("./signaturesWheel.js", () => ({
  verifyWheel: async (context: SignatureContext) => {
    state.scratch = context.scratch;
    if (state.commandFailure !== undefined)
      await context.run(
        {
          command: process.execPath,
          arguments: [],
          runId: "test-owner",
          hostEnvironment: {},
        },
        { timeoutMs: 1000, diagnosticBytes: 1024 },
      );
    context.report.checks.push({
      id: "completed-fixture",
      status: "passed",
      reason: state.largeReport
        ? "x".repeat(5 * 1024 ** 2)
        : "A completed provider observation.",
    });
  },
}));
vi.mock("../process/OwnedCommand.js", async (original) => ({
  ...(await original<object>()),
  runOwnedCommand: async () => {
    if (state.mockJar)
      return {
        exitCode: 0,
        signal: null,
        stdout: { text: "jar verified.\n", bytes: 14, observedBytes: 14 },
        stderr: { text: "", bytes: 0, observedBytes: 0 },
      };
    throw state.commandFailure;
  },
}));

let root: string;
let path: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "rea-signature-lifecycle-"));
  path = join(root, "input");
  await writeFile(path, "immutable input");
});
afterAll(async () => {
  state.failCleanup = false;
  state.abortOnCleanup = undefined;
  state.commandFailure = undefined;
  await rm(root, { recursive: true, force: true });
});
const input = () =>
  verifyArtifactSignatureInputSchema.parse({ path, kind: "wheel" });

it("keeps a completed observation and opaque cancellation when cleanup triggers cancellation", async () => {
  const controller = new AbortController();
  state.abortOnCleanup = controller;
  const result = await verifyArtifactSignature(input(), {
    signal: controller.signal,
  });
  state.abortOnCleanup = undefined;
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error._tag).toBe("AnalysisCancelledError");
  expect(result.error.cause).toBe("late caller reason");
  expect(result.error.partialObservation).toMatchObject({
    normalized_result: { integrity: { status: "passed" } },
  });
  await expect(readFile(join(state.scratch, "artifact.whl"))).rejects.toThrow();
});

it("retains a failed scratch release and completed facts until the next call retries it", async () => {
  state.failCleanup = true;
  const result = await verifyArtifactSignature(input());
  const scratch = state.scratch;
  state.failCleanup = false;
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.cleanupIncomplete).toBe(true);
  expect(result.error.partialObservation).toMatchObject({
    normalized_result: { integrity: { status: "passed" } },
  });
  expect((await readFile(join(scratch, "artifact.whl"))).toString()).toBe(
    "immutable input",
  );
  expect((await verifyArtifactSignature(input())).ok).toBe(true);
  expect(result.error.cleanupIncomplete).toBe(false);
  await expect(readFile(join(scratch, "artifact.whl"))).rejects.toThrow();
});

it("retains the exact failed process owner with its scratch until stop succeeds", async () => {
  let released = false;
  const stop = vi.fn(async () =>
    released
      ? { status: "verified-cleanup" as const }
      : { status: "incomplete" as const, reason: "still owned" },
  );
  state.commandFailure = new OwnedCommandFailure(
    "cancelled",
    "command cancelled",
    null,
    "still owned",
    undefined,
    ["owned-process"],
    { stop } as unknown as ProviderProcessSupervisor,
  );
  const result = await verifyArtifactSignature(input());
  const scratch = state.scratch;
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.cleanupIncomplete).toBe(true);
  expect(result.error.partialObservation).toBeUndefined();
  expect((await readFile(join(scratch, "artifact.whl"))).toString()).toBe(
    "immutable input",
  );
  state.commandFailure = undefined;
  released = true;
  expect((await verifyArtifactSignature(input())).ok).toBe(true);
  expect(stop).toHaveBeenCalledTimes(2);
  expect(result.error.cleanupIncomplete).toBe(false);
  await expect(readFile(join(scratch, "artifact.whl"))).rejects.toThrow();
});

it("reports an unavailable verifier without claiming signature verification", async () => {
  state.missingTools = true;
  const result = await verifyArtifactSignature(
    verifyArtifactSignatureInputSchema.parse({ path, kind: "apple" }),
  );
  state.missingTools = false;
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.integrity.status).toBe("unavailable");
  expect(result.value.signers).toEqual([]);
});

it("refuses oversized complete reports before creating Evidence and still releases scratch", async () => {
  state.largeReport = true;
  const result = await verifyArtifactSignature(input());
  state.largeReport = false;
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error._tag).toBe("AnalysisResourceConstraintError");
  expect(result.error.partialObservation).toBeUndefined();
  await expect(readFile(join(state.scratch, "artifact.whl"))).rejects.toThrow();
});

it.skipIf(process.platform !== "darwin")(
  "keeps JAR integrity separate when keytool cannot establish requested trust",
  async () => {
    state.missingKeytool = true;
    state.mockJar = true;
    try {
      for (const requested of [false, true]) {
        const result = await verifyArtifactSignature(
          verifyArtifactSignatureInputSchema.parse({
            path,
            kind: "jar",
            ...(requested ? { trusted_certificate: path } : {}),
          }),
        );
        expect(result.ok).toBe(true);
        if (!result.ok) continue;
        expect(result.value.integrity.status).toBe("passed");
        expect(result.value.trust.status).toBe(
          requested ? "unavailable" : "not_checked",
        );
        expect(result.value.signers).toEqual([]);
      }
    } finally {
      state.missingKeytool = false;
      state.mockJar = false;
    }
  },
);
