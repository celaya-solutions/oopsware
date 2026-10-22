import { z } from "zod";

import {
  analysisViewResultSchema,
  type AnalysisViewResult,
} from "../../domain/analysisView/analysisView.js";
import { scenarioCaptureRecords } from "../../domain/analysisView/scenarioCaptureRecords.js";
import {
  readRecordedResponseBody,
  type RecordedResponseBody,
} from "../../domain/analysisView/recordedResponseBody.js";
import { readRecordedRequestLine } from "../../domain/analysisView/webNetworkRouteTemplates.js";
import { browserScenarioCaptureSchema } from "../../domain/browserScenarioCapture.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisInputError,
  type AnalysisInputIssue,
} from "../../domain/analysisErrorCore.js";
import { immutableEvidence, type Evidence } from "../../domain/evidence.js";
import { projectInputIssues } from "../../domain/inputIssueProjection.js";
import { immutableJsonSnapshotMember } from "../../domain/immutableJson.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  webNetworkCaptureSchema,
  type WebNetworkCaptureRecord,
} from "../../domain/webNetworkCapture.js";

/** Operation name every refusal of the serve command reports. */
export const ENVIRONMENT_SERVE_OPERATION = "environment-serve";

export type EnvironmentManifest = Extract<
  AnalysisViewResult,
  { kind: "environment-manifest" }
>;
export type EnvironmentManifestTool = EnvironmentManifest["tools"][number];

/** One retained parent record reduced to what a replay returns; a cut body is reported truncated. */
export interface RecordedExchange extends RecordedResponseBody {
  readonly ordinal: number;
  readonly path: string;
  /** WHATWG query spelling including `?`, or null when the request had none. */
  readonly query: string | null;
  readonly status: number | null;
  readonly contentType: string | null;
}

/** Replayed bodies larger than this are cut at a UTF-8 boundary and flagged. */
export const REPLAY_BODY_LIMIT_BYTES = 256 * 1024;

/** A HAR inspected by inspect_web_network_capture, or a session recorded by capture_browser_scenario. */
export type EnvironmentCaptureKind = "web-network-capture" | "browser-scenario";

/** A manifest and the parent capture it cites, authenticated and cross-checked. */
export interface EnvironmentSource {
  readonly manifest: EnvironmentManifest;
  readonly manifestEvidenceId: string;
  readonly evidenceId: string;
  /** Which REA operation recorded the parent capture. */
  readonly captureKind: EnvironmentCaptureKind;
  /**
   * SHA-256 of the captured artifact for a web network capture, or of the scenario definition for a
   * browser scenario; null when the capture excluded it from Evidence.
   */
  readonly captureSha256: string | null;
  /** Parent records cited by at least one tool, keyed by producer ordinal. */
  readonly exchanges: ReadonlyMap<number, RecordedExchange>;
}

const inputError = (
  operation: string,
  issues: readonly AnalysisInputIssue[],
  userMessage?: string,
): AnalysisInputError =>
  new AnalysisInputError(
    operation,
    userMessage === undefined ? undefined : { userMessage },
    issues,
  );

/** Authenticate one Evidence file; schema failures name the file role in their paths. */
const parseEvidenceFile = (
  operation: string,
  role: "manifest" | "evidence",
  value: unknown,
): Result<Evidence, AnalysisError> => {
  try {
    for (const key of ["parameters", "raw_result", "normalized_result"])
      immutableJsonSnapshotMember(value, key);
    return ok(immutableEvidence(value));
  } catch (cause: unknown) {
    if (!(cause instanceof z.ZodError)) throw cause;
    return err(
      inputError(
        operation,
        projectInputIssues(cause.issues, value).map((issue) => ({
          ...issue,
          path: [role, ...issue.path],
        })),
        `The ${role} file is not authenticated REA Evidence JSON.`,
      ),
    );
  }
};

const recordedExchange = (
  record: WebNetworkCaptureRecord,
): RecordedExchange | undefined => {
  const line = readRecordedRequestLine(record.reported, true, () => true);
  if (line === null || line.kind !== "line") return undefined;
  return {
    ordinal: record.ordinal,
    path: line.path,
    query: line.query === undefined || line.query === "" ? null : line.query,
    status: line.status,
    contentType: line.rawMime === "" ? null : line.rawMime,
    ...readRecordedResponseBody(record, REPLAY_BODY_LIMIT_BYTES),
  };
};

/** Authenticate the manifest file and require the environment-manifest view kind. */
const parseManifestEvidence = (
  operation: string,
  value: unknown,
): Result<
  { readonly manifest: EnvironmentManifest; readonly evidenceId: string },
  AnalysisError
> => {
  const evidence = parseEvidenceFile(operation, "manifest", value);
  if (!evidence.ok) return evidence;
  const view = analysisViewResultSchema.safeParse(
    evidence.value.normalized_result,
  );
  if (
    evidence.value.operation !== "inspect_analysis_view" ||
    !view.success ||
    view.data.kind !== "environment-manifest"
  )
    return err(
      inputError(
        operation,
        [
          {
            path: ["manifest", "normalized_result", "kind"],
            reason: "invalid_value",
            expected: "environment-manifest",
            message:
              "The manifest file must be inspect_analysis_view Evidence of kind environment-manifest.",
          },
        ],
        "The manifest file is not environment-manifest view Evidence.",
      ),
    );
  return ok({ manifest: view.data, evidenceId: evidence.value.evidence_id });
};

/** Authenticate the evidence file and require complete capture Evidence of either kind. */
const parseCaptureEvidence = (
  operation: string,
  value: unknown,
): Result<
  {
    readonly records: readonly WebNetworkCaptureRecord[];
    readonly evidenceId: string;
    readonly captureKind: EnvironmentCaptureKind;
    readonly captureSha256: string | null;
  },
  AnalysisError
> => {
  const evidence = parseEvidenceFile(operation, "evidence", value);
  if (!evidence.ok) return evidence;
  const { evidence_id: evidenceId } = evidence.value;
  const normalized = immutableJsonSnapshotMember(
    evidence.value,
    "normalized_result",
  );
  if (evidence.value.operation === "capture_browser_scenario") {
    const scenario = browserScenarioCaptureSchema.safeParse(normalized);
    const definition = z
      .object({ scenario_sha256: z.string() })
      .safeParse(evidence.value.parameters);
    if (scenario.success)
      return ok({
        records: scenarioCaptureRecords(scenario.data, "replay").records,
        evidenceId,
        captureKind: "browser-scenario",
        captureSha256: definition.success
          ? definition.data.scenario_sha256
          : null,
      });
  } else if (evidence.value.operation === "inspect_web_network_capture") {
    const records = immutableJsonSnapshotMember(normalized, "records");
    if (Array.isArray(records))
      for (let index = 0; index < records.length; index += 1) {
        const record = immutableJsonSnapshotMember(records, String(index));
        immutableJsonSnapshotMember(record, "reported");
      }
    const capture = webNetworkCaptureSchema.safeParse(normalized);
    if (capture.success) {
      // The manifest view projects HAR captures only, and replay reads HAR's response fields.
      if (capture.data.format !== "har")
        return err(
          inputError(
            operation,
            [
              {
                path: ["evidence", "normalized_result", "format"],
                reason: "invalid_value",
                expected: "har",
                message: `Agent environments replay HAR captures; this capture's format is ${capture.data.format}.`,
              },
            ],
            "The evidence file is not a HAR capture.",
          ),
        );
      return ok({
        records: capture.data.records,
        evidenceId,
        captureKind: "web-network-capture",
        captureSha256: capture.data.artifact.sha256,
      });
    }
  }
  return err(
    inputError(
      operation,
      [
        {
          path: ["evidence", "operation"],
          reason: "invalid_value",
          expected: "inspect_web_network_capture or capture_browser_scenario",
          message:
            "The evidence file must be complete inspect_web_network_capture or capture_browser_scenario Evidence.",
        },
      ],
      "The evidence file is not web network capture or browser scenario Evidence.",
    ),
  );
};

/**
 * Reduce every record a tool cites to its replayable exchange. Authentication
 * already proves the capture is the manifest's parent, so every cited ordinal
 * is a record with a request line; a record that still yields none is left
 * out and the tool refuses at call time.
 */
const indexExchanges = (
  manifest: EnvironmentManifest,
  records: readonly WebNetworkCaptureRecord[],
): ReadonlyMap<number, RecordedExchange> => {
  const byOrdinal = new Map(records.map((record) => [record.ordinal, record]));
  const exchanges = new Map<number, RecordedExchange>();
  for (const tool of manifest.tools)
    for (const ordinal of tool.record_ordinals) {
      if (exchanges.has(ordinal)) continue;
      const record = byOrdinal.get(ordinal);
      const exchange =
        record === undefined ? undefined : recordedExchange(record);
      if (exchange !== undefined) exchanges.set(ordinal, exchange);
    }
  return exchanges;
};

/**
 * Load the manifest Evidence and its parent capture Evidence, refusing any pair
 * that does not belong together; refusals name the command that loaded them.
 */
export const loadEnvironmentSource = (
  manifestValue: unknown,
  evidenceValue: unknown,
  operation: string = ENVIRONMENT_SERVE_OPERATION,
): Result<EnvironmentSource, AnalysisError> => {
  const manifest = parseManifestEvidence(operation, manifestValue);
  if (!manifest.ok) return manifest;
  const capture = parseCaptureEvidence(operation, evidenceValue);
  if (!capture.ok) return capture;
  const parentId = manifest.value.manifest.parent_evidence_id;
  if (parentId !== capture.value.evidenceId)
    return err(
      inputError(
        operation,
        [
          {
            path: ["evidence", "evidence_id"],
            reason: "invalid_value",
            expected: parentId,
            message: `The manifest cites parent Evidence ${parentId}; the evidence file is ${capture.value.evidenceId}.`,
          },
        ],
        "The manifest was projected from a different capture than the supplied evidence file.",
      ),
    );
  return ok({
    manifest: manifest.value.manifest,
    manifestEvidenceId: manifest.value.evidenceId,
    evidenceId: capture.value.evidenceId,
    captureKind: capture.value.captureKind,
    captureSha256: capture.value.captureSha256,
    exchanges: indexExchanges(manifest.value.manifest, capture.value.records),
  });
};
