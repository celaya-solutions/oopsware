import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import type { LinuxPackagePort } from "../application/linuxPackage/LinuxPackagePort.js";
import { LINUX_PACKAGE_PROVIDER } from "../application/InvestigationProviders.js";
import { readStableArtifact } from "../artifacts/readStableArtifact.js";
import { stableReadFailure } from "../artifacts/stableReadFailure.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisResourceConstraintError,
  AnalysisUnsupportedTargetError,
} from "../domain/analysisErrorCore.js";
import {
  hasAppImageSignature,
  hasDebSignature,
  hasRpmLead,
  hasSquashfsSuperblock,
} from "../domain/archiveStreamFormat.js";
import { ArtifactOperationError } from "../domain/artifactOperationError.js";
import type { FacetCoverage } from "../domain/formatRegistry.js";
import type {
  InspectLinuxPackageInput,
  LinuxPackageReport,
} from "../domain/linuxPackage/linuxPackage.js";
import { err, ok, type Result } from "../domain/result.js";
import { readDebPackage } from "./debReport.js";
import { PayloadDecodeFailure } from "./decode.js";
import { readImagePackage } from "./imageReport.js";
import {
  decoderRecords,
  filePage,
  SHARED_LIMITATIONS,
  type FileRecord,
} from "./report.js";
import { readRpmPackage } from "./rpmReport.js";

type Kind = LinuxPackageReport["package"]["kind"];
const OPERATION = "inspect_linux_package";

const KIND_LIMITATIONS: Readonly<Record<Kind, readonly string[]>> = {
  deb: [
    "The control archive is read in full and the data archive is decoded to list files and recheck md5sums; bzip2 members are not decoded.",
  ],
  rpm: [
    "Files come from the header; the cpio payload is decoded to recheck each file digest. Rich dependencies are kept as written, not evaluated.",
  ],
  appimage: [
    "The AppImage's runtime is located from its ELF section headers and its SquashFS image is read in process; the runtime is never executed, mounted or used with --appimage-extract. Type 1 (ISO 9660) AppImages are identified only.",
    "SquashFS images compressed with gzip, zstd or lz4 are read; xz, lzma and lzo images are identified only.",
  ],
  squashfs: [
    "SquashFS images compressed with gzip, zstd or lz4 are read; xz, lzma and lzo images are identified only.",
  ],
};

const SUFFIXES: readonly (readonly [string, Kind])[] = [
  [".deb", "deb"],
  [".rpm", "rpm"],
  [".appimage", "appimage"],
  [".squashfs", "squashfs"],
  [".sqsh", "squashfs"],
  [".sfs", "squashfs"],
];

const kindOf = (bytes: Uint8Array): Kind | null =>
  hasDebSignature(bytes)
    ? "deb"
    : hasRpmLead(bytes)
      ? "rpm"
      : hasAppImageSignature(bytes)
        ? "appimage"
        : hasSquashfsSuperblock(bytes)
          ? "squashfs"
          : null;

const conflictOf = (path: string, kind: Kind): string | null => {
  const lower = path.toLowerCase();
  const hinted = SUFFIXES.find(([suffix]) => lower.endsWith(suffix))?.[1];
  return hinted === undefined || hinted === kind
    ? null
    : `The name suggests ${hinted}; the bytes are ${kind}.`;
};

const coverageOf = (
  files: readonly FileRecord[],
  diagnostics: LinuxPackageReport["diagnostics"],
  listed: boolean,
): FacetCoverage[] => [
  {
    facet: "identify",
    state: "complete",
    examined: "package magic and container layout",
    omitted: null,
    reason: null,
    continuation: null,
  },
  listed
    ? {
        facet: "inventory",
        state: "complete",
        examined: `${String(files.length)} declared or stored files`,
        omitted: null,
        reason: null,
        continuation: null,
      }
    : {
        facet: "inventory",
        state: "unsupported",
        examined: null,
        omitted: null,
        reason:
          "The package's contents are in a form this reader identifies but does not list.",
        continuation: null,
      },
  diagnostics.length === 0
    ? {
        facet: "inspect",
        state: "complete",
        examined:
          "package metadata, dependencies, scripts, signatures as recorded, and file digests",
        omitted: null,
        reason: null,
        continuation: null,
      }
    : {
        facet: "inspect",
        state: "partial",
        examined:
          "package metadata, dependencies, scripts, signatures as recorded, and file digests",
        omitted: `${String(diagnostics.length)} problems are listed in diagnostics`,
        reason: "Some structures are damaged, missing or not decoded.",
        continuation: null,
      },
  {
    facet: "extract",
    state: "not_requested",
    examined: null,
    omitted: null,
    reason:
      "extract_artifact materializes the contents into owned scratch space.",
    continuation: null,
  },
];

/** Read freshly: the signal can abort while the package is read. */
const aborted = (signal?: AbortSignal): boolean => signal?.aborted === true;

/** Typed errors for failures that leave no report. */
const failure = (cause: unknown, limit: number): AnalysisError => {
  if (cause instanceof PayloadDecodeFailure)
    switch (cause.reason) {
      case "cancelled":
        return new AnalysisCancelledError(OPERATION, { cause });
      case "budget":
        return new AnalysisResourceConstraintError(
          OPERATION,
          "memory",
          cause.message,
          { max_decoded_bytes: limit },
          {
            cause,
            remediationAction: "Raise max_decoded_bytes (up to 2 GiB).",
          },
        );
      case "unavailable":
        return new AnalysisCapabilityUnavailableError(
          "xz",
          OPERATION,
          cause.message,
          { cause },
        );
      case "format":
        break;
    }
  return new ArtifactOperationError(
    OPERATION,
    "format",
    undefined,
    `The package could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
    { cause },
  );
};

/** In-process Linux package reading for the shared service. */
export class LinuxPackageProvider implements LinuxPackagePort {
  readonly identity = LINUX_PACKAGE_PROVIDER;

  async inspectPackage(
    input: InspectLinuxPackageInput,
    options?: ExecutionOptions,
  ): Promise<Result<LinuxPackageReport, AnalysisError>> {
    const signal = options?.signal;
    let snapshot: Awaited<ReturnType<typeof readStableArtifact>>;
    try {
      snapshot = await readStableArtifact(
        input.path,
        input.max_file_bytes,
        signal,
      );
    } catch (cause) {
      return err(
        stableReadFailure(OPERATION, input.path, cause, {
          cancelled: signal?.aborted === true,
          maxFileBytes: input.max_file_bytes,
          remediationAction:
            "Raise max_file_bytes (up to 1 GiB) or select a smaller file.",
        }),
      );
    }
    if (signal?.aborted === true)
      return err(new AnalysisCancelledError(OPERATION));
    const kind = kindOf(snapshot.bytes);
    if (kind === null)
      return err(
        new AnalysisUnsupportedTargetError(
          OPERATION,
          input.path,
          "The file is not a Debian package, an RPM package, an AppImage or a SquashFS image.",
        ),
      );
    try {
      const parts =
        kind === "deb"
          ? {
              ...(await readDebPackage(
                snapshot.bytes,
                input.max_decoded_bytes,
                signal,
              )),
              rpm: null,
              appimage: null,
              squashfs: null,
              listed: true,
            }
          : kind === "rpm"
            ? {
                ...(await readRpmPackage(
                  snapshot.bytes,
                  input.max_decoded_bytes,
                  signal,
                )),
                deb: null,
                appimage: null,
                squashfs: null,
                listed: true,
              }
            : {
                ...(await readImagePackage(snapshot.bytes, kind, signal)),
                deb: null,
                rpm: null,
              };
      if (aborted(signal)) return err(new AnalysisCancelledError(OPERATION));
      return ok({
        artifact: {
          path: input.path,
          sha256: snapshot.sha256,
          bytes: snapshot.bytes.length,
        },
        package: { kind, name_conflict: conflictOf(input.path, kind) },
        identity: parts.identity,
        dependencies: parts.dependencies,
        scripts: parts.scripts,
        triggers: parts.triggers,
        deb: parts.deb,
        rpm: parts.rpm,
        appimage: parts.appimage,
        squashfs: parts.squashfs,
        ...filePage(parts.files, input.start, input.limit),
        decoders: decoderRecords(parts.commands),
        diagnostics: parts.diagnostics,
        coverage: coverageOf(parts.files, parts.diagnostics, parts.listed),
        limitations: [...SHARED_LIMITATIONS, ...KIND_LIMITATIONS[kind]],
      });
    } catch (cause) {
      if (aborted(signal))
        return err(new AnalysisCancelledError(OPERATION, { cause }));
      return err(failure(cause, input.max_decoded_bytes));
    }
  }
}
