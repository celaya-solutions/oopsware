/** Verify real pre-summary source Evidence through retained MCP and provider-free CLI views. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { finished } from "node:stream/promises";
import { parseArgs, promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/server";
import { createRetainedQueryCaller } from "./retained-query-calls.mjs";
import { finalizeRetainedQueryReceipt } from "./retained-query-finalization.mjs";

const { values } = parseArgs({
  options: Object.fromEntries(
    ["runtime", "source", "output"].map((name) => [name, { type: "string" }]),
  ),
});
for (const name of ["runtime", "source", "output"])
  assert.ok(values[name] && values[name] === resolve(values[name]), name);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const originalBytes = await readFile(join(values.source, "evidence.json"));
const original = JSON.parse(originalBytes);
const sources = JSON.parse(
  await readFile(join(values.source, "sources.json"), "utf8"),
).filter((source) => source.phase === "first");
assert.equal(sources.length, 5);
await mkdir(values.output, { mode: 0o700 });
const home = await mkdtemp(join(tmpdir(), "rea-portable-native-inventory-"));
const environment = {
  HOME: home,
  PATH: process.env.PATH,
  NODE_OPTIONS: "--max-old-space-size=2048",
  REA_LOG_LEVEL: "silent",
};
const client = new Client({ name: "portable-native-inventory", version: "1" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(values.runtime, "scripts/rea.mjs"), "mcp"],
  env: environment,
  stderr: "pipe",
});
const serverLog = createWriteStream(join(values.output, "server.log"));
const serverLogFinished = finished(serverLog);
serverLogFinished.catch(() => {});
transport.stderr?.pipe(serverLog);
const report = {
  source_bundle_sha256: hash(originalBytes),
  calls: [],
  cli: [],
  rows: {},
};
const transcript = [];
const call = createRetainedQueryCaller(client, (receipt, event) => {
  report.calls.push(receipt);
  transcript.push(event);
});
const result = async (name, input, phase = name) => {
  const reply = await call(name, input, phase);
  assert.notEqual(reply.isError, true, JSON.stringify(reply));
  assert.ok(reply.structuredContent);
  return reply.structuredContent;
};
const started = performance.now();
try {
  await client.connect(transport);
  const catalog = await client.listTools();
  assert.equal(catalog.nextCursor, undefined);
  report.catalog = {
    tool_count: catalog.tools.length,
    bytes: Buffer.byteLength(JSON.stringify(catalog)),
    sha256: hash(JSON.stringify(catalog)),
  };
  const definitions = new Map(catalog.tools.map((tool) => [tool.name, tool]));
  const originalCall = client.callTool.bind(client);
  client.callTool = (input, options) =>
    originalCall(input, {
      ...options,
      toolDefinition: definitions.get(input.name),
    });
  await result("import_evidence_bundle", {
    path: join(values.source, "evidence.json"),
  });
  for (const { operation, record } of sources) {
    assert.deepEqual(
      original.records.find(
        (source) => source.evidence_id === record.evidence_id,
      ),
      record,
    );
    const sourcePath = join(values.output, `${operation}.json`);
    const sourceBytes = Buffer.from(JSON.stringify(record));
    await writeFile(sourcePath, sourceBytes);
    const source = {
      kind: "retained-evidence",
      evidence_id: record.evidence_id,
    };
    const pageView = {
      kind: "native-inventory",
      offset: 0,
      limit: 4,
      fields: ["value"],
    };
    const expected = await result(
      "inspect_analysis_view",
      { source, view: pageView },
      `${operation}:selected`,
    );
    for (const view of [{ kind: "summary" }, pageView]) {
      const inputPath = join(
        values.output,
        `${operation}-${view.kind}.input.json`,
      );
      await writeFile(
        inputPath,
        JSON.stringify({
          source: { kind: "evidence-file", path: sourcePath },
          view,
        }),
      );
      const cliStarted = performance.now();
      const { stdout, stderr } = await promisify(execFile)(
        process.execPath,
        [
          join(values.runtime, "scripts/rea.mjs"),
          "inspect-analysis-view",
          inputPath,
          "--json",
        ],
        {
          env: environment,
          encoding: "utf8",
          timeout: 60000,
          maxBuffer: STDIO_DEFAULT_MAX_BUFFER_SIZE,
        },
      );
      const cliElapsed = performance.now() - cliStarted;
      const actual = JSON.parse(stdout);
      const mcp =
        view.kind === "summary"
          ? await result(
              "inspect_analysis_view",
              { source, view },
              `${operation}:summary`,
            )
          : expected;
      assert.deepEqual(actual, mcp);
      report.cli.push({
        operation,
        view: view.kind,
        elapsed_ms: cliElapsed,
        stdout_bytes: Buffer.byteLength(stdout),
        stderr_bytes: Buffer.byteLength(stderr),
        evidence_id: actual.evidence_id,
      });
    }
    const all = [];
    let offset = 0;
    do {
      const evidence = await result(
        "inspect_analysis_view",
        { source, view: { kind: "native-inventory", offset, limit: 128 } },
        `${operation}:page:${offset}`,
      );
      const page = evidence.normalized_result;
      assert.equal(page.kind, "native-inventory");
      const expectedRows = Math.min(
        128,
        record.normalized_result.length - offset,
      );
      assert.equal(page.rows.length, expectedRows);
      assert.equal(page.coverage.total, record.normalized_result.length);
      for (const [index, row] of page.rows.entries())
        assert.equal(row.source_index, offset + index);
      all.push(...page.rows.map((row) => row.record));
      assert.equal(
        page.coverage.next_offset,
        offset + expectedRows >= record.normalized_result.length
          ? null
          : offset + expectedRows,
      );
      offset = page.coverage.next_offset;
    } while (offset !== null);
    assert.deepEqual(all, record.normalized_result);
    report.rows[operation] = all.length;
    assert.equal(hash(await readFile(sourcePath)), hash(sourceBytes));
  }
  const exportPath = join(values.output, "exported.json");
  await result("export_evidence_bundle", { path: exportPath });
  const exported = JSON.parse(await readFile(exportPath, "utf8"));
  for (const { record } of sources)
    assert.deepEqual(
      exported.records.find(
        (source) => source.evidence_id === record.evidence_id,
      ),
      record,
    );
  assert.equal(
    hash(await readFile(join(values.source, "evidence.json"))),
    report.source_bundle_sha256,
  );
  report.status = "passed";
} catch (cause) {
  report.status = "failed";
  report.failure = String(cause?.stack ?? cause);
  process.exitCode = 1;
} finally {
  report.elapsed_before_cleanup_ms = performance.now() - started;
  try {
    await writeFile(
      join(values.output, "transcript.json"),
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
    output: values.output,
  });
  if (report.status !== "passed" || !finalized) process.exitCode = 1;
}
