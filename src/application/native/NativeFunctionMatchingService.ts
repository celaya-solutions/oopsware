import { NativeMatchingAdmission } from "./NativeMatchingAdmission.js";
import { loadNativeMatchingBundleSources } from "./NativeMatchingBundleSources.js";
import { RegularFileCleanupFailure } from "../RegularFileRead.js";
import { matchFunctionInventories } from "../../domain/native/matchFunctionInventories.js";
import type { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { setImmediate } from "node:timers/promises";
import { matchNativeFunctionsInputSchema } from "../../contracts/native/functionMatchingContracts.js";
import { retainedEvidenceReferenceSchema } from "../../domain/evidenceReference.js";
import {
  createEvidence,
  parseEvidence,
  type Evidence,
} from "../../domain/evidence.js";
import { readFunctionInventory } from "../../domain/native/functionInventory.js";
import { nativeFunctionMatchingSchema } from "../../domain/native/functionMatching.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
} from "../../domain/analysisErrorCore.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  resolveEvidenceInput,
  type EvidenceLookup,
} from "../EvidenceInputResolver.js";
import type { ExecutionOptions } from "../AnalysisProvider.js";
import { FUNCTION_COMPARISON_PROVIDER } from "../InvestigationProviders.js";

const OPERATION = "match_native_functions";
export interface NativeFunctionMatchingResult {
  readonly evidence: Evidence;
  readonly sources: readonly Evidence[];
}

/** Pair existing observations through one source/analysis admission. */
export const matchNativeFunctions = (
  rawInput: unknown,
  options?: ExecutionOptions,
  lookup?: EvidenceLookup,
): Promise<Result<NativeFunctionMatchingResult, AnalysisError>> =>
  matchWithAdmission(
    rawInput,
    options,
    lookup,
    new NativeMatchingAdmission(OPERATION, options?.signal),
  );

const matchWithAdmission = async (
  rawInput: unknown,
  options: ExecutionOptions | undefined,
  lookup: EvidenceLookup | undefined,
  admission: NativeMatchingAdmission,
): Promise<Result<NativeFunctionMatchingResult, AnalysisError>> => {
  try {
    const checkpoint = admission.checkpoint;
    await setImmediate();
    await checkpoint();
    const parsed = matchNativeFunctionsInputSchema.safeParse(rawInput);
    if (!parsed.success)
      return err(
        analysisInputErrorFromIssues(OPERATION, parsed.error.issues, rawInput),
      );
    const sources = new Map<string, Evidence>();
    const resolve = async (input: unknown): Promise<Evidence> => {
      const reference = retainedEvidenceReferenceSchema.safeParse(input);
      let raw = input;
      if (reference.success) {
        const found = resolveEvidenceInput(reference.data, lookup);
        if (!found.ok) throw found.error;
        raw = found.value;
      }
      await admission.admit(raw);
      const evidence = parseEvidence(raw);
      const cached = sources.get(evidence.evidence_id);
      if (cached !== undefined) return cached;
      sources.set(evidence.evidence_id, evidence);
      return evidence;
    };
    const left = await resolve(parsed.data.left),
      right = await resolve(parsed.data.right);
    const observations = async (inputs: readonly unknown[]) => {
      const result: Evidence[] = [];
      const seen = new Set<string>();
      for (const input of inputs) {
        const record = await resolve(input);
        if (!seen.has(record.evidence_id)) {
          seen.add(record.evidence_id);
          result.push(record);
        }
      }
      return result;
    };
    const leftObservations = await observations(parsed.data.left_observations);
    const rightObservations = await observations(
      parsed.data.right_observations,
    );
    const directLinks = [...sources.keys()].sort();
    // Expand provenance separately from role observations: dependencies may be
    // any Evidence operation and must not be interpreted as native body facts.
    for (const source of sources.values())
      for (const id of source.evidence_links)
        if (!sources.has(id))
          await resolve({ kind: "retained-evidence", evidence_id: id });
    const leftFunctions = await readFunctionInventory(
      left,
      leftObservations,
      checkpoint,
    );
    const rightFunctions = await readFunctionInventory(
      right,
      rightObservations,
      checkpoint,
    );
    const compatible =
      left.subject?.architecture != null &&
      left.subject.architecture === right.subject?.architecture;
    const { matches, summary } = await matchFunctionInventories(
      leftFunctions,
      rightFunctions,
      { identicalBytesComparable: compatible, checkpoint },
    );
    const limitations = [
      ...new Set([
        ...left.limitations.map((x) => `Left: ${x}`),
        ...right.limitations.map((x) => `Right: ${x}`),
        "Coverage is restricted to the supplied provider-observed inventories; missing/truncated inventory facts never prove absence from either binary.",
        "Only unique exact symbols and bytes are paired. Compatible observed CFG/call/string fingerprints propose unresolved candidates, never identity or equivalence. Missing structural coverage stays unknown.",
        "Name or byte correspondence is not behavioral equivalence; use analyze_function for selected pairs, then compare_functions. Existing dossier pairs include directly usable retained-reference inputs.",
        ...(!compatible
          ? [
              "Identical-byte matching unavailable: input architectures are missing or differ.",
            ]
          : []),
      ]),
    ];
    const report = nativeFunctionMatchingSchema.parse({
      left: {
        evidence_id: left.evidence_id,
        sha256: left.subject!.digest.sha256,
        functions: leftFunctions.length,
      },
      right: {
        evidence_id: right.evidence_id,
        sha256: right.subject!.digest.sha256,
        functions: rightFunctions.length,
      },
      scope: "provider-observed-inputs",
      source_coverage: {
        status:
          summary.only_left + summary.only_right + summary.unresolved > 0
            ? "partial"
            : "complete-within-inputs",
        left_inventory_completeness: "unknown",
        right_inventory_completeness: "unknown",
        left_byte_fingerprints: leftFunctions.filter(
          (x) => x.fingerprint !== null,
        ).length,
        left_structural_candidates: leftFunctions.filter(
          (x) => x.member.structural_candidate_sha256 !== null,
        ).length,
        right_structural_candidates: rightFunctions.filter(
          (x) => x.member.structural_candidate_sha256 !== null,
        ).length,
        right_byte_fingerprints: rightFunctions.filter(
          (x) => x.fingerprint !== null,
        ).length,
      },
      summary,
      matches,
      limitations,
    });
    await checkpoint();
    const evidence = createEvidence(undefined, FUNCTION_COMPARISON_PROVIDER, {
      operation: OPERATION,
      predicateType: "rea.native-function-matching",
      confidence: "derived",
      authority: "analyst-inference",
      parameters: {
        left_evidence_id: left.evidence_id,
        right_evidence_id: right.evidence_id,
        left_observation_ids: leftObservations.map((x) => x.evidence_id),
        right_observation_ids: rightObservations.map((x) => x.evidence_id),
        algorithm: "exact-symbol-body-bytes-and-structural-candidates-v1",
      },
      result: report,
      limitations,
      evidenceLinks: directLinks,
    });
    await checkpoint();
    return ok({ evidence, sources: [...sources.values()] });
  } catch (cause: unknown) {
    if (options?.signal?.aborted)
      return err(
        new AnalysisCancelledError(OPERATION, { cause: options.signal.reason }),
      );
    if (cause instanceof AnalysisError) return err(cause);
    return err(
      new AnalysisInputError(OPERATION, { cause }, [
        {
          path: [],
          reason: "invalid_value",
          message:
            cause instanceof Error
              ? cause.message
              : "Invalid native matching observations",
        },
      ]),
    );
  }
};

/** Load selected portable records; do not retain unrelated records across bundles. */
export const matchNativeFunctionsFromBundles = async (
  input: unknown,
  paths: readonly string[],
  resources: ArtifactResourceScope,
  options?: ExecutionOptions,
): Promise<Result<NativeFunctionMatchingResult, AnalysisError>> => {
  try {
    const parsed = matchNativeFunctionsInputSchema.safeParse(input);
    if (!parsed.success)
      return err(
        analysisInputErrorFromIssues(OPERATION, parsed.error.issues, input),
      );
    const admission = new NativeMatchingAdmission(OPERATION, options?.signal);
    const loaded = await loadNativeMatchingBundleSources({
      input: parsed.data,
      paths,
      resources,
      admission,
    });
    return await matchWithAdmission(
      loaded.input,
      options,
      loaded.lookup,
      admission,
    );
  } catch (cause: unknown) {
    // This marker carries the exact descriptor owner; the caller must finish
    // that owner before classifying cancellation or unexpected I/O failures.
    if (cause instanceof RegularFileCleanupFailure) throw cause;
    if (options?.signal?.aborted)
      return err(
        new AnalysisCancelledError(OPERATION, { cause: options.signal.reason }),
      );
    if (cause instanceof AnalysisError) return err(cause);
    return err(new AnalysisInputError(OPERATION, { cause }));
  }
};
