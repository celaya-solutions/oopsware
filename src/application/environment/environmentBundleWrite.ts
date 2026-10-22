import { createHash } from "node:crypto";
import { mkdir, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";

import {
  AnalysisInputError,
  AnalysisAccessDeniedError,
} from "../../domain/analysisErrorCore.js";
import { AnalysisCleanupLease } from "../../artifacts/AnalysisCleanupLease.js";
import { ArtifactFileCleanupFailure } from "../../artifacts/ArtifactFileOperation.js";
import { RegularFileCleanupFailure } from "../../filesystem/OwnedRegularFile.js";
import { streamChunkToBuffer } from "../../artifacts/StreamBytes.js";
import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { SafeOutputTree } from "../../artifacts/SafeOutputTree.js";
import { SafeOutputTreeCreationFailure } from "../../artifacts/SafeOutputTreeCreationFailure.js";
import { RegularFileChangedError } from "../../filesystem/RegularFile.js";
import { withRegularFile } from "../RegularFileRead.js";
import {
  ENVIRONMENT_EXPORT_OPERATION,
  type EnvironmentBundlePlan,
} from "./environmentBundle.js";
import type {
  EnvironmentExportInput,
  WrittenBundleFile,
} from "./environmentExport.js";

const writeBytes = async (
  tree: SafeOutputTree,
  relative: string,
  bytes: Buffer,
): Promise<WrittenBundleFile> => {
  const written = await tree.write(relative, Readable.from([bytes]), {
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  return { path: written.relativePath, bytes: written.bytesWritten };
};

interface BundleTarball {
  readonly path: string;
  readonly handle: FileHandle;
  readonly size: number;
}

/** Hash and copy only the instance retained before destination admission. */
const writeTarball = async (
  tree: SafeOutputTree,
  relative: string,
  source: BundleTarball,
): Promise<WrittenBundleFile> => {
  const hash = createHash("sha256");
  let observed = 0;
  for await (const chunk of source.handle.createReadStream({
    start: 0,
    autoClose: false,
  })) {
    const bytes = streamChunkToBuffer(chunk);
    observed += bytes.length;
    if (observed > source.size) throw new RegularFileChangedError(source.path);
    hash.update(bytes);
  }
  if (observed !== source.size) throw new RegularFileChangedError(source.path);
  const written = await tree.write(
    relative,
    source.handle.createReadStream({ start: 0, autoClose: false }),
    {
      bytes: source.size,
      sha256: hash.digest("hex"),
    },
  );
  return { path: written.relativePath, bytes: written.bytesWritten };
};

/** The output owner anchors every create and verifies the complete tree before publication. */
const writeBundleFiles = async (
  input: EnvironmentExportInput,
  plan: EnvironmentBundlePlan,
  tarball?: BundleTarball,
): Promise<readonly WrittenBundleFile[]> => {
  const resources = new ArtifactResourceScope();
  let tree: SafeOutputTree | undefined;
  let written: WrittenBundleFile[] | undefined;
  let outcome:
    | {
        readonly kind: "completed";
        readonly files: readonly WrittenBundleFile[];
      }
    | { readonly kind: "failed"; readonly cause: unknown };
  try {
    await mkdir(dirname(input.directory), { recursive: true, mode: 0o700 });
    try {
      tree = await SafeOutputTree.create(input.directory, process.platform, {
        acceptExistingEmpty: true,
      });
    } catch (cause: unknown) {
      if (cause instanceof SafeOutputTreeCreationFailure) tree = cause.tree;
      throw cause;
    }
    written = [];
    for (const file of plan.files)
      written.push(
        await writeBytes(tree, file.path, Buffer.from(file.content)),
      );
    written.push(
      await writeBytes(tree, plan.copies.manifest, input.manifest.bytes),
    );
    written.push(
      await writeBytes(tree, plan.copies.evidence, input.evidence.bytes),
    );
    if (plan.copies.tarball !== null && tarball !== undefined)
      written.push(await writeTarball(tree, plan.copies.tarball, tarball));
    await tree.commit();
    outcome = { kind: "completed", files: written };
  } catch (cause: unknown) {
    outcome = { kind: "failed", cause };
  }
  const owner = tree;
  if (owner !== undefined) {
    const closed = await resources.release({
      kind: "lease",
      resource: input.directory,
      lease: { release: () => owner.closeHandles() },
    });
    if (closed.kind === "failed")
      throw resources.cleanupFailure(outcome, [closed]);
  }
  if (outcome.kind === "failed") {
    if (owner?.published === true && written !== undefined) return written;
    throw outcome.cause;
  }
  return outcome.files;
};

/** Retain one tarball instance across planning output writes and final stability verification. */
export const writeEnvironmentBundle = async (
  input: EnvironmentExportInput,
  plan: EnvironmentBundlePlan,
): Promise<readonly WrittenBundleFile[]> => {
  if (plan.packageSource.kind !== "tarball")
    return writeBundleFiles(input, plan);
  const path = plan.packageSource.path;
  const resources = new ArtifactResourceScope();
  let admitted = false;
  try {
    return await withRegularFile(
      path,
      async (handle, state) => {
        admitted = true;
        return writeBundleFiles(input, plan, {
          path,
          handle,
          size: state.size,
        });
      },
      { resources },
    );
  } catch (cause: unknown) {
    if (cause instanceof RegularFileCleanupFailure)
      throw new ArtifactFileCleanupFailure(
        cause,
        AnalysisCleanupLease.forCloseOwner(cause.owner, path),
      );
    if (!admitted && cause instanceof Error && "code" in cause) {
      if (cause.code === "EACCES" || cause.code === "EPERM")
        throw new AnalysisAccessDeniedError(
          ENVIRONMENT_EXPORT_OPERATION,
          path,
          cause.code,
          { cause },
        );
      if (
        ["ENOENT", "ENOTDIR", "ENAMETOOLONG", "EISDIR", "ENOTFILE"].includes(
          String(cause.code),
        )
      )
        throw new AnalysisInputError(
          ENVIRONMENT_EXPORT_OPERATION,
          {
            cause,
            userMessage: `${path} must name a readable regular package tarball.`,
          },
          [
            {
              path: ["package_tarball"],
              reason: "invalid_value",
              message: "The package tarball must be an existing regular file.",
            },
          ],
        );
    }
    throw cause;
  }
};
