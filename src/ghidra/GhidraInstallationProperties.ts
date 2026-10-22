import { createHash } from "node:crypto";
import type { RetainedResourceScope } from "../application/AnalysisProvider.js";
import {
  ArtifactFileCancelled,
  ArtifactFileCleanupFailure,
  artifactFilePrimaryFailure,
  withArtifactRegularFile,
} from "../artifacts/ArtifactFileOperation.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import { NonRegularFileReadError } from "../filesystem/RegularFile.js";
import { readStableFileBytes } from "../filesystem/readStableFileBytes.js";
import { ghidraApplicationProperties } from "./GhidraInstallationPolicy.js";
import { ghidraFileFailure } from "./GhidraFileArtifacts.js";

/** Metadata admission budget, not a Java Properties format limit. */
export const MAX_GHIDRA_INSTALLATION_PROPERTIES_BYTES = 1024 * 1024;
export interface GhidraInstallationFileOptions {
  readonly resourceOwner: RetainedResourceScope;
  readonly signal?: AbortSignal;
}

/** Preserve Java's Latin-1 byte mapping and follow the caller's selected symlinks. */
export const readGhidraInstallationProperties = async (
  path: string,
  options: GhidraInstallationFileOptions,
): Promise<string | undefined> => {
  try {
    return await options.resourceOwner.run(() =>
      withArtifactRegularFile(
        path,
        {
          retain: (resource) =>
            options.resourceOwner.retain(
              { close: () => resource.lease.release() },
              resource.resource,
            ),
        },
        options.signal,
        async (file) =>
          (
            await readStableFileBytes(
              file,
              path,
              MAX_GHIDRA_INSTALLATION_PROPERTIES_BYTES,
              {
                symlinks: "follow",
                ...(options.signal === undefined
                  ? {}
                  : { signal: options.signal }),
              },
            )
          ).toString("latin1"),
        "follow",
      ),
    );
  } catch (cause: unknown) {
    const physical = artifactFilePrimaryFailure(cause);
    if (
      !(cause instanceof ArtifactFileCleanupFailure) &&
      physical instanceof Error &&
      "code" in physical &&
      "syscall" in physical &&
      physical.syscall === "open" &&
      (physical.code === "ENOENT" || physical.code === "ENOTDIR")
    )
      return undefined;
    const completed =
      cause instanceof ArtifactFileCancelled
        ? cause.fileCancellation.outcome.value
        : cause instanceof ArtifactFileCleanupFailure &&
            cause.fileCleanupFailure.outcome.kind === "completed"
          ? cause.fileCleanupFailure.outcome.value
          : undefined;
    const diagnostics = {
      path,
      stage: "installation_properties",
      ...(physical instanceof NonRegularFileReadError
        ? { system_code: physical.code }
        : {}),
      ...(typeof completed !== "string"
        ? {}
        : {
            completed_properties: {
              bytes: Buffer.byteLength(completed, "latin1"),
              sha256: createHash("sha256")
                .update(completed, "latin1")
                .digest("hex"),
              properties: jsonValueSchema.parse(
                ghidraApplicationProperties(completed),
              ),
            },
          }),
    };
    throw ghidraFileFailure(cause, "ghidra:installation", diagnostics);
  }
};
