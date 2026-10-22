import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import {
  parseRuntimeReconciliationInput,
  reconcileJavaScriptRuntime,
} from "../../../../src/domain/javascript/javascriptRuntimeReconciliation.js";
import { reconcileRuntimeEntities } from "../../../../src/domain/javascript/javascriptRuntimeReconciliationMatching.js";
import { classifyStaticLoadStates } from "../../../../src/domain/javascript/javascriptRuntimeLoadState.js";
import { projectRuntimeCaptures } from "../../../../src/domain/javascript/javascriptRuntimeReconciliationRuntime.js";
import { reconcileJavaScriptRuntimeInputSchema } from "../../../../src/domain/javascript/javascriptRuntimeReconciliationSchemas.js";
import { collectStaticRuntimeCandidates } from "../../../../src/domain/javascript/javascriptRuntimeStaticCandidates.js";
import {
  SOURCE,
  analyzeFixture,
  applicationFixture,
  electronRuntimeEvidence,
} from "../../../fixtures/javascriptRuntimeReconciliation.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

const CAPTURED = "export const observed = 'different';\n";

const collisionInput = async (
  alternatives: number,
  explicitMapping: boolean,
) => {
  const root = await applicationFixture();
  if (alternatives > 0) await writeFile(join(root, "other.js"), CAPTURED);
  const live = explicitMapping
    ? await createTestTempDirectory("rea-runtime-content-live-")
    : root;
  const extra = await createTestTempDirectory("rea-runtime-content-extra-");
  await writeFile(join(extra, "app.js"), CAPTURED);
  return parseRuntimeReconciliationInput(
    reconcileJavaScriptRuntimeInputSchema.parse({
      static_layers: [
        {
          role: "application",
          analysis: await analyzeFixture(root),
          runtime_mappings: explicitMapping
            ? [{ kind: "file-root", root: live, artifact_prefix: "" }]
            : [],
        },
        ...(alternatives > 1
          ? [{ role: "assets", analysis: await analyzeFixture(extra) }]
          : []),
      ],
      runtime_observations: [
        electronRuntimeEvidence(live, CAPTURED, { includeWorker: false }),
      ],
    }),
  );
};

it.each([
  [0, false],
  [1, false],
  [2, false],
  [0, true],
  [1, true],
  [2, true],
] as const)(
  "preserves mapped disagreement with %i other content matches (explicit mapping: %s)",
  async (alternatives, explicitMapping) => {
    const parsed = await collisionInput(alternatives, explicitMapping);
    const result = reconcileJavaScriptRuntime(parsed);
    const script = result.reconciliations.find(
      ({ entity_kind }) => entity_kind === "script",
    );
    expect(script).toMatchObject({
      status: "unmatched",
      basis: explicitMapping ? "operator-file-mapping" : "artifact-path",
      confidence: "high",
      reason: "captured-content-disagrees-with-static-location",
      static_layer_id: null,
      static_node_id: null,
      candidate_static_count: 1,
    });
    const candidate = script?.candidate_static_nodes[0];
    const selected = result.graph.nodes.find(
      ({ node_id }) => node_id === candidate?.static_node_id,
    );
    expect(selected?.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          properties: expect.objectContaining({ path: "app.js" }),
        }),
      ]),
    );
    expect(
      result.graph.edges.some(
        (edge) =>
          edge.relation === "observed_as" &&
          edge.target_node_id === script?.runtime_node_id,
      ),
    ).toBe(false);
  },
);

it("restricts content-and-location ambiguity to mapped candidates", async () => {
  const application = await applicationFixture();
  const cache = await applicationFixture();
  const other = await applicationFixture();
  const live = await createTestTempDirectory("rea-runtime-content-mapped-");
  const analysis = await analyzeFixture(application);
  const mapping = [{ kind: "file-root", root: live, artifact_prefix: "" }];
  const parsed = parseRuntimeReconciliationInput(
    reconcileJavaScriptRuntimeInputSchema.parse({
      static_layers: [
        { role: "application", analysis, runtime_mappings: mapping },
        {
          role: "cache",
          analysis: await analyzeFixture(cache),
          runtime_mappings: mapping,
        },
        { role: "assets", analysis: await analyzeFixture(other) },
      ],
      runtime_observations: [
        electronRuntimeEvidence(live, SOURCE, { includeWorker: false }),
      ],
    }),
  );
  const result = reconcileJavaScriptRuntime(parsed);
  const script = result.reconciliations.find(
    ({ entity_kind }) => entity_kind === "script",
  );
  expect(script).toMatchObject({
    status: "ambiguous",
    reason: "ambiguous-static-candidates",
    candidate_static_count: 2,
  });
  const unmapped = result.static_layers.find(({ role }) => role === "assets");
  expect(
    script?.candidate_static_nodes.map(
      ({ static_layer_id }) => static_layer_id,
    ),
  ).not.toContain(unmapped?.layer_id);
});

it.each([false, true])(
  "retains digest-only matching without a mapped candidate (mapping: %s)",
  async (mapped) => {
    const root = await applicationFixture();
    await writeFile(join(root, "other.js"), CAPTURED);
    const live = await createTestTempDirectory(
      "rea-runtime-content-unlocated-",
    );
    const result = reconcileJavaScriptRuntime(
      parseRuntimeReconciliationInput(
        reconcileJavaScriptRuntimeInputSchema.parse({
          static_layers: [
            {
              role: "application",
              analysis: await analyzeFixture(root),
              runtime_mappings: mapped
                ? [{ kind: "file-root", root: live, artifact_prefix: "" }]
                : [],
            },
          ],
          runtime_observations: [
            electronRuntimeEvidence(live, CAPTURED, {
              scriptFile: "absent.js",
              includeWorker: false,
            }),
          ],
        }),
      ),
    );
    expect(
      result.reconciliations.find(
        ({ entity_kind }) => entity_kind === "script",
      ),
    ).toMatchObject({
      status: "matched",
      basis: "content-sha256",
      confidence: "high",
      reason: "unique-content-match",
      candidate_static_count: 1,
    });
  },
);

it("keeps unavailable mapped digests unknown instead of borrowing unrelated matches", async () => {
  const parsed = await collisionInput(1, true);
  const candidates = collectStaticRuntimeCandidates(parsed.layers).map(
    (candidate) =>
      candidate.paths.includes("app.js") && candidate.category === "javascript"
        ? { ...candidate, digests: [] }
        : candidate,
  );
  // Model the matcher's supported missing-digest boundary; do not falsify Evidence.
  const runtime = projectRuntimeCaptures(parsed.captures);
  const result = reconcileRuntimeEntities({
    entities: runtime.entities,
    candidates,
    layers: parsed.layers,
  });
  expect(
    result.items.find(({ entity_kind }) => entity_kind === "script"),
  ).toMatchObject({
    status: "unknown",
    basis: "operator-file-mapping",
    confidence: "unknown",
    reason: "static-or-runtime-coverage-incomplete",
    candidate_static_count: 1,
  });
  const script = result.items.find(
    ({ entity_kind }) => entity_kind === "script",
  );
  const candidate = script?.candidate_static_nodes[0];
  const states = classifyStaticLoadStates(
    parsed.layers,
    runtime.entities,
    result.items,
    {
      reconciliationComplete: true,
    },
  );
  expect(
    states.states.find(
      (state) =>
        state.static_layer_id === candidate?.static_layer_id &&
        state.static_node_id === candidate?.static_node_id,
    ),
  ).toMatchObject({
    status: "unknown",
    reason: "static-or-runtime-coverage-incomplete",
  });
});
