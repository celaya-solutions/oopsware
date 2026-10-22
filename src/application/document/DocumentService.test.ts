import { describe, expect, it } from "vitest";

import { DocumentService } from "./DocumentService.js";
import { STRUCTURED_TEXT_PROVIDER } from "../InvestigationProviders.js";
import type { StructuredTextDocument } from "../../domain/document/structuredText.js";
import { ok } from "../../domain/result.js";

const reading = (
  overrides: Partial<StructuredTextDocument> = {},
): StructuredTextDocument => ({
  artifact: { path: "/docs/a.txt", sha256: "a".repeat(64), bytes: 4 },
  format: {
    profile: "plain-text",
    basis: "name-hint",
    extension: ".txt",
    name_hint: null,
  },
  encoding: {
    name: "utf-8",
    basis: "default",
    declared: null,
    bom_bytes: 0,
    undecodable: [],
    undecodable_count: 0,
    nul_characters: 0,
    newlines: { lf: 0, crlf: 0, cr: 0 },
    lines: 1,
    final_newline: false,
  },
  parse: { status: "parsed", parser: "line reader", records: 1 },
  diagnostics: [],
  diagnostics_omitted: 0,
  node_count: 1,
  page: { start: 0, limit: 500, returned: 1, next: null },
  nodes: [
    {
      index: 0,
      depth: 0,
      kind: "line",
      path: "line 1",
      name: null,
      value: "text",
      value_length: null,
      fields: null,
      record: 1,
      location: { line: 1, column: 1, offset: 0 },
      end_offset: 4,
      details: { newline: null },
    },
  ],
  coverage: [],
  limitations: [],
  ...overrides,
});

const service = (value: StructuredTextDocument) =>
  new DocumentService({
    identity: STRUCTURED_TEXT_PROVIDER,
    read: () => Promise.resolve(ok(value)),
  });

describe("DocumentService", () => {
  it("returns observed Evidence bound to the document digest", async () => {
    const result = await service(reading()).inspect({ path: "/docs/a.txt" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.confidence).toBe("observed");
    expect(result.value.subject?.digest.sha256).toBe("a".repeat(64));
    expect(result.value.parameters).toEqual({
      path: "/docs/a.txt",
      start: 0,
      limit: 500,
      max_file_bytes: 64 * 1024 ** 2,
    });
  });

  it("rejects readings that change identity or break page and offset invariants", async () => {
    for (const bad of [
      reading({
        artifact: { path: "/other.txt", sha256: "a".repeat(64), bytes: 4 },
      }),
      reading({ page: { start: 0, limit: 500, returned: 1, next: 1 } }),
      reading({ node_count: 5 }),
      reading({
        artifact: { path: "/docs/a.txt", sha256: "a".repeat(64), bytes: 2 },
      }),
    ]) {
      const result = await service(bad).inspect({ path: "/docs/a.txt" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error._tag).toBe("AnalysisOutputError");
    }
  });

  it("rejects relative paths, misplaced delimiters and cancelled calls before reading", async () => {
    for (const input of [
      { path: "a.txt" },
      { path: "/a.json", format: "json", delimiter: ";" },
      { path: "/a.csv", delimiter: "\n" },
    ]) {
      const result = await service(reading()).inspect(input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error._tag).toBe("AnalysisInputError");
    }
    const controller = new AbortController();
    controller.abort();
    const cancelled = await service(reading()).inspect(
      { path: "/docs/a.txt" },
      { signal: controller.signal },
    );
    expect(!cancelled.ok && cancelled.error._tag).toBe(
      "AnalysisCancelledError",
    );
  });
});
