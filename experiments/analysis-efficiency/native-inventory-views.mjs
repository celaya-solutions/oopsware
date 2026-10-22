/** Compare complete delivery with selected native inventory views on real Ghidra. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { finished } from "node:stream/promises";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createRetainedQueryCaller } from "./retained-query-calls.mjs";
import { finalizeRetainedQueryReceipt } from "./retained-query-finalization.mjs";

const { values } = parseArgs({
  options: {
    ...Object.fromEntries(
      ["runtime", "target", "output", "ghidra", "java", "mode", "control"].map(
        (name) => [name, { type: "string" }],
      ),
    ),
    "verify-pages": { type: "boolean", default: false },
  },
});
for (const name of ["runtime", "target", "output", "ghidra", "java"])
  assert.ok(values[name] && values[name] === resolve(values[name]), name);
assert.ok(["complete", "summary"].includes(values.mode));
assert.ok(!values["verify-pages"] || values.mode === "summary");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const output = values.output;
await mkdir(output, { mode: 0o700 });
const targetBytes = await readFile(values.target);
const home = await mkdtemp(join(tmpdir(), "rea-native-inventory-"));
const client = new Client({ name: "native-inventory-views", version: "1" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(values.runtime, "scripts/rea.mjs"), "mcp"],
  env: {
    HOME: home,
    PATH: process.env.PATH,
    NODE_OPTIONS: "--max-old-space-size=2048",
    GHIDRA_INSTALL_DIR: values.ghidra,
    JAVA_HOME: values.java,
    GHIDRA_HEADLESS_MAXMEM: "768M",
    JAVA_TOOL_OPTIONS: "-XX:ActiveProcessorCount=1",
    REA_GHIDRA_STARTUP_TIMEOUT_MS: "600000",
    REA_LOG_LEVEL: "silent",
  },
  stderr: "pipe",
});
const serverLog = createWriteStream(join(output, "server.log"));
const serverLogFinished = finished(serverLog);
serverLogFinished.catch(() => {});
transport.stderr?.pipe(serverLog);
const report = {
  artifact: {
    path: values.target,
    bytes: targetBytes.length,
    sha256: hash(targetBytes),
  },
  mode: values.mode,
  verify_pages: values["verify-pages"],
  question:
    "Report retained row counts and the first four address/value pairs for procedures, names, strings, and literal main procedure/string matches.",
  calls: [],
  tasks: [],
  local_recoveries: [],
};
const transcript = [];
const call = createRetainedQueryCaller(client, (receipt, event) => {
  report.calls.push(receipt);
  transcript.push(event);
});
const result = async (name, input, phase) => {
  const reply = await call(name, input, phase ?? name);
  assert.notEqual(reply.isError, true, JSON.stringify(reply));
  assert.ok(reply.structuredContent);
  return reply.structuredContent;
};
const operations = [
  "list_procedures",
  "list_names",
  "list_strings",
  "search_procedures",
  "search_strings",
];
const selectedRows = (rows) =>
  rows.slice(0, 4).map(({ address, value }) => ({ address, value }));
const sourceReferences = [];
const started = performance.now();
let opened = false;
try {
  await client.connect(transport);
  const discovery = performance.now();
  const catalog = await client.listTools();
  assert.equal(catalog.nextCursor, undefined);
  report.catalog = {
    elapsed_ms: performance.now() - discovery,
    tool_count: catalog.tools.length,
    bytes: Buffer.byteLength(JSON.stringify(catalog)),
    sha256: hash(JSON.stringify(catalog)),
  };
  await writeFile(join(output, "catalog.json"), JSON.stringify(catalog));
  const definitions = new Map(catalog.tools.map((tool) => [tool.name, tool]));
  const original = client.callTool.bind(client);
  client.callTool = (input, options) =>
    original(input, {
      ...options,
      timeout: 600000,
      toolDefinition: definitions.get(input.name),
    });
  await result("open_binary", { path: values.target, provider_id: "ghidra" });
  opened = true;
  for (const phase of ["first", "warm"]) {
    const taskStarted = performance.now();
    const facts = [];
    for (const operation of operations) {
      const parameters = operation.startsWith("search_")
        ? { pattern: "main", mode: "literal", case_sensitive: false }
        : {};
      const input =
        values.mode === "summary"
          ? { ...parameters, detail: "summary" }
          : parameters;
      const reply = await call(operation, input, `${phase}:${operation}`);
      let evidence;
      if (reply.isError) {
        const text = reply.content.find((item) => item.type === "text");
        assert.ok(text);
        const error = JSON.parse(text.text).error;
        assert.equal(values.mode, "complete");
        assert.equal(error.code, "resource_constraint");
        const reference = error.details?.reported_limits?.evidence_reference;
        assert.equal(error.details?.reported_limits?.boundary, "mcp-response");
        assert.equal(reference?.kind, "retained-evidence");
        const recovery = { phase: `${phase}:${operation}`, status: "started" };
        report.local_recoveries.push(recovery);
        const path = join(
          output,
          `recovery-${report.local_recoveries.length}.json`,
        );
        await result(
          "export_evidence_bundle",
          { path },
          `${phase}:${operation}:recovery-export`,
        );
        const recoveryStarted = performance.now();
        try {
          const bytes = await readFile(path);
          const bundle = JSON.parse(bytes);
          evidence = bundle.records.find(
            (record) => record.evidence_id === reference.evidence_id,
          );
          assert.ok(evidence);
          assert.equal(evidence.operation, operation);
          assert.ok(Array.isArray(evidence.normalized_result));
          // This is local JSON field selection after the documented export recovery,
          // not another provider query or an MCP view available in the baseline.
          const projection = {
            evidence_id: evidence.evidence_id,
            operation,
            row_count: evidence.normalized_result.length,
            rows: selectedRows(evidence.normalized_result),
            provider: evidence.provider,
            parameters: evidence.parameters,
            limitations: evidence.limitations,
          };
          recovery.bundle_bytes_read = bytes.length;
          recovery.projection_bytes = Buffer.byteLength(
            JSON.stringify(projection),
          );
          recovery.status = "passed";
          transcript.push({
            name: "local-bundle-projection",
            phase: recovery.phase,
            input: {
              path,
              evidence_id: reference.evidence_id,
              offset: 0,
              limit: 4,
              fields: ["address", "value"],
            },
            projection,
          });
        } finally {
          recovery.elapsed_ms = performance.now() - recoveryStarted;
        }
      } else evidence = reply.structuredContent;
      assert.ok(evidence);
      assert.equal(evidence.subject.digest.sha256, report.artifact.sha256);
      let count, rows, provider, query, parent;
      if (values.mode === "complete") {
        assert.equal(evidence.operation, operation);
        assert.equal(evidence.provider.id, "ghidra");
        assert.ok(Array.isArray(evidence.normalized_result));
        count = evidence.normalized_result.length;
        rows = selectedRows(evidence.normalized_result);
        provider = evidence.provider;
        query = evidence.parameters;
        parent = evidence.evidence_id;
      } else {
        assert.equal(evidence.operation, "inspect_analysis_view");
        const summary = evidence.normalized_result;
        assert.equal(summary.kind, "summary");
        assert.equal(summary.parent_operation, operation);
        assert.equal(summary.summary.discovery_coverage, "unknown");
        assert.equal(summary.source_provider.id, "ghidra");
        count = summary.summary.row_count;
        provider = summary.source_provider;
        query = summary.source_parameters;
        parent = summary.parent_evidence_id;
        assert.deepEqual(evidence.evidence_links, [parent]);
        rows = [];
        if (count > 0) {
          const pageEvidence = await result(
            "inspect_analysis_view",
            {
              source: { kind: "retained-evidence", evidence_id: parent },
              view: {
                kind: "native-inventory",
                offset: 0,
                limit: 4,
                fields: ["value"],
              },
            },
            `${phase}:${operation}:page`,
          );
          const page = pageEvidence.normalized_result;
          assert.equal(page.kind, "native-inventory");
          assert.equal(page.parent_evidence_id, parent);
          assert.equal(page.coverage.total, count);
          assert.equal(page.rows.length, Math.min(4, count));
          for (const [index, row] of page.rows.entries())
            assert.equal(row.source_index, index);
          rows = page.rows.map(({ record: { address, value } }) => ({
            address,
            value,
          }));
        }
      }
      assert.ok(Number.isSafeInteger(count) && count >= 0);
      if (operation.startsWith("list_")) assert.ok(count > 0, operation);
      assert.equal(provider.version, "12.1.4");
      assert.equal(Object.hasOwn(query, "detail"), false);
      assert.equal(rows.length, Math.min(4, count));
      facts.push({
        operation,
        row_count: count,
        rows,
        provider,
        parameters: query,
        limitations: [...new Set(evidence.limitations)].sort(),
      });
      sourceReferences.push({ phase, operation, parent });
    }
    report.tasks.push({
      phase,
      elapsed_ms: performance.now() - taskStarted,
      facts,
    });
  }
  assert.deepEqual(report.tasks[0].facts, report.tasks[1].facts);
  const taskFacts = report.tasks.map(({ phase, facts }) => ({ phase, facts }));
  await writeFile(join(output, "facts.json"), JSON.stringify(taskFacts));
  report.facts_sha256 = hash(JSON.stringify(taskFacts));
  const bundlePath = join(output, "evidence.json");
  await result("export_evidence_bundle", { path: bundlePath });
  const bundle = JSON.parse(await readFile(bundlePath, "utf8"));
  const sources = sourceReferences.map(({ phase, operation, parent }) => {
    const record = bundle.records.find(
      (record) => record.evidence_id === parent,
    );
    assert.ok(record);
    assert.equal(record.operation, operation);
    assert.equal(record.subject.digest.sha256, report.artifact.sha256);
    const task = report.tasks
      .find((task) => task.phase === phase)
      .facts.find((fact) => fact.operation === operation);
    assert.equal(record.normalized_result.length, task.row_count);
    assert.deepEqual(selectedRows(record.normalized_result), task.rows);
    assert.deepEqual(record.parameters, task.parameters);
    assert.deepEqual(record.provider, task.provider);
    return { phase, operation, record };
  });
  await writeFile(join(output, "sources.json"), JSON.stringify(sources));
  report.sources_sha256 = hash(JSON.stringify(sources));
  if (values.control) {
    assert.deepEqual(
      taskFacts,
      JSON.parse(await readFile(join(values.control, "facts.json"), "utf8")),
    );
    const control = JSON.parse(
      await readFile(join(values.control, "sources.json"), "utf8"),
    );
    // Assertion formatting of a large mismatch can itself exhaust the experiment
    // scope. Retain both files and report a bounded failure without weakening it.
    assert.ok(
      isDeepStrictEqual(sources, control),
      `Full source Evidence differs from control; inspect retained sources.json files (${report.sources_sha256} vs ${hash(JSON.stringify(control))}).`,
    );
  }
  if (values["verify-pages"]) {
    for (const { operation, parent } of sourceReferences.filter(
      (source) => source.phase === "first",
    )) {
      const source = sources.find(
        (source) => source.phase === "first" && source.operation === operation,
      ).record;
      const all = [];
      let offset = 0;
      do {
        const evidence = await result(
          "inspect_analysis_view",
          {
            source: { kind: "retained-evidence", evidence_id: parent },
            view: { kind: "native-inventory", offset, limit: 128 },
          },
          `verification:${operation}:${offset}`,
        );
        const page = evidence.normalized_result;
        assert.equal(page.kind, "native-inventory");
        assert.equal(
          page.rows.length,
          Math.min(128, source.normalized_result.length - offset),
        );
        for (const [index, row] of page.rows.entries())
          assert.equal(row.source_index, offset + index);
        all.push(...page.rows.map((row) => row.record));
        assert.equal(
          page.coverage.next_offset,
          offset + page.rows.length >= source.normalized_result.length
            ? null
            : offset + page.rows.length,
        );
        offset = page.coverage.next_offset;
      } while (offset !== null);
      assert.deepEqual(all, source.normalized_result);
    }
  }
  assert.equal(hash(await readFile(values.target)), report.artifact.sha256);
  report.status = "passed";
} catch (cause) {
  report.status = "failed";
  report.failure = String(cause?.stack ?? cause);
  process.exitCode = 1;
} finally {
  if (opened)
    try {
      await result("close_binary", {});
    } catch (cause) {
      report.status = "failed";
      report.close_failure = String(cause?.stack ?? cause);
    }
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
