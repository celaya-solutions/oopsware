import { constants, type Stats } from "node:fs";
import {
  link,
  lstat,
  mkdtemp,
  open,
  realpath,
  rename,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";

import { AnalysisCleanupLease } from "../artifacts/AnalysisCleanupLease.js";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import { OwnedStagedOutput } from "../filesystem/OwnedStagedOutput.js";
import {
  RegularFileChangedError,
  sameRegularFileState,
} from "../filesystem/RegularFile.js";
import type { RegularFileOperationOutcome } from "../filesystem/OwnedRegularFile.js";
import { readRegularFileTextSnapshot } from "./RegularFileRead.js";
import { ClientConfigurationPublicationFailure } from "./ClientConfigurationCleanup.js";

/** The exact staged file retained through publication, verification and recovery. */
export class ClientConfigurationPublication {
  private constructor(
    readonly path: string,
    private readonly contents: string,
    private readonly owner: OwnedFileHandle,
    private readonly staging: OwnedStagedOutput,
    private readonly cleanup: AnalysisCleanupLease,
  ) {}

  static async write(
    path: string,
    contents: string,
    previous: string | undefined,
    mode?: number,
  ): Promise<ClientConfigurationPublication> {
    const parent = await realpath(dirname(path));
    const destination = join(parent, basename(path));
    const input = await selectedConfiguration(destination, previous);
    const directory = await mkdtemp(`${parent}${sep}.rea-config-`);
    const staging = await OwnedStagedOutput.create(directory);
    const cleanup = new AnalysisCleanupLease(
      () => staging.close(),
      [directory],
    );
    try {
      const stagedPath = `${directory}${sep}content`;
      const owner = new OwnedFileHandle(
        await open(
          stagedPath,
          constants.O_RDWR |
            constants.O_CREAT |
            constants.O_EXCL |
            (constants.O_NONBLOCK ?? 0) |
            (constants.O_NOFOLLOW ?? 0),
          0o600,
        ),
      );
      staging.setFile(owner);
      await owner.handle.writeFile(contents, { encoding: "utf8" });
      const created = await owner.handle.stat();
      if (
        input !== undefined &&
        (input.uid !== created.uid || input.gid !== created.gid)
      )
        await owner.handle.chown(input.uid, input.gid);
      await owner.handle.chmod(mode ?? (input?.mode ?? 0o600) & 0o7777);
      await owner.handle.sync();
      if ((await owner.handle.stat()).ino === 0)
        throw new RegularFileChangedError(stagedPath);
      await staging.assertReadyForPublication(stagedPath);
      await assertSelectedConfiguration(destination, input);
      if (input === undefined) {
        // An exclusive link cannot overwrite a file created after absence was checked.
        await link(stagedPath, destination);
      } else {
        // The destination is explicit: rename never follows its final symlink.
        await rename(stagedPath, destination);
        staging.recordPublishedRename();
      }
      return new ClientConfigurationPublication(
        destination,
        contents,
        owner,
        staging,
        cleanup,
      );
    } catch (cause: unknown) {
      await releaseStaging(path, staging, cleanup, { kind: "failed", cause });
      throw cause;
    }
  }

  /** Keep all publication resources owned through the complete operation. */
  async verify<Value>(operation: () => Promise<Value>): Promise<Value> {
    let outcome: RegularFileOperationOutcome<Value>;
    try {
      outcome = { kind: "completed", value: await operation() };
    } catch (cause: unknown) {
      outcome = { kind: "failed", cause };
    }
    await releaseStaging(this.path, this.staging, this.cleanup, outcome);
    if (outcome.kind === "failed") throw outcome.cause;
    return outcome.value;
  }

  async assertCurrent(): Promise<void> {
    const owned = await this.owner.handle.stat();
    const named = await lstat(this.path);
    if (
      owned.ino === 0 ||
      named.isSymbolicLink() ||
      !sameRegularFileState(owned, named)
    )
      throw new RegularFileChangedError(this.path);
  }

  /** State checks do not exclude a concurrent writer to the same inode. */
  async restore(original: string | undefined): Promise<void> {
    if (original === undefined)
      throw new Error(
        "First-run configuration recovery requires manual removal; pathname deletion cannot prove ownership",
      );
    const handle = this.owner.handle;
    const before = await handle.stat();
    const named = await lstat(this.path);
    if (
      before.ino === 0 ||
      !before.isFile() ||
      named.isSymbolicLink() ||
      !sameRegularFileState(before, named) ||
      !(await this.#hasPublishedBytes(handle)) ||
      !sameRegularFileState(before, await handle.stat()) ||
      !sameRegularFileState(before, await lstat(this.path))
    )
      throw new RegularFileChangedError(this.path);
    const bytes = Buffer.from(original, "utf8");
    for (let position = 0; position < bytes.length;) {
      const { bytesWritten } = await handle.write(
        bytes,
        position,
        bytes.length - position,
        position,
      );
      if (bytesWritten === 0)
        throw new Error("Configuration restoration made no write progress");
      position += bytesWritten;
    }
    await handle.truncate(bytes.length);
    if (!sameRegularFileState(await handle.stat(), await lstat(this.path)))
      throw new RegularFileChangedError(this.path);
  }

  async #hasPublishedBytes(handle: FileHandle): Promise<boolean> {
    const expected = Buffer.from(this.contents, "utf8");
    if ((await handle.stat()).size !== expected.length) return false;
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, expected.length));
    for (let position = 0; position < expected.length;) {
      const { bytesRead } = await handle.read(
        chunk,
        0,
        Math.min(chunk.length, expected.length - position),
        position,
      );
      if (
        bytesRead === 0 ||
        !chunk
          .subarray(0, bytesRead)
          .equals(expected.subarray(position, position + bytesRead))
      )
        return false;
      position += bytesRead;
    }
    return true;
  }
}

const selectedConfiguration = async (
  path: string,
  previous: string | undefined,
): Promise<Stats | undefined> => {
  let selected:
    | Awaited<ReturnType<typeof readRegularFileTextSnapshot>>
    | undefined;
  try {
    selected = await readRegularFileTextSnapshot(path, { symlinks: "reject" });
  } catch (cause: unknown) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT"))
      throw cause;
  }
  if (selected?.text !== previous || selected?.state.ino === 0)
    throw new RegularFileChangedError(path);
  return selected?.state;
};

const assertSelectedConfiguration = async (
  path: string,
  selected: Stats | undefined,
): Promise<void> => {
  let current: Stats | undefined;
  try {
    current = await lstat(path);
  } catch (cause: unknown) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT"))
      throw cause;
  }
  if (
    selected === undefined
      ? current !== undefined
      : current === undefined ||
        current.isSymbolicLink() ||
        !sameRegularFileState(selected, current)
  )
    throw new RegularFileChangedError(path);
};

const releaseStaging = async <Value>(
  path: string,
  staging: OwnedStagedOutput,
  cleanup: AnalysisCleanupLease,
  outcome: RegularFileOperationOutcome<Value>,
): Promise<void> => {
  try {
    await cleanup.release();
  } catch (cause: unknown) {
    throw new ClientConfigurationPublicationFailure(
      path,
      outcome,
      cause,
      { kind: "staged-output", resource: staging.directory, output: staging },
      cleanup,
    );
  }
};
