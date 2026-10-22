import {
  apiSurfaceHar,
  environmentManifestHar,
} from "../../fixtures/historicalHar.js";
import { inspectAnalysisView } from "../../../src/application/analysisView/AnalysisViewService.js";
import { createHash } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";
import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

import {
  analysisViewLayoutEvidence,
  analysisViewCaptureFixture,
  analysisViewCaptureEvidence,
  analysisViewObjectDenseCapture,
  analysisViewJavaScriptEvidence,
  analysisViewJavaScriptAnalysisWithSource,
  analysisViewNativeEvidence,
  environmentManifestCaptureFixture,
  environmentStateCaptureFixture,
} from "../../fixtures/analysisView.js";
import { createEvidence, parseEvidence } from "../../../src/domain/evidence.js";
import { ghidraFunctionDossier } from "../../../src/domain/ghidraValues.fixture.js";
import { createEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import { inspectEvidenceBundle } from "../../../src/application/investigation/InspectEvidenceBundle.js";

cliTest(
  "preserves native relationship coverage independently of exhausted CLI pages",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-native-coverage-cli-");
    const parent = analysisViewNativeEvidence({
      status: "partial",
      limited_directions: ["callees"],
      limitations: ["Callees: fixture read limit"],
      diagnostics: ["Fixture relationship diagnostic"],
    });
    const parentBefore = JSON.stringify(parent);
    const request = join(root, "request.json");
    await writeFile(
      request,
      JSON.stringify({
        source: { kind: "inline", evidence: parent },
        view: { kind: "native", facet: "callees", offset: 0, limit: 1 },
      }),
    );
    const response = await cli.run({
      arguments: ["inspect-analysis-view", request, "--json"],
    });
    expect(response.exitCode).toBe(0);
    const evidence = parseEvidence(response.json);
    expect(evidence.relationship_coverage).toEqual(
      parent.relationship_coverage,
    );
    expect(evidence.normalized_result).toMatchObject({
      item: [],
      coverage: { total: 0, exhausted: true },
      limitations: expect.arrayContaining(["Fixture dossier caveat"]),
    });
    expect(evidence.evidence_links).toEqual([parent.evidence_id]);
    expect(JSON.stringify(parent)).toBe(parentBefore);
  },
);

cliTest(
  "reads typed module references through the public CLI with canonical Evidence",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-module-reference-cli-");
    const request = join(root, "request.json");
    const parent = analysisViewJavaScriptEvidence(
      analysisViewJavaScriptAnalysisWithSource(),
    );
    const input = {
      source: { kind: "inline", evidence: parent },
      view: {
        kind: "javascript",
        collection: "modules",
        projection: "references",
        where: { path: "renderer.js" },
        limit: 1,
      },
    };
    const expected = inspectAnalysisView(input);
    if (!expected.ok) throw expected.error;
    await writeFile(request, JSON.stringify(input));
    const response = await cli.run({
      arguments: ["inspect-analysis-view", request, "--json"],
    });
    expect(response.exitCode).toBe(0);
    const evidence = parseEvidence(response.json);
    expect(evidence.normalized_result).toEqual(
      expected.value.normalized_result,
    );
    expect(evidence.evidence_id).toBe(expected.value.evidence_id);
    expect(evidence.evidence_links).toEqual([parent.evidence_id]);
  },
);
cliTest(
  "projects opted-in query names through compiled CLI without query values",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-query-names-cli-");
    const path = join(root, "view.json");
    const capture = analysisViewCaptureFixture();
    capture.records = capture.records.slice(0, 2);
    capture.total_records = 2;
    capture.records.forEach((record, index) => {
      record.reported = {
        request: {
          method: "GET",
          url:
            index === 0
              ? "https://api.test/products?category=books&page=1&category=repeat"
              : "https://api.test/products?category=games&sort=price#ignored",
        },
      };
    });
    await writeFile(
      path,
      JSON.stringify({
        source: {
          kind: "inline",
          evidence: analysisViewCaptureEvidence(capture),
        },
        view: { kind: "api-surface", include_query_parameter_names: true },
      }),
    );
    const result = await cli.run({
      arguments: ["inspect-analysis-view", path, "--json"],
    });
    expect(result.exitCode).toBe(0);
    const evidence = parseEvidence(result.json);
    expect(evidence.normalized_result).toMatchObject({
      groups: [
        {
          query_parameter_names: [
            { name: "category", record_ordinals: [0, 1] },
            { name: "page", record_ordinals: [0] },
            { name: "sort", record_ordinals: [1] },
          ],
        },
      ],
    });
    for (const value of ["books", "games", "repeat", "price", "ignored"])
      expect(result.stdout).not.toContain(value);
  },
);

cliTest(
  "projects portable artifact inventory after the original ZIP is removed",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-inventory-view-cli-");
    const archive = join(root, "fixture.zip");
    const writer = new ZipWriter(new Uint8ArrayWriter());
    await writer.add("main.js", new TextReader("console.log('portable');\n"));
    await writeFile(archive, await writer.close());
    const inspected = await cli.run({
      arguments: ["inspect-artifact", archive, "--json"],
    });
    expect(inspected.exitCode).toBe(0);
    const parent = parseEvidence(inspected.json);
    await unlink(archive);
    const request = join(root, "view.json");
    await writeFile(
      request,
      JSON.stringify({
        source: { kind: "inline", evidence: parent },
        view: {
          kind: "inventory",
          collection: "occurrences",
          logical_paths: ["main.js"],
        },
      }),
    );
    const projected = await cli.run({
      arguments: ["inspect-analysis-view", request, "--json"],
    });
    expect(projected.exitCode).toBe(0);
    expect(projected.json).toMatchObject({
      operation: "inspect_analysis_view",
      evidence_links: [parent.evidence_id],
      normalized_result: {
        parent_evidence_id: parent.evidence_id,
        kind: "inventory",
        source_complete: true,
        artifact: { path: archive, sha256: parent.subject?.digest.sha256 },
        items: [expect.objectContaining({ logical_path: "main.js" })],
        coverage: { total: 1, exhausted: true, next_offset: null },
      },
    });
  },
);

cliTest(
  "admits portable captures before parsing and preserves capture caveats",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-inline-capture-cli-");
    const path = join(root, "view.json");
    const environment = {
      HOME: root,
      XDG_CONFIG_HOME: root,
      XDG_CACHE_HOME: root,
    };
    await writeFile(
      path,
      JSON.stringify({
        source: {
          kind: "inline",
          evidence: analysisViewCaptureEvidence(
            analysisViewObjectDenseCapture(),
          ),
        },
        view: { kind: "api-surface" },
      }),
    );
    const refused = await cli.run({
      arguments: ["inspect-analysis-view", path, "--json"],
      environment,
    });
    expect(refused.exitCode).toBe(1);
    expect(refused.json).toMatchObject({
      code: "resource_constraint",
      details: { resource: "memory" },
    });

    const capture = analysisViewCaptureFixture();
    capture.records = capture.records.slice(0, 1);
    capture.total_records = 1;
    const caveat = "Producer omitted exchanges before capture startup.";
    capture.limitations = [caveat, caveat];
    capture.records[0]!.reported = {
      request: { method: "GET", url: "https://api.test/a" },
      response: {
        status: 200,
        content: { mimeType: "\u000btext/plain\u000b" },
      },
    };
    const parent = analysisViewCaptureEvidence(capture);
    expect(parent.limitations).not.toContain(caveat);
    await writeFile(
      path,
      JSON.stringify({
        source: { kind: "inline", evidence: parent },
        view: { kind: "api-surface" },
      }),
    );
    const response = await cli.run({
      arguments: ["inspect-analysis-view", path, "--json"],
      environment,
    });
    expect(response.exitCode, response.stdout).toBe(0);
    const result = parseEvidence(response.json);
    expect(result.limitations.filter((value) => value === caveat)).toEqual([
      caveat,
    ]);
    expect(result.normalized_result).toMatchObject({
      groups: [{ content_types: [], flags: ["single-sample"] }],
      limitations: expect.arrayContaining([caveat]),
      unknowns: [
        "Some retained records have unavailable status or content type values.",
      ],
    });
  },
);

cliTest(
  "discovers native records from a complete portable bundle using the shared workflow",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-evidence-discovery-cli-");
    const parent = createEvidence(
      { path: "/fixtures/native.exe", format: "pe", sha256: "a".repeat(64) },
      { id: "ghidra", name: "Ghidra", version: "12.1.4" },
      {
        operation: "analyze_function",
        parameters: {},
        result: ghidraFunctionDossier(),
      },
    );
    const bundle = createEvidenceBundle([parent]);
    const path = join(root, "evidence.json");
    await writeFile(path, JSON.stringify(bundle));
    const options = {
      detail: "summary" as const,
      filters: { evidence_id: parent.evidence_id },
    };
    const result = await cli.run({
      arguments: [
        "inspect-evidence-bundle",
        JSON.stringify({ path, ...options }),
        "--json",
      ],
      environment: { HOME: root, XDG_CONFIG_HOME: root, XDG_CACHE_HOME: root },
    });
    expect(result.exitCode).toBe(0);
    const expected = inspectEvidenceBundle(bundle, options);
    if (!expected.ok) throw expected.error;
    expect(result.json).toEqual(expected.value);
    const complete = await cli.run({
      arguments: [
        "inspect-evidence-bundle",
        JSON.stringify({ path }),
        "--json",
      ],
      environment: { HOME: root, XDG_CONFIG_HOME: root, XDG_CACHE_HOME: root },
    });
    expect(complete.exitCode).toBe(0);
    expect(complete.json).toEqual(bundle);
  },
);
cliTest(
  "projects one section from a JSON file of inline layout Evidence",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-analysis-view-cli-");
    const parent = analysisViewLayoutEvidence();
    const request = {
      source: { kind: "inline", evidence: parent },
      view: {
        kind: "item",
        collection: "sections",
        selector: { name: ".data" },
      },
    };
    const input = join(root, "view.json");
    await mkdir(root, { recursive: true });
    await writeFile(input, JSON.stringify(request));
    const result = await cli.run({
      arguments: ["inspect-analysis-view", input, "--json"],
      environment: {
        HOME: root,
        XDG_CONFIG_HOME: root,
        XDG_CACHE_HOME: root,
      },
    });
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({
      operation: "inspect_analysis_view",
      normalized_result: {
        kind: "item",
        parent_evidence_id: parent.evidence_id,
        item: { name: { display: ".data" } },
      },
    });
  },
);

cliTest(
  "projects native function pseudocode without requiring Ghidra",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-native-view-cli-");
    const parent = createEvidence(
      { path: "/fixtures/native.exe", format: "pe", sha256: "a".repeat(64) },
      { id: "ghidra", name: "Ghidra", version: "12.1.4" },
      {
        operation: "analyze_function",
        parameters: { address: "0x401000" },
        result: ghidraFunctionDossier(),
      },
    );
    const input = join(root, "native-view.json");
    await writeFile(
      input,
      JSON.stringify({
        source: { kind: "inline", evidence: parent },
        view: { kind: "native", facet: "pseudocode", offset: 0, limit: 12 },
      }),
    );
    const result = await cli.run({
      arguments: ["inspect-analysis-view", input, "--json"],
      environment: { HOME: root, XDG_CONFIG_HOME: root, XDG_CACHE_HOME: root },
    });
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({
      operation: "inspect_analysis_view",
      normalized_result: {
        kind: "native",
        parent_evidence_id: parent.evidence_id,
        procedure_address: "0x401000",
        item: { text: "int fixture_", unit: "utf16-code-units" },
      },
      locations: [
        { kind: "artifact-path", path: "/fixtures/native.exe" },
        { kind: "address", address: "0x401000" },
      ],
    });
  },
);

cliTest("rejects malformed JSON before projection", async ({ cli }) => {
  const root = await createTestTempDirectory("rea-analysis-view-cli-bad-");
  const result = await cli.run({
    arguments: ["inspect-analysis-view", "{", "--json"],
    environment: {
      HOME: root,
      XDG_CONFIG_HOME: root,
      XDG_CACHE_HOME: root,
    },
  });
  expect(result.exitCode).toBe(1);
  expect(result.json).toMatchObject({
    code: "invalid_request",
    category: "invalid_input",
    details: { operation: "inspect-analysis-view" },
  });
});

cliTest("rejects a request that omits source", async ({ cli }) => {
  const root = await createTestTempDirectory("rea-analysis-view-cli-missing-");
  const input = join(root, "missing-source.json");
  await writeFile(input, JSON.stringify({ view: { kind: "summary" } }));
  const result = await cli.run({
    arguments: ["inspect-analysis-view", input, "--json"],
    environment: {
      HOME: root,
      XDG_CONFIG_HOME: root,
      XDG_CACHE_HOME: root,
    },
  });
  expect(result.exitCode).toBe(1);
  expect(result.json).toMatchObject({
    code: "invalid_request",
    category: "invalid_input",
    details: { operation: "inspect-analysis-view" },
  });
});

for (const [view, reason] of [
  [{ kind: "unknown-view" }, "invalid_value"],
  [{}, "missing_argument"],
] as const) {
  cliTest(
    `reports correction details for ${reason} view kind`,
    async ({ cli }) => {
      const root = await createTestTempDirectory("rea-view-variant-");
      const input = join(root, "view.json");
      await writeFile(
        input,
        JSON.stringify({
          source: {
            kind: "inline",
            evidence: analysisViewLayoutEvidence(),
          },
          view,
        }),
      );
      const result = await cli.run({
        arguments: ["inspect-analysis-view", input, "--json"],
        environment: {
          HOME: root,
          XDG_CONFIG_HOME: root,
          XDG_CACHE_HOME: root,
        },
      });
      expect(result.exitCode).toBe(1);
      expect(result.json).toMatchObject({
        code: "invalid_request",
        details: {
          issues: [
            {
              path: ["view", "kind"],
              reason,
              expected: expect.arrayContaining(["summary", "page"]),
            },
          ],
        },
      });
      expect(JSON.stringify(result.json)).not.toContain("unknown-view");
    },
  );
}

cliTest(
  "decodes HAR credentials and projects recorded API paths through the compiled workflows",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-surface-cli-");
    const fixture = apiSurfaceHar();
    const entry = fixture.log.entries[0]!;
    const urls = [
      "https://user:password@api.example.test/a/%2e%2e/admin?token=ordinary#fragment",
      "https://api.example.test/admin",
      "https:user:password@api.example.test/path",
      "https:///user:password@api.example.test/path",
    ];
    fixture.log.entries.push(
      ...urls.map((url) => ({
        ...entry,
        request: { ...entry.request, url },
      })),
    );
    const bytes = JSON.stringify(fixture);
    const capturePath = join(root, "capture.har");
    const input = join(root, "view.json");
    const environment = {
      HOME: root,
      XDG_CONFIG_HOME: root,
      XDG_CACHE_HOME: root,
    };
    await writeFile(capturePath, bytes);
    const capture = await cli.run({
      arguments: ["inspect-web-network-capture", capturePath, "har", "--json"],
      environment,
    });
    expect(capture.exitCode, capture.stdout).toBe(0);
    const parent = parseEvidence(capture.json);
    expect(parent.subject?.digest.sha256).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    expect(JSON.stringify(parent)).not.toContain("password");
    await writeFile(
      input,
      JSON.stringify({
        source: { kind: "inline", evidence: parent },
        view: { kind: "api-surface" },
      }),
    );
    const result = await cli.run({
      arguments: ["inspect-analysis-view", input, "--json"],
      environment,
    });
    expect(result.exitCode, result.stdout).toBe(0);
    expect(result.json).toMatchObject({
      confidence: "inferred",
      evidence_links: [parent.evidence_id],
      normalized_result: {
        kind: "api-surface",
        records: { examined: 17, total: 17, excluded: 2 },
        coverage: { total: 14, exhausted: true },
        groups: expect.arrayContaining([
          expect.objectContaining({
            path_template: "/a/%2e%2e/admin",
            record_ordinals: [13],
          }),
          expect.objectContaining({
            path_template: "/admin",
            record_ordinals: [14],
          }),
        ]),
        excluded_records: [
          { ordinal: 15, reason: "url-redacted" },
          { ordinal: 16, reason: "url-redacted" },
        ],
      },
    });
    expect(JSON.stringify(result.json)).not.toContain("password");
    expect(JSON.stringify(result.json)).not.toContain("ordinary");
  },
);

cliTest(
  "projects an environment manifest from an Evidence file through the compiled CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-evidence-file-cli-");
    const capturePath = join(root, "capture.json");
    const parent = analysisViewCaptureEvidence(
      environmentManifestCaptureFixture(),
    );
    await writeFile(capturePath, JSON.stringify(parent));
    const requestPath = join(root, "view.json");
    const view = {
      kind: "environment-manifest",
      template_rules: ["opaque-token", "sibling-pair-variance"],
    } as const;
    await writeFile(
      requestPath,
      JSON.stringify({
        source: { kind: "evidence-file", path: capturePath },
        view,
      }),
    );
    const result = await cli.run({
      arguments: ["inspect-analysis-view", requestPath, "--json"],
    });
    expect(result.exitCode, result.stdout).toBe(0);
    const evidence = parseEvidence(result.json);
    expect(evidence.parameters).toMatchObject({
      parent_evidence_id: parent.evidence_id,
    });
    // The file source projects exactly what the same Evidence projects inline.
    const inline = inspectAnalysisView({
      source: { kind: "inline", evidence: parent },
      view,
    });
    if (!inline.ok) throw inline.error;
    expect(evidence.normalized_result).toEqual(inline.value.normalized_result);
    expect(evidence.normalized_result).toMatchObject({
      kind: "environment-manifest",
      origin: "http://grafana.example",
    });
  },
);

cliTest(
  "projects an environment manifest through the compiled CLI without recorded values",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-environment-manifest-cli-");
    const path = join(root, "view.json");
    await writeFile(
      path,
      JSON.stringify({
        source: {
          kind: "inline",
          evidence: analysisViewCaptureEvidence(
            environmentManifestCaptureFixture(),
          ),
        },
        view: {
          kind: "environment-manifest",
          template_rules: [
            "after-uid-literal",
            "opaque-token",
            "sibling-variance",
          ],
        },
      }),
    );
    const result = await cli.run({
      arguments: ["inspect-analysis-view", path, "--json"],
    });
    expect(result.exitCode, result.stdout).toBe(0);
    const evidence = parseEvidence(result.json);
    expect(evidence.confidence).toBe("inferred");
    expect(evidence.normalized_result).toMatchObject({
      kind: "environment-manifest",
      origin: "http://grafana.example",
      name: "grafana-example",
      coverage: { total: 19, exhausted: true },
      excluded: expect.arrayContaining([
        expect.objectContaining({ reason: "other-origin" }),
      ]),
    });
    for (const template of [
      "/api/dashboards/uid/{uid}",
      "/api/folders/{uid}",
      "/api/plugins/{plugin_id}/settings",
      "/api/datasources/uid/{uid}/health",
    ])
      expect(result.stdout).toContain(JSON.stringify(template));
    for (const value of ["probe folder", "Main Org", "JFIF", "console.log"])
      expect(result.stdout).not.toContain(value);
    await writeFile(
      path,
      JSON.stringify({
        source: {
          kind: "inline",
          evidence: analysisViewCaptureEvidence(
            analysisViewObjectDenseCapture(),
          ),
        },
        view: { kind: "environment-manifest" },
      }),
    );
    const refused = await cli.run({
      arguments: ["inspect-analysis-view", path, "--json"],
    });
    expect(refused.exitCode).toBe(1);
    expect(refused.json).toMatchObject({
      code: "resource_constraint",
      details: { resource: "memory" },
    });
  },
);

cliTest(
  "extracts an environment state through the compiled CLI with recorded values",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-environment-state-cli-");
    const path = join(root, "view.json");
    await writeFile(
      path,
      JSON.stringify({
        source: {
          kind: "inline",
          evidence: analysisViewCaptureEvidence(
            environmentStateCaptureFixture(),
          ),
        },
        view: {
          kind: "environment-state",
          template_rules: [
            "after-uid-literal",
            "opaque-token",
            "sibling-variance",
          ],
        },
      }),
    );
    const result = await cli.run({
      arguments: ["inspect-analysis-view", path, "--json"],
    });
    expect(result.exitCode, result.stdout).toBe(0);
    const evidence = parseEvidence(result.json);
    expect(evidence.confidence).toBe("inferred");
    expect(evidence.normalized_result).toMatchObject({
      kind: "environment-state",
      origin: "http://grafana.example",
      timeline: "recorded-start-time",
      types: expect.arrayContaining([
        expect.objectContaining({
          collection_template: "/api/folders",
          id_field: "uid",
        }),
      ]),
    });
    for (const value of ["probe folder", "probe@example.test"])
      expect(result.stdout).toContain(value);
  },
);

cliTest(
  "decodes a Grafana-shaped HAR and projects its environment manifest through the compiled workflows",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-manifest-chain-cli-");
    const capturePath = join(root, "capture.har");
    await writeFile(capturePath, JSON.stringify(environmentManifestHar()));
    const capture = await cli.run({
      arguments: ["inspect-web-network-capture", capturePath, "har", "--json"],
    });
    expect(capture.exitCode, capture.stdout).toBe(0);
    const parent = parseEvidence(capture.json);
    const input = join(root, "manifest.json");
    await writeFile(
      input,
      JSON.stringify({
        source: { kind: "inline", evidence: parent },
        view: { kind: "environment-manifest" },
      }),
    );
    const result = await cli.run({
      arguments: ["inspect-analysis-view", input, "--json"],
    });
    expect(result.exitCode, result.stdout).toBe(0);
    expect(result.json).toMatchObject({
      confidence: "inferred",
      evidence_links: [parent.evidence_id],
      normalized_result: {
        kind: "environment-manifest",
        name: "grafana-example",
        templated_groups: 6,
        coverage: { total: 22, exhausted: true },
        artifact: { path: capturePath, sha256: parent.subject?.digest.sha256 },
        records: expect.arrayContaining([
          {
            ordinal: 3,
            method: "GET",
            path: "/api/org",
            status: 200,
            content_type: "application/json",
          },
        ]),
        unknowns: [
          expect.objectContaining({ kind: "authorization-model" }),
          expect.objectContaining({ kind: "response-semantics" }),
          expect.objectContaining({ kind: "state-transition" }),
        ],
      },
    });
    expect(JSON.stringify(result.json)).not.toContain("probe folder");
  },
);
