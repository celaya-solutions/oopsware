/** Real Ghidra inventory/function Evidence; raw inputs and receipts stay outside Git. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { finished } from "node:stream/promises";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createRetainedQueryCaller } from "./retained-query-calls.mjs";
import { finalizeRetainedQueryReceipt } from "./retained-query-finalization.mjs";

const { values } = parseArgs({
  options: Object.fromEntries(
    ["runtime", "target", "output", "ghidra", "java", "expect", "control"].map(
      (name) => [name, { type: "string" }],
    ),
  ),
});
for (const name of ["runtime", "target", "output", "ghidra", "java"])
  assert.ok(values[name] && values[name] === resolve(values[name]), name);
assert.ok(["duplicate", "compact"].includes(values.expect));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const output = values.output;
await mkdir(output, { mode: 0o700 });
const bytes = await readFile(values.target);
const home = await mkdtemp(join(tmpdir(), "rea-ghidra-evidence-"));
const client = new Client({ name: "ghidra-evidence-projection", version: "1" });
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
  artifact: { path: values.target, bytes: bytes.length, sha256: hash(bytes) },
  expected_projection: values.expect,
  calls: [],
};
const transcript = [];
const evidence = [];
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
const inspect = async (name, input, phase = name) => {
  const value = await result(name, input, phase);
  assert.equal(value.subject.digest.sha256, report.artifact.sha256);
  assert.equal(
    value.provider.id,
    name === "binary_overview" ? "rea-workflow" : "ghidra",
  );
  assert.equal(
    value.provider.version,
    name === "binary_overview" ? "1" : "12.1.4",
  );
  assert.ok(value.analysis_profile);
  evidence.push({ phase, value });
  return value;
};
const started = performance.now();
let opened = false;
try {
  await client.connect(transport);
  const discovery = performance.now();
  const catalog = await client.listTools();
  assert.equal(catalog.nextCursor, undefined);
  report.catalog = {
    elapsed_ms: performance.now() - discovery,
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
  const documents = await inspect("list_documents", {});
  assert.equal(documents.normalized_result.length, 1);
  const procedures = await inspect("list_procedures", {});
  assert.ok(procedures.normalized_result.length > 0);
  const selected = procedures.normalized_result.find(
    (row) => row.procedure.external === false && row.procedure.thunk === false,
  );
  assert.ok(selected);
  report.procedure = selected.address;
  report.procedure_count = procedures.normalized_result.length;
  await inspect("binary_overview", {});
  await inspect("inspect_native_load_image", {});
  for (const name of [
    "procedure_info",
    "procedure_pseudo_code",
    "procedure_assembly",
    "procedure_callers",
    "procedure_callees",
    "analyze_function",
  ])
    await inspect(name, { procedure: selected.address });
  const warmInventory = await inspect("list_procedures", {}, "warm-inventory");
  assert.deepEqual(
    warmInventory.normalized_result,
    procedures.normalized_result,
  );
  const warmPseudocode = await inspect(
    "procedure_pseudo_code",
    { procedure: selected.address },
    "warm-pseudocode",
  );
  assert.deepEqual(
    warmPseudocode.normalized_result,
    evidence.find(({ phase }) => phase === "procedure_pseudo_code").value
      .normalized_result,
  );
  for (const { phase, value } of evidence) {
    if (phase === "binary_overview") {
      assert.equal(value.raw_result, null);
      continue;
    }
    const distinct = phase === "inspect_native_load_image";
    if (values.expect === "compact" && !distinct)
      assert.equal(value.raw_result, null, phase);
    else assert.notEqual(value.raw_result, null, phase);
    if (values.expect === "duplicate" && !distinct) {
      const raw = value.raw_result;
      const wrapped =
        raw !== null &&
        !Array.isArray(raw) &&
        Object.hasOwn(raw, "value") &&
        Object.hasOwn(raw, "limitations");
      assert.deepEqual(
        wrapped ? raw.value : raw,
        value.normalized_result,
        phase,
      );
    }
  }
  const facts = evidence.map(({ phase, value }) => {
    const { evidence_id: _id, raw_result: _raw, ...facts } = value;
    return { phase, facts };
  });
  report.facts_sha256 = hash(JSON.stringify(facts));
  await writeFile(join(output, "facts.json"), JSON.stringify(facts));
  if (values.control)
    assert.deepEqual(facts, JSON.parse(await readFile(values.control, "utf8")));
  const path = join(output, "evidence.json");
  await result("export_evidence_bundle", { path });
  const bundle = JSON.parse(await readFile(path, "utf8"));
  for (const { value } of evidence)
    assert.deepEqual(
      bundle.records.find((record) => record.evidence_id === value.evidence_id),
      value,
    );
  assert.equal(hash(await readFile(values.target)), report.artifact.sha256);
  report.status = "passed";
} catch (cause) {
  report.status = "failed";
  report.failure = String(cause?.stack ?? cause);
  process.exitCode = 1;
} finally {
  if (opened) {
    try {
      await result("close_binary", {});
    } catch (cause) {
      report.status = "failed";
      report.close_failure = String(cause?.stack ?? cause);
    }
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
