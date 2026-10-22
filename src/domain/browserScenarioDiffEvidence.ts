import type {
  BrowserScenarioCompleteness,
  BrowserScenarioCompletenessSection,
  BrowserScenarioStep,
  BrowserStepArtifacts,
} from "./browserScenarioCaptureValues.js";
import type { BrowserScenarioCapture } from "./browserScenarioCapture.js";
import {
  fingerprintScenarioNetworkTransactions,
  scenarioNetworkTransactions,
  scenarioNetworkCoverageReason,
} from "./browserScenarioNetworkComparison.js";
import type {
  BrowserScenarioArtifactKind,
  BrowserScenarioEvidenceState,
  BrowserScenarioNormalizationRule,
} from "./browserScenarioDiffValues.js";

/** Capture-state input consumed by browser scenario artifact comparison. */
export type CaptureState<Value> =
  | { readonly state: "captured"; readonly value: Value }
  | { readonly state: "not_requested" }
  | { readonly state: "missing"; readonly reason: string }
  | {
      readonly state: "truncated";
      readonly observed: number;
      readonly retained: number;
      readonly reason: string;
    };

const includesCompletenessSection = (
  completeness: BrowserScenarioCompleteness,
  collection: "missing_sections" | "truncated_sections",
  section: BrowserScenarioCompletenessSection,
): boolean => {
  const sections: readonly BrowserScenarioCompletenessSection[] =
    completeness[collection];
  return sections.includes(section);
};

/** Project one captured artifact through its step-level completeness ledger. */
export const artifactEvidenceState = <Value>(
  artifact: BrowserScenarioArtifactKind,
  state: CaptureState<Value>,
  step: BrowserScenarioStep,
): BrowserScenarioEvidenceState => {
  if (state.state !== "captured") return state.state;
  const section = artifact === "action_state" ? "action" : artifact;
  if (
    includesCompletenessSection(
      step.completeness,
      "truncated_sections",
      section,
    )
  )
    return "truncated";
  return includesCompletenessSection(
    step.completeness,
    "missing_sections",
    section,
  )
    ? "missing"
    : "captured";
};

const EVENT_SECTIONS = [
  "events",
  "frames",
  "workers",
  "popups",
  "websockets",
] as const;

/** Project event evidence through capture- and step-level completeness. */
export const eventEvidenceState = (
  capture: BrowserScenarioCapture,
  step: BrowserScenarioStep,
): BrowserScenarioEvidenceState => {
  const listed = (collection: "missing_sections" | "truncated_sections") =>
    EVENT_SECTIONS.some(
      (section) =>
        includesCompletenessSection(
          capture.completeness,
          collection,
          section,
        ) ||
        includesCompletenessSection(step.completeness, collection, section),
    );
  if (capture.events.dropped > 0 || listed("truncated_sections"))
    return "truncated";
  return listed("missing_sections") ? "missing" : "captured";
};

/** Select stable action fields for normalized comparison. */
export const actionState = (step: BrowserScenarioStep) => ({
  action: step.action,
  status: step.status,
  before_url: step.before_url,
  after_url: step.after_url,
  error: step.error,
});

/** One step's ordered events and a single indexed network graph. */
export interface ScenarioStepEvents {
  readonly events: readonly unknown[];
  readonly network_transactions: readonly string[];
}

/** Build one graph and fingerprint index per capture, then select in linear total work. */
export const prepareScenarioEvents = (
  capture: BrowserScenarioCapture,
  rules: readonly BrowserScenarioNormalizationRule[],
): {
  readonly coverageReason: string | undefined;
  readonly forStep: (stepIndex: number) => ScenarioStepEvents;
} => {
  const eventsByStep = new Map<number, unknown[]>();
  for (const { sequence: _sequence, step_index, ...event } of capture.events
    .items) {
    if ("transaction_id" in event) continue;
    const events = eventsByStep.get(step_index) ?? [];
    events.push(event);
    eventsByStep.set(step_index, events);
  }
  const nodes = scenarioNetworkTransactions(capture);
  const fingerprints = fingerprintScenarioNetworkTransactions(nodes, rules);
  const networkByStep = new Map<number, string[]>();
  for (const [index, node] of nodes.entries()) {
    const step = networkByStep.get(node.step_index) ?? [];
    const fingerprint = fingerprints[index];
    if (fingerprint === undefined)
      throw new Error("Network comparison node has no fingerprint");
    step.push(fingerprint);
    networkByStep.set(node.step_index, step);
  }
  for (const fingerprintsForStep of networkByStep.values())
    fingerprintsForStep.sort();
  return {
    coverageReason: scenarioNetworkCoverageReason(capture, nodes),
    forStep: (stepIndex) => ({
      events: eventsByStep.get(stepIndex) ?? [],
      network_transactions: networkByStep.get(stepIndex) ?? [],
    }),
  };
};

/** Different content selection is missing comparability, not an observed website change. */
export const networkContentCoverageReason = (
  before: BrowserScenarioCapture,
  after: BrowserScenarioCapture,
): string | undefined => {
  const left = before.scenario.network_content;
  const right = after.scenario.network_content;
  return left.request_body !== right.request_body ||
    left.response_body !== right.response_body ||
    left.header_values !== right.header_values
    ? "Network content selections differ; capture both sides with matching content selection before comparing network evidence."
    : undefined;
};

/** Different event-family selection is missing comparability, not an observed website change. */
export const eventFamilyCoverageReason = (
  before: BrowserScenarioCapture,
  after: BrowserScenarioCapture,
): string | undefined => {
  const left = before.scenario.event_families;
  const right = after.scenario.event_families;
  const leftFamilies = new Set(left);
  const rightFamilies = new Set(right);
  return leftFamilies.size === rightFamilies.size &&
    [...leftFamilies].every((family) => rightFamilies.has(family))
    ? undefined
    : `Event family selections differ (${familyList(leftFamilies)} before, ${familyList(rightFamilies)} after); capture both sides with matching event families before comparing event evidence.`;
};

const familyList = (families: ReadonlySet<string>): string =>
  families.size === 0 ? "none" : [...families].sort().join(", ");

/** Wrap one value as captured comparison evidence. */
export const captured = <Value>(value: Value): CaptureState<Value> => ({
  state: "captured",
  value,
});

/** Retain stable screenshot identity without embedding image bytes. */
export const screenshotProjection = (
  screenshot: Extract<
    BrowserStepArtifacts["screenshot"],
    { state: "captured" }
  >["value"],
) => ({
  sha256: screenshot.sha256,
  bytes: screenshot.bytes,
  media_type: screenshot.media_type,
});
