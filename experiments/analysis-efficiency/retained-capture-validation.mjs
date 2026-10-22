/** Public stdio MCP capture paging; keep original recordings and transcripts outside Git. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, mkdtemp } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { finished } from "node:stream/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createRetainedQueryCaller } from "./retained-query-calls.mjs";
import { finalizeRetainedQueryReceipt } from "./retained-query-finalization.mjs";

const { values } = parseArgs({
  options: Object.fromEntries(
    ["runtime", "capture", "output", "bundle"].map((name) => [
      name,
      { type: "string" },
    ]),
  ),
});
for (const name of ["runtime", "capture", "output"])
  assert.ok(
    values[name] && values[name] === resolve(values[name]),
    `${name} must be absolute`,
  );
const hash = (value) => createHash("sha256").update(value).digest("hex");
const output = values.output;
await mkdir(output, { mode: 0o700 });
const recording = await readFile(values.capture);
const raw = JSON.parse(recording);
const events = raw.traces.flatMap((trace, t) =>
  trace.events.map((reported, e) => ({
    reported,
    pointer: `/traces/${t}/events/${e}`,
  })),
);
assert.ok(events.length >= 6);
const home = await mkdtemp(join(tmpdir(), "rea-capture-validation-"));
const client = new Client({
  name: "retained-capture-validation",
  version: "1",
});
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(values.runtime, "scripts/rea.mjs"), "mcp"],
  env: {
    HOME: home,
    PATH: process.env.PATH,
    NODE_OPTIONS: "--max-old-space-size=2048",
    REA_LOG_LEVEL: "silent",
  },
  stderr: "pipe",
});
const serverLog = createWriteStream(join(output, "server.log"));
const serverLogFinished = finished(serverLog);
serverLogFinished.catch(() => {});
transport.stderr?.pipe(serverLog);
const report = {
  capture_sha256: hash(recording),
  capture_bytes: recording.length,
  events: events.length,
  mode: values.bundle ? "imported" : "producer",
  calls: [],
};
const transcript = [];
const call = createRetainedQueryCaller(client, (receipt, event) => {
  report.calls.push(receipt);
  transcript.push(event);
});
const result = async (name, args, phase) => {
  const response = await call(name, args, phase);
  assert.notEqual(response.isError, true, JSON.stringify(response));
  assert.ok(response.structuredContent);
  return response.structuredContent;
};
const started = performance.now();
try {
  await client.connect(transport);
  const discovery = performance.now();
  const catalog = await client.listTools();
  assert.equal(
    catalog.nextCursor,
    undefined,
    "This driver requires a complete catalog page",
  );
  report.catalog = {
    elapsed_ms: performance.now() - discovery,
    sha256: hash(JSON.stringify(catalog)),
    bytes: Buffer.byteLength(JSON.stringify(catalog)),
  };
  await writeFile(join(output, "catalog.json"), JSON.stringify(catalog));
  // Compile the exact live named contract for each call, avoiding client-wide compilation.
  const definitions = new Map(catalog.tools.map((tool) => [tool.name, tool]));
  const originalCallTool = client.callTool.bind(client);
  client.callTool = (input, options) =>
    originalCallTool(input, {
      ...options,
      toolDefinition: definitions.get(input.name),
    });
  let original;
  if (values.bundle) {
    const bundle = JSON.parse(await readFile(values.bundle, "utf8"));
    original = bundle.records.find(
      (record) => record.operation === "inspect_web_network_capture",
    );
    assert.ok(original);
    await result("import_evidence_bundle", { path: values.bundle }, "import");
  } else {
    const evidence = await result(
      "inspect_web_network_capture",
      {
        capture_path: values.capture,
        format: "qlog",
        detail: "summary",
      },
      "produce-summary",
    );
    report.summary_id = evidence.evidence_id;
    const path = join(output, "original.json");
    await result("export_evidence_bundle", { path }, "export-original");
    const bundle = JSON.parse(await readFile(path, "utf8"));
    original = bundle.records.find(
      (record) => record.operation === "inspect_web_network_capture",
    );
    assert.ok(original);
  }
  assert.equal(
    original.normalized_result.artifact.sha256,
    report.capture_sha256,
  );
  assert.equal(original.normalized_result.total_records, events.length);
  const source = {
    kind: "retained-evidence",
    evidence_id: original.evidence_id,
  };
  report.source_id = original.evidence_id;
  const answers = [];
  for (let pass = 0; pass < 3; pass += 1) {
    const summary = await result(
      "inspect_analysis_view",
      { source, view: { kind: "summary" } },
      `summary-${pass}`,
    );
    assert.equal(
      summary.normalized_result.summary.total_records,
      events.length,
    );
    answers.push(summary);
    for (const offset of [0, 2, 4]) {
      const evidence = await result(
        "inspect_analysis_view",
        {
          source,
          view: { kind: "capture", detail: "complete", offset, limit: 2 },
        },
        `page-${pass}-${offset}`,
      );
      const view = evidence.normalized_result;
      assert.equal(view.parent_evidence_id, original.evidence_id);
      assert.equal(view.coverage.total, events.length);
      assert.equal(view.coverage.next_offset, offset + 2);
      assert.equal(
        view.items.length,
        2,
        "Every selected record must be returned",
      );
      for (const [i, row] of view.items.entries()) {
        assert.equal(row.ordinal, offset + i);
        assert.equal(row.location.pointer, events[offset + i].pointer);
        const expected = structuredClone(events[offset + i].reported);
        // QUIC reset tokens are transport authentication material, not reported facts.
        const resetToken = Object.hasOwn(
          expected.data ?? {},
          "stateless_reset_token",
        );
        if (resetToken) expected.data.stateless_reset_token = null;
        assert.deepEqual(
          row.redactions,
          resetToken
            ? [
                {
                  pointer: "/data/stateless_reset_token",
                  reason: "transport-credential",
                },
              ]
            : [],
        );
        assert.deepEqual(row.reported, expected);
      }
      answers.push(evidence);
    }
    const traces = await result(
      "inspect_analysis_view",
      {
        source,
        view: { kind: "qlog", facet: "traces", offset: 0, limit: 50 },
      },
      `traces-${pass}`,
    );
    assert.equal(traces.normalized_result.page.items.length, raw.traces.length);
    for (const [i, row] of traces.normalized_result.page.items.entries()) {
      assert.equal(row.trace_index, i);
      assert.equal(row.event_count, raw.traces[i].events.length);
    }
    answers.push(traces);
  }
  const roundtrip = join(output, "roundtrip.json");
  await result(
    "export_evidence_bundle",
    { path: roundtrip },
    "export-roundtrip",
  );
  const exported = JSON.parse(await readFile(roundtrip, "utf8"));
  assert.deepEqual(
    exported.records.find(
      (record) => record.evidence_id === original.evidence_id,
    ),
    original,
  );
  assert.equal(hash(await readFile(values.capture)), report.capture_sha256);
  report.answers_sha256 = hash(JSON.stringify(answers));
  report.original_record_sha256 = hash(JSON.stringify(original));
  report.status = "passed";
} catch (cause) {
  report.status = "failed";
  report.failure = String(cause?.stack ?? cause);
  process.exitCode = 1;
} finally {
  report.elapsed_before_cleanup_ms = performance.now() - started;
  try {
    await writeFile(
      join(output, "transcript.json"),
      JSON.stringify(transcript),
    );
  } catch (cause) {
    report.status = "failed";
    report.transcript_failure = String(cause);
  }
  const finalized = await finalizeRetainedQueryReceipt({
    report,
    client,
    transport,
    account: home,
    serverLog,
    serverLogFinished,
    output,
  });
  if (report.status !== "passed" || !finalized) process.exitCode = 1;
}
