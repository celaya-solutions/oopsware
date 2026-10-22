import { expect, it } from "vitest";

import { finishAnalysisCommand } from "../../../src/cli/finishAnalysisCommand.js";
import { AnalysisOutputError } from "../../../src/domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { ProviderCleanupError } from "../../../src/domain/providerCleanupError.js";
import { err, ok } from "../../../src/domain/result.js";
import { scriptCaptureEvidenceFixture } from "../../fixtures/webScriptCapture.js";

it("preserves producer-owned cleanup failure when service close does not resolve it", async () => {
  const evidence = scriptCaptureEvidenceFixture();
  const failure = new ProviderCleanupError(
    "fixture-provider",
    ["producer-owned-resource"],
    { reason: "producer cleanup was not confirmed" },
    { operation: "inspect_web_page", partialObservation: evidence },
  );
  const expected = projectAnalysisError(failure);
  const result = await finishAnalysisCommand(
    async () => err(failure),
    { close: async () => {} },
    "fixture-provider",
    "inspect_web_page",
    new AbortController().signal,
  );

  expect(result).toEqual(expected);
  expect(failure.cleanupIncomplete).toBe(true);
});

it("returns completed partial Evidence when cancellation arrives during close", async () => {
  const evidence = scriptCaptureEvidenceFixture();
  const controller = new AbortController();
  const result = await finishAnalysisCommand(
    async () => ok(evidence),
    {
      close: async () => {
        controller.abort(new Error("cancelled during close"));
      },
    },
    "fixture-provider",
    "capture_browser_scenario",
    controller.signal,
  );

  expect(result).toMatchObject({
    code: "cancelled",
    details: { partial_observation: { evidence_id: evidence.evidence_id } },
  });
});

it("preserves the primary operation error when cancellation arrives during close", async () => {
  const controller = new AbortController();
  const result = await finishAnalysisCommand(
    async () =>
      err(new AnalysisOutputError("inspect_web_page", "primary failure")),
    {
      close: async () => {
        controller.abort();
      },
    },
    "fixture-provider",
    "inspect_web_page",
    controller.signal,
  );

  expect(result).toMatchObject({
    code: "unreadable_output",
    details: {
      reason: "primary failure",
      operation: "inspect_web_page",
    },
  });
});
