import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NativeVersionComparison } from "./NativeVersionComparison.js";
import { createTestBinarySession } from "../../tests/fixtures/binarySession.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { thinMach, elf } from "../domain/binaryTarget.fixture.js";
import { ok, err } from "../domain/result.js";
import { observed } from "../../tests/fixtures/analysisExecution.js";
import { FUNCTION_COMPARISON_EXAMPLE } from "../contracts/functionComparisonExample.js";
import { functionDossierSchema } from "../domain/hopperValues.js";
import { nativeVersionComparisonResultSchema } from "../domain/nativeVersionComparisonSchemas.js";
import {
  AnalysisOutputError,
  AnalysisCancelledError,
} from "../domain/analysisErrorCore.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";

const files = async () => {
  const root = await createTestTempDirectory("rea-native-versions-");
  const left = join(root, "left"),
    right = join(root, "right");
  await writeFile(left, thinMach(0xcffaedfe, 0x0100000c));
  await writeFile(
    right,
    Buffer.concat([thinMach(0xcffaedfe, 0x0100000c), Buffer.from("different")]),
  );
  return { left: { path: left }, right: { path: right } };
};
const fixture = (fail = false, controller?: AbortController) => {
  const closed: string[] = [],
    opened: string[] = [];
  const service = new NativeVersionComparison(() =>
    ok(
      createTestBinarySession((target) => {
        opened.push(target.path);
        return {
          health: () => Promise.resolve(),
          close: () => {
            closed.push(target.path);
            return Promise.resolve(ok(null));
          },
          execute: (operation) => {
            if (operation === "health")
              return Promise.resolve(observed({ ready: true }));
            if (operation === "list_procedures")
              return Promise.resolve(
                observed([{ address: "0x1000", value: "main" }]),
              );
            controller?.abort();
            if (fail)
              return Promise.resolve(
                err(new AnalysisOutputError(operation, "dossier unavailable")),
              );
            const dossier = functionDossierSchema.parse(
              FUNCTION_COMPARISON_EXAMPLE.left.normalized_result,
            );
            return Promise.resolve(
              observed({ ...dossier, assembly: ["0x1000: ret"] }),
            );
          },
        };
      }),
    ),
  );
  return { service, closed, opened };
};

describe("native version collection lifecycle", () => {
  it("does not promote an observed exact pair when a failed duplicate could hide alternatives", async () => {
    const request = await files();
    const { service, closed } = unavailableSecondFunction(
      () =>
        new AnalysisOutputError("analyze_function", "duplicate unavailable"),
    );
    const result = await service.compare(request);
    if (!result.ok) throw result.error;
    const comparison = nativeVersionComparisonResultSchema.parse(
      result.value.normalized_result,
    );
    expect(comparison.completeness).toBe("partial");
    expect(comparison.right.failures).toHaveLength(1);
    expect(comparison.candidates[0]?.selection).toBe("disputed");
    expect(comparison.comparisons).toEqual([]);
    expect(closed).toHaveLength(2);
    const selected = await service.compare({
      ...request,
      selected_pairs: [{ left_address: "0x1000", right_address: "0x1000" }],
    });
    if (!selected.ok) throw selected.error;
    expect(
      nativeVersionComparisonResultSchema.parse(
        selected.value.normalized_result,
      ).comparisons[0]?.selection,
    ).toBe("analyst-selected");
  });
  it("preserves inventory, earlier dossiers and a cancelled function's own partial observation", async () => {
    const request = await files();
    const partial = FUNCTION_COMPARISON_EXAMPLE.right;
    const { service, closed } = unavailableSecondFunction(
      () =>
        new AnalysisCancelledError("analyze_function", {
          partialObservation: partial,
        }),
      true,
    );
    const result = await service.compare(request);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected cancellation");
    expect(result.error.partialObservation).toMatchObject({
      normalized_result: {
        collected_side: {
          inventory: expect.any(Object),
          functions: [expect.any(Object)],
        },
        interrupted_observation: partial,
      },
    });
    expect(closed).toHaveLength(1);
  });
  it("retains both collected sides when the analyst selects a missing pair", async () => {
    const request = await files();
    const { service, closed } = fixture();
    const result = await service.compare({
      ...request,
      selected_pairs: [{ left_address: "0x9999", right_address: "0x1000" }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected missing pair rejection");
    expect(result.error.partialObservation).toMatchObject({
      normalized_result: {
        left: { functions: [expect.any(Object)] },
        right: { functions: [expect.any(Object)] },
      },
    });
    expect(closed).toHaveLength(2);
  });
  it("collects two owned sessions and preserves inline identity-bound source evidence", async () => {
    const request = await files();
    const { service, closed, opened } = fixture();
    const result = await service.compare(request);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) throw result.error;
    const comparison = nativeVersionComparisonResultSchema.parse(
      result.value.normalized_result,
    );
    expect(comparison.left.failures).toEqual([]);
    expect(comparison.left.sha256).not.toBe(comparison.right.sha256);
    expect(comparison.left.functions[0]?.subject?.digest.sha256).toBe(
      comparison.left.sha256,
    );
    expect(comparison.comparisons[0]?.selection).toBe(
      "unique-exact-representation",
    );
    expect(closed).toEqual(opened);
    expect(closed).toHaveLength(2);
  });
  it("rejects expected hash and cross-format mismatch before creating any provider", async () => {
    const request = await files();
    const { service, opened } = fixture();
    const mismatch = await service.compare({
      ...request,
      left: { ...request.left, expected_sha256: "f".repeat(64) },
    });
    expect(mismatch.ok ? "success" : mismatch.error._tag).toBe(
      "EvidenceIntegrityError",
    );
    await writeFile(request.right.path, elf(2, 1, 62));
    const unsupported = await service.compare(request);
    expect(unsupported.ok ? "success" : unsupported.error._tag).toBe(
      "AnalysisUnsupportedTargetError",
    );
    expect(opened).toEqual([]);
  });
  it("retains failed facets and still closes both sessions", async () => {
    const request = await files();
    const { service, closed } = fixture(true);
    const result = await service.compare(request);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.value.normalized_result).toMatchObject({
      completeness: "partial",
      left: {
        failures: [
          {
            address: "0x1000",
            reason: expect.stringContaining("dossier unavailable"),
          },
        ],
      },
    });
    expect(closed).toHaveLength(2);
  });
  it("closes the first session on cancellation and does not open the second", async () => {
    const request = await files();
    const controller = new AbortController();
    const { service, closed, opened } = fixture(false, controller);
    const result = await service.compare(request, controller.signal);
    expect(result.ok ? "success" : result.error._tag).toBe(
      "AnalysisCancelledError",
    );
    expect(closed).toEqual(opened);
    expect(closed).toHaveLength(1);
  });
});

const unavailableSecondFunction = (
  failure: () => AnalysisError,
  failLeft = false,
) => {
  const closed: string[] = [];
  const service = new NativeVersionComparison(() =>
    ok(
      createTestBinarySession((target) => ({
        health: () => Promise.resolve(),
        close: () => {
          closed.push(target.path);
          return Promise.resolve(ok(null));
        },
        execute: (operation, input) => {
          if (operation === "health") return Promise.resolve(observed({}));
          if (operation === "list_procedures")
            return Promise.resolve(
              observed([
                { address: "0x1000", value: "visible" },
                ...(failLeft || target.path.endsWith("right")
                  ? [{ address: "0x2000", value: "duplicate" }]
                  : []),
              ]),
            );
          if (input.procedure === "0x2000")
            return Promise.resolve(err(failure()));
          const dossier = functionDossierSchema.parse(
            FUNCTION_COMPARISON_EXAMPLE.left.normalized_result,
          );
          return Promise.resolve(
            observed({ ...dossier, assembly: ["0x1000: ret"] }),
          );
        },
      })),
    ),
  );
  return { service, closed };
};
