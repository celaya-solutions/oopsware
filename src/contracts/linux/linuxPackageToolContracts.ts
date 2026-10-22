import {
  inspectLinuxPackageInputSchema,
  linuxPackageReportSchema,
} from "../../domain/linuxPackage/linuxPackage.js";
import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";

/** Debian packages, RPM packages, AppImages and SquashFS images (format expansion F05), read in process. */
export const LINUX_PACKAGE_TOOL_CONTRACTS = [
  {
    name: "inspect_linux_package",
    ...toolContractMetadata("inspect_linux_package"),
    kind: "artifact-provider",
    description:
      "Read one explicit local Debian package (.deb), RPM package (.rpm), Type 2 AppImage or SquashFS image from its bytes, without installing it, running a maintainer script or scriptlet, executing or mounting an AppImage, or contacting a repository. Returns the package identity (name, version, release, epoch, architecture, summary); every declared dependency, provide, conflict, breaks, replaces, obsoletes and weak dependency with its operator, version, architecture qualifier and RPM sense flags (rich RPM dependencies kept as written); maintainer scripts and RPM scriptlets as text with interpreter and SHA-256; triggers; for a .deb its ar members, control fields in order, conffiles, md5sums recomputed over the data members, and signature members (never verified); for an .rpm its lead, header and payload digests recomputed, file digest algorithm and signature packets present (never verified or trusted); for an AppImage its type, runtime ELF machine, update information, embedded signature presence, SquashFS superblock, desktop entry and AppRun entry point (a Type 1 AppImage is identified only). Then a page of files with type, mode, setuid/setgid/sticky bits (never applied), owner, size, time, link target, flags such as conffile, config, doc and ghost, and the declared digest checked against the bytes. extract_artifact materializes the contents; inspect_artifact lists them in the artifact graph.",
    inputSchema: inspectLinuxPackageInputSchema,
    outputSchema: evidenceResultOf(linuxPackageReportSchema),
    examples: [
      {
        title: "Read a Debian package",
        input: { path: "/artifacts/tool_1.0-1_amd64.deb" },
      },
      {
        title: "Page the files of an AppImage",
        input: {
          path: "/artifacts/App-x86_64.AppImage",
          start: 1000,
          limit: 1000,
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
