import { createHash } from "node:crypto";
import {
  objcSwiftMetadataSchema,
  nativeDispatchMetadataResultSchema,
  type ObjcSwiftMetadata,
} from "../domain/native/objcSwiftMetadata.js";
import {
  isMachOFormat,
  type BinaryTarget,
} from "../domain/binaryTargetTypes.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import {
  ArtifactFileCleanupFailure,
  artifactFileCancellationCause,
  artifactFilePrimaryFailure,
  bindArtifactFileCleanup,
  withArtifactRegularFile,
} from "../artifacts/ArtifactFileOperation.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import {
  APPLE_DISPATCH_METADATA_ANALYSIS_PROFILE,
  NATIVE_MACOS_PROVIDER_IDENTITY as IDENTITY,
} from "./NativeMacOSProviderMetadata.js";
import { readBoundedFileBytes } from "../process/BoundedFileBytes.js";
import { EvidenceIntegrityError } from "../domain/evidenceErrors.js";
import { pushDispatchCoverage } from "./AppleDispatchCoverage.js";
import { parsePointerFixups } from "./AppleMachoFixups.js";
import { parseMachoLayout } from "./AppleMachoSelection.js";
import { decodeObjcDispatchFacets } from "./AppleObjcDispatchFacets.js";
import {
  createSwiftRelativeReader,
  decodeSwiftDispatchFacets,
  type DispatchRecordBudget,
} from "./AppleSwiftDispatchFacets.js";
import { decodeSwiftClassVtables } from "./AppleSwiftVtables.js";

/** Decode validated little-endian 64-bit Apple Objective-C metadata without loading target code. */
export const decodeAppleDispatchMetadata = (
  bytes: Buffer,
  maxRecords: number,
  provenance: { path: string; sha256: string },
  architecture = "arm64",
): ObjcSwiftMetadata => {
  const layout = parseMachoLayout(bytes, architecture);
  const { segments, sections, offset } = layout;
  const fixups = parsePointerFixups(
    bytes,
    layout.fixups,
    segments,
    layout.baseAddress,
  );
  const u32 = (address: bigint) => bytes.readUInt32LE(offset(address, 4));
  const decodePointer = (address: bigint) =>
    fixups.decode(address, bytes.readBigUInt64LE(offset(address, 8)));
  /** Rebased target of a pointer; a bind to another image reads as 0. */
  const pointer = (address: bigint) => {
    const decodedPointer = decodePointer(address);
    return decodedPointer.kind === "rebase" ? decodedPointer.target : 0n;
  };
  const bound = (address: bigint) => {
    const decodedPointer = decodePointer(address);
    return decodedPointer.kind === "bind" ? decodedPointer : undefined;
  };
  const location = (address: bigint) => ({
    address: `0x${address.toString(16)}`,
    file_offset: offset(address),
  });
  const evidence = (address: bigint, description: string) => [
    {
      kind: "binary_metadata" as const,
      description,
      location: location(address),
      artifact_path: provenance.path,
      artifact_sha256: provenance.sha256,
    },
  ];
  const string = (address: bigint) => {
    const start = offset(address);
    let end = start;
    while (end < bytes.length && end - start < 4096 && bytes[end] !== 0) end++;
    if (end === bytes.length || end - start >= 4096)
      throw new RangeError("Unterminated or oversized metadata string");
    offset(address, end - start + 1);
    // A metadata C string owns every code point, including an initial U+FEFF.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes.subarray(start, end),
    );
  };
  const result = objcSwiftMetadataSchema.parse({ db_save_result: null });
  let records = 0;
  const budget: DispatchRecordBudget = {
    truncated: false,
    isFull: () => records >= maxRecords,
    markTruncated: () => {
      budget.truncated = true;
    },
    admit: () => {
      if (records >= maxRecords) {
        budget.truncated = true;
        return false;
      }
      records++;
      return true;
    },
  };
  const readers = {
    u32,
    i32: (address: bigint) => bytes.readInt32LE(offset(address, 4)),
    u64: (address: bigint) => bytes.readBigUInt64LE(offset(address, 8)),
    pointer,
    bound,
    string,
    location,
    evidence,
    offset,
  };
  const {
    failures,
    categoryIssues,
    examined,
    categoriesExamined,
    objcListScanTruncated,
    objcClassListScanTruncated,
  } = decodeObjcDispatchFacets({
    bytes,
    sections,
    segments,
    readers,
    budget,
    maxListSlots: maxRecords,
    result,
  });
  const swiftRelative = createSwiftRelativeReader({
    bytes,
    readers,
    budget,
    result,
  });
  const swift = decodeSwiftDispatchFacets({
    sections,
    segments,
    readers,
    relative: swiftRelative,
    budget,
    result,
  });
  const typeEntries: bigint[] = [];
  for (const section of sections.filter(
    ({ name }) => name === "__swift5_types",
  )) {
    if (section.size % 4 !== 0)
      throw new RangeError("Misaligned Swift type section");
    for (let index = 0; index < section.size / 4 && index < maxRecords; index++)
      typeEntries.push(section.address + BigInt(index * 4));
    if (section.size / 4 > maxRecords) budget.truncated = true;
  }
  const vtables = decodeSwiftClassVtables({
    entries: typeEntries,
    result,
    readers: {
      u32,
      relative: swiftRelative,
      string,
      location,
      evidence,
      admit: () => budget.admit(),
      executable: (address) =>
        segments.some(
          (segment) =>
            segment.executable &&
            address >= segment.address &&
            address < segment.address + segment.size,
        ),
    },
  });
  pushDispatchCoverage({
    result,
    failures,
    categoryIssues,
    examined,
    categoriesExamined,
    objcListScanTruncated,
    objcClassListScanTruncated,
    truncated: budget.truncated,
    fixups,
    vtables,
    swift,
  });
  return objcSwiftMetadataSchema.parse(result);
};

/**
 * Read digest-verified target bytes under a 64 MiB static metadata budget.
 * The caller's scope retains the target descriptor when its final close fails.
 */
export const inspectAppleDispatchMetadata = async (
  target: BinaryTarget,
  maxRecords: number,
  resources: ArtifactResourceScope,
  signal?: AbortSignal,
) => {
  if (target.kind !== "executable" || !isMachOFormat(target.format))
    throw new TypeError("Apple dispatch metadata requires a Mach-O target");
  const maximumBytes = 64 * 1024 * 1024;
  const capacityError = () =>
    new AnalysisResourceConstraintError(
      "inspect_native_dispatch_metadata",
      "memory",
      "Apple static metadata input exceeds its 64 MiB snapshot budget",
      { input_bytes: maximumBytes },
    );
  const cancelled = () =>
    new AnalysisCancelledError("inspect_native_dispatch_metadata", {
      cause: signal?.reason,
    });
  const { bytes, digest } = await withArtifactRegularFile(
    target.path,
    resources,
    signal,
    async (handle) => {
      const before = await handle.stat();
      if (before.size > maximumBytes) throw capacityError();
      if (signal?.aborted) throw cancelled();
      const read = await readBoundedFileBytes(
        handle,
        maximumBytes,
        signal,
      ).catch((cause: unknown) => {
        // The bounded reader rejects with the caller's exact abort reason.
        if (signal?.aborted === true && cause === signal.reason)
          throw cancelled();
        throw cause;
      });
      if (read === undefined) throw capacityError();
      const sha256 = createHash("sha256").update(read).digest("hex");
      if (sha256 !== target.sha256)
        throw new EvidenceIntegrityError(
          "Apple metadata target digest changed after session binding",
        );
      return { bytes: read, digest: sha256 };
    },
    "reject",
  );
  return nativeDispatchMetadataResultSchema.parse({
    target_sha256: target.sha256,
    provider: APPLE_DISPATCH_METADATA_ANALYSIS_PROFILE.provider,
    analysis_profile_digest: APPLE_DISPATCH_METADATA_ANALYSIS_PROFILE.digest,
    result: decodeAppleDispatchMetadata(
      bytes,
      maxRecords,
      { path: target.path, sha256: digest },
      target.architecture,
    ),
  });
};

const OPERATION = "inspect_native_dispatch_metadata";

/** Translate the owned target read, keeping a failed close beside its physical outcome. */
export const appleDispatchMetadataFailure = (
  cause: unknown,
  path: string,
): AnalysisError => {
  if (cause instanceof ArtifactReaderFailure && cause.cleanup !== undefined) {
    const physical =
      cause instanceof ArtifactFileCleanupFailure
        ? cause.fileCleanupFailure
        : undefined;
    const previous =
      physical?.outcome.kind === "failed"
        ? appleDispatchMetadataFailure(artifactFilePrimaryFailure(cause), path)
        : physical?.completionCancellation === undefined
          ? undefined
          : new AnalysisCancelledError(OPERATION, {
              cause: physical.completionCancellation.reason,
            });
    const failure = new ProviderCleanupError(
      IDENTITY.id,
      cause.cleanup.resources,
      {
        reason: cause.cleanup.reason,
        previous_error:
          previous === undefined ? null : projectAnalysisError(previous),
      },
      { operation: OPERATION, cause, cleanupPrimary: previous },
    );
    bindArtifactFileCleanup(cause, failure);
    return failure;
  }
  if (cause instanceof AnalysisError) return cause;
  if (cause instanceof ArtifactReaderFailure && cause.reason === "cancelled")
    return new AnalysisCancelledError(OPERATION, {
      cause: artifactFileCancellationCause(cause),
    });
  if (cause instanceof ArtifactReaderFailure && cause.reason === "unavailable")
    return new AnalysisCapabilityUnavailableError(
      IDENTITY.id,
      OPERATION,
      cause.message,
      { cause },
    );
  return new ProviderAdapterError(IDENTITY.id, OPERATION, {
    cause,
    diagnostics: {
      target_path: path,
      reason: cause instanceof Error ? cause.message : String(cause),
    },
  });
};
