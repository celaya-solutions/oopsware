import { AsarArtifactReader } from "../AsarArtifactReader.js";
import type {
  ArtifactReader,
  ArtifactReaderTraversal,
} from "../ArtifactReader.js";
import { DirectoryArtifactReader } from "../DirectoryArtifactReader.js";
import { GodotPckArtifactReader } from "../GodotPckArtifactReader.js";
import { MachOSliceArtifactReader } from "../MachOSliceArtifactReader.js";
import { NativeDmgArtifactReader } from "../NativeDmgArtifactReader.js";
import { ContainerImageArtifactReader } from "../ContainerImageArtifactReader.js";
import { MsiArtifactReader } from "../MsiArtifactReader.js";
import { SquashfsArtifactReader } from "../SquashfsArtifactReader.js";
import { ZipArtifactReader } from "../ZipArtifactReader.js";
import {
  DEFAULT_ARCHIVE_READ_POLICY,
  StreamArchiveArtifactReader,
  type ArchiveReadPolicy,
} from "../archives/StreamArchiveArtifactReader.js";
import type {
  ArtifactInventoryCoverage,
  ArtifactOccurrence,
} from "../../domain/artifactGraph.js";
import { isContainerImageFormat } from "../../domain/archiveStreamFormat.js";
import {
  isZipPackageFormat,
  ZIP_NON_ENTRY_LIMITATION,
} from "../../domain/zipPackageFormat.js";
import type { StableRegularFileDescriptor } from "../../filesystem/RegularFile.js";

export const createReader = (
  path: string,
  format: ArtifactOccurrence["artifact_format"],
  environment: Readonly<NodeJS.ProcessEnv>,
  rootSource?: StableRegularFileDescriptor,
  archive: ArchiveReadPolicy = DEFAULT_ARCHIVE_READ_POLICY,
): ArtifactReader | undefined => {
  if (isZipPackageFormat(format))
    return new ZipArtifactReader(path, format, undefined, rootSource);
  switch (format) {
    case "iso":
    case "tar":
    case "gzip":
    case "xz":
    case "7z":
    case "deb":
    case "rpm":
      return new StreamArchiveArtifactReader(path, format, archive);
    case "squashfs":
    case "appimage":
      return new SquashfsArtifactReader(path, format);
    case "msi":
      return new MsiArtifactReader(path);
    case "oci-image-layout":
    case "oci-image-archive":
    case "docker-save-archive":
      return archive.containerImages === "deny"
        ? undefined
        : new ContainerImageArtifactReader(path, format, archive);
    case "directory":
      return new DirectoryArtifactReader(path);
    case "asar":
      return new AsarArtifactReader(path);
    case "godot-pck":
      return new GodotPckArtifactReader(path, rootSource);
    case "mach-o-universal":
      return process.platform === "darwin"
        ? new MachOSliceArtifactReader(path, environment, undefined, rootSource)
        : undefined;
    case "dmg":
      if (process.platform !== "darwin") return undefined;
      return new NativeDmgArtifactReader(path, environment);
    default:
      return undefined;
  }
};

/** Decide traversal scope and availability once, independently of diagnostic wording. */
export const inventoryCoverage = (
  format: ArtifactOccurrence["artifact_format"],
  reader: ArtifactReader | undefined,
  traversal: ArtifactReaderTraversal,
): {
  readonly coverage: ArtifactInventoryCoverage;
  readonly limitations: string[];
} => {
  if (reader !== undefined) {
    const omissions = reader.omissions?.() ?? [];
    return {
      coverage: {
        scope: "container-entries",
        // Members a reader saw but did not expose leave the entry set incomplete.
        status: omissions.length === 0 ? traversal.status : "unknown",
      },
      limitations: [
        ...(isZipPackageFormat(reader.format)
          ? [ZIP_NON_ENTRY_LIMITATION]
          : []),
        ...(reader.format === "godot-pck"
          ? [
              "PCK inventory establishes packaged bytes and metadata; scenes, binary resources, GDScript bytecode and runtime signal behavior were not decoded.",
            ]
          : []),
        ...traversal.limitations,
        ...(reader.observations?.() ?? []),
        ...omissions,
      ],
    };
  }
  if (isContainerImageFormat(format))
    return {
      coverage: { scope: "container-entries", status: "unknown" },
      limitations: [
        "Container images are read by the local install only; this service keeps the byte preview.",
      ],
    };
  if (format === "rar")
    return {
      coverage: { scope: "container-entries", status: "unknown" },
      limitations: [
        "RAR is identified from its marker block only. No RAR reader is admitted: no real RAR producer was available to build verification fixtures, so members are not listed.",
      ],
    };
  // dmg and pkg reach here only after classifyRootFormat matched their bytes.
  if (format === "dmg" || format === "pkg")
    return {
      coverage: { scope: "container-entries", status: "unknown" },
      limitations: [
        `${format.toUpperCase()} root hash is observed; child inventory requires a native macOS adapter.`,
      ],
    };
  if (format === "mach-o-universal")
    return {
      coverage: { scope: "container-entries", status: "unknown" },
      limitations: [
        "Universal Mach-O slices require the native macOS lipo adapter.",
      ],
    };
  if (
    isZipPackageFormat(format) ||
    format === "directory" ||
    format === "asar" ||
    format === "godot-pck"
  )
    return {
      coverage: { scope: "container-entries", status: "unknown" },
      limitations: [`${format} child inventory reader is unavailable.`],
    };
  return {
    coverage: { scope: "root", status: "complete" },
    limitations: ["Artifact has no child container entries."],
  };
};
