/** Measure public retained queries against an authentic, previously exported bundle. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { finished } from "node:stream/promises";
import canonicalize from "canonicalize";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  requireMcpOperationResult,
  requireMcpToolError,
} from "../../scripts/lib/mcp-verifier-results.mjs";
import { createRetainedQueryCaller } from "./retained-query-calls.mjs";
import { finalizeRetainedQueryReceipt } from "./retained-query-finalization.mjs";
import {
  verifyMixedRetainedHistory,
  verifyMixedRetainedClosure,
  retainedUnknownHeads,
} from "./retained-mixed-verification.mjs";

const { values } = parseArgs({
  options: {
    "runtime-root": {
      type: "string",
      default: resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
    },
    revision: { type: "string" },
    bundle: { type: "string" },
    "evidence-id": { type: "string" },
    scenario: { type: "string" },
    delivery: { type: "string" },
    output: { type: "string" },
    "verify-mixed": { type: "boolean", default: false },
  },
});
for (const key of ["runtime-root", "bundle", "output"])
  assert.ok(values[key] && isAbsolute(values[key]), `${key} must be absolute`);
assert.ok(values.revision && values["evidence-id"]);
assert.ok(["native", "javascript"].includes(values.scenario));
assert.ok(["complete", "focused"].includes(values.delivery));
const root = values["runtime-root"];
const output = values.output;
await mkdir(output, { recursive: false, mode: 0o700 });
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sourceBytes = await readFile(values.bundle);
const original = JSON.parse(sourceBytes);
const source = original.records.find(
  (record) => record.evidence_id === values["evidence-id"],
);
const operation =
  values.scenario === "native"
    ? "inspect_binary_layout"
    : "analyze_javascript_application";
assert.equal(source?.operation, operation);
const unknownDomain = `retained-${values.scenario}`;
const expectedUnknowns = retainedUnknownHeads(original.unknowns, unknownDomain);
// These oracles check selected original facts, not producer discovery completeness.
const expectedRows =
  values.scenario === "native"
    ? source.normalized_result.symbols
    : source.normalized_result.graph.nodes
        .filter((node) =>
          ["javascript-asset", "javascript-module", "source-module"].includes(
            node.kind,
          ),
        )
        .map((node) => {
          const candidates = node.observations.flatMap((observation) => {
            const property = observation.properties.path;
            const where = observation.evidence.location;
            return [
              ...(typeof property === "string" ? [property] : []),
              ...(where.available && where.value.kind === "artifact-path"
                ? [where.value.path]
                : where.available && where.value.kind === "source-range"
                  ? [where.value.source]
                  : []),
            ];
          });
          return {
            node_id: node.node_id,
            kind: node.kind,
            path:
              node.identity.strategy === "canonical-path"
                ? node.identity.path
                : node.identity.strategy === "source-map-original"
                  ? node.identity.original_source
                  : (candidates[0] ?? null),
          };
        });
assert.ok(expectedRows.length >= 6, "This task needs six original rows");
const runtimeEntrySha256 = digest(
  await readFile(join(root, "dist/mcp/main.js")),
);
const account = await mkdtemp(join(tmpdir(), "rea-retained-query-"));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, "scripts/rea.mjs"), "mcp"],
  env: {
    PATH: process.env.PATH,
    HOME: account,
    NODE_OPTIONS: "--max-old-space-size=2048",
    REA_LOG_LEVEL: "silent",
  },
  stderr: "pipe",
});
const serverLog = createWriteStream(join(output, "server.log"));
const serverLogFinished = finished(serverLog);
serverLogFinished.catch(() => {});
transport.stderr?.pipe(serverLog);
const client = new Client({
  name: "retained-investigation-measurement",
  version: "1",
});
const report = {
  revision: values.revision,
  runtime_entry_sha256: runtimeEntrySha256,
  bundle_sha256: digest(sourceBytes),
  bundle_bytes: sourceBytes.length,
  source_evidence_id: source.evidence_id,
  scenario: values.scenario,
  delivery: values.delivery,
  verify_mixed: values["verify-mixed"],
  calls: [],
  status: "running",
};
const call = createRetainedQueryCaller(client, async (receipt, event) => {
  report.calls.push(receipt);
  await appendFile(
    join(output, "transcript.jsonl"),
    JSON.stringify(event) + "\n",
  );
});
const result = (reply, name) => requireMcpOperationResult(reply, name);
try {
  await client.connect(transport);
  const started = performance.now();
  const catalog = await client.listTools();
  report.catalog = {
    elapsed_ms: performance.now() - started,
    tools: catalog.tools.length,
    bytes: Buffer.byteLength(JSON.stringify(catalog)),
    sha256: digest(JSON.stringify(catalog)),
  };
  assert.equal(catalog.nextCursor, undefined);
  await writeFile(join(output, "catalog.json"), JSON.stringify(catalog));
  result(
    await call("import_evidence_bundle", { path: values.bundle }, "import"),
    "import_evidence_bundle",
  );
  const answers = [];
  for (let repeat = 0; repeat < 3; repeat += 1) {
    let answer;
    if (values.delivery === "complete") {
      const reply = await call("get_evidence_bundle", {}, `complete-${repeat}`);
      if (reply.isError !== true) {
        const bundle = result(reply, "get_evidence_bundle");
        assert.deepEqual(
          bundle.records.find(
            (record) => record.evidence_id === source.evidence_id,
          ),
          source,
        );
        assert.deepEqual(bundle.unknowns, original.unknowns);
        answer = [expectedRows.slice(0, 6), expectedUnknowns];
      } else {
        // Keep capacity refusals and every recovery RPC in the completed task.
        const failure = requireMcpToolError(reply);
        assert.equal(failure.code, "resource_constraint");
        assert.equal(failure.details?.resource, "transport");
        report.complete_delivery_refused = true;
      }
    }
    if (answer === undefined) {
      const metadata = result(
        await call(
          "get_evidence_bundle",
          {
            detail: "summary",
            filters: { evidence_id: source.evidence_id },
          },
          `discovery-${repeat}`,
        ),
        "get_evidence_bundle",
      );
      assert.equal(metadata.matching_records, 1);
      assert.equal(metadata.records[0].evidence_id, source.evidence_id);
      const rows = [];
      for (const offset of [0, 2, 4]) {
        const view = result(
          await call(
            "inspect_analysis_view",
            {
              source: {
                kind: "retained-evidence",
                evidence_id: source.evidence_id,
              },
              view: {
                kind: "page",
                collection:
                  values.scenario === "native" ? "symbols" : "modules",
                offset,
                limit: 2,
              },
            },
            `page-${repeat}-${offset}`,
          ),
          "inspect_analysis_view",
        );
        assert.equal(view.parent_evidence_id, source.evidence_id);
        assert.equal(view.coverage.total, expectedRows.length);
        assert.equal(view.coverage.examined, 2);
        assert.equal(
          view.coverage.next_offset,
          offset + 2 < expectedRows.length ? offset + 2 : null,
        );
        assert.deepEqual(view.items, expectedRows.slice(offset, offset + 2));
        rows.push(...view.items);
      }
      const unknowns = [];
      let offset = 0;
      do {
        const page = result(
          await call(
            "list_unknowns",
            { domain: unknownDomain, offset, limit: 2 },
            `unknowns-${repeat}-${offset}`,
          ),
          "list_unknowns",
        );
        assert.equal(page.total, expectedUnknowns.length);
        assert.equal(page.offset, offset);
        assert.deepEqual(
          page.items,
          expectedUnknowns.slice(offset, offset + 2),
        );
        assert.equal(
          page.next_offset,
          offset + 2 < expectedUnknowns.length ? offset + 2 : null,
        );
        unknowns.push(...page.items);
        offset = page.next_offset;
      } while (offset !== null);
      assert.deepEqual(unknowns, expectedUnknowns);
      answer = [rows, unknowns];
    }
    answers.push(digest(canonicalize(answer)));
  }
  assert.equal(new Set(answers).size, 1);
  report.answer_sha256 = answers[0];
  if (values["verify-mixed"])
    report.mixed_verification = await verifyMixedRetainedHistory({
      call,
      original,
      sourceId: source.evidence_id,
      output,
    });
  const roundtrip = join(output, "roundtrip.json");
  result(
    await call("export_evidence_bundle", { path: roundtrip }, "export"),
    "export_evidence_bundle",
  );
  const exported = JSON.parse(await readFile(roundtrip, "utf8"));
  const exportedRecords = new Map(
    exported.records.map((record) => [record.evidence_id, record]),
  );
  for (const record of original.records)
    assert.deepEqual(exportedRecords.get(record.evidence_id), record);
  assert.deepEqual(exported.unknowns, original.unknowns);
  report.original_records_preserved = true;
  result(await call("close_binary", {}, "close"), "close_binary");
  const closed = result(
    await call("get_evidence_bundle", { detail: "summary" }, "after-close"),
    "get_evidence_bundle",
  );
  assert.equal(closed.total_retained_records, 0);
  report.close_cleared_records = true;
  if (values["verify-mixed"])
    Object.assign(
      report.mixed_verification,
      await verifyMixedRetainedClosure(call, source.evidence_id),
    );
  assert.equal(digest(await readFile(values.bundle)), report.bundle_sha256);
  report.status = "passed";
} catch (cause) {
  report.status = "failed";
  report.failure = { name: cause.name, message: cause.message };
} finally {
  const finalized = await finalizeRetainedQueryReceipt({
    report,
    client,
    transport,
    account,
    serverLog,
    serverLogFinished,
    output,
  });
  if (report.status !== "passed" || !finalized) process.exitCode = 1;
}
