import { describe, expect, it } from "vitest";

import {
  analysisViewCaptureEvidence,
  analysisViewCaptureFixture,
  environmentManifestCaptureFixture,
} from "../../../tests/fixtures/analysisView.js";
import {
  environmentServeFixture,
  environmentServeSource,
} from "../../../tests/fixtures/environmentServe.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { inspectAnalysisView } from "../analysisView/AnalysisViewService.js";
import { loadEnvironmentSource } from "./environmentSource.js";

const refusal = (manifest: unknown, evidence: unknown) => {
  const loaded = loadEnvironmentSource(manifest, evidence);
  if (loaded.ok) throw new Error("Expected the pair to be refused");
  return projectAnalysisError(loaded.error);
};

describe("loadEnvironmentSource", () => {
  it("authenticates the pair and indexes every cited record as a replayable exchange", () => {
    const fixture = environmentServeFixture();
    const source = environmentServeSource(fixture);
    expect(source.manifest.kind).toBe("environment-manifest");
    expect(source.manifest.name).toBe("grafana-example");
    expect(source.evidenceId).toBe(fixture.capture.evidence_id);
    expect(source.manifestEvidenceId).toBe(fixture.manifest.evidence_id);
    const cited = new Set(
      source.manifest.tools.flatMap((tool) => tool.record_ordinals),
    );
    expect(new Set(source.exchanges.keys())).toEqual(cited);
    const users = source.manifest.tools.find(
      (tool) => tool.name === "get_users_by_id",
    );
    const user = source.exchanges.get(users?.record_ordinals[0] ?? -1);
    expect(user).toMatchObject({
      path: "/api/users/2",
      query: null,
      status: 200,
      contentType: "application/json",
    });
    expect(user?.bodyText).toContain('"login":"probe"');
    const search = source.manifest.tools.find(
      (tool) => tool.name === "get_search",
    );
    expect(source.exchanges.get(search?.record_ordinals[0] ?? -1)?.query).toBe(
      "?query=probe&type=dash-db",
    );
  });

  it("refuses capture Evidence in a format other than HAR before pairing it", () => {
    const fixture = environmentServeFixture();
    for (const format of ["saz", "mitmproxy"] as const) {
      const evidence = analysisViewCaptureEvidence({
        ...analysisViewCaptureFixture(),
        format,
      });
      expect(refusal(fixture.manifest, evidence)).toMatchObject({
        code: "invalid_request",
        details: {
          issues: [
            {
              path: ["evidence", "normalized_result", "format"],
              expected: "har",
            },
          ],
        },
      });
    }
  });

  it("refuses a manifest whose parent is not the supplied evidence with a typed invalid request", () => {
    const fixture = environmentServeFixture();
    const other = analysisViewCaptureEvidence(analysisViewCaptureFixture());
    const projected = refusal(fixture.manifest, other);
    expect(projected).toMatchObject({
      code: "invalid_request",
      category: "invalid_input",
      details: {
        operation: "environment-serve",
        issues: [
          {
            path: ["evidence", "evidence_id"],
            reason: "invalid_value",
            expected: fixture.capture.evidence_id,
          },
        ],
      },
    });
    expect(projected.message).toContain("different capture");
  });

  it("refuses manifests of another view kind, non-capture evidence and non-Evidence JSON", () => {
    const fixture = environmentServeFixture();
    const surface = inspectAnalysisView({
      source: { kind: "inline", evidence: fixture.capture },
      view: { kind: "api-surface" },
    });
    if (!surface.ok) throw surface.error;
    expect(refusal(surface.value, fixture.capture)).toMatchObject({
      code: "invalid_request",
      details: {
        issues: [
          {
            path: ["manifest", "normalized_result", "kind"],
            expected: "environment-manifest",
          },
        ],
      },
    });
    expect(refusal(fixture.manifest, fixture.manifest)).toMatchObject({
      code: "invalid_request",
      details: {
        issues: [
          {
            path: ["evidence", "operation"],
            expected: "inspect_web_network_capture or capture_browser_scenario",
          },
        ],
      },
    });
    const malformed = refusal({ evidence_id: "ev_x" }, fixture.capture);
    expect(malformed.code).toBe("invalid_request");
    expect(malformed.details?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: expect.arrayContaining(["manifest"]) }),
      ]),
    );
  });

  it("indexes nothing for a manifest that cites no records and leaves tampered captures to authentication", () => {
    const fixture = environmentServeFixture();
    const capture = analysisViewCaptureEvidence({
      ...analysisViewCaptureFixture(),
      records: [],
      total_records: 0,
    });
    const manifest = inspectAnalysisView({
      source: { kind: "inline", evidence: capture },
      view: { kind: "environment-manifest" },
    });
    if (!manifest.ok) throw manifest.error;
    const empty = loadEnvironmentSource(manifest.value, capture);
    if (!empty.ok) throw empty.error;
    expect(empty.value.exchanges.size).toBe(0);
    // Removing records changes the capture's semantic identity, so the pair is
    // refused as an unauthenticated evidence file before any ordinal is looked up.
    const tampered = structuredClone(fixture.capture);
    const result = tampered.normalized_result;
    if (typeof result !== "object" || result === null || Array.isArray(result))
      throw new Error("Capture result must be an object");
    result.records = [];
    expect(refusal(fixture.manifest, tampered)).toMatchObject({
      code: "invalid_request",
      details: {
        issues: expect.arrayContaining([
          expect.objectContaining({
            path: expect.arrayContaining(["evidence"]),
          }),
        ]),
      },
    });
  });
});

describe("loadEnvironmentSource recorded request lines", () => {
  it("keeps the delimiter of an explicit empty query in the recorded exchange", () => {
    const capture = environmentManifestCaptureFixture();
    const record = capture.records.find((entry) =>
      JSON.stringify(entry.reported).includes("/api/users/2"),
    );
    if (record === undefined) throw new Error("Fixture lacks /api/users/2");
    const reported = structuredClone(record.reported) as {
      request: { url: string };
    };
    reported.request.url = `${reported.request.url}?`;
    record.reported = reported;
    const evidence = analysisViewCaptureEvidence(capture);
    const manifest = inspectAnalysisView({
      source: { kind: "inline", evidence },
      view: { kind: "environment-manifest" },
    });
    if (!manifest.ok) throw manifest.error;
    const loaded = loadEnvironmentSource(manifest.value, evidence);
    if (!loaded.ok) throw loaded.error;
    const exchanges = [...loaded.value.exchanges.values()];
    expect(
      exchanges.find((entry) => entry.path === "/api/users/2")?.query,
    ).toBe("?");
    expect(
      exchanges.find((entry) => entry.path === "/api/users/3")?.query,
    ).toBeNull();
  });
});
