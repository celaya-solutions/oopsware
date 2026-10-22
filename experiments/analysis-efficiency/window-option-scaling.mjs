#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { analyzeJavaScriptStaticSource } from "../../dist/domain/javascript/javascriptStaticAnalysis.js";

const label = process.argv[2] ?? "unlabelled";
const counts = (process.argv[3] ?? "256,512,1024").split(",").map(Number);
assert.ok(counts.every((count) => Number.isSafeInteger(count) && count > 0));
const rows = [];
for (const count of counts) {
  const source = [
    'const {BrowserWindow}=require("electron");',
    "const options={webPreferences:{sandbox:true}};",
    ...Array.from({ length: count }, () => "new BrowserWindow(options);"),
  ].join("\n");
  const samples = [];
  for (let round = 0; round < 3; round++) {
    const cpu = process.cpuUsage();
    const began = performance.now();
    const result = analyzeJavaScriptStaticSource(source);
    const cpuUsed = process.cpuUsage(cpu);
    const elapsedMs = performance.now() - began;
    const windows = result.electron.browser_windows;
    assert.equal(windows.length, count);
    assert.deepEqual(
      windows.map(({ location }) => location.start.line),
      Array.from({ length: count }, (_, index) => index + 3),
    );
    assert.equal(windows[0].options_status, "object-literal");
    assert.ok(
      windows
        .slice(1)
        .every(({ options_status }) => options_status === "dynamic"),
    );
    samples.push({
      round,
      elapsed_ms: elapsedMs,
      cpu_seconds: (cpuUsed.user + cpuUsed.system) / 1e6,
    });
  }
  rows.push({ count, source_bytes: Buffer.byteLength(source), samples });
}
const modules = [
  "javascriptStaticAnalysis",
  "electronStaticOptionObjects",
  "javascriptSemanticAnalysis",
  "javascriptSemanticMemberMutations",
];
const moduleHashes = {};
for (const name of modules)
  moduleHashes[name] = createHash("sha256")
    .update(
      await readFile(
        new URL(`../../dist/domain/javascript/${name}.js`, import.meta.url),
      ),
    )
    .digest("hex");
console.log(
  JSON.stringify({
    label,
    rows,
    module_sha256: moduleHashes,
    conditions:
      "Synthetic capacity/scaling control, not a real-app or agent task. Three sequential source analyses per size in one process; V8 and module caches may warm, no retained analysis cache. Timing assertions are not test gates. Run under the documented resource observer; real Joplin tasks are measured separately.",
  }),
);
