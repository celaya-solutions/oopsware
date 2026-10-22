import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import { AnalysisError } from "../domain/analysisErrorBase.js";
import type { ArtifactCommand } from "../domain/artifactGraph.js";
import type { ContainerImageFormat } from "../domain/archiveStreamFormat.js";
import {
  MAX_IMAGE_FILE_BYTES,
  type ImageDiagnostic,
  type ImageFile,
} from "../domain/containerImage/containerImage.js";
import {
  BlobUnavailable,
  type BlobStore,
} from "../containerImage/blobStore.js";
import { loadSelection } from "../containerImage/imageLoad.js";
import type { Candidate } from "../containerImage/imageModel.js";
import { composeLayers } from "../containerImage/layerCompose.js";
import type { LayerView } from "../containerImage/layerView.js";
import {
  decodedChunks,
  detectCompression,
  type TarData,
} from "../containerImage/layerWalk.js";
import { PayloadDecodeFailure } from "../linuxPackage/decode.js";
import {
  ArtifactReaderFailure,
  copyArtifactEntry,
  type ArtifactEntry,
  type ArtifactReader,
} from "./ArtifactReader.js";
import { ByteSource } from "./archives/ByteSource.js";
import {
  DEFAULT_ARCHIVE_READ_POLICY,
  type ArchiveReadPolicy,
} from "./archives/StreamArchiveArtifactReader.js";

const SPECIAL_TYPES: Readonly<Record<string, string>> = {
  "char-device": "a character device",
  "block-device": "a block device",
  fifo: "a FIFO",
  unknown: "an entry of unknown type",
};

interface Member {
  readonly path: string;
  readonly tar: TarData;
}

/** A live decode of one layer, positioned between members. */
interface Cursor {
  readonly layer: number;
  readonly source: ByteSource;
  position: number;
}

const abortIfNeeded = (signal?: AbortSignal): void => {
  if (signal?.aborted === true)
    throw new ArtifactReaderFailure(
      "cancelled",
      "Container image read was cancelled",
    );
};

/** Typed graph failure for whatever the image reader threw. */
const readerFailure = (cause: unknown): ArtifactReaderFailure => {
  if (cause instanceof ArtifactReaderFailure) return cause;
  if (cause instanceof PayloadDecodeFailure)
    return new ArtifactReaderFailure(
      cause.reason === "budget"
        ? "limit"
        : cause.reason === "cancelled"
          ? "cancelled"
          : "format",
      cause.message,
      {
        cause,
        ...(cause.reason === "budget" ? { boundary: "memory" as const } : {}),
      },
    );
  if (cause instanceof BlobUnavailable)
    return new ArtifactReaderFailure("format", cause.message, { cause });
  return new ArtifactReaderFailure(
    cause instanceof AnalysisError &&
      cause._tag === "AnalysisUnsupportedTargetError"
      ? "format"
      : "io",
    cause instanceof Error ? cause.message : String(cause),
    { cause },
  );
};

/**
 * Reader over the composed filesystem of one container image: an OCI layout
 * directory, an OCI archive or a Docker save archive holding a single image.
 * Layers are applied in order in a virtual view (whiteouts, opaque directories
 * and replacements), so members are the files a container would see, not the
 * blobs that carry them. Nothing is pulled, started or mounted. Owners, special
 * mode bits and devices are never applied. Layers that are missing, foreign or
 * do not match their digests are omissions, so extraction refuses.
 */
export class ContainerImageArtifactReader implements ArtifactReader {
  readonly format: ContainerImageFormat;
  readonly #path: string;
  readonly #policy: ArchiveReadPolicy;
  readonly #members = new Map<string, Member>();
  readonly #observations: string[] = [];
  readonly #omissions: string[] = [];
  /** SHA-256 of each layer blob as read for the listing; a later read must match. */
  readonly #layerSha256s = new Map<number, string>();
  #store: BlobStore | undefined;
  #chosen: Candidate | undefined;
  #cursor: Cursor | undefined;
  /** Opens run one at a time: a layer is decoded by a single forward cursor. */
  #tail: Promise<void> = Promise.resolve();

  constructor(
    path: string,
    format: ContainerImageFormat,
    policy: ArchiveReadPolicy = DEFAULT_ARCHIVE_READ_POLICY,
  ) {
    this.#path = path;
    this.format = format;
    this.#policy = policy;
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
    const sources = new WeakMap<ImageFile, TarData>();
    const diagnostics: ImageDiagnostic[] = [];
    let view: LayerView;
    try {
      const loaded = await loadSelection(
        {
          path: this.#path,
          platform: undefined,
          manifest: undefined,
          max_file_bytes: MAX_IMAGE_FILE_BYTES,
        },
        signal,
      );
      for (const diagnostic of loaded.diagnostics) diagnostics.push(diagnostic);
      if (loaded.chosen === null)
        throw new ArtifactReaderFailure(
          "unavailable",
          `${loaded.selection.reason ?? "No image was selected."} Use inspect_container_image with platform or manifest to choose one; the graph lists single-image archives.`,
        );
      this.#store = loaded.opened.store;
      this.#chosen = loaded.chosen;
      const composition = await composeLayers({
        store: loaded.opened.store,
        chosen: loaded.chosen,
        config: loaded.config,
        keepLayer: undefined,
        budget: {
          remaining: this.#policy.maximumDecodedBytes,
          limit: this.#policy.maximumDecodedBytes,
        },
        maxFileBytes: MAX_IMAGE_FILE_BYTES,
        signal,
        diagnostics,
        sources,
        blobSha256s: this.#layerSha256s,
      });
      view = composition.view;
      this.#observations.push(
        `${this.format} image ${loaded.chosen.id}${
          loaded.config?.os === null || loaded.config?.os === undefined
            ? ""
            : ` (${loaded.config.os}/${loaded.config.architecture ?? "?"})`
        }: ${String(composition.layers.length)} layers applied in order to a virtual filesystem; whiteouts, opaque directories and replacements are resolved. Nothing was pulled, started or mounted.`,
      );
      this.#omissions.push(...composition.problems);
    } catch (cause) {
      throw readerFailure(cause);
    }
    for (const entry of this.#listed(view, sources)) {
      abortIfNeeded(signal);
      yield copyArtifactEntry(entry);
    }
  }

  /** Directories first (parents before children), then bytes in layer order so each layer is decoded once. */
  #listed(
    view: LayerView,
    sources: WeakMap<ImageFile, TarData>,
  ): ArtifactEntry[] {
    const directories: ArtifactEntry[] = [];
    const others: {
      readonly key: [number, number];
      readonly entry: ArtifactEntry;
    }[] = [];
    let next = 0;
    const underSymlink = (path: string): boolean => {
      for (
        let slash = path.indexOf("/");
        slash > 0;
        slash = path.indexOf("/", slash + 1)
      )
        if (view.get(path.slice(0, slash))?.type === "symlink") return true;
      return false;
    };
    for (const file of view.entries()) {
      const special = SPECIAL_TYPES[file.type];
      if (special !== undefined) {
        this.#omissions.push(
          `${JSON.stringify(file.path)} is ${special}; it was not listed or materialized.`,
        );
        continue;
      }
      if (underSymlink(file.path)) {
        this.#omissions.push(
          `${JSON.stringify(file.path)} is below a symbolic link; it was not listed or materialized.`,
        );
        continue;
      }
      const limitations: string[] = [];
      const mode = file.mode === null ? 0 : Number.parseInt(file.mode, 8);
      if (file.type === "symlink")
        limitations.push(
          `Container image symbolic link to ${JSON.stringify(file.link_target ?? "")}; the target was not followed or materialized.`,
        );
      if (file.type === "directory" && file.implicit)
        limitations.push("Created for a parent directory no layer listed.");
      if ((mode & 0o6000) !== 0)
        limitations.push(
          `The image declares mode ${file.mode ?? ""}; only the bytes are materialized, never the mode or owner.`,
        );
      if (file.type === "hardlink")
        limitations.push(
          `Hard link to ${JSON.stringify(file.link_target ?? "")}; materialized as its own copy.`,
        );
      const kind =
        file.type === "directory"
          ? "directory"
          : file.type === "symlink"
            ? "symlink"
            : "file";
      const tar = sources.get(file);
      if (kind === "file" && tar === undefined) {
        this.#omissions.push(
          `${JSON.stringify(file.path)} has no layer data to read; it was not listed.`,
        );
        continue;
      }
      const key = String(next++);
      const entry: ArtifactEntry = {
        path: file.path,
        kind,
        declaredSize: kind === "file" ? (tar?.size ?? 0) : null,
        compressedSize: null,
        executable: kind === "file" && (mode & 0o111) !== 0,
        encrypted: false,
        byteOffset: null,
        declaredIntegrity: null,
        unpacked: false,
        limitations,
        adapterKey: key,
      };
      if (kind === "file" && tar !== undefined) {
        this.#members.set(key, { path: file.path, tar });
        others.push({ key: [tar.layer, tar.dataOffset], entry });
      } else if (kind === "directory") directories.push(entry);
      else others.push({ key: [Number.MAX_SAFE_INTEGER, 0], entry });
    }
    others.sort(
      (left, right) => left.key[0] - right.key[0] || left.key[1] - right.key[1],
    );
    return [...directories, ...others.map((item) => item.entry)];
  }

  open(entry: ArtifactEntry, signal?: AbortSignal): Promise<Readable> {
    const member = this.#members.get(entry.adapterKey);
    if (member === undefined || member.path !== entry.path)
      return Promise.reject(
        new ArtifactReaderFailure(
          "integrity",
          `Image member is not one this reader listed: ${entry.path}`,
        ),
      );
    const previous = this.#tail;
    let release: () => void = () => undefined;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stream = Readable.from(this.#read(member, entry, previous, signal), {
      objectMode: false,
    });
    // An abandoned stream must not block the next open.
    stream.once("close", release);
    return Promise.resolve(stream);
  }

  async *#read(
    member: Member,
    entry: ArtifactEntry,
    previous: Promise<void>,
    signal?: AbortSignal,
  ): AsyncGenerator<Buffer> {
    await previous;
    abortIfNeeded(signal);
    const { tar } = member;
    try {
      const cursor = await this.#position(tar, signal);
      let remaining = tar.size;
      for await (const piece of cursor.source.take(remaining)) {
        abortIfNeeded(signal);
        remaining -= piece.length;
        cursor.position += piece.length;
        yield piece;
      }
      if (remaining > 0)
        throw new ArtifactReaderFailure(
          "integrity",
          `${entry.path} ended ${String(remaining)} bytes short of its declared ${String(tar.size)}`,
        );
    } catch (cause) {
      // A failed or abandoned read leaves the cursor somewhere unknown.
      await this.#drop();
      throw readerFailure(cause);
    }
  }

  /** A cursor on the member's layer, at the member's first byte. */
  async #position(tar: TarData, signal?: AbortSignal): Promise<Cursor> {
    const current = this.#cursor;
    if (
      current !== undefined &&
      current.layer === tar.layer &&
      current.position <= tar.dataOffset
    ) {
      await current.source.skip(tar.dataOffset - current.position);
      current.position = tar.dataOffset;
      return current;
    }
    await this.#drop();
    const store = this.#store;
    const ref = this.#chosen?.layers?.[tar.layer];
    if (store === undefined || ref?.path === undefined || ref.path === null)
      throw new ArtifactReaderFailure(
        "integrity",
        `Layer ${String(tar.layer)} is not available to read`,
      );
    const blob = await store.read(ref.path, MAX_IMAGE_FILE_BYTES, signal);
    // The listing vouched for these exact bytes; a layer swapped since is not read.
    if (
      this.#layerSha256s.get(tar.layer) !==
      createHash("sha256").update(blob).digest("hex")
    )
      throw new ArtifactReaderFailure(
        "integrity",
        `Layer ${String(tar.layer)} changed after it was listed`,
      );
    const compression = detectCompression(blob);
    if (compression === "unknown")
      throw new ArtifactReaderFailure(
        "format",
        `Layer ${String(tar.layer)} is not tar, gzip or zstd data`,
      );
    const source = new ByteSource(
      decodedChunks(blob, compression, {
        budget: {
          remaining: this.#policy.maximumDecodedBytes,
          limit: this.#policy.maximumDecodedBytes,
        },
        signal,
      }),
    );
    await source.skip(tar.dataOffset);
    this.#cursor = { layer: tar.layer, source, position: tar.dataOffset };
    return this.#cursor;
  }

  async #drop(): Promise<void> {
    const cursor = this.#cursor;
    this.#cursor = undefined;
    await cursor?.source.return().catch(() => undefined);
  }

  async close(): Promise<void> {
    await this.#drop();
    this.#members.clear();
    this.#store = undefined;
  }
}
