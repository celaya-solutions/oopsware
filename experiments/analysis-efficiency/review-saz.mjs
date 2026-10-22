import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import {
  sazRequest,
  verifySazRecords,
  verifySazOracleIdentity,
  sazEvidenceParameters,
} from "./saz-entry.mjs";

const { values } = parseArgs({
  options: {
    trial: { type: "string" },
    oracle: { type: "string" },
    "runtime-root": { type: "string" },
    artifact: { type: "string" },
    selection: { type: "string" },
  },
});
if (
  !values.trial ||
  !values.oracle ||
  !values["runtime-root"] ||
  !["baseline", "focused"].includes(values.selection)
)
  throw new Error(
    "Use --trial DIR --oracle JSON --runtime-root DIR --artifact ID --selection baseline|focused",
  );
const load = async (file) =>
  JSON.parse(await readFile(resolve(values.trial, file), "utf8"));
const settings = await load("trial-settings.json"),
  summary = await load("summary.json");
const oracle = JSON.parse(await readFile(values.oracle, "utf8"));
verifySazOracleIdentity(values.artifact, oracle);
const runtime = (file) =>
  pathToFileURL(resolve(values["runtime-root"], file)).href;
const { parseEvidence } = await import(runtime("dist/domain/evidence.js"));
const { inspectWebNetworkCaptureInputSchema, webNetworkCaptureSchema } =
  await import(runtime("dist/domain/webNetworkCapture.js"));
const { inspectAnalysisViewInputSchema, analysisViewResultSchema } =
  await import(runtime("dist/domain/analysisView/analysisView.js"));
const calls = (await readFile(resolve(values.trial, "events.jsonl"), "utf8"))
  .split("\n")
  .filter(Boolean)
  .map(JSON.parse)
  .filter(
    (event) =>
      event.type === "item.completed" && event.item?.type === "mcp_tool_call",
  )
  .map((event) => event.item);
const planned = inspectWebNetworkCaptureInputSchema.parse(
  sazRequest(
    values.artifact,
    settings.selected_artifact_path,
    values.selection,
  ),
);
const reasons = [],
  workflowReasons = [],
  authenticated = new Map(),
  parents = new Set(),
  conflicts = new Set();
let transportRecovery = false;
for (const call of calls) {
  try {
    assert.equal(call.server, "rea");
    assert.equal(call.status, "completed");
    assert.ok(!call.error, "RPC did not provide observations");
    const text = call.result.content.filter((item) => item.type === "text");
    assert.equal(text.length, 1, "Ambiguous Evidence text carrier");
    let evidence = JSON.parse(text[0].text);
    if (call.result.isError) {
      const limits = evidence.error?.details?.reported_limits;
      assert.equal(call.tool, "inspect_web_network_capture");
      assert.equal(evidence.error?.code, "resource_constraint");
      assert.equal(
        evidence.error.details.operation,
        "inspect_web_network_capture",
      );
      assert.equal(limits?.boundary, "mcp-response");
      const input = inspectWebNetworkCaptureInputSchema.parse(call.arguments);
      assert.deepEqual(input, planned);
      const source = inspectAnalysisViewInputSchema.parse({
        source: limits.evidence_reference,
        view: { kind: "summary" },
      }).source;
      assert.equal(source.kind, "retained-evidence");
      parents.add(source.evidence_id);
      transportRecovery = true;
      continue;
    }
    if (call.result.structuredContent !== undefined)
      assert.deepEqual(evidence, call.result.structuredContent);
    evidence = parseEvidence(evidence);
    assert.equal(evidence.subject.local_path, settings.selected_artifact_path);
    assert.equal(evidence.subject.digest.sha256, oracle.sha256);
    let records;
    if (call.tool === "inspect_web_network_capture") {
      const { detail, ...arguments_ } = call.arguments;
      const input = inspectWebNetworkCaptureInputSchema.parse(arguments_);
      assert.equal(input.capture_path, settings.selected_artifact_path);
      assert.equal(input.format, "saz");
      if (!isDeepStrictEqual(input, planned))
        workflowReasons.push(
          "Inspection selection differs from planned arguments",
        );
      if (detail === "summary") {
        workflowReasons.push(
          "Summary delivery differs from the fixed complete-delivery plan",
        );
        assert.equal(evidence.operation, "inspect_analysis_view");
        const report = analysisViewResultSchema.parse(
          evidence.normalized_result,
        );
        assert.equal(report.kind, "summary");
        assert.equal(report.parent_operation, "inspect_web_network_capture");
        assert.equal(report.summary.format, "saz");
        assert.equal(report.summary.total_records, oracle.total_records);
        assert.deepEqual(evidence.parameters, {
          parent_evidence_id: report.parent_evidence_id,
          view: { kind: "summary" },
        });
        parents.add(report.parent_evidence_id);
        authenticated.set(evidence.evidence_id, []);
        continue;
      }
      assert.ok(detail === undefined || detail === "complete");
      assert.equal(evidence.operation, "inspect_web_network_capture");
      assert.deepEqual(
        evidence.parameters,
        sazEvidenceParameters(input, oracle.total_records),
      );
      const report = webNetworkCaptureSchema.parse(evidence.normalized_result);
      assert.equal(report.total_records, oracle.total_records);
      assert.equal(report.format, "saz");
      records = report.records;
      parents.add(evidence.evidence_id);
    } else {
      assert.equal(call.tool, "inspect_analysis_view");
      const input = inspectAnalysisViewInputSchema.parse(call.arguments);
      assert.equal(input.source.kind, "retained-evidence");
      assert.ok(
        parents.has(input.source.evidence_id),
        "Unknown retained parent",
      );
      assert.equal(evidence.operation, "inspect_analysis_view");
      assert.deepEqual(evidence.parameters, {
        parent_evidence_id: input.source.evidence_id,
        view: input.view,
      });
      const page = analysisViewResultSchema.parse(evidence.normalized_result);
      assert.deepEqual(page.view, input.view);
      assert.equal(page.parent_evidence_id, input.source.evidence_id);
      assert.equal(page.parent_operation, "inspect_web_network_capture");
      if (page.kind === "summary") {
        assert.equal(page.summary.total_records, oracle.total_records);
        assert.equal(page.summary.format, "saz");
        records = [];
      } else {
        assert.equal(page.kind, "capture");
        records = page.view.detail === "complete" ? page.items : [];
      }
    }
    const prior = authenticated.get(evidence.evidence_id);
    if (prior && !isDeepStrictEqual(prior, records)) {
      conflicts.add(evidence.evidence_id);
      authenticated.delete(evidence.evidence_id);
      parents.delete(evidence.evidence_id);
      throw new Error("Conflicting observations share an Evidence ID");
    }
    if (!conflicts.has(evidence.evidence_id))
      authenticated.set(evidence.evidence_id, records);
  } catch (cause) {
    workflowReasons.push(String(cause));
  }
}
if (
  calls[0]?.tool !== "inspect_web_network_capture" ||
  calls.filter((call) => call.tool === "inspect_web_network_capture").length !==
    1 ||
  (!transportRecovery && calls.length !== 1)
)
  workflowReasons.push(
    "Completed call sequence differs from the fixed initial call/recovery plan",
  );
try {
  const raw = (await readFile(resolve(values.trial, "answer.txt"), "utf8"))
    .trim()
    .replace(/^```(?:json)?\s*|\s*```$/g, "");
  const answer = JSON.parse(raw);
  assert.ok(
    Array.isArray(answer.evidence_ids) && answer.evidence_ids.length > 0,
    "Missing Evidence citations",
  );
  const observed = new Map();
  for (const id of answer.evidence_ids) {
    assert.ok(authenticated.has(id), "Unknown/failed cited Evidence");
    for (const row of authenticated.get(id)) {
      const prior = observed.get(row.ordinal);
      assert.ok(
        !prior || isDeepStrictEqual(prior, row),
        "Conflicting cited record identities",
      );
      observed.set(row.ordinal, row);
    }
  }
  const facts = verifySazRecords(
    oracle.record_ordinals.map((ordinal) => observed.get(ordinal)),
    oracle,
  );
  assert.equal(answer.records.length, facts.length, "Answer coverage differs");
  assert.deepEqual(
    [...answer.records].sort((a, b) => a.ordinal - b.ordinal),
    [...facts].sort((a, b) => a.ordinal - b.ordinal),
    "Answer facts differ from cited stored bytes",
  );
  if (
    !isDeepStrictEqual(
      answer.records.map((row) => row.ordinal),
      oracle.record_ordinals,
    )
  )
    workflowReasons.push("Final answer changes caller-selected order");
  if (
    !Array.isArray(answer.limitations) ||
    answer.limitations.length === 0 ||
    answer.limitations.some(
      (value) => typeof value !== "string" || !value.trim(),
    )
  )
    workflowReasons.push("Final answer omits limitations");
  assert.equal(settings.selected_artifact_sha256_before, oracle.sha256);
  assert.equal(summary.selected_artifact_sha256_after, oracle.sha256);
  if (
    summary.exit_code !== 0 ||
    summary.timeout ||
    summary.selected_artifact_bytes_unchanged !== true
  )
    workflowReasons.push(
      "Trial did not complete with original bytes unchanged",
    );
} catch (cause) {
  reasons.push(String(cause));
}
const report = {
  factual_correctness: reasons.length ? "failed" : "passed",
  workflow_correctness:
    reasons.length || workflowReasons.length ? "failed" : "passed",
  reasons,
  workflow_reasons: workflowReasons,
  completed_calls: calls.length,
  wall_seconds: summary.wall_seconds,
  usage: summary.usage,
  selected_artifact_sha256: oracle.sha256,
  scope:
    "Authenticated cited stored HTTP records and independent raw-byte checks; no live attribution, body decompression or certificate interpretation",
  limitation_prose: "Presence checked; wording requires transcript review",
};
await writeFile(
  resolve(values.trial, "saz-review.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report));
if (report.workflow_correctness !== "passed") process.exitCode = 1;
