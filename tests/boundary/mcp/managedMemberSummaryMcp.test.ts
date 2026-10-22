import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it, onTestFinished } from "vitest";
import { composeBinarySession } from "../../../src/application/binary/BinarySessionComposition.js";
import { AnalysisProviderRegistry } from "../../../src/application/binary/AnalysisProviderRegistry.js";
import { inspectAnalysisView } from "../../../src/application/analysisView/AnalysisViewService.js";
import { ManagedStaticProvider } from "../../../src/dotnet/ManagedStaticProvider.js";
import { buildManagedPeFixture } from "../../../src/dotnet/ManagedPe.fixture.js";
import { createEvidence, parseEvidence } from "../../../src/domain/evidence.js";
import {
  analysisViewResultSchema,
  managedMemberSummaryViewResultSchema,
} from "../../../src/domain/analysisView/analysisView.js";
import { managedMemberInspectionSchema } from "../../../src/domain/managed/managedArtifact.js";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const COLLECTIONS = [
  "types",
  "exported_types",
  "fields",
  "methods",
  "member_refs",
  "call_edges",
  "field_accesses",
  "user_strings",
] as const;

const createHarness = async () => {
  const session = composeBinarySession(new AnalysisProviderRegistry([]), [
    new ManagedStaticProvider(),
  ]);
  const harness = await createApplicationMcpHarness({ session });
  onTestFinished(harness.close);
  return harness;
};

it("summarizes selected members and pages every original collection after the file disappears", async () => {
  const directory = await createTestTempDirectory("rea-member-summary-");
  const path = join(directory, "fixture.dll");
  await writeFile(
    path,
    buildManagedPeFixture({
      methodRowCount: 2,
      // ldarg.0; ldfld field; call member ref; ldstr "ok"; pop; ret
      ilBody: Buffer.from([
        (18 << 2) | 2,
        0x02,
        0x7b,
        1,
        0,
        0,
        0x04,
        0x28,
        1,
        0,
        0,
        0x0a,
        0x72,
        1,
        0,
        0,
        0x70,
        0x26,
        0x2a,
      ]),
      userStringHeap: Buffer.from([0, 5, 0x6f, 0, 0x6b, 0, 0]),
      exportedTypes: [
        {
          namespace: "System",
          name: "Object",
          flags: 0x0020_0001,
          implementationRaw: (1 << 2) | 1,
        },
      ],
    }),
  );
  const { client, session } = await createHarness();
  const definition = (await client.listTools()).tools.find(
    (x) => x.name === "inspect_managed_members",
  );
  if (definition?.outputSchema === undefined)
    throw new Error("Managed member schemas are absent");
  const outputSchema: Record<string, unknown> = definition.outputSchema;
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  expect(ajv.validateSchema(definition.inputSchema)).toBe(true);
  expect(ajv.validateSchema(outputSchema)).toBe(true);
  const type_names = ["Fixture.Program", "Missing.Type"];
  expect(
    ajv.validate(definition.inputSchema, {
      path,
      type_names,
      detail: "summary",
    }),
  ).toBe(true);
  const reply = await client.callTool({
    name: "inspect_managed_members",
    arguments: { path, type_names, detail: "summary" },
  });
  expect(reply.isError).not.toBe(true);
  expect(
    ajv.validate(outputSchema, reply.structuredContent),
    JSON.stringify(ajv.errors),
  ).toBe(true);
  const receipt = parseEvidence(reply.structuredContent);
  const view = managedMemberSummaryViewResultSchema.parse(
    receipt.normalized_result,
  );
  const parent = session.evidenceById(view.parent_evidence_id);
  if (parent === undefined)
    throw new Error("Complete member source was not retained");
  expect(parent.operation).toBe("inspect_managed_members");
  expect(parent.parameters).toEqual({ path, type_names });
  expect(receipt.evidence_links).toEqual([parent.evidence_id]);
  const report = managedMemberInspectionSchema.parse(parent.normalized_result);
  expect(view.summary.selection).toEqual({
    type_names,
    unmatched_type_names: ["Missing.Type"],
  });
  expect(view.summary.coverage).toEqual(report.coverage);
  expect(view.summary.signature_resolution).toBe("type-names-v1");
  expect(view.summary.identity_scope).toEqual(report.identity_scope);
  expect(view.summary).not.toHaveProperty("methods");
  for (const detail of [undefined, "complete"]) {
    const complete = parseEvidence(
      (
        await client.callTool({
          name: "inspect_managed_members",
          arguments: { path, type_names, ...(detail ? { detail } : {}) },
        })
      ).structuredContent,
    );
    expect(complete.operation).toBe("inspect_managed_members");
    expect(complete.evidence_id).toBe(parent.evidence_id);
  }
  const original = JSON.stringify(parent);
  await unlink(path);
  for (const collection of COLLECTIONS) {
    const rows =
      collection === "user_strings"
        ? report.user_strings?.literals
        : report[collection];
    if (rows == null) throw new Error(`${collection} was not examined`);
    // Empty collections would compare equal even if a row schema dropped facts.
    expect(rows.length, collection).toBeGreaterThan(0);
    expect(view.summary.reported_counts[collection]).toBe(rows.length);
    const paged: unknown[] = [];
    for (let offset: number | null = 0; offset !== null;) {
      const result = await client.callTool({
        name: "inspect_analysis_view",
        arguments: {
          source: {
            kind: "retained-evidence",
            evidence_id: parent.evidence_id,
          },
          view: { kind: "managed-members", collection, offset, limit: 1 },
        },
      });
      expect(result.isError).not.toBe(true);
      const page = analysisViewResultSchema.parse(
        parseEvidence(result.structuredContent).normalized_result,
      );
      if (page.kind !== "managed-members")
        throw new Error("Unexpected page kind");
      expect(page.page.collection).toBe(collection);
      expect(page.signature_resolution).toBe("type-names-v1");
      expect(page.selection).toEqual(report.selection);
      expect(page.coverage.total).toBe(rows.length);
      paged.push(...page.page.rows);
      offset = page.coverage.next_offset;
    }
    // Method rows carry body facts that a looser row schema would strip.
    expect(paged).toEqual(rows);
  }
  expect(JSON.stringify(session.evidenceById(parent.evidence_id))).toBe(
    original,
  );
  const portable = inspectAnalysisView({
    source: { kind: "inline", evidence: parent },
    view: { kind: "summary" },
  });
  if (!portable.ok) throw portable.error;
  expect(portable.value.normalized_result).toEqual(view);
}, 30000);

it("keeps collections that historical member Evidence never examined unknown", async () => {
  const directory = await createTestTempDirectory("rea-member-historical-");
  const path = join(directory, "fixture.dll");
  await writeFile(path, buildManagedPeFixture());
  const { client } = await createHarness();
  const parent = parseEvidence(
    (
      await client.callTool({
        name: "inspect_managed_members",
        arguments: { path },
      })
    ).structuredContent,
  );
  const {
    exported_types: _exported,
    user_strings: _strings,
    selection: _selection,
    signature_resolution: _resolution,
    ...recorded
  } = managedMemberInspectionSchema.parse(parent.normalized_result);
  const historical = createEvidence(undefined, parent.provider, {
    operation: parent.operation,
    parameters: parent.parameters,
    result: recorded,
    limitations: parent.limitations,
    authority: parent.authority,
  });
  const summary = inspectAnalysisView({
    source: { kind: "inline", evidence: historical },
    view: { kind: "summary" },
  });
  if (!summary.ok) throw summary.error;
  const view = managedMemberSummaryViewResultSchema.parse(
    summary.value.normalized_result,
  );
  expect(view.summary.reported_counts.exported_types).toBeNull();
  expect(view.summary.signature_resolution).toBeNull();
  expect(view.summary.reported_counts.user_strings).toBeNull();
  expect(view.summary.user_strings).toBeNull();
  expect(view.summary.selection).toBeNull();
  expect(view.unknowns.join(" ")).toContain("no recorded subject");
  for (const collection of ["exported_types", "user_strings"] as const)
    expect(
      inspectAnalysisView({
        source: { kind: "inline", evidence: historical },
        view: { kind: "managed-members", collection, offset: 0, limit: 1 },
      }),
    ).toMatchObject({ ok: false, error: { _tag: "AnalysisInputError" } });
  expect(
    inspectAnalysisView({
      source: { kind: "inline", evidence: historical },
      view: { kind: "managed", collection: "attributes", offset: 0, limit: 1 },
    }),
  ).toMatchObject({ ok: false, error: { _tag: "AnalysisInputError" } });
}, 30000);
