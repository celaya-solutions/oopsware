import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { msiFacts, type MsiFacts } from "./facts.js";
import {
  buildCoverageFixtures,
  COVERAGE_READY,
  exportTable,
  openMsi,
  type CoverageFixtures,
} from "./msi.fixture.js";
import {
  buildWindowsFixtures,
  README_TEXT,
  WINDOWS_TOOLS,
  windowsOracle,
  type WindowsFixtures,
} from "../../../tests/fixtures/windowsProducers.js";
import { removeTestWorkspace } from "../../../tests/support/workspace/workspaceFixture.js";

/**
 * Installer facts against msiextract (where every File row lands, and
 * which files the cabinets hold), the WiX sources and msibuild SQL the
 * fixtures were made from, and the Windows Installer SDK tables for bits
 * and custom action types. msiextract drops root directories and "."
 * names and writes ProgramFilesFolder as "Program Files"; facts keep the
 * root or system folder ID as the first path segment instead.
 */

interface Built {
  readonly windows: WindowsFixtures;
  readonly coverage: CoverageFixtures;
}

let root: string | undefined;
let building: Promise<Built> | undefined;

const built = (): Promise<Built> => {
  building ??= (async () => {
    root = await realpath(
      await mkdtemp(join(await realpath(tmpdir()), "rea-msi-facts-")),
    );
    const windows = await buildWindowsFixtures(join(root, "windows"));
    return {
      windows,
      coverage: await buildCoverageFixtures(
        join(root, "coverage"),
        windows.msi,
      ),
    };
  })();
  return building;
};

afterAll(async () => {
  if (root !== undefined) await removeTestWorkspace(root);
});

const factsOf = async (path: string): Promise<MsiFacts> =>
  msiFacts((await openMsi(path)).database);

/** msiextract's layout of a target path: the root or system folder dropped, ProgramFilesFolder as "Program Files". */
const msiextractPath = (target: string): string => {
  const [first = "", ...rest] = target.split("/");
  return [
    ...(first === "ProgramFilesFolder" ? ["Program Files"] : []),
    ...rest,
  ].join("/");
};

const filesUnder = async (directory: string): Promise<string[]> => {
  const out: string[] = [];
  for (const entry of await readdir(directory, {
    withFileTypes: true,
    recursive: true,
  }))
    if (entry.isFile())
      out.push(relative(directory, join(entry.parentPath, entry.name)));
  return out.sort();
};

const md5 = (bytes: Uint8Array | string): string =>
  createHash("md5").update(bytes).digest("hex");

describe.skipIf(!COVERAGE_READY)(
  "installer paths and media against msiextract",
  () => {
    beforeAll(async () => {
      await built();
    }, 120_000);

    it("places every File row where msiextract lists it", async () => {
      const { windows, coverage } = await built();
      let files = 0;
      for (const path of [
        windows.msi,
        windows.msiExternal,
        coverage.neutral,
        coverage.utf8,
        coverage.latin,
        coverage.sql,
        coverage.v4,
      ]) {
        const listed = (await windowsOracle("msiextract", ["-l", path]))
          .toString("utf8")
          .split("\n")
          .filter((line) => line !== "");
        const facts = await factsOf(path);
        expect(
          facts.files.map((file) => msiextractPath(file.target_path)),
          path,
        ).toEqual(listed);
        files += listed.length;
      }
      expect(files).toBeGreaterThan(20);
    });

    it("lays out the cabinets' files where msiextract writes them, embedded and external", async () => {
      const { windows, coverage } = await built();
      if (root === undefined) throw new Error("no workspace");
      for (const [index, path] of [
        windows.msi,
        windows.msiExternal,
        coverage.sql,
      ].entries()) {
        const target = join(root, `extract-${String(index)}`);
        await windowsOracle("msiextract", ["-C", target, path]);
        const facts = await factsOf(path);
        const inCabinet = facts.files.filter((file) => file.key !== "SameFile");
        expect(await filesUnder(target), path).toEqual(
          inCabinet.map((file) => msiextractPath(file.target_path)).sort(),
        );
        for (const file of inCabinet)
          expect(
            (await stat(join(target, msiextractPath(file.target_path)))).size,
            file.key,
          ).toBe(file.size);
      }
    });

    it("says which cabinet holds each file and whether it is a stream of the database", async () => {
      const { windows } = await built();
      const embedded = await openMsi(windows.msi);
      const external = await openMsi(windows.msiExternal);
      const media = {
        disk_id: 1,
        last_sequence: 2,
        disk_prompt: null,
        cabinet: "oops.cab",
        volume_label: null,
        source: null,
      };
      expect(msiFacts(embedded.database).media).toEqual([
        { ...media, embedded: true },
      ]);
      expect(msiFacts(external.database).media).toEqual([
        { ...media, embedded: false },
      ]);
      expect(
        msiFacts(external.database).files.map((file) => file.media),
      ).toEqual([
        { disk_id: 1, cabinet: "oops.cab", embedded: false },
        { disk_id: 1, cabinet: "oops.cab", embedded: false },
      ]);
      expect(embedded.database.stream("oops.cab")?.size).toBeGreaterThan(
        400_000,
      );
      expect(external.database.stream("oops.cab")).toBeNull();
    });
  },
);

describe.skipIf(WINDOWS_TOOLS === null)(
  "installer facts of the shared WiX fixture: product and files",
  () => {
    beforeAll(async () => {
      await built();
    }, 120_000);

    it("reads product, directories, components, files and hashes", async () => {
      const { windows } = await built();
      const facts = await factsOf(windows.msi);
      expect(facts.product).toMatchObject({
        name: "Oops Demo",
        version: "1.2.3",
        manufacturer: "Oops Fixture",
        upgrade_code: "{12345678-1234-1234-1234-123456789012}",
        language: "1033",
        all_users: "1",
      });
      expect(facts.product.product_code).toMatch(/^\{[0-9A-F-]{36}\}$/u);
      expect(
        facts.properties.find((property) => property.name === "OOPS_MODE"),
      ).toEqual({ name: "OOPS_MODE", value: "demo" });
      expect(facts.directories).toEqual([
        {
          id: "INSTALLDIR",
          parent: "ProgramFiles64Folder",
          default_dir: "Oops",
          target_path: "ProgramFiles64Folder/Oops",
          source_path: "SourceDir/Oops",
        },
        {
          id: "ProgramFiles64Folder",
          parent: "TARGETDIR",
          default_dir: ".",
          target_path: "ProgramFiles64Folder",
          source_path: "SourceDir",
        },
        {
          id: "TARGETDIR",
          parent: null,
          default_dir: "SourceDir",
          target_path: "TARGETDIR",
          source_path: "SourceDir",
        },
      ]);
      expect(
        facts.components.map((component) => [
          component.id,
          component.directory,
          component.attributes,
          component.key_path,
        ]),
      ).toEqual([
        ["MainExe", "INSTALLDIR", ["local-only", "64-bit"], "ToolExe"],
        ["Readme", "INSTALLDIR", ["local-only", "64-bit"], "ReadmeTxt"],
      ]);
      const payload = await readFile(windows.payload);
      expect(facts.files).toEqual([
        {
          key: "ToolExe",
          component: "MainExe",
          name: "tool.exe",
          short_name: null,
          size: payload.length,
          version: null,
          language: null,
          attributes: ["vital"],
          sequence: 1,
          target_path: "ProgramFiles64Folder/Oops/tool.exe",
          media: { disk_id: 1, cabinet: "oops.cab", embedded: true },
          hash: { md5: md5(payload) },
        },
        {
          key: "ReadmeTxt",
          component: "Readme",
          name: "readme.txt",
          short_name: null,
          size: README_TEXT.length,
          version: null,
          language: null,
          attributes: ["vital"],
          sequence: 2,
          target_path: "ProgramFiles64Folder/Oops/readme.txt",
          media: { disk_id: 1, cabinet: "oops.cab", embedded: true },
          hash: { md5: md5(README_TEXT) },
        },
      ]);
      expect(facts.features).toEqual([
        {
          id: "Main",
          parent: null,
          title: "Main",
          description: null,
          level: 1,
          display: 2,
          attributes: ["favor-local"],
          components: ["MainExe", "Readme"],
          conditions: [],
        },
      ]);
      expect(facts.problems).toEqual([]);
    });
  },
);

describe.skipIf(WINDOWS_TOOLS === null)(
  "installer facts of the shared WiX fixture: registry, services and the rest",
  () => {
    beforeAll(async () => {
      await built();
    }, 120_000);

    it("reads registry, services, shortcuts, environment, INI, upgrades and launch conditions", async () => {
      const facts = await factsOf((await built()).windows.msi);
      expect(facts.registry).toEqual([
        {
          id: expect.stringMatching(/^reg[0-9A-F]{32}$/u),
          root: "HKLM",
          key: "Software\\Oops",
          name: "InstallDir",
          value: "[INSTALLDIR]",
          component: "MainExe",
          action: "write",
        },
      ]);
      expect(facts.services).toEqual([
        {
          kind: "install",
          id: "OopsSvc",
          name: "OopsService",
          display_name: "Oops Service",
          type: ["own-process"],
          start: "auto",
          error_control: "normal",
          arguments: null,
          account: null,
          events: [],
          component: "MainExe",
        },
        {
          kind: "control",
          id: "OopsSvcCtl",
          name: "OopsService",
          display_name: null,
          type: [],
          start: null,
          error_control: null,
          arguments: null,
          account: null,
          events: [
            "install-start",
            "install-stop",
            "uninstall-stop",
            "uninstall-delete",
          ],
          component: "MainExe",
        },
      ]);
      expect(facts.shortcuts).toEqual([
        {
          id: "OopsShortcut",
          directory: "INSTALLDIR",
          name: "Oops",
          target: "[INSTALLDIR]readme.txt",
          arguments: null,
          component: "Readme",
        },
      ]);
      expect(facts.environment).toEqual([
        {
          id: expect.any(String),
          name: "PATH",
          flags: ["set", "system", "append"],
          value: "[~];[INSTALLDIR]",
          component: "Readme",
        },
      ]);
      expect(facts.ini_files).toEqual([
        {
          id: "OopsIni",
          file: "oops.ini",
          directory: "INSTALLDIR",
          section: "main",
          key: "mode",
          value: "demo",
          action: "add-line",
          component: "Readme",
        },
      ]);
      expect(facts.upgrades).toEqual([
        {
          upgrade_code: "{12345678-1234-1234-1234-123456789012}",
          version_min: null,
          version_max: "1.2.3",
          language: null,
          attributes: ["migrate-features"],
          remove: null,
          action_property: "WIX_UPGRADE_DETECTED",
        },
        {
          upgrade_code: "{12345678-1234-1234-1234-123456789012}",
          version_min: "1.2.3",
          version_max: null,
          language: null,
          attributes: ["only-detect"],
          remove: null,
          action_property: "WIX_DOWNGRADE_DETECTED",
        },
      ]);
      expect(facts.launch_conditions).toEqual([
        {
          condition: "NOT WIX_DOWNGRADE_DETECTED",
          message: "A newer version is installed.",
        },
        { condition: "VersionNT >= 603", message: "Needs Windows 10" },
      ]);
      expect(facts.binaries).toEqual([
        {
          name: "SetupDll",
          stream: "Binary.SetupDll",
          size: "MZ fixture dll bytes, never run\n".length,
        },
      ]);
      expect(facts.signature).toEqual({ digital_signature: null, ex: null });
    });
  },
);

describe.skipIf(WINDOWS_TOOLS === null)(
  "installer facts of the shared WiX fixture: custom actions and sequences",
  () => {
    beforeAll(async () => {
      await built();
    }, 120_000);

    it("decodes custom actions and orders every sequence table as msiinfo stores it, by sequence", async () => {
      const path = (await built()).windows.msi;
      const facts = await factsOf(path);
      const execute = (await exportTable(path, "InstallExecuteSequence")).rows;
      const scheduled = (action: string) =>
        execute
          .filter(([name]) => name === action)
          .map(([, condition = "", sequence = ""]) => ({
            table: "InstallExecuteSequence",
            sequence: Number(sequence),
            condition: condition === "" ? null : condition,
          }));
      expect(facts.custom_actions).toEqual([
        {
          id: "SetMode",
          type: 51,
          source_kind: "set-property",
          script: null,
          source: "OOPS_MODE",
          target: "[INSTALLDIR]",
          extended_type: null,
          execution: ["immediate"],
          scheduled: scheduled("SetMode"),
        },
        {
          id: "RunTool",
          type: 3090,
          source_kind: "exe-installed-file",
          script: null,
          source: "ToolExe",
          target: "--setup",
          extended_type: null,
          execution: ["deferred", "in-script", "no-impersonate"],
          scheduled: scheduled("RunTool"),
        },
        {
          id: "CallDll",
          type: 65,
          source_kind: "dll-in-binary",
          script: null,
          source: "SetupDll",
          target: "Configure",
          extended_type: null,
          execution: ["immediate", "continue-on-error"],
          scheduled: scheduled("CallDll"),
        },
      ]);
      expect(
        facts.custom_actions.map((action) => action.scheduled[0]?.condition),
      ).toEqual([null, "NOT Installed", 'REMOVE="ALL"']);
      expect(facts.sequences.map((sequence) => sequence.table)).toEqual(
        (await windowsOracle("msiinfo", ["tables", path]))
          .toString("utf8")
          .split("\n")
          .filter((name) => name.endsWith("Sequence")),
      );
      for (const sequence of facts.sequences) {
        const rows = (await exportTable(path, sequence.table)).rows.map(
          ([action = "", condition = "", number = ""]) => ({
            action,
            condition: condition === "" ? null : condition,
            sequence: number === "" ? null : Number(number),
          }),
        );
        const ordered = rows
          .map((row, index) => ({ row, index }))
          .sort(
            (left, right) =>
              (left.row.sequence ?? Infinity) -
                (right.row.sequence ?? Infinity) || left.index - right.index,
          )
          .map(({ row }) => row);
        expect(sequence.actions, sequence.table).toEqual(ordered);
      }
    });
  },
);
