import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gzipSync, zstdCompressSync } from "node:zlib";

/**
 * Hand-assembled container images. No image builder (Docker, podman, skopeo)
 * is installed on this host, so layers are ustar tars written here and the
 * layouts follow the OCI image-spec and Docker save formats. Tests recheck the
 * digests with the host's own sha256 and `tar`.
 */

export interface TarEntry {
  readonly name: string;
  readonly type?: "file" | "dir" | "symlink" | "hardlink" | "char" | "fifo";
  readonly data?: string | Buffer;
  readonly link?: string;
  readonly mode?: number;
  readonly uid?: number;
  readonly gid?: number;
  readonly mtime?: number;
  /** pax records written in an extended header before this entry. */
  readonly pax?: Record<string, string>;
  /** Write a size in the header without any data (a hard link with a stale size field). */
  readonly sizeField?: number;
  /** Store the name in a GNU long-name record, whatever its length. */
  readonly gnuLongName?: boolean;
}

const TYPEFLAG: Record<NonNullable<TarEntry["type"]>, string> = {
  file: "0",
  dir: "5",
  symlink: "2",
  hardlink: "1",
  char: "3",
  fifo: "6",
};

const field = (
  header: Buffer,
  offset: number,
  length: number,
  value: string,
) => {
  header.write(value.slice(0, length), offset, "utf8");
};

const octal = (value: number, length: number): string =>
  value.toString(8).padStart(length - 1, "0");

/** One header block of a metadata record (`x` pax or `L` GNU long name). */
const record = (typeflag: string, name: string, data: Buffer): Buffer[] => {
  const block = Buffer.alloc(512);
  field(block, 0, 100, name);
  field(block, 100, 8, octal(0o644, 8));
  field(block, 124, 12, octal(data.length, 12));
  block.fill(0x20, 148, 156);
  field(block, 156, 1, typeflag);
  field(block, 257, 6, "ustar\0");
  field(block, 263, 2, "00");
  const sum = block.reduce((total, byte) => total + byte, 0);
  field(block, 148, 8, `${octal(sum, 7)}\0`);
  block[155] = 0x20;
  return [block, data, Buffer.alloc((512 - (data.length % 512)) % 512)];
};

const paxData = (records: Record<string, string>): Buffer =>
  Buffer.concat(
    Object.entries(records).map(([key, value]) => {
      const body = `${key}=${value}\n`;
      let length = Buffer.byteLength(body) + 3;
      while (String(length).length + 1 + Buffer.byteLength(body) !== length)
        length = String(length).length + 1 + Buffer.byteLength(body);
      return Buffer.from(`${String(length)} ${body}`);
    }),
  );

const header = (entry: TarEntry, size: number): Buffer => {
  const block = Buffer.alloc(512);
  const type = entry.type ?? "file";
  let name = entry.name;
  let prefix = "";
  if (entry.gnuLongName === true) name = name.slice(0, 99);
  else if (Buffer.byteLength(name) > 100) {
    const slash = name.lastIndexOf("/", 155 + 1);
    prefix = name.slice(0, slash);
    name = name.slice(slash + 1);
  }
  field(block, 0, 100, name);
  field(
    block,
    100,
    8,
    octal(entry.mode ?? (type === "dir" ? 0o755 : 0o644), 8),
  );
  field(block, 108, 8, octal(entry.uid ?? 0, 8));
  field(block, 116, 8, octal(entry.gid ?? 0, 8));
  field(block, 124, 12, octal(size, 12));
  field(block, 136, 12, octal(entry.mtime ?? 1_700_000_000, 12));
  block.fill(0x20, 148, 156);
  field(block, 156, 1, TYPEFLAG[type]);
  field(block, 157, 100, entry.link ?? "");
  field(block, 257, 6, "ustar\0");
  field(block, 263, 2, "00");
  field(block, 345, 155, prefix);
  const sum = block.reduce((total, byte) => total + byte, 0);
  field(block, 148, 8, `${octal(sum, 7)}\0`);
  block[155] = 0x20;
  return block;
};

/** A ustar archive of the entries, in order, with the two-zero-block end marker. */
export const tarBytes = (entries: readonly TarEntry[]): Buffer => {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const data =
      entry.data === undefined
        ? Buffer.alloc(0)
        : Buffer.isBuffer(entry.data)
          ? entry.data
          : Buffer.from(entry.data);
    const size = (entry.type ?? "file") === "file" ? data.length : 0;
    if (entry.pax !== undefined)
      parts.push(...record("x", "PaxHeaders/entry", paxData(entry.pax)));
    if (entry.gnuLongName === true)
      parts.push(
        ...record(
          "L",
          "././@LongLink",
          Buffer.concat([Buffer.from(entry.name), Buffer.alloc(1)]),
        ),
      );
    parts.push(header(entry, entry.sizeField ?? size));
    if (size > 0) {
      parts.push(data, Buffer.alloc((512 - (size % 512)) % 512));
    }
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
};

export const sha256Of = (bytes: Buffer | string): string =>
  createHash("sha256").update(bytes).digest("hex");

export type LayerCompression = "none" | "gzip" | "zstd";

export interface LayerSpec {
  readonly entries: readonly TarEntry[];
  readonly compression?: LayerCompression;
  /** Overrides the descriptor media type (for foreign layers). */
  readonly mediaType?: string;
  /** Describe the layer by URL only; its blob is not written. */
  readonly foreign?: string;
}

export interface ImageSpec {
  readonly layers: readonly LayerSpec[];
  readonly platform?: {
    readonly os: string;
    readonly architecture: string;
    readonly variant?: string;
  };
  readonly tag?: string;
  readonly config?: Record<string, unknown>;
  readonly history?: readonly Record<string, unknown>[];
  /** Write a wrong diff id into the configuration for these layer indexes. */
  readonly wrongDiffIds?: readonly number[];
}

const MEDIA = {
  manifest: "application/vnd.oci.image.manifest.v1+json",
  index: "application/vnd.oci.image.index.v1+json",
  config: "application/vnd.oci.image.config.v1+json",
  layer: {
    none: "application/vnd.oci.image.layer.v1.tar",
    gzip: "application/vnd.oci.image.layer.v1.tar+gzip",
    zstd: "application/vnd.oci.image.layer.v1.tar+zstd",
  },
} as const;

export interface BuiltImage {
  readonly manifestDigest: string;
  readonly configDigest: string;
  readonly layerDigests: readonly string[];
  readonly diffIds: readonly string[];
  readonly layerBlobs: readonly Buffer[];
  readonly layerTars: readonly Buffer[];
  readonly manifestDescriptor: Record<string, unknown>;
  /** Blobs to write, keyed by `blobs/sha256/<hex>`. */
  readonly blobs: ReadonlyMap<string, Buffer>;
}

const blobPath = (digest: string): string => `blobs/sha256/${digest}`;

/** Build one image's blobs: layers, configuration and manifest. */
export const buildImage = (spec: ImageSpec): BuiltImage => {
  const blobs = new Map<string, Buffer>();
  const layerTars: Buffer[] = [];
  const layerBlobs: Buffer[] = [];
  const layerDescriptors: Record<string, unknown>[] = [];
  const diffIds: string[] = [];
  for (const layer of spec.layers) {
    const raw = tarBytes(layer.entries);
    const compression = layer.compression ?? "gzip";
    const blob =
      compression === "gzip"
        ? gzipSync(raw)
        : compression === "zstd"
          ? zstdCompressSync(raw)
          : raw;
    const digest = sha256Of(blob);
    layerTars.push(raw);
    layerBlobs.push(blob);
    diffIds.push(`sha256:${sha256Of(raw)}`);
    if (layer.foreign === undefined) blobs.set(blobPath(digest), blob);
    layerDescriptors.push({
      mediaType: layer.mediaType ?? MEDIA.layer[compression],
      digest: `sha256:${digest}`,
      size: blob.length,
      ...(layer.foreign === undefined ? {} : { urls: [layer.foreign] }),
    });
  }
  const platform = spec.platform ?? { os: "linux", architecture: "amd64" };
  const config = {
    created: "2026-10-01T00:00:00Z",
    author: "fixture",
    ...platform,
    config: {
      User: "app",
      Env: ["PATH=/usr/local/bin:/usr/bin", "MODE=test"],
      Entrypoint: ["/bin/app"],
      Cmd: ["--serve"],
      WorkingDir: "/srv",
      ExposedPorts: { "8080/tcp": {} },
      Labels: { "org.example.role": "fixture" },
      ...spec.config,
    },
    rootfs: {
      type: "layers",
      diff_ids: diffIds.map((id, index) =>
        spec.wrongDiffIds?.includes(index) === true
          ? `sha256:${"0".repeat(64)}`
          : id,
      ),
    },
    history:
      spec.history ??
      spec.layers.map((_, index) => ({
        created: "2026-10-01T00:00:00Z",
        created_by: `RUN step ${String(index)}`,
      })),
  };
  const configBytes = Buffer.from(JSON.stringify(config));
  const configDigest = sha256Of(configBytes);
  blobs.set(blobPath(configDigest), configBytes);
  const manifestBytes = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: MEDIA.manifest,
      config: {
        mediaType: MEDIA.config,
        digest: `sha256:${configDigest}`,
        size: configBytes.length,
      },
      layers: layerDescriptors,
    }),
  );
  const manifestDigest = sha256Of(manifestBytes);
  blobs.set(blobPath(manifestDigest), manifestBytes);
  return {
    manifestDigest: `sha256:${manifestDigest}`,
    configDigest: `sha256:${configDigest}`,
    layerDigests: layerDescriptors.map((layer) => String(layer.digest)),
    diffIds,
    layerBlobs,
    layerTars,
    manifestDescriptor: {
      mediaType: MEDIA.manifest,
      digest: `sha256:${manifestDigest}`,
      size: manifestBytes.length,
      ...(spec.tag === undefined
        ? {}
        : { annotations: { "org.opencontainers.image.ref.name": spec.tag } }),
      platform,
    },
    blobs,
  };
};

/** Files of an OCI image layout holding the images behind one index. */
export const ociLayoutFiles = (
  images: readonly BuiltImage[],
): Map<string, Buffer> => {
  const files = new Map<string, Buffer>();
  files.set("oci-layout", Buffer.from('{"imageLayoutVersion":"1.0.0"}'));
  for (const image of images)
    for (const [path, bytes] of image.blobs) files.set(path, bytes);
  files.set(
    "index.json",
    Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: MEDIA.index,
        manifests: images.map((image) => image.manifestDescriptor),
      }),
    ),
  );
  return files;
};

/** Files of a legacy Docker save archive for one image (layer.tar per layer id). */
export const dockerSaveFiles = (
  spec: ImageSpec,
  repoTag = "fixture:latest",
): Map<string, Buffer> => {
  const image = buildImage({
    ...spec,
    layers: spec.layers.map((layer) => ({ ...layer, compression: "none" })),
  });
  const config = [...image.blobs].find(
    ([path]) => path === blobPath(image.configDigest.slice("sha256:".length)),
  )?.[1] as Buffer;
  const files = new Map<string, Buffer>();
  const hex = image.configDigest.slice("sha256:".length);
  files.set(`${hex}.json`, config);
  const layerPaths = image.layerTars.map((tar, index) => {
    const id = sha256Of(`${hex}:${String(index)}`);
    files.set(`${id}/layer.tar`, tar);
    files.set(`${id}/VERSION`, Buffer.from("1.0"));
    return `${id}/layer.tar`;
  });
  files.set(
    "manifest.json",
    Buffer.from(
      JSON.stringify([
        { Config: `${hex}.json`, RepoTags: [repoTag], Layers: layerPaths },
      ]),
    ),
  );
  return files;
};

/** An archive holding the files, as `docker save` or `skopeo copy oci-archive:` writes them. */
export const archiveOf = (files: ReadonlyMap<string, Buffer>): Buffer =>
  tarBytes([...files].map(([name, data]) => ({ name, data })));

/** Write an OCI image layout directory. */
export const writeLayout = async (
  root: string,
  files: ReadonlyMap<string, Buffer>,
): Promise<void> => {
  for (const [path, bytes] of files) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
};
