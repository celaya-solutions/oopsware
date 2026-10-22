import { createHash } from "node:crypto";

import canonicalize from "canonicalize";
import { z } from "zod";

import { artifactComparisonResultSchema } from "./artifactComparison.js";
import { parseArtifactInventoryEvidence } from "./artifactInventoryEvidence.js";
import { uniqueSorted } from "./canonicalOrdering.js";
import { compareUnicodeCodePoints } from "./unicodeCodePointOrder.js";
import {
  comparisonSourceEvidenceSides,
  assertComparisonFindingLinks,
} from "./comparisonSourceEvidence.js";
import { parseEvidence, type Evidence } from "./evidence.js";
import { parseEvidenceBundle } from "./evidenceBundle.js";
import { functionComparisonResultSchema } from "./functionComparisonSchemas.js";
import {
  PROCESS_PROVIDER,
  isProcessEvidenceProvider,
} from "./process/processEvidenceProvider.js";
import { functionDossierSchema } from "./hopperValues.js";
import { assessFunctionCallCoverage } from "./functionCallCoverage.js";
import { processCaptureComparisonSchema } from "./process/processComparison.js";
import { parseProcessCapture } from "./process/processCaptureParsing.js";
import {
  reconstructionClaimResultSchema,
  reconstructionSpecificationSchema,
  reconstructionVerificationResultSchema,
  type ReconstructionClaim as Claim,
  type ReconstructionClaimResult as ClaimResult,
  type ReconstructionObservedStatus as ObservedStatus,
  type ReconstructionVerificationResult,
} from "./reconstructionVerificationSchemas.js";
import {
  reconstructionClaimUnknowns,
  reconstructionProbes,
  reconstructionUnknownHeads,
} from "./reconstructionUnknowns.js";
import type { ResidualUnknown } from "./residualUnknown.js";

const providers = {
  behavioral: {
    operation: "compare_process_captures",
    predicates: ["rea.process-comparison"],
    ...PROCESS_PROVIDER,
  },
  "structural-function": {
    operation: "compare_functions",
    predicates: ["rea.function-comparison"],
    id: "rea-function-comparison",
    name: "Oopsware function comparison",
  },
  "structural-artifact": {
    operation: "compare_artifacts",
    predicates: ["rea.artifact-comparison"],
    id: "rea-artifact-comparison",
    name: "Oopsware artifact comparison",
  },
} as const;

interface FunctionSourceFacts {
  readonly evidence_id: string;
  readonly callCoverageBlockers: readonly string[];
  readonly callCoverageDiagnostics: readonly string[];
}

const acceptsPredicate = (
  expected: readonly string[],
  actual: string,
): boolean => expected.some((predicate) => predicate === actual);

/** Verify only explicitly declared claims; no global equivalence is inferred. */
export const verifyReconstruction = (
  specificationInput: unknown,
  bundleInput: unknown,
): ReconstructionVerificationResult => {
  const specification =
    reconstructionSpecificationSchema.parse(specificationInput);
  const bundle = parseEvidenceBundle(bundleInput);
  const records = new Map(
    bundle.records.map((item) => [item.evidence_id, item]),
  );
  const heads = reconstructionUnknownHeads(bundle.unknowns);
  const results = specification.claims
    .map((claim) => evaluateClaim(claim, records, heads))
    .sort((left, right) =>
      compareUnicodeCodePoints(left.claim_id, right.claim_id),
    );
  const failed = count(results, "fail");
  const unresolved = count(results, "unknown");
  const probes = reconstructionProbes(results, heads);
  const evidenceLinks = uniqueSorted(
    results.flatMap(({ evidence_links: links }) => links),
  );
  const output = {
    status: failed > 0 ? "fail" : unresolved > 0 ? "unknown" : "pass",
    specification_sha256: digest({
      ...specification,
      claims: [...specification.claims].sort((left, right) =>
        compareUnicodeCodePoints(left.claim_id, right.claim_id),
      ),
    }),
    summary: {
      total: results.length,
      passed: count(results, "pass"),
      failed,
      unknown: unresolved,
      behavioral: results.filter(({ kind }) => kind === "behavioral").length,
      structural: results.filter(({ kind }) => kind !== "behavioral").length,
    },
    claims: {
      items: results,
    },
    recommended_probes: probes,
    evidence_links: evidenceLinks,
    limitations: [
      "Pass means every declared claim passed; it does not establish global implementation equivalence.",
    ],
  };
  return reconstructionVerificationResultSchema.parse(output);
};

const evaluateClaim = (
  claim: Claim,
  records: ReadonlyMap<string, Evidence>,
  heads: ReadonlyMap<string, ResidualUnknown>,
): ClaimResult => {
  const comparison = records.get(claim.comparison_evidence_id);
  if (comparison === undefined)
    throw new TypeError(
      `Missing comparison Evidence ${claim.comparison_evidence_id}`,
    );
  validateComparisonIdentity(claim, comparison);
  const sides = comparisonSourceEvidenceSides(comparison);
  const allSourceIds = uniqueSorted([...sides.left, ...sides.right]);
  if (!sameSet(comparison.evidence_links, allSourceIds))
    throw new TypeError(
      "Comparison Evidence closure disagrees with its parameters",
    );
  const sources = allSourceIds.map((id) => {
    const source = records.get(id);
    if (source === undefined)
      throw new TypeError(`Missing source Evidence ${id}`);
    return source;
  });
  const functionSourceFacts = readValidatedSourceFacts(claim, sources);
  const observation = comparisonObservation(claim, comparison);
  const observed = observation.status;
  const callCoverage = sourceCallCoverage(
    claim,
    functionSourceFacts,
    observation.hasIndependentFunctionChange === true,
  );
  const blockers = [
    ...authorityLimitations(claim, sources, sides),
    ...callCoverage.blockers,
  ];
  const relatedUnknowns = reconstructionClaimUnknowns(
    heads,
    comparison.evidence_id,
    allSourceIds,
    claim.dimension,
  );
  const relevantUnknowns = relatedUnknowns;
  const status = classify(observed, blockers, relevantUnknowns);
  const displayedUnknowns = relevantUnknowns;
  return reconstructionClaimResultSchema.parse({
    claim_id: claim.claim_id,
    kind: claim.kind,
    dimension: claim.dimension,
    status,
    observed_status: observed,
    comparison_evidence_id: comparison.evidence_id,
    left_evidence_ids: sides.left,
    right_evidence_ids: sides.right,
    evidence_links: uniqueSorted([comparison.evidence_id, ...allSourceIds]),
    unknown_ids: displayedUnknowns.map(({ unknown_id: id }) => id),
    limitations: uniqueSorted([
      ...comparison.limitations,
      ...observation.limitations,
      ...blockers,
      ...callCoverage.diagnostics,
      ...displayedUnknowns.map(
        ({ question }) => `Residual unknown: ${question}`,
      ),
    ]),
  });
};

const readValidatedSourceFacts = (
  claim: Claim,
  sources: readonly Evidence[],
): readonly FunctionSourceFacts[] => {
  const isExpectedType = (source: Evidence): boolean => {
    if (claim.kind === "behavioral")
      return (
        source.operation === "capture_process_scenario" &&
        source.predicate_type === "rea.process-capture"
      );
    if (claim.kind === "structural-function")
      return (
        source.operation === "analyze_function" &&
        source.predicate_type === "rea.analysis"
      );
    return (
      (source.operation === "inventory_artifact" ||
        source.operation === "inspect_artifact") &&
      source.predicate_type === "rea.analysis"
    );
  };
  if (sources.some((source) => !isExpectedType(source)))
    throw new TypeError(
      "Comparison source Evidence has an unexpected observation type",
    );
  const functionSources: FunctionSourceFacts[] = [];
  for (const source of sources) {
    if (claim.kind === "behavioral")
      parseProcessCapture(source.normalized_result);
    else if (claim.kind === "structural-function") {
      const dossier = functionDossierSchema.parse(source.normalized_result);
      const callCoverage = assessFunctionCallCoverage(
        source.relationship_coverage,
        dossier,
      );
      functionSources.push({
        evidence_id: source.evidence_id,
        callCoverageBlockers: callCoverage.blockers,
        callCoverageDiagnostics: callCoverage.diagnostics,
      });
    } else parseArtifactInventoryEvidence(source);
  }
  return functionSources;
};

const validateComparisonIdentity = (claim: Claim, evidence: Evidence): void => {
  parseEvidence(evidence);
  const expected = providers[claim.kind];
  if (
    evidence.operation !== expected.operation ||
    !acceptsPredicate(expected.predicates, evidence.predicate_type) ||
    (claim.kind === "behavioral"
      ? !isProcessEvidenceProvider(evidence.provider)
      : evidence.provider.id !== expected.id ||
        evidence.provider.name !== expected.name ||
        evidence.provider.version !== "1") ||
    evidence.confidence !== "derived" ||
    evidence.authority !== "analyst-inference" ||
    evidence.subject !== null
  )
    throw new TypeError("Comparison Evidence identity or authority disagrees");
};

const comparisonObservation = (
  claim: Claim,
  evidence: Evidence,
): {
  readonly status: ObservedStatus;
  readonly limitations: readonly string[];
  readonly hasIndependentFunctionChange?: boolean;
} => {
  if (claim.kind === "behavioral") {
    const result = processCaptureComparisonSchema.parse(
      evidence.normalized_result,
    );
    if (claim.dimension !== "overall")
      return { status: result[claim.dimension], limitations: [] };
    if (
      result.status === "unchanged" &&
      result.first_divergence.status === "unknown"
    )
      return {
        status: "unknown",
        limitations: [result.first_divergence.reason],
      };
    return {
      status: result.status,
      limitations: [],
    };
  }
  if (claim.kind === "structural-function") {
    const result = functionComparisonResultSchema.parse(
      evidence.normalized_result,
    );
    assertComparisonFindingLinks(
      evidence,
      result.dimensions.flatMap(({ evidence_links }) => evidence_links),
    );
    if (claim.dimension === "overall")
      return {
        status: result.status,
        limitations: result.dimensions.flatMap(
          ({ limitations }) => limitations,
        ),
        // Historical overall changes can be caused only by incomplete call
        // sets. Ignore that aggregate change when independently checking the
        // source call-coverage limitations.
        hasIndependentFunctionChange:
          result.function_match.status === "mismatched" ||
          (result.function_match.status === "matched" &&
            result.dimensions.some(
              (dimension) =>
                dimension.dimension !== "calls" &&
                dimension.status === "changed",
            )),
      };
    const dimension = result.dimensions.find(
      (item) => item.dimension === claim.dimension,
    );
    if (dimension === undefined)
      throw new TypeError("Function comparison dimension missing");
    return { status: dimension.status, limitations: dimension.limitations };
  }
  const result = artifactComparisonResultSchema.parse(
    evidence.normalized_result,
  );
  assertComparisonFindingLinks(
    evidence,
    result.changes.flatMap(({ evidence_links }) => evidence_links),
  );
  return { status: result.status, limitations: [] };
};

const authorityLimitations = (
  claim: Claim,
  sources: readonly Evidence[],
  sides: {
    readonly left: readonly string[];
    readonly right: readonly string[];
  },
): string[] => {
  const requiredAuthority =
    claim.kind === "behavioral" ? "controlled-replay" : "shipped-artifact";
  const limitations: string[] = [];
  if (sides.left.some((id) => sides.right.includes(id)))
    limitations.push(
      "A source observation appears on both comparison sides; independent original and reconstruction observations are unavailable.",
    );
  if (
    sources.some(
      (source) =>
        source.authority !== requiredAuthority ||
        (claim.kind === "structural-function"
          ? source.confidence === "inferred"
          : source.confidence !== "observed"),
    )
  )
    limitations.push(
      `Source Evidence lacks qualifying ${requiredAuthority} authority.`,
    );
  if (
    claim.kind !== "behavioral" &&
    sources.some(({ subject }) => subject === null)
  )
    limitations.push("Structural source artifact identity is unavailable.");
  if (claim.kind === "behavioral") {
    const referenceEnvironment = sources[0]?.environment;
    if (
      referenceEnvironment === null ||
      referenceEnvironment === undefined ||
      sources.some(
        ({ environment }) =>
          environment === null ||
          JSON.stringify(environment) !== JSON.stringify(referenceEnvironment),
      )
    )
      limitations.push(
        "Controlled replay environments are unavailable or incompatible.",
      );
  }
  return limitations;
};

const sourceCallCoverage = (
  claim: Claim,
  functionSources: readonly FunctionSourceFacts[],
  hasIndependentFunctionChange: boolean,
): { blockers: string[]; diagnostics: string[] } => {
  if (
    claim.kind !== "structural-function" ||
    (claim.dimension !== "calls" &&
      !(claim.dimension === "overall" && !hasIndependentFunctionChange))
  )
    return { blockers: [], diagnostics: [] };
  return {
    blockers: functionSources.flatMap(({ evidence_id, callCoverageBlockers }) =>
      callCoverageBlockers.map((reason) => `Source ${evidence_id}: ${reason}`),
    ),
    diagnostics: functionSources.flatMap(
      ({ evidence_id, callCoverageDiagnostics }) =>
        callCoverageDiagnostics.map(
          (reason) => `Source ${evidence_id}: ${reason}`,
        ),
    ),
  };
};

const classify = (
  observed: ObservedStatus,
  limitations: readonly string[],
  unknowns: readonly ResidualUnknown[],
): ClaimResult["status"] => {
  if (limitations.length > 0) return "unknown";
  if (["changed", "added", "removed", "contradiction"].includes(observed))
    return "fail";
  if (observed === "unknown" || observed === "truncated" || unknowns.length > 0)
    return "unknown";
  return "pass";
};

const digest = (value: unknown): string => {
  const encoded = canonicalize(value);
  if (encoded === undefined)
    throw new TypeError("Specification canonicalization failed");
  return createHash("sha256").update(encoded).digest("hex");
};

const count = (
  items: readonly ClaimResult[],
  status: ClaimResult["status"],
): number => items.filter((item) => item.status === status).length;
const sameSet = (left: readonly string[], right: readonly string[]): boolean =>
  uniqueSorted(left).length === uniqueSorted(right).length &&
  uniqueSorted(left).every((id, index) => id === uniqueSorted(right)[index]);
