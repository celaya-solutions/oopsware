import type { AnalysisViewRequest } from "../domain/analysisView/analysisView.js";
import { z } from "incur";
import { parseEvidence, type Evidence } from "../domain/evidence.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { Result } from "../domain/result.js";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import { createEvidenceBundle } from "../domain/evidenceBundle.js";
import { writeEvidenceBundle } from "../application/EvidenceBundleFiles.js";
import { inspectAnalysisView } from "../application/analysisView/AnalysisViewService.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";

export const analysisEvidenceDeliveryOptions = {
  detail: z
    .enum(["complete", "summary"])
    .default("complete")
    .describe("Deliver complete Evidence, or a summary with --evidence_output"),
  evidence_output: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Save complete Evidence as a bundle; required for summary delivery. Never overwrites.",
    ),
};

const isEvidence = (value: JsonValue): value is Evidence =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  "evidence_id" in value &&
  "normalized_result" in value;

interface CliEvidenceDelivery {
  readonly view?: AnalysisViewRequest;
  readonly providerId: string;
  readonly operation: string;
  readonly signal: AbortSignal;
  readonly detail: "complete" | "summary";
  readonly evidenceOutput: string | undefined;
  /** Derived workflows publish their selected source closure with the result. */
  readonly sourceEvidence?: readonly Evidence[];
}

export const cliEvidenceDeliveryInputError = (
  input: Pick<CliEvidenceDelivery, "detail" | "evidenceOutput" | "operation">,
): AnalysisInputError | undefined =>
  input.detail === "summary" && input.evidenceOutput === undefined
    ? new AnalysisInputError(input.operation, undefined, [
        {
          path: ["evidence_output"],
          reason: "invalid_value",
          message:
            "Summary delivery requires --evidence_output so complete source Evidence remains available.",
        },
      ])
    : undefined;

/** One-shot delivery owns report publication; analysis keeps its own cleanup owner. */
export const deliverCliAnalysisEvidence = async (
  input: CliEvidenceDelivery & {
    readonly run: () => Promise<Result<Evidence, AnalysisError>>;
    readonly service: { close(): Promise<void> };
  },
) => {
  const {
    run,
    service,
    providerId,
    operation,
    signal,
    detail,
    evidenceOutput,
  } = input;
  const inputError = cliEvidenceDeliveryInputError(input);
  if (inputError !== undefined)
    return finishAnalysisCommand(
      async () => ({ ok: false, error: inputError }),
      service,
      providerId,
      operation,
      signal,
    );
  const complete = await finishAnalysisCommand(
    run,
    service,
    providerId,
    operation,
    signal,
  );
  return publishCliAnalysisEvidence(complete, {
    providerId,
    operation,
    signal,
    detail,
    evidenceOutput,
    ...(input.view === undefined ? {} : { view: input.view }),
  });
};

/** Publish already finalized CLI analysis without opening a second provider/session. */
export const publishCliAnalysisEvidence = async (
  value: JsonValue,
  input: CliEvidenceDelivery,
) => {
  const { providerId, operation, signal, detail, evidenceOutput } = input;
  if (!isEvidence(value)) return value;
  const complete = parseEvidence(value);
  const inputError = cliEvidenceDeliveryInputError(input);
  if (inputError !== undefined) {
    inputError.retainPartialObservation(complete);
    return projectAnalysisError(inputError);
  }
  if (evidenceOutput === undefined) return complete;
  const resources = new ArtifactResourceScope();
  let receipt: { readonly path: string; readonly bytes: number } | undefined;
  const delivered = await finishAnalysisCommand(
    async () => {
      const written = await writeEvidenceBundle(
        createEvidenceBundle([
          ...new Map(
            [...(input.sourceEvidence ?? []), complete].map((record) => [
              record.evidence_id,
              record,
            ]),
          ).values(),
        ]),
        absoluteCallerPath(evidenceOutput),
        false,
        resources,
        signal,
      );
      if (!written.ok) {
        if (written.error.partialObservation === undefined)
          written.error.retainPartialObservation(complete);
        return written;
      }
      receipt = written.value;
      return detail === "summary"
        ? inspectAnalysisView({
            source: { kind: "inline", evidence: complete },
            view: input.view ?? { kind: "summary" },
          })
        : { ok: true as const, value: complete };
    },
    { close: () => resources.close() },
    providerId,
    operation,
    signal,
  );
  return isEvidence(delivered) && detail === "summary"
    ? { summary: delivered, evidence_bundle: receipt }
    : delivered;
};
