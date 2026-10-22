import { expect, it } from "vitest";
import type { BrowserObservationPort } from "./BrowserObservationPort.js";
import { listBrowserTargets } from "./BrowserObservationService.js";
import type { BrowserTargetList } from "../domain/browserObservationSchemas.js";
import { parseEvidence } from "../domain/evidence.js";
import { AnalysisOutputError } from "../domain/analysisErrorCore.js";
import { BrowserObservationError } from "../domain/browserObservationError.js";
import { ok } from "../domain/result.js";
import { passiveNetworkCapture } from "../../tests/fixtures/passiveNetworkCapture.js";
import { inspectWebPage } from "./BrowserObservationService.js";
import { analyzeWebBundleInputSchema } from "../domain/webBundleAnalysis.js";
import { inspectWebPageInputSchema } from "../domain/browserObservation.js";
import { analyzeWebBundle } from "./BrowserObservationService.js";

const input = {
  cdp_endpoint: {
    transport: "http_discovery" as const,
    url: "http://127.0.0.1:9222",
    recorded: "http://127.0.0.1:9222",
  },
  allowed_origins: [],
};

const report: BrowserTargetList = {
  browser: {
    product: "Chrome",
    protocol_version: "1.3",
    revision: "1",
    user_agent: "Chrome fixture",
    js_version: "V8 fixture",
  },
  targets: [],
  excluded: { disallowed_origin: 0, unsupported_url: 0, non_page: 0 },
  limitations: [],
};

const provider = (
  listTargets: BrowserObservationPort["listTargets"],
): BrowserObservationPort =>
  ({
    identity: () => ({ id: "browser-fixture", name: "Fixture", version: "1" }),
    listTargets,
  }) as unknown as BrowserObservationPort;

it("retains completed browser inventory Evidence when the provider completes after abort", async () => {
  const controller = new AbortController();
  const result = await listBrowserTargets(
    provider(async () => {
      controller.abort();
      return ok(report);
    }),
    input,
    { signal: controller.signal },
  );
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error._tag).toBe("AnalysisCancelledError");
    expect(parseEvidence(result.error.partialObservation)).toMatchObject({
      operation: "list_browser_targets",
      normalized_result: report,
    });
  }
});

it("does not let late cancellation hide invalid completed browser output", async () => {
  const malformed = {
    ...report,
    limitations: [() => undefined],
  } as unknown as BrowserTargetList;
  const output = await listBrowserTargets(
    provider(async () => ok(malformed)),
    input,
  );
  expect(output).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
  if (!output.ok) expect(output.error).toBeInstanceOf(AnalysisOutputError);

  const controller = new AbortController();
  const late = await listBrowserTargets(
    provider(async () => {
      controller.abort();
      return ok(malformed);
    }),
    input,
    { signal: controller.signal },
  );
  expect(late).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
  if (!late.ok) expect(late.error).toBeInstanceOf(AnalysisOutputError);
});

it("converts a raw page inspection retained after browser cleanup failure", async () => {
  const inspection = passiveNetworkCapture();
  const failure = new BrowserObservationError(
    "inspect_web_page",
    "cleanup_failed",
    {
      cleanup: {
        reason: "target detach failed",
        resources: ["browser target"],
      },
      partialObservation: inspection,
    },
  );
  const browser: BrowserObservationPort = {
    identity: () => ({ id: "browser-fixture", name: "Fixture", version: "1" }),
    listTargets: async () => ok(report),
    inspectPage: async () => ({ ok: false, error: failure }),
  } as unknown as BrowserObservationPort;
  const pageInput = inspectWebPageInputSchema.parse({
    cdp_endpoint: input.cdp_endpoint.recorded,
    allowed_origins: [],
    target_id: "page",
    observation_ms: 0,
    include_script_sources: false,
  });
  const result = await inspectWebPage(browser, pageInput);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toBe(failure);
    expect(result.error.cleanupIncomplete).toBe(true);
    expect(parseEvidence(result.error.partialObservation)).toMatchObject({
      operation: "inspect_web_page",
      normalized_result: inspection,
    });
  }
});

it("retains captured page Evidence when bundle analysis fails after capture", async () => {
  const inspection = passiveNetworkCapture();
  const failure = new BrowserObservationError(
    "analyze_web_bundle",
    "cancelled",
    { partialObservation: inspection },
  );
  const browser: BrowserObservationPort = {
    ...provider(async () => ok(report)),
    analyzeBundle: async () => ({ ok: false as const, error: failure }),
  } as unknown as BrowserObservationPort;
  const bundleInput = analyzeWebBundleInputSchema.parse({
    ...input,
    cdp_endpoint: input.cdp_endpoint.recorded,
    target_id: "page",
    observation_ms: 0,
    include_script_sources: true,
  });
  const result = await analyzeWebBundle(browser, bundleInput);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toBe(failure);
    expect(failure.operation).toBe("analyze_web_bundle");
    expect(parseEvidence(result.error.partialObservation)).toMatchObject({
      operation: "inspect_web_page",
      normalized_result: inspection,
    });
  }
});

it("retains completed bundle facts as bundle Evidence after cancellation", async () => {
  const { analyzeCapturedWebBundle } =
    await import("../domain/webBundleAnalyzer.js");
  const { AnalysisCancelledError } =
    await import("../domain/analysisErrorCore.js");
  const bundle = analyzeCapturedWebBundle(passiveNetworkCapture());
  const reason = { requested: "stop after completed script" };
  const failure = new AnalysisCancelledError("analyze_web_bundle", {
    cause: reason,
    partialObservation: bundle,
  });
  const browser: BrowserObservationPort = {
    ...provider(async () => ok(report)),
    analyzeBundle: async () => ({ ok: false as const, error: failure }),
  };
  const selected = analyzeWebBundleInputSchema.parse({
    cdp_endpoint: input.cdp_endpoint.recorded,
    target_id: "page",
    max_heap_mb: 256,
    analysis_timeout_ms: 100,
    total_analysis_timeout_ms: 1000,
  });
  const result = await analyzeWebBundle(browser, selected);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected cancellation");
  expect(result.error).toBe(failure);
  expect(result.error.cause).toBe(reason);
  expect(parseEvidence(result.error.partialObservation)).toMatchObject({
    operation: "analyze_web_bundle",
    parameters: expect.objectContaining({
      max_heap_mb: 256,
      analysis_timeout_ms: 100,
      total_analysis_timeout_ms: 1000,
    }),
    normalized_result: bundle,
  });
});

it("preserves a prior caller reason without admitting browser work", async () => {
  const reason = new AnalysisOutputError(
    "inspect_web_page",
    "caller supplied reason",
  );
  const result = await listBrowserTargets(
    provider(async () => {
      throw new Error("Cancelled inventory must not start");
    }),
    input,
    { signal: AbortSignal.abort(reason) },
  );
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected cancelled inventory");
  expect(result.error._tag).toBe("AnalysisCancelledError");
  expect(result.error.cause).toBe(reason);
});
