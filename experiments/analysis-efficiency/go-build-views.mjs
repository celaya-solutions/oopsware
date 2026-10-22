import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { finished } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createRetainedQueryCaller } from "./retained-query-calls.mjs";
import { finalizeRetainedQueryReceipt } from "./retained-query-finalization.mjs";

const { values } = parseArgs({
  options: {
    runtime: { type: "string" },
    input: { type: "string" },
    oracle: { type: "string" },
    output: { type: "string" },
    mode: { type: "string" },
    warm: { type: "boolean", default: false },
  },
});
for (const key of ["runtime", "input", "oracle", "output"])
  assert.equal(values[key], resolve(values[key]));
assert.ok(["complete", "selected"].includes(values.mode));
const oracle = JSON.parse(await readFile(values.oracle, "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const bytes = await readFile(values.input);
assert.equal(sha256(bytes), oracle.artifact_sha256);
const require = createRequire(join(values.runtime, "package.json"));
const { Client } = await import(
  pathToFileURL(require.resolve("@modelcontextprotocol/client"))
);
const { StdioClientTransport } = await import(
  pathToFileURL(require.resolve("@modelcontextprotocol/client/stdio"))
);
await mkdir(values.output, { mode: 0o700 });
const account = await mkdtemp(join(tmpdir(), "rea-go-build-views-"));
const report = {
  question:
    "Report compiler, main module and the selected embedded dependency; preserve complete original Evidence.",
  mode: values.mode,
  warm_diagnostic: values.warm,
  calls: [],
  artifact_sha256: oracle.artifact_sha256,
};
const client = new Client({ name: "rea-go-build-views", version: "1" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(values.runtime, "scripts/rea.mjs"), "mcp"],
  env: {
    HOME: account,
    PATH: process.env.PATH,
    NODE_OPTIONS: "--max-old-space-size=2048",
    UV_THREADPOOL_SIZE: "1",
    REA_LOG_LEVEL: "silent",
  },
  stderr: "pipe",
});
const serverLog = createWriteStream(join(values.output, "server.log"));
const serverLogFinished = finished(serverLog);
serverLogFinished.catch(() => {});
transport.stderr?.pipe(serverLog);
const transcript = [];
const call = createRetainedQueryCaller(client, (receipt, event) => {
  report.calls.push(receipt);
  transcript.push(event);
});
async function result(name, input, phase = name) {
  const reply = await call(name, input, phase);
  assert.ok(!reply.isError, JSON.stringify(reply));
  assert.ok(reply.structuredContent);
  assert.equal(reply.content.length, 1);
  assert.equal(reply.content[0].type, "text");
  assert.deepEqual(JSON.parse(reply.content[0].text), reply.structuredContent);
  return reply.structuredContent;
}
try {
  await client.connect(transport);
  const catalog = await client.listTools();
  assert.equal(catalog.nextCursor, undefined);
  report.catalog_tools = catalog.tools.length;
  await writeFile(join(values.output, "catalog.json"), JSON.stringify(catalog));
  const definitions = new Map(catalog.tools.map((tool) => [tool.name, tool]));
  const original = client.callTool.bind(client);
  client.callTool = (input, options) =>
    original(input, {
      ...options,
      timeout: 60000,
      toolDefinition: definitions.get(input.name),
    });
  const inspected = await result(
    "inspect_go_binary",
    {
      path: values.input,
      ...(values.mode === "selected" ? { detail: "summary" } : {}),
    },
    "inspection:first",
  );
  let answer;
  if (values.mode === "complete") {
    report.parent_evidence_id = inspected.evidence_id;
    const info = inspected.normalized_result.build_info;
    assert.ok(info);
    answer = {
      go_version: info.go_version,
      main: info.module.main,
      runtime_dependencies: "unknown",
      dependencies: info.module.dependencies.flatMap((row, index) =>
        row.path === oracle.dependency_path ? [{ index, ...row }] : [],
      ),
    };
  } else {
    const summary = inspected.normalized_result;
    assert.equal(summary.kind, "summary");
    report.parent_evidence_id = summary.parent_evidence_id;
    assert.equal(summary.source_coverage.runtime_dependencies, "unknown");
    assert.equal(
      summary.summary.build_info.module.available_counts.dependencies,
      oracle.dependency_count,
    );
    const input = {
      source: {
        kind: "retained-evidence",
        evidence_id: report.parent_evidence_id,
      },
      view: {
        kind: "go",
        collection: "dependencies",
        paths: [oracle.dependency_path],
        fields: ["path", "version", "sum", "replacement"],
        offset: 0,
        limit: 64,
      },
    };
    let dependencies = [];
    if (summary.summary.build_info.module.available_counts.dependencies > 0) {
      const selected = await result(
        "inspect_analysis_view",
        input,
        "retained-query:first",
      );
      assert.equal(selected.normalized_result.coverage.exhausted, true);
      assert.equal(
        selected.normalized_result.source_coverage.runtime_dependencies,
        "unknown",
      );
      dependencies = selected.normalized_result.page.rows;
      if (values.warm) {
        const warm = await result(
          "inspect_analysis_view",
          input,
          "retained-query:warm-diagnostic",
        );
        assert.deepEqual(warm, selected);
      }
    }
    answer = {
      go_version: summary.summary.build_info.go_version,
      main: summary.summary.build_info.module.main,
      runtime_dependencies: "unknown",
      dependencies,
    };
  }
  assert.deepEqual(answer, oracle.answer);
  report.answer = answer;
  await result("export_evidence_bundle", {
    path: join(values.output, "evidence.json"),
  });
  const bundle = JSON.parse(
    await readFile(join(values.output, "evidence.json"), "utf8"),
  );
  const parent = bundle.records.find(
    (e) => e.evidence_id === report.parent_evidence_id,
  );
  assert.ok(parent);
  assert.equal(parent.operation, "inspect_go_binary");
  assert.deepEqual(parent.parameters, { path: values.input });
  assert.equal(
    parent.normalized_result.artifact.sha256,
    oracle.artifact_sha256,
  );
  // The pre-change normalized result was independently checked against native
  // go version -m and its file-backed bytes before pinning this exact JSON.
  const expected = JSON.parse(
    await readFile(oracle.complete_result_path, "utf8"),
  );
  assert.deepEqual(parent.normalized_result, expected);
  assert.equal(
    parent.normalized_result.build_info.module.dependencies.length,
    oracle.dependency_count,
  );
  for (const name of ["version", "module"]) {
    const info = parent.normalized_result.build_info;
    const location = info[name + "_location"];
    const encoded =
      info[(name === "version" ? "go_version" : "module") + "_bytes_base64"];
    assert.deepEqual(
      bytes.subarray(location.offset, location.offset + location.bytes),
      Buffer.from(encoded, "base64"),
    );
  }
  assert.equal(sha256(await readFile(values.input)), oracle.artifact_sha256);
  report.oracle_file_sha256 = sha256(await readFile(values.oracle));
  report.complete_result_file_sha256 = sha256(
    await readFile(oracle.complete_result_path),
  );
  report.status = "observed";
} catch (cause) {
  report.status = "failed";
  report.failure = String(cause?.stack ?? cause);
  process.exitCode = 1;
} finally {
  if (
    !(await finalizeRetainedQueryReceipt({
      report,
      client,
      transport,
      account,
      serverLog,
      serverLogFinished,
      output: values.output,
      transcript,
    }))
  )
    process.exitCode = 1;
}
