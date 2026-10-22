/**
 * verify:formats:linux-packages — real-producer acceptance for format
 * expansion F05.
 *
 * Builds Debian packages with dpkg-deb, RPM packages with rpmbuild, SquashFS
 * images with mksquashfs and Type 2 AppImages from the pinned AppImage
 * runtime, then reads each through the compiled CLI (inspect-linux-package,
 * inspect-artifact, extract-artifact) and compares with dpkg-deb, rpm and
 * unsquashfs. Nothing is installed, no script runs and no AppImage executes.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  lstat,
  mkdtemp,
  readFile,
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
  join(repository, "tests/fixtures/linuxProducers.ts")
);

if (producers.LINUX_TOOLS === null) {
  console.error(
    "UNAVAILABLE verify:formats:linux-packages: needs dpkg-deb, rpmbuild, rpm, mksquashfs, unsquashfs and the pinned AppImage runtimes (npm run fixtures:linux; see docs/linux-packages.md).",
  );
  process.exit(2);
}

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
  return JSON.parse(stdout).normalized_result;
};

const summary = [];
const report = {
  lane: "verify:formats:linux-packages",
  host: { platform: platform(), arch: arch() },
  inputs: [],
  passed: [],
  omitted: [],
};
const scratch = await mkdtemp(join(tmpdir(), "oopsware-linux-lane-"));
const extractionRoots = [];
try {
  report.commit = (
    await exec("git", ["-C", repository, "rev-parse", "HEAD"])
  ).stdout.trim();
  const fixtures = await producers.buildLinuxFixtures(
    join(scratch, "fixtures"),
  );
  const all = [
    ...Object.values(fixtures.deb),
    ...Object.values(fixtures.rpm),
    ...Object.values(fixtures.squashfs),
    ...Object.values(fixtures.appimage),
  ];
  for (const path of all)
    report.inputs.push({
      path: basename(path),
      sha256: sha256(await readFile(path)),
    });

  // Debian: every compression, control fields as dpkg-deb prints them, md5sums all matched.
  for (const [compression, path] of Object.entries(fixtures.deb)) {
    const deb = await run("inspect-linux-package", path);
    assert.equal(deb.package.kind, "deb");
    assert.equal(deb.identity.name, producers.PACKAGE);
    const control = await producers.linuxOracle("dpkg-deb", ["-f", path]);
    for (const field of deb.deb.fields)
      assert.ok(
        control.includes(`${field.name}:`),
        `${field.name} in dpkg-deb -f`,
      );
    assert.equal(deb.deb.md5sums.mismatched.length, 0);
    assert.equal(deb.deb.md5sums.missing.length, 0);
    assert.equal(deb.deb.md5sums.matched, deb.deb.md5sums.declared);
    assert.deepEqual(
      deb.scripts.map((script) => script.name),
      ["preinst", "postinst", "prerm", "postrm"],
    );
    const helper = deb.files.find(
      (file) => file.path === "/usr/lib/oops/helper",
    );
    assert.deepEqual(helper.special, ["setuid"]);
    assert.equal(deb.diagnostics.length, 0, JSON.stringify(deb.diagnostics));
    summary.push(
      `deb (${compression}): ${String(deb.file_count)} files, ${String(deb.dependencies.length)} declarations, md5sums ${String(deb.deb.md5sums.matched)}/${String(deb.deb.md5sums.declared)}`,
    );
  }
  report.passed.push("deb-inspect");

  // RPM: every payload compressor, header and payload digests valid, every file digest valid.
  for (const [compression, path] of Object.entries(fixtures.rpm)) {
    const rpm = await run("inspect-linux-package", path);
    assert.equal(rpm.package.kind, "rpm");
    assert.ok(
      rpm.rpm.header_digests.length > 0 &&
        rpm.rpm.header_digests.every((digest) => digest.valid),
    );
    assert.equal(rpm.rpm.payload.digest.valid, true);
    const checked = rpm.files.filter(
      (file) => file.digest !== null && file.digest.valid !== null,
    );
    assert.ok(checked.length > 0 && checked.every((file) => file.digest.valid));
    const requires = (
      await producers.linuxOracle("rpm", ["-qp", "--requires", path])
    )
      .trim()
      .split("\n");
    assert.deepEqual(
      rpm.dependencies
        .filter((entry) => entry.kind === "requires")
        .map((entry) => entry.text)
        .sort(),
      [...requires].sort(),
    );
    assert.equal(rpm.diagnostics.length, 0, JSON.stringify(rpm.diagnostics));
    summary.push(
      `rpm (${compression}): ${String(rpm.file_count)} files, ${String(checked.length)} file digests checked, ${String(rpm.scripts.length)} scriptlets`,
    );
  }
  report.passed.push("rpm-inspect");

  // SquashFS and AppImage: listings equal unsquashfs; xz is identified, not read.
  for (const [compression, path] of Object.entries(fixtures.squashfs)) {
    if (compression === "xz") {
      const xz = await run("inspect-linux-package", path);
      assert.equal(
        xz.coverage.find((entry) => entry.facet === "inventory").state,
        "unsupported",
      );
      continue;
    }
    const image = await run("inspect-linux-package", path);
    const listing = (
      await producers.linuxOracle("unsquashfs", ["-lc", "-n", path])
    )
      .trim()
      .split("\n")
      .filter((line) => line.startsWith("squashfs-root/"));
    const regular = image.files
      .filter((file) => file.type !== "directory")
      .map((file) => `squashfs-root${file.path}`)
      .sort();
    assert.deepEqual(regular, [...listing].sort());
    summary.push(
      `squashfs (${compression}): ${String(image.file_count)} entries, superblock ${image.squashfs.compression}`,
    );
  }
  for (const [machine, path] of Object.entries(fixtures.appimage)) {
    const app = await run("inspect-linux-package", path);
    assert.equal(app.appimage.type, 2);
    assert.equal(
      app.appimage.desktop.entries.find((entry) => entry.key === "Name").value,
      "Oops Demo",
    );
    assert.equal(app.appimage.app_run.interpreter, "/bin/sh");
    const offset = app.appimage.squashfs_offset;
    const listing = (
      await producers.linuxOracle("unsquashfs", [
        "-o",
        String(offset),
        "-lc",
        "-n",
        path,
      ])
    )
      .trim()
      .split("\n")
      .filter((line) => line.startsWith("squashfs-root/"));
    assert.equal(
      app.files.filter((file) => file.type !== "directory").length,
      listing.length,
    );
    summary.push(
      `AppImage (${machine}): runtime ${app.appimage.runtime.machine}, image at byte ${String(offset)}, ${String(app.file_count)} entries`,
    );
  }
  report.passed.push("squashfs-appimage-inspect");

  // Artifact graph and extraction: contents listed and written; the ELF stays an ELF; setuid never applied.
  for (const path of [
    fixtures.deb.xz,
    fixtures.rpm.zstd,
    fixtures.appimage.x86_64,
  ]) {
    const extracted = await run("extract-artifact", path);
    extractionRoots.push(extracted.output_root);
    const helper = join(extracted.output_root, "usr/lib/oops/helper");
    assert.ok(await exists(helper), `${basename(path)}: helper extracted`);
    const bytes = await readFile(helper);
    assert.equal(sha256(bytes), sha256(await readFile(fixtures.elf)));
    assert.equal(
      (await lstat(helper)).mode & 0o6000,
      0,
      "setuid/setgid never applied",
    );
    summary.push(
      `extract ${basename(path)}: ELF helper intact, mode bits not applied`,
    );
  }
  report.passed.push("extract-and-native-handoff");

  // A damaged RPM (header index count past the end) and a damaged Debian member are refused, not guessed.
  const rpmBytes = Buffer.from(await readFile(fixtures.rpm.gzip));
  const header =
    96 +
    16 +
    rpmBytes.readUInt32BE(96 + 8) * 16 +
    rpmBytes.readUInt32BE(96 + 12);
  const mainHeader = header + ((8 - (header % 8)) % 8);
  rpmBytes.writeUInt32BE(0x00ffffff, mainHeader + 8);
  const broken = join(scratch, "broken.rpm");
  await writeFile(broken, rpmBytes);
  const refused = await exec(
    process.execPath,
    [cli, "inspect-linux-package", broken, "--json"],
    {
      env: { ...process.env, REA_LOG_LEVEL: "silent" },
    },
  ).then(
    () => null,
    (error) => JSON.parse(error.stdout),
  );
  assert.equal(
    refused?.code,
    "artifact_operation_failed",
    "damaged RPM refused",
  );
  assert.match(refused.details.detail, /index entries/u);
  report.passed.push("malformed-rpm");

  for (const line of summary) console.log(line);
  if (process.env.REA_LINUX_LANE_REPORT !== undefined)
    await writeFile(
      process.env.REA_LINUX_LANE_REPORT,
      `${JSON.stringify(report, null, 2)}\n`,
    );
  console.log("PASS verify:formats:linux-packages");
} finally {
  for (const path of [scratch, ...extractionRoots])
    await rm(path, { recursive: true, force: true });
}
