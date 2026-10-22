import { expect, it } from "vitest";

import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { BrowserObservationError } from "../domain/browserObservationError.js";
import { parseEvidence } from "../domain/evidence.js";
import { browserScenarioInputSchema } from "../domain/browserScenario.js";
import { err } from "../domain/result.js";
import { scriptScenarioFixture } from "../../tests/fixtures/webScriptCapture.js";
import type { BrowserScenarioCapturePort } from "./BrowserScenarioCapturePort.js";
import { captureBrowserScenario } from "./BrowserScenarioCaptureService.js";

const scenario = browserScenarioInputSchema.parse({
  browser: { mode: "launch", executable_path: "/fixture/chrome" },
  start_url: { url: "https://fixture.test/", query: [] },
  actions: [{ step_id: "settle", action: "wait_for_timeout", duration_ms: 1 }],
});
const capture = scriptScenarioFixture();

it("converts a retained raw scenario capture into partial Evidence", async () => {
  const failure = new AnalysisCancelledError("capture_browser_scenario", {
    partialObservation: {
      kind: "browser-scenario-observation",
      capture,
    },
  });
  const provider: BrowserScenarioCapturePort = {
    identity: () => ({
      id: "scenario-fixture",
      name: "Scenario fixture",
      version: "1",
    }),
    captureScenario: async () => err(failure),
  };
  const result = await captureBrowserScenario(provider, scenario);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toBe(failure);
    expect(parseEvidence(result.error.partialObservation)).toMatchObject({
      operation: "capture_browser_scenario",
      normalized_result: capture,
    });
  }
});

it("converts a raw scenario capture retained after cleanup failure", async () => {
  const failure = new BrowserObservationError(
    "capture_browser_scenario",
    "cleanup_failed",
    {
      cleanup: {
        reason: "browser close failed",
        resources: ["browser process"],
      },
      partialObservation: {
        kind: "browser-scenario-observation",
        capture,
      },
    },
  );
  const provider: BrowserScenarioCapturePort = {
    identity: () => ({
      id: "scenario-fixture",
      name: "Scenario fixture",
      version: "1",
    }),
    captureScenario: async () => err(failure),
  };
  const result = await captureBrowserScenario(provider, scenario);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toBe(failure);
    expect(result.error.cleanupIncomplete).toBe(true);
    expect(parseEvidence(result.error.partialObservation)).toMatchObject({
      operation: "capture_browser_scenario",
      normalized_result: capture,
    });
  }
});

it.each([
  null,
  { request: "opaque cancellation" },
  new BrowserObservationError("capture_browser_scenario", "protocol_error"),
])(
  "preserves the exact pre-admission caller reason without dispatch: %j",
  async (reason) => {
    const caller = new AbortController();
    caller.abort(reason);
    let calls = 0;
    const provider: BrowserScenarioCapturePort = {
      identity: () => ({ id: "fixture", name: "fixture", version: "1" }),
      captureScenario: async () => {
        calls++;
        throw new Error("Unexpected dispatch");
      },
    };
    const result = await captureBrowserScenario(provider, scenario, {
      signal: caller.signal,
    });
    if (result.ok) throw new Error("Expected cancellation");
    expect(result.error).toBeInstanceOf(AnalysisCancelledError);
    expect(result.error.cause).toBe(reason);
    expect(calls).toBe(0);
  },
);
