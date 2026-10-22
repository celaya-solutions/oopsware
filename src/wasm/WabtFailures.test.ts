import { expect, it } from "vitest";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { wabtFailure } from "./WabtFailures.js";
import { WABT_LIMITS } from "./WabtRelease.js";

it.each([false, true])(
  "preserves the file-size boundary with cleanup=%s when an input exceeds its fixed allowance",
  (cleanup) => {
    const cause = new ArtifactReaderFailure(
      "limit",
      "Selected artifact exceeds its byte allowance",
      {
        boundary: "file-size",
        ...(cleanup
          ? {
              cleanup: { reason: "close denied", resources: ["selected.wasm"] },
            }
          : {}),
      },
    );
    const projected = projectAnalysisError(
      wabtFailure(cause, "artifact", "selected.wasm"),
    );
    expect(projected).toMatchObject({
      code: cleanup ? "cleanup_incomplete" : "resource_constraint",
      category: "resource_constraint",
      retryable: false,
      details: {
        resource: "file-size",
        reported_limits: { maximum_input_bytes: WABT_LIMITS.inputBytes },
      },
    });
    if (!cleanup) {
      expect(projected.remediation.action).toContain("input byte allowance");
      expect(projected.remediation.action).not.toContain("evidence reply");
    }
    expect(
      wabtFailure(cause, "artifact", "selected.wasm").cleanupResources,
    ).toEqual(cleanup ? ["selected.wasm"] : []);
  },
);

it("keeps oversized tool admission distinct from selected artifact size", () => {
  const cause = new ArtifactReaderFailure(
    "limit",
    "Configured tool exceeds its byte allowance",
    { boundary: "file-size" },
  );
  expect(
    projectAnalysisError(wabtFailure(cause, "configuration", "selected.wasm"))
      .code,
  ).toBe("capability_unavailable");
});
