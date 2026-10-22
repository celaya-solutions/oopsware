import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  analysisViewCaptureFixture,
  analysisViewCaptureEvidence,
  analysisViewObjectDenseCapture,
  environmentManifestCaptureFixture,
  environmentStateCaptureFixture,
} from "../../../tests/fixtures/analysisView.js";
import { describe, expect, it, vi } from "vitest";

import { JAVASCRIPT_APPLICATION_EVIDENCE_EXAMPLE } from "../../contracts/javascript/javascriptRuntimeReconciliationExample.js";
import { createEvidence, parseEvidence } from "../../domain/evidence.js";
import { inspectAnalysisViewInputSchema } from "../../domain/analysisView/analysisView.js";
import { functionDossierSchema } from "../../domain/hopperValues.js";
import { ghidraFunctionDossier } from "../../domain/ghidraValues.fixture.js";
import {
  analysisViewJavaScriptAnalysisWithSource,
  analysisViewJavaScriptEvidence,
  analysisViewLayoutEvidence,
} from "../../../tests/fixtures/analysisView.js";
import {
  inspectAnalysisView,
  inspectAnalysisViewValidated,
  inspectAnalysisViewWithFiles,
  summarizeRetainedAnalysis,
} from "./AnalysisViewService.js";
import type { Evidence } from "../../domain/evidence.js";
import { EvidenceIntegrityError } from "../../domain/evidenceErrors.js";
import { err, ok } from "../../domain/result.js";
import { EvidenceLedger } from "../investigation/EvidenceLedger.js";
import { WEB_NETWORK_CAPTURE_LIMITS } from "../../domain/webNetworkCapture.js";
import { isImmutableJsonSnapshot } from "../../domain/immutableJson.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import {
  SCENARIO_EXCHANGES,
  scenarioCaptureEvidence,
  scenarioCaptureFixture,
} from "../../../tests/fixtures/browserScenarioCapture.js";
import { readEvidenceFileSource } from "./evidenceFileSource.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";

vi.mock("./evidenceFileSource.js", { spy: true });

it.each(["layout", "javascript"])(
  "carries the retained %s source snapshot into repeatable shared views",
  (kind) => {
    const parent =
      kind === "layout"
        ? analysisViewLayoutEvidence()
        : analysisViewJavaScriptEvidence();
    const ledger = new EvidenceLedger();
    const recorded = ledger.record(parent);
    if (!recorded.ok) throw recorded.error;
    const borrowed = ledger.forAnalysis(parent.evidence_id)!;
    const original = JSON.stringify(borrowed);
    const input = {
      source: { kind: "retained-evidence", evidence_id: parent.evidence_id },
      view: { kind: "summary" },
    } as const;
    const first = inspectAnalysisView(input, (id) => ledger.forAnalysis(id));
    if (!first.ok) throw first.error;
    const repeated = inspectAnalysisView(input, (id) => ledger.forAnalysis(id));
    if (!repeated.ok) throw repeated.error;
    expect(repeated.value.normalized_result).toEqual(
      first.value.normalized_result,
    );
    expect(isImmutableJsonSnapshot(borrowed.normalized_result)).toBe(true);
    expect(JSON.stringify(borrowed)).toBe(original);
    expect(ledger.forAnalysis(parent.evidence_id)).toBe(borrowed);
  },
);

it.each(["/fixtures/unknown.exe", ""])(
  "preserves recorded empty native identity fields: path=%j",
  (path) => {
    const original = functionDossierSchema.parse(ghidraFunctionDossier());
    const parent = createEvidence(
      { path, format: "pe", sha256: "c".repeat(64) },
      { id: "ghidra", name: "Ghidra", version: "12.1.4" },
      {
        operation: "analyze_function",
        parameters: {},
        result: {
          ...original,
          procedure: {
            ...original.procedure,
            address: "",
            body: { available: false, reason: "Not recorded" },
          },
        },
      },
    );
    const result = inspectAnalysisView({
      source: { kind: "inline", evidence: parent },
      view: {
        kind: "native",
        facet: "procedure",
        offset: 0,
        limit: 64,
      },
    });
    if (!result.ok) throw result.error;
    expect(result.value.normalized_result).toMatchObject({
      procedure_address: "",
      artifact: { path },
      item: { address: "" },
    });
    expect(result.value.locations).toEqual(
      path.length > 0 ? [{ kind: "artifact-path", path }] : [],
    );
  },
);

it("reports inline Evidence identity failures at the complete source path", () => {
  const parent = analysisViewLayoutEvidence();
  const input = {
    source: {
      kind: "inline",
      evidence: { ...parent, evidence_id: `ev_${"0".repeat(64)}` },
    },
    view: { kind: "summary" },
  } as const;

  for (const result of [
    inspectAnalysisView(input),
    inspectAnalysisViewValidated(input),
  ])
    expect(result).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisInputError",
        issues: [
          {
            path: ["source", "evidence", "evidence_id"],
            reason: "invalid_value",
            message: "Evidence semantic identifier does not match its record",
          },
        ],
      },
    });
});

it("projects a small native view from an authenticated >10 MiB retained dossier", () => {
  const original = functionDossierSchema.parse(ghidraFunctionDossier());
  const parent = createEvidence(
    { path: "/fixtures/large.exe", format: "pe", sha256: "c".repeat(64) },
    { id: "ghidra", name: "Ghidra", version: "12.1.4" },
    {
      operation: "analyze_function",
      parameters: { address: "0x401000" },
      result: { ...original, pseudocode: "X".repeat(11 * 1024 * 1024) },
      limitations: ["Synthetic fixture"],
    },
  );
  const input = {
    source: {
      kind: "retained-evidence" as const,
      evidence_id: parent.evidence_id,
    },
    view: {
      kind: "native" as const,
      facet: "pseudocode" as const,
      offset: 0,
      limit: 128,
    },
  };
  const view = inspectAnalysisView(input, (id) =>
    id === parent.evidence_id ? parent : undefined,
  );
  if (!view.ok) throw view.error;
  expect(view.value.evidence_links).toEqual([parent.evidence_id]);
  expect(view.value.normalized_result).toMatchObject({
    kind: "native",
    parent_operation: "analyze_function",
    parent_evidence_id: parent.evidence_id,
    procedure_address: "0x401000",
    artifact: { path: "/fixtures/large.exe", sha256: "c".repeat(64) },
    coverage: { total: 11 * 1024 * 1024, examined: 128, next_offset: 128 },
  });
  expect(view.value.locations).toEqual([
    { kind: "artifact-path", path: "/fixtures/large.exe" },
    { kind: "address", address: "0x401000" },
  ]);
  expect(JSON.stringify(view.value).length).toBeLessThan(12000);
  expect(JSON.stringify(parent).length).toBeGreaterThan(10 * 1024 * 1024);
  expect(inspectAnalysisView(input, () => undefined)).toMatchObject({
    ok: false,
    error: { _tag: "EvidenceIntegrityError" },
  });
});

it("projects inline layout Evidence and retains a derived view record", () => {
  const parent = analysisViewLayoutEvidence();
  const result = inspectAnalysisView({
    source: { kind: "inline", evidence: parent },
    view: {
      kind: "item",
      collection: "sections",
      selector: { index: 2 },
    },
  });
  if (!result.ok) throw result.error;
  const evidence = parseEvidence(result.value);
  expect(evidence.operation).toBe("inspect_analysis_view");
  expect(evidence.predicate_type).toBe("rea.analysis-view");
  expect(evidence.confidence).toBe("derived");
  expect(evidence.evidence_links).toEqual([parent.evidence_id]);
  expect(evidence.normalized_result).toMatchObject({
    kind: "item",
    parent_evidence_id: parent.evidence_id,
    item: { name: { display: ".data" } },
  });
});

it("resolves same-session retained JavaScript Evidence without re-running analysis", () => {
  const parent = analysisViewJavaScriptEvidence(
    analysisViewJavaScriptAnalysisWithSource(),
  );
  const lookup = (evidenceId: string) =>
    evidenceId === parent.evidence_id ? parent : undefined;
  const summary = inspectAnalysisView(
    {
      source: {
        kind: "retained-evidence",
        evidence_id: parent.evidence_id,
      },
      view: { kind: "summary" },
    },
    lookup,
  );
  if (!summary.ok) throw summary.error;
  expect(summary.value.normalized_result).toMatchObject({
    kind: "summary",
    parent_evidence_id: parent.evidence_id,
    parent_operation: "analyze_javascript_application",
  });
  expect(summary.value.normalized_result).not.toHaveProperty(
    "summary.semantic_graph",
  );
  const item = inspectAnalysisView(
    {
      source: {
        kind: "retained-evidence",
        evidence_id: parent.evidence_id,
      },
      view: {
        kind: "item",
        collection: "modules",
        selector: { path: "renderer.js" },
      },
    },
    lookup,
  );
  if (!item.ok) throw item.error;
  expect(JSON.stringify(item.value.normalized_result)).toContain(
    "export const secret = 1;",
  );
});

it("rejects stale retained IDs and unsupported parent operations", () => {
  const missing = inspectAnalysisView(
    {
      source: {
        kind: "retained-evidence",
        evidence_id: JAVASCRIPT_APPLICATION_EVIDENCE_EXAMPLE.evidence_id,
      },
      view: { kind: "summary" },
    },
    () => undefined,
  );
  expect(missing).toMatchObject({
    ok: false,
    error: {
      _tag: "EvidenceIntegrityError",
      evidenceId: JAVASCRIPT_APPLICATION_EVIDENCE_EXAMPLE.evidence_id,
    },
  });
  const unsupported = createEvidence(
    undefined,
    { id: "fixture", name: "Fixture", version: "1" },
    {
      operation: "inspect_recorded_crash",
      parameters: {},
      result: { path: "/artifacts/crash.core" },
    },
  );
  const rejected = inspectAnalysisView({
    source: { kind: "inline", evidence: unsupported },
    view: { kind: "summary" },
  });
  expect(rejected).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisUnsupportedTargetError" },
  });
  expect(
    inspectAnalysisView({
      source: { kind: "inline", evidence: analysisViewLayoutEvidence() },
      view: { kind: "summary", approval: true },
    }),
  ).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisInputError" },
  });
});

it("preserves an absent parent subject instead of guessing its format", () => {
  const analysis = analysisViewJavaScriptAnalysisWithSource();
  const original = analysisViewJavaScriptEvidence(analysis);
  const parent = createEvidence(undefined, original.provider, {
    operation: original.operation,
    parameters: {},
    result: original.normalized_result,
    limitations: original.limitations,
  });
  const result = inspectAnalysisView(
    {
      source: { kind: "retained-evidence", evidence_id: parent.evidence_id },
      view: { kind: "summary" },
    },
    () => parent,
  );
  if (!result.ok) throw result.error;
  expect(result.value.subject).toBeNull();
  expect(result.value.locations).toEqual([
    { kind: "artifact-path", path: analysis.input_path },
  ]);
});

it("rejects contradictory subject and analysis artifact digests", () => {
  const analysis = analysisViewJavaScriptAnalysisWithSource();
  const original = analysisViewJavaScriptEvidence(analysis);
  const parent = createEvidence(
    {
      path: analysis.input_path,
      format: analysis.format,
      sha256: "d".repeat(64),
    },
    original.provider,
    {
      operation: original.operation,
      parameters: {},
      result: original.normalized_result,
    },
  );
  const result = inspectAnalysisView(
    {
      source: { kind: "retained-evidence", evidence_id: parent.evidence_id },
      view: { kind: "summary" },
    },
    () => parent,
  );
  expect(result).toMatchObject({
    ok: false,
    error: { _tag: "EvidenceIntegrityError" },
  });
});

describe("summarizeRetainedAnalysis", () => {
  const parent = analysisViewJavaScriptEvidence(
    analysisViewJavaScriptAnalysisWithSource(),
  );

  it("retains the complete Evidence before projecting its summary", () => {
    const retained = new Map<string, Evidence>();
    const summary = summarizeRetainedAnalysis(parent, {
      recordEvidence: (evidence) => {
        retained.set(evidence.evidence_id, evidence);
        return ok("added");
      },
      evidenceById: (evidenceId) => retained.get(evidenceId),
    });
    if (!summary.ok) throw summary.error;
    expect(retained.get(parent.evidence_id)).toBe(parent);
    expect(summary.value.evidence_links).toEqual([parent.evidence_id]);
    expect(summary.value.normalized_result).toMatchObject({
      kind: "summary",
      parent_evidence_id: parent.evidence_id,
      parent_operation: "analyze_javascript_application",
    });
  });

  it("refuses a summary whose complete Evidence cannot be retained", () => {
    const unavailable = summarizeRetainedAnalysis(parent, {
      recordEvidence: undefined,
      evidenceById: undefined,
    });
    expect(unavailable.ok).toBe(false);
    if (unavailable.ok) return;
    expect(unavailable.error._tag).toBe("AnalysisCapabilityUnavailableError");
    expect(unavailable.error.userMessage).toContain("detail complete");

    const conflict = new EvidenceIntegrityError("ledger conflict");
    expect(
      summarizeRetainedAnalysis(parent, {
        recordEvidence: () => err(conflict),
        evidenceById: () => parent,
      }),
    ).toEqual(err(conflict));
  });
});

it("seals inferred and literal HAR pages, including a null artifact digest", () => {
  const capture = analysisViewCaptureFixture();
  capture.artifact.sha256 = null;
  const parent = analysisViewCaptureEvidence(capture);
  // Any templated group in the full grouping makes every page inferred.
  for (const [offset, confidence] of [
    [0, "inferred"],
    [11, "inferred"],
  ] as const) {
    const result = inspectAnalysisView({
      source: { kind: "inline", evidence: parent },
      view: { kind: "api-surface", offset, limit: 1 },
    });
    if (!result.ok) throw result.error;
    expect(result.value.confidence).toBe(confidence);
    expect(result.value.subject).toBeNull();
    expect(parseEvidence(result.value)).toEqual(result.value);
  }
  expect(
    inspectAnalysisView({
      source: { kind: "inline", evidence: analysisViewLayoutEvidence() },
      view: { kind: "api-surface" },
    }),
  ).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisUnsupportedTargetError" },
  });
});

it("rejects a null projected digest under a present parent subject", () => {
  const capture = analysisViewCaptureFixture();
  capture.artifact.sha256 = null;
  const parent = createEvidence(
    { path: capture.artifact.path, sha256: "a".repeat(64), format: "file" },
    { id: "fixture", name: "fixture", version: "1" },
    {
      operation: "inspect_web_network_capture",
      parameters: { sensitive_value_count: 0 },
      result: capture,
      confidence: "observed",
    },
  );
  expect(
    inspectAnalysisView({
      source: { kind: "inline", evidence: parent },
      view: { kind: "api-surface" },
    }),
  ).toMatchObject({ ok: false, error: { _tag: "EvidenceIntegrityError" } });
});

it("refuses an object-dense borrowed capture before making a full schema clone", () => {
  const capture = analysisViewObjectDenseCapture();
  expect(Buffer.byteLength(JSON.stringify(capture))).toBeLessThan(
    WEB_NETWORK_CAPTURE_LIMITS.inputBytes,
  );
  const parent = analysisViewCaptureEvidence(capture);
  const ledger = new EvidenceLedger();
  const recorded = ledger.record(parent);
  if (!recorded.ok) throw recorded.error;
  const borrowed = ledger.forAnalysis(parent.evidence_id)!;
  expect(Object.isFrozen(borrowed.normalized_result)).toBe(true);
  for (const view of [
    { kind: "api-surface", limit: 1 },
    { kind: "environment-manifest" },
    { kind: "environment-state" },
  ] as const) {
    const result = inspectAnalysisView(
      {
        source: { kind: "retained-evidence", evidence_id: parent.evidence_id },
        view,
      },
      (id) => ledger.forAnalysis(id),
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisResourceConstraintError",
        resource: "memory",
      },
    });
  }
  expect(ledger.forAnalysis(parent.evidence_id)).toBe(borrowed);
});

it("seals an inferred environment manifest and a derived manifest without templated groups", () => {
  const parent = analysisViewCaptureEvidence(
    environmentManifestCaptureFixture(),
  );
  const inferred = inspectAnalysisView({
    source: { kind: "inline", evidence: parent },
    view: { kind: "environment-manifest", template_rules: ["opaque-token"] },
  });
  if (!inferred.ok) throw inferred.error;
  expect(inferred.value.confidence).toBe("inferred");
  expect(inferred.value.authority).toBe(parent.authority);
  expect(inferred.value.evidence_links).toEqual([parent.evidence_id]);
  expect(inferred.value.parameters).toMatchObject({
    view: {
      kind: "environment-manifest",
      template_rules: ["opaque-token"],
      include_query_parameter_names: true,
    },
  });
  expect(inferred.value.normalized_result).toMatchObject({
    kind: "environment-manifest",
    name: "grafana-example",
    parent_evidence_id: parent.evidence_id,
  });
  expect(parseEvidence(inferred.value)).toEqual(inferred.value);
  const literal = environmentManifestCaptureFixture();
  literal.artifact.sha256 = null;
  literal.records = [3, 4, 8].map((ordinal) => literal.records[ordinal]!);
  const derived = inspectAnalysisView({
    source: { kind: "inline", evidence: analysisViewCaptureEvidence(literal) },
    view: { kind: "environment-manifest" },
  });
  if (!derived.ok) throw derived.error;
  expect(derived.value.confidence).toBe("derived");
  expect(derived.value.subject).toBeNull();
  expect(derived.value.normalized_result).toMatchObject({
    templated_groups: 0,
    tools: [{ name: "get_org" }, { name: "get_search" }, { name: "get_user" }],
    limitations: expect.arrayContaining([
      "Parent contains an ordinal subset; the manifest covers only retained records.",
    ]),
  });
  expect(
    inspectAnalysisView({
      source: { kind: "inline", evidence: analysisViewLayoutEvidence() },
      view: { kind: "environment-manifest" },
    }),
  ).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisUnsupportedTargetError" },
  });
});

it("seals an inferred environment state whose values are the recorded ones", () => {
  const parent = analysisViewCaptureEvidence(environmentStateCaptureFixture());
  const sealed = inspectAnalysisView({
    source: { kind: "inline", evidence: parent },
    view: { kind: "environment-state", template_rules: ["opaque-token"] },
  });
  if (!sealed.ok) throw sealed.error;
  expect(sealed.value.confidence).toBe("inferred");
  expect(sealed.value.authority).toBe(parent.authority);
  expect(sealed.value.evidence_links).toEqual([parent.evidence_id]);
  expect(sealed.value.parameters).toMatchObject({
    view: { kind: "environment-state", template_rules: ["opaque-token"] },
  });
  expect(sealed.value.normalized_result).toMatchObject({
    kind: "environment-state",
    name: "grafana-example",
    parent_evidence_id: parent.evidence_id,
    timeline: "recorded-start-time",
  });
  expect(JSON.stringify(sealed.value.normalized_result)).toContain(
    "probe folder",
  );
  expect(parseEvidence(sealed.value)).toEqual(sealed.value);
});

it.each([
  "summary",
  "capture",
  "api-surface",
  "environment-manifest",
  "environment-state",
] as const)("rejects inline accessors before parsing a %s view", (kind) => {
  let accessed = false;
  const evidence = {
    get normalized_result() {
      accessed = true;
      throw new Error("Evidence must be admitted before parsing");
    },
  };
  const input = {
    source: { kind: "inline", evidence },
    view: { kind },
  };
  const parsed = inspectAnalysisViewInputSchema.parse(input);
  if (parsed.source.kind !== "inline") throw new Error("Expected inline input");
  expect(parsed.source.evidence).toBe(evidence);
  expect(inspectAnalysisView(input)).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisInputError",
      issues: [{ path: ["source", "evidence", "normalized_result"] }],
    },
  });
  expect(accessed).toBe(false);
  expect(
    inspectAnalysisView({
      source: { kind: "inline", evidence: analysisViewCaptureEvidence() },
      view: { kind },
    }).ok,
  ).toBe(true);
});

it.each([
  "summary",
  "capture",
  "api-surface",
  "environment-manifest",
  "environment-state",
] as const)(
  "rejects nested, hidden and inherited inline accessors for %s",
  (kind) => {
    const parent = analysisViewCaptureEvidence();
    let accessed = false;
    const getter = () => {
      accessed = true;
      throw new Error("Inline accessors must remain inert");
    };
    const nested = {
      get value() {
        return getter();
      },
    };
    const hidden = Object.defineProperty({}, "value", { get: getter });
    const array = Object.defineProperty([null], 0, { get: getter });
    const inherited: unknown = Object.create({
      get value() {
        return getter();
      },
    });
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    const cases: { data: unknown; path: (string | number)[] }[] = [
      { data: nested, path: ["value"] },
      { data: hidden, path: ["value"] },
      { data: array, path: [0] },
      { data: inherited, path: [] },
      { data: cyclic, path: ["self"] },
    ];
    for (const { data, path } of cases) {
      // A complete envelope reaches payload parsing and Evidence authentication.
      const input = {
        source: {
          kind: "inline" as const,
          evidence: { ...parent, raw_result: data },
        },
        view: { kind },
      };
      for (const result of [
        inspectAnalysisView(input),
        inspectAnalysisViewValidated(
          inspectAnalysisViewInputSchema.parse(input),
        ),
      ])
        expect(result).toMatchObject({
          ok: false,
          error: {
            _tag: "AnalysisInputError",
            issues: [{ path: ["source", "evidence", "raw_result", ...path] }],
          },
        });
    }
    expect(accessed).toBe(false);
  },
);

it.each([
  ["own map", "map", false],
  ["own iterator", Symbol.iterator, false],
  ["own constructor", "constructor", false],
  ["inherited map", "map", true],
  ["inherited iterator", Symbol.iterator, true],
] as const)(
  "rejects array %s accessors without invoking them",
  (_name, key, inherited) => {
    const parent = analysisViewCaptureEvidence();
    let accessed = false;
    const array: unknown[] = [];
    const owner: object = inherited ? Object.create(Array.prototype) : array;
    Object.defineProperty(owner, key, {
      get() {
        accessed = true;
        throw new Error("Array behavior must remain inert");
      },
    });
    if (inherited) Object.setPrototypeOf(array, owner);
    for (const kind of [
      "summary",
      "capture",
      "api-surface",
      "environment-manifest",
      "environment-state",
    ] as const) {
      const result = inspectAnalysisView({
        source: { kind: "inline", evidence: { ...parent, raw_result: array } },
        view: { kind },
      });
      expect(result).toMatchObject({
        ok: false,
        error: { _tag: "AnalysisInputError" },
      });
    }
    expect(accessed).toBe(false);
  },
);

it("rejects callable array overrides and subclass species before parsing", () => {
  const parent = analysisViewCaptureEvidence();
  let invoked = false;
  const callback = () => {
    invoked = true;
    throw new Error("Array callbacks must remain inert");
  };
  class CustomArray extends Array<unknown> {
    static override get [Symbol.species](): ArrayConstructor {
      return callback();
    }
  }
  for (const array of [
    Object.defineProperty([], "map", { value: callback }),
    Object.defineProperty([], Symbol.iterator, { value: callback }),
    new CustomArray(),
  ])
    for (const kind of [
      "summary",
      "capture",
      "api-surface",
      "environment-manifest",
      "environment-state",
    ] as const) {
      const result = inspectAnalysisView({
        source: { kind: "inline", evidence: { ...parent, raw_result: array } },
        view: { kind },
      });
      expect(result).toMatchObject({
        ok: false,
        error: { _tag: "AnalysisInputError" },
      });
    }
  expect(invoked).toBe(false);
});

it.each([
  "summary",
  "capture",
  "api-surface",
  "environment-manifest",
  "environment-state",
] as const)("preserves ordinary inline Evidence for %s", (kind) => {
  const parent = analysisViewCaptureEvidence();
  const before = JSON.stringify(parent);
  const result = inspectAnalysisView({
    source: { kind: "inline", evidence: parent },
    view: { kind },
  });
  if (!result.ok) throw result.error;
  expect(parseEvidence(result.value)).toEqual(result.value);
  expect(result.value.evidence_links).toEqual([parent.evidence_id]);
  expect(result.value.normalized_result).toMatchObject({
    kind,
    parent_evidence_id: parent.evidence_id,
  });
  expect(JSON.stringify(parent)).toBe(before);
  expect(Object.isFrozen(parent)).toBe(false);
});

it("rejects executable constructor values before schema plain-object checks", () => {
  const parent = analysisViewCaptureEvidence();
  let invoked = false;
  const constructor = () => undefined;
  Object.defineProperty(constructor, "prototype", {
    get() {
      invoked = true;
      throw new Error("Constructor metadata must remain inert");
    },
  });
  for (const kind of [
    "summary",
    "capture",
    "api-surface",
    "environment-manifest",
    "environment-state",
  ] as const) {
    expect(
      inspectAnalysisView({
        source: {
          kind: "inline",
          evidence: { ...parent, raw_result: { constructor } },
        },
        view: { kind },
      }),
    ).toMatchObject({ ok: false, error: { _tag: "AnalysisInputError" } });
  }
  expect(invoked).toBe(false);
});

it("rejects inline proxy values before reflection or parsing can run traps", () => {
  const parent = analysisViewCaptureEvidence();
  let invoked = false;
  const trap = () => {
    invoked = true;
    throw new Error("Proxy behavior must remain inert");
  };
  const revoked = Proxy.revocable([], {});
  revoked.revoke();
  for (const value of [
    new Proxy({}, { getPrototypeOf: trap, ownKeys: trap, get: trap }),
    new Proxy(() => undefined, { get: trap }),
    revoked.proxy,
  ])
    for (const kind of [
      "summary",
      "capture",
      "api-surface",
      "environment-manifest",
      "environment-state",
    ] as const) {
      const result = inspectAnalysisView({
        source: { kind: "inline", evidence: { ...parent, raw_result: value } },
        view: { kind },
      });
      expect(result).toMatchObject({
        ok: false,
        error: { _tag: "AnalysisInputError" },
      });
    }
  expect(invoked).toBe(false);
});

it("keeps ignored array metadata inert through parsing and projection", () => {
  const capture = analysisViewCaptureFixture();
  const parent = createEvidence(
    {
      path: capture.artifact.path,
      sha256: capture.artifact.sha256!,
      format: "file",
    },
    { id: "fixture", name: "fixture", version: "1" },
    {
      operation: "inspect_web_network_capture",
      parameters: { sensitive_value_count: 0 },
      result: capture,
      rawResult: [],
    },
  );
  if (!Array.isArray(parent.raw_result)) throw new Error("Expected raw array");
  const array = parent.raw_result;
  let invoked = false;
  const getter = () => {
    invoked = true;
    throw new Error("Ignored array metadata must remain inert");
  };
  for (let index = 0; index < 10_000; index += 1)
    Object.defineProperty(array, `metadata-${index}`, { get: getter });
  Object.defineProperty(array, Symbol("metadata"), { get: getter });
  for (const kind of [
    "summary",
    "capture",
    "api-surface",
    "environment-manifest",
    "environment-state",
  ] as const) {
    const result = inspectAnalysisView({
      source: { kind: "inline", evidence: parent },
      view: { kind },
    });
    if (!result.ok) throw result.error;
    expect(result.value.evidence_links).toEqual([parent.evidence_id]);
  }
  expect(invoked).toBe(false);
  expect(parseEvidence(parent).raw_result).toEqual([]);
});

it("keeps inline-envelope admission live alongside capture validation and grouping", () => {
  // Each clone alone fits; both graphs coexist while the view is projected.
  const capture = analysisViewObjectDenseCapture(40_000);
  const parent = analysisViewCaptureEvidence(capture);
  for (const kind of ["summary", "capture"] as const) {
    const projected = inspectAnalysisView({
      source: { kind: "inline", evidence: parent },
      view: { kind },
    });
    if (!projected.ok) throw projected.error;
    expect(projected.value.evidence_links).toEqual([parent.evidence_id]);
  }
  const retained = inspectAnalysisView(
    {
      source: { kind: "retained-evidence", evidence_id: parent.evidence_id },
      view: { kind: "api-surface" },
    },
    () => parent,
  );
  if (!retained.ok) throw retained.error;
  expect(
    inspectAnalysisView({
      source: { kind: "inline", evidence: parent },
      view: { kind: "api-surface" },
    }),
  ).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisResourceConstraintError", resource: "memory" },
  });
});

it("admits raw_result and parameters before authenticating a portable capture", () => {
  const dense = analysisViewObjectDenseCapture();
  const parent = analysisViewCaptureEvidence();
  for (const field of ["raw_result", "parameters"] as const)
    for (const kind of [
      "api-surface",
      "environment-manifest",
      "environment-state",
    ] as const) {
      const result = inspectAnalysisView({
        source: { kind: "inline", evidence: { ...parent, [field]: dense } },
        view: { kind },
      });
      // Refuse expansion before hashing can report the deliberately stale ID.
      expect(result).toMatchObject({
        ok: false,
        error: { _tag: "AnalysisResourceConstraintError", resource: "memory" },
      });
    }
});

const manifestView = { kind: "environment-manifest" } as const;
const writeEvidenceFile = async (value: unknown): Promise<string> => {
  const root = await createTestTempDirectory("rea-analysis-view-file-");
  const path = join(root, "capture.json");
  await writeFile(path, JSON.stringify(value));
  return path;
};

describe("inspectAnalysisViewWithFiles", () => {
  const view = manifestView;

  it("projects an Evidence file exactly as the same Evidence inline", async () => {
    const parent = analysisViewCaptureEvidence(
      environmentManifestCaptureFixture(),
    );
    const fromFile = await inspectAnalysisViewWithFiles({
      source: { kind: "evidence-file", path: await writeEvidenceFile(parent) },
      view,
    });
    const inline = inspectAnalysisView({
      source: { kind: "inline", evidence: parent },
      view,
    });
    if (!fromFile.ok) throw fromFile.error;
    if (!inline.ok) throw inline.error;
    expect(fromFile.value.normalized_result).toEqual(
      inline.value.normalized_result,
    );
    expect(fromFile.value.parameters).toEqual(inline.value.parameters);
  });

  it("accepts from a file a capture whose response text exceeds the inline budget", async () => {
    const capture = environmentManifestCaptureFixture();
    const reported = capture.records[0]!.reported as {
      response: { content: { text: string } };
    };
    // Inline admission charges about 14 bytes per character; this body alone overruns it.
    reported.response.content.text = "a".repeat(
      Math.ceil(WEB_NETWORK_CAPTURE_LIMITS.outputBytes / 14) + 1024,
    );
    const parent = analysisViewCaptureEvidence(capture);
    expect(
      inspectAnalysisView({
        source: { kind: "inline", evidence: parent },
        view,
      }),
    ).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisResourceConstraintError", resource: "memory" },
    });
    const fromFile = await inspectAnalysisViewWithFiles({
      source: { kind: "evidence-file", path: await writeEvidenceFile(parent) },
      view,
    });
    if (!fromFile.ok) throw fromFile.error;
    expect(fromFile.value.parameters).toMatchObject({
      parent_evidence_id: parent.evidence_id,
    });
  });

  it("refuses a relative path, a missing file and JSON that is not Evidence", async () => {
    expect(
      await inspectAnalysisViewWithFiles({
        source: { kind: "evidence-file", path: "capture.json" },
        view,
      }),
    ).toMatchObject({ ok: false, error: { _tag: "AnalysisInputError" } });
    const missing = join(
      await createTestTempDirectory("rea-analysis-view-missing-"),
      "absent.json",
    );
    expect(
      await inspectAnalysisViewWithFiles({
        source: { kind: "evidence-file", path: missing },
        view,
      }),
    ).toMatchObject({ ok: false, error: { _tag: "EvidenceFileError" } });
    const notEvidence = await inspectAnalysisViewWithFiles({
      source: {
        kind: "evidence-file",
        path: await writeEvidenceFile({ hello: 1 }),
      },
      view,
    });
    expect(notEvidence).toMatchObject({
      ok: false,
      error: { _tag: "EvidenceFileError", reason: "wrong-kind" },
    });
    if (notEvidence.ok) throw new Error("Expected invalid Evidence file");
    expect(projectAnalysisError(notEvidence.error)).toMatchObject({
      details: {
        content_issues: expect.arrayContaining([
          {
            path: ["evidence_id"],
            reason: "missing_argument",
            expected: "string",
          },
        ]),
      },
    });
  });

  it("returns typed cancellation for a cancelled file request", async () => {
    const controller = new AbortController();
    controller.abort();
    const parent = analysisViewCaptureEvidence(
      environmentManifestCaptureFixture(),
    );
    expect(
      await inspectAnalysisViewWithFiles(
        {
          source: {
            kind: "evidence-file",
            path: await writeEvidenceFile(parent),
          },
          view,
        },
        undefined,
        { signal: controller.signal },
      ),
    ).toMatchObject({ ok: false, error: { _tag: "AnalysisCancelledError" } });
  });

  it("returns typed cancellation when a running file request is aborted", async () => {
    const controller = new AbortController();
    const parent = analysisViewCaptureEvidence(
      environmentManifestCaptureFixture(),
    );
    const path = await writeEvidenceFile(parent);
    const running = inspectAnalysisViewWithFiles(
      { source: { kind: "evidence-file", path }, view },
      undefined,
      { signal: controller.signal },
    );
    // Queued before the request yields after its synchronous work, so it is seen even if the read already finished.
    setImmediate(() => controller.abort());
    expect(await running).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError" },
    });
  });

  it("leaves file sources to the file-aware entry point", () => {
    expect(
      inspectAnalysisView({
        source: { kind: "evidence-file", path: "/tmp/capture.json" },
        view,
      }),
    ).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCapabilityUnavailableError" },
    });
  });
});

describe("inspectAnalysisViewWithFiles scenario parents and cancellation", () => {
  const view = manifestView;

  it("accepts from a file a scenario capture whose response bodies exceed the inline budget", async () => {
    const blob = "a".repeat(
      Math.ceil(WEB_NETWORK_CAPTURE_LIMITS.outputBytes / 14) + 1024,
    );
    const parent = scenarioCaptureEvidence(
      scenarioCaptureFixture(
        SCENARIO_EXCHANGES.map((exchange, index) =>
          index === 1 ? { ...exchange, body: `{"blob":"${blob}"}` } : exchange,
        ),
      ),
    );
    expect(
      inspectAnalysisView({
        source: { kind: "inline", evidence: parent },
        view,
      }),
    ).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisResourceConstraintError", resource: "memory" },
    });
    const fromFile = await inspectAnalysisViewWithFiles({
      source: { kind: "evidence-file", path: await writeEvidenceFile(parent) },
      view,
    });
    if (!fromFile.ok) throw fromFile.error;
    expect(fromFile.value.parameters).toMatchObject({
      parent_evidence_id: parent.evidence_id,
    });
  });

  it("reports cancellation rather than the authentication failure of a file aborted while it is authenticated", async () => {
    const controller = new AbortController();
    const parent = analysisViewCaptureEvidence(
      environmentManifestCaptureFixture(),
    );
    const path = await writeEvidenceFile({
      ...parent,
      evidence_id: `ev_${"0".repeat(64)}`,
    });
    const { readEvidenceFileSource: read } = await vi.importActual<
      typeof import("./evidenceFileSource.js")
    >("./evidenceFileSource.js");
    // The abort arrives once the read has finished, while the stale ID is being authenticated.
    vi.mocked(readEvidenceFileSource).mockImplementationOnce(
      async (...args) => {
        const loaded = await read(...args);
        controller.abort();
        return loaded;
      },
    );
    expect(
      await inspectAnalysisViewWithFiles(
        { source: { kind: "evidence-file", path }, view },
        undefined,
        { signal: controller.signal },
      ),
    ).toMatchObject({ ok: false, error: { _tag: "AnalysisCancelledError" } });
  });
});
