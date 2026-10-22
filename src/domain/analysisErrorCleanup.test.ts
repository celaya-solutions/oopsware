import { expect, it } from "vitest";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
} from "./analysisErrorCore.js";
import { analysisErrorWithCleanupFailure } from "./analysisErrorCleanup.js";
import { projectAnalysisError } from "./analysisErrorProjection.js";
import {
  analysisErrorCategory,
  analysisErrorRemediationAction,
  analysisErrorUserMessage,
} from "./analysisErrorPresentation.js";
import { ProviderCleanupError } from "./providerCleanupError.js";
import { createEvidence } from "./evidence.js";

it("keeps dependency-owned resources empty after the final owner releases", () => {
  const file = new ProviderCleanupError("fixture", ["file-owner"], {});
  const trace = new ProviderCleanupError("fixture", ["trace-owner"], {});
  const composed = analysisErrorWithCleanupFailure(
    file,
    trace,
  ).bindCleanupDependencies([file, trace]);
  expect(new Set(composed.cleanupResources)).toEqual(
    new Set(["file-owner", "trace-owner"]),
  );
  file.resolveCleanup();
  expect(composed.cleanupResources).toEqual(["trace-owner"]);
  trace.resolveCleanup();
  expect(composed.cleanupIncomplete).toBe(false);
  expect(composed.cleanupResources).toEqual([]);
  expect(new Set(composed.cleanup?.resources)).toEqual(
    new Set(["file-owner", "trace-owner"]),
  );
});

it("keeps primary diagnostics separate from historical cleanup diagnostics with the same keys", () => {
  const primary = new AnalysisInputError("inspect", {
    diagnostics: {
      primary_error: "source observation",
      cleanup_error: "another source observation",
    },
  });
  const cleanup = new ProviderCleanupError("fixture", ["owned-input"], {});
  const composed = analysisErrorWithCleanupFailure(
    primary,
    cleanup,
  ).bindCleanupDependencies([primary, cleanup]);
  cleanup.resolveCleanup();
  const projected = projectAnalysisError(composed);
  expect(projected.details?.diagnostics).toEqual(primary.diagnostics);
  expect(projected.details?.cleanup_history).toMatchObject({
    primary_error: projectAnalysisError(primary),
    cleanup_error: { code: "cleanup_incomplete" },
  });
  expect(composed.cleanupPrimary).toBe(primary);
  expect(Object.hasOwn(composed, "cleanupPrimary")).toBe(false);
});

it.each([
  new AnalysisInputError("inspect", { diagnostics: { input: "original" } }, [
    {
      path: ["path"],
      reason: "out_of_range",
      message: "fixed input allowance",
    },
  ]),
  new AnalysisCancelledError("inspect", { cause: "caller reason" }),
  new AnalysisTimeoutError("inspect", 1234),
  new AnalysisResourceConstraintError(
    "inspect",
    "file-size",
    "fixed input allowance",
    { maximum_input_bytes: 123 },
    { retryable: false, remediationAction: "Select a smaller suitable input." },
  ),
  new AnalysisOutputError("inspect", "invalid output", {
    capturedOutput: {
      stdout: "original output",
      stderr: "original warning",
      truncated: true,
    },
    partialObservation: createEvidence(
      undefined,
      { id: "fixture", name: "Fixture", version: null },
      {
        operation: "inspect",
        parameters: {},
        result: { original_fact: true },
        confidence: "observed",
        locations: [],
        limitations: [],
      },
    ),
  }),
])("restores the typed $_tag primary after confirmed cleanup", (primary) => {
  const original = projectAnalysisError(primary);
  const cleanup = new ProviderCleanupError(
    "fixture",
    ["owned-input"],
    { reason: "close denied" },
    { operation: "inspect" },
  );
  const composed = analysisErrorWithCleanupFailure(
    primary,
    cleanup,
    "inspect",
  ).bindCleanupDependencies([primary, cleanup]);
  expect(projectAnalysisError(composed).code).toBe("cleanup_incomplete");
  cleanup.resolveCleanup();
  const projected = projectAnalysisError(composed);
  expect(projected).toMatchObject(original);
  expect(projected.details?.cleanup_history).toMatchObject({
    primary_error: original,
    cleanup_error: { code: "cleanup_incomplete" },
  });
  expect(projected.details).not.toHaveProperty("cleanup", "incomplete");
  expect(projected.details).not.toHaveProperty("resources");
  expect(analysisErrorCategory(composed)).toBe(original.category);
  expect(analysisErrorUserMessage(composed)).toBe(original.message);
  expect(analysisErrorRemediationAction(composed)).toBe(
    original.remediation.action,
  );
  expect(composed.cause).toBeInstanceOf(AggregateError);
  expect((composed.cause as AggregateError).errors[0]).toBe(primary);
});

it.each(["inner", "outer"] as const)(
  "waits for both nested cleanup owners when %s resolves first",
  (first) => {
    const primary = new AnalysisInputError("inspect");
    const innerCleanup = new ProviderCleanupError("fixture", ["input"], {});
    const outerCleanup = new ProviderCleanupError("fixture", ["workspace"], {});
    const inner = analysisErrorWithCleanupFailure(
      primary,
      innerCleanup,
    ).bindCleanupDependencies([primary, innerCleanup]);
    const outer = analysisErrorWithCleanupFailure(
      inner,
      outerCleanup,
    ).bindCleanupDependencies([inner, outerCleanup]);
    const released = first === "inner" ? innerCleanup : outerCleanup;
    const pending = first === "inner" ? outerCleanup : innerCleanup;
    released.resolveCleanup();
    expect(outer.cleanupIncomplete).toBe(true);
    expect(projectAnalysisError(outer).code).toBe("cleanup_incomplete");
    pending.resolveCleanup();
    expect(outer.cleanupIncomplete).toBe(false);
    expect(projectAnalysisError(outer)).toMatchObject(
      projectAnalysisError(primary),
    );
  },
);

it("does not infer cleanup success when a composition has no live owner binding", () => {
  const primary = new AnalysisInputError("inspect");
  const cleanup = new ProviderCleanupError("fixture", ["input"], {});
  const composed = analysisErrorWithCleanupFailure(primary, cleanup);
  cleanup.resolveCleanup();
  expect(projectAnalysisError(composed).code).toBe("cleanup_incomplete");
});

it("retains an observation attached to the composite after the primary failed", () => {
  const primary = new AnalysisInputError("inspect");
  const cleanup = new ProviderCleanupError("fixture", ["input"], {});
  const composed = analysisErrorWithCleanupFailure(
    primary,
    cleanup,
  ).bindCleanupDependencies([primary, cleanup]);
  const observation = createEvidence(
    undefined,
    { id: "fixture", name: "Fixture", version: null },
    {
      operation: "inspect",
      parameters: {},
      result: { late_fact: true },
      confidence: "observed",
      locations: [],
      limitations: [],
    },
  );
  composed.retainPartialObservation(observation);
  composed.resolveCleanup();
  expect(projectAnalysisError(composed).code).toBe("cleanup_incomplete");
  cleanup.resolveCleanup();
  expect(projectAnalysisError(composed)).toMatchObject({
    code: "invalid_request",
    details: { partial_observation: observation },
  });
});
