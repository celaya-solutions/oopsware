import { describe, expect, it } from "vitest";

import {
  projectAnalysisView,
  type AnalysisViewParent,
} from "./analysisView.js";

const target = "a".repeat(64);
const evidence = (artifact_path: string) => [
  {
    kind: "interface_builder_resource" as const,
    description: "compiled document",
    location: { address: null, file_offset: null },
    artifact_path,
    artifact_sha256: "b".repeat(64),
  },
];
const node = (id: string, kind: string, document: string) => ({
  id,
  kind,
  name: id,
  location: null,
  attributes: {},
  evidence: evidence(document),
});
const main = "Contents/Resources/Main.nib";
const second = "Contents/Resources/Second.nib";
const document = (relative_path: string) => ({
  relative_path,
  archive_sha256: "b".repeat(64),
  document_kind: "nib" as const,
  object_count: 2,
  connection_count: 1,
  hierarchy_complete: true,
});
const report = (truncated = false) => ({
  target_sha256: target,
  documents: [document(main), document(second)],
  graph: {
    target_sha256: target,
    provider: { id: "rea-ib", version: "1", tool_version: "1" },
    nodes: [
      node("main:root", "scene", main),
      node("main:button", "control", main),
      node("second:root", "scene", second),
    ],
    edges: [
      {
        id: "main:edge",
        from: "main:root",
        to: "main:button",
        relation: "contains",
        resolution: "observed",
        evidence: evidence(main),
        limitations: [],
      },
    ],
    coverage: [
      {
        facet: `objects:${main}`,
        status: "complete",
        reason: null,
        examined: 2,
        omitted: 0,
      },
    ],
    truncated,
  },
  limitations: ["Recognized archive fields only."],
});
const parent = (
  normalizedResult: unknown = report(),
  sha256 = target,
): AnalysisViewParent => ({
  evidenceId: `ev_${"c".repeat(64)}`,
  operation: "decode_interface_builder",
  normalizedResult,
  subject: {
    name: "Fixture",
    digest: { sha256 },
    format: "mach-o",
    architecture: "arm64",
    local_path: "/Applications/Fixture.app/Contents/MacOS/Fixture",
  },
  limitations: [],
});

describe("Interface Builder analysis views", () => {
  it("summarizes documents and graph counts without rows", () => {
    const projected = projectAnalysisView(parent(), { kind: "summary" });
    if (!projected.ok) throw projected.error;
    expect(projected.value).toMatchObject({
      kind: "summary",
      parent_operation: "decode_interface_builder",
      artifact: { sha256: target },
      summary: {
        documents: report().documents,
        available_counts: { nodes: 3, edges: 1, coverage: 1 },
        node_kinds: { control: 1, scene: 2 },
        edge_relations: { contains: 1 },
        coverage_statuses: { complete: 1 },
        truncated: false,
      },
      coverage: { examined: 7, total: 7 },
    });
    expect(JSON.stringify(projected.value)).not.toContain("main:button");
  });

  it("pages one document's nodes and keeps decoder truncation visible", () => {
    const projected = projectAnalysisView(parent(), {
      kind: "interface-builder",
      collection: "nodes",
      document: main,
      offset: 1,
      limit: 5,
    });
    if (!projected.ok) throw projected.error;
    expect(projected.value).toMatchObject({
      kind: "interface-builder",
      items: [node("main:button", "control", main)],
      source_truncated: false,
      coverage: { status: "page", examined: 1, total: 2, exhausted: true },
    });
    const truncated = projectAnalysisView(parent(report(true)), {
      kind: "interface-builder",
      collection: "coverage",
      offset: 0,
      limit: 64,
    });
    if (!truncated.ok) throw truncated.error;
    expect(truncated.value).toMatchObject({
      items: report().graph.coverage,
      source_truncated: true,
      unknowns: expect.arrayContaining([
        expect.stringContaining("The decoded graph is incomplete"),
      ]),
    });
  });

  it("refuses unknown documents, other views and mismatched targets", () => {
    const unknown = projectAnalysisView(parent(), {
      kind: "interface-builder",
      collection: "edges",
      document: "Contents/Resources/Missing.nib",
      offset: 0,
      limit: 64,
    });
    if (unknown.ok) throw new Error("expected an unknown-document refusal");
    expect(unknown.error).toMatchObject({
      issues: [{ path: ["view", "document"] }],
    });
    const wrongKind = projectAnalysisView(parent(), {
      kind: "macho",
      facet: "imports",
      offset: 0,
      limit: 64,
    });
    if (wrongKind.ok) throw new Error("expected a view-kind refusal");
    expect(wrongKind.error).toMatchObject({ issues: [{ path: ["view"] }] });
    const mismatched = projectAnalysisView(parent(report(), "d".repeat(64)), {
      kind: "summary",
    });
    if (mismatched.ok) throw new Error("expected a subject refusal");
    expect(mismatched.error).toMatchObject({
      issues: [{ path: ["source", "subject"] }],
    });
  });
});
