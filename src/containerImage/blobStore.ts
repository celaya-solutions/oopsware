import { lstat, realpath } from "node:fs/promises";
import { join, sep } from "node:path";

import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { ByteSource } from "../artifacts/archives/ByteSource.js";
import { TarStream } from "../artifacts/archives/TarStream.js";
import { readStableArtifact } from "../artifacts/readStableArtifact.js";
import type { ImageDiagnostic } from "../domain/containerImage/containerImage.js";
import { normalizeLayerPath, resolveLinkTarget } from "./layerPaths.js";

/** The files of an image layout or archive, addressed by relative POSIX path. */
export interface BlobStore {
  /** The stored size of a regular file, or null when there is none at that path. */
  size(path: string): Promise<number | null>;
  /** The file's bytes, at most `limit` of them. Throws when absent or larger. */
  read(path: string, limit: number, signal?: AbortSignal): Promise<Buffer>;
}

export class BlobUnavailable extends Error {
  constructor(
    readonly reason: "missing" | "too_large",
    message: string,
  ) {
    super(message);
    this.name = "BlobUnavailable";
  }
}

const cleanPath = (path: string): string | null => {
  const normalized = normalizeLayerPath(path);
  return normalized.kind === "path" ? normalized.path : null;
};

/**
 * A directory in OCI image layout form. A blob is a regular file whose real
 * path stays under the layout root: a link, or a linked parent directory,
 * that leads outside it is not a blob.
 */
export class DirectoryBlobStore implements BlobStore {
  #rootReal: Promise<string> | undefined;

  constructor(
    readonly root: string,
    readonly maximumBytes: number,
  ) {}

  async size(path: string): Promise<number | null> {
    const clean = cleanPath(path);
    if (clean === null) return null;
    try {
      const full = join(this.root, clean);
      const stats = await lstat(full, { bigint: true });
      if (!stats.isFile()) return null;
      this.#rootReal ??= realpath(this.root);
      const [real, rootReal] = await Promise.all([
        realpath(full),
        this.#rootReal,
      ]);
      return real.startsWith(rootReal + sep) ? Number(stats.size) : null;
    } catch {
      return null;
    }
  }

  async read(
    path: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    const clean = cleanPath(path);
    const size = clean === null ? null : await this.size(clean);
    if (clean === null || size === null)
      throw new BlobUnavailable(
        "missing",
        `${path} is not a regular file in the layout.`,
      );
    if (size > limit)
      throw new BlobUnavailable(
        "too_large",
        `${path} is ${String(size)} bytes, over the ${String(limit)}-byte limit.`,
      );
    return (await readStableArtifact(join(this.root, clean), limit, signal))
      .bytes;
  }
}

interface TarFile {
  readonly offset: number;
  readonly size: number;
}

const MAX_LINK_HOPS = 8;

/** The regular files of a tar held in memory, plus its names for classification. */
export class TarBlobStore implements BlobStore {
  private constructor(
    private readonly bytes: Buffer,
    private readonly files: ReadonlyMap<string, TarFile>,
    private readonly links: ReadonlyMap<string, string>,
    readonly diagnostics: readonly ImageDiagnostic[],
  ) {}

  /** Index every member header; file data is not read. */
  static async open(
    bytes: Buffer,
    signal?: AbortSignal,
  ): Promise<TarBlobStore> {
    const source = new ByteSource(chunksOf(bytes));
    const tar = new TarStream(source);
    const files = new Map<string, TarFile>();
    const links = new Map<string, string>();
    const diagnostics: ImageDiagnostic[] = [];
    try {
      for (;;) {
        if (signal?.aborted === true)
          throw new ArtifactReaderFailure(
            "cancelled",
            "The read was cancelled.",
          );
        const member = await tar.next();
        if (member === null) break;
        const clean = member.name === null ? null : cleanPath(member.name);
        if (clean === null) {
          if (
            member.name !== null &&
            normalizeLayerPath(member.name).kind !== "root"
          )
            diagnostics.push({
              location: member.name,
              message: "An archive member with an unsafe name was ignored.",
            });
          continue;
        }
        if (member.typeflag === "0" || member.typeflag === "7") {
          if (files.has(clean) || links.has(clean))
            diagnostics.push({
              location: clean,
              message:
                "The archive holds this path more than once; the last entry is used.",
            });
          links.delete(clean);
          files.set(clean, { offset: member.dataOffset, size: member.size });
        } else if (member.typeflag === "2" && member.linkName !== null) {
          // Docker save shares one layer.tar between images through a symlink.
          files.delete(clean);
          links.set(clean, member.linkName);
        }
      }
    } catch (cause) {
      if (
        cause instanceof ArtifactReaderFailure &&
        cause.reason === "cancelled"
      )
        throw cause;
      diagnostics.push({
        location: null,
        message: `The archive is damaged after ${String(files.size)} files: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      });
    }
    return new TarBlobStore(bytes, files, links, diagnostics);
  }

  /** Whether any member (file or link) has this exact path. */
  has(path: string): boolean {
    const clean = cleanPath(path);
    return clean !== null && (this.files.has(clean) || this.links.has(clean));
  }

  /** Paths of all regular files and links, for classification. */
  names(): ReadonlySet<string> {
    return new Set([...this.files.keys(), ...this.links.keys()]);
  }

  #resolve(path: string): TarFile | undefined {
    let current = cleanPath(path);
    for (let hop = 0; current !== null && hop <= MAX_LINK_HOPS; hop += 1) {
      const file = this.files.get(current);
      if (file !== undefined) return file;
      const target = this.links.get(current);
      if (target === undefined) return undefined;
      const resolved = resolveLinkTarget(current, target);
      // A link that leaves the archive resolves to nothing.
      current = "path" in resolved ? cleanPath(resolved.path) : null;
      if (current === null) return undefined;
    }
    return undefined;
  }

  async size(path: string): Promise<number | null> {
    return this.#resolve(path)?.size ?? null;
  }

  async read(path: string, limit: number): Promise<Buffer> {
    const file = this.#resolve(path);
    if (file === undefined)
      throw new BlobUnavailable(
        "missing",
        `${path} is not a file in the archive.`,
      );
    if (file.size > limit)
      throw new BlobUnavailable(
        "too_large",
        `${path} is ${String(file.size)} bytes, over the ${String(limit)}-byte limit.`,
      );
    return this.bytes.subarray(file.offset, file.offset + file.size);
  }
}

async function* chunksOf(bytes: Buffer): AsyncGenerator<Buffer> {
  const step = 1024 * 1024;
  for (let offset = 0; offset < bytes.length; offset += step)
    yield bytes.subarray(offset, Math.min(bytes.length, offset + step));
}
