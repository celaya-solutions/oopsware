import type { EvidenceLookup } from "../EvidenceInputResolver.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import { inspectAnalysisViewValidated } from "../analysisView/AnalysisViewService.js";
import { artifactInventorySummaryViewResultSchema } from "../../domain/analysisView/analysisView.js";
import {
  EvidenceIntegrityError,
  EvidenceReferenceError,
} from "../../domain/evidenceErrors.js";
import type { Evidence } from "../../domain/evidence.js";
import { err, ok, type Result } from "../../domain/result.js";

/** Resolve only an artifact summary's exact retained owner before comparison. */
export const resolveArtifactComparisonEvidence = (
  evidence: Evidence,
  evidenceById: EvidenceLookup | undefined,
): Result<Evidence, AnalysisError> => {
  if (evidence.operation !== "inspect_analysis_view") return ok(evidence);

  const summary = artifactInventorySummaryViewResultSchema.safeParse(
    evidence.normalized_result,
  );
  if (!summary.success)
    return err(
      new AnalysisInputError("compare_artifacts", undefined, [
        {
          path: ["evidence"],
          reason: "invalid_value",
          message:
            "Artifact comparison accepts only an artifact inventory summary from inspect_analysis_view.",
        },
      ]),
    );

  const parentId = summary.data.parent_evidence_id;
  const parent = evidenceById?.(parentId);
  if (parent === undefined)
    return err(
      new EvidenceReferenceError(
        parentId,
        "missing",
        "retained complete artifact inventory Evidence",
        null,
      ),
    );
  const reprojected = inspectAnalysisViewValidated(
    {
      source: { kind: "retained-evidence", evidence_id: parentId },
      view: { kind: "summary" },
    },
    (evidenceId) => (evidenceId === parentId ? parent : undefined),
  );
  if (!reprojected.ok) return reprojected;
  if (reprojected.value.evidence_id !== evidence.evidence_id)
    return err(
      new EvidenceIntegrityError(
        "Artifact summary does not match its retained parent inventory.",
      ),
    );
  return ok(parent);
};
