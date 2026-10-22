import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import type { EvidenceLookup } from "../application/EvidenceInputResolver.js";
import {
  requireAnalysisViewRetention,
  summarizeRetainedAnalysis,
} from "../application/analysisView/AnalysisViewService.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import type { Evidence } from "../domain/evidence.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { ok } from "../domain/result.js";
import type { Logger } from "pino";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";

/** Registration inputs shared by provider-backed Evidence tool families. */
export interface EvidenceToolFamilyOptions {
  readonly logger: Logger;
  readonly activeTarget: (() => BinaryTarget | undefined) | undefined;
  readonly recordEvidence: EvidenceWriter["recordEvidence"] | undefined;
  readonly evidenceById?: EvidenceLookup | undefined;
  readonly withAdmittedAnalysis: WithAdmittedAnalysis;
}

type Parameters = Readonly<Record<string, JsonValue>>;

/**
 * Summary delivery for the named operations: refuse it before analysis when
 * this server retains no Evidence, then return the retained summary view.
 */
export const retainedSummaryDelivery = (
  operations: ReadonlySet<string>,
  options: Pick<EvidenceToolFamilyOptions, "recordEvidence" | "evidenceById">,
) => {
  const retention = {
    recordEvidence: options.recordEvidence,
    evidenceById: options.evidenceById,
  };
  const selected = (operation: string, parameters: Parameters): boolean =>
    operations.has(operation) && parameters.detail === "summary";
  return {
    preflight: (operation: string, parameters: Parameters) =>
      selected(operation, parameters)
        ? requireAnalysisViewRetention(operation, retention)
        : ok(null),
    projectEvidence: (
      operation: string,
      parameters: Parameters,
      evidence: Evidence,
    ) =>
      selected(operation, parameters)
        ? summarizeRetainedAnalysis(evidence, retention)
        : ok(evidence),
  };
};

/** Delivery detail selects a response shape; it never reaches tools or Evidence identity. */
export const withoutDeliveryDetail =
  (operations: ReadonlySet<string>) =>
  (operation: string, parameters: Parameters): Parameters => {
    if (!operations.has(operation)) return parameters;
    const { detail: _detail, ...selected } = parameters;
    return selected;
  };
