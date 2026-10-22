/**
 * verify:formats:windows-packages — real-producer acceptance for format
 * expansion F08.
 *
 * Builds Windows Installer packages with msitools' wixl (an embedded MSZIP
 * cabinet, and an external cabinet wixl declares but does not write), a
 * companion cabinet with gcab, and MSIX packages and a bundle assembled from
 * the published schemas (no MSIX producer runs on macOS). Each is read
 * through the compiled CLI (inspect-windows-installer, inspect-msix-package,
 * inspect-artifact, extract-artifact) and compared with msiinfo, msiextract
 * and gcab. Nothing is installed and no custom action or embedded program
 * runs.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { arch, platform, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const cli = join(repository, "scripts/oopsware.mjs");
const producers = await import(
  join(repository, "tests/fixtures/windowsProducers.ts")
);

if (producers.WINDOWS_TOOLS === null) {
  console.error(
    "UNAVAILABLE verify:formats:windows-packages: needs msitools (wixl, msiinfo, msiextract), gcab, 7zz and the pinned payload binary (npm run fixtures:linux; see docs/windows-installers.md).",
  );
  process.exit(2);
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const run = async (...args) => {
  const { stdout } = await exec(process.execPath, [cli, ...args, "--json"], {
    maxBuffer: 512 * 1024 ** 2,
    env: { ...process.env, REA_LOG_LEVEL: "silent" },
  });
  return JSON.parse(stdout).normalized_result;
};
const refusal = (...args) =>
  exec(process.execPath, [cli, ...args, "--json"], {
    env: { ...process.env, REA_LOG_LEVEL: "silent" },
  }).then(
    () => null,
    (error) => JSON.parse(error.stdout),
  );
/** Every file below a folder, relative and sorted. */
const walk = async (root) => {
  const found = [];
  for (const entry of await readdir(root, {
    recursive: true,
    withFileTypes: true,
  }))
    if (entry.isFile())
      found.push(relative(root, join(entry.parentPath, entry.name)));
  return found.sort();
};
/** msiinfo export lines: header, types, keys, then one row per line (CRLF, tab-separated). */
const exportRows = async (msi, table, cwd) =>
  (await producers.windowsOracle("msiinfo", ["export", msi, table], cwd))
    .toString("latin1")
    .split("\r\n")
    .slice(3)
    .filter((line) => line.length > 0)
    .map((line) => line.split("\t"));

const summary = [];
const report = {
  lane: "verify:formats:windows-packages",
  host: { platform: platform(), arch: arch() },
  inputs: [],
  passed: [],
  omitted: [
    "LZX and Quantum cabinets: no producer here writes them.",
    "Real Windows-built or WiX-built MSIs and producer-made MSIX packages: none available on this host.",
    "Signatures: recorded by size, never verified.",
  ],
};
const scratch = await mkdtemp(join(tmpdir(), "oopsware-windows-lane-"));
const extractionRoots = [];
try {
  report.commit = (
    await exec("git", ["-C", repository, "rev-parse", "HEAD"])
  ).stdout.trim();
  const fixtures = await producers.buildWindowsFixtures(
    join(scratch, "fixtures"),
  );
  const oracleRoot = join(scratch, "oracle");
  await mkdir(oracleRoot);
  for (const path of [
    fixtures.msi,
    fixtures.msiExternal,
    fixtures.cabinet,
    fixtures.cabinetStored,
    ...Object.values(fixtures.msix),
    fixtures.msixbundle,
  ])
    report.inputs.push({
      path: basename(path),
      sha256: sha256(await readFile(path)),
    });
  const payload = sha256(await readFile(fixtures.payload));
  const before = await walk(join(scratch, "fixtures"));

  // MSI: every table msiinfo lists, row counts equal its export, custom actions as stored.
  const msi = await run("inspect-windows-installer", fixtures.msi);
  const tables = (
    await producers.windowsOracle("msiinfo", ["tables", fixtures.msi])
  )
    .toString("latin1")
    .trim()
    .split("\n")
    .filter((name) => !name.startsWith("_"));
  const listed = new Map(msi.tables.map((table) => [table.name, table.rows]));
  for (const table of tables) {
    assert.ok(listed.has(table), `${table} listed`);
    assert.equal(
      listed.get(table),
      (await exportRows(fixtures.msi, table, oracleRoot)).length,
      `${table} rows`,
    );
  }
  const actions = await exportRows(fixtures.msi, "CustomAction", oracleRoot);
  assert.deepEqual(
    msi.custom_actions.map((action) => [action.id, String(action.type)]).sort(),
    actions.map((row) => [row[0], row[1]]).sort(),
  );
  assert.ok(msi.custom_actions.every((action) => action.scheduled.length > 0));
  const suminfo = (
    await producers.windowsOracle("msiinfo", ["suminfo", fixtures.msi])
  ).toString("latin1");
  assert.ok(suminfo.includes(`Template: ${msi.summary.template}`));
  assert.ok(
    suminfo.includes(`Revision number (UUID): ${msi.summary.revision}`),
  );
  assert.ok(
    msi.files.every(
      (file) => file.status === "read" && file.md5.valid === true,
    ),
  );
  assert.equal(msi.diagnostics.length, 0, JSON.stringify(msi.diagnostics));
  summary.push(
    `msi: ${String(tables.length)} tables equal msiinfo export, ${String(msi.custom_actions.length)} custom actions, ${String(msi.file_count)} files with MsiFileHash rechecked`,
  );
  report.passed.push("msi-tables");

  // Files: resolved target paths equal msiextract's, bytes equal what msiextract writes.
  const extractedByMsitools = join(oracleRoot, "msiextract");
  await producers.windowsOracle("msiextract", [
    "-C",
    extractedByMsitools,
    fixtures.msi,
  ]);
  const oracleFiles = await walk(extractedByMsitools);
  assert.deepEqual(
    msi.files
      .map((file) => file.target_path.split("/").slice(1).join("/"))
      .sort(),
    oracleFiles,
  );
  for (const file of msi.files) {
    const bytes = await readFile(
      join(extractedByMsitools, file.target_path.split("/").slice(1).join("/")),
    );
    assert.equal(file.sha256, sha256(bytes), file.target_path);
  }
  const extracted = await run("extract-artifact", fixtures.msi);
  extractionRoots.push(extracted.output_root);
  const written = await walk(extracted.output_root);
  assert.deepEqual(written, [
    "Binary/SetupDll",
    "ProgramFiles64Folder/Oops/readme.txt",
    "ProgramFiles64Folder/Oops/tool.exe",
  ]);
  assert.equal(
    sha256(
      await readFile(
        join(extracted.output_root, "ProgramFiles64Folder/Oops/tool.exe"),
      ),
    ),
    payload,
  );
  summary.push(
    `msi extract: ${String(written.length)} files at their target directories, equal to msiextract`,
  );
  report.passed.push("msi-extract");

  // External cabinet: never searched for; read only when supplied, bound by its digest.
  const external = await run("inspect-windows-installer", fixtures.msiExternal);
  assert.ok(external.files.every((file) => file.status === "cabinet-missing"));
  const supplied = await run(
    "inspect-windows-installer",
    fixtures.msiExternal,
    "--cabinets",
    fixtures.cabinet,
  );
  assert.ok(
    supplied.files.every(
      (file) => file.status === "read" && file.md5.valid === true,
    ),
  );
  assert.equal(
    supplied.cabinets[0].sha256,
    sha256(await readFile(fixtures.cabinet)),
  );
  // gcab -l: "<name> <size> <date> <time> <attributes>" per member.
  const members = (
    await producers.windowsOracle("gcab", ["-l", fixtures.cabinet])
  )
    .toString("latin1")
    .trim()
    .split("\n")
    .map((line) => /^(.*) (\d+) \S+ \S+ 0x[0-9a-f]+$/u.exec(line))
    .map((match) => [match[1], Number(match[2])])
    .sort();
  assert.deepEqual(
    supplied.files.map((file) => [file.key, file.size]).sort(),
    members,
  );
  summary.push(
    "msi external cabinet: missing when not supplied; read and bound by SHA-256 when supplied",
  );
  report.passed.push("msi-external-cabinet");

  // Damage: a truncated package and a damaged cabinet block are reported, not guessed.
  const whole = await readFile(fixtures.msi);
  const truncated = join(scratch, "truncated.msi");
  await writeFile(truncated, whole.subarray(0, Math.floor(whole.length / 3)));
  const cut = await refusal("inspect-windows-installer", truncated);
  assert.equal(cut?.code, "artifact_operation_failed");
  assert.match(cut.details.detail, /truncated/u);
  const cabinet = Buffer.from(await readFile(fixtures.cabinet));
  cabinet[cabinet.length - 200] ^= 0xff;
  const brokenFolder = join(scratch, "broken");
  await mkdir(brokenFolder);
  await writeFile(join(brokenFolder, "oops.cab"), cabinet);
  const damaged = await run(
    "inspect-windows-installer",
    fixtures.msiExternal,
    "--cabinets",
    join(brokenFolder, "oops.cab"),
  );
  assert.ok(damaged.files.every((file) => file.status === "damaged"));
  summary.push(
    "msi damage: truncated package refused as truncated; damaged cabinet block marks its files damaged",
  );
  report.passed.push("msi-malformed");

  // MSIX: block maps recomputed, bundle offsets checked, a package chosen only when named.
  const bundle = await run("inspect-msix-package", fixtures.msixbundle);
  assert.deepEqual(bundle.bundle.architectures, ["arm64", "x64"]);
  assert.ok(
    bundle.bundle.packages.every(
      (entry) => entry.layout_matches && entry.block_map_verified,
    ),
  );
  assert.equal(bundle.bundle.parts.block_map.verified, true);
  const chosen = await run(
    "inspect-msix-package",
    fixtures.msixbundle,
    "--container",
    "Oops.Demo_1.2.3.0_x64.msix",
  );
  assert.equal(chosen.parts.manifest.identity.processor_architecture, "x64");
  assert.equal(chosen.parts.block_map.verified, true);
  const unknown = await refusal(
    "inspect-msix-package",
    fixtures.msixbundle,
    "--container",
    "missing.msix",
  );
  assert.equal(unknown?.code, "invalid_request");
  assert.match(JSON.stringify(unknown), /packages: Oops\.Demo/u);
  const bundleExtract = await run("extract-artifact", fixtures.msixbundle);
  extractionRoots.push(bundleExtract.output_root);
  assert.ok(
    (await walk(bundleExtract.output_root)).includes(
      "Oops.Demo_1.2.3.0_arm64.msix",
    ),
  );
  summary.push(
    `msixbundle: ${String(bundle.bundle.packages.length)} packages, offsets and block maps verified, selection explicit`,
  );
  report.passed.push("msix-bundle");

  // Nothing outside owned scratch space changed: reading wrote nothing beside the inputs.
  assert.deepEqual(await walk(join(scratch, "fixtures")), before);
  report.passed.push("no-host-changes");

  for (const line of summary) console.log(line);
  if (process.env.REA_WINDOWS_LANE_REPORT !== undefined)
    await writeFile(
      process.env.REA_WINDOWS_LANE_REPORT,
      `${JSON.stringify(report, null, 2)}\n`,
    );
  console.log("PASS verify:formats:windows-packages");
} finally {
  for (const path of [scratch, ...extractionRoots])
    await rm(path, { recursive: true, force: true });
}
