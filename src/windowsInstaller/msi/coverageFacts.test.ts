import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { msiFacts, type MsiFacts } from "./facts.js";
import {
  buildCoverageFixtures,
  COVERAGE_READY,
  openMsi,
  SQL_CUSTOM_ACTIONS,
  type CoverageFixtures,
} from "./msi.fixture.js";
import { buildWindowsFixtures } from "../../../tests/fixtures/windowsProducers.js";
import { removeTestWorkspace } from "../../../tests/support/workspace/workspaceFixture.js";

/**
 * Facts from the coverage database: wixl's product plus msibuild's SQL rows
 * (msi.fixture.ts). Expected values are the inputs as written, decoded by
 * the Windows Installer SDK tables: custom action types ("Summary List of
 * All Custom Action Types" and its option pages), Component, File,
 * Feature, ServiceInstall and ServiceControl bits, Registry roots and
 * Environment prefixes. Where wixl stores something other than its WiX
 * input (HKMU as Root 4, ErrorControl without the vital bit), the facts
 * report what is stored.
 */

let root: string | undefined;
let building: Promise<CoverageFixtures> | undefined;

const built = (): Promise<CoverageFixtures> => {
  building ??= (async () => {
    root = await realpath(
      await mkdtemp(join(await realpath(tmpdir()), "rea-msi-coverage-")),
    );
    const windows = await buildWindowsFixtures(join(root, "windows"));
    return buildCoverageFixtures(join(root, "coverage"), windows.msi);
  })();
  return building;
};

afterAll(async () => {
  if (root !== undefined) await removeTestWorkspace(root);
});

const sqlFacts = async (): Promise<MsiFacts> =>
  msiFacts((await openMsi((await built()).sql)).database);

/** Custom action type -> (kind, script, execution) per the SDK's type and option tables. */
const DOCUMENTED: Readonly<
  Record<string, readonly [string, string | null, readonly string[]]>
> = {
  CaFile: [
    "exe-installed-file",
    null,
    ["immediate", "once-per-process", "async"],
  ],
  CaDll: ["dll-in-binary", null, ["rollback", "in-script", "no-impersonate"]],
  CaJs: [
    "script-in-binary",
    "jscript",
    ["commit", "in-script", "no-impersonate"],
  ],
  CaProp: [
    "exe-from-property",
    null,
    ["immediate", "first-sequence", "async", "continue-on-error"],
  ],
  CaSet: [
    "set-property",
    null,
    ["immediate", "client-repeat", "continue-on-error"],
  ],
  T2: ["exe-in-binary", null, ["immediate"]],
  T6: ["script-in-binary", "vbscript", ["immediate"]],
  T19: ["error-message", null, ["immediate"]],
  T21: ["script-installed-file", "jscript", ["immediate"]],
  T22: ["script-installed-file", "vbscript", ["immediate"]],
  T34: ["exe-in-directory", null, ["immediate"]],
  T35: ["set-directory", null, ["immediate"]],
  T37: ["script-text", "jscript", ["immediate", "64-bit-script"]],
  T38: ["script-text", "vbscript", ["immediate", "hide-target"]],
  T53: ["script-from-property", "jscript", ["immediate", "ts-aware"]],
  T54: ["script-from-property", "vbscript", ["immediate", "patch-uninstall"]],
  T7: ["nested-install", null, ["immediate"]],
  T23: ["nested-install-source", null, ["immediate"]],
  T39: ["nested-install-advertised", null, ["immediate"]],
  T3: ["undefined-3", null, ["immediate"]],
  T33: ["undefined-33", null, ["immediate"]],
  T8: ["dll-in-binary", null, ["immediate", "0x8"]],
};

describe.skipIf(!COVERAGE_READY)(
  "coverage database: directory and file paths",
  () => {
    beforeAll(async () => {
      await built();
    }, 120_000);

    it("resolves short|long names, '.' directories, target:source names and system folders", async () => {
      const facts = await sqlFacts();
      const paths = Object.fromEntries(
        facts.directories.map((directory) => [
          directory.id,
          [directory.target_path, directory.source_path],
        ]),
      );
      expect(paths).toEqual({
        TARGETDIR: ["TARGETDIR", "SourceDir"],
        ProgramFiles64Folder: ["ProgramFiles64Folder", "SourceDir"],
        INSTALLDIR: ["ProgramFiles64Folder/Oops", "SourceDir/Oops"],
        SUBDIR: [
          "ProgramFiles64Folder/Oops/sub dir é",
          "SourceDir/Oops/sub dir é",
        ],
        SAMEDIR: [
          "ProgramFiles64Folder/Oops/sub dir é",
          "SourceDir/Oops/sub dir é",
        ],
        SPLITDIR: [
          "ProgramFiles64Folder/Oops/Target Dir",
          "SourceDir/Oops/Source Dir",
        ],
        CommonAppDataFolder: ["CommonAppDataFolder", "SourceDir"],
        DATADIR: ["CommonAppDataFolder/OopsData", "SourceDir/OopsData"],
        TopLevel: ["TARGETDIR/TopLevel", "SourceDir/TopLevel"],
      });
      const files = Object.fromEntries(
        facts.files.map((file) => [
          file.key,
          [file.name, file.short_name, file.target_path, file.attributes],
        ]),
      );
      expect(files).toEqual({
        ToolExe: [
          "tool.exe",
          null,
          "ProgramFiles64Folder/Oops/tool.exe",
          ["vital"],
        ],
        LongFile: [
          "A Long File Name é.txt",
          "ALONGF~1.TXT",
          "ProgramFiles64Folder/Oops/sub dir é/A Long File Name é.txt",
          ["vital"],
        ],
        DataDll: [
          "b.dll",
          null,
          "CommonAppDataFolder/OopsData/b.dll",
          ["vital"],
        ],
        TopFile: ["top.txt", null, "TARGETDIR/TopLevel/top.txt", ["vital"]],
        SameFile: [
          "same.txt",
          null,
          "ProgramFiles64Folder/Oops/sub dir é/same.txt",
          [
            "read-only",
            "hidden",
            "system",
            "checksum",
            "patch-added",
            "noncompressed",
          ],
        ],
      });
      expect(
        facts.files.find((file) => file.key === "SameFile")?.media,
      ).toBeNull();
      expect(facts.problems).toEqual([
        "Table Pic has 1 binary cells whose stream is not in the database; they read as null.",
        "File SameFile has sequence 6, past every Media row's LastSequence.",
      ]);
    });
  },
);

describe.skipIf(!COVERAGE_READY)(
  "coverage database: component, feature, service and registry bits",
  () => {
    beforeAll(async () => {
      await built();
    }, 120_000);

    it("names component, feature, service and registry bits", async () => {
      const facts = await sqlFacts();
      expect(
        Object.fromEntries(
          facts.components.map((component) => [
            component.id,
            [component.attributes, component.condition],
          ]),
        ),
      ).toEqual({
        Data: [["local-only", "permanent", "64-bit"], "NOT Installed"],
        Sub: [["local-only", "64-bit"], null],
        MainExe: [["local-only", "64-bit"], null],
        Top: [["local-only", "64-bit"], null],
        Same: [
          [
            "source-only",
            "registry-keypath",
            "shared-dll-refcount",
            "never-overwrite",
            "disable-registry-reflection",
            "uninstall-on-supersedence",
            "shared",
          ],
          null,
        ],
      });
      expect(facts.features).toEqual([
        {
          id: "Parent",
          parent: null,
          title: "Parent é",
          description: "Top feature",
          level: 1,
          display: 1,
          attributes: [
            "favor-local",
            "disallow-advertise",
            "ui-disallow-absent",
          ],
          components: ["Sub", "MainExe"],
          conditions: [],
        },
        {
          id: "Child",
          parent: "Parent",
          title: "Child",
          description: null,
          level: 3,
          display: 2,
          attributes: ["favor-source"],
          components: ["Data", "Top"],
          conditions: [{ level: 0, condition: "NOT FEATURES" }],
        },
      ]);
      expect(facts.services).toEqual([
        {
          kind: "install",
          id: "Svc2",
          name: "Svc2",
          display_name: "Svc 2",
          type: ["share-process", "interactive"],
          start: "demand",
          error_control: "critical",
          arguments: "-x",
          account: "LocalSystem",
          events: [],
          component: "Data",
        },
        {
          kind: "control",
          id: "Svc2Ctl",
          name: "Svc2",
          display_name: null,
          type: [],
          start: null,
          error_control: null,
          arguments: null,
          account: null,
          events: [
            "install-start",
            "install-stop",
            "install-delete",
            "uninstall-start",
            "uninstall-delete",
          ],
          component: "Data",
        },
      ]);
      expect(
        facts.registry.map((entry) => [
          entry.root,
          entry.key,
          entry.name,
          entry.value,
          entry.action,
        ]),
      ).toEqual([
        ["4", "Software\\Oops", "Count", "#7", "write"],
        ["HKCR", ".oops", null, "Oops.File", "write"],
        [
          "per-user/per-machine (-1)",
          "Software\\Oops\\Old",
          "-",
          null,
          "remove",
        ],
      ]);
    });
  },
);

describe.skipIf(!COVERAGE_READY)(
  "coverage database: environment, INI, shortcuts, binaries and signatures",
  () => {
    beforeAll(async () => {
      await built();
    }, 120_000);

    it("decodes environment prefixes, INI actions, shortcuts, binaries and signature streams", async () => {
      const facts = await sqlFacts();
      expect(facts.environment).toEqual([
        {
          id: expect.any(String),
          name: "OOPS_VAR",
          flags: ["create-if-absent", "prepend"],
          value: "x;[~]",
          component: "Sub",
        },
      ]);
      expect(facts.ini_files).toEqual([
        {
          id: "Ini2",
          file: "c.ini",
          directory: "SUBDIR",
          section: "s",
          key: "k",
          value: "v",
          action: "create-line",
          component: "Sub",
        },
        {
          id: "RmIni",
          file: "old.ini",
          directory: "SUBDIR",
          section: "s",
          key: "k",
          value: null,
          action: "remove-tag",
          component: "Sub",
        },
      ]);
      expect(facts.shortcuts).toEqual([
        {
          id: "Sc2",
          directory: "SUBDIR",
          name: "Oops Shortcut é",
          target: "[SUBDIR]x.txt",
          arguments: "--open",
          component: "Sub",
        },
      ]);
      expect(facts.binaries).toEqual([
        {
          name: "SetupDll",
          stream: "Binary.SetupDll",
          size: "MZ coverage dll bytes, never run\n".length,
        },
        {
          name: "Js",
          stream: "Binary.Js",
          size: "function main() { return 1; }\n".length,
        },
      ]);
      expect(facts.signature).toEqual({ digital_signature: 300, ex: 20 });
    });
  },
);

describe.skipIf(!COVERAGE_READY)(
  "coverage database: custom action types",
  () => {
    beforeAll(async () => {
      await built();
    }, 120_000);

    it("decodes every documented custom action type and option, and where each is scheduled", async () => {
      const facts = await sqlFacts();
      const decoded = Object.fromEntries(
        facts.custom_actions.map((action) => [
          action.id,
          [action.source_kind, action.script, action.execution],
        ]),
      );
      expect(decoded).toEqual(DOCUMENTED);
      for (const [id, type, source, target, extended] of SQL_CUSTOM_ACTIONS)
        expect(
          facts.custom_actions.find((action) => action.id === id),
        ).toMatchObject({ type, source, target, extended_type: extended });
      const scheduled = Object.fromEntries(
        facts.custom_actions
          .filter((action) => action.scheduled.length > 0)
          .map((action) => [action.id, action.scheduled]),
      );
      expect(scheduled).toMatchObject({
        T2: [
          {
            table: "AdvtExecuteSequence",
            sequence: null,
            condition: "NOT Installed",
          },
        ],
        T19: [{ table: "AdminExecuteSequence", sequence: -1, condition: null }],
        CaProp: [{ table: "InstallUISequence", condition: "UILevel > 2" }],
        CaDll: [{ table: "InstallExecuteSequence", condition: "1" }],
      });
      const advertise =
        facts.sequences.find(
          (sequence) => sequence.table === "AdvtExecuteSequence",
        )?.actions ?? [];
      expect(advertise.at(-1)).toEqual({
        action: "T2",
        condition: "NOT Installed",
        sequence: null,
      });
      expect(
        facts.sequences.find(
          (sequence) => sequence.table === "AdminExecuteSequence",
        )?.actions[0],
      ).toEqual({ action: "T19", condition: null, sequence: -1 });
    });
  },
);

describe.skipIf(!COVERAGE_READY)(
  "coverage database: long string references",
  () => {
    beforeAll(async () => {
      await built();
    }, 120_000);

    it("reads 34,000 properties through 3-byte string references", async () => {
      const { database } = await openMsi((await built()).long);
      const facts = msiFacts(database);
      expect(database.strref).toBe(3);
      expect(facts.properties).toHaveLength(34_000);
      expect(
        facts.properties.every(
          (property) => property.value === `value ${property.name.slice(1)}`,
        ),
      ).toBe(true);
      expect(facts.product.name).toBeNull();
    });
  },
);
