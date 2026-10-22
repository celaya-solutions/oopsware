import {
  requireSymbol,
  validateEvidence,
  quality,
  verifyPatch,
  withoutEvidenceIds,
  optimizationQuality,
} from "./lib/native-version-quality.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  copyFile,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  requireMcpLifecycleResult,
  requireMcpToolError,
} from "./lib/mcp-verifier-results.mjs";
import { completeVerifierRun, createVerifierRun } from "./lib/verifier-run.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dispatcher = join(root, "scripts/rea.mjs");
const fixtureRoot = join(root, "tests/fixtures/native-versions");
const exec = promisify(execFile);
const run = createVerifierRun();
const timeout = 180_000;
const command = (executable, args) =>
  exec(executable, args, {
    cwd: root,
    timeout,
    maxBuffer: 64 * 1024 * 1024,
    env: process.env,
  });
const sha256 = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
const cli = async (args) =>
  JSON.parse(
    (await command(process.execPath, [dispatcher, ...args, "--json"])).stdout,
  );
const writeJson = (path, value) =>
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
const canonicalAddress = (hex) => `0x${BigInt(`0x${hex}`).toString(16)}`;

async function preflight() {
  const supported = new Set(["darwin/arm64", "linux/x64"]).has(
    `${process.platform}/${process.arch}`,
  );
  if (!supported)
    return {
      status: "unavailable",
      lane: `${process.platform}-${process.arch}`,
      missing_prerequisites: [
        "Verifier supports native macOS arm64 and Linux x86_64 hosts only; other lanes are unverified",
      ],
    };
  const compiler = process.env.CC ?? "cc";
  const missing = [];
  for (const executable of [compiler, "nm", "strip"]) {
    try {
      if (isAbsolute(executable)) await access(executable, constants.X_OK);
      else await command("which", [executable]);
    } catch {
      missing.push(`Required host command unavailable: ${executable}`);
    }
  }
  const status = await cli(["providers"]);
  const candidates = status.analysis_provider_candidates ?? [];
  const requested = process.env.REA_VERIFY_NATIVE_PROVIDER;
  const allowed =
    requested === undefined
      ? process.platform === "darwin"
        ? ["hopper"]
        : ["ghidra", "hopper"]
      : [requested];
  const provider = allowed
    .map((id) =>
      candidates.find(
        (candidate) =>
          candidate.provider.id === id &&
          candidate.availability.status === "available",
      ),
    )
    .find(Boolean)?.provider.id;
  if (provider === undefined)
    for (const id of allowed)
      missing.push(
        `${id}: ${candidates.find((candidate) => candidate.provider.id === id)?.availability.reason ?? "provider is not configured"}`,
      );
  if (
    provider === "hopper" &&
    process.platform === "linux" &&
    !process.env.DISPLAY
  )
    missing.push(
      "Linux Hopper requires an existing DISPLAY (this lane does not install or start Xvfb)",
    );
  const lane = `${process.platform}-${process.arch}-${provider ?? allowed.join("-or-")}`;
  return missing.length > 0
    ? { status: "unavailable", lane, missing_prerequisites: missing }
    : { status: "ready", lane, compiler, provider };
}

async function symbols(path) {
  const { stdout } = await command("nm", ["-n", path]);
  const result = new Map();
  for (const line of stdout.split("\n")) {
    const match = /^\s*([0-9a-f]+)\s+[tT]\s+(\S+)\s*$/iu.exec(line);
    if (match !== null)
      result.set(
        process.platform === "darwin" ? match[2].replace(/^_/u, "") : match[2],
        canonicalAddress(match[1]),
      );
  }
  return result;
}

async function compileInlining(prepared, directory) {
  const optimized = {};
  for (const level of ["O0", "O2"]) {
    const path = join(directory, `inlining-${level}`);
    await command(prepared.compiler, [
      `-${level}`,
      join(fixtureRoot, "inlining.c"),
      "-o",
      path,
    ]);
    optimized[level] = {
      path,
      symbols: await symbols(path),
      sha256: await sha256(path),
    };
  }
  requireSymbol(optimized.O0.symbols, "inline_candidate");
  assert.ok(
    !optimized.O2.symbols.has("inline_candidate"),
    "Optimization fixture did not eliminate the separate static helper",
  );
  for (const value of Object.values(optimized))
    requireSymbol(value.symbols, "inline_wrapper");
  return optimized;
}

async function compile(prepared, directory) {
  const binaries = {};
  const sourceHashes = {};
  for (const name of ["before", "after"]) {
    const source = join(fixtureRoot, `${name}.c`),
      output = join(directory, name);
    sourceHashes[name] = await sha256(source);
    await command(prepared.compiler, ["-O1", "-g", source, "-o", output]);
    const table = await symbols(output);
    const stripped = `${output}-stripped`;
    await copyFile(output, stripped);
    await command(
      "strip",
      process.platform === "darwin" ? [stripped] : ["--strip-all", stripped],
    );
    binaries[name] = {
      path: output,
      stripped,
      symbols: table,
      sha256: await sha256(output),
      stripped_sha256: await sha256(stripped),
    };
  }
  for (const name of [
    "parse_header",
    "check_length",
    "same_helper",
    "duplicate_a",
    "duplicate_b",
    "removed_helper",
    "main",
  ])
    requireSymbol(binaries.before.symbols, name);
  for (const name of [
    "decode_header",
    "check_length",
    "same_helper",
    "duplicate_a",
    "duplicate_b",
    "added_helper",
    "main",
  ])
    requireSymbol(binaries.after.symbols, name);
  assert.notEqual(
    requireSymbol(binaries.before.symbols, "parse_header"),
    requireSymbol(binaries.after.symbols, "decode_header"),
    "Fixture must move the renamed function",
  );
  assert.notEqual(
    requireSymbol(binaries.before.symbols, "duplicate_a"),
    requireSymbol(binaries.before.symbols, "duplicate_b"),
    "Compiler merged duplicate fixture identities",
  );
  assert.notEqual(
    requireSymbol(binaries.after.symbols, "duplicate_a"),
    requireSymbol(binaries.after.symbols, "duplicate_b"),
    "Compiler merged duplicate fixture identities",
  );
  for (const side of [binaries.before, binaries.after]) {
    const strippedSymbols = await symbols(side.stripped);
    assert.ok(
      !strippedSymbols.has("check_length"),
      "Stripped fixture still exposes its source function symbols",
    );
  }
  const optimized = await compileInlining(prepared, directory);
  sourceHashes.inlining = await sha256(join(fixtureRoot, "inlining.c"));
  await writeJson(join(directory, "ground-truth.json"), {
    source_sha256: sourceHashes,
    compiler: prepared.compiler,
    flags: { labeled: ["-O1", "-g"], inlining: ["-O0", "-O2"] },
    before: Object.fromEntries(binaries.before.symbols),
    after: Object.fromEntries(binaries.after.symbols),
    inlining: Object.fromEntries(
      Object.entries(optimized).map(([level, value]) => [
        level,
        Object.fromEntries(value.symbols),
      ]),
    ),
    binaries_executed: false,
  });
  return { ...binaries, optimized };
}

async function verifyMcp({
  prepared,
  directory,
  corpus,
  selected,
  strippedResult,
  mismatch,
}) {
  const client = new Client({
    name: "rea-native-versions-verifier",
    version: "1",
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [dispatcher, "mcp"],
    cwd: root,
    stderr: "pipe",
  });
  const request = {
    left: {
      path: corpus.before.stripped,
      expected_sha256: corpus.before.stripped_sha256,
    },
    right: {
      path: corpus.after.stripped,
      expected_sha256: corpus.after.stripped_sha256,
    },
    provider_id: prepared.provider,
    selected_pairs: selected,
  };
  let mcpResult;
  await client.connect(transport);
  try {
    const response = await client.callTool(
      { name: "compare_native_versions", arguments: request },
      { timeout },
    );
    assert.notEqual(response.isError, true, JSON.stringify(response));
    await writeJson(
      join(directory, "stripped-mcp.json"),
      response.structuredContent,
    );
    mcpResult = validateEvidence(
      response.structuredContent,
      corpus.before.stripped_sha256,
      corpus.after.stripped_sha256,
    );
    for (const field of [
      "candidates",
      "comparisons",
      "ambiguous",
      "collisions",
      "changed_candidates",
      "added_candidates",
      "removed_candidates",
    ])
      assert.deepEqual(
        withoutEvidenceIds(mcpResult[field]),
        withoutEvidenceIds(strippedResult[field]),
        `CLI/MCP result drift: ${field}`,
      );
    const failed = await client.callTool(
      {
        name: "compare_native_versions",
        arguments: {
          ...request,
          left: { ...request.left, expected_sha256: "f".repeat(64) },
        },
      },
      { timeout },
    );
    assert.equal(requireMcpToolError(failed).code, mismatch.code);
    const state = requireMcpLifecycleResult(
      await client.callTool(
        { name: "binary_session", arguments: {} },
        { timeout },
      ),
      "binary_session",
    );
    assert.equal(
      state.open,
      false,
      "Independent comparison opened the caller's session",
    );
  } finally {
    await client.close();
    await transport.close();
  }

  return mcpResult;
}

async function verify(prepared, directory) {
  const corpus = await compile(prepared, directory);
  const selected = [
    {
      left_address: requireSymbol(corpus.before.symbols, "check_length"),
      right_address: requireSymbol(corpus.after.symbols, "check_length"),
    },
  ];
  const commandArgs = (left, right) => [
    "compare-native-versions",
    left,
    right,
    "--provider-id",
    prepared.provider,
  ];
  const plain = await cli(commandArgs(corpus.before.path, corpus.after.path));
  await writeJson(join(directory, "labeled-cli.json"), plain);
  const labeled = validateEvidence(
    plain,
    corpus.before.sha256,
    corpus.after.sha256,
  );
  const stripped = await cli([
    ...commandArgs(corpus.before.stripped, corpus.after.stripped),
    "--selected-pairs",
    JSON.stringify(selected),
  ]);
  await writeJson(join(directory, "stripped-cli.json"), stripped);
  const strippedResult = validateEvidence(
    stripped,
    corpus.before.stripped_sha256,
    corpus.after.stripped_sha256,
  );
  const mismatch = await cli([
    ...commandArgs(corpus.before.path, corpus.after.path),
    "--left-sha256",
    "f".repeat(64),
  ]);
  assert.equal(mismatch.code, "evidence_integrity_mismatch");
  await writeJson(join(directory, "identity-mismatch-cli.json"), mismatch);

  const mcpResult = await verifyMcp({
    prepared,
    directory,
    corpus,
    selected,
    strippedResult,
    mismatch,
  });

  const optimized = await cli(
    commandArgs(corpus.optimized.O0.path, corpus.optimized.O2.path),
  );
  await writeJson(join(directory, "inlining-cli.json"), optimized);
  const optimizedResult = validateEvidence(
    optimized,
    corpus.optimized.O0.sha256,
    corpus.optimized.O2.sha256,
  );
  return {
    status: "passed",
    lane: prepared.lane,
    provider: prepared.provider,
    binaries_executed: false,
    fixture:
      "One labeled O1 source pair, its stripped copies, and a separate O0/O2 static-helper-inlining pair; no general precision or platform claim",
    quality: {
      labeled_cli: quality(labeled, corpus),
      stripped_cli: quality(strippedResult, corpus),
      stripped_mcp: quality(mcpResult, corpus),
    },
    selected_patch: {
      cli: verifyPatch(strippedResult, corpus),
      mcp: verifyPatch(mcpResult, corpus),
    },
    cli_mcp_parity:
      "candidate, selected comparison, ambiguity, collision and change sections agree after removing Evidence IDs",
    identity_mismatch: "CLI and MCP rejected an incorrect expected SHA-256",
    optimization_inlining: optimizationQuality(optimizedResult, corpus),
    evidence_directory: directory,
    verification: await completeVerifierRun(run),
  };
}

const prepared = await preflight();
if (prepared.status !== "ready") {
  process.stdout.write(`${JSON.stringify(prepared, null, 2)}\n`);
  process.exitCode = 2;
} else {
  // Hopper's external application bridge cannot reliably reopen macOS's
  // per-user /var/folders temp targets; use the existing verifier /tmp convention.
  const directory = await mkdtemp(
    join(
      process.platform === "darwin" ? "/tmp" : tmpdir(),
      "rea-native-versions-",
    ),
  );
  try {
    const report = await verify(prepared, directory);
    await writeJson(join(directory, "report.json"), report);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    const report = {
      status: "failed",
      lane: prepared.lane,
      evidence_directory: directory,
      error: error instanceof Error ? error.message : String(error),
      verification: await completeVerifierRun(run),
    };
    await writeJson(join(directory, "report.json"), report);
    process.stderr.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = 1;
  }
}
