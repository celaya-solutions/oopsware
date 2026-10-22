import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import zlib from "node:zlib";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { WindowsInstallerProvider } from "./WindowsInstallerProvider.js";
import { MsiArtifactReader } from "../artifacts/MsiArtifactReader.js";
import { ZipArtifactReader } from "../artifacts/ZipArtifactReader.js";
import type { ArtifactReader } from "../artifacts/ArtifactReader.js";
import {
  inspectMsixPackageInputSchema,
  msixPackageReportSchema,
  type MsixPackageReport,
} from "../domain/windowsInstaller/msixPackage.js";
import {
  inspectWindowsInstallerInputSchema,
  windowsInstallerReportSchema,
  type WindowsInstallerReport,
} from "../domain/windowsInstaller/windowsInstaller.js";
import {
  buildWindowsFixtures,
  PRODUCT_NAME,
  README_TEXT,
  UPGRADE_CODE,
  WINDOWS_TOOLS,
  type WindowsFixtures,
} from "../../tests/fixtures/windowsProducers.js";
import { removeTestWorkspace } from "../../tests/support/workspace/workspaceFixture.js";

const provider = new WindowsInstallerProvider();

const installer = async (
  input: Record<string, unknown>,
): Promise<WindowsInstallerReport> => {
  const result = await provider.inspectInstaller(
    inspectWindowsInstallerInputSchema.parse(input),
  );
  if (!result.ok) throw result.error;
  return windowsInstallerReportSchema.parse(result.value);
};

const msix = async (
  input: Record<string, unknown>,
): Promise<MsixPackageReport> => {
  const result = await provider.inspectMsix(
    inspectMsixPackageInputSchema.parse(input),
  );
  if (!result.ok) throw result.error;
  return msixPackageReportSchema.parse(result.value);
};

const failure = async (
  kind: "installer" | "msix",
  input: Record<string, unknown>,
) => {
  const result =
    kind === "installer"
      ? await provider.inspectInstaller(
          inspectWindowsInstallerInputSchema.parse(input),
        )
      : await provider.inspectMsix(inspectMsixPackageInputSchema.parse(input));
  if (result.ok) throw new Error("expected a failure");
  const issues =
    "issues" in result.error
      ? (result.error.issues as readonly { message: string }[])
      : [];
  const detail =
    "detail" in result.error && typeof result.error.detail === "string"
      ? [result.error.detail]
      : [];
  return {
    tag: result.error._tag,
    message: [
      result.error.message,
      ...detail,
      ...issues.map((issue) => issue.message),
    ].join(" "),
  };
};

const LOCAL_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const CENTRAL_HEADER = Buffer.from([0x50, 0x4b, 0x01, 0x02]);

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** Every file entry a reader lists, with the SHA-256 of its bytes. */
const readAll = async (reader: ArtifactReader) => {
  const listed = new Map<string, string>();
  try {
    for await (const entry of reader.entries()) {
      if (entry.kind !== "file") continue;
      const hash = createHash("sha256");
      for await (const piece of await reader.open(entry))
        hash.update(piece as Buffer);
      listed.set(entry.path, hash.digest("hex"));
    }
  } finally {
    await reader.close();
  }
  return listed;
};

let root = "";
let fixtures: WindowsFixtures;
let payloadSha256 = "";
let payloadBytes = 0;
let built: Promise<void> | null = null;

const setup = (): Promise<void> => {
  built ??= (async () => {
    root = await realpath(
      await mkdtemp(join(tmpdir(), "rea-windows-reports-")),
    );
    fixtures = await buildWindowsFixtures(root);
    const payload = await readFile(fixtures.payload);
    payloadSha256 = sha256(payload);
    payloadBytes = payload.length;
  })();
  return built;
};

afterAll(async () => {
  if (root !== "") await removeTestWorkspace(root);
});

const suite = describe.skipIf(WINDOWS_TOOLS === null);

suite("Windows Installer packages", () => {
  beforeAll(setup, 120_000);

  it("reads product, tables, declarations and custom actions, and rechecks MsiFileHash", async () => {
    const report = await installer({ path: fixtures.msi });
    expect(report.product).toMatchObject({
      name: PRODUCT_NAME,
      version: "1.2.3",
      upgrade_code: UPGRADE_CODE,
    });
    expect(report.summary?.platforms).toEqual(["x64"]);
    expect(report.tables.find((table) => table.name === "File")?.rows).toBe(2);
    expect(
      report.files.map((file) => [
        file.target_path,
        file.status,
        file.md5?.valid,
      ]),
    ).toEqual([
      ["ProgramFiles64Folder/Oops/tool.exe", "read", true],
      ["ProgramFiles64Folder/Oops/readme.txt", "read", true],
    ]);
    expect(report.files[0]?.sha256).toBe(payloadSha256);
    expect(
      report.custom_actions.map((action) => [action.id, action.source_kind]),
    ).toEqual(
      expect.arrayContaining([
        ["RunTool", "exe-installed-file"],
        ["CallDll", "dll-in-binary"],
        ["SetMode", "set-property"],
      ]),
    );
    expect(
      report.custom_actions.find((action) => action.id === "RunTool")
        ?.execution,
    ).toEqual(expect.arrayContaining(["deferred", "no-impersonate"]));
    expect(
      report.custom_actions.find((action) => action.id === "RunTool")
        ?.scheduled[0]?.condition,
    ).toBe("NOT Installed");
    expect(report.registry[0]).toMatchObject({
      key: "Software\\Oops",
      name: "InstallDir",
      action: "write",
    });
    expect(report.services.map((service) => service.kind)).toEqual([
      "install",
      "control",
    ]);
    expect(report.environment[0]?.name).toBe("PATH");
    expect(report.launch_conditions.map((entry) => entry.condition)).toContain(
      "VersionNT >= 603",
    );
    expect(report.binaries[0]).toMatchObject({ name: "SetupDll", kind: "pe" });
    expect(report.cabinets).toMatchObject([
      {
        name: "oops.cab",
        source: "embedded",
        folders: [{ compression: "mszip" }],
      },
    ]);
    expect(report.signature).toEqual({
      digital_signature: null,
      ex: null,
      verified: false,
    });
    expect(report.diagnostics).toEqual([]);
  });

  it("reads an external cabinet only when supplied, and reports a damaged one without failing", async () => {
    const missing = await installer({ path: fixtures.msiExternal });
    expect(
      missing.files.every((file) => file.status === "cabinet-missing"),
    ).toBe(true);
    expect(
      missing.coverage.find((entry) => entry.facet === "inventory")?.state,
    ).toBe("partial");
    const supplied = await installer({
      path: fixtures.msiExternal,
      cabinets: [fixtures.cabinet],
    });
    expect(
      supplied.files.every(
        (file) => file.status === "read" && file.md5?.valid === true,
      ),
    ).toBe(true);
    expect(supplied.cabinets[0]).toMatchObject({
      source: "companion",
      path: fixtures.cabinet,
      sha256: sha256(await readFile(fixtures.cabinet)),
    });
    const stray = await installer({
      path: fixtures.msiExternal,
      cabinets: [fixtures.cabinet, fixtures.cabinetStored],
    });
    expect(
      stray.diagnostics.some((entry) =>
        /not named by any Media row/u.test(entry.message),
      ),
    ).toBe(true);
    const tight = await installer({
      path: fixtures.msiExternal,
      cabinets: [fixtures.cabinet],
      max_decoded_bytes: 1024,
    });
    // readme.txt is 10 bytes, but it follows tool.exe in one MSZIP folder: reaching it decodes both.
    expect(tight.files.map((file) => file.status)).toEqual([
      "over-budget",
      "over-budget",
    ]);

    // Both files share the cabinet's last MSZIP block, so one changed byte there spoils both.
    const damaged = Buffer.from(await readFile(fixtures.cabinet));
    damaged[damaged.length - 200] = (damaged[damaged.length - 200] ?? 0) ^ 0xff;
    await mkdir(join(root, "broken"), { recursive: true });
    const broken = join(root, "broken", "oops.cab");
    await writeFile(broken, damaged);
    const partial = await installer({
      path: fixtures.msiExternal,
      cabinets: [broken],
    });
    expect(partial.files.map((file) => file.status)).toEqual([
      "damaged",
      "damaged",
    ]);
    expect(
      partial.diagnostics.some((entry) =>
        /could not be decoded/u.test(entry.message),
      ),
    ).toBe(true);
    expect(partial.custom_actions.length).toBe(supplied.custom_actions.length);
  });

  it("refuses what is not an installer and a relative cabinet path", async () => {
    expect((await failure("installer", { path: fixtures.cabinet })).tag).toBe(
      "AnalysisUnsupportedTargetError",
    );
    const relative = await failure("installer", {
      path: fixtures.msi,
      cabinets: ["oops.cab"],
    });
    expect(relative.tag).toBe("AnalysisInputError");
    const whole = await readFile(fixtures.msi);
    const truncated = join(root, "truncated.msi");
    await writeFile(truncated, whole.subarray(0, Math.floor(whole.length / 3)));
    const cut = await failure("installer", { path: truncated });
    expect(cut.tag).toBe("ArtifactOperationError");
    expect(cut.message).toMatch(
      /past the end of the \d+-byte file; it is truncated/u,
    );
  });
});

suite(
  "MSIX packages and bundles (hand-assembled: no MSIX tool runs on macOS)",
  () => {
    beforeAll(setup, 120_000);

    it("reads a package's manifest and block map and names a tampered member", async () => {
      const report = await msix({ path: fixtures.msix.x64 });
      expect(report.package).toEqual({
        kind: "msix",
        basis: "layout",
        name_conflict: null,
      });
      expect(report.parts?.manifest?.identity).toMatchObject({
        name: "Oops.Demo",
        processor_architecture: "x64",
      });
      expect(
        report.parts?.manifest?.capabilities.map((entry) => [
          entry.name,
          entry.kind,
        ]),
      ).toEqual([
        ["internetClient", "general"],
        ["runFullTrust", "restricted"],
      ]);
      expect(report.parts?.block_map?.verified).toBe(true);
      expect(report.parts?.signature).toMatchObject({
        magic: true,
        verified: false,
      });

      const bytes = Buffer.from(await readFile(fixtures.msix.x64));
      // oops.exe is stored: change one byte of its first 64 KiB block.
      const at = bytes.indexOf(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) + 100;
      bytes[at] = (bytes[at] ?? 0) ^ 0xff;
      const crcBroken = join(root, "crc-broken.msix");
      await writeFile(crcBroken, bytes);
      const refused = await msix({ path: crcBroken });
      expect(refused.parts?.block_map).toMatchObject({
        verified: false,
        missing: [],
        unreadable: ["oops.exe"],
      });
      expect(refused.diagnostics[0]?.message).toMatch(/CRC/u);

      // Rewrite the member's CRC-32 in its local and central headers, so only the block map can tell.
      const start = at - 100;
      const crc = zlib.crc32(bytes.subarray(start, start + payloadBytes));
      bytes.writeUInt32LE(crc, bytes.lastIndexOf(LOCAL_HEADER, start) + 14);
      let central = bytes.indexOf(CENTRAL_HEADER, start + payloadBytes);
      while (
        bytes.toString(
          "latin1",
          central + 46,
          central + 46 + bytes.readUInt16LE(central + 28),
        ) !== "oops.exe"
      )
        central = bytes.indexOf(CENTRAL_HEADER, central + 4);
      bytes.writeUInt32LE(crc, central + 16);
      const tampered = join(root, "tampered.msix");
      await writeFile(tampered, bytes);
      const changed = await msix({ path: tampered });
      expect(changed.parts?.block_map).toMatchObject({
        verified: false,
        mismatched: [{ path: "oops.exe", blocks: [0] }],
        unreadable: [],
      });
    });

    it("checks a bundle's packages and reads one only when named", async () => {
      const report = await msix({ path: fixtures.msixbundle });
      expect(report.package.kind).toBe("msixbundle");
      expect(report.parts).toBeNull();
      expect(report.bundle?.architectures).toEqual(["arm64", "x64"]);
      expect(
        report.bundle?.packages.every(
          (entry) =>
            entry.layout_matches === true && entry.block_map_verified === true,
        ),
      ).toBe(true);
      expect(report.bundle?.parts.block_map?.verified).toBe(true);
      const arm = await msix({
        path: fixtures.msixbundle,
        container: "Oops.Demo_1.2.3.0_arm64.msix",
      });
      expect(arm.parts?.manifest?.identity?.processor_architecture).toBe(
        "arm64",
      );
      expect(
        (
          await failure("msix", {
            path: fixtures.msixbundle,
            container: "missing.msix",
          })
        ).message,
      ).toMatch(/packages: Oops\.Demo/u);
      expect(
        (
          await failure("msix", {
            path: fixtures.msix.x64,
            container: "x.msix",
          })
        ).message,
      ).toMatch(/single package/u);
      expect((await failure("msix", { path: fixtures.msi })).tag).toBe(
        "AnalysisUnsupportedTargetError",
      );
    });
  },
);

suite("Installer contents in the artifact graph", () => {
  beforeAll(setup, 120_000);

  it("lays MSI files out at their target directories and lists Binary streams", async () => {
    const listed = await readAll(new MsiArtifactReader(fixtures.msi));
    expect([...listed.keys()].sort()).toEqual([
      "Binary/SetupDll",
      "ProgramFiles64Folder/Oops/readme.txt",
      "ProgramFiles64Folder/Oops/tool.exe",
    ]);
    expect(listed.get("ProgramFiles64Folder/Oops/tool.exe")).toBe(
      payloadSha256,
    );
    expect(listed.get("ProgramFiles64Folder/Oops/readme.txt")).toBe(
      sha256(Buffer.from(README_TEXT)),
    );
    const external = new MsiArtifactReader(fixtures.msiExternal);
    expect([...(await readAll(external)).keys()]).toEqual(["Binary/SetupDll"]);
    expect(external.omissions().join(" ")).toMatch(
      /external cabinet oops\.cab, which is not searched for/u,
    );
  });

  it("reads a bundle as a bundle, not as a package", async () => {
    const reader = new ZipArtifactReader(fixtures.msixbundle, "msixbundle");
    const listed = await readAll(reader);
    expect([...listed.keys()]).toContain("Oops.Demo_1.2.3.0_x64.msix");
    expect(reader.format).toBe("msixbundle");
  });
});
