import { locateGodotPck } from "../GodotPckLocation.js";
import { sameRegularFileState } from "../../filesystem/RegularFile.js";
import type { FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import type { StableRegularFileDescriptor } from "../../filesystem/RegularFile.js";
import type { OwnedFileHandle } from "../../filesystem/OwnedFileHandle.js";

import { classifyArtifactContent } from "./ArtifactGraphConstruction.js";
import { isImageLayoutDirectory, probeImageArchive } from "./imageProbe.js";
import { abortIfNeeded } from "../ArtifactHash.js";
import { createArtifactClassificationProbe } from "../ArtifactClassificationProbe.js";
import type { ArtifactOccurrence } from "../../domain/artifactGraph.js";
import {
  hasZipSignature,
  isZipPackageFormat,
  zipPackageFormatForPath,
  type ZipPackageFormat,
} from "../../domain/zipPackageFormat.js";
import {
  hasUdifTrailer,
  hasXarSignature,
  UDIF_TRAILER_BYTES,
} from "../../domain/formatSignatures.js";
import { isMsiRoot } from "../../domain/archiveStreamFormat.js";
import { ArtifactReaderFailure } from "../ArtifactReader.js";
import type { ArtifactResourceOwner } from "../ArtifactResourceScope.js";
import type { HashResult } from "../ArtifactHash.js";
import {
  hashStableRootArtifactHandle,
  openRootArtifact,
} from "./hashStableRootArtifact.js";
import type { ArtifactInventoryOptions } from "./types.js";
import type { FatSliceHeaderEvidence } from "../../domain/apple/machoContainer.js";
import { readMachoHeaderPrefixFacts } from "../../domain/apple/machoContainer.js";

interface RootClassification {
  readonly format: ArtifactOccurrence["artifact_format"];
  readonly digest: HashResult | null;
}

type RootInventoryClassification = RootClassification & {
  readonly rootSource: RootInventorySource | undefined;
};

/** The admitted descriptor and the single owner that can confirm its close. */
export interface RootInventorySource extends StableRegularFileDescriptor {
  readonly owner: OwnedFileHandle;
}

/** Classify and hash one file root through the same stable open descriptor. */
export const classifyAndHashRoot = async (
  path: string,
  directory: boolean,
  expectedMetadata: Stats,
  options: Pick<ArtifactInventoryOptions, "resourceScope" | "signal">,
): Promise<RootClassification> => {
  return options.resourceScope.run(async () => {
    const result = await classifyAndHashRootForInventory(
      path,
      directory,
      expectedMetadata,
      options,
    );
    const rootSource = result.rootSource;
    if (rootSource !== undefined) {
      const owner: ArtifactResourceOwner = {
        kind: "file-handle",
        handle: rootSource.owner,
        resource: `root artifact descriptor for ${path}`,
      };
      const cleanupAttempt = await options.resourceScope.release(owner);
      if (cleanupAttempt.kind === "failed")
        throw options.resourceScope.cleanupFailure({ kind: "completed" }, [
          cleanupAttempt,
        ]);
    }
    return { format: result.format, digest: result.digest };
  });
};

/**
 * Classify one regular file through an admitted descriptor, exactly as a root
 * is classified, without hashing it. For callers that only need to choose a
 * reader, such as identification opening a nested container it copied out.
 */
export const classifyRootFile = async (
  path: string,
  expectedMetadata: Stats,
  options: Pick<ArtifactInventoryOptions, "resourceScope" | "signal">,
): Promise<ArtifactOccurrence["artifact_format"]> =>
  options.resourceScope.run(async () => {
    const ownedHandle = await openRootArtifact(
      path,
      options.resourceScope,
      options.signal,
    );
    const owner: ArtifactResourceOwner = {
      kind: "file-handle",
      handle: ownedHandle,
      resource: `root artifact descriptor for ${path}`,
    };
    let outcome:
      | {
          readonly kind: "completed";
          readonly value: ArtifactOccurrence["artifact_format"];
        }
      | { readonly kind: "failed"; readonly cause: unknown };
    try {
      const initial = await ownedHandle.handle.stat();
      if (!sameRegularFileState(expectedMetadata, initial))
        throw new ArtifactReaderFailure(
          "integrity",
          `Artifact changed before classification: ${path}`,
        );
      outcome = {
        kind: "completed",
        value: await classifyRootFormat(
          path,
          ownedHandle.handle,
          options.signal,
        ),
      };
    } catch (cause: unknown) {
      outcome = { kind: "failed", cause };
    }
    const cleanupAttempt = await options.resourceScope.release(owner);
    if (cleanupAttempt.kind === "failed")
      throw options.resourceScope.cleanupFailure(outcome, [cleanupAttempt]);
    if (outcome.kind === "failed") throw outcome.cause;
    return outcome.value;
  });

/** Classify a root and retain its admitted ZIP descriptor for child inventory. */
export const classifyAndHashRootForInventory = async (
  path: string,
  directory: boolean,
  expectedMetadata: Stats,
  options: Pick<ArtifactInventoryOptions, "resourceScope" | "signal">,
): Promise<RootInventoryClassification> => {
  if (directory)
    return {
      format: (await isImageLayoutDirectory(path))
        ? "oci-image-layout"
        : "directory",
      digest: null,
      rootSource: undefined,
    };
  const ownedHandle = await openRootArtifact(
    path,
    options.resourceScope,
    options.signal,
  );
  const handle = ownedHandle.handle;
  const owner: ArtifactResourceOwner = {
    kind: "file-handle",
    handle: ownedHandle,
    resource: `root artifact descriptor for ${path}`,
  };
  let outcome:
    | {
        readonly kind: "completed";
        readonly value: RootInventoryClassification;
      }
    | { readonly kind: "failed"; readonly cause: unknown };
  try {
    const initial = await handle.stat();
    if (!sameRegularFileState(expectedMetadata, initial))
      throw new ArtifactReaderFailure(
        "integrity",
        `Root artifact changed before inventory: ${path}`,
      );
    const format = await classifyRootFormat(path, handle, options.signal);
    const digest = await hashStableRootArtifactHandle(
      path,
      handle,
      initial,
      options.signal,
    );
    const retainSource =
      isZipPackageFormat(format) ||
      format === "mach-o-universal" ||
      format === "godot-pck";
    outcome = {
      kind: "completed",
      value: {
        format,
        digest,
        rootSource: retainSource
          ? { handle, initial, owner: ownedHandle }
          : undefined,
      },
    };
  } catch (cause: unknown) {
    outcome = { kind: "failed", cause };
  }
  if (outcome.kind === "failed" || outcome.value.rootSource === undefined) {
    const cleanupAttempt = await options.resourceScope.release(owner);
    if (cleanupAttempt.kind === "failed")
      throw options.resourceScope.cleanupFailure(outcome, [cleanupAttempt]);
  }
  if (outcome.kind === "failed") throw outcome.cause;
  return outcome.value;
};

const classifyRootFormat = async (
  path: string,
  handle: FileHandle,
  signal?: AbortSignal,
): Promise<ArtifactOccurrence["artifact_format"]> => {
  const probe = createArtifactClassificationProbe();
  const chunk = Buffer.alloc(64 * 1024);
  while (probe.length < probe.limit) {
    abortIfNeeded(signal);
    const read = await handle.read(
      chunk,
      0,
      Math.min(chunk.length, probe.limit - probe.length),
      probe.length,
    );
    abortIfNeeded(signal);
    if (read.bytesRead === 0) break;
    probe.write(chunk.subarray(0, read.bytesRead));
  }
  const archiveBytes = (await handle.stat()).size;
  const evidence = probe.finish(archiveBytes);
  abortIfNeeded(signal);
  const lower = path.toLowerCase();
  if (hasZipSignature(evidence.prefix)) return zipRootPackageFormat(lower);
  if (lower.endsWith(".pkg") && hasXarSignature(evidence.prefix)) return "pkg";
  if (
    lower.endsWith(".dmg") &&
    (await hasKolyTrailer(handle, archiveBytes, signal))
  )
    return "dmg";
  if (await locateGodotPck(handle, archiveBytes, signal, evidence.prefix))
    return "godot-pck";
  if (
    await isMsiRoot(evidence.prefix, (offset, length) =>
      readAt(handle, offset, length),
    )
  )
    return "msi";
  const fatSliceHeaders = await readRootFatSliceHeaders(
    handle,
    evidence.fatSliceHeaders,
    signal,
  );
  const format = classifyArtifactContent(
    path,
    {
      ...evidence,
      ...(fatSliceHeaders === undefined ? {} : { fatSliceHeaders }),
    },
    archiveBytes,
  ).format;
  // A tar is an image by what it holds, not by its first bytes.
  return format === "tar"
    ? ((await probeImageArchive(handle, archiveBytes, signal)) ?? format)
    : format;
};

/** Read exact FAT header windows missed by the bounded prefix probe. */
const readRootFatSliceHeaders = async (
  handle: FileHandle,
  existing: FatSliceHeaderEvidence | undefined,
  signal?: AbortSignal,
): Promise<FatSliceHeaderEvidence | undefined> => {
  if (existing === undefined) return undefined;
  const { header } = existing;
  const sliceHeadersByOffset = new Map(existing.sliceHeadersByOffset);
  for (let index = 0; index < header.slices.length; index += 1) {
    const slice = header.slices[index];
    const observed =
      slice === undefined ? undefined : sliceHeadersByOffset.get(slice.offset);
    if (
      slice === undefined ||
      header.rangeIssues[index] !== null ||
      slice.size < 4 ||
      (observed !== undefined && observed.magic !== null)
    )
      continue;
    const headerLength = Math.min(12, slice.size);
    const thinHeader = Buffer.alloc(headerLength);
    let bytesRead = 0;
    while (bytesRead < thinHeader.length) {
      abortIfNeeded(signal);
      const read = await handle.read(
        thinHeader,
        bytesRead,
        thinHeader.length - bytesRead,
        slice.offset + bytesRead,
      );
      abortIfNeeded(signal);
      if (read.bytesRead === 0) break;
      bytesRead += read.bytesRead;
    }
    sliceHeadersByOffset.set(
      slice.offset,
      readMachoHeaderPrefixFacts(thinHeader.subarray(0, bytesRead)),
    );
  }
  return { header, sliceHeadersByOffset };
};

const readAt = async (
  handle: FileHandle,
  offset: number,
  length: number,
): Promise<Uint8Array> => {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, offset);
  return buffer.subarray(0, bytesRead);
};

/** App Pack is a verified ZIP root role; nested .app members retain their observed format. */
const zipRootPackageFormat = (lower: string): ZipPackageFormat =>
  lower.endsWith(".app")
    ? "app-pack"
    : (zipPackageFormatForPath(lower) ?? "zip");

const hasKolyTrailer = async (
  handle: FileHandle,
  size: number,
  signal?: AbortSignal,
): Promise<boolean> => {
  if (size < UDIF_TRAILER_BYTES) return false;
  const trailer = Buffer.alloc(4);
  let bytes = 0;
  while (bytes < trailer.length) {
    abortIfNeeded(signal);
    const read = await handle.read(
      trailer,
      bytes,
      trailer.length - bytes,
      size - UDIF_TRAILER_BYTES + bytes,
    );
    abortIfNeeded(signal);
    if (read.bytesRead === 0) return false;
    bytes += read.bytesRead;
  }
  return hasUdifTrailer(trailer);
};
