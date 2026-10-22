#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import canonicalize from "canonicalize";

const [baselinePath, candidatePath, recordPath] = process.argv.slice(2);
assert.ok(baselinePath && candidatePath && recordPath);
const record = JSON.parse(await readFile(recordPath, "utf8"));
const fingerprinted = record.trials.at(-1);
const digest = (value) =>
  createHash("sha256").update(canonicalize(value)).digest("hex");
const readSemantic = async (path, label) => {
  const evidence = JSON.parse(await readFile(path, "utf8"));
  const analysis = evidence.normalized_result;
  assert.equal(analysis.root_artifact_sha256, record.input.asar_sha256);
  const semantic = analysis.semantic_graph;
  assert.equal(semantic.application_graph_id, analysis.graph.graph_id);
  const rawSha = digest(semantic);
  assert.equal(
    rawSha,
    fingerprinted[label].profile.analysis_fingerprints.semantic_graph_sha256,
  );
  const { application_graph_id, graph_id, ...content } = semantic;
  return { content, rawSha, application_graph_id, graph_id };
};

// Read sequentially; retain semantic content rather than complete parent graphs.
const before = await readSemantic(baselinePath, "baseline");
const after = await readSemantic(candidatePath, "candidate");
assert.ok(
  isDeepStrictEqual(before.content, after.content),
  "Semantic content differs after excluding only the two parent commitments",
);
console.log(
  JSON.stringify({
    excluded_top_level_fields: ["application_graph_id", "graph_id"],
    content_deep_equal: true,
    baseline_raw_sha256: before.rawSha,
    candidate_raw_sha256: after.rawSha,
    baseline_content_sha256: digest(before.content),
    candidate_content_sha256: digest(after.content),
    baseline_application_graph_id: before.application_graph_id,
    candidate_application_graph_id: after.application_graph_id,
    baseline_graph_id: before.graph_id,
    candidate_graph_id: after.graph_id,
    compared_fields: Object.keys(before.content).sort(),
    serialization:
      "RFC 8785 canonical JSON; arrays and all remaining fields retained",
  }),
);
