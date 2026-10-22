import { setImmediate } from "node:timers/promises";
import { INSPECT_ANALYSIS_VIEW_OPERATION } from "../../domain/analysisView/analysisViewErrors.js";
import { z } from "zod";

import { ANALYSIS_VIEW_PROVIDER } from "../InvestigationProviders.js";
import type { EvidenceLookup } from "../EvidenceInputResolver.js";
import { resolveEvidenceInput } from "../EvidenceInputResolver.js";
import type { EvidenceWriter } from "../investigation/InvestigationRecordPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
} from "../../domain/analysisErrorCore.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { EvidenceIntegrityError } from "../../domain/evidenceErrors.js";
import {
  createEvidence,
  parseEvidence,
  type Evidence,
} from "../../domain/evidence.js";
import {
  inspectAnalysisViewInputSchema,
  projectAnalysisView,
  type AnalysisViewResult,
  type AnalysisViewRequest,
  type InspectAnalysisViewInput,
} from "../../domain/analysisView/analysisView.js";
import { jsonValueSchema } from "../../domain/jsonValue.js";
import {
  immutableJsonSnapshotMember,
  isImmutableJsonSnapshot,
} from "../../domain/immutableJson.js";
import { err, ok, type Result } from "../../domain/result.js";
import { WebNetworkApiSurfaceAccumulator } from "../../domain/analysisView/WebNetworkApiSurfaceAccumulator.js";
import { EnvironmentManifestAccumulator } from "../../domain/analysisView/EnvironmentManifestAccumulator.js";
import { EnvironmentStateAccumulator } from "../../domain/analysisView/EnvironmentStateAccumulator.js";
import { admitAnalysisViewData } from "../../domain/analysisView/analysisViewDataAdmission.js";
import {
  readEvidenceFileSource,
  type EvidenceFileReadOptions,
} from "./evidenceFileSource.js";

/** Authenticate a selected-view request and project already completed Evidence. */
export const inspectAnalysisView = (
  rawInput: unknown,
  lookup?: EvidenceLookup,
): Result<Evidence, AnalysisError> => {
  const parsed = inspectAnalysisViewInputSchema.safeParse(rawInput);
  if (!parsed.success)
    return err(
      analysisInputErrorFromIssues(
        INSPECT_ANALYSIS_VIEW_OPERATION,
        parsed.error.issues,
        rawInput,
        { cause: parsed.error },
      ),
    );
  return inspectAnalysisViewValidated(parsed.data, lookup);
};

/** Validate a request whose source may be an Evidence file, then project it. */
export const inspectAnalysisViewWithFiles = async (
  rawInput: unknown,
  lookup?: EvidenceLookup,
  options: EvidenceFileReadOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  const parsed = inspectAnalysisViewInputSchema.safeParse(rawInput);
  if (!parsed.success)
    return err(
      analysisInputErrorFromIssues(
        INSPECT_ANALYSIS_VIEW_OPERATION,
        parsed.error.issues,
        rawInput,
        { cause: parsed.error },
      ),
    );
  return inspectAnalysisViewValidatedWithFiles(parsed.data, lookup, options);
};

/**
 * Read and authenticate an Evidence-file source, then project it as retained
 * Evidence: its strings are bounded by the file reader rather than charged as
 * inline input. Other sources project unchanged.
 */
export const inspectAnalysisViewValidatedWithFiles = async (
  input: InspectAnalysisViewInput,
  lookup?: EvidenceLookup,
  options: EvidenceFileReadOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  if (input.source.kind !== "evidence-file")
    return inspectAnalysisViewValidated(input, lookup);
  const loaded = await readEvidenceFileSource(input.source.path, options);
  // Authentication and projection are synchronous; yield so a pending abort is dispatched before each check.
  const cancelled = async (): Promise<boolean> => {
    await setImmediate();
    return options.signal?.aborted === true;
  };
  // A request cancelled during authentication reports cancellation, even when authentication failed.
  if (await cancelled())
    return err(new AnalysisCancelledError(INSPECT_ANALYSIS_VIEW_OPERATION));
  if (!loaded.ok) return loaded;
  const id = loaded.value.evidence_id;
  const projected = inspectAnalysisViewValidated(
    { ...input, source: { kind: "retained-evidence", evidence_id: id } },
    (evidenceId) => (evidenceId === id ? loaded.value : lookup?.(evidenceId)),
  );
  // A request cancelled during projection delivers and records nothing.
  return (await cancelled())
    ? err(new AnalysisCancelledError(INSPECT_ANALYSIS_VIEW_OPERATION))
    : projected;
};

/** Authenticate borrowed inline Evidence after adapter envelope validation. */
export const inspectAnalysisViewValidated = (
  input: InspectAnalysisViewInput,
  lookup?: EvidenceLookup,
): Result<Evidence, AnalysisError> => {
  const apiSurfaceAccumulator =
    input.view.kind === "api-surface"
      ? new WebNetworkApiSurfaceAccumulator(
          undefined,
          input.view.include_query_parameter_names === true,
        )
      : undefined;
  const manifestAccumulator =
    input.view.kind === "environment-manifest"
      ? new EnvironmentManifestAccumulator(
          undefined,
          input.view.include_query_parameter_names,
          input.view.template_rules,
        )
      : undefined;
  const stateAccumulator =
    input.view.kind === "environment-state"
      ? new EnvironmentStateAccumulator(undefined, input.view.template_rules)
      : undefined;
  const accumulator =
    apiSurfaceAccumulator ?? manifestAccumulator ?? stateAccumulator;
  if (input.source.kind === "inline") {
    const admitted =
      accumulator === undefined
        ? admitAnalysisViewData(input.source.evidence, true)
        : accumulator.admitInlineEvidence(input.source.evidence);
    if (!admitted.ok) return admitted;
  }
  const resolved = resolveAnalysisViewSource(input.source, lookup);
  if (!resolved.ok) return resolved;
  const parent = resolved.value;
  const projected = projectAnalysisView(
    {
      evidenceId: parent.evidence_id,
      operation: parent.operation,
      provider: parent.provider,
      analysisProfileDigest: parent.analysis_profile?.digest ?? null,
      normalizedResult:
        immutableJsonSnapshotMember(parent, "normalized_result") ??
        parent.normalized_result,
      // Sealing an Evidence root deep-freezes it; only the root is registered.
      sealedResult: isImmutableJsonSnapshot(parent),
      subject: parent.subject,
      limitations: parent.limitations,
      parameters: parent.parameters,
      artifact:
        parent.subject === null
          ? null
          : {
              path: parent.subject.local_path,
              sha256: parent.subject.digest.sha256,
            },
    },
    input.view,
    {
      apiSurface: apiSurfaceAccumulator,
      manifest: manifestAccumulator,
      state: stateAccumulator,
    },
  );
  if (!projected.ok) return projected;
  if (
    parent.subject !== null &&
    parent.subject.digest.sha256 !== projected.value.artifact?.sha256
  )
    return err(
      new EvidenceIntegrityError(
        `Parent subject SHA-256 ${parent.subject.digest.sha256} differs from analysis artifact SHA-256 ${projected.value.artifact?.sha256 ?? "unknown"}.`,
      ),
    );
  return ok(createAnalysisViewEvidence(input, parent, projected.value));
};

/** Session Evidence ownership required to deliver a view instead of a complete record. */
export interface AnalysisViewRetention {
  readonly evidenceById: EvidenceLookup | undefined;
  readonly recordEvidence: EvidenceWriter["recordEvidence"] | undefined;
}

/** Fail before analysis when selected delivery cannot keep its complete source. */
export const requireAnalysisViewRetention = (
  operation: string,
  retention: AnalysisViewRetention,
): Result<
  {
    readonly evidenceById: EvidenceLookup;
    readonly recordEvidence: EvidenceWriter["recordEvidence"];
  },
  AnalysisError
> => {
  if (
    retention.recordEvidence === undefined ||
    retention.evidenceById === undefined
  )
    return err(
      new AnalysisCapabilityUnavailableError(
        ANALYSIS_VIEW_PROVIDER.id,
        operation,
        "summary detail requires a server session that retains Evidence for later views",
        {
          userMessage:
            "This server does not retain Evidence. Select detail complete to receive the complete analysis inline.",
        },
      ),
    );
  return ok({
    evidenceById: retention.evidenceById,
    recordEvidence: retention.recordEvidence,
  });
};

/**
 * Retain complete analysis Evidence in the session, then project its summary
 * view from the retained record. Callers page or select the rest through
 * inspect_analysis_view with the view's parent Evidence ID.
 */
export const summarizeRetainedAnalysis = (
  evidence: Evidence,
  retention: AnalysisViewRetention,
): Result<Evidence, AnalysisError> =>
  projectRetainedAnalysis(evidence, retention, { kind: "summary" });

/** Retain the complete owner observation and deliver one explicitly selected view. */
export const projectRetainedAnalysis = (
  evidence: Evidence,
  retention: AnalysisViewRetention,
  view: AnalysisViewRequest,
): Result<Evidence, AnalysisError> => {
  const ready = requireAnalysisViewRetention(evidence.operation, retention);
  if (!ready.ok) return ready;
  const recorded = ready.value.recordEvidence(evidence);
  if (!recorded.ok) return recorded;
  return inspectAnalysisViewValidated(
    {
      source: { kind: "retained-evidence", evidence_id: evidence.evidence_id },
      view,
    },
    ready.value.evidenceById,
  );
};

const resolveAnalysisViewSource = (
  source: InspectAnalysisViewInput["source"],
  lookup: EvidenceLookup | undefined,
): Result<Evidence, AnalysisError> => {
  if (source.kind === "retained-evidence")
    return resolveEvidenceInput(source, lookup);
  // Files are read by inspectAnalysisViewValidatedWithFiles, which the CLI and MCP adapters call.
  if (source.kind === "evidence-file")
    return err(
      new AnalysisCapabilityUnavailableError(
        ANALYSIS_VIEW_PROVIDER.id,
        INSPECT_ANALYSIS_VIEW_OPERATION,
        "evidence-file sources are read before projection",
      ),
    );
  return authenticateEvidence(source.evidence, ["source", "evidence"], {
    source,
  });
};

/** Parse complete Evidence, reporting schema issues under the given request path. */
const authenticateEvidence = (
  value: unknown,
  path: readonly (string | number)[],
  input: unknown,
): Result<Evidence, AnalysisError> => {
  try {
    return ok(parseEvidence(value));
  } catch (cause: unknown) {
    if (cause instanceof z.ZodError)
      return err(
        analysisInputErrorFromIssues(
          INSPECT_ANALYSIS_VIEW_OPERATION,
          cause.issues.map((issue) => ({
            ...issue,
            path: [...path, ...issue.path],
          })),
          input,
          { cause },
        ),
      );
    if (cause instanceof TypeError)
      return err(
        new EvidenceIntegrityError(
          cause.message,
          cause.message.length > 0 ? { userMessage: cause.message } : undefined,
        ),
      );
    throw cause;
  }
};

const createAnalysisViewEvidence = (
  input: InspectAnalysisViewInput,
  parent: Evidence,
  result: AnalysisViewResult,
): Evidence => {
  const target =
    parent.subject === null
      ? undefined
      : {
          path: parent.subject.local_path,
          sha256: parent.subject.digest.sha256,
          format: parent.subject.format,
          ...(parent.subject.architecture === null
            ? {}
            : { architecture: parent.subject.architecture }),
        };
  return createEvidence(target, ANALYSIS_VIEW_PROVIDER, {
    predicateType: "rea.analysis-view",
    operation: INSPECT_ANALYSIS_VIEW_OPERATION,
    parameters: {
      parent_evidence_id: parent.evidence_id,
      view: jsonValueSchema.parse(input.view),
    },
    result: jsonValueSchema.parse(result),
    rawResult: null,
    confidence:
      // Grouping is whole-capture, so any templated group or parameter makes the result inferred;
      // entity types and identity in an extracted state always are.
      result.kind === "environment-state" ||
      ((result.kind === "api-surface" ||
        result.kind === "environment-manifest") &&
        result.templated_groups > 0)
        ? "inferred"
        : "derived",
    authority: parent.authority,
    limitations: result.limitations,
    ...(result.kind === "native" && parent.relationship_coverage !== null
      ? { relationshipCoverage: parent.relationship_coverage }
      : {}),
    locations: [
      ...(result.artifact != null && result.artifact.path.length > 0
        ? [{ kind: "artifact-path" as const, path: result.artifact.path }]
        : []),
      ...(result.kind === "native" &&
      result.procedure_address !== null &&
      result.procedure_address.length > 0
        ? [{ kind: "address" as const, address: result.procedure_address }]
        : []),
    ],
    evidenceLinks: [parent.evidence_id],
  });
};
