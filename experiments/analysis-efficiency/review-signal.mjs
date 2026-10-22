import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import {
  SIGNAL_ARTIFACTS,
  signalRequest,
  signalDataRows,
  signalFacts,
  verifySignalRows,
  verifySignalOracleIdentity,
} from "./signal-entry.mjs";

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
  !Object.hasOwn(SIGNAL_ARTIFACTS, values.artifact ?? "") ||
  !["baseline", "focused"].includes(values.selection)
)
  throw new Error(
    "Use --trial DIR --oracle JSON --runtime-root DIR --artifact ID --selection baseline|focused",
  );
const json = async (name) =>
  JSON.parse(await readFile(resolve(values.trial, name), "utf8"));
const settings = await json("trial-settings.json"),
  summary = await json("summary.json");
const oracle = JSON.parse(await readFile(values.oracle, "utf8"));
const kind = SIGNAL_ARTIFACTS[values.artifact].kind;
const expectedRows =
  kind === "uart"
    ? oracle.rows
    : oracle.reads.flatMap((read) => read.bytes.slice(1));
const expected = signalFacts(kind, expectedRows);
const runtime = (file) =>
  pathToFileURL(resolve(values["runtime-root"], file)).href;
const { parseEvidence } = await import(runtime("dist/domain/evidence.js"));
const { decodeSignalRecordingInputSchema, signalRecordingSchema } =
  await import(runtime("dist/domain/signals/signalRecording.js"));
const { inspectSignalDecodersInputSchema, signalDecodersSchema } = await import(
  runtime("dist/domain/signals/signalDecoders.js")
);
const calls = (await readFile(resolve(values.trial, "events.jsonl"), "utf8"))
  .split("\n")
  .filter(Boolean)
  .map(JSON.parse)
  .filter(
    (event) =>
      event.type === "item.completed" && event.item?.type === "mcp_tool_call",
  )
  .map((event) => event.item);
const reasons = [],
  workflowReasons = [],
  authenticated = new Map(),
  conflicting = new Set();
try {
  verifySignalOracleIdentity(values.artifact, oracle);
  if (oracle.kind !== kind)
    throw new Error("Wrong independent signal question oracle");
  if (calls.length !== 1 || calls[0]?.tool !== "decode_signal_recording")
    workflowReasons.push(
      "Completed public call sequence differs from the fixed single-call plan",
    );
  const planned = decodeSignalRecordingInputSchema.parse(
    signalRequest(
      values.artifact,
      settings.selected_artifact_path,
      values.selection,
    ),
  );
  for (const call of calls) {
    try {
      if (
        call.server !== "rea" ||
        call.status !== "completed" ||
        call.error ||
        call.result?.isError
      )
        throw new Error("Call did not return successful REA observations");
      const text =
        call.result?.content?.filter((item) => item.type === "text") ?? [];
      if (!call.result?.structuredContent && text.length !== 1)
        throw new Error("No unambiguous Evidence envelope");
      const evidence =
        call.result.structuredContent ?? JSON.parse(text[0].text);
      parseEvidence(evidence);
      const capture = call.tool === "decode_signal_recording";
      if (!capture && call.tool !== "inspect_signal_decoders")
        throw new Error("Not a signal observation tool");
      const input = (
        capture
          ? decodeSignalRecordingInputSchema
          : inspectSignalDecodersInputSchema
      ).parse(call.arguments);
      const report = (
        capture ? signalRecordingSchema : signalDecodersSchema
      ).parse(evidence.normalized_result);
      if (
        evidence.operation !== call.tool ||
        !isDeepStrictEqual(evidence.parameters, input) ||
        !isDeepStrictEqual(report.selection, input)
      )
        throw new Error(
          "Evidence differs from actual operation or caller choices",
        );
      if (
        capture
          ? evidence.subject?.local_path !== input.path ||
            evidence.subject?.digest?.sha256 !== oracle.sha256 ||
            report.artifact.path !== input.path ||
            report.artifact.sha256 !== oracle.sha256
          : evidence.subject?.local_path !== report.tool.path ||
            evidence.subject?.digest?.sha256 !== report.tool.sha256
      )
        throw new Error("Evidence identifies different recording/tool bytes");
      if (capture && !isDeepStrictEqual(input, planned))
        workflowReasons.push("Capture selection differs from the fixed plan");
      const observation = {
        operation: call.tool,
        input,
        report,
        rows: capture ? signalDataRows(kind, report.annotations_text) : null,
      };
      const id = evidence.evidence_id;
      if (conflicting.has(id))
        throw new Error("Previously conflicting Evidence identity");
      if (
        authenticated.has(id) &&
        !isDeepStrictEqual(authenticated.get(id), observation)
      ) {
        authenticated.delete(id);
        conflicting.add(id);
        throw new Error(
          "Repeated Evidence identity has inconsistent observations",
        );
      }
      authenticated.set(id, observation);
    } catch (error) {
      workflowReasons.push(
        `Call ${call.tool} did not provide authenticated observations: ${String(error)}`,
      );
    }
  }
  const answer = JSON.parse(
    (await readFile(resolve(values.trial, "answer.txt"), "utf8")).trim(),
  );
  if (
    !isDeepStrictEqual(
      Object.keys(answer).sort(),
      [...Object.keys(expected), "evidence_ids", "limitations"].sort(),
    )
  )
    workflowReasons.push("Final answer shape differs from the fixed plan");
  if (
    !isDeepStrictEqual(
      Object.fromEntries(
        Object.keys(expected).map((key) => [key, answer[key]]),
      ),
      expected,
    )
  )
    throw new Error("Final answer differs from independent sample facts");
  if (
    !Array.isArray(answer.evidence_ids) ||
    new Set(answer.evidence_ids).size !== answer.evidence_ids.length ||
    answer.evidence_ids.some((id) => !authenticated.has(id))
  )
    throw new Error(
      "Final citations are not authenticated signal observations",
    );
  const rows = new Map();
  for (const id of answer.evidence_ids) {
    for (const row of authenticated.get(id).rows ?? []) {
      const old = rows.get(row.start);
      if (old && !isDeepStrictEqual(old, row))
        throw new Error("Cited sample ranges have conflicting decoded data");
      rows.set(row.start, row);
    }
  }
  verifySignalRows(
    kind,
    [...rows.values()].sort((a, b) => a.start - b.start),
    oracle,
    oracle.sha256,
  );
  const limitations =
    typeof answer.limitations === "string"
      ? [answer.limitations]
      : answer.limitations;
  if (
    !Array.isArray(limitations) ||
    limitations.length === 0 ||
    limitations.some((value) => typeof value !== "string" || !value.trim())
  )
    workflowReasons.push("Final answer omits investigation limitations");
  if (
    summary.exit_code !== 0 ||
    summary.timeout ||
    summary.selected_artifact_bytes_unchanged !== true ||
    settings.selected_artifact_sha256_before !== oracle.sha256 ||
    summary.selected_artifact_sha256_after !== oracle.sha256
  )
    workflowReasons.push(
      "Trial did not complete with original selected bytes unchanged",
    );
} catch (error) {
  reasons.push(String(error));
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
    "Two pinned single-device recordings; independently sampled bytes and authenticated cited decoder observations; hardware behavior is not inferred",
  limitation_prose: "Presence checked; wording requires transcript review",
};
await writeFile(
  resolve(values.trial, "signal-review.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report));
if (reasons.length || workflowReasons.length) process.exitCode = 1;
