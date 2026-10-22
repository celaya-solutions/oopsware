import type { Evidence } from "../../domain/evidence.js";
import { parseEvidence } from "../../domain/evidence.js";
import { EvidenceIntegrityError } from "../../domain/evidenceErrors.js";
import type { Result } from "../../domain/result.js";
import { err, ok } from "../../domain/result.js";

/**
 * Authenticate caller-supplied records. When `expectedOperations` is omitted,
 * the shared workflow owns which authentic operations it can use.
 */
const parseExpectedEvidence = (
  rawEvidence: readonly Evidence[],
  expectedOperations?: readonly string[],
): Result<Evidence[], EvidenceIntegrityError> => {
  try {
    const evidence = rawEvidence.map(parseEvidence);
    if (expectedOperations !== undefined)
      for (const record of evidence)
        if (
          !expectedOperations.includes(record.operation) ||
          record.predicate_type !== "rea.analysis"
        )
          throw new TypeError(
            `Expected ${expectedOperations.join(" or ")} Evidence, received ${record.operation}`,
          );
    return ok(evidence);
  } catch (cause: unknown) {
    return err(
      new EvidenceIntegrityError(
        cause instanceof Error ? cause.message : "Invalid Evidence",
      ),
    );
  }
};

export const resolveManagedEvidence = (
  evidence: Evidence,
): Result<Evidence[], EvidenceIntegrityError> =>
  parseExpectedEvidence([evidence], ["inspect_managed_members"]);

export const resolveManagedArtifactEvidence = (
  evidence: Evidence,
): Result<Evidence[], EvidenceIntegrityError> =>
  parseExpectedEvidence([evidence], ["inspect_managed_artifact"]);

export const resolveManagedBoundaryEvidence = (
  evidence: Evidence,
): Result<Evidence[], EvidenceIntegrityError> =>
  parseExpectedEvidence([evidence], ["inspect_managed_native_boundaries"]);

/**
 * Authenticate native observations without an operation allowlist: the domain
 * counts authentic operations it cannot read symbols from as unsupported.
 */
export const resolveNativeEvidence = (
  evidence: readonly Evidence[],
): Result<Evidence[], EvidenceIntegrityError> =>
  parseExpectedEvidence(evidence);

export const sourceEvidence = (input: {
  readonly managed_artifact?: Evidence | undefined;
  readonly managed_members?: Evidence | undefined;
  readonly managed_native_boundaries?: Evidence | undefined;
}): Evidence[] =>
  [
    input.managed_artifact,
    input.managed_members,
    input.managed_native_boundaries,
  ].filter((evidence): evidence is Evidence => evidence !== undefined);
