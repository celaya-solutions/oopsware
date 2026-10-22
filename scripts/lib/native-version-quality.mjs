import assert from "node:assert/strict";
import { parseEvidence } from "../../dist/domain/evidence.js";
import { toolContract } from "../../dist/contracts/toolContracts.js";
import { nativeVersionComparisonResultSchema } from "../../dist/domain/nativeVersionComparisonSchemas.js";

export function requireSymbol(table, name) {
  const value = table.get(name);
  assert.ok(value, `Compiler/nm fixture omitted ${name}`);
  return value;
}

export function validateEvidence(value, leftHash, rightHash) {
  const evidence = parseEvidence(
    toolContract("compare_native_versions").outputSchema.parse(value),
  );
  const result = nativeVersionComparisonResultSchema.parse(
    evidence.normalized_result,
  );
  assert.equal(result.completeness, "provider-inventory");
  for (const [side, hash] of [
    [result.left, leftHash],
    [result.right, rightHash],
  ]) {
    assert.equal(side.sha256, hash);
    assert.deepEqual(side.failures, []);
    const inventory = parseEvidence(side.inventory);
    assert.equal(inventory.subject.digest.sha256, hash);
    assert.equal(side.functions.length, inventory.normalized_result.length);
    for (const source of [inventory, ...side.functions]) {
      const parsed = parseEvidence(source);
      assert.equal(parsed.subject.digest.sha256, hash);
      assert.ok(
        evidence.evidence_links.includes(parsed.evidence_id),
        "Comparison lost a source Evidence reference",
      );
    }
  }
  return result;
}

function labelCorpus(corpus) {
  const pairs = [
    ["parse_header", "decode_header"],
    ["check_length", "check_length"],
    ["same_helper", "same_helper"],
    ["main", "main"],
  ];
  const leftLabels = new Map(),
    rightLabels = new Map();
  for (const [l, r] of pairs) {
    leftLabels.set(requireSymbol(corpus.before.symbols, l), l);
    rightLabels.set(requireSymbol(corpus.after.symbols, r), r);
  }
  for (const name of ["duplicate_a", "duplicate_b"]) {
    leftLabels.set(
      requireSymbol(corpus.before.symbols, name),
      "duplicate_family",
    );
    rightLabels.set(
      requireSymbol(corpus.after.symbols, name),
      "duplicate_family",
    );
  }
  leftLabels.set(
    requireSymbol(corpus.before.symbols, "removed_helper"),
    "removed_helper",
  );
  rightLabels.set(
    requireSymbol(corpus.after.symbols, "added_helper"),
    "added_helper",
  );
  const key = (l, r) => `${l} -> ${r}`;
  const truth = new Set([
    ...pairs.map(([l, r]) => key(l, r)),
    key("duplicate_family", "duplicate_family"),
  ]);
  return { pairs, leftLabels, rightLabels, key, truth };
}

export function quality(result, corpus) {
  const { pairs, leftLabels, rightLabels, key, truth } = labelCorpus(corpus);
  const predictions = new Set();
  for (const candidate of result.candidates) {
    const l = leftLabels.get(candidate.left.address),
      r = rightLabels.get(candidate.right.address);
    if (l !== undefined && r !== undefined) predictions.add(key(l, r));
  }
  const correct = [...predictions].filter((pair) => truth.has(pair));
  const automatic = result.comparisons.filter(
    (pair) => pair.selection !== "analyst-selected",
  );
  const labeledAutomatic = automatic.filter(
    (pair) =>
      leftLabels.has(pair.left.address) && rightLabels.has(pair.right.address),
  );
  const automaticCorrect = labeledAutomatic.filter((pair) =>
    truth.has(
      key(
        leftLabels.get(pair.left.address),
        rightLabels.get(pair.right.address),
      ),
    ),
  );
  verifyLabeledMatches(result, corpus, {
    pairs,
    leftLabels,
    rightLabels,
    automatic,
    automaticCorrect,
    labeledAutomatic,
  });
  return {
    universe:
      "Seven source-labeled functions per side. Four one-to-one correspondences plus one two-by-two duplicate family; added/removed helpers are negative labels. Imported/runtime functions are excluded from quality denominators.",
    left_labeled_functions: leftLabels.size,
    right_labeled_functions: rightLabels.size,
    true_correspondence_groups: truth.size,
    provider_missing_labeled_addresses: {
      left: [...leftLabels.keys()].filter(
        (address) =>
          !result.left.functions.some(
            (evidence) =>
              evidence.normalized_result.procedure.address === address,
          ),
      ),
      right: [...rightLabels.keys()].filter(
        (address) =>
          !result.right.functions.some(
            (evidence) =>
              evidence.normalized_result.procedure.address === address,
          ),
      ),
    },
    retrieved_candidate_groups: predictions.size,
    correct_candidate_groups: correct.length,
    candidate_group_precision:
      predictions.size === 0 ? null : correct.length / predictions.size,
    candidate_group_recall: correct.length / truth.size,
    automatic_labeled_pairs: labeledAutomatic.length,
    automatic_correct_labeled_pairs: automaticCorrect.length,
    automatic_labeled_precision:
      labeledAutomatic.length === 0
        ? null
        : automaticCorrect.length / labeledAutomatic.length,
    automatic_unlabeled_pairs_excluded:
      automatic.length - labeledAutomatic.length,
    duplicate_family: {
      left_members: 2,
      right_members: 2,
      metric_weight: 1,
      automatically_selected: 0,
    },
    total_provider_functions: [
      result.left.functions.length,
      result.right.functions.length,
    ],
    total_candidates: result.candidates.length,
  };
}

export function verifyPatch(result, corpus) {
  const pair = result.comparisons.find(
    (item) => item.selection === "analyst-selected",
  );
  assert.ok(pair, "Explicit patch pair was not compared");
  assert.equal(
    pair.left.address,
    requireSymbol(corpus.before.symbols, "check_length"),
  );
  assert.equal(
    pair.right.address,
    requireSymbol(corpus.after.symbols, "check_length"),
  );
  assert.ok(
    pair.comparison.dimensions.some(
      (dimension) =>
        dimension.dimension === "assembly" && dimension.status === "changed",
    ),
  );
  assert.ok(
    result.changed_candidates.some(
      (candidate) =>
        candidate.left_address === pair.left.address &&
        candidate.right_address === pair.right.address,
    ),
  );
  return {
    status: pair.comparison.status,
    changed_dimensions: pair.comparison.dimensions
      .filter((dimension) => dimension.status === "changed")
      .map((dimension) => dimension.dimension),
    semantic_equivalence_claimed: false,
  };
}

export function withoutEvidenceIds(value) {
  if (Array.isArray(value)) return value.map(withoutEvidenceIds);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !["evidence_id", "evidence_links"].includes(key))
        .map(([key, child]) => [key, withoutEvidenceIds(child)]),
    );
  return value;
}

export function optimizationQuality(optimizedResult, corpus) {
  const survivingSymbolPairs = ["main", "inline_wrapper"].map((name) => ({
    left: requireSymbol(corpus.optimized.O0.symbols, name),
    right: requireSymbol(corpus.optimized.O2.symbols, name),
  }));
  const optimizerCandidates = optimizedResult.candidates.filter(
    (candidate) =>
      survivingSymbolPairs.some(
        (pair) => pair.left === candidate.left.address,
      ) &&
      survivingSymbolPairs.some(
        (pair) => pair.right === candidate.right.address,
      ),
  );
  const correctOptimizerCandidates = optimizerCandidates.filter((candidate) =>
    survivingSymbolPairs.some(
      (pair) =>
        pair.left === candidate.left.address &&
        pair.right === candidate.right.address,
    ),
  );
  const optimizerAutomatic = optimizedResult.comparisons.filter(
    (comparison) =>
      comparison.selection !== "analyst-selected" &&
      survivingSymbolPairs.some(
        (pair) => pair.left === comparison.left.address,
      ) &&
      survivingSymbolPairs.some(
        (pair) => pair.right === comparison.right.address,
      ),
  );
  const correctOptimizerAutomatic = optimizerAutomatic.filter((comparison) =>
    survivingSymbolPairs.some(
      (pair) =>
        pair.left === comparison.left.address &&
        pair.right === comparison.right.address,
    ),
  );
  assert.equal(
    correctOptimizerAutomatic.length,
    optimizerAutomatic.length,
    "Incorrect automatic pair among the optimization fixture's surviving source symbols",
  );
  return {
    compiler_symbols: {
      O0_has_static_helper: true,
      O2_has_static_helper: false,
    },
    provider_function_counts: [
      optimizedResult.left.functions.length,
      optimizedResult.right.functions.length,
    ],
    candidate_count: optimizedResult.candidates.length,
    automatic_pair_count: optimizedResult.comparisons.filter(
      (pair) => pair.selection !== "analyst-selected",
    ).length,
    unmatched_observations: {
      left: optimizedResult.removed_candidates.length,
      right: optimizedResult.added_candidates.length,
    },
    surviving_symbol_quality: {
      oracle:
        "main and inline_wrapper survive in both compiler symbol tables. The inlined static helper has no one-to-one oracle and is excluded; these labels do not prove semantic equivalence.",
      known_pairs: survivingSymbolPairs.length,
      candidate_pairs: optimizerCandidates.length,
      correct_candidate_pairs: correctOptimizerCandidates.length,
      candidate_precision:
        optimizerCandidates.length === 0
          ? null
          : correctOptimizerCandidates.length / optimizerCandidates.length,
      candidate_recall:
        correctOptimizerCandidates.length / survivingSymbolPairs.length,
      automatic_pairs: optimizerAutomatic.length,
      correct_automatic_pairs: correctOptimizerAutomatic.length,
      automatic_precision:
        optimizerAutomatic.length === 0
          ? null
          : correctOptimizerAutomatic.length / optimizerAutomatic.length,
    },
    interpretation:
      "The compiler no longer emits a separate helper symbol at O2. Provider inventory and matching observations do not prove semantic equivalence, true function absence, or source-level correspondence; optimizer quality is not included in labeled corpus metrics.",
  };
}

function verifyLabeledMatches(
  result,
  corpus,
  {
    pairs,
    leftLabels,
    rightLabels,
    automatic,
    automaticCorrect,
    labeledAutomatic,
  },
) {
  assert.equal(
    automaticCorrect.length,
    labeledAutomatic.length,
    "Incorrect automatic pair in labeled corpus",
  );
  for (const pair of automatic)
    assert.ok(
      leftLabels.get(pair.left.address) !== "duplicate_family" &&
        rightLabels.get(pair.right.address) !== "duplicate_family",
      "Duplicate helper was automatically disambiguated",
    );
  for (const name of ["duplicate_a", "duplicate_b"]) {
    const alternatives = result.candidates.filter(
      (candidate) =>
        candidate.left.address === requireSymbol(corpus.before.symbols, name) &&
        rightLabels.get(candidate.right.address) === "duplicate_family",
    );
    assert.equal(
      alternatives.length,
      2,
      "Duplicate family alternatives were lost",
    );
    assert.ok(
      alternatives.every((candidate) => candidate.selection === "disputed"),
      "Duplicate family does not remain disputed",
    );
  }
  for (const [l, r] of [pairs[0], pairs[2]])
    assert.ok(
      automatic.some(
        (pair) =>
          pair.left.address === requireSymbol(corpus.before.symbols, l) &&
          pair.right.address === requireSymbol(corpus.after.symbols, r),
      ),
      `Missing unique exact renamed/moved pair: ${l}`,
    );
}
