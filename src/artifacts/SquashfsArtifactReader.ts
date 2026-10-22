import type { FileHandle } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";

import type { ArtifactCommand } from "../domain/artifactGraph.js";
import type { RandomAccessContainerFormat } from "../domain/archiveStreamFormat.js";
import {
  NonRegularFileReadError,
  openRegularFile,
  sameRegularFileState,
} from "../filesystem/RegularFile.js";
import { readAppImageRuntime } from "../linuxPackage/appimage.js";
import {
  SquashfsFormatError,
  SquashfsImage,
  SquashfsUnsupportedError,
  type SquashfsEntry,
} from "../linuxPackage/squashfs/squashfs.js";
import {
  ArtifactReaderFailure,
  copyArtifactEntry,
  type ArtifactEntry,
  type ArtifactReader,
} from "./ArtifactReader.js";

const SPECIAL_TYPES: Readonly<Record<string, string>> = {
  "block-device": "a block device",
  "char-device": "a character device",
  fifo: "a FIFO",
  socket: "a socket",
};

const positional =
  (handle: FileHandle, base: number) =>
  async (offset: number, length: number): Promise<Uint8Array> => {
    const buffer = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await handle.read(
        buffer,
        filled,
        length - filled,
        base + offset + filled,
      );
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return buffer.subarray(0, filled);
  };

const abortIfNeeded = (signal?: AbortSignal): void => {
  if (signal?.aborted === true)
    throw new ArtifactReaderFailure(
      "cancelled",
      "Filesystem image read was cancelled",
    );
};

/**
 * Random-access reader for SquashFS images and the Type 2 AppImages that
 * carry one after their runtime. The image is decoded in process; the
 * runtime is never executed, mounted or asked to extract itself. Devices,
 * FIFOs and sockets are omissions; owners and special mode bits are stated,
 * never applied.
 */
export class SquashfsArtifactReader implements ArtifactReader {
  readonly format: Exclude<RandomAccessContainerFormat, "msi">;
  readonly #path: string;
  #handle: FileHandle | undefined;
  #image: SquashfsImage | undefined;
  readonly #entries = new Map<string, SquashfsEntry>();
  readonly #observations: string[] = [];
  readonly #omissions: string[] = [];

  constructor(
    path: string,
    format: Exclude<RandomAccessContainerFormat, "msi">,
  ) {
    this.#path = path;
    this.format = format;
  }

  observations(): readonly string[] {
    return [...this.#observations];
  }

  omissions(): readonly string[] {
    return [...this.#omissions];
  }

  provenance(): readonly ArtifactCommand[] {
    return [];
  }

  async *entries(signal?: AbortSignal): AsyncIterable<ArtifactEntry> {
    abortIfNeeded(signal);
    let handle: FileHandle;
    try {
      handle = await openRegularFile(this.#path, {
        symlinks: "reject",
        signal,
      });
    } catch (cause: unknown) {
      if (cause instanceof NonRegularFileReadError)
        throw new ArtifactReaderFailure(
          "format",
          `Image source is not a regular file: ${this.#path}`,
          { cause },
        );
      throw cause;
    }
    this.#handle = handle;
    const initial = await handle.stat();
    let base = 0;
    if (this.format === "appimage") {
      const runtime = await readAppImageRuntime(
        positional(handle, 0),
        initial.size,
      ).catch((cause: unknown) => {
        throw new ArtifactReaderFailure(
          "format",
          `AppImage runtime is malformed: ${cause instanceof Error ? cause.message : String(cause)}`,
          { cause },
        );
      });
      if (runtime.type === 1) {
        this.#omissions.push(
          "A Type 1 AppImage (ISO 9660 payload) is identified only; its files are not listed.",
        );
        return;
      }
      base = runtime.payload_offset;
      this.#observations.push(
        `AppImage Type 2 runtime: ${runtime.elf.class}-bit ${runtime.elf.machine} ELF of ${String(base)} bytes; the SquashFS image starts at byte ${String(base)} (end of the section header table). The runtime was not executed.`,
        ...runtime.problems,
      );
    }
    let image: SquashfsImage;
    try {
      image = await SquashfsImage.open(
        positional(handle, base),
        initial.size - base,
      );
    } catch (cause: unknown) {
      if (cause instanceof SquashfsUnsupportedError) {
        this.#omissions.push(
          `The SquashFS image is identified but not read: ${cause.message}`,
        );
        return;
      }
      if (cause instanceof SquashfsFormatError)
        throw new ArtifactReaderFailure(
          "format",
          `SquashFS image is malformed at byte ${String(base + cause.offset)}: ${cause.message}`,
          { cause },
        );
      throw cause;
    }
    this.#image = image;
    const superblock = image.superblock;
    this.#observations.push(
      `SquashFS ${superblock.version} image, ${superblock.compression} compression, ${String(superblock.block_size)}-byte blocks, ${String(superblock.inode_count)} inodes, read in process.`,
    );
    let ordinal = 0;
    for await (const entry of image.entries(signal)) {
      abortIfNeeded(signal);
      ordinal += 1;
      const special = SPECIAL_TYPES[entry.type];
      if (special !== undefined) {
        this.#omissions.push(
          `${JSON.stringify(entry.path)} is ${special}; it was not listed or materialized.`,
        );
        continue;
      }
      const kind =
        entry.type === "file"
          ? "file"
          : entry.type === "directory"
            ? "directory"
            : "symlink";
      const limitations: string[] = [];
      if (kind === "symlink")
        limitations.push(
          `SquashFS symbolic link to ${JSON.stringify(entry.link_target ?? "")}; the target was not followed or materialized.`,
        );
      if (kind === "file" && (entry.mode & 0o6000) !== 0)
        limitations.push(
          `The image declares mode ${(entry.mode & 0o7777).toString(8).padStart(4, "0")} (${(entry.mode & 0o4000) !== 0 ? "setuid" : "setgid"}); only the bytes are materialized, never the mode or owner.`,
        );
      if (kind === "file" && entry.hard_links > 1)
        limitations.push(
          `Hard link of inode ${String(entry.inode_number)}; materialized as its own copy.`,
        );
      const metadata: ArtifactEntry = {
        path: entry.path,
        kind,
        declaredSize: kind === "file" ? entry.size : null,
        compressedSize: null,
        executable: kind === "file" && (entry.mode & 0o111) !== 0,
        encrypted: false,
        byteOffset: null,
        declaredIntegrity: null,
        unpacked: false,
        limitations,
        adapterKey: String(ordinal),
      };
      this.#entries.set(metadata.adapterKey, entry);
      yield copyArtifactEntry(metadata);
    }
    for (const problem of image.problems)
      this.#omissions.push(
        problem.offset === null
          ? problem.message
          : `${problem.message} (byte ${String(base + problem.offset)})`,
      );
    const [opened, current] = await Promise.all([
      handle.stat(),
      stat(this.#path),
    ]);
    if (
      !sameRegularFileState(initial, opened) ||
      !sameRegularFileState(initial, current)
    )
      throw new ArtifactReaderFailure(
        "integrity",
        `Image changed while it was read: ${this.#path}`,
      );
  }

  open(entry: ArtifactEntry, signal?: AbortSignal): Promise<Readable> {
    const stored = this.#entries.get(entry.adapterKey);
    const image = this.#image;
    if (
      stored === undefined ||
      image === undefined ||
      stored.path !== entry.path
    )
      return Promise.reject(
        new ArtifactReaderFailure(
          "integrity",
          `Image member is not one this reader listed: ${entry.path}`,
        ),
      );
    if (stored.type !== "file")
      return Promise.reject(
        new ArtifactReaderFailure(
          "format",
          `Image member is not a regular file: ${entry.path}`,
        ),
      );
    const declared = stored.size;
    // The image reader does not cap output; a member never yields more than its declared size.
    const bounded = async function* (): AsyncGenerator<Buffer> {
      let total = 0;
      for await (const piece of image.read(stored, signal)) {
        abortIfNeeded(signal);
        total += piece.length;
        if (total > declared)
          throw new ArtifactReaderFailure(
            "integrity",
            `${entry.path} yielded more than its declared ${String(declared)} bytes`,
          );
        yield Buffer.from(piece.buffer, piece.byteOffset, piece.byteLength);
      }
    };
    return Promise.resolve(Readable.from(bounded(), { objectMode: false }));
  }

  async close(): Promise<void> {
    const handle = this.#handle;
    this.#handle = undefined;
    this.#image = undefined;
    await handle?.close();
  }
}
