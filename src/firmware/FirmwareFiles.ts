import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, lstat, opendir, readlink, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import type { FirmwareRequest } from "../domain/firmware/firmwareAnalysis.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import { readBoundedFileBytes } from "../process/BoundedFileBytes.js";
import { FIRMWARE_LIMITS } from "./FirmwareRelease.js";
import { compareUnicodeCodePoints } from "../domain/unicodeCodePointOrder.js";
import type { SafeOutputTree } from "../artifacts/SafeOutputTree.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import {
  withArtifactRegularFile,
  assertArtifactReadActive,
  mapArtifactFileFailure,
} from "../artifacts/ArtifactFileOperation.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { readArtifactFileChunks } from "../artifacts/readArtifactFileChunks.js";
import { NonRegularFileReadError } from "../filesystem/RegularFile.js";

/** One regular file or unpublished filesystem entry in a private extraction. */
export interface FirmwareEntry {
  readonly relativePath: string;
  readonly path: string;
  readonly size: number;
  readonly kind: "file" | "symlink" | "special";
  readonly linkTarget: string | null;
}

const throwIfFirmwareInventoryCancelled = (
  signal: AbortSignal | undefined,
  operation: string,
): void => {
  if (signal?.aborted === true)
    throw new AnalysisCancelledError(operation, { cause: signal.reason });
};

/** Own all firmware reads, including rejected admission and final descriptor cleanup. */
export class FirmwareFileAccess {
  readonly #resources = new ArtifactResourceScope();

  /** Retry retained descriptors without closing admission for future operations. */
  retryCleanup(): Promise<void> {
    return this.#resources.retryCleanup();
  }

  /** Wait for admitted operations and retry every retained descriptor. */
  close(): Promise<void> {
    return this.#resources.close();
  }

  /** Hash one admitted regular file without retaining its bytes in memory. */
  hash(path: string, signal?: AbortSignal): Promise<string> {
    return this.#resources.run(() => this.#hash(path, signal));
  }

  async #hash(path: string, signal?: AbortSignal): Promise<string> {
    return withArtifactRegularFile(
      path,
      this.#resources,
      signal,
      async (handle) => {
        const hash = createHash("sha256");
        for await (const chunk of readArtifactFileChunks(handle, { signal })) {
          assertArtifactReadActive(signal);
          hash.update(chunk);
        }
        assertArtifactReadActive(signal);
        return hash.digest("hex");
      },
    );
  }

  /** Copy and identify the exact bytes consumed by firmware providers. */
  snapshot(request: FirmwareRequest, root: string, signal: AbortSignal) {
    return this.#resources.run(() => this.#snapshot(request, root, signal));
  }

  async #snapshot(request: FirmwareRequest, root: string, signal: AbortSignal) {
    const sourcePath = absoluteCallerPath(request.input.path);
    const source = await realpath(sourcePath);
    const fullPath = join(root, "firmware.bin");
    const copied = await withArtifactRegularFile(
      source,
      this.#resources,
      signal,
      async (handle) => {
        const stat = await handle.stat();
        if (stat.size === 0 || stat.size > FIRMWARE_LIMITS.inputBytes)
          throw firmwareInputFailure(request.operation);
        const hash = createHash("sha256");
        let size = 0;
        const meter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            size += chunk.length;
            if (size > FIRMWARE_LIMITS.inputBytes) {
              callback(firmwareInputFailure(request.operation));
              return;
            }
            hash.update(chunk);
            callback(null, chunk);
          },
        });
        await pipeline(
          readArtifactFileChunks(handle, { signal }),
          meter,
          createWriteStream(fullPath, { flags: "wx", mode: 0o600 }),
        );
        return { size, sha256: hash.digest("hex") };
      },
    ).catch((cause: unknown) => {
      throw firmwareAdmissionFailure(cause, (primary) =>
        firmwareInputFailure(request.operation, primary),
      );
    });
    const { size, sha256 } = copied;
    await chmod(fullPath, 0o400);
    const selected =
      request.operation === "extract_firmware"
        ? request.input.range
        : undefined;
    const offset = selected?.offset ?? 0;
    const length = selected?.length ?? size;
    if (length === 0 || offset > size || length > size - offset)
      throw new AnalysisInputError(request.operation, undefined, [
        {
          path: ["range"],
          reason: "out_of_range",
          message: `Selected range must be within the ${size}-byte firmware file`,
        },
      ]);
    let inputPath = fullPath;
    if (selected !== undefined) {
      inputPath = join(root, "selected.bin");
      await withArtifactRegularFile(
        fullPath,
        this.#resources,
        signal,
        async (handle) => {
          await pipeline(
            readArtifactFileChunks(handle, {
              start: offset,
              end: offset + length - 1,
              signal,
            }),
            createWriteStream(inputPath, { flags: "wx", mode: 0o600 }),
          );
        },
      );
      await chmod(inputPath, 0o400);
    }
    return {
      subject: { path: sourcePath, sha256, format: "file" as const },
      size,
      inputPath,
      selection: {
        offset,
        length,
        sha256:
          selected === undefined ? sha256 : await this.#hash(inputPath, signal),
      },
    };
  }

  /** Own the exact source descriptor consumed by publication through its final close. */
  publish(
    entry: FirmwareEntry,
    sha256: string,
    tree: SafeOutputTree,
    signal: AbortSignal,
  ) {
    return this.#resources.run(() =>
      withArtifactRegularFile(entry.path, this.#resources, signal, (handle) =>
        tree.write(
          entry.relativePath,
          readArtifactFileChunks(handle, { signal }),
          { sha256, bytes: entry.size },
          signal,
        ),
      ),
    );
  }

  /** Read a complete bounded report; oversized data is never reported as complete. */
  async report(
    path: string,
    operation: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.#resources.run(() =>
      withArtifactRegularFile(path, this.#resources, signal, async (handle) => {
        const bytes = await readBoundedFileBytes(
          handle,
          FIRMWARE_LIMITS.reportBytes,
        );
        if (bytes === undefined)
          throw new AnalysisOutputError(
            operation,
            `Report exceeded ${FIRMWARE_LIMITS.reportBytes} bytes`,
          );
        assertArtifactReadActive(signal);
        try {
          const value: unknown = JSON.parse(
            new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
              bytes,
            ),
          );
          return value;
        } catch (cause: unknown) {
          throw new AnalysisOutputError(
            operation,
            "Tool report is not valid complete JSON",
            { cause },
          );
        }
      }).catch((cause: unknown) => {
        throw firmwareAdmissionFailure(
          cause,
          (primary) =>
            new AnalysisOutputError(operation, "Report is not a regular file", {
              cause: primary,
            }),
        );
      }),
    );
  }
}

/** Preserve admission semantics inside the same exact owner's physical outcome. */
const firmwareAdmissionFailure = (
  cause: unknown,
  classify: (cause: NonRegularFileReadError) => Error,
): unknown => {
  return mapArtifactFileFailure(cause, (primary) =>
    primary instanceof NonRegularFileReadError ? classify(primary) : primary,
  );
};

const firmwareInputFailure = (operation: string, cause?: unknown) =>
  new AnalysisInputError(operation, { cause }, [
    {
      path: ["path"],
      reason: "out_of_range",
      message: `Firmware must be a nonempty regular file no larger than ${FIRMWARE_LIMITS.inputBytes} bytes. Select a stable copy within this allowance.`,
    },
  ]);

/** Inventory private output without following links, enforcing aggregate staging budgets. */
export const inventoryFirmwareOutput = async (
  root: string,
  maxBytes: number,
  maxEntries: number,
  operation: string,
  signal?: AbortSignal,
): Promise<FirmwareEntry[]> => {
  const entries: FirmwareEntry[] = [];
  const pending = [root];
  let bytes = 0;
  let count = 0;
  while (pending.length > 0) {
    throwIfFirmwareInventoryCancelled(signal, operation);
    const directory = pending.pop();
    if (directory === undefined) break;
    const directoryStat = await lstat(directory).catch((cause: unknown) => {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
        return undefined;
      throw cause;
    });
    if (
      directoryStat === undefined ||
      !directoryStat.isDirectory() ||
      directoryStat.isSymbolicLink()
    )
      continue;
    const handle = await opendir(directory).catch((cause: unknown) => {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
        return undefined;
      throw cause;
    });
    if (handle === undefined) continue;
    const names: string[] = [];
    for await (const entry of handle) {
      throwIfFirmwareInventoryCancelled(signal, operation);
      count++;
      if (count > maxEntries)
        throw new AnalysisOutputError(
          operation,
          `Staging entry budget exceeded (${maxEntries})`,
        );
      names.push(entry.name);
    }
    for (const name of names.sort()) {
      const path = join(directory, name);
      const stat = await lstat(path).catch((cause: unknown) => {
        if (
          cause instanceof Error &&
          "code" in cause &&
          cause.code === "ENOENT"
        )
          return undefined;
        throw cause;
      });
      if (stat === undefined) continue;
      if (stat.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (stat.isFile()) bytes += stat.size;
      if (bytes > maxBytes)
        throw new AnalysisOutputError(
          operation,
          `Staging byte budget exceeded (${maxBytes})`,
        );
      entries.push({
        path,
        relativePath: relative(root, path).split(sep).join("/"),
        size: stat.size,
        kind: stat.isSymbolicLink()
          ? "symlink"
          : stat.isFile()
            ? "file"
            : "special",
        linkTarget: stat.isSymbolicLink() ? await readlink(path) : null,
      });
    }
  }
  return entries.sort((a, b) =>
    compareUnicodeCodePoints(a.relativePath, b.relativePath),
  );
};

/** Bind producer paths to the selected input or private extraction tree. */
export const firmwareLogicalPath = (
  path: string,
  inputPath: string,
  outputRoot: string,
): string => {
  if (path === inputPath) return "$input";
  const rel = relative(outputRoot, path);
  if (
    !isAbsolute(path) ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  )
    throw new AnalysisOutputError(
      "extract_firmware",
      `Provider reported a path outside its owned output: ${path}`,
    );
  return rel === "" ? "$output" : `$output/${rel.split(sep).join("/")}`;
};
