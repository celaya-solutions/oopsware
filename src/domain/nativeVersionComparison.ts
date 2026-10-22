import type { Evidence } from "./evidence.js";
import {
  parseFunctionEvidence,
  type FunctionSnapshot,
} from "./functionDossierEvidence.js";
import { normalizeCfg } from "./functionComparisonNormalization.js";
import { compareFunctions } from "./functionComparison.js";
import { canonicalJson } from "./comparisonSemantics.js";
import { digestCanonicalValue } from "./canonicalDigest.js";
import { compareUnicodeCodePoints } from "./unicodeCodePointOrder.js";
import {
  AnalysisResourceConstraintError,
  AnalysisCancelledError,
  AnalysisInputError,
} from "./analysisErrorCore.js";
import type {
  NativeCandidateDiscovery,
  NativeVersionComparisonInput,
} from "./nativeVersionComparisonSchemas.js";

type Candidate = NativeCandidateDiscovery["candidates"][number];
type Facet = Candidate["signals"][number]["facet"];
type Features = {
  snapshot: FunctionSnapshot;
  facets: Map<Facet, string[]>;
  unavailable: string[];
};
const reference = ({ snapshot }: Features) => ({
  address: snapshot.dossier.procedure.address,
  name: snapshot.dossier.procedure.name,
  evidence_id: snapshot.evidence.evidence_id,
});
const canonicalAddress = (address: string) =>
  `0x${BigInt(address).toString(16)}`;
const encode = (value: unknown) =>
  canonicalJson(value, "Native candidate discovery");
const unique = (values: string[]) =>
  [...new Set(values)].sort(compareUnicodeCodePoints);
const pairInputError = (message: string) =>
  new AnalysisInputError("compare_native_versions", undefined, [
    { path: ["selected_pairs"], reason: "invalid_value", message },
  ]);

const features = (evidence: Evidence): Features => {
  const snapshot = parseFunctionEvidence(evidence);
  const { dossier } = snapshot;
  const facets = new Map<Facet, string[]>();
  const unavailable: string[] = [];
  facets.set("artifact_address", [
    `${snapshot.subject.digest.sha256}:${canonicalAddress(dossier.procedure.address)}`,
  ]);
  const cfg = normalizeCfg(dossier.basic_blocks);
  if (cfg !== null && cfg.length > 0) facets.set("cfg", [encode(cfg)]);
  else unavailable.push("cfg: no complete address-normalizable block graph");
  // Normalize only instruction source addresses. Operands, immediates and symbol
  // spelling are retained verbatim; guessing which hex tokens are addresses loses facts.
  const assembly = dossier.assembly.map((line) =>
    /^(0x[0-9a-f]+):\s*(.+)$/iu.exec(line),
  );
  if (
    assembly.length > 0 &&
    assembly.every(
      (line) =>
        line?.[1] !== undefined &&
        line[2] !== undefined &&
        BigInt(line[1]) >= BigInt(dossier.procedure.address),
    )
  ) {
    facets.set("assembly", [
      encode({
        provider: snapshot.evidence.provider,
        instructions: assembly.map((line) => ({
          offset:
            line?.[1] === undefined
              ? null
              : String(BigInt(line[1]) - BigInt(dossier.procedure.address)),
          text: line?.[2],
        })),
      }),
    ]);
  } else
    unavailable.push(
      "assembly: source-address-prefixed complete instruction representation unavailable",
    );
  const imports = dossier.outgoing_references
    .filter(
      (edge) =>
        edge.kind.available &&
        edge.kind.external &&
        edge.target_procedure !== null,
    )
    .map((edge) => edge.target_procedure?.name ?? "");
  if (imports.length > 0) facets.set("imports", unique(imports));
  else
    unavailable.push(
      "imports: no classified external targets observed; absence is not proof of no imports",
    );
  if (dossier.referenced_strings.length > 0)
    facets.set(
      "strings",
      unique(dossier.referenced_strings.map(({ value }) => value)),
    );
  else unavailable.push("strings: no referenced string observations");
  const flow = dossier.native_value_flow;
  if (
    flow?.available &&
    !flow.truncated &&
    flow.known_omitted_inputs === 0 &&
    flow.known_omitted_edges === 0
  ) {
    const constants = flow.operations.flatMap((operation) =>
      operation.inputs
        .filter(
          (input) => input.kind === "constant" && input.constant_hex !== null,
        )
        .map((input) => `${input.size_bytes}:${input.constant_hex}`),
    );
    if (constants.length > 0) facets.set("constants", unique(constants));
    else unavailable.push("constants: no IR constant operands observed");
    if (flow.operations.length > 0)
      facets.set("intermediate_representation", [
        encode({
          provider: snapshot.evidence.provider,
          provenance: flow.provenance,
          operations: flow.operations.map((operation) => ({
            opcode: operation.opcode,
            inputs: operation.inputs.map((input) => ({
              kind: input.kind,
              size_bytes: input.size_bytes,
              constant_hex: input.constant_hex,
            })),
            output:
              operation.output === null
                ? null
                : {
                    kind: operation.output.kind,
                    size_bytes: operation.output.size_bytes,
                  },
          })),
        }),
      ]);
    else
      unavailable.push("intermediate_representation: no operations observed");
  } else
    unavailable.push(
      "constants: complete provider IR unavailable",
      "intermediate_representation: complete provider IR unavailable",
    );
  return { snapshot, facets, unavailable };
};

const pairCandidate = (
  left: Features,
  right: Features,
  selected: boolean,
): Candidate => {
  const signals: Candidate["signals"] = [];
  for (const [facet, values] of left.facets) {
    const other = right.facets.get(facet);
    if (other === undefined) continue;
    const overlap = values.filter((value) => other.includes(value));
    if (overlap.length === 0) continue;
    signals.push({
      facet,
      method:
        facet === "cfg"
          ? "exact address-normalized block graph; SHA-256 fingerprints, source dossier inline"
          : "shared observed feature values; SHA-256 facet fingerprints, source dossier inline",
      left: [digestCanonicalValue(values)],
      right: [digestCanonicalValue(other)],
      similarity: overlap.length / new Set([...values, ...other]).size,
    });
  }
  const identity = signals.some(({ facet }) => facet === "artifact_address");
  return {
    left: reference(left),
    right: reference(right),
    score: identity
      ? 1
      : signals.reduce((sum, signal) => sum + signal.similarity, 0) / 6,
    method: selected
      ? "analyst-selected"
      : identity
        ? "artifact-address-identity"
        : "structural-candidate",
    selection: selected
      ? "analyst-selected"
      : identity
        ? "exact-identity"
        : "disputed",
    signals,
    unavailable_facets: [
      ...left.unavailable.map((item) => `Left: ${item}`),
      ...right.unavailable.map((item) => `Right: ${item}`),
    ],
  };
};

/** Discover candidates; representation uniqueness requires complete caller-confirmed inventories, never semantic equivalence. */
export const discoverNativeFunctionCandidates = (
  leftEvidence: readonly Evidence[],
  rightEvidence: readonly Evidence[],
  selectedPairs: NativeVersionComparisonInput["selected_pairs"],
  signal?: AbortSignal,
  inventoryComplete = false,
): NativeCandidateDiscovery => {
  const left = leftEvidence.map(features),
    right = rightEvidence.map(features);
  const byAddress = (values: Features[]) => {
    const map = new Map(
      values.map((value) => [
        canonicalAddress(value.snapshot.dossier.procedure.address),
        value,
      ]),
    );
    if (map.size !== values.length)
      throw new TypeError("Duplicate function addresses in version inventory");
    return map;
  };
  const leftMap = byAddress(left),
    rightMap = byAddress(right);
  const selected = new Set<string>();
  const selectedLeft = new Set<string>(),
    selectedRight = new Set<string>();
  for (const pair of selectedPairs) {
    const l = canonicalAddress(pair.left_address),
      r = canonicalAddress(pair.right_address);
    if (!leftMap.has(l) || !rightMap.has(r))
      throw pairInputError(
        `Selected pair is absent from collected function dossiers: ${l}, ${r}`,
      );
    if (selectedLeft.has(l) || selectedRight.has(r))
      throw pairInputError(
        "Selected pairs must be one-to-one; repeated function address",
      );
    selectedLeft.add(l);
    selectedRight.add(r);
    selected.add(`${l}:${r}`);
  }
  const index = new Map<string, Features[]>();
  const leftIndex = new Map<string, Features[]>();
  const addIndex = (values: Features[], target: Map<string, Features[]>) => {
    for (const value of values)
      for (const [facet, tokens] of value.facets)
        for (const token of tokens) {
          const key = encode([facet, token]);
          const members = target.get(key) ?? [];
          members.push(value);
          target.set(key, members);
        }
  };
  addIndex(right, index);
  addIndex(left, leftIndex);
  const candidates: Candidate[] = [];
  for (const l of left) {
    if (signal?.aborted)
      throw new AnalysisCancelledError("compare_native_versions");
    const possible = new Set<Features>();
    for (const [facet, tokens] of l.facets)
      for (const token of tokens)
        for (const r of index.get(encode([facet, token])) ?? [])
          possible.add(r);
    const lAddress = canonicalAddress(l.snapshot.dossier.procedure.address);
    for (const pair of selectedPairs)
      if (canonicalAddress(pair.left_address) === lAddress) {
        const r = rightMap.get(canonicalAddress(pair.right_address));
        if (r !== undefined) possible.add(r);
      }
    if (candidates.length + possible.size > 100_000)
      throw new AnalysisResourceConstraintError(
        "compare_native_versions",
        "memory",
        "Candidate evidence expansion exceeds 100000 pairs; compare smaller binaries or explicit functions with compare_functions",
        { candidate_pairs: 100_000 },
      );
    for (const r of possible) {
      const candidate = pairCandidate(
        l,
        r,
        selected.has(
          `${lAddress}:${canonicalAddress(r.snapshot.dossier.procedure.address)}`,
        ),
      );
      if (!inventoryComplete)
        candidate.unavailable_facets.push(
          "Representation uniqueness is unknown because function collection is incomplete; unobserved functions may hide duplicate alternatives.",
        );
      // An explicit analyst pairing takes precedence over a competing automatic identity match.
      if (
        candidate.selection === "exact-identity" &&
        (selectedLeft.has(lAddress) ||
          selectedRight.has(
            canonicalAddress(r.snapshot.dossier.procedure.address),
          ))
      )
        candidate.selection = "disputed";
      candidates.push(candidate);
    }
  }
  candidates.sort(
    (a, b) =>
      b.score - a.score ||
      compareUnicodeCodePoints(a.left.address, b.left.address) ||
      compareUnicodeCodePoints(a.right.address, b.right.address),
  );
  const exactRepresentation = (candidate: Candidate) =>
    candidate.signals.some(
      (item) => item.facet === "assembly" && item.similarity === 1,
    ) &&
    candidate.signals.some(
      (item) => item.facet === "cfg" && item.similarity === 1,
    );
  const exact = inventoryComplete ? candidates.filter(exactRepresentation) : [];
  const group = (items: Candidate[], side: "left" | "right") => {
    const map = new Map<string, Candidate[]>();
    for (const item of items) {
      const members = map.get(item[side].evidence_id) ?? [];
      members.push(item);
      map.set(item[side].evidence_id, members);
    }
    return map;
  };
  const exactLeft = group(exact, "left"),
    exactRight = group(exact, "right");
  for (const candidate of exact) {
    if (
      candidate.selection !== "disputed" ||
      selectedLeft.has(canonicalAddress(candidate.left.address)) ||
      selectedRight.has(canonicalAddress(candidate.right.address))
    )
      continue;
    if (
      exactLeft.get(candidate.left.evidence_id)?.length === 1 &&
      exactRight.get(candidate.right.evidence_id)?.length === 1
    ) {
      candidate.selection = "unique-exact-representation";
      candidate.method = "unique-exact-representation";
    }
  }
  const ambiguous: NativeCandidateDiscovery["ambiguous"] = [];
  const byLeft = group(candidates, "left"),
    byRight = group(candidates, "right");
  for (const [side, values] of [
    ["left", left],
    ["right", right],
  ] as const)
    for (const value of values) {
      const matches =
        (side === "left" ? byLeft : byRight).get(
          value.snapshot.evidence.evidence_id,
        ) ?? [];
      if (matches.length > 1)
        ambiguous.push({
          side,
          function: reference(value),
          alternatives: matches.map(
            (candidate) => candidate[side === "left" ? "right" : "left"],
          ),
        });
    }
  const collisions: NativeCandidateDiscovery["collisions"] = [];
  for (const key of new Set([...leftIndex.keys(), ...index.keys()])) {
    const leftMembers = leftIndex.get(key) ?? [];
    const rightMembers = index.get(key) ?? [];
    if (leftMembers.length > 1 || rightMembers.length > 1)
      collisions.push({
        facet:
          [
            ...((leftMembers[0] ?? rightMembers[0])?.facets.entries() ?? []),
          ].find(([facet, tokens]) =>
            tokens.some((token) => encode([facet, token]) === key),
          )?.[0] ?? "unknown",
        fingerprint: digestCanonicalValue(key),
        left: leftMembers.map(reference),
        right: rightMembers.map(reference),
      });
  }
  const comparisons: NativeCandidateDiscovery["comparisons"] = [];
  for (const candidate of candidates)
    if (candidate.selection !== "disputed") {
      const l = leftMap.get(canonicalAddress(candidate.left.address)),
        r = rightMap.get(canonicalAddress(candidate.right.address));
      if (l !== undefined && r !== undefined)
        comparisons.push({
          left: candidate.left,
          right: candidate.right,
          selection: candidate.selection,
          comparison: compareFunctions(
            l.snapshot.evidence,
            r.snapshot.evidence,
          ),
        });
    }
  return {
    candidates,
    changed_candidates: comparisons
      .filter(({ comparison }) =>
        comparison.dimensions.some(
          (dimension) => dimension.status === "changed",
        ),
      )
      .map(({ left: l, right: r }) => ({
        left_address: l.address,
        right_address: r.address,
      })),
    ambiguous,
    collisions,
    comparisons,
    removed_candidates: left
      .filter((value) => !byLeft.has(value.snapshot.evidence.evidence_id))
      .map(reference),
    added_candidates: right
      .filter((value) => !byRight.has(value.snapshot.evidence.evidence_id))
      .map(reference),
  };
};
