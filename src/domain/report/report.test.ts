import { describe, expect, it } from "vitest";
import { createEvidence } from "../evidence.js";
import type { JsonValue } from "../jsonValue.js";
import {
  APPENDIX_RUN_BYTES,
  ReportBuilder,
  capBytes,
  type ReportHeader,
} from "./reportHtml.js";
import { collectLimits } from "./reportLimits.js";
import type { ReportRun, ReportRunRecord } from "./reportRun.js";

const SHA = "b".repeat(64);
const EVIL = `<script>alert(1)</script>"'&\u202e`;

const header = (over: Partial<ReportHeader> = {}): ReportHeader => ({
  title: "Calculator study",
  description: "",
  generatedAt: "2026-10-21T12:00:00.000Z",
  version: "9.9.9",
  format: "html",
  includeAppendix: true,
  leftOut: 0,
  ...over,
});

const evidence = (result: JsonValue, limitations: string[] = []) =>
  createEvidence(
    { path: "/tmp/Calculator", sha256: SHA, format: "mach-o" },
    { id: "hopper", name: "Hopper", version: "6.0.0" },
    {
      operation: "inspect",
      parameters: {},
      result,
      limitations,
    },
  ) as unknown as JsonValue;

const record = (
  over: Partial<ReportRunRecord> & { structured?: JsonValue } = {},
): ReportRunRecord => {
  const { structured, ...rest } = over;
  return {
    id: "00000000-0000-4000-8000-000000000001",
    tool: "inspect_artifact",
    arguments: { path: "/tmp/Calculator" },
    status: "completed",
    createdAt: "2026-10-21T10:00:00.000Z",
    startedAt: "2026-10-21T10:00:00.000Z",
    completedAt: "2026-10-21T10:00:02.500Z",
    result: {
      content: [],
      structuredContent: structured ?? evidence({ ok: true }),
    },
    ...rest,
  };
};

const run = (
  rec: ReportRunRecord | null,
  over: Partial<ReportRun> = {},
): ReportRun => ({
  workspace_id: "3d1f6a2c-7b8e-4c5d-9e0f-112233445566",
  run_id: rec?.id ?? "00000000-0000-4000-8000-000000000009",
  tool: rec?.tool ?? "inspect_artifact",
  status: rec?.status ?? "missing",
  record: rec,
  archivePath: "/home/me/.config/rea/web/workspaces/w/runs/r.json",
  problem: null,
  ...over,
});

const build = (
  runs: ReportRun[],
  over: Partial<ReportHeader> = {},
  unselected: ReportRun[] = [],
) => {
  const builder = new ReportBuilder(
    header(over),
    [],
    { notes: [], bookmarks: [], renames: [] },
    (tool) => (tool === "inspect_artifact" ? "Inspect artifact" : null),
  );
  for (const item of runs) builder.addRun(item);
  for (const item of unselected) builder.addUnselected(item);
  return builder.html();
};

const limitsSection = (html: string) =>
  html.slice(html.indexOf('id="limits"'), html.indexOf("Appendix: stored"));

describe("report HTML", () => {
  it("is self-contained and escapes hostile values everywhere", () => {
    const html = build(
      [
        run(
          record({
            tool: EVIL,
            arguments: { name: EVIL },
            structured: evidence({ label: EVIL }, [EVIL]),
          }),
        ),
      ],
      { title: EVIL, description: EVIL },
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("\u202e");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain(
      `content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"`,
    );
    expect(html).not.toMatch(/<(script|link|iframe|img)\b/i);
    expect(html).not.toMatch(/\b(src|href)="(?!#)/);
  });

  it("shows an empty project honestly", () => {
    const html = build([]);
    expect(html).toContain("No runs were picked.");
    expect(html).toContain("No files are recorded.");
    expect(html).toContain("That is not proof there are none.");
  });

  it("lists failed, cancelled and missing runs as limits", () => {
    const failed = record({
      status: "failed",
      error: "Hopper is not running",
      result: undefined,
    });
    const html = build([run(failed), run(null)], {}, [
      run(record({ id: "00000000-0000-4000-8000-000000000003" }), {
        status: "cancelled",
        record: null,
      }),
      run(record({ id: "00000000-0000-4000-8000-000000000004" }), {
        status: "completed",
        record: null,
      }),
    ]);
    const limits = limitsSection(html);
    expect(limits).toContain("The run failed.");
    expect(limits).toContain("The run record is missing");
    expect(limits).toContain("The run cancelled.");
    expect(html).toContain("Hopper is not running");
    // A completed run left out by choice is not a limit.
    expect(limits).not.toContain("000000000004");
  });

  it("collects envelope limits by schema and nested ones by field name", () => {
    const html = build([
      run(
        record({
          structured: evidence(
            {
              functions: 3,
              parts: [{ unknowns: ["entry point"] }],
              symbol_coverage: { complete: false },
              warnings: [],
            },
            ["Stripped binary."],
          ),
        }),
      ),
    ]);
    const limits = limitsSection(html);
    expect(limits).toContain("Stripped binary.");
    expect(limits).toContain("Evidence envelope");
    expect(limits).toContain("$.normalized_result.parts[0].unknowns");
    expect(limits).toContain("$.normalized_result.symbol_coverage");
    expect(limits).toContain("collected by field name");
    // Empty fields name no limit.
    expect(limits).not.toContain(".warnings");
    // Headline facts are the normalized scalars, not envelope fields.
    const findings = html.slice(
      html.indexOf("Headline facts"),
      html.indexOf('id="limits"'),
    );
    expect(findings).toContain("<code>functions</code>");
    expect(findings).not.toContain("<code>evidence_id</code>");
  });

  it("caps each appendix entry and names the full record", () => {
    const big = "x".repeat(APPENDIX_RUN_BYTES + 1000);
    const html = build([run(record({ structured: evidence({ big }) }))]);
    expect(html).toMatch(/[\d,]+ bytes left out here/);
    expect(html).toContain("/home/me/.config/rea/web/workspaces/w/runs/r.json");
    expect(html.length).toBeLessThan(APPENDIX_RUN_BYTES + 200_000);
  });

  it("leaves the appendix out of a PDF unless asked, and says so", () => {
    const without = build([run(record())], {
      format: "pdf",
      includeAppendix: false,
    });
    expect(without).toContain("This PDF leaves out the JSON appendix.");
    expect(without).not.toContain("<details>");
    const withIt = build([run(record())], {
      format: "pdf",
      includeAppendix: true,
    });
    expect(withIt).toContain("<details>");
  });

  it("embeds the graph picture with its caption", () => {
    const html = build([
      run(
        record({
          tool: "analyze_javascript_application",
          structured: evidence({
            graph: {
              schema: "JavaScriptApplicationGraph",
              root_node_ids: ["jag_node_a"],
              nodes: [
                {
                  node_id: "jag_node_a",
                  kind: "artifact",
                  identity: {},
                  observations: [],
                },
              ],
              edges: [],
              coverage: null,
              limitations: [],
            },
          }),
        }),
      ),
    ]);
    expect(html).toContain("<svg");
    expect(html).toContain("A missing edge is not proof");
  });
});

describe("limit sweep", () => {
  it("stops on a budget and says so", () => {
    const wide = Array.from({ length: 210_000 }, (_, i) => i);
    expect(collectLimits({ wide }).stoppedAfter).toBe(200_000);
  });

  it("cuts on a byte budget", () => {
    expect(capBytes("h\u00e9llo", 2)).toEqual({ text: "h\ufffd", omitted: 4 });
  });
});
