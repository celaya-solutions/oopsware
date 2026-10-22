import { regularFileCancellation } from "../../filesystem/OwnedRegularFile.js";
import { createHash } from "node:crypto";
import { lstat, mkdir, opendir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import { normalizeArtifactPath } from "../../artifacts/ArtifactPaths.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
} from "../../domain/analysisErrorCore.js";
import {
  NonRegularFileReadError,
  openRegularFile,
  RegularFileAdmissionFailure,
} from "../../filesystem/RegularFile.js";
import { RECOVERY_LIMITS } from "./WakaruRelease.js";

const OPERATION = "recover_javascript_sources";

/** Fingerprint exact selected or derived bytes. */
export const recoveryDigest = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/** A file exceeded the byte bound its caller selected; the caller owns what that bound means. */
class RecoveryFileSizeError extends AnalysisOutputError {
  constructor(
    reason: string,
    readonly maximum: number,
  ) {
    super(OPERATION, reason);
  }
}

/** Read a stable regular file without retaining bytes during engine fingerprinting. */
const scanRecoveryFile = async (
  path: string,
  maximum: number,
  consume: (chunk: Buffer) => void,
  signal?: AbortSignal,
) => {
  // A FIFO without a writer must be rejected before it can block the open.
  const handle = await openRegularFile(path, {
    symlinks: "reject",
    signal,
  }).catch((cause: unknown) => {
    // A descriptor whose close failed stays owned by its error, even when
    // cancellation was also requested.
    if (cause instanceof RegularFileAdmissionFailure) throw cause;
    const cancellation = regularFileCancellation(cause);
    if (cancellation !== undefined)
      throw new AnalysisCancelledError(OPERATION, {
        cause: cancellation.reason,
      });
    if (cause instanceof NonRegularFileReadError)
      throw new AnalysisOutputError(
        OPERATION,
        `Expected a regular file no larger than ${String(maximum)} bytes: ${path}`,
      );
    throw cause;
  });
  const hash = createHash("sha256");
  try {
    const before = await handle.stat();
    if (before.size > maximum)
      throw new RecoveryFileSizeError(
        `Expected a regular file no larger than ${String(maximum)} bytes: ${path}`,
        maximum,
      );
    let bytes = 0;
    for await (const raw of handle.createReadStream({ autoClose: false })) {
      checkRecoveryCancellation(signal);
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      bytes += chunk.length;
      if (bytes > maximum)
        throw new RecoveryFileSizeError(
          `File exceeds ${String(maximum)} bytes: ${path}`,
          maximum,
        );
      hash.update(chunk);
      consume(chunk);
    }
    const after = await handle.stat();
    const current = await lstat(path);
    if (
      before.dev !== current.dev ||
      before.ino !== current.ino ||
      before.size !== bytes ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.size !== after.size
    )
      throw new AnalysisOutputError(
        OPERATION,
        `File identity changed while reading: ${path}`,
      );
    return { sha256: hash.digest("hex"), bytes };
  } finally {
    await handle.close();
  }
};

/** Fingerprint a regular file incrementally with bounded memory. */
export const fingerprintRecoveryFile = async (
  path: string,
  maximum: number,
  signal?: AbortSignal,
) => scanRecoveryFile(path, maximum, () => {}, signal);

/** Read only a regular file through one handle with a bounded, stable identity. */
export const readRecoveryFile = async (
  path: string,
  maximum: number,
  signal?: AbortSignal,
): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  const result = await scanRecoveryFile(
    path,
    maximum,
    (chunk) => chunks.push(chunk),
    signal,
  );
  return Buffer.concat(chunks, result.bytes);
};

export type RecoveryInputSnapshot = {
  path: string;
  snapshot_path: string;
  relative_path: string;
  sha256: string;
  bytes: number;
};

/** Snapshot one script within the remaining operation-wide input budget. */
const snapshotRecoveryInput = async (
  path: string,
  snapshotPath: string,
  relativePath: string,
  maximum: number,
  signal?: AbortSignal,
): Promise<RecoveryInputSnapshot> => {
  if (!isAbsolute(path))
    throw recoveryInputFailure(
      "path",
      "Select an absolute JavaScript file path",
    );
  let bytes: Buffer;
  try {
    bytes = await readRecoveryFile(path, maximum, signal);
  } catch (cause: unknown) {
    if (cause instanceof AnalysisCancelledError) throw cause;
    // The operation-wide input allowance is a deterministic byte budget, not
    // a malformed argument; the same selection fails again unchanged.
    if (cause instanceof RecoveryFileSizeError)
      throw new AnalysisResourceConstraintError(
        OPERATION,
        "file-size",
        `Selected JavaScript input ${path} exceeds the ${String(cause.maximum)} bytes remaining of the ${String(RECOVERY_LIMITS.inputBytes)}-byte total input allowance`,
        {
          maximum_input_bytes: RECOVERY_LIMITS.inputBytes,
          remaining_input_bytes: cause.maximum,
        },
        {
          cause,
          retryable: false,
          remediationAction:
            "Select JavaScript inputs whose combined size is within maximum_input_bytes. Do not truncate required source; retrying the unchanged selection will fail again.",
        },
      );
    throw recoveryInputFailure(
      "path",
      `Cannot snapshot UTF-8 JavaScript input ${path}: ${recoveryFailureMessage(cause)}`,
      cause,
    );
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause: unknown) {
    throw new AnalysisInputError(OPERATION, { cause }, [
      {
        path: ["path"],
        reason: "invalid_format",
        expected: "UTF-8",
        message: `JavaScript input is not valid UTF-8: ${path}`,
      },
    ]);
  }
  await mkdir(dirname(snapshotPath), { recursive: true, mode: 0o700 });
  await writeFile(snapshotPath, bytes, { flag: "wx", mode: 0o600 });
  return {
    path,
    snapshot_path: snapshotPath,
    relative_path: relativePath,
    sha256: recoveryDigest(bytes),
    bytes: bytes.length,
  };
};

/** Preserve each selected file and its relative input layout without concatenation. */
export const snapshotRecoveryInputs = async (
  paths: readonly [string, ...string[]],
  directory: string,
  signal?: AbortSignal,
): Promise<readonly [RecoveryInputSnapshot, ...RecoveryInputSnapshot[]]> => {
  let commonDirectory = dirname(resolve(paths[0]));
  for (const path of paths) {
    while (true) {
      const fromCommon = relative(commonDirectory, resolve(path));
      if (
        fromCommon !== ".." &&
        !fromCommon.startsWith(`..${sep}`) &&
        !isAbsolute(fromCommon)
      )
        break;
      const parent = dirname(commonDirectory);
      if (parent === commonDirectory)
        throw recoveryInputFailure(
          "additional_paths",
          "Selected files must share a filesystem root",
        );
      commonDirectory = parent;
    }
  }
  const snapshots: RecoveryInputSnapshot[] = [];
  let remaining = RECOVERY_LIMITS.inputBytes;
  for (const path of paths) {
    const relativePath =
      paths.length === 1
        ? "bundle.js"
        : relative(commonDirectory, resolve(path)).split(sep).join("/");
    try {
      // Wakaru's multi-input public paths interpret backslashes as separators.
      if (relativePath.includes("\\"))
        throw new TypeError(
          "Wakaru cannot preserve literal backslashes in input paths",
        );
      if (normalizeArtifactPath(relativePath) !== relativePath)
        throw new TypeError(
          "Input names must already use NFC Unicode spelling",
        );
    } catch (cause: unknown) {
      throw recoveryInputFailure(
        "path",
        `Cannot preserve selected input path in published artifacts: ${path}: ${recoveryFailureMessage(cause)}`,
        cause,
      );
    }
    const snapshot = await snapshotRecoveryInput(
      path,
      join(directory, relativePath),
      relativePath,
      remaining,
      signal,
    );
    snapshots.push(snapshot);
    remaining -= snapshot.bytes;
  }
  // The selected-input tuple guarantees a primary snapshot.
  const [primary, ...additional] = snapshots;
  if (primary === undefined)
    throw recoveryInputFailure("path", "Select a JavaScript input");
  return [primary, ...additional];
};

/** Inventory staging without following symlinks or publishing special files. */
export const inventoryRecoveryFiles = async (
  root: string,
  signal?: AbortSignal,
): Promise<
  readonly { relativePath: string; path: string; bytes: number }[]
> => {
  const files: { relativePath: string; path: string; bytes: number }[] = [];
  let bytes = 0;
  let entries = 0;
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw new AnalysisOutputError(
        OPERATION,
        `Unsafe staging directory: ${directory}`,
      );
    const handle = await opendir(directory);
    const children: string[] = [];
    try {
      for await (const entry of handle) {
        checkRecoveryCancellation(signal);
        entries++;
        if (entries > RECOVERY_LIMITS.outputEntries)
          throw new AnalysisOutputError(
            OPERATION,
            "Recovery staging exceeds the 10000-entry resource limit",
          );
        children.push(entry.name);
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
    for (const name of children) {
      checkRecoveryCancellation(signal);
      const relativePath = prefix === "" ? name : `${prefix}/${name}`;
      const path = join(directory, name);
      const info = await lstat(path);
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()))
        throw new AnalysisOutputError(
          OPERATION,
          `Recovery produced a symlink or special file: ${relativePath}`,
        );
      if (info.isDirectory()) await visit(path, relativePath);
      else {
        bytes += info.size;
        if (bytes > RECOVERY_LIMITS.outputBytes)
          throw new AnalysisOutputError(
            OPERATION,
            "Recovery staging exceeds the 128 MiB resource limit",
          );
        files.push({ relativePath, path, bytes: info.size });
      }
    }
  };
  await visit(root, "");
  return files;
};

/** Preserve actionable caller constraints in the ordinary error algebra. */
export const recoveryInputFailure = (
  field: string,
  message: string,
  cause?: unknown,
): AnalysisInputError =>
  new AnalysisInputError(OPERATION, { cause }, [
    { path: [field], reason: "invalid_value", message },
  ]);

/** Convert one caught boundary cause into diagnostic text without masking its type. */
export const recoveryFailureMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** Cancellation remains distinct from malformed source or provider output. */
export const checkRecoveryCancellation = (signal?: AbortSignal): void => {
  if (signal?.aborted === true) throw new AnalysisCancelledError(OPERATION);
};

/** Keep both tool invocations within one operation's execution budget. */
export const checkRecoveryDeadline = (
  deadline: number,
  signal?: AbortSignal,
): void => {
  checkRecoveryCancellation(signal);
  if (performance.now() >= deadline)
    throw new AnalysisTimeoutError(OPERATION, RECOVERY_LIMITS.timeoutMs);
};
