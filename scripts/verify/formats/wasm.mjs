// Real-producer lane for format expansion F01: a module compiled by the
// installed Rust toolchain is read through the public CLI. A missing producer
// makes the lane unavailable, never a pass.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { arch, platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const cli = join(repository, "scripts/oopsware.mjs");

const SOURCE = `#![no_std]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! { loop {} }

#[link(wasm_import_module = "host")]
extern "C" { fn report(value: i32); }

static GREETING: &[u8] = b"oopsware wasm fixture";

trait Shape { fn area(&self) -> i32; }
struct Square(i32);
struct Rect(i32, i32);
impl Shape for Square { fn area(&self) -> i32 { self.0 * self.0 } }
impl Rect { #[inline(never)] fn wide(&self) -> i32 { self.0 * 2 } }
impl Shape for Rect { fn area(&self) -> i32 { self.0 * self.1 + self.wide() - self.0 * 2 } }

#[inline(never)]
fn pick(kind: i32) -> &'static dyn Shape {
    static SQ: Square = Square(3);
    static RE: Rect = Rect(2, 5);
    if kind == 0 { &SQ } else { &RE }
}

#[no_mangle]
pub extern "C" fn area_of(kind: i32) -> i32 {
    let shape = core::hint::black_box(pick(kind));
    let value = shape.area();
    unsafe { report(value) };
    value
}

#[no_mangle]
pub extern "C" fn greeting_len() -> i32 { core::hint::black_box(GREETING).len() as i32 }
`;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const unavailable = (reason) => {
  console.log(
    JSON.stringify({
      lane: "verify:formats:wasm",
      status: "unavailable",
      reason,
    }),
  );
  console.error(`UNAVAILABLE: ${reason}`);
  process.exit(2);
};

const run = async (...args) => {
  const { stdout } = await exec(process.execPath, [cli, ...args, "--json"], {
    cwd: repository,
    maxBuffer: 64 * 1024 ** 2,
    env: { ...process.env, REA_LOG_LEVEL: "silent" },
  });
  return JSON.parse(stdout).normalized_result;
};

/** The CLI prints a typed error as JSON and exits 1; other failures are ours. */
const runOrError = async (...args) => {
  try {
    return { result: await run(...args) };
  } catch (cause) {
    const error = JSON.parse(cause.stdout ?? "null");
    if (error?.code === undefined) throw cause;
    return { error };
  }
};

/**
 * Translate one module with wasm2c and check that the result agrees with
 * itself; wasm2c's and clang's verdicts are counted, never failed on.
 */
const translate = async (path, module, functionExports) => {
  const { result, error } = await runOrError("convert-wasm-to-c", path);
  if (error !== undefined) {
    assert.equal(error.code, "capability_unavailable", error.message);
    return { unavailable: error.message };
  }
  for (const file of [result.c, result.header]) {
    assert.deepEqual(file.derived_from, [sha256(module)]);
    assert.equal(file.sha256, sha256(file.text));
  }
  const states = Object.fromEntries(
    result.checks.map((check) => [check.id, check.state]),
  );
  const allPassed = result.checks.every((check) => check.state === "passed");
  assert.equal(result.coverage[0].state, allPassed ? "complete" : "partial");
  if (states.compiles === "failed") assert.ok(result.compile_errors.length > 0);
  else assert.deepEqual(result.compile_errors, []);
  if (states.exports_match === "passed") {
    assert.equal(result.exports.module, functionExports);
    assert.equal(result.exports.declared, functionExports);
    assert.deepEqual([result.exports.missing, result.exports.extra], [[], []]);
  }
  return { states, lines: result.c.lines, converter: result.converter.build };
};

const root = await mkdtemp(join(tmpdir(), "oopsware-wasm-lane-"));
try {
  let rustc;
  try {
    rustc = (await exec("rustc", ["--version"])).stdout.trim();
  } catch {
    unavailable("rustc is not on PATH");
  }
  const sourcePath = join(root, "shapes.rs");
  const wasmPath = join(root, "shapes.wasm");
  await writeFile(sourcePath, SOURCE);
  try {
    await exec("rustc", [
      "--target",
      "wasm32-unknown-unknown",
      "--crate-type",
      "cdylib",
      "-O",
      "-C",
      "panic=abort",
      sourcePath,
      "-o",
      wasmPath,
    ]);
  } catch (cause) {
    unavailable(
      `rustc could not build for wasm32-unknown-unknown (rustup target add wasm32-unknown-unknown): ${String(cause.stderr ?? cause).slice(0, 300)}`,
    );
  }
  const module = await readFile(wasmPath);
  const debugPath = join(root, "shapes.debug.wasm");
  await exec("rustc", [
    "--target",
    "wasm32-unknown-unknown",
    "--crate-type",
    "cdylib",
    "-C",
    "opt-level=0",
    "-C",
    "panic=abort",
    sourcePath,
    "-o",
    debugPath,
  ]);

  const report = await run("inspect-wasm-module", wasmPath);
  assert.equal(report.artifact.sha256, sha256(module));
  assert.equal(report.validation.state, "valid");
  assert.equal(
    report.coverage.find((item) => item.facet === "inspect").state,
    "complete",
  );
  assert.deepEqual(report.exports.map((item) => item.name).sort(), [
    "area_of",
    "greeting_len",
    "memory",
  ]);
  assert.deepEqual(
    report.imports.map((item) => `${item.module}.${item.name}`),
    ["host.report"],
  );
  assert.ok(
    report.producers.some((field) =>
      field.values.some((value) => value.name === "rustc"),
    ),
    "the producers section names rustc",
  );
  assert.ok(
    report.data.some((segment) =>
      segment.preview_text.includes("oopsware wasm fixture"),
    ),
    "the static string sits in a data segment",
  );
  const areaOf = report.functions.find((item) => item.name === "area_of");
  assert.ok(areaOf, "area_of is named by the name section");
  assert.equal(areaOf.indirect_call_sites, 1);

  const fn = await run("inspect-wasm-function", wasmPath, String(areaOf.index));
  const targets = fn.indirect_calls[0].targets;
  assert.equal(targets.state, "static");
  const names = targets.candidates.map((item) => item.name ?? "").join(" ");
  assert.match(names, /Square.*Shape.*area/u);
  assert.match(names, /Rect.*Shape.*area/u);
  assert.equal(targets.candidates.length, 2);
  for (const instruction of fn.instructions)
    assert.ok(instruction.offset < module.length);

  const watPath = join(root, "shapes.derived.wat");
  const conversion = await run("convert-wasm-to-text", wasmPath, watPath);
  const wat = await readFile(watPath);
  assert.equal(conversion.output.sha256, sha256(wat));
  assert.equal(conversion.output.derived_from, sha256(module));
  const roundTrip = await run("inspect-wasm-module", watPath);
  assert.equal(roundTrip.source.format, "text");
  assert.equal(roundTrip.function_count, report.function_count);
  assert.equal(
    sha256(await readFile(wasmPath)),
    sha256(module),
    "original unchanged",
  );

  const functionExports = report.exports.filter(
    (item) => item.kind === "func",
  ).length;
  const translations = [];
  for (const [label, path] of [
    ["-O", wasmPath],
    ["opt-level=0", debugPath],
  ])
    translations.push({
      module: label,
      ...(await translate(path, await readFile(path), functionExports)),
    });
  const translated = translations.filter((item) => item.states !== undefined);
  const counts = {};
  for (const item of translated)
    for (const [id, value] of Object.entries(item.states))
      counts[`${id} ${value}`] = (counts[`${id} ${value}`] ?? 0) + 1;

  const { stdout: commit } = await exec("git", ["rev-parse", "HEAD"], {
    cwd: repository,
  });
  console.log(
    JSON.stringify({
      lane: "verify:formats:wasm",
      status: "passed",
      commit: commit.trim(),
      host: `${platform()}-${arch()}`,
      tools: {
        rustc,
        wabt: conversion.output.converter,
        wasm2c: translated[0]?.converter ?? "unavailable",
      },
      input: {
        profile: "rustc wasm32-unknown-unknown cdylib -O",
        sha256: sha256(module),
        bytes: module.length,
      },
      passed: [
        "identify",
        "inspect: sections, imports, exports, data, producers, names",
        "inspect: direct calls and static indirect-call candidates",
        "derived WAT output with digest and round trip",
        ...(translated.length > 0
          ? ["wasm2c C translation, self-consistent checks"]
          : []),
      ],
      wasm2c: { translations, counts },
      omitted: [
        "SIMD and newer-proposal instructions",
        "components",
        "DWARF",
        "source-like decompilation",
        ...(translated.length > 0 ? [] : ["wasm2c C translation"]),
      ],
    }),
  );
  console.error(
    `PASS: rustc-built module (${module.length} bytes, ${report.function_count} functions) read through the CLI; trait-object call has 2 static candidates; derived WAT round-trips; wasm2c translated ${translated.length} of ${translations.length} modules ${JSON.stringify(counts)}.`,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
