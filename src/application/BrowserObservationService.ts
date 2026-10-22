import type { Evidence } from "../domain/evidence.js";
import type {
  InspectWebPageInput,
  ListBrowserTargetsInput,
} from "../domain/browserObservation.js";
import {
  webBundleAnalysisSchema,
  type AnalyzeWebBundleInput,
} from "../domain/webBundleAnalysis.js";
import type { ObserveWebSessionInput } from "../domain/browserSession.js";
import type { DiscoverWebMcpToolsInput } from "../domain/webMcpDiscovery.js";
import type { BrowserCaptureComparisonInput } from "../domain/browserCaptureComparison.js";
import type {
  CaptureWebScreenshotInput,
  CompareWebScreenshotsInput,
} from "../domain/webScreenshot.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { err, ok, type Result } from "../domain/result.js";
import type { ExecutionOptions } from "./AnalysisProvider.js";
import type { BrowserObservationPort } from "./BrowserObservationPort.js";
import { createBrowserEvidence } from "./BrowserEvidence.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import { completeProviderEvidence } from "./ProviderOperationExecution.js";
import { webPageInspectionSchema } from "../domain/browserObservationSchemas.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";

/** List browser targets within the endpoint and origin scope in the request. */
export const listBrowserTargets = async (
  browser: BrowserObservationPort | undefined,
  input: ListBrowserTargetsInput,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  const ready = requireBrowser(browser, "list_browser_targets");
  if (!ready.ok) return ready;
  if (options.signal?.aborted)
    return err(
      new AnalysisCancelledError("list_browser_targets", {
        cause: options.signal.reason,
      }),
    );
  const result = await ready.value.listTargets(input, options);
  return result.ok
    ? browserEvidence(
        "list_browser_targets",
        input,
        result.value,
        ready.value.identity(),
        options,
      )
    : result;
};

/** Inspect one page within the endpoint and origin scope in the request. */
export const inspectWebPage = async (
  browser: BrowserObservationPort | undefined,
  input: InspectWebPageInput,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  const ready = requireBrowser(browser, "inspect_web_page");
  if (!ready.ok) return ready;
  if (options.signal?.aborted)
    return err(
      new AnalysisCancelledError("inspect_web_page", {
        cause: options.signal.reason,
      }),
    );
  const result = await ready.value.inspectPage(input, options);
  if (!result.ok)
    return retainBrowserObservation(
      result.error,
      input,
      ready.value,
      "inspect_web_page",
    );
  return result.ok
    ? browserEvidence(
        "inspect_web_page",
        input,
        result.value,
        ready.value.identity(),
        options,
      )
    : result;
};

/** Capture requested sources and derive static web-bundle evidence. */
export const analyzeWebBundle = async (
  browser: BrowserObservationPort | undefined,
  input: AnalyzeWebBundleInput,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  const ready = requireBrowser(browser, "analyze_web_bundle");
  if (!ready.ok) return ready;
  if (options.signal?.aborted)
    return err(
      new AnalysisCancelledError("analyze_web_bundle", {
        cause: options.signal.reason,
      }),
    );
  const analyzed = await ready.value.analyzeBundle(input, options);
  if (!analyzed.ok)
    return retainBrowserObservation(
      analyzed.error,
      input,
      ready.value,
      "analyze_web_bundle",
    );
  return browserEvidence(
    "analyze_web_bundle",
    input,
    analyzed.value,
    ready.value.identity(),
    options,
  );
};

/** Observe navigation caused by external user actions during one armed window. */
export const observeWebSession = async (
  browser: BrowserObservationPort | undefined,
  input: ObserveWebSessionInput,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  const ready = requireBrowser(browser, "observe_web_session");
  if (!ready.ok) return ready;
  if (options.signal?.aborted)
    return err(
      new AnalysisCancelledError("observe_web_session", {
        cause: options.signal.reason,
      }),
    );
  const observed = await ready.value.observeSession(input, options);
  return observed.ok
    ? browserEvidence(
        "observe_web_session",
        input,
        observed.value,
        ready.value.identity(),
        options,
      )
    : observed;
};

/** Discover WebMCP declarations without exposing an invocation surface. */
export const discoverWebMcpTools = async (
  browser: BrowserObservationPort | undefined,
  input: DiscoverWebMcpToolsInput,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  const ready = requireBrowser(browser, "discover_webmcp_tools");
  if (!ready.ok) return ready;
  if (options.signal?.aborted)
    return err(
      new AnalysisCancelledError("discover_webmcp_tools", {
        cause: options.signal.reason,
      }),
    );
  const discovered = await ready.value.discoverWebMcpTools(input, options);
  return discovered.ok
    ? browserEvidence(
        "discover_webmcp_tools",
        input,
        discovered.value,
        ready.value.identity(),
        options,
      )
    : discovered;
};

/** Compare two already-normalized web captures without external access. */
export const compareWebCaptureEvidence = async (
  browser: BrowserObservationPort | undefined,
  input: BrowserCaptureComparisonInput,
): Promise<Result<Evidence, AnalysisError>> => {
  const ready = requireBrowser(browser, "compare_web_captures");
  if (!ready.ok) return ready;
  const compared = await ready.value.compareCaptures(input);
  return compared.ok
    ? ok(
        createBrowserEvidence(
          "compare_web_captures",
          input,
          compared.value,
          ready.value.identity(),
        ),
      )
    : compared;
};

/** Capture one visible-viewport screenshot for the requested target. */
export const captureWebScreenshot = async (
  browser: BrowserObservationPort | undefined,
  input: CaptureWebScreenshotInput,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  const ready = requireBrowser(browser, "capture_web_screenshot");
  if (!ready.ok) return ready;
  if (options.signal?.aborted)
    return err(
      new AnalysisCancelledError("capture_web_screenshot", {
        cause: options.signal.reason,
      }),
    );
  const captured = await ready.value.captureScreenshot(input, options);
  return captured.ok
    ? browserEvidence(
        "capture_web_screenshot",
        input,
        captured.value,
        ready.value.identity(),
        options,
      )
    : captured;
};

/** Compare two self-verifying PNG artifacts without external access. */
export const compareWebScreenshotEvidence = async (
  browser: BrowserObservationPort | undefined,
  input: CompareWebScreenshotsInput,
): Promise<Result<Evidence, AnalysisError>> => {
  const ready = requireBrowser(browser, "compare_web_screenshots");
  if (!ready.ok) return ready;
  const compared = await ready.value.compareScreenshots(input);
  return compared.ok
    ? ok(
        createBrowserEvidence(
          "compare_web_screenshots",
          input,
          compared.value,
          ready.value.identity(),
        ),
      )
    : compared;
};

const requireBrowser = (
  browser: BrowserObservationPort | undefined,
  operation: string,
): Result<BrowserObservationPort, AnalysisError> =>
  browser === undefined
    ? err(
        new AnalysisCapabilityUnavailableError(
          "rea-cdp-browser",
          operation,
          "browser observation provider is not configured",
        ),
      )
    : ok(browser);

const browserEvidence = (
  operation: Parameters<typeof createBrowserEvidence>[0],
  input: Parameters<typeof createBrowserEvidence>[1],
  result: Parameters<typeof createBrowserEvidence>[2],
  provider: Parameters<typeof createBrowserEvidence>[3],
  options: ExecutionOptions,
): Result<Evidence, AnalysisError> => {
  const json = jsonValueSchema.safeParse(result);
  if (!json.success)
    return err(
      new AnalysisOutputError(
        operation,
        "Browser provider returned non-JSON observation data.",
        {
          cause: json.error,
        },
      ),
    );
  return completeProviderEvidence(
    createBrowserEvidence(operation, input, result, provider),
    options.signal,
  );
};

/** Retain the completed capture or bundle facts under their actual operation. */
const retainBrowserObservation = (
  error: AnalysisError,
  input: InspectWebPageInput | AnalyzeWebBundleInput,
  provider: BrowserObservationPort,
  errorOperation: "inspect_web_page" | "analyze_web_bundle",
): Result<Evidence, AnalysisError> => {
  const partial = error.partialObservation;
  if (
    errorOperation === "analyze_web_bundle" &&
    partial !== undefined &&
    !("evidence_id" in partial) &&
    "observations" in partial &&
    "capture" in partial
  ) {
    const bundle = webBundleAnalysisSchema.safeParse(partial);
    if (!bundle.success) {
      const malformed = new AnalysisOutputError(
        errorOperation,
        "Browser provider retained malformed completed bundle facts.",
        { cause: bundle.error },
      );
      return err(
        error.cleanupIncomplete
          ? analysisErrorWithCleanupFailure(
              malformed,
              error,
              errorOperation,
            ).bindCleanupDependencies([malformed, error])
          : malformed,
      );
    }
    error.partialObservation = createBrowserEvidence(
      "analyze_web_bundle",
      input,
      bundle.data,
      provider.identity(),
    );
    return err(error);
  }
  if (
    partial === undefined ||
    "evidence_id" in partial ||
    !("target" in partial) ||
    !("network" in partial) ||
    !("capture_window" in partial)
  )
    return err(error);
  const inspection = webPageInspectionSchema.safeParse(partial);
  if (!inspection.success) {
    if (error instanceof AnalysisCancelledError)
      return err(
        new AnalysisOutputError(
          errorOperation,
          "Browser provider retained a malformed completed page inspection.",
          { cause: inspection.error },
        ),
      );
    return err(error);
  }
  const pageInput: InspectWebPageInput =
    "fetch_source_maps" in input
      ? (({ fetch_source_maps: _fetchSourceMaps, ...page }) => page)(input)
      : input;
  error.partialObservation = createBrowserEvidence(
    "inspect_web_page",
    pageInput,
    inspection.data,
    provider.identity(),
  );
  return err(error);
};
