import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LinuxPackageProvider } from "./LinuxPackageProvider.js";
import { SquashfsArtifactReader } from "../artifacts/SquashfsArtifactReader.js";
import { StreamArchiveArtifactReader } from "../artifacts/archives/StreamArchiveArtifactReader.js";
import type {
  ArtifactEntry,
  ArtifactReader,
} from "../artifacts/ArtifactReader.js";
import {
  inspectLinuxPackageInputSchema,
  linuxPackageReportSchema,
  type LinuxPackageReport,
} from "../domain/linuxPackage/linuxPackage.js";
import {
  buildLinuxFixtures,
  CONFIG_TEXT,
  LINUX_TOOLS,
  linuxOracle,
  PACKAGE,
  SCRIPT_TEXT,
  type LinuxFixtures,
} from "../../tests/fixtures/linuxProducers.js";
import { removeTestWorkspace } from "../../tests/support/workspace/workspaceFixture.js";

const provider = new LinuxPackageProvider();

const inspect = async (
  input: Record<string, unknown>,
): Promise<LinuxPackageReport> => {
  const result = await provider.inspectPackage(
    inspectLinuxPackageInputSchema.parse(input),
  );
  if (!result.ok) throw result.error;
  return linuxPackageReportSchema.parse(result.value);
};

const failure = async (input: Record<string, unknown>) => {
  const result = await provider.inspectPackage(
    inspectLinuxPackageInputSchema.parse(input),
  );
  if (result.ok) throw new Error("expected a failure");
  return { tag: result.error._tag, message: result.error.message };
};

/** Every entry a reader lists, with the SHA-256 of each regular file it opens. */
const readAll = async (reader: ArtifactReader) => {
  const listed: { entry: ArtifactEntry; sha256: string | null }[] = [];
  try {
    for await (const entry of reader.entries()) {
      if (entry.kind !== "file") {
        listed.push({ entry, sha256: null });
        continue;
      }
      const hash = createHash("sha256");
      for await (const piece of await reader.open(entry))
        hash.update(piece as Buffer);
      listed.push({ entry, sha256: hash.digest("hex") });
    }
  } finally {
    await reader.close();
  }
  return listed;
};

let root = "";
let fixtures: LinuxFixtures;
let elfSha256 = "";
let built: Promise<void> | null = null;

const setup = (): Promise<void> => {
  built ??= (async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "rea-linux-reports-")));
    fixtures = await buildLinuxFixtures(root);
    elfSha256 = createHash("sha256")
      .update(await readFile(fixtures.elf))
      .digest("hex");
  })();
  return built;
};

afterAll(async () => {
  if (root !== "") await removeTestWorkspace(root);
});

const suite = describe.skipIf(LINUX_TOOLS === null);

suite("Debian packages", () => {
  beforeAll(setup, 120_000);

  it("reads control fields, relations, scripts and conffiles, and rechecks md5sums for every compression", async () => {
    for (const [compression, path] of Object.entries(fixtures.deb)) {
      const report = await inspect({ path });
      expect(report.package.kind).toBe("deb");
      expect(report.identity).toMatchObject({
        name: PACKAGE,
        version: "1.2.3",
        release: "1",
        architecture: "amd64",
      });
      expect(report.deb?.data_compression).toBe(compression);
      const oracle = await linuxOracle("dpkg-deb", ["-f", path, "Depends"]);
      expect(
        report.dependencies
          .filter((entry) => entry.kind === "depends")
          .map((entry) => entry.text)
          .join(", "),
      ).toBe(oracle.trim());
      const libssl = report.dependencies
        .flatMap((entry) => entry.alternatives)
        .find((entry) => entry.name === "libssl3");
      expect(libssl).toMatchObject({
        architecture: "amd64",
        operator: ">>",
        version: "3.0.0~",
      });
      expect(
        report.dependencies.find((entry) => entry.text === "bash | dash")
          ?.alternatives,
      ).toHaveLength(2);
      expect(
        report.scripts.find((script) => script.name === "postinst"),
      ).toMatchObject({ interpreter: "/bin/sh", text: SCRIPT_TEXT });
      expect(
        report.scripts.find((script) => script.name === "postrm")?.interpreter,
      ).toBe("/bin/bash");
      expect(report.triggers).toEqual([
        {
          kind: "interest-noawait",
          condition: "/usr/share/oops",
          interpreter: null,
          text: null,
        },
      ]);
      expect(report.deb?.conffiles).toEqual(["/etc/oops/oops.conf"]);
      expect(report.deb?.md5sums).toMatchObject({
        mismatched: [],
        missing: [],
        unlisted: 0,
      });
      const conf = report.files.find(
        (file) => file.path === "/etc/oops/oops.conf",
      );
      expect(conf).toMatchObject({
        flags: ["conffile"],
        size: CONFIG_TEXT.length,
        user: "root",
        digest: { algorithm: "md5", valid: true },
      });
      expect(
        report.files.find((file) => file.path === "/usr/lib/oops/helper"),
      ).toMatchObject({ mode: "4755", special: ["setuid"] });
      expect(
        report.files.find(
          (file) => file.path === "/usr/share/doc/oops/oops-link",
        ),
      ).toMatchObject({ type: "symlink", link_target: "../../../bin/oops" });
      expect(report.diagnostics).toEqual([]);
    }
  });

  it("names an md5sums mismatch and refuses a damaged ar member", async () => {
    const bytes = Buffer.from(await readFile(fixtures.deb.none));
    // The uncompressed data.tar holds oops.conf's bytes verbatim; change one of them.
    const at = bytes.indexOf(Buffer.from(CONFIG_TEXT));
    bytes[at] = 0x4c;
    const changed = join(root, "changed.deb");
    await writeFile(changed, bytes);
    const report = await inspect({ path: changed });
    expect(report.deb?.md5sums?.mismatched).toEqual(["/etc/oops/oops.conf"]);
    expect(
      report.files.find((file) => file.path === "/etc/oops/oops.conf")?.digest
        ?.valid,
    ).toBe(false);

    const damaged = Buffer.from(await readFile(fixtures.deb.xz));
    // The second member's decimal size field (header at 8 + 60 + 4, size at +48) claims far more than the file.
    damaged.write("9999999999", 8 + 60 + 4 + 48, "latin1");
    const broken = join(root, "broken.deb");
    await writeFile(broken, damaged);
    expect((await failure({ path: broken })).tag).toBe(
      "ArtifactOperationError",
    );
  });
});

suite("RPM packages", () => {
  beforeAll(setup, 120_000);

  it("reads dependencies, scriptlets, triggers and files, and rechecks header, payload and file digests", async () => {
    for (const [compression, path] of Object.entries(fixtures.rpm)) {
      const report = await inspect({ path });
      expect(report.package.kind).toBe("rpm");
      expect(report.rpm?.payload.compressor).toBe(compression);
      expect(report.rpm?.payload.digest?.valid).toBe(true);
      expect(report.rpm?.header_digests.every((digest) => digest.valid)).toBe(
        true,
      );
      const requires = (await linuxOracle("rpm", ["-qp", "--requires", path]))
        .trim()
        .split("\n")
        .sort();
      expect(
        report.dependencies
          .filter((entry) => entry.kind === "requires")
          .map((entry) => entry.text)
          .sort(),
      ).toEqual(requires);
      expect(
        report.dependencies.find((entry) => entry.text === "(curl or wget)")
          ?.rich,
      ).toBe(true);
      expect(
        report.scripts.map((script) => [script.name, script.interpreter]),
      ).toEqual(
        expect.arrayContaining([
          ["post", "/bin/bash"],
          ["postun", "<lua>"],
        ]),
      );
      expect(report.triggers[0]).toMatchObject({
        kind: "triggerin",
        condition: "bash",
      });
      const helper = report.files.find(
        (file) => file.path === "/usr/lib/oops/helper",
      );
      expect(helper).toMatchObject({
        special: ["setuid"],
        digest: { declared: elfSha256, valid: true },
      });
      expect(
        report.files.find((file) => file.path === "/var/log/oops.log")?.flags,
      ).toContain("ghost");
      expect(
        report.files.find((file) => file.path === "/etc/oops/oops.conf")?.flags,
      ).toEqual(expect.arrayContaining(["config", "noreplace"]));
      expect(report.diagnostics).toEqual([]);
    }
  });

  it("refuses a header whose index count runs past the file", async () => {
    const bytes = Buffer.from(await readFile(fixtures.rpm.gzip));
    // Signature header at 96: 16-byte intro, index entries, data, padded to 8; then the main header's count at +8.
    const end =
      96 + 16 + bytes.readUInt32BE(104) * 16 + bytes.readUInt32BE(108);
    bytes.writeUInt32BE(0x00ffffff, end + ((8 - (end % 8)) % 8) + 8);
    const broken = join(root, "broken.rpm");
    await writeFile(broken, bytes);
    expect((await failure({ path: broken })).tag).toBe(
      "ArtifactOperationError",
    );
  });
});

suite("AppImages and SquashFS images", () => {
  beforeAll(setup, 120_000);

  it("reads the runtime, desktop entry and AppRun, and lists the image as unsquashfs does", async () => {
    for (const [machine, path] of Object.entries(fixtures.appimage)) {
      const report = await inspect({ path });
      const runtimeBytes = (
        await readFile(join(LINUX_TOOLS?.runtimes ?? "", `runtime-${machine}`))
      ).length;
      expect(report.appimage).toMatchObject({
        type: 2,
        squashfs_offset: runtimeBytes,
        runtime: { machine, bytes: runtimeBytes },
      });
      expect(report.appimage?.app_run).toMatchObject({
        type: "file",
        interpreter: "/bin/sh",
      });
      expect(report.appimage?.icon).toBe("oops.png");
      expect(report.identity).toMatchObject({
        name: "Oops Demo",
        version: "1.2.3",
        architecture: machine,
      });
      const listing = (
        await linuxOracle("unsquashfs", [
          "-o",
          String(runtimeBytes),
          "-lc",
          "-n",
          path,
        ])
      )
        .trim()
        .split("\n")
        .filter((line) => line.startsWith("squashfs-root/"))
        .map((line) => line.slice("squashfs-root".length))
        .sort();
      // unsquashfs -lc lists every non-directory entry.
      expect(
        report.files
          .filter((file) => file.type !== "directory")
          .map((file) => file.path)
          .sort(),
      ).toEqual(listing);
    }
    const typeOne = Buffer.from(await readFile(fixtures.appimage.x86_64));
    typeOne[10] = 1;
    const legacy = join(root, "legacy.AppImage");
    await writeFile(legacy, typeOne);
    const identified = await inspect({ path: legacy });
    expect(identified.appimage?.type).toBe(1);
    expect(
      identified.coverage.find((entry) => entry.facet === "inventory")?.state,
    ).toBe("unsupported");
  });

  it("identifies an xz image without reading it", async () => {
    const report = await inspect({ path: fixtures.squashfs.xz });
    expect(report.squashfs?.compression).toBe("xz");
    expect(report.files).toEqual([]);
    expect(report.diagnostics[0]?.message).toMatch(/compression xz/u);
  });
});

suite("Package contents in the artifact graph", () => {
  beforeAll(setup, 120_000);

  it("streams .deb and .rpm contents and reads AppImage images, never applying special modes", async () => {
    for (const reader of [
      new StreamArchiveArtifactReader(fixtures.deb.xz, "deb"),
      new StreamArchiveArtifactReader(fixtures.deb.zstd, "deb"),
      new StreamArchiveArtifactReader(fixtures.rpm.zstd, "rpm"),
      new StreamArchiveArtifactReader(fixtures.rpm.gzip, "rpm"),
      new SquashfsArtifactReader(fixtures.appimage.x86_64, "appimage"),
      new SquashfsArtifactReader(fixtures.squashfs.lz4, "squashfs"),
    ]) {
      const listed = await readAll(reader);
      const helper = listed.find(
        (item) => item.entry.path === "usr/lib/oops/helper",
      );
      expect(helper?.sha256, reader.format).toBe(elfSha256);
      expect(helper?.entry.limitations.join(" ")).toMatch(
        /setuid\); only the bytes are materialized/u,
      );
      expect(
        listed.find(
          (item) => item.entry.path === "usr/share/doc/oops/oops-link",
        )?.entry.kind,
      ).toBe("symlink");
      expect(
        listed.some(
          (item) =>
            item.entry.path === "usr/share/doc/oops/names/ünïcode file.txt",
        ),
      ).toBe(true);
    }
    const image = new SquashfsArtifactReader(fixtures.squashfs.xz, "squashfs");
    expect(await readAll(image)).toEqual([]);
    expect(image.omissions()[0]).toMatch(/compression xz/u);
  });
});
