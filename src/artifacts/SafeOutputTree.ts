import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  mkdir,
  open,
  readdir,
  realpath,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { Readable } from "node:stream";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import { streamChunkToBuffer } from "./StreamBytes.js";

import {
  ArtifactPathRegistry,
  destinationCaseCollisionMessage,
  normalizeArtifactPath,
} from "./ArtifactPaths.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import { ArtifactReaderFailure } from "./ArtifactReader.js";
import { SafeOutputTreeCreationFailure } from "./SafeOutputTreeCreationFailure.js";
import { hashOutputFile } from "./SafeOutputTreeReadback.js";
import { removeOwnedTree } from "./SafeOutputTreeCleanup.js";
import {
  assertExactTreeEntries,
  assertHandleIdentity,
  assertFilePathIdentity,
  assertPathIdentity,
  isAbsent,
  readDirectoryIdentity,
  readFileIdentity,
  replacedDirectory,
  type DirectoryIdentity,
  type FileIdentity,
} from "./SafeOutputTreeIdentity.js";

/** One file durably written to an operation-owned output tree. */
export interface SafeOutputFile {
  readonly relativePath: string;
  readonly sha256: string;
  readonly bytesWritten: number;
}

/** Cleanup state established while rolling back an uncommitted tree. */
export type SafeOutputCleanup =
  | { readonly status: "not-required" }
  | { readonly status: "complete"; readonly residualPaths: readonly [] }
  | {
      readonly status: "incomplete";
      readonly residualPaths: readonly [string, ...string[]];
    };

/**
 * Materialize files in a tree created by this operation.
 *
 * Path identities are revalidated around operations, but Node has no portable
 * descriptor-relative traversal; a syscall-boundary pathname race remains.
 */
export class SafeOutputTree {
  readonly #registry = new ArtifactPathRegistry();
  readonly #outputRoot: string;
  #rootIdentity: DirectoryIdentity | undefined;
  readonly #nestedDirectories = new Map<string, DirectoryIdentity>();
  readonly #unknownDirectories = new Set<string>();
  readonly #ownedFiles = new Map<string, FileIdentity>();
  readonly #openFiles = new Map<string, OwnedFileHandle>();
  readonly #openHandles = new Set<OwnedFileHandle>();
  #published = false;
  #createdRoot = true;
  #cleanup: SafeOutputCleanup = {
    status: "not-required",
  };

  private constructor(
    outputRoot: string,
    private readonly platform: NodeJS.Platform,
    private readonly selectedRoot: string,
  ) {
    this.#outputRoot = outputRoot;
  }

  /**
   * Exclusively create the destination, or explicitly admit a caller-owned empty
   * directory. Admission never grants authority to remove that existing root.
   *
   * Windows inherits ACLs: mode bits do not establish owner-only access there.
   * Directory `fchmod`/`fsync` are skipped on Windows because those operations
   * have no equivalent on the directory descriptor.
   */
  static async create(
    outputRoot: string,
    platform: NodeJS.Platform = process.platform,
    options: { readonly acceptExistingEmpty?: boolean } = {},
  ): Promise<SafeOutputTree> {
    if (!isAbsolute(outputRoot))
      throw new ArtifactReaderFailure(
        "path",
        "Extraction output root must be absolute",
      );
    // Path syntax follows the host; `platform` selects only the name policy.
    const requested = absoluteCallerPath(outputRoot);
    const name = basename(requested);
    if (name === "." || name === "..")
      throw new ArtifactReaderFailure("path", "Invalid extraction output root");
    const parent = await realpath(dirname(requested)).catch(
      (cause: unknown) => {
        throw new ArtifactReaderFailure(
          "unavailable",
          "Extraction output parent is unavailable",
          { cause },
        );
      },
    );
    const canonicalOutput = join(parent, name);
    let created = true;
    await mkdir(canonicalOutput, { mode: 0o700 }).catch((cause: unknown) => {
      if (!isAlreadyExists(cause)) throw cause;
      if (options.acceptExistingEmpty) {
        created = false;
        return;
      }
      throw new ArtifactReaderFailure(
        "path",
        "Extraction output root already exists",
        { cause },
      );
    });
    const tree = new SafeOutputTree(canonicalOutput, platform, requested);
    tree.#createdRoot = created;
    try {
      const rootIdentity = await readDirectoryIdentity(canonicalOutput);
      tree.#rootIdentity = rootIdentity;
      if (!created && (await readdir(canonicalOutput)).length > 0)
        throw new ArtifactReaderFailure(
          "path",
          "Output directory is not empty",
        );
      if (created)
        await tree.#secureCreatedDirectory(canonicalOutput, rootIdentity);
      await assertPathIdentity(canonicalOutput, rootIdentity);
      return tree;
    } catch (cause: unknown) {
      throw new SafeOutputTreeCreationFailure(cause, tree);
    }
  }

  get outputRoot(): string {
    return this.#outputRoot;
  }

  /** The output was durably committed, even if descriptor cleanup later failed. */
  get published(): boolean {
    return this.#published;
  }

  get cleanup(): SafeOutputCleanup {
    return structuredClone(this.#cleanup);
  }

  /** Stream one regular file with exact byte and digest verification. */
  async write(
    relativePath: string,
    source: Readable,
    expected: { readonly sha256: string; readonly bytes: number },
    signal?: AbortSignal,
  ): Promise<SafeOutputFile> {
    try {
      this.#assertWritable();
      if (!Number.isSafeInteger(expected.bytes) || expected.bytes < 0)
        throw new ArtifactReaderFailure(
          "format",
          `Invalid expected extraction size for ${relativePath}`,
        );
      const path = normalizeDestinationPath(relativePath, this.platform);
      this.#registry.add(path, "file");
      const lineage = await this.#prepareParent(path);
      const parent = lineage.at(-1);
      if (parent === undefined) throw replacedDirectory(this.#outputRoot);
      const fileName = path.slice(path.lastIndexOf("/") + 1);
      const destination = join(parent.path, fileName);
      const handle = await open(
        destination,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600,
      ).catch(async (cause: unknown) => {
        await throwIfDestinationCaseCollision(parent.path, path, cause);
        throw new ArtifactReaderFailure(
          "path",
          `Could not exclusively create extraction path: ${path}`,
          { cause },
        );
      });
      const ownedHandle = this.#trackHandle(handle);
      this.#openFiles.set(destination, ownedHandle);
      const fileIdentity = await readFileIdentity(
        ownedHandle.handle,
        destination,
      );
      await assertFilePathIdentity(destination, fileIdentity);
      this.#ownedFiles.set(destination, fileIdentity);
      if (this.platform !== "win32") {
        await ownedHandle.handle.chmod(0o600);
        if (((await ownedHandle.handle.stat()).mode & 0o777) !== 0o600)
          throw new ArtifactReaderFailure(
            "path",
            "Could not establish private output file permissions",
          );
      }
      const hash = createHash("sha256");
      let bytes = 0;
      await this.#assertLineage(lineage);
      for await (const raw of source) {
        abortIfNeeded(signal);
        const chunk = streamChunkToBuffer(raw);
        if (chunk.length > expected.bytes - bytes)
          throw new ArtifactReaderFailure(
            "integrity",
            `Extracted content exceeds the inventoried size: ${path}`,
          );
        bytes += chunk.length;
        hash.update(chunk);
        await writeAll(ownedHandle.handle, chunk);
      }
      if (bytes !== expected.bytes)
        throw new ArtifactReaderFailure(
          "integrity",
          `Extracted content size disagrees with inventory: ${path}`,
        );
      const sha256 = hash.digest("hex");
      if (sha256 !== expected.sha256)
        throw new ArtifactReaderFailure(
          "integrity",
          `Extracted content disagrees with inventory: ${path}`,
        );
      await this.#assertLineage(lineage);
      await assertFilePathIdentity(destination, fileIdentity);
      await ownedHandle.handle.sync();
      await this.#closeFileHandle(destination, ownedHandle);
      const readbackHandle = this.#trackHandle(
        await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW),
      );
      const readback = await hashOutputFile(
        readbackHandle,
        destination,
        fileIdentity,
        { maximum: bytes, signal },
      );
      await this.#closeHandle(readbackHandle);
      await this.#assertLineage(lineage);
      await assertFilePathIdentity(destination, fileIdentity);
      if (readback.sha256 !== sha256 || readback.bytes !== bytes)
        throw new ArtifactReaderFailure(
          "integrity",
          `Durable readback verification failed: ${path}`,
        );
      return { relativePath: path, sha256, bytesWritten: bytes };
    } catch (cause: unknown) {
      try {
        source.destroy();
      } catch {
        // Preserve the write refusal or failure as the caller-visible error.
      }
      throw cause;
    }
  }

  /** Sync the owned output tree and prevent further writes through this instance. */
  async commit(signal?: AbortSignal): Promise<void> {
    this.#assertWritable();
    abortIfNeeded(signal);
    await this.#assertOwnedDirectories();
    await this.#assertExactEntries();
    abortIfNeeded(signal);
    // Windows has no directory fsync; file contents are already synced in write().
    if (this.platform === "win32") {
      this.#published = true;
      return;
    }
    const parent = this.#trackHandle(
      await open(
        dirname(this.#outputRoot),
        constants.O_RDONLY | constants.O_DIRECTORY,
      ),
    );
    let output: OwnedFileHandle | undefined;
    let sync:
      | { readonly kind: "synced" }
      | {
          readonly kind: "failed";
          readonly cause: unknown;
        } = { kind: "synced" };
    try {
      output = this.#trackHandle(
        await open(
          this.#outputRoot,
          constants.O_RDONLY | constants.O_DIRECTORY,
        ),
      );
      await assertHandleIdentity(
        output.handle,
        this.#requireRootIdentity(),
        this.#outputRoot,
      );
      await output.handle.sync();
      await parent.handle.sync();
      await this.#assertExactEntries();
      abortIfNeeded(signal);
      this.#published = true;
    } catch (cause: unknown) {
      sync = { kind: "failed", cause };
    }
    const closeResults = await Promise.allSettled(
      [parent, output]
        .filter(isDefined)
        .map((handle) => this.#closeHandle(handle)),
    );
    const closeFailures = closeResults
      .filter(isRejected)
      .map(({ reason }) => reason);
    if (closeFailures.length > 0) {
      const closeFailure = new AggregateError(
        closeFailures,
        "Extraction output directory handles could not be closed",
      );
      const cleanup = ArtifactReaderFailure.cleanupObservation(
        closeFailure,
        this.#outputRoot,
      );
      if (sync.kind === "failed") {
        const primary = isCancellationFailure(sync.cause)
          ? sync.cause
          : new ArtifactReaderFailure(
              "path",
              "Could not durably sync extraction output",
              { cause: sync.cause },
            );
        throw ArtifactReaderFailure.withCleanup(primary, cleanup);
      }
      throw ArtifactReaderFailure.withCleanup(closeFailure, cleanup);
    }
    if (sync.kind === "failed") {
      if (isCancellationFailure(sync.cause)) throw sync.cause;
      throw new ArtifactReaderFailure(
        "path",
        "Could not durably sync extraction output",
        { cause: sync.cause },
      );
    }
  }

  /** Remove only this operation's unsealed tree and verify absence. */
  async rollback(): Promise<SafeOutputCleanup> {
    if (this.#published) {
      await this.closeHandles();
      return structuredClone(this.#cleanup);
    }
    if (this.#cleanup.status === "complete")
      return structuredClone(this.#cleanup);
    this.#cleanup = {
      status: "incomplete",
      residualPaths: [basename(this.#outputRoot)],
    };
    let removalFailure: unknown;
    try {
      await this.#admitPendingFiles();
      await this.closeHandles();
      await this.#assertOwnedDirectories();
      await removeOwnedTree({
        outputRoot: this.#outputRoot,
        rootIdentity: this.#requireRootIdentity(),
        directories: this.#nestedDirectories,
        files: this.#ownedFiles,
        preserveRoot: !this.#createdRoot,
      });
      if (!this.#createdRoot)
        await assertPathIdentity(this.#outputRoot, this.#requireRootIdentity());
    } catch (cause: unknown) {
      removalFailure = cause;
    }
    const complete =
      removalFailure === undefined &&
      (!this.#createdRoot || (await isAbsent(this.#outputRoot)));
    this.#cleanup = complete
      ? { status: "complete", residualPaths: [] }
      : {
          status: "incomplete",
          residualPaths: [basename(this.#outputRoot)],
        };
    if (!complete)
      throw new ArtifactReaderFailure(
        "integrity",
        `Extraction output cleanup could not be verified${removalFailure === undefined ? "" : `: ${removalFailure instanceof Error ? removalFailure.message : String(removalFailure)}`}`,
        {
          cause: removalFailure,
          cleanup: {
            reason:
              removalFailure instanceof Error
                ? removalFailure.message
                : "Extraction output root remains after rollback",
            resources: [this.#outputRoot],
          },
        },
      );
    return structuredClone(this.#cleanup);
  }

  async #secureCreatedDirectory(
    path: string,
    identity: DirectoryIdentity,
  ): Promise<void> {
    if (this.platform === "win32") return;
    const stagingHandle = this.#trackHandle(
      await open(path, constants.O_RDONLY | constants.O_DIRECTORY).catch(
        async (cause: unknown) => {
          if (
            !(cause instanceof Error) ||
            !("code" in cause) ||
            cause.code !== "EACCES"
          )
            throw cause;
          // Owner-read can be masked at mkdir; repair only the proven created
          // directory under the same portable pathname-race boundary.
          await assertPathIdentity(path, identity);
          await chmod(path, 0o700);
          await assertPathIdentity(path, identity);
          return open(path, constants.O_RDONLY | constants.O_DIRECTORY);
        },
      ),
    );
    let setup:
      | { readonly kind: "ready" }
      | {
          readonly kind: "failed";
          readonly cause: unknown;
        } = { kind: "ready" };
    try {
      await assertHandleIdentity(stagingHandle.handle, identity, path);
      await stagingHandle.handle.chmod(0o700);
      if (((await stagingHandle.handle.stat()).mode & 0o777) !== 0o700)
        throw new ArtifactReaderFailure(
          "path",
          "Could not establish owner access to output directory",
        );
    } catch (cause: unknown) {
      setup = { kind: "failed", cause };
    }
    try {
      await this.#closeHandle(stagingHandle);
    } catch (closeCause: unknown) {
      if (setup.kind === "failed")
        throw ArtifactReaderFailure.withCleanup(
          setup.cause,
          ArtifactReaderFailure.cleanupObservation(closeCause, path),
        );
      throw closeCause;
    }
    if (setup.kind === "failed") throw setup.cause;
  }

  async #prepareParent(
    relativePath: string,
  ): Promise<readonly DirectoryLineageEntry[]> {
    const parts = relativePath.split("/");
    if (parts.pop() === undefined)
      throw new ArtifactReaderFailure("path", "Invalid extraction path");
    let current = this.#outputRoot;
    let logicalParent = "";
    const lineage: DirectoryLineageEntry[] = [
      { path: this.#outputRoot, identity: this.#requireRootIdentity() },
    ];
    if (parts.length === 0)
      await assertPathIdentity(this.#outputRoot, this.#requireRootIdentity());
    for (const part of parts) {
      const parent = lineage.at(-1);
      if (parent === undefined) throw replacedDirectory(this.#outputRoot);
      const logicalPath =
        logicalParent.length === 0 ? part : `${logicalParent}/${part}`;
      current = join(current, part);
      await assertPathIdentity(parent.path, parent.identity);
      let created = true;
      await mkdir(current, { mode: 0o700 }).catch((cause: unknown) => {
        if (!isAlreadyExists(cause)) throw cause;
        created = false;
      });
      if (!created) {
        await throwIfDestinationCaseCollision(parent.path, logicalPath);
        const identity = this.#nestedDirectories.get(current);
        if (identity === undefined) throw replacedDirectory(current);
        await assertPathIdentity(current, identity);
      } else {
        const identity = await readDirectoryIdentity(current).catch(
          (cause: unknown) => {
            this.#unknownDirectories.add(current);
            throw cause;
          },
        );
        this.#nestedDirectories.set(current, identity);
        await this.#secureCreatedDirectory(current, identity);
      }
      await assertPathIdentity(parent.path, parent.identity);
      const identity = this.#nestedDirectories.get(current);
      if (identity === undefined) throw replacedDirectory(current);
      await assertPathIdentity(current, identity);
      lineage.push({ path: current, identity });
      logicalParent = logicalPath;
    }
    return lineage;
  }

  async #assertLineage(
    lineage: readonly DirectoryLineageEntry[],
  ): Promise<void> {
    for (const { path, identity } of lineage)
      await assertPathIdentity(path, identity);
  }

  async #assertOwnedDirectories(): Promise<void> {
    const rootIdentity = this.#requireRootIdentity();
    await assertPathIdentity(this.#outputRoot, rootIdentity);
    await assertPathIdentity(this.selectedRoot, rootIdentity);
    for (const [path, identity] of this.#nestedDirectories)
      await assertPathIdentity(path, identity);
    if (this.#unknownDirectories.size > 0)
      throw new ArtifactReaderFailure(
        "path",
        `Extraction directory ownership is unknown: ${[...this.#unknownDirectories].join(", ")}`,
      );
  }

  async #assertExactEntries(): Promise<void> {
    await assertExactTreeEntries(
      this.#outputRoot,
      this.#nestedDirectories,
      this.#ownedFiles,
    );
    await this.#assertOwnedDirectories();
  }

  #requireRootIdentity(): DirectoryIdentity {
    if (this.#rootIdentity === undefined)
      throw new ArtifactReaderFailure(
        "path",
        `Extraction output root identity is unknown: ${this.#outputRoot}`,
      );
    return this.#rootIdentity;
  }

  #assertWritable(): void {
    if (this.#published)
      throw new ArtifactReaderFailure(
        "integrity",
        "Extraction tree is already committed",
      );
    if (this.#cleanup.status !== "not-required")
      throw new ArtifactReaderFailure(
        "integrity",
        "Extraction tree cleanup has already started",
      );
  }

  #trackHandle(handle: FileHandle): OwnedFileHandle {
    const owner = new OwnedFileHandle(handle);
    this.#openHandles.add(owner);
    return owner;
  }

  async #closeHandle(owner: OwnedFileHandle): Promise<void> {
    await owner.close();
    this.#openHandles.delete(owner);
  }

  /** Release descriptors without deleting an inspectable partial output tree. */
  async closeHandles(): Promise<void> {
    const failures: unknown[] = [];
    for (const owner of this.#openHandles) {
      try {
        await this.#closeHandle(owner);
      } catch (cause: unknown) {
        failures.push(cause);
      }
    }
    if (failures.length > 0)
      throw new AggregateError(failures, "Output tree handles remain open");
  }

  async #closeFileHandle(path: string, owner: OwnedFileHandle): Promise<void> {
    await this.#closeHandle(owner);
    this.#openFiles.delete(path);
  }

  async #admitPendingFiles(): Promise<void> {
    for (const [path, owner] of this.#openFiles) {
      let identity = this.#ownedFiles.get(path);
      if (identity === undefined) {
        identity = await readFileIdentity(owner.handle, path);
        await assertFilePathIdentity(path, identity);
        this.#ownedFiles.set(path, identity);
      }
    }
  }
}

const isDefined = <T>(value: T | undefined): value is T => value !== undefined;

const isRejected = (
  result: PromiseSettledResult<void>,
): result is PromiseRejectedResult => result.status === "rejected";

type DirectoryLineageEntry = {
  readonly path: string;
  readonly identity: DirectoryIdentity;
};

const writeAll = async (
  handle: Awaited<ReturnType<typeof open>>,
  chunk: Buffer,
): Promise<void> => {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(
      chunk,
      offset,
      chunk.length - offset,
    );
    if (bytesWritten === 0)
      throw new ArtifactReaderFailure(
        "unavailable",
        "Extraction output stopped accepting bytes",
      );
    offset += bytesWritten;
  }
};

const normalizeDestinationPath = (
  relativePath: string,
  platform: NodeJS.Platform,
): string => {
  const path = normalizeArtifactPath(relativePath);
  if (platform === "win32" && path.includes("\\"))
    throw new ArtifactReaderFailure(
      "path",
      `Windows destination cannot materialize artifact path: ${JSON.stringify(path)}; backslashes denote path separators.`,
    );
  if (platform === "win32" && path.includes(":"))
    throw new ArtifactReaderFailure(
      "path",
      `Windows destination cannot materialize artifact path as a regular file: ${path}; ':' denotes alternate data stream syntax.`,
    );
  if (platform === "win32" && /[\u0001-\u001f]/u.test(path))
    throw new ArtifactReaderFailure(
      "path",
      `Windows destination cannot materialize artifact path: ${JSON.stringify(path)}; Windows names cannot contain U+0001-U+001F.`,
    );
  return path;
};

const abortIfNeeded = (signal?: AbortSignal): void => {
  if (signal?.aborted === true)
    throw new ArtifactReaderFailure(
      "cancelled",
      "Artifact extraction cancelled",
      { cause: signal.reason },
    );
};

const isCancellationFailure = (
  cause: unknown,
): cause is ArtifactReaderFailure =>
  cause instanceof ArtifactReaderFailure && cause.reason === "cancelled";

const isAlreadyExists = (cause: unknown): boolean =>
  cause instanceof Error && "code" in cause && cause.code === "EEXIST";

/** Fail when this directory already holds another spelling of the requested segment. */
const throwIfDestinationCaseCollision = async (
  parentDirectory: string,
  logicalPath: string,
  cause?: unknown,
): Promise<void> => {
  const names = await readdir(parentDirectory).catch(() => undefined);
  if (names === undefined) return;
  const message = destinationCaseCollisionMessage(logicalPath, names);
  if (message === undefined) return;
  throw new ArtifactReaderFailure(
    "path",
    message,
    cause === undefined ? undefined : { cause },
  );
};
