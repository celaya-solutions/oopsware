import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  constants,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";

const run = promisify(execFile);

/**
 * Windows installer fixtures for F08. MSI databases come from msitools'
 * wixl (embedded MSZIP cabinet, or an external cabinet it declares but does
 * not write), companion cabinets from gcab, and the oracles are msiinfo,
 * msiextract, gcab and 7-Zip. No MSIX/AppX packaging tool exists for macOS,
 * so MSIX packages and bundles are hand-assembled from the published
 * AppxManifest, AppxBlockMap and AppxBundleManifest schemas with real ZIP
 * writing; tests say so. Nothing is installed and nothing runs.
 */
export interface WindowsTools {
  readonly wixl: string;
  readonly msiinfo: string;
  readonly msiextract: string;
  readonly gcab: string;
  readonly sevenZip: string;
  /** A real binary placed in the packages (the pinned AppImage runtime bytes; only bytes matter here). */
  readonly payload: string;
}

const executable = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const readable = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
};

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const findTool = async (name: string): Promise<string | null> => {
  for (const directory of ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"])
    if (await executable(join(directory, name))) return join(directory, name);
  return null;
};

const findPayload = async (): Promise<string | null> => {
  for (const candidate of [
    process.env.REA_TEST_APPIMAGE_RUNTIMES,
    join(repository, "_reference/linux-packages"),
    join(repository, "../../_reference/linux-packages"),
  ])
    if (
      candidate !== undefined &&
      candidate !== "" &&
      (await readable(join(candidate, "runtime-x86_64")))
    )
      return join(candidate, "runtime-x86_64");
  return null;
};

const findTools = async (): Promise<WindowsTools | null> => {
  const [wixl, msiinfo, msiextract, gcab, sevenZip, payload] =
    await Promise.all([
      findTool("wixl"),
      findTool("msiinfo"),
      findTool("msiextract"),
      findTool("gcab"),
      findTool("7zz"),
      findPayload(),
    ]);
  if (
    wixl === null ||
    msiinfo === null ||
    msiextract === null ||
    gcab === null ||
    sevenZip === null ||
    payload === null
  )
    return null;
  return { wixl, msiinfo, msiextract, gcab, sevenZip, payload };
};

export const WINDOWS_TOOLS = await findTools();

const tools = (): WindowsTools => {
  if (WINDOWS_TOOLS === null)
    throw new Error(
      "Windows installer fixtures need msitools (wixl, msiinfo, msiextract), gcab, 7zz and a payload binary (npm run fixtures:linux).",
    );
  return WINDOWS_TOOLS;
};

const exec = async (
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
    },
    maxBuffer: 256 * 1024 ** 2,
  });
  return stdout;
};

export const PRODUCT_NAME = "Oops Demo";
export const PRODUCT_VERSION = "1.2.3";
export const UPGRADE_CODE = "{12345678-1234-1234-1234-123456789012}";
export const README_TEXT = "hello msi\n";

const productXml = (
  media: string,
): string => `<?xml version="1.0" encoding="utf-8"?>
<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi">
  <Product Id="*" Name="${PRODUCT_NAME}" Language="1033" Version="${PRODUCT_VERSION}" Manufacturer="Oops Fixture" UpgradeCode="12345678-1234-1234-1234-123456789012">
    <Package InstallerVersion="500" Compressed="yes" InstallScope="perMachine" Description="Oops demo installer" Comments="fixture"/>
    <MajorUpgrade DowngradeErrorMessage="A newer version is installed."/>
    ${media}
    <Property Id="OOPS_MODE" Value="demo"/>
    <Condition Message="Needs Windows 10">VersionNT >= 603</Condition>
    <Binary Id="SetupDll" SourceFile="src/setup.dll"/>
    <Directory Id="TARGETDIR" Name="SourceDir">
      <Directory Id="ProgramFiles64Folder">
        <Directory Id="INSTALLDIR" Name="Oops">
          <Component Id="MainExe" Guid="11111111-2222-3333-4444-555555555555" Win64="yes">
            <File Id="ToolExe" Name="tool.exe" Source="src/tool.exe" KeyPath="yes"/>
            <RegistryValue Root="HKLM" Key="Software\\Oops" Name="InstallDir" Type="string" Value="[INSTALLDIR]"/>
            <ServiceInstall Id="OopsSvc" Name="OopsService" DisplayName="Oops Service" Type="ownProcess" Start="auto" ErrorControl="normal"/>
            <ServiceControl Id="OopsSvcCtl" Name="OopsService" Start="install" Stop="both" Remove="uninstall"/>
          </Component>
          <Component Id="Readme" Guid="22222222-2222-3333-4444-555555555555" Win64="yes">
            <File Id="ReadmeTxt" Name="readme.txt" Source="src/readme.txt" KeyPath="yes"/>
            <Environment Id="OopsPath" Name="PATH" Value="[INSTALLDIR]" Part="last" Action="set" System="yes"/>
            <IniFile Id="OopsIni" Name="oops.ini" Directory="INSTALLDIR" Section="main" Key="mode" Value="demo" Action="addLine"/>
            <Shortcut Id="OopsShortcut" Name="Oops" Directory="INSTALLDIR" Target="[INSTALLDIR]readme.txt"/>
          </Component>
        </Directory>
      </Directory>
    </Directory>
    <CustomAction Id="RunTool" FileKey="ToolExe" ExeCommand="--setup" Execute="deferred" Return="check" Impersonate="no"/>
    <CustomAction Id="CallDll" BinaryKey="SetupDll" DllEntry="Configure" Execute="immediate" Return="ignore"/>
    <CustomAction Id="SetMode" Property="OOPS_MODE" Value="[INSTALLDIR]"/>
    <InstallExecuteSequence>
      <Custom Action="SetMode" Before="CostFinalize"/>
      <Custom Action="RunTool" After="InstallFiles">NOT Installed</Custom>
      <Custom Action="CallDll" After="InstallFinalize">REMOVE="ALL"</Custom>
    </InstallExecuteSequence>
    <Feature Id="Main" Title="Main" Level="1">
      <ComponentRef Id="MainExe"/>
      <ComponentRef Id="Readme"/>
    </Feature>
  </Product>
</Wix>
`;

/** An MSI built by wixl in `directory`; `embed` chooses an embedded cabinet or an external one wixl does not write. */
const buildMsi = async (
  directory: string,
  name: string,
  embed: boolean,
  payload: Uint8Array,
): Promise<string> => {
  await mkdir(join(directory, "src"), { recursive: true });
  await writeFile(join(directory, "src/tool.exe"), payload);
  await writeFile(join(directory, "src/readme.txt"), README_TEXT);
  await writeFile(
    join(directory, "src/setup.dll"),
    Buffer.from("MZ fixture dll bytes, never run\n"),
  );
  const source = join(directory, `${name}.wxs`);
  await writeFile(
    source,
    productXml(
      `<Media Id="1" Cabinet="oops.cab" EmbedCab="${embed ? "yes" : "no"}"/>`,
    ),
  );
  const output = join(directory, `${name}.msi`);
  await exec(tools().wixl, ["-a", "x64", "-o", output, source], directory);
  return output;
};

/** A cabinet built by gcab whose member names are the MSI File keys; `compress` picks MSZIP or stored. */
const buildCabinet = async (
  directory: string,
  name: string,
  members: Readonly<Record<string, Uint8Array | string>>,
  compress: boolean,
): Promise<string> => {
  const staging = join(directory, `${name}-members`);
  await mkdir(staging, { recursive: true });
  for (const [member, content] of Object.entries(members))
    await writeFile(join(staging, member), content);
  const output = join(directory, name);
  await exec(
    tools().gcab,
    [
      "-c",
      ...(compress ? ["-z"] : []),
      "--nopath",
      output,
      ...Object.keys(members).map((member) => join(staging, member)),
    ],
    staging,
  );
  return output;
};

const sha256Base64 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("base64");

const BLOCK = 64 * 1024;

const escape = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/** AppxBlockMap.xml for stored members: one SHA-256 per 64 KiB block. */
const blockMap = (
  members: readonly (readonly [string, Uint8Array])[],
  lfhSizes: ReadonlyMap<string, number>,
): string => {
  const files = members.map(([name, bytes]) => {
    const blocks: string[] = [];
    for (let at = 0; at < bytes.length; at += BLOCK)
      blocks.push(
        `    <Block Hash="${sha256Base64(bytes.subarray(at, at + BLOCK))}"/>`,
      );
    return `  <File Name="${escape(name.replaceAll("/", "\\"))}" Size="${String(bytes.length)}" LfhSize="${String(lfhSizes.get(name) ?? 30 + Buffer.byteLength(name))}">\n${blocks.join("\n")}\n  </File>`;
  });
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<BlockMap xmlns="http://schemas.microsoft.com/appx/2010/blockmap" HashMethod="http://www.w3.org/2001/04/xmlenc#sha256">\n${files.join("\n")}\n</BlockMap>\n`;
};

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="exe" ContentType="application/x-msdownload"/><Default Extension="png" ContentType="image/png"/><Default Extension="msix" ContentType="application/vnd.ms-appx"/><Override PartName="/AppxManifest.xml" ContentType="application/vnd.ms-appx.manifest+xml"/><Override PartName="/AppxBlockMap.xml" ContentType="application/vnd.ms-appx.blockmap+xml"/><Override PartName="/AppxSignature.p7x" ContentType="application/vnd.ms-appx.signature"/><Override PartName="/AppxMetadata/AppxBundleManifest.xml" ContentType="application/vnd.ms-appx.bundlemanifest+xml"/></Types>
`;

/** A placeholder signature part: "PKCX" plus bytes. It is never verified; only its presence is reported. */
const SIGNATURE = Buffer.concat([
  Buffer.from("PKCX", "latin1"),
  Buffer.alloc(64, 0x5a),
]);

const LAST_MODIFIED = new Date(Date.UTC(2026, 0, 1));

/** Write stored members and return the bytes plus each member's data offset and local header size. */
const storedZip = async (
  members: readonly (readonly [string, Uint8Array])[],
): Promise<{
  bytes: Buffer;
  offsets: Map<string, { data: number; lfh: number }>;
}> => {
  const writer = new ZipWriter(new Uint8ArrayWriter(), {
    level: 0,
    useWebWorkers: false,
    extendedTimestamp: false,
    dataDescriptor: false,
  });
  for (const [name, bytes] of members)
    await writer.add(name, new Uint8ArrayReader(bytes), {
      level: 0,
      lastModDate: LAST_MODIFIED,
    });
  const bytes = Buffer.from(await writer.close());
  const offsets = new Map<string, { data: number; lfh: number }>();
  for (
    let at = 0;
    at + 30 <= bytes.length && bytes.readUInt32LE(at) === 0x04034b50;
  ) {
    const nameLength = bytes.readUInt16LE(at + 26);
    const extraLength = bytes.readUInt16LE(at + 28);
    const size = bytes.readUInt32LE(at + 18);
    const name = bytes.subarray(at + 30, at + 30 + nameLength).toString("utf8");
    const lfh = 30 + nameLength + extraLength;
    offsets.set(name, { data: at + lfh, lfh });
    at += lfh + size;
  }
  return { bytes, offsets };
};

/** A hand-assembled MSIX package: manifest, content types, block map over its files, placeholder signature. */
const msixPackage = async (
  architecture: string,
  files: readonly (readonly [string, Uint8Array])[],
  manifest: string,
): Promise<Buffer> => {
  const content: (readonly [string, Uint8Array])[] = [
    ["AppxManifest.xml", Buffer.from(manifest)],
    ...files,
  ];
  const first = await storedZip([
    ...content,
    ["AppxBlockMap.xml", Buffer.alloc(0)],
    ["[Content_Types].xml", Buffer.from(CONTENT_TYPES)],
  ]);
  const lfh = new Map(
    [...first.offsets].map(([name, entry]) => [name, entry.lfh]),
  );
  void architecture;
  return (
    await storedZip([
      ...content,
      ["AppxBlockMap.xml", Buffer.from(blockMap(content, lfh))],
      ["AppxSignature.p7x", SIGNATURE],
      ["[Content_Types].xml", Buffer.from(CONTENT_TYPES)],
    ])
  ).bytes;
};

const appManifest = (
  architecture: string,
): string => `<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10" xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10" xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities" IgnorableNamespaces="uap rescap">
  <Identity Name="Oops.Demo" Publisher="CN=Oops Fixture" Version="1.2.3.0" ProcessorArchitecture="${architecture}"/>
  <Properties><DisplayName>Oops Demo</DisplayName><PublisherDisplayName>Oops Fixture</PublisherDisplayName><Logo>Assets\\logo.png</Logo></Properties>
  <Dependencies><TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.17763.0" MaxVersionTested="10.0.22621.0"/></Dependencies>
  <Resources><Resource Language="en-us"/></Resources>
  <Applications>
    <Application Id="App" Executable="oops.exe" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements DisplayName="Oops" Description="Oops demo" BackgroundColor="transparent" Square150x150Logo="Assets\\logo.png" Square44x44Logo="Assets\\logo.png"/>
    </Application>
  </Applications>
  <Capabilities><Capability Name="internetClient"/><rescap:Capability Name="runFullTrust"/></Capabilities>
</Package>
`;

const resourceManifest = `<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10">
  <Identity Name="Oops.Demo" Publisher="CN=Oops Fixture" Version="1.2.3.0" ResourceId="split.scale-200"/>
  <Properties><DisplayName>Oops Demo</DisplayName><PublisherDisplayName>Oops Fixture</PublisherDisplayName><Logo>Assets\\logo.png</Logo><ResourcePackage>true</ResourcePackage></Properties>
  <Dependencies><TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.17763.0" MaxVersionTested="10.0.22621.0"/></Dependencies>
  <Resources><Resource uap:Scale="200" xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"/></Resources>
</Package>
`;

/** A hand-assembled bundle of two architecture packages and one resource package. */
const msixBundle = async (
  packages: readonly (readonly [
    string,
    Buffer,
    string,
    "application" | "resource",
  ])[],
): Promise<Buffer> => {
  const members: (readonly [string, Uint8Array])[] = packages.map(
    ([name, bytes]) => [name, bytes],
  );
  const placeholder = await storedZip([
    ["AppxMetadata/AppxBundleManifest.xml", Buffer.alloc(0)],
    ...members,
  ]);
  const manifest = (
    offsets: Map<string, { data: number; lfh: number }>,
  ) => `<?xml version="1.0" encoding="UTF-8"?>
<Bundle xmlns="http://schemas.microsoft.com/appx/2013/bundle" xmlns:b4="http://schemas.microsoft.com/appx/2018/bundle" SchemaVersion="5.0" IgnorableNamespaces="b4">
  <Identity Name="Oops.Demo" Publisher="CN=Oops Fixture" Version="1.2.3.0"/>
  <Packages>
${packages
  .map(([name, bytes, variant, type]) => {
    const offset = offsets.get(name)?.data ?? 0;
    return type === "application"
      ? `    <Package Type="application" Version="1.2.3.0" Architecture="${variant}" FileName="${name}" Offset="${String(offset)}" Size="${String(bytes.length)}"><Resources><Resource Language="en-us"/></Resources><b4:Dependencies><b4:TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.17763.0" MaxVersionTested="10.0.22621.0"/></b4:Dependencies></Package>`
      : `    <Package Type="resource" Version="1.2.3.0" ResourceId="${variant}" FileName="${name}" Offset="${String(offset)}" Size="${String(bytes.length)}"><Resources><Resource Scale="200"/></Resources></Package>`;
  })
  .join("\n")}
  </Packages>
</Bundle>
`;
  // The manifest's length moves the packages (an offset gaining a digit grows it); rewrite until it stops changing.
  let draft = manifest(placeholder.offsets);
  for (let pass = 0; pass < 8; pass += 1) {
    const sized = await storedZip([
      ["AppxMetadata/AppxBundleManifest.xml", Buffer.from(draft)],
      ...members,
    ]);
    const next = manifest(sized.offsets);
    if (next === draft) break;
    draft = next;
  }
  const bundleManifest = Buffer.from(draft);
  const content: (readonly [string, Uint8Array])[] = [
    ["AppxMetadata/AppxBundleManifest.xml", bundleManifest],
    ...members,
  ];
  const withMap = await storedZip([
    ...content,
    ["AppxBlockMap.xml", Buffer.alloc(0)],
  ]);
  const lfh = new Map(
    [...withMap.offsets].map(([name, entry]) => [name, entry.lfh]),
  );
  return (
    await storedZip([
      ...content,
      ["AppxBlockMap.xml", Buffer.from(blockMap(content, lfh))],
      ["AppxSignature.p7x", SIGNATURE],
      ["[Content_Types].xml", Buffer.from(CONTENT_TYPES)],
    ])
  ).bytes;
};

export interface WindowsFixtures {
  /** wixl MSI with an embedded MSZIP cabinet, registry, service, shortcut, environment, INI, custom actions. */
  readonly msi: string;
  /** The same product with an external cabinet that wixl declares but does not write. */
  readonly msiExternal: string;
  /** gcab companion cabinet (MSZIP) for msiExternal, members named by File key. */
  readonly cabinet: string;
  /** gcab stored (uncompressed) cabinet with the same members. */
  readonly cabinetStored: string;
  /** Hand-assembled MSIX packages and bundle (no MSIX tool on this host). */
  readonly msix: {
    readonly x64: string;
    readonly arm64: string;
    readonly resource: string;
  };
  readonly msixbundle: string;
  /** The binary placed as tool.exe / oops.exe. */
  readonly payload: string;
}

/** Build every Windows installer fixture under `root`. */
export const buildWindowsFixtures = async (
  root: string,
): Promise<WindowsFixtures> => {
  const payload = await readFile(tools().payload);
  const msi = await buildMsi(join(root, "embedded"), "oops", true, payload);
  const msiExternal = await buildMsi(
    join(root, "external"),
    "oops-external",
    false,
    payload,
  );
  const members = { ToolExe: payload, ReadmeTxt: README_TEXT };
  const cabinet = await buildCabinet(
    join(root, "external"),
    "oops.cab",
    members,
    true,
  );
  const cabinetStored = await buildCabinet(
    join(root, "stored"),
    "oops-stored.cab",
    members,
    false,
  );
  const logo = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  const x64 = await msixPackage(
    "x64",
    [
      ["oops.exe", payload],
      ["Assets/logo.png", logo],
    ],
    appManifest("x64"),
  );
  const arm64 = await msixPackage(
    "arm64",
    [
      ["oops.exe", payload],
      ["Assets/logo.png", logo],
    ],
    appManifest("arm64"),
  );
  const resource = await msixPackage(
    "neutral",
    [["Assets/logo.scale-200.png", logo]],
    resourceManifest,
  );
  const msixDirectory = join(root, "msix");
  await mkdir(msixDirectory, { recursive: true });
  const paths = {
    x64: join(msixDirectory, "Oops.Demo_1.2.3.0_x64.msix"),
    arm64: join(msixDirectory, "Oops.Demo_1.2.3.0_arm64.msix"),
    resource: join(msixDirectory, "Oops.Demo_1.2.3.0_scale-200.msix"),
  };
  await writeFile(paths.x64, x64);
  await writeFile(paths.arm64, arm64);
  await writeFile(paths.resource, resource);
  const bundle = await msixBundle([
    ["Oops.Demo_1.2.3.0_x64.msix", x64, "x64", "application"],
    ["Oops.Demo_1.2.3.0_arm64.msix", arm64, "arm64", "application"],
    [
      "Oops.Demo_1.2.3.0_scale-200.msix",
      resource,
      "split.scale-200",
      "resource",
    ],
  ]);
  const msixbundle = join(msixDirectory, "Oops.Demo_1.2.3.0.msixbundle");
  await writeFile(msixbundle, bundle);
  return {
    msi,
    msiExternal,
    cabinet,
    cabinetStored,
    msix: paths,
    msixbundle,
    payload: tools().payload,
  };
};

/** The oracles' views: msiinfo, gcab or 7-Zip output for a fixture. */
export const windowsOracle = async (
  tool: "msiinfo" | "gcab" | "7zz" | "msiextract",
  args: readonly string[],
  cwd?: string,
): Promise<Buffer> => {
  const path = {
    msiinfo: tools().msiinfo,
    gcab: tools().gcab,
    "7zz": tools().sevenZip,
    msiextract: tools().msiextract,
  }[tool];
  return exec(path, args, cwd);
};
