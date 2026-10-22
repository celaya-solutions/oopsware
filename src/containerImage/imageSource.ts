import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";

import { readStableArtifact } from "../artifacts/readStableArtifact.js";
import { stableReadFailure } from "../artifacts/stableReadFailure.js";
import { AnalysisUnsupportedTargetError } from "../domain/analysisErrorCore.js";
import {
  hasGzipSignature,
  hasTarHeader,
} from "../domain/archiveStreamFormat.js";
import type {
  ContainerImageReport,
  ImageDiagnostic,
  ImageFormat,
  InspectContainerImageInput,
} from "../domain/containerImage/containerImage.js";
import {
  DirectoryBlobStore,
  TarBlobStore,
  type BlobStore,
} from "./blobStore.js";

export const OPERATION = "inspect_container_image";

export interface OpenedImage {
  readonly store: BlobStore;
  readonly format: ImageFormat;
  readonly artifact: ContainerImageReport["artifact"];
  /** The OCI index and layout files are present (always true for a layout or OCI archive). */
  readonly hasOciIndex: boolean;
  readonly diagnostics: readonly ImageDiagnostic[];
}

const unsupported = (path: string, message: string) =>
  new AnalysisUnsupportedTargetError(OPERATION, path, message);

/** What opening needs: the path and the byte limit for any one read. */
export type OpenInput = Pick<
  InspectContainerImageInput,
  "path" | "max_file_bytes"
>;

const openDirectory = async (
  input: OpenInput,
  signal: AbortSignal | undefined,
): Promise<OpenedImage> => {
  const store = new DirectoryBlobStore(input.path, input.max_file_bytes);
  if (
    (await store.size("oci-layout")) === null ||
    (await store.size("index.json")) === null
  )
    throw unsupported(
      input.path,
      "The directory is not an OCI image layout: it needs an oci-layout file and an index.json.",
    );
  const index = await store.read("index.json", input.max_file_bytes, signal);
  return {
    store,
    format: "oci-image-layout",
    artifact: {
      path: input.path,
      kind: "directory",
      sha256: createHash("sha256").update(index).digest("hex"),
      sha256_of: "index.json",
      bytes: null,
    },
    hasOciIndex: true,
    diagnostics: [],
  };
};

const openArchive = async (
  input: OpenInput,
  signal: AbortSignal | undefined,
): Promise<OpenedImage> => {
  let snapshot: Awaited<ReturnType<typeof readStableArtifact>>;
  try {
    snapshot = await readStableArtifact(
      input.path,
      input.max_file_bytes,
      signal,
    );
  } catch (cause) {
    throw stableReadFailure(OPERATION, input.path, cause, {
      cancelled: signal?.aborted === true,
      maxFileBytes: input.max_file_bytes,
      remediationAction:
        "Raise max_file_bytes (up to 1 GiB) or select a smaller file.",
    });
  }
  if (hasGzipSignature(snapshot.bytes))
    throw unsupported(
      input.path,
      "The file is gzip-compressed. Decompress it to a .tar first; an image archive is read as a tar.",
    );
  if (!hasTarHeader(snapshot.bytes))
    throw unsupported(
      input.path,
      "The file is not a tar archive, so it is not an OCI image archive or a Docker save archive.",
    );
  const store = await TarBlobStore.open(snapshot.bytes, signal);
  const docker = store.has("manifest.json");
  const oci = store.has("oci-layout") && store.has("index.json");
  if (!docker && !oci)
    throw unsupported(
      input.path,
      "The tar has neither a manifest.json nor an oci-layout with an index.json. A plain tar, such as a docker export root filesystem, has no image configuration or history and is not an image; inspect_artifact lists its files.",
    );
  return {
    store,
    format: docker ? "docker-save-archive" : "oci-image-archive",
    artifact: {
      path: input.path,
      kind: "file",
      sha256: snapshot.sha256,
      sha256_of: "content",
      bytes: snapshot.bytes.length,
    },
    hasOciIndex: oci,
    diagnostics: store.diagnostics,
  };
};

/** Read one directory or archive and classify it by its structure, not its name. */
export const openImage = async (
  input: OpenInput,
  signal: AbortSignal | undefined,
): Promise<OpenedImage> => {
  const stats = await lstat(input.path).catch(() => null);
  return stats?.isDirectory() === true
    ? openDirectory(input, signal)
    : openArchive(input, signal);
};
