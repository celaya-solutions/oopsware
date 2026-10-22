import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  checkBundleLayout,
  parseAppxBundleManifest,
  type AppxBundleManifest,
} from "./bundle.js";
import {
  APPX_BLOCK_BYTES,
  parseAppxBlockMap,
  verifyBlockMap,
  type AppxBlockMap,
} from "./blockMap.js";
import { parseAppxManifest, type AppxManifest } from "./manifest.js";
import { readAppxSignature } from "./signature.js";
import {
  buildWindowsFixtures,
  WINDOWS_TOOLS,
  type WindowsFixtures,
} from "../../../tests/fixtures/windowsProducers.js";
import { removeTestWorkspace } from "../../../tests/support/workspace/workspaceFixture.js";

/**
 * The AppX/MSIX readers. No MSIX packaging tool (MakeAppx, the MSIX SDK
 * packager) runs on macOS, so the packages and bundle are hand-assembled by
 * tests/fixtures/windowsProducers.ts from the published AppxManifest,
 * AppxBlockMap and AppxBundleManifest schemas with real ZIP writing; the
 * expectations below are the values that file writes. ZIP layout is
 * checked against zipinfo. Further manifests are hand-written here from the
 * same schemas.
 */

const run = promisify(execFile);

let root: string | undefined;
let building: Promise<WindowsFixtures> | undefined;

const built = (): Promise<WindowsFixtures> => {
  building ??= (async () => {
    root = await realpath(
      await mkdtemp(join(await realpath(tmpdir()), "rea-appx-")),
    );
    return buildWindowsFixtures(root);
  })();
  return building;
};

afterAll(async () => {
  if (root !== undefined) await removeTestWorkspace(root);
});

const useFixtures = () => {
  beforeAll(async () => {
    await built();
  }, 120_000);
};

interface ZipMember {
  readonly name: string;
  readonly header_offset: number;
  readonly data_offset: number;
  readonly stored_size: number;
  readonly bytes: Buffer;
}

/** Members from the central directory; data offsets from each local header. The fixtures are stored. */
const zipMembers = (bytes: Buffer): ZipMember[] => {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let at = bytes.readUInt32LE(end + 16);
  return Array.from({ length: bytes.readUInt16LE(end + 10) }, () => {
    const nameLength = bytes.readUInt16LE(at + 28);
    const name = bytes.toString("utf8", at + 46, at + 46 + nameLength);
    const header_offset = bytes.readUInt32LE(at + 42);
    const stored_size = bytes.readUInt32LE(at + 20);
    expect(bytes.readUInt16LE(at + 10), name).toBe(0);
    const data_offset =
      header_offset +
      30 +
      bytes.readUInt16LE(header_offset + 26) +
      bytes.readUInt16LE(header_offset + 28);
    at +=
      46 +
      nameLength +
      bytes.readUInt16LE(at + 30) +
      bytes.readUInt16LE(at + 32);
    return {
      name,
      header_offset,
      data_offset,
      stored_size,
      bytes: bytes.subarray(data_offset, data_offset + stored_size),
    };
  });
};

/** zipinfo's member names and local header offsets. */
const zipinfoOffsets = async (path: string): Promise<[string, number][]> => {
  const { stdout } = await run("/usr/bin/unzip", ["-Zv", path]);
  return stdout
    .split("Central directory entry #")
    .slice(1)
    .map((entry) => {
      const lines = entry
        .split("\n")
        .slice(1)
        .map((line) => line.trim());
      const name =
        lines.find((line) => line !== "" && !/^-+$/u.test(line)) ?? "";
      const offset =
        /offset of local header from start of archive:\s+(\d+)/u.exec(entry);
      return [name, Number(offset?.[1])];
    });
};

const openZip = async (path: string) => {
  const members = zipMembers(await readFile(path));
  expect(members.map((member) => [member.name, member.header_offset])).toEqual(
    await zipinfoOffsets(path),
  );
  const member = (name: string): Buffer => {
    const found = members.find((entry) => entry.name === name);
    if (found === undefined) throw new Error(`No ${name}`);
    return found.bytes;
  };
  return { members, member, names: members.map((entry) => entry.name) };
};

const unwrap = <T>(
  result: { ok: true; value: T } | { ok: false; error: { message: string } },
): T => {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

const xml = (text: string): Buffer => Buffer.from(text, "utf8");

const fixtureManifest = (architecture: string): AppxManifest => ({
  namespace: "http://schemas.microsoft.com/appx/manifest/foundation/windows10",
  schema: "windows10",
  identity: {
    name: "Oops.Demo",
    publisher: "CN=Oops Fixture",
    version: "1.2.3.0",
    processor_architecture: architecture,
    resource_id: null,
  },
  properties: {
    display_name: "Oops Demo",
    publisher_display_name: "Oops Fixture",
    logo: "Assets\\logo.png",
    description: null,
    resource_package: null,
    framework: null,
  },
  target_device_families: [
    {
      name: "Windows.Desktop",
      min_version: "10.0.17763.0",
      max_version_tested: "10.0.22621.0",
    },
  ],
  os_min_version: null,
  os_max_version_tested: null,
  package_dependencies: [],
  resources: [{ language: "en-us", scale: null, dx_feature_level: null }],
  applications: [
    {
      id: "App",
      executable: "oops.exe",
      entry_point: "Windows.FullTrustApplication",
      trust_level: null,
      runtime_behavior: null,
      extensions: [],
    },
  ],
  package_extensions: [],
  capabilities: [
    {
      name: "internetClient",
      kind: "general",
      namespace:
        "http://schemas.microsoft.com/appx/manifest/foundation/windows10",
    },
    {
      name: "runFullTrust",
      kind: "restricted",
      namespace:
        "http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities",
    },
  ],
  problems: [],
});

describe.skipIf(WINDOWS_TOOLS === null)(
  "hand-assembled MSIX package manifests (no MSIX tool on macOS)",
  () => {
    useFixtures();

    it.each(["x64", "arm64"] as const)(
      "reads the %s application package's manifest as written",
      async (architecture) => {
        const zip = await openZip((await built()).msix[architecture]);
        expect(
          unwrap(parseAppxManifest(zip.member("AppxManifest.xml"))),
        ).toEqual(fixtureManifest(architecture));
      },
    );

    it("reads the resource package's ResourceId, ResourcePackage and uap:Scale", async () => {
      const zip = await openZip((await built()).msix.resource);
      const manifest = unwrap(
        parseAppxManifest(zip.member("AppxManifest.xml")),
      );
      expect(manifest.identity).toEqual({
        name: "Oops.Demo",
        publisher: "CN=Oops Fixture",
        version: "1.2.3.0",
        processor_architecture: null,
        resource_id: "split.scale-200",
      });
      expect(manifest.properties.resource_package).toBe(true);
      expect(manifest.resources).toEqual([
        { language: null, scale: "200", dx_feature_level: null },
      ]);
      expect(manifest.applications).toEqual([]);
      expect(manifest.capabilities).toEqual([]);
      expect(manifest.problems).toEqual([]);
    });
  },
);

const NS = {
  foundation: "http://schemas.microsoft.com/appx/manifest/foundation/windows10",
  uap: "http://schemas.microsoft.com/appx/manifest/uap/windows10",
  uap3: "http://schemas.microsoft.com/appx/manifest/uap/windows10/3",
  uap4: "http://schemas.microsoft.com/appx/manifest/uap/windows10/4",
  uap5: "http://schemas.microsoft.com/appx/manifest/uap/windows10/5",
  uap10: "http://schemas.microsoft.com/appx/manifest/uap/windows10/10",
  desktop: "http://schemas.microsoft.com/appx/manifest/desktop/windows10",
  com: "http://schemas.microsoft.com/appx/manifest/com/windows10",
  rescap:
    "http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities",
  iot: "http://schemas.microsoft.com/appx/manifest/iot/windows10",
};

/** Hand-written from the Windows 10 AppxManifest schema: one of each declaration this reader names. */
const DECLARATIONS = `<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="${NS.foundation}" ${Object.entries(NS)
  .filter(([prefix]) => prefix !== "foundation")
  .map(([prefix, uri]) => `xmlns:${prefix}="${uri}"`)
  .join(
    " ",
  )} IgnorableNamespaces="uap uap3 uap4 uap5 uap10 desktop com rescap iot">
  <Identity Name="Oops.Full" Publisher="CN=Oops" Version="2.0.0.0" ProcessorArchitecture="neutral"/>
  <Properties><DisplayName>Full</DisplayName><PublisherDisplayName>Oops</PublisherDisplayName><Logo>logo.png</Logo><Description>Every declaration</Description><Framework>false</Framework></Properties>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.19041.0" MaxVersionTested="10.0.26100.0"/>
    <PackageDependency Name="Microsoft.VCLibs.140.00.UWPDesktop" Publisher="CN=Microsoft Corporation" MinVersion="14.0.24217.0" MaxMajorVersionTested="14"/>
    <uap3:MainPackageDependency Name="Oops.Main"/>
  </Dependencies>
  <Resources><Resource Language="en-us"/><Resource uap:DXFeatureLevel="dx11"/></Resources>
  <Applications>
    <Application Id="Tool" Executable="tool.exe" EntryPoint="Windows.FullTrustApplication" uap10:TrustLevel="mediumIL" uap10:RuntimeBehavior="win32App">
      <Extensions>
        <desktop:Extension Category="windows.fullTrustProcess" Executable="helper.exe"/>
        <uap:Extension Category="windows.protocol"><uap:Protocol Name="oops"/></uap:Extension>
        <desktop:Extension Category="windows.startupTask" Executable="tool.exe" EntryPoint="Windows.FullTrustApplication"><desktop:StartupTask TaskId="OopsStartup" Enabled="true" DisplayName="Oops"/></desktop:Extension>
        <com:Extension Category="windows.comServer"><com:ComServer><com:ExeServer Executable="tool.exe" DisplayName="Oops COM"><com:Class Id="11111111-2222-3333-4444-555555555555"/></com:ExeServer></com:ComServer></com:Extension>
        <uap5:Extension Category="windows.appExecutionAlias" Executable="tool.exe" EntryPoint="Windows.FullTrustApplication"><uap5:AppExecutionAlias><uap5:ExecutionAlias Alias="oops.exe"/></uap5:AppExecutionAlias></uap5:Extension>
      </Extensions>
    </Application>
  </Applications>
  <Extensions><Extension Category="windows.activatableClass.inProcessServer"><InProcessServer><Path>oops.dll</Path><ActivatableClass ActivatableClassId="Oops.Widget" ThreadingModel="both"/></InProcessServer></Extension></Extensions>
  <Capabilities>
    <Capability Name="internetClient"/>
    <uap:Capability Name="picturesLibrary"/>
    <uap3:Capability Name="backgroundMediaPlayback"/>
    <rescap:Capability Name="runFullTrust"/>
    <rescap:Capability Name="allowElevation"/>
    <iot:Capability Name="systemManagement"/>
    <uap4:CustomCapability Name="Oops.Custom_0123456789abc"/>
    <DeviceCapability Name="webcam"/>
  </Capabilities>
</Package>
`;

describe("manifest declarations hand-written from the published schemas", () => {
  it("names every Extension's category with what it declares, as declarations", () => {
    const manifest = unwrap(parseAppxManifest(xml(DECLARATIONS)));
    expect(manifest.problems).toEqual([]);
    const [application] = manifest.applications;
    expect(application).toMatchObject({
      id: "Tool",
      executable: "tool.exe",
      entry_point: "Windows.FullTrustApplication",
      trust_level: "mediumIL",
      runtime_behavior: "win32App",
    });
    expect(application?.extensions).toEqual([
      {
        category: "windows.fullTrustProcess",
        namespace: NS.desktop,
        executable: "helper.exe",
        entry_point: null,
        names: [],
      },
      {
        category: "windows.protocol",
        namespace: NS.uap,
        executable: null,
        entry_point: null,
        names: ["oops"],
      },
      {
        category: "windows.startupTask",
        namespace: NS.desktop,
        executable: "tool.exe",
        entry_point: "Windows.FullTrustApplication",
        names: ["OopsStartup"],
      },
      {
        category: "windows.comServer",
        namespace: NS.com,
        executable: null,
        entry_point: null,
        names: ["11111111-2222-3333-4444-555555555555"],
      },
      {
        category: "windows.appExecutionAlias",
        namespace: NS.uap5,
        executable: "tool.exe",
        entry_point: "Windows.FullTrustApplication",
        names: ["oops.exe"],
      },
    ]);
    expect(manifest.package_extensions).toEqual([
      {
        category: "windows.activatableClass.inProcessServer",
        namespace: NS.foundation,
        executable: null,
        entry_point: null,
        names: [],
      },
    ]);
  });

  it("sorts capabilities by namespace: general, uap, restricted, other, custom, device", () => {
    const manifest = unwrap(parseAppxManifest(xml(DECLARATIONS)));
    expect(manifest.capabilities.map(({ name, kind }) => [name, kind])).toEqual(
      [
        ["internetClient", "general"],
        ["picturesLibrary", "uap"],
        ["backgroundMediaPlayback", "uap"],
        ["runFullTrust", "restricted"],
        ["allowElevation", "restricted"],
        ["systemManagement", "other"],
        ["Oops.Custom_0123456789abc", "custom"],
        ["webcam", "device"],
      ],
    );
  });

  it("reads dependencies, resources and properties", () => {
    const manifest = unwrap(parseAppxManifest(xml(DECLARATIONS)));
    expect(manifest.package_dependencies).toEqual([
      {
        kind: "package",
        name: "Microsoft.VCLibs.140.00.UWPDesktop",
        publisher: "CN=Microsoft Corporation",
        min_version: "14.0.24217.0",
        max_major_version_tested: "14",
      },
      {
        kind: "main",
        name: "Oops.Main",
        publisher: null,
        min_version: null,
        max_major_version_tested: null,
      },
    ]);
    expect(manifest.resources).toEqual([
      { language: "en-us", scale: null, dx_feature_level: null },
      { language: null, scale: null, dx_feature_level: "dx11" },
    ]);
    expect(manifest.properties).toMatchObject({
      description: "Every declaration",
      framework: false,
      resource_package: null,
    });
  });

  it("accepts the Windows 8 namespace with its Prerequisites and m2 device capability", () => {
    const manifest = unwrap(
      parseAppxManifest(
        xml(`<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/2010/manifest" xmlns:m2="http://schemas.microsoft.com/appx/2013/manifest">
  <Identity Name="Oops.Eight" Publisher="CN=Oops" Version="1.0.0.0" ProcessorArchitecture="x86"/>
  <Properties><DisplayName>Eight</DisplayName><PublisherDisplayName>Oops</PublisherDisplayName><Logo>logo.png</Logo></Properties>
  <Prerequisites><OSMinVersion>6.2.1</OSMinVersion><OSMaxVersionTested>6.3.0</OSMaxVersionTested></Prerequisites>
  <Resources><Resource Language="x-generate"/></Resources>
  <Applications><Application Id="App" Executable="eight.exe" EntryPoint="Eight.App"/></Applications>
  <Capabilities><Capability Name="internetClient"/><m2:DeviceCapability Name="bluetooth.genericAttributeProfile"/></Capabilities>
</Package>`),
      ),
    );
    expect(manifest.schema).toBe("windows8");
    expect([manifest.os_min_version, manifest.os_max_version_tested]).toEqual([
      "6.2.1",
      "6.3.0",
    ]);
    expect(manifest.capabilities.map(({ name, kind }) => [name, kind])).toEqual(
      [
        ["internetClient", "general"],
        ["bluetooth.genericAttributeProfile", "device"],
      ],
    );
    expect(manifest.problems).toEqual([]);
  });

  it("states what a manifest lacks and rejects a non-boolean flag", () => {
    const manifest = unwrap(
      parseAppxManifest(
        xml(
          `<Package xmlns="${NS.foundation}"><Identity Name="Oops"/><Properties><Framework>maybe</Framework></Properties></Package>`,
        ),
      ),
    );
    expect(manifest.problems).toEqual([
      "Identity has no Publisher attribute.",
      "Identity has no Version attribute.",
      'Framework is "maybe", not an xs:boolean.',
    ]);
  });
});

/** The fixture bundle's three packages as written by windowsProducers.ts, offsets aside. */
const BUNDLE_PACKAGES = [
  {
    type: "application",
    architecture: "x64",
    resource_id: null,
    file_name: "Oops.Demo_1.2.3.0_x64.msix",
    resources: [{ language: "en-us", scale: null, dx_feature_level: null }],
    families: 1,
  },
  {
    type: "application",
    architecture: "arm64",
    resource_id: null,
    file_name: "Oops.Demo_1.2.3.0_arm64.msix",
    resources: [{ language: "en-us", scale: null, dx_feature_level: null }],
    families: 1,
  },
  {
    type: "resource",
    architecture: null,
    resource_id: "split.scale-200",
    file_name: "Oops.Demo_1.2.3.0_scale-200.msix",
    resources: [{ language: null, scale: "200", dx_feature_level: null }],
    families: 0,
  },
];

const bundleZip = async () => openZip((await built()).msixbundle);

const locator = (members: readonly ZipMember[]) => (name: string) => {
  const found = members.find((member) => member.name === name);
  return found === undefined
    ? null
    : { data_offset: found.data_offset, stored_size: found.stored_size };
};

describe.skipIf(WINDOWS_TOOLS === null)(
  "the hand-assembled MSIX bundle",
  () => {
    useFixtures();

    it("reads the bundle manifest as written", async () => {
      const zip = await bundleZip();
      const bundle = unwrap(
        parseAppxBundleManifest(
          zip.member("AppxMetadata/AppxBundleManifest.xml"),
        ),
      );
      expect(bundle.schema_version).toBe("5.0");
      expect(bundle.identity).toEqual({
        name: "Oops.Demo",
        publisher: "CN=Oops Fixture",
        version: "1.2.3.0",
        processor_architecture: null,
        resource_id: null,
      });
      expect(
        bundle.packages.map((entry) => ({
          type: entry.type,
          architecture: entry.architecture,
          resource_id: entry.resource_id,
          file_name: entry.file_name,
          resources: entry.resources,
          families: entry.target_device_families.length,
        })),
      ).toEqual(BUNDLE_PACKAGES);
      expect(bundle.packages[0]?.target_device_families).toEqual([
        {
          name: "Windows.Desktop",
          min_version: "10.0.17763.0",
          max_version_tested: "10.0.22621.0",
        },
      ]);
      expect(
        bundle.packages.every((entry) => entry.version === "1.2.3.0"),
      ).toBe(true);
      expect(bundle.optional_bundles).toEqual([]);
      expect(bundle.problems).toEqual([]);
    });

    it("finds each package at the Offset and Size it declares (zipinfo's local headers)", async () => {
      const zip = await bundleZip();
      const bundle = unwrap(
        parseAppxBundleManifest(
          zip.member("AppxMetadata/AppxBundleManifest.xml"),
        ),
      );
      const checks = checkBundleLayout(bundle, locator(zip.members));
      expect(checks.map((check) => check.matches)).toEqual([true, true, true]);
      for (const check of checks) {
        const member = zip.members.find(
          (entry) => entry.name === check.file_name,
        );
        expect(check.offset.declared).toBe(member?.data_offset);
        expect(
          zip
            .member(check.file_name ?? "")
            .subarray(0, 4)
            .toString("latin1"),
        ).toBe("PK\u0003\u0004");
      }
    });

    it("reports a package whose declared Offset is one byte off, and one that is absent", async () => {
      const zip = await bundleZip();
      const text = zip
        .member("AppxMetadata/AppxBundleManifest.xml")
        .toString("utf8");
      const shifted = text.replace(
        /Offset="(\d+)"/u,
        (_, offset: string) => `Offset="${String(Number(offset) - 1)}"`,
      );
      const bundle: AppxBundleManifest = unwrap(
        parseAppxBundleManifest(xml(shifted)),
      );
      const checks = checkBundleLayout(bundle, (name) =>
        name.includes("arm64") ? null : locator(zip.members)(name),
      );
      expect(checks.map(({ matches, found }) => [matches, found])).toEqual([
        [false, true],
        [false, false],
        [true, true],
      ]);
      expect(checks[0]?.offset).toEqual({
        declared: (checks[0]?.offset.actual ?? 0) - 1,
        actual: checks[0]?.offset.actual,
      });
    });

    it("reads OptionalBundle entries (hand-written from the bundle schema)", () => {
      const bundle = unwrap(
        parseAppxBundleManifest(
          xml(`<Bundle xmlns="http://schemas.microsoft.com/appx/2013/bundle" SchemaVersion="3.0">
  <Identity Name="Oops.Main" Publisher="CN=Oops" Version="1.0.0.0"/>
  <Packages>
    <Package Type="application" Version="1.0.0.0" Architecture="x64" FileName="main.msix" Offset="0" Size="10"/>
    <OptionalBundle Name="Oops.Extra" Publisher="CN=Oops" Version="1.0.0.0" FileName="extra.msixbundle">
      <Package Type="application" Version="1.0.0.0" Architecture="x64" FileName="extra_x64.msix"/>
    </OptionalBundle>
  </Packages>
</Bundle>`),
        ),
      );
      expect(bundle.optional_bundles).toMatchObject([
        {
          name: "Oops.Extra",
          file_name: "extra.msixbundle",
          packages: [{ file_name: "extra_x64.msix", offset: null, size: null }],
        },
      ]);
      expect(bundle.problems).toEqual([]);
    });
  },
);

const packageZip = async (pick: (fixtures: WindowsFixtures) => string) =>
  openZip(pick(await built()));

const blockMapOf = (zip: Awaited<ReturnType<typeof openZip>>): AppxBlockMap =>
  unwrap(parseAppxBlockMap(zip.member("AppxBlockMap.xml")));

const membersOf =
  (zip: Awaited<ReturnType<typeof openZip>>) => (path: string) =>
    zip.names.includes(path) ? zip.member(path) : null;

describe.skipIf(WINDOWS_TOOLS === null)(
  "hand-assembled block maps recomputed over every member",
  () => {
    useFixtures();

    it.each([
      [
        "x64 package",
        (f: WindowsFixtures) => f.msix.x64,
        ["AppxManifest.xml", "oops.exe", "Assets/logo.png"],
      ],
      [
        "arm64 package",
        (f: WindowsFixtures) => f.msix.arm64,
        ["AppxManifest.xml", "oops.exe", "Assets/logo.png"],
      ],
      [
        "resource package",
        (f: WindowsFixtures) => f.msix.resource,
        ["AppxManifest.xml", "Assets/logo.scale-200.png"],
      ],
      [
        "bundle",
        (f: WindowsFixtures) => f.msixbundle,
        [
          "AppxMetadata/AppxBundleManifest.xml",
          "Oops.Demo_1.2.3.0_x64.msix",
          "Oops.Demo_1.2.3.0_arm64.msix",
          "Oops.Demo_1.2.3.0_scale-200.msix",
        ],
      ],
    ] as const)("verifies the %s", async (_, pick, paths) => {
      const zip = await packageZip(pick);
      const map = blockMapOf(zip);
      expect(map.hash).toBe("sha256");
      expect(map.problems).toEqual([]);
      expect(map.files.map((file) => file.path)).toEqual(paths);
      expect(map.files.map((file) => file.name)).toEqual(
        paths.map((path) => path.replaceAll("/", "\\")),
      );
      for (const file of map.files) {
        const member = zip.members.find((entry) => entry.name === file.path);
        expect(file.size).toBe(member?.stored_size);
        // The fixture's LfhSize is the real local header: 30 bytes plus the name.
        expect(file.lfh_size).toBe(
          (member?.data_offset ?? 0) - (member?.header_offset ?? 0),
        );
        expect(file.blocks.every((block) => block.size === null)).toBe(true);
      }
      const result = await verifyBlockMap(map, membersOf(zip), {
        names: zip.names,
      });
      expect(result.unlisted).toEqual([]);
      expect(result.files.every((file) => file.verified)).toBe(true);
      expect(result.verified).toBe(true);
    });

    it("flags exactly the block holding a changed byte", async () => {
      const zip = await packageZip((f) => f.msix.x64);
      const map = blockMapOf(zip);
      const result = await verifyBlockMap(map, (path) => {
        const bytes = membersOf(zip)(path);
        if (path !== "oops.exe" || bytes === null) return bytes;
        const changed = Buffer.from(bytes);
        changed[APPX_BLOCK_BYTES + 4_464] =
          (changed[APPX_BLOCK_BYTES + 4_464] ?? 0) ^ 0xff;
        return changed;
      });
      const exe = result.files.find((file) => file.path === "oops.exe");
      expect(exe).toMatchObject({
        mismatched_blocks: [1],
        verified: false,
        missing: false,
      });
      expect(exe?.size).toEqual({ declared: 944_632, actual: 944_632 });
      expect(
        result.files.filter((file) => file.verified).map((file) => file.path),
      ).toEqual(["AppxManifest.xml", "Assets/logo.png"]);
      expect(result.verified).toBe(false);
    });

    it("reports a missing member, a shortened one and members the map does not list", async () => {
      const zip = await packageZip((f) => f.msix.x64);
      const result = await verifyBlockMap(
        blockMapOf(zip),
        (path) =>
          path === "Assets/logo.png"
            ? null
            : path === "oops.exe"
              ? zip.member(path).subarray(0, 70_000)
              : membersOf(zip)(path),
        {
          names: [
            ...zip.names,
            "Assets/extra%20file.dat",
            "AppxMetadata/CodeIntegrity.cat",
            "Assets/",
          ],
        },
      );
      expect(
        result.files.find((file) => file.path === "Assets/logo.png"),
      ).toMatchObject({ missing: true, verified: false });
      expect(
        result.files.find((file) => file.path === "oops.exe"),
      ).toMatchObject({
        size: { declared: 944_632, actual: 70_000 },
        block_count: { declared: 15, expected: 2 },
        mismatched_blocks: [1],
        verified: false,
      });
      // The map never lists itself, the signature or [Content_Types].xml; a CodeIntegrity.cat must be listed.
      expect(result.unlisted).toEqual([
        "Assets/extra%20file.dat",
        "AppxMetadata/CodeIntegrity.cat",
      ]);
    });

    it("streams a member in uneven chunks to the same digests", async () => {
      const zip = await packageZip((f) => f.msix.arm64);
      async function* uneven(bytes: Buffer) {
        for (
          let at = 0, step = 1;
          at < bytes.length;
          at += step, step = ((step * 7) % 100_003) + 1
        )
          yield bytes.subarray(at, at + step);
      }
      const result = await verifyBlockMap(blockMapOf(zip), (path) =>
        uneven(zip.member(path)),
      );
      expect(result.files.map((file) => file.verified)).toEqual([
        true,
        true,
        true,
      ]);
    });
  },
);

/** A block map over one member, hand-written with the given HashMethod URI and digest. */
const singleFileMap = (method: string, hash: string, size: number) =>
  xml(`<?xml version="1.0" encoding="UTF-8"?>
<BlockMap xmlns="http://schemas.microsoft.com/appx/2010/blockmap" HashMethod="${method}">
  <File Name="Assets\\a.bin" Size="${String(size)}" LfhSize="43"><Block Hash="${hash}" Size="12"/></File>
</BlockMap>`);

describe("block map hash methods and records hand-written from the schema", () => {
  const bytes = Buffer.from("seventeen bytes!!");

  it.each([
    ["sha384", "http://www.w3.org/2001/04/xmldsig-more#sha384"],
    ["sha512", "http://www.w3.org/2001/04/xmlenc#sha512"],
  ] as const)(
    "verifies a %s map and keeps a compressed block's Size",
    async (hash, uri) => {
      const { createHash } = await import("node:crypto");
      const map = unwrap(
        parseAppxBlockMap(
          singleFileMap(
            uri,
            createHash(hash).update(bytes).digest("base64"),
            bytes.length,
          ),
        ),
      );
      expect(map).toMatchObject({ hash, problems: [] });
      expect(map.files[0]).toMatchObject({
        name: "Assets\\a.bin",
        path: "Assets/a.bin",
        lfh_size: 43,
        blocks: [{ size: 12 }],
      });
      expect((await verifyBlockMap(map, () => bytes)).verified).toBe(true);
    },
  );

  it("reports an unknown hash method, a malformed digest, a wrong block count and a repeated name", async () => {
    const unknown = unwrap(
      parseAppxBlockMap(singleFileMap("urn:md5", "AAAA", 17)),
    );
    expect(unknown.hash).toBeNull();
    expect(unknown.problems).toEqual([
      'HashMethod "urn:md5" is not SHA-256, SHA-384 or SHA-512; blocks cannot be checked.',
    ]);
    expect((await verifyBlockMap(unknown, () => bytes)).verified).toBe(false);
    const bad = unwrap(
      parseAppxBlockMap(
        singleFileMap(
          "http://www.w3.org/2001/04/xmlenc#sha256",
          "not-base64",
          70_000,
        ),
      ),
    );
    expect(bad.problems).toEqual([
      'File "Assets\\a.bin" block 0 hash is not a base64 32-byte digest.',
      'File "Assets\\a.bin" is 70000 bytes but lists 1 blocks; 2 are needed.',
    ]);
    const twice = unwrap(
      parseAppxBlockMap(
        xml(
          `<BlockMap xmlns="http://schemas.microsoft.com/appx/2010/blockmap" HashMethod="http://www.w3.org/2001/04/xmlenc#sha256"><File Name="a" Size="0" LfhSize="31"/><File Name="A" Size="0" LfhSize="31"/></BlockMap>`,
        ),
      ),
    );
    expect(twice.problems).toEqual(['File "A" is listed twice.']);
  });
});

describe.skipIf(WINDOWS_TOOLS === null)("the signature part", () => {
  useFixtures();

  it("records the fixture's PKCX placeholder without verifying anything", async () => {
    const zip = await packageZip((f) => f.msixbundle);
    const part = readAppxSignature(zip.member("AppxSignature.p7x"));
    expect(part).toMatchObject({
      size: 68,
      magic: true,
      pkcs7_bytes: 64,
      der_length: null,
    });
    expect(part.pkcs7_sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(part.problems).toEqual([
      "The PKCS#7 blob does not start with a definite-length DER SEQUENCE.",
    ]);
  });
});

describe("signature part shapes", () => {
  const der = (length: number, body: number) =>
    Buffer.concat([
      Buffer.from("PKCX", "latin1"),
      Buffer.from([0x30, 0x82, length >> 8, length & 0xff]),
      Buffer.alloc(body, 0x02),
    ]);

  it("records a DER SEQUENCE's length and says when the blob is longer or shorter", () => {
    expect(readAppxSignature(der(300, 300))).toMatchObject({
      magic: true,
      pkcs7_bytes: 304,
      der_length: 304,
      problems: [],
    });
    expect(readAppxSignature(der(300, 200)).problems).toEqual([
      "The PKCS#7 SEQUENCE spans 304 bytes; 204 follow the magic.",
    ]);
    expect(readAppxSignature(Buffer.from("MZ\u0090\u0000")).problems).toEqual([
      'The signature part does not start with "PKCX".',
      "The PKCS#7 blob does not start with a definite-length DER SEQUENCE.",
    ]);
  });
});

const PARSERS = [
  [
    "AppxManifest.xml",
    parseAppxManifest,
    `<Package xmlns="${NS.foundation}">`,
    "</Package>",
  ],
  [
    "AppxBundleManifest.xml",
    parseAppxBundleManifest,
    '<Bundle xmlns="http://schemas.microsoft.com/appx/2013/bundle">',
    "</Bundle>",
  ],
  [
    "AppxBlockMap.xml",
    parseAppxBlockMap,
    '<BlockMap xmlns="http://schemas.microsoft.com/appx/2010/blockmap">',
    "</BlockMap>",
  ],
] as const;

const LAUGHS = `<?xml version="1.0"?>
<!DOCTYPE lolz [
 <!ENTITY lol "lol">
${Array.from({ length: 9 }, (_, level) => ` <!ENTITY lol${String(level + 1)} "${`&lol${level === 0 ? "" : String(level)};`.repeat(10)}">`).join("\n")}
]>`;

describe("hostile and malformed AppX XML", () => {
  it.each(PARSERS)(
    "%s: a DOCTYPE is refused before parsing, so no entity expands",
    (_, parse, open, close) => {
      const started = performance.now();
      for (const text of [
        `${LAUGHS}${open}&lol9;${close}`,
        `<?xml version="1.0"?><!DOCTYPE p [<!ENTITY x SYSTEM "file:///etc/passwd">]>${open}&x;${close}`,
        `<!DOCTYPE p SYSTEM "http://127.0.0.1:9/dtd">${open}${close}`,
      ]) {
        const result = parse(xml(text));
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.code).toBe("doctype");
      }
      expect(performance.now() - started).toBeLessThan(1_000);
    },
  );

  it.each(PARSERS)(
    "%s: malformed XML, an undefined entity and an unbound prefix are not well-formed",
    (_, parse, open, close) => {
      for (const text of [
        `${open}<a></b>${close}`,
        `${open}&undefined;${close}`,
        `${open}<x:a/>${close}`,
        `${open}`,
      ]) {
        const result = parse(xml(text));
        expect(result.ok ? null : result.error.code, text).toBe(
          "not_well_formed",
        );
      }
    },
  );

  it.each(PARSERS)(
    "%s: the wrong root, non-UTF-8 bytes, size and markup bounds are typed problems",
    (name, parse, open, close) => {
      const code = (bytes: Uint8Array) => {
        const result = parse(bytes);
        return result.ok ? null : result.error.code;
      };
      expect(code(xml('<Package xmlns="urn:other"/>'))).toBe("unexpected_root");
      expect(
        code(Buffer.concat([xml(open), Buffer.from([0xff, 0xfe]), xml(close)])),
      ).toBe("not_utf8");
      expect(code(Buffer.from(`﻿${open}${close}`, "utf16le"))).toBe("not_utf8");
      expect(code(Buffer.alloc(17 * 1024 ** 2, 0x20))).toBe("too_large");
      expect(
        code(
          xml(
            `${open}${"<a/>".repeat(name === "AppxBlockMap.xml" ? 600_001 : 200_001)}${close}`,
          ),
        ),
      ).toBe("too_many_nodes");
    },
  );
});
