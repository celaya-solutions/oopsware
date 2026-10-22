// Real-input lane for the .NET decompiler (roadmap item 5, part B): public
// types of the installed .NET runtime's own assemblies are reconstructed
// through the public CLI by the admitted ilspycmd. ILSpy's quality is
// reported, not asserted; the checks must agree with themselves. A missing
// runtime or ilspycmd makes the lane unavailable, never a pass.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const cli = join(repository, "scripts/oopsware.mjs");
const load = (path) => import(join(repository, "dist", path));
const { resolveIlspy } = await load("dotnet/ilspy/ilspycmd.js");
const { inspectManagedMembersBytes } = await load(
  "dotnet/ManagedMemberInspector.js",
);

const ASSEMBLIES = [
  "System.Private.CoreLib.dll",
  "System.Text.Json.dll",
  "System.Linq.dll",
  "System.Collections.dll",
  "System.Net.Http.dll",
];
const SAMPLE = Number(process.env.REA_DOTNET_DECOMPILE_SAMPLE ?? 10);

let tool;
try {
  tool = await resolveIlspy();
} catch (cause) {
  console.log(`UNAVAILABLE: ${cause.message}`);
  process.exit(1);
}
const shared = join(
  dirname(tool.dotnet),
  "shared/Microsoft.NETCore.App",
  tool.runtimeVersion,
);

const run = async (...args) => {
  const { stdout } = await exec(process.execPath, [cli, ...args, "--json"], {
    cwd: repository,
    maxBuffer: 256 * 1024 ** 2,
    env: { ...process.env, REA_LOG_LEVEL: "silent" },
  });
  return JSON.parse(stdout).normalized_result;
};

const present = new Set(await readdir(shared));
const summary = [];
for (const name of ASSEMBLIES.filter((entry) => present.has(entry))) {
  const path = join(shared, name);
  const bytes = await readFile(path);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const { types } = inspectManagedMembersBytes(
    bytes,
    { path, sha256, kind: "executable", format: "pe", managed: true },
    { methodLimit: 0, userStrings: false },
  );
  // Public top-level types (visibility 1), spread across the table.
  const candidates = types.filter(
    (type) =>
      type.enclosing_type_token === null &&
      (type.flags & 7) === 1 &&
      !type.name.includes("<"),
  );
  const step = Math.max(1, Math.floor(candidates.length / SAMPLE));
  const sample = candidates
    .filter((_, index) => index % step === 0)
    .slice(0, SAMPLE);
  const counts = { types: 0, complete: 0, clean: 0, members: 0, lines: 0 };
  for (const type of sample) {
    const report = await run(
      "decompile-managed-type",
      path,
      "--type",
      type.full_name,
      "--reference",
      shared,
    );
    assert.equal(report.source.confidence, "inferred", type.full_name);
    assert.deepEqual(report.source.derived_from, [sha256], type.full_name);
    assert.equal(report.selection.decompiled, type.full_name);
    const state = (id) => report.checks.find((check) => check.id === id)?.state;
    assert.equal(
      state("decompiler_clean") === "passed",
      report.decompiler_notes.length === 0 && report.messages.length === 0,
      `${type.full_name}: clean agrees with notes`,
    );
    assert.equal(
      state("members_present") === "failed",
      report.missing_members.length > 0,
      `${type.full_name}: members agree with the missing list`,
    );
    assert.equal(
      report.coverage[0].state === "complete",
      report.checks.every((check) => check.state === "passed"),
      `${type.full_name}: coverage agrees with checks`,
    );
    counts.types += 1;
    counts.lines += report.source.lines;
    if (report.coverage[0].state === "complete") counts.complete += 1;
    if (state("decompiler_clean") === "passed") counts.clean += 1;
    if (state("members_present") === "passed") counts.members += 1;
  }
  summary.push(
    `${name} (.NET ${tool.runtimeVersion}): ${String(counts.types)} public types, ${String(counts.lines)} lines; ILSpy clean ${String(counts.clean)}, members named ${String(counts.members)}, all checks passed ${String(counts.complete)}`,
  );
  console.log(summary.at(-1));
}
assert.ok(summary.length > 0, "No runtime assembly was found to decompile.");
console.log("PASS verify:formats:dotnet");
