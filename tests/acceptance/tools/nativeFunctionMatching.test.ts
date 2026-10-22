import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { cliTest, type TestCli } from "../../support/cli/cliFixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import {
  nativeMatchingInventory,
  nativeMatchingDetails,
} from "../../fixtures/nativeFunctionMatching.js";
import { createEvidence, parseEvidence } from "../../../src/domain/evidence.js";
import { nativeMatchingProvider } from "../../fixtures/nativeFunctionMatching.js";
import {
  createEvidenceBundle,
  parseEvidenceBundle,
} from "../../../src/domain/evidenceBundle.js";
import { nativeFunctionMatchingSchema } from "../../../src/domain/native/functionMatching.js";

const createMatchingFixture = async () => {
  const root = await createTestTempDirectory("rea-native-matching-");
  const ancestor = createEvidence(undefined, nativeMatchingProvider, {
    operation: "fixture_provenance",
    parameters: {},
    result: { source: "Synthetic ancestor" },
  });
  const unrelated = createEvidence(undefined, nativeMatchingProvider, {
    operation: "fixture_unrelated",
    parameters: {},
    result: { source: "Unselected synthetic record" },
  });
  const dependency = createEvidence(undefined, nativeMatchingProvider, {
    operation: "fixture_dependency",
    parameters: {},
    result: { source: "Synthetic dependency" },
    evidenceLinks: [ancestor.evidence_id],
  });
  const left = nativeMatchingInventory(
    "1",
    [
      { address: "0x10", value: "main" },
      { address: "0x20", value: "old_name" },
    ],
    [dependency.evidence_id],
  );
  const right = nativeMatchingInventory("2", [
    { address: "0x30", value: "main" },
    { address: "0x40", value: "new_name" },
  ]);
  const leftDetails = [
    ...nativeMatchingDetails("1", "0x10", "9000", true),
    ...nativeMatchingDetails("1", "0x20", "c3", true),
  ];
  const rightDetails = [
    ...nativeMatchingDetails("2", "0x30", "9001", true),
    ...nativeMatchingDetails("2", "0x40", "c3", true),
  ];
  const ancestorsPath = join(root, "ancestors.json");
  await writeFile(
    ancestorsPath,
    JSON.stringify(createEvidenceBundle([ancestor, unrelated])),
  );
  const importedPath = join(root, "dependencies.json");
  await writeFile(
    importedPath,
    JSON.stringify(createEvidenceBundle([ancestor, dependency])),
  );
  return {
    root,
    ancestor,
    dependency,
    unrelated,
    left,
    right,
    leftDetails,
    rightDetails,
    ancestorsPath,
    importedPath,
  };
};
const verifyPortableCli = async (
  cli: TestCli,
  fixture: Awaited<ReturnType<typeof createMatchingFixture>>,
  input: Record<string, unknown>,
  evidenceId: string,
) => {
  const {
    root,
    ancestor,
    dependency,
    unrelated,
    left,
    right,
    leftDetails,
    rightDetails,
    ancestorsPath,
  } = fixture;
  const bundlePath = join(root, "sources.json"),
    inputPath = join(root, "request.json"),
    outputPath = join(root, "result.json");
  await writeFile(
    bundlePath,
    JSON.stringify(
      createEvidenceBundle([
        left,
        right,
        ...leftDetails,
        ...rightDetails,
        dependency,
      ]),
    ),
  );
  const original = await readFile(bundlePath);
  await writeFile(inputPath, JSON.stringify({ ...input, detail: "complete" }));
  const cliFull = await cli.run({
    arguments: [
      "match-native-functions",
      inputPath,
      "--source_bundle",
      ancestorsPath,
      "--source_bundle",
      bundlePath,
      "--json",
    ],
  });
  expect(cliFull.exitCode, cliFull.stderr).toBe(0);
  expect(parseEvidence(cliFull.json).evidence_id).toBe(evidenceId);
  await writeFile(inputPath, JSON.stringify(input));
  const cliSummary = await cli.run({
    arguments: [
      "match-native-functions",
      inputPath,
      "--source_bundle",
      ancestorsPath,
      "--source_bundle",
      bundlePath,
      "--evidence_output",
      outputPath,
      "--json",
    ],
  });
  expect(cliSummary.exitCode, cliSummary.stderr).toBe(0);
  expect(cliSummary.json).toMatchObject({
    summary: {
      normalized_result: { parent_evidence_id: evidenceId },
    },
    evidence_bundle: { path: outputPath },
  });
  const bundle = parseEvidenceBundle(
    JSON.parse(await readFile(outputPath, "utf8")),
  );
  const ids = new Set(bundle.records.map((x) => x.evidence_id));
  for (const record of bundle.records)
    for (const id of record.evidence_links)
      expect(
        ids.has(id),
        `Missing dependency ${id} of ${record.evidence_id}`,
      ).toBe(true);
  expect(ids.has(ancestor.evidence_id)).toBe(true);
  expect(ids.has(dependency.evidence_id)).toBe(true);
  expect(ids.has(unrelated.evidence_id)).toBe(false);
  expect(ids.has(evidenceId)).toBe(true);
  expect(await readFile(bundlePath)).toEqual(original);
  const incomplete = await cli.run({
    arguments: [
      "match-native-functions",
      inputPath,
      "--source_bundle",
      bundlePath,
      "--evidence_output",
      join(root, "incomplete.json"),
      "--json",
    ],
  });
  expect(incomplete.json).toMatchObject({
    code: "evidence_integrity_mismatch",
  });
};

cliTest(
  "shared public CLI/MCP matching retains sources, pages exact facts, and feeds selected dossier pairs directly to compare_functions",
  async ({ cli }) => {
    const fixture = await createMatchingFixture();
    const { left, right, leftDetails, rightDetails, importedPath } = fixture;
    const { call } = await connectLocalToolsMcp();
    const imported = await call("import_evidence_bundle", {
      path: importedPath,
    });
    expect(imported.isError, JSON.stringify(imported)).not.toBe(true);
    const full = await call("match_native_functions", {
      left,
      right,
      left_observations: leftDetails,
      right_observations: rightDetails,
      detail: "complete",
    });
    expect(full.isError, JSON.stringify(full)).not.toBe(true);
    const evidence = parseEvidence(full.structuredContent),
      report = nativeFunctionMatchingSchema.parse(evidence.normalized_result);
    expect(report.summary).toEqual({
      matched: 2,
      only_left: 0,
      only_right: 0,
      unresolved: 0,
    });
    const reference = (evidence_id: string) => ({
      kind: "retained-evidence",
      evidence_id,
    });
    const input = {
      left: reference(left.evidence_id),
      right: reference(right.evidence_id),
      left_observations: leftDetails.map((x) => reference(x.evidence_id)),
      right_observations: rightDetails.map((x) => reference(x.evidence_id)),
    };
    const summary = await call("match_native_functions", input);
    expect(summary.isError, JSON.stringify(summary)).not.toBe(true);
    expect(
      parseEvidence(summary.structuredContent).normalized_result,
    ).toMatchObject({
      kind: "summary",
      artifact: null,
      parent_evidence_id: evidence.evidence_id,
      summary: { summary: report.summary },
    });
    expect(parseEvidence(summary.structuredContent).locations).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "artifact-path" }),
      ]),
    );
    const page = await call("inspect_analysis_view", {
      source: reference(evidence.evidence_id),
      view: {
        kind: "function-matches",
        collection: "functions",
        sides: ["left"],
        fields: ["name", "body_sha256"],
        offset: 1,
        limit: 1,
      },
    });
    expect(page.isError, JSON.stringify(page)).not.toBe(true);
    expect(
      parseEvidence(page.structuredContent).normalized_result,
    ).toMatchObject({
      artifact: null,
      coverage: { total: 2, next_offset: null },
      items: [
        {
          name: "old_name",
          function_id: `${left.evidence_id}/1`,
          address: "0x20",
        },
      ],
    });
    expect(parseEvidence(page.structuredContent).locations).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "artifact-path" }),
      ]),
    );
    const compared = await call(
      "compare_functions",
      report.matches[0]!.compare_functions_input!,
    );
    expect(compared.isError, JSON.stringify(compared)).not.toBe(true);
    expect(parseEvidence(compared.structuredContent).operation).toBe(
      "compare_functions",
    );
    await verifyPortableCli(cli, fixture, input, evidence.evidence_id);
    const missing = await call("match_native_functions", {
      left: reference(`ev_${"a".repeat(64)}`),
      right: reference(right.evidence_id),
    });
    expect(missing.isError).toBe(true);
  },
  60000,
);
