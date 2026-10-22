/**
 * verify:formats:android — real-producer acceptance for format expansion F04.
 *
 * Builds a DEX, a signed APK (v1-v3), an App Bundle with an on-demand feature
 * module and bundletool's split APK set with Google's tools, reads each
 * through the compiled CLI, and compares whole DEX files that d8 builds from
 * large real JARs with dexdump. When the pinned JADX engine is present it also
 * checks the handoff: one APK extracted from the set is read by the JADX
 * tools. Nothing is installed on a device and no package code runs.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { arch, platform, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const cli = join(repository, "scripts/oopsware.mjs");
const producers = await import(
  join(repository, "tests/fixtures/androidProducers.ts")
);

if (producers.ANDROID_TOOLS === null) {
  console.error(
    `UNAVAILABLE verify:formats:android: needs Android build-tools ${producers.ANDROID_BUILD_TOOLS}, ${producers.ANDROID_PLATFORM}, bundletool, a JDK 17+ and clang (see docs/android-packages.md).`,
  );
  process.exit(2);
}
const tools = producers.ANDROID_TOOLS;

const exists = async (path) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const run = async (...args) => {
  const { stdout } = await exec(process.execPath, [cli, ...args, "--json"], {
    maxBuffer: 512 * 1024 ** 2,
    env: { ...process.env, REA_LOG_LEVEL: "silent" },
  });
  return JSON.parse(stdout);
};
const result = async (...args) => (await run(...args)).normalized_result;

/** Big real JARs to dex: REA_ANDROID_LANE_JARS (colon-separated) or the Ghidra install's libraries. */
const laneJars = async () => {
  if (process.env.REA_ANDROID_LANE_JARS !== undefined)
    return process.env.REA_ANDROID_LANE_JARS.split(":").filter(
      (path) => path !== "",
    );
  const library =
    "/opt/homebrew/opt/ghidra/libexec/Ghidra/Framework/Generic/lib";
  if (!(await exists(library))) return [];
  return (await readdir(library))
    .filter((name) => /^(guava|bcprov|commons-lang3|gson)-.*\.jar$/u.test(name))
    .map((name) => join(library, name))
    .sort();
};

const summary = [];
const report = {
  lane: "verify:formats:android",
  host: { platform: platform(), arch: arch() },
  tools: {
    build_tools: producers.ANDROID_BUILD_TOOLS,
    platform: producers.ANDROID_PLATFORM,
    bundletool: tools.bundletool,
    java_home: tools.javaHome,
  },
  inputs: [],
  passed: [],
  omitted: [],
};
const scratch = await mkdtemp(join(tmpdir(), "oopsware-android-lane-"));
/** extract-artifact writes to its own temporary roots; they are removed with the scratch directory. */
const extractionRoots = [];
try {
  const commit = (
    await exec("git", ["-C", repository, "rev-parse", "HEAD"])
  ).stdout.trim();
  report.commit = commit;
  const fixtures = await producers.buildAndroidFixtures(
    join(scratch, "fixtures"),
  );
  for (const path of [
    fixtures.apk,
    fixtures.aab,
    fixtures.apks,
    fixtures.dex,
    fixtures.libraryDex,
  ])
    report.inputs.push({
      path: basename(path),
      sha256: sha256(await readFile(path)),
    });

  // APK: binary manifest, resources, two DEX files, both ABIs, v1-v3 signature material.
  const apk = await result("inspect-android-artifact", fixtures.apk);
  assert.equal(apk.package.kind, "apk");
  assert.equal(apk.apk.manifest.facts.package_name, producers.PACKAGE_NAME);
  assert.equal(apk.apk.manifest.facts.version_code, producers.VERSION_CODE);
  assert.deepEqual(apk.apk.dex, ["classes.dex", "classes2.dex"]);
  assert.deepEqual(apk.apk.native_abis, [...producers.ABIS].sort());
  assert.ok(
    apk.native_libraries.every((library) => library.elf?.matches_abi === true),
  );
  assert.ok(apk.apk.signing.jar_signers.length === 1);
  const blocks = apk.apk.signing.signing_block.blocks.map(
    (block) => block.name,
  );
  assert.ok(
    blocks.includes("APK Signature Scheme v2") &&
      blocks.includes("APK Signature Scheme v3"),
  );
  assert.ok(
    apk.dex_files.every((dex) => dex.checksum.valid && dex.signature.valid),
  );
  assert.equal(apk.diagnostics.length, 0, JSON.stringify(apk.diagnostics));
  summary.push(
    `apk: ${String(apk.class_count)} classes in ${String(apk.dex_files.length)} DEX files, ${String(blocks.length)} signing blocks, ${String(apk.native_libraries.length)} native libraries`,
  );
  report.passed.push("apk-inventory");

  // Bundle: proto manifests, modules, delivery, BundleConfig.
  const aab = await result("inspect-android-artifact", fixtures.aab);
  assert.equal(aab.package.kind, "aab");
  assert.deepEqual(
    aab.bundle.modules.map((module) => module.name),
    ["base", "camera"],
  );
  const camera = aab.bundle.modules.find((module) => module.name === "camera");
  assert.deepEqual(camera.manifest.facts.module.delivery, ["on-demand"]);
  assert.equal(camera.manifest.facts.split, "camera");
  assert.ok(aab.bundle.config !== null);
  assert.equal(aab.diagnostics.length, 0, JSON.stringify(aab.diagnostics));
  summary.push(
    `aab: modules ${aab.bundle.modules.map((module) => module.name).join(", ")}; ${String(aab.class_count)} classes`,
  );
  report.passed.push("aab-inventory");

  // APK set: toc.pb, every split, base per variant, no gaps.
  const set = await result("inspect-android-artifact", fixtures.apks);
  assert.equal(set.package.kind, "apks");
  assert.deepEqual(set.apk_set.missing, []);
  assert.deepEqual(set.apk_set.undeclared, []);
  assert.ok(
    set.apk_set.apks.every(
      (entry) => entry.kind !== "undeclared" && entry.sha256 !== null,
    ),
  );
  assert.equal(set.apk_set.base.state, "multiple");
  assert.deepEqual(set.apk_set.conflicts, []);
  summary.push(
    `apks: ${String(set.apk_set.apks.length)} APKs, ${String(set.apk_set.base.entries.length)} base masters, ${String(set.dex_files.length)} DEX files`,
  );
  report.passed.push("apks-inventory");

  // A set missing one declared split: the gap is reported, nothing is guessed.
  const { ZipReader, ZipWriter, Uint8ArrayReader, Uint8ArrayWriter } =
    await import("@zip.js/zip.js");
  const reader = new ZipReader(
    new Uint8ArrayReader(await readFile(fixtures.apks)),
  );
  const writer = new ZipWriter(new Uint8ArrayWriter(), { level: 0 });
  for (const entry of await reader.getEntries())
    if (entry.filename !== "splits/base-es.apk")
      await writer.add(
        entry.filename,
        new Uint8ArrayReader(await entry.getData(new Uint8ArrayWriter())),
      );
  await reader.close();
  const gapped = join(scratch, "gapped.apks");
  await writeFile(gapped, await writer.close());
  const gap = await result("inspect-android-artifact", gapped);
  assert.deepEqual(gap.apk_set.missing, ["splits/base-es.apk"]);
  report.passed.push("apks-missing-split");

  // Class and method selection across containers.
  const codes = await result(
    "inspect-dex-class",
    fixtures.apk,
    "org.oops.lib.Codes",
  );
  assert.equal(codes.selection.entry, "classes2.dex");
  const identical = await result(
    "inspect-dex-class",
    fixtures.apks,
    "com.example.oops.MainActivity",
  );
  assert.equal(identical.selection.basis, "identical");
  const classify = await result(
    "inspect-dex-method",
    fixtures.libraryDex,
    "org.oops.lib.Codes",
    "classify",
  );
  assert.equal(classify.instructions[0].mnemonic, "packed-switch");
  summary.push(
    `selection: Codes in classes2.dex; MainActivity in ${String(identical.selection.definitions.length)} identical base masters`,
  );
  report.passed.push("dex-selection");

  // A real-world APK (Appium ApiDemos, Apache-2.0) when the pinned fixture is present.
  const apiDemos =
    process.env.REA_ANDROID_TEST_APK ??
    join(
      repository,
      "..",
      "..",
      "_reference/apk-integration/ApiDemos-debug.apk",
    );
  const realApk = (await exists(apiDemos))
    ? apiDemos
    : (await exists(
          join(repository, "_reference/apk-integration/ApiDemos-debug.apk"),
        ))
      ? join(repository, "_reference/apk-integration/ApiDemos-debug.apk")
      : null;
  if (realApk === null)
    report.omitted.push("real-world APK (run npm run fixtures:android)");
  else {
    const demos = await result(
      "inspect-android-artifact",
      realApk,
      "--limit",
      "1",
    );
    assert.equal(
      demos.apk.manifest.facts.package_name,
      "io.appium.android.apis",
    );
    assert.ok(
      demos.dex_files.every((dex) => dex.checksum.valid && dex.signature.valid),
    );
    report.inputs.push({
      path: basename(realApk),
      sha256: sha256(await readFile(realApk)),
    });
    summary.push(
      `ApiDemos: ${String(demos.class_count)} classes, ${String(demos.apk.manifest.facts.components.length)} components, ${String(demos.diagnostics.length)} diagnostics`,
    );
    report.passed.push("real-world-apk");
  }

  // Whole-file oracle: d8 over large real JARs, every class compared with dexdump -d -a.
  const jars = await laneJars();
  const oracleInputs = [fixtures.dex, fixtures.libraryDex];
  for (const [index, jar] of jars.entries()) {
    for (const api of ["21", "26", "28"]) {
      const out = join(scratch, "oracle", `${String(index)}-${api}`);
      await mkdir(out, { recursive: true });
      await exec(
        join(tools.buildTools, "d8"),
        ["--min-api", api, "--lib", tools.androidJar, "--output", out, jar],
        {
          env: {
            PATH: `${join(tools.javaHome, "bin")}:/usr/bin:/bin`,
            JAVA_HOME: tools.javaHome,
          },
          maxBuffer: 64 * 1024 ** 2,
        },
      );
      for (const name of (await readdir(out)).filter((file) =>
        file.endsWith(".dex"),
      ))
        oracleInputs.push(join(out, name));
    }
    report.inputs.push({
      path: basename(jar),
      sha256: sha256(await readFile(jar)),
    });
  }
  if (jars.length === 0)
    report.omitted.push(
      "large real JARs for the dexdump oracle (set REA_ANDROID_LANE_JARS)",
    );
  const oracle = await exec(
    process.execPath,
    [
      join(repository, "node_modules/vitest/vitest.mjs"),
      "run",
      "--project",
      "adapters",
      "src/androidPackage/dex/dexdump.test.ts",
    ],
    {
      cwd: repository,
      env: { ...process.env, REA_DEX_ORACLE_INPUTS: oracleInputs.join(":") },
      maxBuffer: 256 * 1024 ** 2,
    },
  );
  assert.match(oracle.stdout, /Tests\s+\d+ passed/u);
  summary.push(
    `dexdump oracle: ${String(oracleInputs.length)} DEX files (${String(jars.length)} real JARs at min-api 21/26/28) identical`,
  );
  report.passed.push("dexdump-oracle");

  // dex2jar + Vineflower reconstruction of a spread of real classes. The tools'
  // quality is reported, not asserted; the checks must agree with themselves.
  const decompileSample = Number(
    process.env.REA_ANDROID_DECOMPILE_SAMPLE ?? 24,
  );
  const decompileInputs = [
    fixtures.dex,
    fixtures.libraryDex,
    ...oracleInputs.slice(2),
  ];
  const candidates = [];
  for (const path of decompileInputs) {
    const listed = await result(
      "inspect-android-artifact",
      path,
      "--limit",
      "5000",
    );
    for (const entry of listed.classes)
      if (entry.descriptor !== null) candidates.push([path, entry.descriptor]);
  }
  const step = Math.max(1, Math.floor(candidates.length / decompileSample));
  const sample = candidates
    .filter((_, index) => index % step === 0)
    .slice(0, decompileSample);
  const counts = {
    classes: 0,
    tool_failed: 0,
    complete: 0,
    translated: 0,
    clean: 0,
    present: 0,
  };
  let decompilers = true;
  for (const [path, descriptor] of sample) {
    let evidence;
    try {
      evidence = await run("decompile-dex-class", path, descriptor);
    } catch (cause) {
      const output = `${cause.stdout ?? ""}`;
      if (
        /"capability_unavailable"|cannot execute decompile_dex_class/u.test(
          output,
        )
      ) {
        decompilers = false;
        report.omitted.push(
          "decompile-dex-class (no admitted dex2jar and Vineflower installed)",
        );
        console.log(
          "UNVERIFIED (no admitted dex2jar and Vineflower installed): decompile-dex-class",
        );
        break;
      }
      // dex2jar or Vineflower can stop on real bytecode; that is counted, not a lane failure.
      if (/(dex2jar|Vineflower) (exited|wrote no)|"timeout"/u.test(output)) {
        counts.classes += 1;
        counts.tool_failed += 1;
        continue;
      }
      throw new Error(
        `${basename(path)} ${descriptor}: decompile failed: ${output.slice(0, 500)}`,
        { cause },
      );
    }
    const decompiled = evidence.normalized_result;
    const where = `${basename(path)} ${descriptor}`;
    const state = (id) =>
      decompiled.checks.find((check) => check.id === id)?.state;
    assert.equal(evidence.confidence, "inferred", `${where}: confidence`);
    assert.equal(decompiled.class.descriptor, descriptor, `${where}: class`);
    assert.deepEqual(
      decompiled.source.derived_from,
      [decompiled.selection.dex_sha256],
      `${where}: derived_from`,
    );
    assert.ok(decompiled.source.text.length > 0, `${where}: text`);
    assert.equal(
      state("methods_present"),
      decompiled.missing_methods.length === 0 ? "not_checked" : "failed",
      `${where}: missing methods agree`,
    );
    assert.equal(
      state("vineflower_clean") === "passed",
      decompiled.decompiler_notes.length === 0 &&
        !decompiled.untrusted_methods.some(
          (entry) => entry.source === "class_file",
        ),
      `${where}: notes agree`,
    );
    if (
      decompiled.untrusted_methods.some((entry) => entry.source === "dex2jar")
    )
      assert.equal(state("dex2jar_translated"), "failed", `${where}: dex2jar`);
    assert.equal(
      decompiled.coverage[0].state === "complete",
      decompiled.checks.every((check) => check.state === "passed") &&
        decompiled.missing_nested.length === 0,
      `${where}: coverage agrees`,
    );
    counts.classes += 1;
    if (decompiled.coverage[0].state === "complete") counts.complete += 1;
    if (state("dex2jar_translated") === "passed") counts.translated += 1;
    if (state("vineflower_clean") === "passed") counts.clean += 1;
    if (state("methods_present") === "passed") counts.present += 1;
  }
  if (decompilers) {
    summary.push(
      `decompile-dex-class: ${String(counts.classes)} classes from ${String(decompileInputs.length)} DEX files; all checks passed ${String(counts.complete)}, dex2jar_translated ${String(counts.translated)}, vineflower_clean ${String(counts.clean)}, methods_present ${String(counts.present)}, tool stopped ${String(counts.tool_failed)}`,
    );
    report.decompile = counts;
    report.passed.push("decompile-dex-class");
  }

  // Handoff: one APK extracted from the set, read by the JADX tools.
  const jadxJar =
    process.env.REA_JADX_MCP_JAR ??
    join(
      repository,
      "_reference/apk-integration/jadx-headless-mcp-0.7.1-all.jar",
    );
  const sharedJar = join(
    repository,
    "..",
    "..",
    "_reference/apk-integration/jadx-headless-mcp-0.7.1-all.jar",
  );
  const engine = (await exists(jadxJar))
    ? jadxJar
    : (await exists(sharedJar))
      ? sharedJar
      : null;
  const extracted = await result("extract-artifact", fixtures.apks);
  extractionRoots.push(extracted.output_root);
  const master = join(extracted.output_root, "splits/base-master.apk");
  assert.ok(
    await exists(master),
    "extract-artifact wrote splits/base-master.apk",
  );
  report.passed.push("extract-split");
  if (engine === null)
    report.omitted.push(
      "JADX handoff (run npm run fixtures:android or set REA_JADX_MCP_JAR)",
    );
  else {
    const { stdout } = await exec(
      process.execPath,
      [
        cli,
        "inspect-android-class",
        master,
        "com.example.oops.MainActivity",
        "--json",
      ],
      {
        env: {
          ...process.env,
          REA_JADX_MCP_JAR: engine,
          REA_LOG_LEVEL: "silent",
        },
        maxBuffer: 64 * 1024 ** 2,
      },
    );
    const jadx = JSON.parse(stdout).normalized_result;
    assert.equal(jadx.class_name, "com.example.oops.MainActivity");
    summary.push(
      `JADX handoff: ${String(jadx.methods.length)} methods of MainActivity from the extracted base master`,
    );
    report.passed.push("jadx-handoff");
  }
  const unpacked = await result("extract-artifact", fixtures.apk);
  extractionRoots.push(unpacked.output_root);
  const native = join(unpacked.output_root, "lib/arm64-v8a/libnative.so");
  assert.ok(
    await exists(native),
    "extract-artifact wrote lib/arm64-v8a/libnative.so",
  );
  const header = await readFile(native);
  assert.equal(header.subarray(0, 4).toString("latin1"), "\x7fELF");
  assert.equal(header.readUInt16LE(18), 183);
  summary.push("native handoff: extracted libnative.so is ELF aarch64");
  report.passed.push("native-handoff");

  for (const line of summary) console.log(line);
  if (process.env.REA_ANDROID_LANE_REPORT !== undefined)
    await writeFile(
      process.env.REA_ANDROID_LANE_REPORT,
      `${JSON.stringify(report, null, 2)}\n`,
    );
  if (report.omitted.length > 0)
    console.log(`OMITTED: ${report.omitted.join("; ")}`);
  console.log("PASS verify:formats:android");
} finally {
  for (const path of [scratch, ...extractionRoots])
    await rm(path, { recursive: true, force: true });
}
