import {
  inspectMsixPackageInputSchema,
  msixPackageReportSchema,
} from "../../domain/windowsInstaller/msixPackage.js";
import {
  inspectWindowsInstallerInputSchema,
  windowsInstallerReportSchema,
} from "../../domain/windowsInstaller/windowsInstaller.js";
import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";

/** Windows Installer packages and MSIX/AppX packages and bundles (format expansion F08), read in process. */
export const WINDOWS_INSTALLER_TOOL_CONTRACTS = [
  {
    name: "inspect_windows_installer",
    ...toolContractMetadata("inspect_windows_installer"),
    kind: "artifact-provider",
    description:
      "Read one explicit local Windows Installer package (.msi) from its bytes, without msiexec, without running any custom action, embedded program or script, and without touching the registry. Returns the compound file layout and decoded stream names, summary information (package code, platforms, languages, creating application), product and every property, every table with its row count, features with their components, components (GUID, directory, attributes such as 64-bit, condition, key path), directories resolved to target paths, registry writes and removals, service installs and controls, shortcuts, environment and INI changes, custom actions decoded by type (DLL, EXE or script source, set property or directory, execution such as deferred or no-impersonate) with the sequences and conditions that schedule them, every sequence table in order, launch conditions, upgrades, Binary streams digested and typed, and signature streams by size (never verified). Cabinets: embedded ones are read in process (stored and MSZIP; LZX and Quantum listed, not decoded); external ones only when passed in `cabinets`, bound by SHA-256. Then a page of files with resolved target path, cabinet, read status, SHA-256 and MsiFileHash rechecked. Conditions are kept as written, never evaluated.",
    inputSchema: inspectWindowsInstallerInputSchema,
    outputSchema: evidenceResultOf(windowsInstallerReportSchema),
    examples: [
      { title: "Read an installer", input: { path: "/artifacts/setup.msi" } },
      {
        title: "Read an installer with its external cabinet",
        input: {
          path: "/artifacts/setup.msi",
          cabinets: ["/artifacts/disk1.cab"],
        },
      },
    ],
  },
  {
    name: "inspect_msix_package",
    ...toolContractMetadata("inspect_msix_package"),
    kind: "artifact-provider",
    description:
      "Read one explicit local MSIX or AppX package or bundle (.msix, .appx, .msixbundle, .appxbundle) from its bytes, without installing, registering or running it. For a package: its AppxManifest identity, properties, target device families, dependencies, resources, applications with entry points and every extension category (protocols, startup tasks, COM servers ...), and capabilities by kind (general, uap, restricted, device, custom) as declarations; AppxBlockMap.xml recomputed block by block (mismatched, missing, resized and unlisted members); the signature part and CodeIntegrity.cat recorded, never verified. For a bundle: its identity and every application and resource package with architecture, resources and the declared offset and size checked against the ZIP, each package's own manifest identity and block map result, the architectures a device would choose between, and the bundle's own block map and signature part. Pass `container` to read one package of a bundle in full.",
    inputSchema: inspectMsixPackageInputSchema,
    outputSchema: evidenceResultOf(msixPackageReportSchema),
    examples: [
      { title: "Read a bundle", input: { path: "/artifacts/App.msixbundle" } },
      {
        title: "Read one package of a bundle",
        input: {
          path: "/artifacts/App.msixbundle",
          container: "App_1.0.0.0_x64.msix",
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
