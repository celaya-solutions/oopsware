import { afterEach, describe, expect, it } from "vitest";

import { runCliJson as runCli } from "../../fixtures/cliJsonProcess.js";
import { DEFAULT_BROWSER_SCENARIO_CAPTURE_LIMITS } from "../../../src/domain/browserScenarioCaptureLimits.js";
import {
  startFakeCdpBrowser,
  type FakeCdpBrowser,
  type FakeOptions,
} from "../../fixtures/fakeCdpBrowser.js";

const browsers: FakeCdpBrowser[] = [];
const INTEGRATION_TEST_TIMEOUT_MS = 60_000;

const partialScriptEvents: FakeOptions["commandEvents"] = (
  { method },
  origin,
) =>
  method === "Debugger.enable"
    ? [
        {
          method: "Debugger.scriptParsed",
          sessionId: "session-1",
          params: {
            scriptId: "partial-script",
            url: `${origin}/app.js`,
            executionContextId: 1,
          },
        },
      ]
    : undefined;

afterEach(async () => {
  await Promise.all(browsers.splice(0).map(async (browser) => browser.close()));
});

it(
  "browser CLI parity returns the same Evidence discovery and inspection contracts",
  async () => {
    const browser = await startFakeCdpBrowser({
      sessionTimeline: "same_origin",
      webMcpTools: true,
      sensitiveShapes: true,
      commandEvents: partialScriptEvents,
      eventsBeforeReply: ["Network.enable"],
    });
    browsers.push(browser);
    const listed = await runCli(
      ["list-browser-targets", browser.endpoint, "--json"],
      process.env,
    );
    expect(listed).toMatchObject({
      operation: "list_browser_targets",
      provider: { id: "rea-cdp-browser" },
      normalized_result: {
        targets: expect.arrayContaining([
          expect.objectContaining({ target_id: "allowed-page" }),
          expect.objectContaining({ target_id: "disallowed-page" }),
        ]),
      },
    });
    const inspected = await runCli(
      [
        "inspect-web-page",
        browser.endpoint,
        "allowed-page",
        "--observation-ms",
        "0",
        "--include-console-text",
        "--include-json-body-shapes",
        "--include-websocket-shapes",
        "--json",
      ],
      process.env,
    );
    expect(inspected).toMatchObject({
      operation: "inspect_web_page",
      provider: { id: "rea-cdp-browser" },
      normalized_result: {
        target: { target_id: "allowed-page" },
        scripts: {
          items: [{ cdp_hash: null, length: null, is_module: null }],
        },
        network: {
          prior_activity_available: false,
          requests: [
            expect.objectContaining({
              body_shapes: expect.objectContaining({ status: "included" }),
            }),
          ],
        },
      },
    });
    const inspection = normalizedResult(inspected);
    const compared = await runCli(
      [
        "compare-web-captures",
        JSON.stringify({ inspection, scenario: { caller_metadata: true } }),
        JSON.stringify({ inspection }),
        "--json",
      ],
      process.env,
    );
    expect(compared).toMatchObject({
      operation: "compare_web_captures",
      normalized_result: {
        overall_status: "unknown",
        dimensions: {
          network: { status: "unknown", total_changes: 0 },
        },
      },
    });
    const scenarioCapture = completeScenarioCapture();
    const scenarioCompared = await runCli(
      [
        "compare-web-captures",
        JSON.stringify(scenarioCapture),
        JSON.stringify(scenarioCapture),
        "--normalization-json",
        '{"rules":[]}',
        "--json",
      ],
      process.env,
    );
    expect(scenarioCompared).toMatchObject({
      operation: "compare_web_captures",
      normalized_result: {
        comparison_kind: "browser_scenario",
        overall_status: "unchanged",
        alignment: { status: "aligned", aligned_steps: 2 },
      },
    });
    const intentionalPolicy = await runCli(
      [
        "compare-web-captures",
        JSON.stringify(scenarioCapture),
        JSON.stringify(scenarioCapture),
        "--normalization-json",
        JSON.stringify({
          rules: [
            {
              rule_id: "domain",
              artifacts: ["url"],
              match: "app.example.test",
              replacement: "normalized.test",
            },
          ],
        }),
        "--json",
      ],
      process.env,
    );
    expect(intentionalPolicy).toMatchObject({
      normalized_result: {
        normalization: { rules: [{ rule_id: "domain" }] },
      },
    });

    const malformedPolicy = await runCli(
      [
        "compare-web-captures",
        JSON.stringify(scenarioCapture),
        JSON.stringify(scenarioCapture),
        "--normalization-json",
        "{invalid-policy",
        "--json",
      ],
      process.env,
    );
    expect(malformedPolicy).toMatchObject({
      error: "Browser observation failed",
      code: "invalid_request",
      details: {
        operation: "compare_web_captures",
        issues: [
          {
            path: ["normalization"],
            reason: "invalid_format",
            expected: "JSON",
          },
        ],
      },
    });
  },
  INTEGRATION_TEST_TIMEOUT_MS,
);

it(
  "compares redirect metadata uncertainty through the public CLI",
  async () => {
    const browser = await startFakeCdpBrowser();
    browsers.push(browser);
    const inspected = await runCli(
      [
        "inspect-web-page",
        browser.endpoint,
        "allowed-page",
        "--observation-ms",
        "0",
        "--json",
      ],
      process.env,
    );
    const inspection = normalizedResult(inspected);
    const missingVsKnown = await compareCapturesCli(
      redirectCapture(inspection, browser.allowedOrigin, null),
      redirectCapture(inspection, browser.allowedOrigin, 302),
    );
    expect(missingVsKnown).toMatchObject({
      normalized_result: {
        dimensions: {
          network: {
            status: "unknown",
            total_changes: 0,
            reason: expect.stringContaining("redirect"),
          },
        },
      },
    });
    const knownDifference = await compareCapturesCli(
      redirectCapture(inspection, browser.allowedOrigin, 302),
      redirectCapture(inspection, browser.allowedOrigin, 307),
    );
    expect(knownDifference).toMatchObject({
      normalized_result: {
        dimensions: { network: { status: "changed", total_changes: 1 } },
      },
    });
  },
  INTEGRATION_TEST_TIMEOUT_MS,
);

it(
  "browser CLI attaches through a browser socket and records it redacted",
  async () => {
    const browser = await startFakeCdpBrowser();
    browsers.push(browser);
    const inspected = await runCli(
      [
        "inspect-web-page",
        browser.browserWebSocketUrl,
        "allowed-page",
        "--observation-ms",
        "0",
        "--json",
      ],
      process.env,
    );
    expect(inspected).toMatchObject({
      operation: "inspect_web_page",
      parameters: {
        cdp_endpoint: browser.browserWebSocketUrl.replace(
          /fake$/u,
          "[REDACTED]",
        ),
      },
      normalized_result: { target: { target_id: "allowed-page" } },
    });
    expect(JSON.stringify(inspected)).not.toContain("/devtools/browser/fake");

    const refused = await runCli(
      [
        "list-browser-targets",
        browser.browserWebSocketUrl.replace(/fake$/u, "not-this-browser"),
        "--json",
      ],
      process.env,
    );
    expect(refused).toMatchObject({
      code: "provider_unavailable",
      details: {
        operation: "list_browser_targets",
        reason: "endpoint_unreachable",
      },
    });
    expect(JSON.stringify(refused)).not.toContain("not-this-browser");
  },
  INTEGRATION_TEST_TIMEOUT_MS,
);

describe("scenario comparison CLI diagnostics", () => {
  const rule = {
    rule_id: "domain",
    artifacts: ["url"],
    match: "app.example.test",
    replacement: "normalized.test",
  };
  it.each([
    {
      name: "duplicate rule IDs",
      normalization: { rules: [rule, rule] },
      issue: {
        path: ["normalization", "rules", 1, "rule_id"],
        reason: "invalid_value",
        message: "Normalization rule IDs must be unique",
      },
    },
    {
      name: "duplicate artifact kinds",
      normalization: { rules: [{ ...rule, artifacts: ["url", "url"] }] },
      issue: {
        path: ["normalization", "rules", 0, "artifacts"],
        reason: "invalid_value",
        message: "Normalization rule artifact kinds must be unique",
      },
    },
    {
      name: "structurally invalid rules",
      normalization: { rules: "invalid" },
      issue: {
        path: ["normalization", "rules"],
        reason: "invalid_type",
        expected: "array",
      },
    },
  ])(
    "retains scenario normalization diagnostics for $name",
    async ({ normalization, issue }) => {
      const capture = JSON.stringify(completeScenarioCapture());
      const result = await runCli([
        "compare-web-captures",
        capture,
        capture,
        "--normalization-json",
        JSON.stringify(normalization),
        "--json",
      ]);
      expect(result).toMatchObject({
        code: "invalid_request",
        details: { operation: "compare_web_captures", issues: [issue] },
      });
    },
  );

  it("keeps malformed scenario diagnostics in the selected capture group", async () => {
    const capture = completeScenarioCapture();
    const result = await runCli([
      "compare-web-captures",
      JSON.stringify({ ...capture, duration_ms: "invalid" }),
      JSON.stringify(capture),
      "--json",
    ]);
    expect(result).toMatchObject({
      code: "invalid_request",
      details: {
        operation: "compare_web_captures",
        issues: [
          {
            path: ["before_scenario", "duration_ms"],
            reason: "invalid_type",
            expected: "number",
          },
        ],
      },
    });
  });

  it.each(["omitted", "misspelled"])(
    "reports the missing scenario manifest when it is %s on both captures",
    async (kind) => {
      const { scenario, ...capture } = completeScenarioCapture();
      const input = JSON.stringify(
        kind === "omitted" ? capture : { ...capture, scneario: scenario },
      );
      const result = await runCli([
        "compare-web-captures",
        input,
        input,
        "--json",
      ]);
      expect(result).toMatchObject({
        code: "invalid_request",
        details: {
          operation: "compare_web_captures",
          issues: expect.arrayContaining([
            {
              path: ["before_scenario", "scenario"],
              reason: "missing_argument",
              expected: "object",
            },
            {
              path: ["after_scenario", "scenario"],
              reason: "missing_argument",
              expected: "object",
            },
          ]),
        },
      });
      expect(JSON.stringify(result)).not.toContain('"inspection"');
    },
  );
});

describe("scenario comparison recovery guidance", () => {
  it("reports independent network recovery alongside console differences", async () => {
    const base = completeScenarioCapture();
    const matchingSelection = scenarioCaptureWithConsole(
      "before",
      base.scenario.network_content,
    );
    const differentSelection = scenarioCaptureWithConsole("after", {
      ...base.scenario.network_content,
      response_body: true,
    });
    const changed = await compareCapturesCli(
      matchingSelection,
      differentSelection,
    );
    expect(changed).toMatchObject({
      normalized_result: {
        overall_status: "changed",
        steps: expect.arrayContaining([
          expect.objectContaining({
            step_id: "open-settings",
            artifact_diffs: expect.arrayContaining([
              expect.objectContaining({
                artifact: "events",
                status: "changed",
                reason: expect.stringContaining(
                  "Network content selections differ",
                ),
              }),
            ]),
          }),
        ]),
      },
    });
    const quietMismatch = await compareCapturesCli(
      matchingSelection,
      scenarioCaptureWithConsole(
        "before",
        differentSelection.scenario.network_content,
      ),
    );
    expect(quietMismatch).toMatchObject({
      normalized_result: {
        steps: expect.arrayContaining([
          expect.objectContaining({
            step_id: "open-settings",
            artifact_diffs: expect.arrayContaining([
              expect.objectContaining({
                artifact: "events",
                status: "unknown",
                reason: expect.stringContaining(
                  "Network content selections differ",
                ),
              }),
            ]),
          }),
        ]),
      },
    });
  });
});

describe("browser CLI capture parity", () => {
  it(
    "runs analysis, session, WebMCP, screenshot, and comparison from explicit request scope",
    async () => {
      const browser = await startFakeCdpBrowser({
        sessionTimeline: "same_origin",
        webMcpTools: true,
        sensitiveShapes: true,
      });
      browsers.push(browser);
      const scopeArgs = ["--allowed-origins", browser.allowedOrigin];
      const analyzed = await runCli(
        [
          "analyze-web-bundle",
          browser.endpoint,
          "allowed-page",
          ...scopeArgs,
          "--observation-ms",
          "0",
          "--json",
        ],
        process.env,
      );
      expect(analyzed).toMatchObject({
        operation: "analyze_web_bundle",
        normalized_result: {
          capture: { scripts_analyzed: 1 },
          observations: { source_maps: { status: "not_requested" } },
        },
      });
      const observedSession = await runCli(
        [
          "observe-web-session",
          browser.endpoint,
          "allowed-page",
          ...scopeArgs,
          "--observation-ms",
          "5",
          "--json",
        ],
        process.env,
      );
      expect(observedSession).toMatchObject({
        operation: "observe_web_session",
        normalized_result: {
          window: { end_reason: "window_elapsed" },
          timeline: expect.arrayContaining([
            expect.objectContaining({ type: "same_origin_reload" }),
          ]),
        },
      });
      const webMcp = await runCli(
        [
          "discover-webmcp-tools",
          browser.endpoint,
          "allowed-page",
          ...scopeArgs,
          "--observation-ms",
          "0",
          "--json",
        ],
        process.env,
      );
      expect(webMcp).toMatchObject({
        operation: "discover_webmcp_tools",
        normalized_result: {
          tools: {
            items: [
              expect.objectContaining({
                name: "search_orders",
                annotations: expect.objectContaining({
                  consequential: true,
                }),
              }),
            ],
          },
        },
      });
      const screenshot = await runCli(
        [
          "capture-web-screenshot",
          browser.endpoint,
          "allowed-page",
          ...scopeArgs,
          "--json",
        ],
        process.env,
      );
      const artifact = screenshotArtifact(screenshot);
      expect(artifact).toMatchObject({ media_type: "image/png", bytes: 70 });
      const visual = await runCli(
        [
          "compare-web-screenshots",
          JSON.stringify(artifact),
          JSON.stringify(artifact),
          "--json",
        ],
        process.env,
      );
      expect(visual).toMatchObject({
        operation: "compare_web_screenshots",
        normalized_result: { status: "identical", changed_pixels: 0 },
      });
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );
});

const screenshotArtifact = (value: unknown): Record<string, unknown> => {
  if (
    !isRecord(value) ||
    !isRecord(value.normalized_result) ||
    !isRecord(value.normalized_result.artifact)
  )
    throw new TypeError("Missing CLI screenshot artifact");
  return value.normalized_result.artifact;
};

const normalizedResult = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value) || !isRecord(value.normalized_result))
    throw new TypeError("Missing CLI normalized result");
  return value.normalized_result;
};

const redirectCapture = (
  inspection: Record<string, unknown>,
  origin: string,
  status: number | null,
) => {
  const copy = structuredClone(inspection);
  if (!isRecord(copy.network) || !Array.isArray(copy.network.requests))
    throw new Error("Missing network capture");
  const request = copy.network.requests[0];
  if (!isRecord(request)) throw new Error("Missing network request");
  request.redirects = [
    {
      url: `${origin}/prior`,
      response_url: `${origin}/prior`,
      method: "GET",
      resource_type: "Fetch",
      status,
      mime_type: "text/plain",
      encoded_data_length: 12,
      request_timestamp: 1,
      redirect_event_timestamp: 2,
    },
  ];
  return { inspection: copy };
};

const compareCapturesCli = (before: unknown, after: unknown) =>
  runCli(
    [
      "compare-web-captures",
      JSON.stringify(before),
      JSON.stringify(after),
      "--json",
    ],
    process.env,
  );

const completeScenarioCapture = () => {
  const url = {
    url: "https://app.example.test/",
    origin: "https://app.example.test",
    query_parameter_names: [],
    redacted: false,
  };
  const completeness = {
    status: "complete",
    equality_eligible: true,
    missing_sections: [],
    truncated_sections: [],
  };
  const artifacts = {
    screenshot: { state: "not_requested" },
    dom: { state: "not_requested" },
    accessibility: { state: "not_requested" },
    url: { state: "captured", value: url },
    history: { state: "not_requested" },
    storage: { state: "not_requested" },
  };
  const step = (stepIndex: number, stepId: string, action: string) => ({
    step_index: stepIndex,
    step_id: stepId,
    action,
    status: "completed",
    elapsed_ms: stepIndex,
    before_url: url,
    after_url: url,
    error: null,
    event_sequence_start: 1,
    event_sequence_end: 0,
    artifacts,
    completeness,
  });
  return {
    browser: {
      mode: "connect",
      process_ownership: "external",
      cleanup: "disconnected-external",
      product: "Chromium",
      version: "149",
    },
    scenario: {
      start_origin: "https://app.example.test",
      action_count: 1,
      secret_references: [],
      network_content: {
        request_body: false,
        response_body: false,
        header_values: false,
      },
      event_families: [],
      limits: DEFAULT_BROWSER_SCENARIO_CAPTURE_LIMITS,
    },
    duration_ms: 1,
    steps: [
      step(0, "scenario_start", "scenario_start"),
      step(1, "open-settings", "click"),
    ],
    events: {
      retained: 0,
      dropped: 0,
      items: [],
      omissions: {
        by_kind: [],
        network_transactions: [],
        network_transaction_range: null,
      },
    },
    completeness,
    limitations: [],
  };
};

const scenarioCaptureWithConsole = (
  text: string,
  networkContent: {
    readonly request_body: boolean;
    readonly response_body: boolean;
    readonly header_values: boolean;
  },
) => {
  const capture = completeScenarioCapture();
  return {
    ...capture,
    scenario: {
      ...capture.scenario,
      network_content: networkContent,
      event_families: ["console"],
    },
    events: {
      retained: 1,
      dropped: 0,
      items: [
        {
          sequence: 1,
          step_index: 1,
          kind: "console",
          level: "info",
          text,
          url: null,
        },
      ],
      omissions: {
        by_kind: [],
        network_transactions: [],
        network_transaction_range: null,
      },
    },
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
