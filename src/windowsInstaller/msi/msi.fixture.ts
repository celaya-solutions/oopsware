import { execFile } from "node:child_process";
import {
  access,
  constants,
  copyFile,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

import { CompoundFile } from "../cfb.js";
import { MsiDatabase, type MsiValue } from "./database.js";
import {
  WINDOWS_TOOLS,
  windowsOracle,
} from "../../../tests/fixtures/windowsProducers.js";

/**
 * Extra MSI producers for the F08 database tests, beside the shared
 * windowsProducers fixtures: wixl builds a coverage product (Latin-1 names,
 * nested features, services, shortcuts, more custom action options) in
 * UTF-8 and windows-1252; msibuild (msitools' SQL front end) adds rows wixl
 * cannot write (every other custom action type, short|long and target:source
 * DefaultDir values, RemoveRegistry, an integer-keyed stream table,
 * signature streams, 34,000 properties for 3-byte string references); and
 * libgsf's `gsf createole` repacks a database's streams into a version 4
 * (4096-byte sector) compound file. wixl crashes on characters outside
 * Latin-1 in names and cannot write a second Media row (DiskId != 1).
 */

const run = promisify(execFile);

const executable = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export const GSF = (await executable("/opt/homebrew/bin/gsf"))
  ? "/opt/homebrew/bin/gsf"
  : null;
const msibuildPath =
  WINDOWS_TOOLS === null
    ? null
    : join(dirname(WINDOWS_TOOLS.msiinfo), "msibuild");
export const MSIBUILD =
  msibuildPath !== null && (await executable(msibuildPath))
    ? msibuildPath
    : null;
/** Everything the coverage databases need. */
export const COVERAGE_READY =
  WINDOWS_TOOLS !== null && GSF !== null && MSIBUILD !== null;

/** Runs a producer or oracle with a fixed environment (UTC, C locale). */
export const exec = async (
  command: string,
  args: readonly string[],
  cwd?: string,
): Promise<Buffer> => {
  const { stdout } = await run(command, [...args], {
    cwd,
    encoding: "buffer",
    env: {
      PATH: "/opt/homebrew/bin:/usr/bin:/bin",
      HOME: process.env.HOME ?? "/tmp",
      LC_ALL: "C",
      TZ: "UTC",
    },
    maxBuffer: 256 * 1024 ** 2,
  });
  return stdout;
};

export const openMsi = async (
  path: string,
): Promise<{ bytes: Buffer; file: CompoundFile; database: MsiDatabase }> => {
  const bytes = await readFile(path);
  const file = await CompoundFile.open(
    (offset, length) =>
      Promise.resolve(bytes.subarray(offset, offset + length)),
    bytes.length,
  );
  return { bytes, file, database: await MsiDatabase.open(file) };
};

/** `msiinfo export` output: names, type codes, table name + keys, then rows; libmsi escapes nothing. */
export interface Idt {
  readonly names: readonly string[];
  readonly types: readonly string[];
  readonly header: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

export const parseIdt = (output: Buffer): Idt => {
  const lines = output.toString("utf8").split("\r\n");
  if (lines.at(-1) === "") lines.pop();
  const [names = "", types = "", header = "", ...rows] = lines;
  return {
    names: names.split("\t"),
    types: types.split("\t"),
    header: header.split("\t"),
    rows: rows.map((row) => row.split("\t")),
  };
};

/** Runs in the database's own directory: msiinfo writes a table's binary cells there as files (e.g. Binary/Binary.SetupDll). */
export const exportTable = async (msi: string, table: string): Promise<Idt> =>
  parseIdt(
    await windowsOracle("msiinfo", ["export", msi, table], dirname(msi)),
  );

/** A cell as msiinfo prints it: null is empty, a binary cell is its stream name. */
export const cellText = (value: MsiValue): string =>
  value === null
    ? ""
    : typeof value === "object"
      ? value.stream
      : String(value);

/** A wixl product exercising more tables; `codepage` sets the database and summary code pages. */
export const coverageXml = (
  codepage: 65001 | 1252,
): string => `<?xml version="1.0" encoding="utf-8"?>
<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi">
  <Product Id="*" Name="Oöps Cövérage" Language="1033" Codepage="${String(codepage)}" Version="2.0.0" Manufacturer="Oops Fixture" UpgradeCode="12345678-1234-1234-1234-123456789012">
    <Package InstallerVersion="500" Compressed="yes" InstallScope="perMachine" Description="${codepage === 65001 ? "Coverage ☃" : "Coverage é"}" Comments="fixture" Keywords="a,b" SummaryCodepage="${String(codepage)}" Languages="1033,1031"/>
    <MajorUpgrade DowngradeErrorMessage="A newer version is installed."/>
    <Media Id="1" Cabinet="cov.cab" EmbedCab="yes" DiskPrompt="Disk 1"/>
    <Property Id="UNI" Value="wert é ü"/>
    <Property Id="OOPS_EXE" Value="C:\\x.exe"/>
    <Binary Id="SetupDll" SourceFile="src/setup.dll"/>
    <Binary Id="Js" SourceFile="src/setup.js"/>
    <Directory Id="TARGETDIR" Name="SourceDir">
      <Directory Id="ProgramFiles64Folder">
        <Directory Id="INSTALLDIR" Name="Oops">
          <Component Id="MainExe" Guid="11111111-2222-3333-4444-555555555555" Win64="yes">
            <File Id="ToolExe" Name="tool.exe" Source="src/tool.exe" KeyPath="yes"/>
            <RegistryValue Root="HKMU" Key="Software\\Oops" Name="Count" Type="integer" Value="7"/>
            <RegistryValue Root="HKCR" Key=".oops" Type="string" Value="Oops.File"/>
          </Component>
          <Directory Id="SUBDIR" Name="sub dir é">
            <Component Id="Sub" Guid="CCCCCCCC-1111-2222-3333-444444444444" Win64="yes">
              <File Id="LongFile" Name="A Long File Name é.txt" Source="src/readme.txt" KeyPath="yes"/>
              <IniFile Id="Ini2" Name="c.ini" Directory="SUBDIR" Section="s" Key="k" Value="v" Action="createLine"/>
              <Environment Id="Env2" Name="OOPS_VAR" Value="x" Action="create" Part="first" Permanent="no"/>
              <Shortcut Id="Sc2" Name="Oops Shortcut é" Directory="SUBDIR" Target="[SUBDIR]x.txt" Arguments="--open" Description="Opens it" WorkingDirectory="SUBDIR"/>
            </Component>
          </Directory>
        </Directory>
      </Directory>
      <Directory Id="CommonAppDataFolder">
        <Directory Id="DATADIR" Name="OopsData">
          <Component Id="Data" Guid="DDDDDDDD-1111-2222-3333-444444444444" Permanent="yes" Win64="yes">
            <Condition>NOT Installed</Condition>
            <File Id="DataDll" Name="b.dll" Source="src/setup.dll" KeyPath="yes"/>
            <ServiceInstall Id="Svc2" Name="Svc2" DisplayName="Svc 2" Type="shareProcess" Start="demand" ErrorControl="critical" Vital="yes" Arguments="-x" Account="LocalSystem" Interactive="yes"/>
            <ServiceControl Id="Svc2Ctl" Name="Svc2" Start="both" Stop="install" Remove="both"/>
          </Component>
        </Directory>
      </Directory>
      <Directory Id="TopLevel" Name="TopLevel">
        <Component Id="Top" Guid="EEEEEEEE-1111-2222-3333-444444444444" Win64="yes">
          <File Id="TopFile" Name="top.txt" Source="src/readme.txt" KeyPath="yes"/>
        </Component>
      </Directory>
    </Directory>
    <CustomAction Id="CaDll" BinaryKey="SetupDll" DllEntry="Go" Execute="rollback" Impersonate="no"/>
    <CustomAction Id="CaJs" BinaryKey="Js" JScriptCall="main" Execute="commit"/>
    <CustomAction Id="CaProp" Property="OOPS_EXE" ExeCommand="-z" Execute="firstSequence" Return="asyncNoWait"/>
    <CustomAction Id="CaFile" FileKey="TopFile" ExeCommand="" Execute="oncePerProcess" Return="asyncWait"/>
    <CustomAction Id="CaSet" Property="OOPS_SET" Value="[INSTALLDIR]" Execute="clientRepeat" Return="ignore"/>
    <InstallExecuteSequence>
      <Custom Action="CaDll" After="InstallFiles">1</Custom>
      <Custom Action="CaJs" Before="InstallFinalize">NOT REMOVE</Custom>
      <Custom Action="CaFile" After="CostFinalize"/>
    </InstallExecuteSequence>
    <InstallUISequence>
      <Custom Action="CaProp" After="CostFinalize">UILevel &gt; 2</Custom>
      <Custom Action="CaSet" After="CostFinalize"/>
    </InstallUISequence>
    <Feature Id="Parent" Title="Parent é" Description="Top feature" Level="1" Display="expand" Absent="disallow" AllowAdvertise="no">
      <ComponentRef Id="MainExe"/>
      <ComponentRef Id="Sub"/>
      <Feature Id="Child" Title="Child" Level="3" InstallDefault="source">
        <Condition Level="0">NOT FEATURES</Condition>
        <ComponentRef Id="Data"/>
        <ComponentRef Id="Top"/>
      </Feature>
    </Feature>
  </Product>
</Wix>
`;

/** Custom action rows wixl cannot write: [Action, Type, Source, Target, ExtendedType]. */
export const SQL_CUSTOM_ACTIONS: readonly (readonly [
  string,
  number,
  string | null,
  string | null,
  number | null,
])[] = [
  ["T2", 2, "SetupDll", "/q", null],
  ["T6", 6, "Js", "Main", null],
  ["T19", 19, null, "Stop [ProductName]", null],
  ["T21", 21, "TopFile", "main", null],
  ["T22", 22, "TopFile", "Main", null],
  ["T34", 34, "INSTALLDIR", "run.exe", null],
  ["T35", 35, "SUBDIR", "[INSTALLDIR]x", null],
  ["T37", 37 | 0x1000, null, "var a = 1;", null],
  ["T38", 38 | 0x2000, null, "a = 1", null],
  ["T53", 53 | 0x4000, "SCRIPT", null, null],
  ["T54", 54, "SCRIPT", null, 0x8000],
  ["T7", 7, "Nested", "ADDLOCAL=ALL", null],
  ["T23", 23, "child.msi", null, null],
  ["T39", 39, "{11111111-2222-3333-4444-555555555555}", null, null],
  ["T3", 3, null, "x", null],
  ["T33", 33, "INSTALLDIR", "x", null],
  ["T8", 8 | 1, "SetupDll", "x", null],
];

/** Source-only + registry key path + shared DLL + never overwrite + no reflection + supersedence + shared. */
export const SAME_COMPONENT_ATTRIBUTES =
  0x1 | 0x4 | 0x8 | 0x80 | 0x200 | 0x400 | 0x800;
/** Read-only, hidden, system, checksum, patch-added, noncompressed. */
export const SAME_FILE_ATTRIBUTES = 0x1 | 0x2 | 0x4 | 0x400 | 0x1000 | 0x2000;

const quote = (value: string | number | null): string =>
  value === null
    ? "NULL"
    : typeof value === "number"
      ? String(value)
      : `'${value.replaceAll("'", "''")}'`;

/** SQL msibuild runs on a copy of the coverage database. */
export const coverageSql = (): string[] => [
  "UPDATE `Directory` SET `DefaultDir` = 'SUBDIR~1|sub dir é' WHERE `Directory` = 'SUBDIR'",
  "UPDATE `File` SET `FileName` = 'ALONGF~1.TXT|A Long File Name é.txt' WHERE `File` = 'LongFile'",
  "INSERT INTO `Directory` (`Directory`, `Directory_Parent`, `DefaultDir`) VALUES ('SAMEDIR', 'SUBDIR', '.')",
  "INSERT INTO `Directory` (`Directory`, `Directory_Parent`, `DefaultDir`) VALUES ('SPLITDIR', 'INSTALLDIR', 'tgt|Target Dir:src|Source Dir')",
  `INSERT INTO \`Component\` (\`Component\`, \`ComponentId\`, \`Directory_\`, \`Attributes\`, \`KeyPath\`) VALUES ('Same', '{FFFFFFFF-1111-2222-3333-444444444444}', 'SAMEDIR', ${String(SAME_COMPONENT_ATTRIBUTES)}, 'SameFile')`,
  `INSERT INTO \`File\` (\`File\`, \`Component_\`, \`FileName\`, \`FileSize\`, \`Attributes\`, \`Sequence\`) VALUES ('SameFile', 'Same', 'same.txt', 3, ${String(SAME_FILE_ATTRIBUTES)}, 6)`,
  ...SQL_CUSTOM_ACTIONS.map((row) => {
    const columns = (
      ["Action", "Type", "Source", "Target", "ExtendedType"] as const
    ).flatMap((column, index) =>
      row[index] === null ? [] : [[column, row[index] ?? null] as const],
    );
    return `INSERT INTO \`CustomAction\` (${columns.map(([column]) => `\`${column}\``).join(", ")}) VALUES (${columns.map(([, value]) => quote(value)).join(", ")})`;
  }),
  "INSERT INTO `AdvtExecuteSequence` (`Action`, `Condition`) VALUES ('T2', 'NOT Installed')",
  "INSERT INTO `AdminExecuteSequence` (`Action`, `Sequence`) VALUES ('T19', -1)",
  "CREATE TABLE `RemoveRegistry` (`RemoveRegistry` CHAR(72) NOT NULL, `Root` SHORT NOT NULL, `Key` CHAR(255) NOT NULL LOCALIZABLE, `Name` CHAR(255) LOCALIZABLE, `Component_` CHAR(72) NOT NULL PRIMARY KEY `RemoveRegistry`)",
  "INSERT INTO `RemoveRegistry` (`RemoveRegistry`, `Root`, `Key`, `Name`, `Component_`) VALUES ('RmOld', -1, 'Software\\Oops\\Old', '-', 'Sub')",
  "INSERT INTO `RemoveIniFile` (`RemoveIniFile`, `FileName`, `DirProperty`, `Section`, `Key`, `Action`, `Component_`) VALUES ('RmIni', 'OLD~1.INI|old.ini', 'SUBDIR', 's', 'k', 4, 'Sub')",
  "CREATE TABLE `Pic` (`Id` SHORT NOT NULL, `Big` LONG, `Small` SHORT, `Note` CHAR(0), `Data` OBJECT PRIMARY KEY `Id`)",
  "INSERT INTO `Pic` (`Id`, `Big`, `Small`, `Note`) VALUES (5, -70000, -3, 'five')",
  "INSERT INTO `Pic` (`Id`, `Big`) VALUES (-2, 2147483647)",
];

export interface CoverageFixtures {
  /** wixl as written: code page 0 with windows-1252 bytes (wixl ignores Product/@Codepage), UTF-8 summary. */
  readonly neutral: string;
  /** The same product, string pool re-encoded by msibuild importing _ForceCodepage 65001; UTF-8 summary. */
  readonly utf8: string;
  /** wixl with a windows-1252 summary, string pool re-encoded by msibuild to _ForceCodepage 1252. */
  readonly latin: string;
  /** The UTF-8 one with msibuild's SQL rows and streams. */
  readonly sql: string;
  /** The shared embedded-cabinet MSI with 34,000 more properties (3-byte string references). */
  readonly long: string;
  /** The shared embedded-cabinet MSI repacked by libgsf with 4096-byte sectors. */
  readonly v4: string;
}

/**
 * Write a compound file from another's streams with `gsf createole`, each
 * stream passed through `edit` (null drops it); the
 * root CLSID, which gsf leaves zero, is set to the MSI database CLSID that
 * libmsi requires (directory entry 0 starts the first directory sector).
 */
export const repack = async (
  source: string,
  output: string,
  sectorSize: 512 | 4096,
  edit: (name: string, bytes: Buffer) => Buffer | null = (_name, bytes) =>
    bytes,
): Promise<string> => {
  if (GSF === null) throw new Error("gsf is not installed");
  const staging = `${output}.streams`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  const files: string[] = [];
  for (const line of (await exec(GSF, ["list", source]))
    .toString("utf8")
    .split("\n")
    .slice(1)) {
    const match = /^f\s+(\d+) (.+)$/.exec(line);
    if (match?.[2] === undefined) continue;
    const bytes = edit(match[2], await exec(GSF, ["cat", source, match[2]]));
    if (bytes === null) continue;
    const path = join(staging, match[2]);
    await writeFile(path, bytes);
    files.push(path);
  }
  await rm(output, { force: true });
  await exec(
    GSF,
    ["--ole-big-block-size", String(sectorSize), "createole", output, ...files],
    staging,
  );
  const bytes = await readFile(output);
  const directory = bytes.readUInt32LE(48);
  Buffer.from("84100C0000000000C000000000000046", "hex").copy(
    bytes,
    (directory + 1) * (1 << bytes.readUInt16LE(30)) + 80,
  );
  await writeFile(output, bytes);
  return output;
};

export const buildCoverageFixtures = async (
  root: string,
  base: string,
): Promise<CoverageFixtures> => {
  const tools = WINDOWS_TOOLS;
  const msibuild = MSIBUILD;
  if (tools === null || msibuild === null)
    throw new Error("msitools are not installed");
  const source = join(root, "coverage");
  await mkdir(join(source, "src"), { recursive: true });
  await copyFile(tools.payload, join(source, "src/tool.exe"));
  await writeFile(join(source, "src/readme.txt"), "coverage\n");
  await writeFile(
    join(source, "src/setup.dll"),
    "MZ coverage dll bytes, never run\n",
  );
  await writeFile(
    join(source, "src/setup.js"),
    "function main() { return 1; }\n",
  );
  const build = async (
    name: string,
    codepage: 65001 | 1252,
    force: boolean,
  ): Promise<string> => {
    await writeFile(join(source, `${name}.wxs`), coverageXml(codepage));
    await exec(
      tools.wixl,
      ["-a", "x64", "-o", `${name}.msi`, `${name}.wxs`],
      source,
    );
    if (force) {
      // msibuild imports the code page and re-encodes the string pool on save.
      await mkdir(join(source, name), { recursive: true });
      await writeFile(
        join(source, name, "_ForceCodepage.idt"),
        `\r\n\r\n${String(codepage)}\t_ForceCodepage\r\n`,
      );
      await exec(
        msibuild,
        [`${name}.msi`, "-i", join(name, "_ForceCodepage.idt")],
        source,
      );
    }
    return join(source, `${name}.msi`);
  };
  const neutral = await build("neutral", 65001, false);
  const utf8 = await build("utf8", 65001, true);
  const latin = await build("latin", 1252, true);
  const sql = join(source, "sql.msi");
  await copyFile(utf8, sql);
  await writeFile(join(source, "pic.bin"), Buffer.from("picture stream bytes"));
  await writeFile(join(source, "signature.bin"), Buffer.alloc(300, 0x30));
  await writeFile(join(source, "signature-ex.bin"), Buffer.alloc(20, 0x31));
  await exec(
    msibuild,
    [
      basename(sql),
      ...coverageSql().flatMap((query) => ["-q", query]),
      "-a",
      "Pic.5",
      "pic.bin",
      "-a",
      "\u0005DigitalSignature",
      "signature.bin",
      "-a",
      "\u0005MsiDigitalSignatureEx",
      "signature-ex.bin",
    ],
    source,
  );
  const long = join(source, "long.msi");
  await copyFile(base, long);
  const rows = ["Property\tValue", "s72\tl0", "Property\tProperty"];
  for (let index = 0; index < 34_000; index += 1)
    rows.push(`P${String(index)}\tvalue ${String(index)}`);
  await writeFile(join(source, "Property.idt"), `${rows.join("\r\n")}\r\n`);
  await exec(msibuild, [basename(long), "-i", "Property.idt"], source);
  const v4 = await repack(base, join(source, "v4.msi"), 4096);
  return { neutral, utf8, latin, sql, long, v4 };
};
