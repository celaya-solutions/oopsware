import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { matchNativeFunctions } from "./NativeFunctionMatchingService.js";
import { nativeFunctionMatchingSchema } from "../../domain/native/functionMatching.js";
import { createEvidence } from "../../domain/evidence.js";
import { createAnalysisProfile } from "../../domain/analysisProfile.js";
import { functionDossierSchema } from "../../domain/hopperValues.js";
import {
  nativeMatchingInventory,
  nativeMatchingDetails,
  nativeMatchingTarget,
  nativeMatchingProvider,
} from "../../../tests/fixtures/nativeFunctionMatching.js";

const compare = async (input: unknown) => {
  const result = await matchNativeFunctions(input);
  if (!result.ok) throw result.error;
  return {
    ...result.value,
    report: nativeFunctionMatchingSchema.parse(
      result.value.evidence.normalized_result,
    ),
  };
};

it("retains transitive provenance without treating dependencies as native observations and fails closed for a missing ancestor", async () => {
  const ancestor = createEvidence(undefined, nativeMatchingProvider, {
    operation: "fixture_provenance",
    parameters: {},
    result: { provenance: "Synthetic ancestor" },
  });
  const dependency = createEvidence(undefined, nativeMatchingProvider, {
    operation: "fixture_dependency",
    parameters: {},
    result: { provenance: "Synthetic dependency" },
    evidenceLinks: [ancestor.evidence_id],
  });
  const left = nativeMatchingInventory(
    "1",
    [{ address: "0x10", value: "main" }],
    [dependency.evidence_id],
  );
  const right = nativeMatchingInventory(
    "2",
    [{ address: "0x20", value: "main" }],
    [dependency.evidence_id],
  );
  const dependencies = new Map(
    [ancestor, dependency].map((record) => [record.evidence_id, record]),
  );
  const result = await matchNativeFunctions({ left, right }, undefined, (id) =>
    dependencies.get(id),
  );
  if (!result.ok) throw result.error;
  expect(
    new Set(result.value.sources.map((record) => record.evidence_id)),
  ).toEqual(
    new Set(
      [left, right, dependency, ancestor].map((record) => record.evidence_id),
    ),
  );
  expect(new Set(result.value.evidence.evidence_links)).toEqual(
    new Set([left.evidence_id, right.evidence_id]),
  );
  expect(
    nativeFunctionMatchingSchema.parse(result.value.evidence.normalized_result)
      .summary.matched,
  ).toBe(1);
  const missing = await matchNativeFunctions(
    { left, right },
    undefined,
    (id) => (id === dependency.evidence_id ? dependency : undefined),
  );
  expect(missing.ok).toBe(false);
  if (missing.ok) throw new Error("Missing ancestor accepted");
  expect(missing.error).toMatchObject({
    evidenceId: ancestor.evidence_id,
    reason: "missing",
  });
});

it("keeps symbol origin unknown when supplied metadata describes a different same-address alias", async () => {
  const left = nativeMatchingInventory("1", [
    { address: "0x10", value: "reported_name" },
  ]);
  const right = nativeMatchingInventory("2", [
    { address: "0x20", value: "reported_name" },
  ]);
  const alias = createEvidence(
    nativeMatchingTarget("1"),
    nativeMatchingProvider,
    {
      operation: "list_names",
      parameters: {},
      result: [
        {
          address: "0x10",
          value: "other_alias",
          symbol: {
            primary: false,
            dynamic: false,
            external: false,
            type: "function",
            source: "user_defined",
          },
        },
      ],
    },
  );
  const { report } = await compare({ left, right, left_observations: [alias] });
  expect(report.summary.matched).toBe(1);
  expect(report.matches[0]?.left[0]?.limitations).toContain(
    "Symbol origin unavailable; exact-name matching uses the reported name and the existing automatic-name exclusion rule.",
  );
  expect(report.matches[0]?.left[0]?.evidence_links).toContain(
    alias.evidence_id,
  );
});

it("preserves contradictory symbol origins from inventory/name facts or multiple name observations, independently of byte correspondence", async () => {
  const observe = (operation: string, generated: boolean) =>
    createEvidence(nativeMatchingTarget("1"), nativeMatchingProvider, {
      operation,
      parameters: {},
      result: [
        {
          address: "0x10",
          value: "same_name",
          symbol: {
            primary: true,
            dynamic: generated,
            external: false,
            type: "function",
            source: generated ? "default" : "user_defined",
          },
        },
      ],
    });
  const right = nativeMatchingInventory("2", [
    { address: "0x20", value: "same_name" },
  ]);
  for (const [left, names] of [
    [observe("list_procedures", false), [observe("list_names", true)]],
    [observe("list_procedures", true), [observe("list_names", false)]],
    [
      nativeMatchingInventory("1", [{ address: "0x10", value: "same_name" }]),
      [observe("list_names", false), observe("list_names", true)],
    ],
    [
      nativeMatchingInventory("1", [{ address: "0x10", value: "same_name" }]),
      [observe("list_names", true), observe("list_names", false)],
    ],
  ] as const) {
    for (const withBytes of [false, true]) {
      const { report } = await compare({
        left,
        right,
        left_observations: [
          ...names,
          ...(withBytes ? nativeMatchingDetails("1", "0x10", "c3") : []),
        ],
        right_observations: withBytes
          ? nativeMatchingDetails("2", "0x20", "c3")
          : [],
      });
      expect(report.summary.matched).toBe(withBytes ? 1 : 0);
      expect(report.matches[0]!.basis).toBe(
        withBytes ? "identical-bytes" : null,
      );
      const member = report.matches[0]!.left[0]!;
      expect(member.limitations).toContain(
        "Conflicting generated and named symbol-origin observations; exact-name matching is unavailable. Independent complete body bytes remain eligible.",
      );
      expect(member.limitations.join(" ")).not.toContain(
        "Symbol origin unavailable",
      );
      for (const source of names)
        expect(member.evidence_links).toContain(source.evidence_id);
    }
  }
});

it("keeps informative CFG/call/string fingerprints as unresolved candidates and refuses incomplete structural observations", async () => {
  const profile = createAnalysisProfile(nativeMatchingProvider, {
    fixture: "structural-candidates-v1",
  });
  const observe = (
    side: "1" | "2",
    operation: string,
    result: Parameters<typeof createEvidence>[2]["result"],
    complete = true,
  ) =>
    createEvidence(nativeMatchingTarget(side), nativeMatchingProvider, {
      operation,
      parameters: {},
      result,
      analysisProfile: profile,
      relationshipCoverage: complete
        ? { status: "complete" }
        : { status: "unknown", reason: "Missing direct call coverage" },
    });
  const left = observe("1", "list_procedures", [
    { address: "0x10", value: "old_behavior" },
  ]);
  const right = observe("2", "list_procedures", [
    { address: "0x20", value: "new_behavior" },
  ]);
  const dossier = (side: "1" | "2", address: string) => {
    const value = functionDossierSchema.parse(
      nativeMatchingDetails(side, address, "0102", true)[0]!.normalized_result,
    );
    value.basic_blocks = [
      {
        start: address,
        end: `0x${(BigInt(address) + 2n).toString(16)}`,
        successors: [],
      },
    ];
    value.callees = [
      {
        address: "0x500",
        name: "puts",
        classification: null,
        body: { available: false, reason: "Synthetic external target" },
      },
    ];
    value.unresolved_calls = [];
    value.referenced_strings = [
      { address: "0x900", value: "marker", source_address: address },
    ];
    return value;
  };
  const l = dossier("1", "0x10"),
    r = dossier("2", "0x20");
  const { report } = await compare({
    left,
    right,
    left_observations: [observe("1", "analyze_function", l)],
    right_observations: [observe("2", "analyze_function", r)],
  });
  expect(report.summary).toEqual({
    matched: 0,
    only_left: 0,
    only_right: 0,
    unresolved: 1,
  });
  expect(report.matches[0]?.left[0]?.structural_candidate_sha256).toMatch(
    /^[a-f0-9]{64}$/u,
  );
  expect(report.matches[0]?.left[0]?.structural_candidate_sha256).toBe(
    report.matches[0]?.right[0]?.structural_candidate_sha256,
  );
  expect(report.matches[0]?.compare_functions_input).toBeNull();
  const incomplete = await compare({
    left,
    right,
    left_observations: [observe("1", "analyze_function", l, false)],
    right_observations: [observe("2", "analyze_function", r)],
  });
  expect(incomplete.report.summary.unresolved).toBe(0);
  expect(incomplete.report.source_coverage.left_structural_candidates).toBe(0);
  const legacy = { ...l };
  delete legacy.facet_availability;
  const missingFacets = await compare({
    left,
    right,
    left_observations: [observe("1", "analyze_function", legacy)],
    right_observations: [observe("2", "analyze_function", r)],
  });
  expect(missingFacets.report.source_coverage.left_structural_candidates).toBe(
    0,
  );
  expect(missingFacets.report.summary.unresolved).toBe(0);
  l.callees = [];
  l.referenced_strings = [];
  r.callees = [];
  r.referenced_strings = [];
  const uninformative = await compare({
    left,
    right,
    left_observations: [observe("1", "analyze_function", l)],
    right_observations: [observe("2", "analyze_function", r)],
  });
  expect(uninformative.report.source_coverage.left_structural_candidates).toBe(
    0,
  );
  expect(uninformative.report.summary.unresolved).toBe(0);
});

it("matches symbols before bytes, retains exact renamed bytes, changed pairs, unpaired observations and duplicate candidates", async () => {
  const left = nativeMatchingInventory("1", [
    { address: "0x1000", value: "stable" },
    { address: "0x1010", value: "changed" },
    { address: "0x1020", value: "old_name" },
    { address: "0x1030", value: "removed_observation" },
    { address: "0x1040", value: "duplicate" },
    { address: "0x1050", value: "duplicate" },
  ]);
  const right = nativeMatchingInventory("2", [
    { address: "0x2000", value: "stable" },
    { address: "0x2010", value: "changed" },
    { address: "0x2020", value: "renamed" },
    { address: "0x2030", value: "added_observation" },
    { address: "0x2040", value: "duplicate" },
  ]);
  const result = await compare({
    left,
    right,
    left_observations: [
      ...nativeMatchingDetails("1", "0x1010", "0102"),
      ...nativeMatchingDetails("1", "0x1020", "030405", true),
    ],
    right_observations: [
      ...nativeMatchingDetails("2", "0x2010", "aabb"),
      ...nativeMatchingDetails("2", "0x2020", "030405", true),
    ],
  });
  expect(result.report.summary).toEqual({
    matched: 3,
    only_left: 1,
    only_right: 1,
    unresolved: 1,
  });
  const renamed = result.report.matches.find(
    (row) => row.basis === "identical-bytes",
  )!;
  expect(renamed.left[0]).toMatchObject({
    name: "old_name",
    body_bytes: 3,
    body_sha256: createHash("sha256")
      .update(Buffer.from("030405", "hex"))
      .digest("hex"),
  });
  expect(renamed.right[0]?.name).toBe("renamed");
  expect(renamed.compare_functions_input?.left.evidence_id).toBe(
    renamed.left[0]?.dossier_evidence_id,
  );
  expect(
    result.report.matches.find((row) => row.left[0]?.name === "changed"),
  ).toMatchObject({ state: "matched", basis: "exact-symbol" });
  expect(
    result.report.matches.find((row) => row.state === "unresolved"),
  ).toMatchObject({
    left: [expect.anything(), expect.anything()],
    right: [expect.anything()],
  });
  expect(new Set(result.evidence.evidence_links)).toEqual(
    new Set(result.sources.map((x) => x.evidence_id)),
  );
  expect(result.report.limitations.join(" ")).toContain("never prove absence");
});

it("does not force repeated identical-byte candidates after an exact name consumes an alias", async () => {
  const left = nativeMatchingInventory("1", [
    { address: "0x10", value: "known" },
    { address: "0x20", value: "FUN_20" },
  ]);
  const right = nativeMatchingInventory("2", [
    { address: "0x30", value: "known" },
    { address: "0x40", value: "FUN_40" },
  ]);
  const { report } = await compare({
    left,
    right,
    left_observations: [
      ...nativeMatchingDetails("1", "0x10", "c3"),
      ...nativeMatchingDetails("1", "0x20", "c3"),
    ],
    right_observations: [
      ...nativeMatchingDetails("2", "0x30", "c3"),
      ...nativeMatchingDetails("2", "0x40", "c3"),
    ],
  });
  expect(report.summary).toEqual({
    matched: 1,
    unresolved: 1,
    only_left: 0,
    only_right: 0,
  });
  expect(
    report.matches.find((x) => x.state === "unresolved")?.left[0]?.name,
  ).toBe("FUN_20");
});

it("reconstructs discontiguous bodies from adjacent byte reads without next-procedure guesses and keeps address-space/64-bit identity", async () => {
  const address = "ram:0xfffffffffffffff0";
  const left = nativeMatchingInventory("1", [{ address, value: "FUN_f0" }]);
  const right = nativeMatchingInventory("2", [
    { address: "0x20", value: "FUN_20" },
  ]);
  const body = {
    available: true,
    provenance: "synthetic noncontiguous body",
    ranges: [
      { start: address, end: "ram:0xfffffffffffffff1" },
      { start: "ram:0xfffffffffffffff8", end: "ram:0xfffffffffffffff8" },
    ],
    total_bytes: 3,
    span_bytes: 9,
    non_contiguous: true,
    contains_entry: true,
  };
  const info = createEvidence(
    nativeMatchingTarget("1"),
    nativeMatchingProvider,
    {
      operation: "procedure_info",
      parameters: {},
      result: {
        name: "a",
        entrypoint: address,
        basicblock_count: 1,
        length: 3,
        signature: null,
        locals: [],
        classification: null,
        body,
      },
    },
  );
  const read = (address: string, hex: string) =>
    createEvidence(nativeMatchingTarget("1"), nativeMatchingProvider, {
      operation: "read_bytes",
      parameters: {},
      result: {
        address,
        requested_bytes: hex.length / 2,
        returned_bytes: hex.length / 2,
        bytes_hex: hex,
        complete: true,
      },
    });
  const rightDetails = nativeMatchingDetails("2", "0x20", "010203");
  const { report } = await compare({
    left,
    right,
    left_observations: [
      info,
      read(address, "01"),
      read("ram:0xfffffffffffffff1", "02"),
      read("ram:0xfffffffffffffff8", "03"),
    ],
    right_observations: rightDetails,
  });
  // Same concatenated bytes with a different body layout do not become a pair.
  expect(report.summary.matched).toBe(0);
  expect(report.matches[0]?.left[0]).toMatchObject({
    address,
    body_bytes: 3,
    body_sha256: createHash("sha256")
      .update(Buffer.from("010203", "hex"))
      .digest("hex"),
  });
});

it("preserves byte correspondence when consistent dossiers differ only in request identity, without choosing an arbitrary dossier", async () => {
  const left = nativeMatchingInventory("1", [
    { address: "0x10", value: "old_name" },
  ]);
  const right = nativeMatchingInventory("2", [
    { address: "0x20", value: "new_name" },
  ]);
  const leftDetails = nativeMatchingDetails("1", "0x10", "0102", true);
  const another = createEvidence(
    nativeMatchingTarget("1"),
    nativeMatchingProvider,
    {
      operation: "analyze_function",
      parameters: { procedure: "old_name" },
      result: leftDetails[0]!.normalized_result,
      relationshipCoverage: { status: "complete" },
    },
  );
  for (const observations of [
    [...leftDetails, another],
    [another, ...leftDetails],
  ]) {
    const { report } = await compare({
      left,
      right,
      left_observations: observations,
      right_observations: nativeMatchingDetails("2", "0x20", "0102", true),
    });
    expect(report.summary.matched).toBe(1);
    expect(report.matches[0]).toMatchObject({
      basis: "identical-bytes",
      compare_functions_input: null,
      left: [
        {
          dossier_evidence_id: null,
          body_bytes: 2,
          body_sha256: createHash("sha256")
            .update(Buffer.from("0102", "hex"))
            .digest("hex"),
        },
      ],
    });
    expect(report.matches[0]!.left[0]!.evidence_links).toContain(
      another.evidence_id,
    );
  }
  const conflicting = nativeMatchingDetails("1", "0x10", "010203", true)[0]!;
  const { report } = await compare({
    left,
    right,
    left_observations: [...leftDetails, conflicting],
    right_observations: nativeMatchingDetails("2", "0x20", "0102", true),
  });
  expect(report.summary.matched).toBe(0);
  expect(report.matches[0]!.left[0]!.body_sha256).toBeNull();
});

it("rejects repeated per-occurrence source-link expansion within the shared representation budget", async () => {
  const base = nativeMatchingDetails("1", "0x10", "c3")[0]!;
  const observations = Array.from({ length: 250 }, (_, observation) =>
    createEvidence(nativeMatchingTarget("1"), nativeMatchingProvider, {
      operation: "procedure_info",
      parameters: { procedure: "0x10", observation },
      result: base.normalized_result,
    }),
  );
  const result = await matchNativeFunctions({
    left: nativeMatchingInventory(
      "1",
      Array.from({ length: 1000 }, (_, i) => ({
        address: "0x10",
        value: `alias_${i}`,
      })),
    ),
    right: nativeMatchingInventory("2", []),
    left_observations: observations,
  });
  expect(result.ok).toBe(false);
  if (!result.ok)
    expect(result.error._tag).toBe("AnalysisResourceConstraintError");
});

it("retains missing bytes and conflicting overlapping observations as unknown instead of exact matches", async () => {
  const left = nativeMatchingInventory("1", [
    { address: "0x10", value: "FUN_10" },
  ]);
  const right = nativeMatchingInventory("2", [
    { address: "0x20", value: "FUN_20" },
  ]);
  const observations = [
    ...nativeMatchingDetails("1", "0x10", "0102"),
    nativeMatchingDetails("1", "0x10", "ffff")[1]!,
  ];
  const { report } = await compare({
    left,
    right,
    left_observations: observations,
    right_observations: nativeMatchingDetails("2", "0x20", "0102"),
  });
  expect(report.summary.matched).toBe(0);
  expect(report.matches[0]?.left[0]?.body_sha256).toBeNull();
});

it("composes consistent overlapping and partial byte reads without losing complete body coverage", async () => {
  const left = nativeMatchingInventory("1", [
    { address: "0x10", value: "FUN_10" },
  ]);
  const right = nativeMatchingInventory("2", [
    { address: "0x20", value: "FUN_20" },
  ]);
  const info = nativeMatchingDetails("1", "0x10", "01020304")[0]!;
  const read = (address: string, hex: string, requested = hex.length / 2) =>
    createEvidence(nativeMatchingTarget("1"), nativeMatchingProvider, {
      operation: "read_bytes",
      parameters: { address, length: requested },
      result: {
        address,
        requested_bytes: requested,
        returned_bytes: hex.length / 2,
        bytes_hex: hex,
        complete: requested === hex.length / 2,
      },
    });
  const { report } = await compare({
    left,
    right,
    left_observations: [
      info,
      read("0x10", "010203", 6),
      read("0x11", "020304"),
    ],
    right_observations: nativeMatchingDetails("2", "0x20", "01020304"),
  });
  expect(report.summary.matched).toBe(1);
  expect(report.source_coverage).toMatchObject({
    status: "complete-within-inputs",
    left_byte_fingerprints: 1,
    right_byte_fingerprints: 1,
    left_inventory_completeness: "unknown",
  });
});

it("does not use generated symbols and preserves literal named FUN_ symbols when producer metadata proves their origin", async () => {
  const entries = [
    { address: "0x10", value: "FUN_10" },
    { address: "0x20", value: "apparently_named" },
  ];
  const names = (side: "1" | "2") =>
    createEvidence(nativeMatchingTarget(side), nativeMatchingProvider, {
      operation: "list_names",
      parameters: {},
      result: entries.map((entry, i) => ({
        ...entry,
        symbol: {
          primary: true,
          dynamic: i === 1,
          external: false,
          type: "function",
          source: i === 0 ? "user_defined" : "default",
        },
      })),
    });
  const { report } = await compare({
    left: nativeMatchingInventory("1", entries),
    right: nativeMatchingInventory("2", entries),
    left_observations: [names("1")],
    right_observations: [names("2")],
  });
  expect(report.summary.matched).toBe(1);
  expect(report.matches[0]?.left[0]?.name).toBe("FUN_10");
  expect(report.matches[0]?.left[0]?.evidence_links).toContain(
    names("1").evidence_id,
  );
});

it("rejects tampered, non-inventory and mixed-target observations with typed failures", async () => {
  const left = nativeMatchingInventory("1", [
    { address: "0x10", value: "main" },
  ]);
  for (const input of [
    { left: { ...left, normalized_result: [] }, right: left },
    { left: nativeMatchingDetails("1", "0x10", "c3")[0], right: left },
    {
      left,
      right: left,
      left_observations: nativeMatchingDetails("2", "0x10", "c3"),
    },
    {
      left,
      right: left,
      left_observations: [
        { kind: "retained-evidence", evidence_id: `ev_${"a".repeat(64)}` },
      ],
    },
  ]) {
    const result = await matchNativeFunctions(input);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect([
        "AnalysisInputError",
        "EvidenceIntegrityError",
        "EvidenceReferenceError",
      ]).toContain(result.error._tag);
  }
});

it("cooperatively preserves the exact cancellation reason and rejects expansion before cloning oversized input", async () => {
  const controller = new AbortController(),
    reason = new Error("stop matching");
  const left = nativeMatchingInventory(
    "1",
    Array.from({ length: 2000 }, (_, i) => ({
      address: `0x${i.toString(16)}`,
      value: `item${i}`,
    })),
  );
  const pending = matchNativeFunctions(
    { left, right: left },
    { signal: controller.signal },
  );
  setImmediate(() => controller.abort(reason));
  const cancelled = await pending;
  expect(cancelled.ok).toBe(false);
  if (!cancelled.ok) {
    expect(cancelled.error._tag).toBe("AnalysisCancelledError");
    expect(cancelled.error.cause).toBe(reason);
  }
  const large = await matchNativeFunctions({
    left: { padding: "x".repeat(26 * 1024 * 1024) },
    right: left,
  });
  expect(large.ok).toBe(false);
  if (!large.ok)
    expect(large.error._tag).toBe("AnalysisResourceConstraintError");
});

it("keeps duplicate candidate storage linear and emits every input occurrence exactly once", async () => {
  const entries = Array.from({ length: 1000 }, (_, i) => ({
    address: `0x${i.toString(16)}`,
    value: "same",
  }));
  const { report } = await compare({
    left: nativeMatchingInventory("1", entries),
    right: nativeMatchingInventory("2", entries),
  });
  expect(report.matches).toHaveLength(1);
  expect(report.matches[0]?.left).toHaveLength(1000);
  expect(report.matches[0]?.right).toHaveLength(1000);
  expect(new Set(report.matches[0]?.left.map((x) => x.function_id)).size).toBe(
    1000,
  );
});
