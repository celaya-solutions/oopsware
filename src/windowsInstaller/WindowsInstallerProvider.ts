import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import type { WindowsInstallerPort } from "../application/windowsInstaller/WindowsInstallerPort.js";
import { WINDOWS_INSTALLER_PROVIDER } from "../application/InvestigationProviders.js";
import { readStableArtifact } from "../artifacts/readStableArtifact.js";
import { stableReadFailure } from "../artifacts/stableReadFailure.js";
import { DecodeBudget, MemberReadFailure } from "../artifacts/zipMemberView.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
  AnalysisUnsupportedTargetError,
} from "../domain/analysisErrorCore.js";
import {
  compoundRootClass,
  compoundRootClsidOffset,
  hasCompoundFileSignature,
} from "../domain/archiveStreamFormat.js";
import { ArtifactOperationError } from "../domain/artifactOperationError.js";
import { hasZipSignature } from "../domain/zipPackageFormat.js";
import type { FacetCoverage } from "../domain/formatRegistry.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  MAX_MSIX_MEMBER_BYTES,
  type InspectMsixPackageInput,
  type MsixPackageReport,
} from "../domain/windowsInstaller/msixPackage.js";
import type {
  InspectWindowsInstallerInput,
  WindowsInstallerReport,
} from "../domain/windowsInstaller/windowsInstaller.js";
import { readMsiInstaller, type CabinetCompanion } from "./msiReport.js";
import {
  MsixSelectionError,
  NotMsixPackageError,
  readMsixPackage,
} from "./msixReport.js";

type Operation = "inspect_windows_installer" | "inspect_msix_package";

/** Read freshly: the signal can abort while the package is read. */
const aborted = (signal?: AbortSignal): boolean => signal?.aborted === true;

const readFailure = (
  operation: Operation,
  path: string,
  cause: unknown,
  signal: AbortSignal | undefined,
  maxFileBytes: number,
): AnalysisError =>
  stableReadFailure(operation, path, cause, {
    cancelled: aborted(signal),
    maxFileBytes,
    remediationAction:
      "Raise max_file_bytes (up to 1 GiB) or select a smaller file.",
  });

const formatFailure = (operation: Operation, cause: unknown): AnalysisError =>
  new ArtifactOperationError(
    operation,
    "format",
    undefined,
    `The package could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
    { cause },
  );

const MSI_LIMITATIONS = [
  "Nothing is installed: no msiexec, custom action, embedded program, script, COM activation or registry change runs.",
  "Table rows declare what an installation could do; conditions are kept as written and never evaluated, so whether a row would apply is not known.",
  "External cabinets are read only when supplied with cabinets; nothing is searched for. Stored and MSZIP cabinets are decoded; LZX and Quantum are listed, not decoded.",
  "Signature streams are reported by size; no signature is verified and no signer is trusted.",
  "Patches (.msp) and transforms (.mst) are not applied or read as packages.",
];

const MSIX_LIMITATIONS = [
  "Nothing is installed, registered or run; manifest capabilities and extensions are declarations, never grants.",
  "Block maps are recomputed over member bytes; the signature part and CodeIntegrity.cat are recorded, never verified, and no signer is trusted.",
  "Which package of a bundle a device would install is not evaluated; read one with container.",
];

const coverage = (
  examined: string,
  diagnostics: number,
  listed: boolean,
): FacetCoverage[] => [
  {
    facet: "identify",
    state: "complete",
    examined: "container signature and layout",
    omitted: null,
    reason: null,
    continuation: null,
  },
  listed
    ? {
        facet: "inventory",
        state: "complete",
        examined: "every declared file and package member",
        omitted: null,
        reason: null,
        continuation: null,
      }
    : {
        facet: "inventory",
        state: "partial",
        examined: "every declared file",
        omitted: "files whose bytes were not read; each file's status says why",
        reason:
          "Some files are in cabinets that were not supplied, are damaged, ran past max_decoded_bytes or use LZX or Quantum, or sit uncompressed beside the package.",
        continuation:
          "Supply external cabinets with cabinets, or raise max_decoded_bytes.",
      },
  diagnostics === 0
    ? {
        facet: "inspect",
        state: "complete",
        examined,
        omitted: null,
        reason: null,
        continuation: null,
      }
    : {
        facet: "inspect",
        state: "partial",
        examined,
        omitted: `${String(diagnostics)} problems are listed in diagnostics`,
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

/** Why bytes are not read as an installer package: not one at all, or a compound file too damaged to tell. */
const installerRefusal = (
  bytes: Uint8Array,
): { readonly kind: "other" | "damaged"; readonly message: string } | null => {
  if (!hasCompoundFileSignature(bytes))
    return {
      kind: "other",
      message:
        "The file is not an OLE compound file, so it is not a Windows Installer package.",
    };
  const offset = compoundRootClsidOffset(bytes);
  if (offset === null)
    return {
      kind: "damaged",
      message:
        "The compound file header has an invalid sector size or root directory sector.",
    };
  if (offset + 16 > bytes.length)
    return {
      kind: "damaged",
      message: `The compound file's root directory entry (byte ${String(offset - 80)}) lies past the end of the ${String(bytes.length)}-byte file; it is truncated.`,
    };
  const kind = compoundRootClass(bytes, offset);
  if (kind === "msi") return null;
  return {
    kind: "other",
    message:
      kind === null
        ? "The compound file's root class is not the Windows Installer package class (it may be an Office document or another compound file)."
        : `The compound file is a Windows Installer ${kind === "msp" ? "patch (.msp)" : "transform (.mst)"}, which is not read as a package.`,
  };
};

/** In-process Windows Installer and MSIX/AppX reading for the shared service. */
export class WindowsInstallerProvider implements WindowsInstallerPort {
  readonly identity = WINDOWS_INSTALLER_PROVIDER;

  async inspectInstaller(
    input: InspectWindowsInstallerInput,
    options?: ExecutionOptions,
  ): Promise<Result<WindowsInstallerReport, AnalysisError>> {
    const operation = "inspect_windows_installer";
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
        readFailure(operation, input.path, cause, signal, input.max_file_bytes),
      );
    }
    const refused = installerRefusal(snapshot.bytes);
    if (refused !== null)
      return err(
        refused.kind === "damaged"
          ? new ArtifactOperationError(
              operation,
              "format",
              undefined,
              refused.message,
            )
          : new AnalysisUnsupportedTargetError(
              operation,
              input.path,
              refused.message,
            ),
      );
    const companions: CabinetCompanion[] = [];
    for (const path of input.cabinets ?? []) {
      try {
        const cabinet = await readStableArtifact(
          path,
          input.max_file_bytes,
          signal,
        );
        companions.push({ path, bytes: cabinet.bytes, sha256: cabinet.sha256 });
      } catch (cause) {
        if (aborted(signal))
          return err(new AnalysisCancelledError(operation, { cause }));
        return err(
          new AnalysisInputError(operation, { cause }, [
            {
              path: ["cabinets"],
              reason: "invalid_value",
              message: `Cabinet ${path} could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
            },
          ]),
        );
      }
    }
    try {
      const parts = await readMsiInstaller(
        snapshot.bytes,
        companions,
        input.max_decoded_bytes,
        signal,
      );
      if (aborted(signal)) return err(new AnalysisCancelledError(operation));
      const { allFiles, ...rest } = parts;
      const slice = allFiles.slice(input.start, input.start + input.limit);
      const next = input.start + slice.length;
      const listed = allFiles.every((file) => file.status === "read");
      return ok({
        artifact: {
          path: input.path,
          sha256: snapshot.sha256,
          bytes: snapshot.bytes.length,
        },
        package: {
          kind: "msi",
          name_conflict: input.path.toLowerCase().endsWith(".msi")
            ? null
            : "The name does not end in .msi; the bytes are a Windows Installer package.",
        },
        ...rest,
        file_count: allFiles.length,
        page: {
          start: input.start,
          limit: input.limit,
          returned: slice.length,
          next: next < allFiles.length ? next : null,
        },
        files: slice,
        coverage: coverage(
          "summary information, every table, product, features, components, directories, files, registry, services, shortcuts, environment, INI changes, custom actions, sequences, upgrades and cabinets",
          rest.diagnostics.length,
          listed,
        ),
        limitations: MSI_LIMITATIONS,
      });
    } catch (cause) {
      if (aborted(signal))
        return err(new AnalysisCancelledError(operation, { cause }));
      return err(formatFailure(operation, cause));
    }
  }

  async inspectMsix(
    input: InspectMsixPackageInput,
    options?: ExecutionOptions,
  ): Promise<Result<MsixPackageReport, AnalysisError>> {
    const operation = "inspect_msix_package";
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
        readFailure(operation, input.path, cause, signal, input.max_file_bytes),
      );
    }
    if (!hasZipSignature(snapshot.bytes))
      return err(
        new AnalysisUnsupportedTargetError(
          operation,
          input.path,
          "The file is not a ZIP-based MSIX or AppX package or bundle.",
        ),
      );
    try {
      const budget = new DecodeBudget(
        input.max_decoded_bytes,
        MAX_MSIX_MEMBER_BYTES,
      );
      const parts = await readMsixPackage(
        snapshot.bytes,
        input.path,
        input.container,
        budget,
        signal,
      );
      if (aborted(signal)) return err(new AnalysisCancelledError(operation));
      const problems =
        parts.diagnostics.length +
        (parts.bundle?.problems.length ?? 0) +
        (parts.parts === null || parts.parts.manifest_error === null ? 0 : 1);
      return ok({
        artifact: {
          path: input.path,
          sha256: snapshot.sha256,
          bytes: snapshot.bytes.length,
        },
        ...parts,
        coverage: coverage(
          "manifests, bundle layout, block maps recomputed and signature parts as recorded",
          problems,
          true,
        ),
        limitations: MSIX_LIMITATIONS,
      });
    } catch (cause) {
      if (cause instanceof NotMsixPackageError)
        return err(
          new AnalysisUnsupportedTargetError(
            operation,
            input.path,
            cause.message,
          ),
        );
      if (cause instanceof MsixSelectionError)
        return err(
          new AnalysisInputError(operation, { cause }, [
            {
              path: ["container"],
              reason: "invalid_value",
              message: cause.message,
            },
          ]),
        );
      if (cause instanceof MemberReadFailure && cause.reason === "budget")
        return err(
          new AnalysisResourceConstraintError(
            operation,
            "memory",
            cause.message,
            { max_decoded_bytes: input.max_decoded_bytes },
            {
              cause,
              remediationAction: "Raise max_decoded_bytes (up to 2 GiB).",
            },
          ),
        );
      if (aborted(signal))
        return err(new AnalysisCancelledError(operation, { cause }));
      return err(formatFailure(operation, cause));
    }
  }
}
