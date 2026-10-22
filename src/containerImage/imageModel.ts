import { createHash } from "node:crypto";

import type {
  BlobCheck,
  ImageDiagnostic,
  ImagePlatform,
} from "../domain/containerImage/containerImage.js";
import { BlobUnavailable, type BlobStore } from "./blobStore.js";
import { normalizeLayerPath } from "./layerPaths.js";

/** A descriptor as an index, manifest or Docker layer map declares it. */
export interface Descriptor {
  readonly mediaType: string | null;
  readonly digest: string | null;
  readonly size: number | null;
  readonly urls: readonly string[];
  readonly platform: ImagePlatform | null;
  readonly annotations: readonly (readonly [string, string])[];
}

export interface LayerRef {
  /** Path in the layout or archive that should hold the layer, or null when it names none. */
  readonly path: string | null;
  readonly descriptor: Descriptor | null;
  /** Declared to live elsewhere (URLs or a foreign media type); never fetched. */
  readonly foreign: boolean;
}

/** One image an index or manifest list names, before its layers are read. */
export interface Candidate {
  /** Selection key: the manifest digest (OCI) or the image id (Docker). */
  readonly id: string;
  readonly kind: "image" | "attestation";
  readonly mediaType: string | null;
  readonly platform: ImagePlatform | null;
  readonly refNames: readonly string[];
  readonly annotations: readonly (readonly [string, string])[];
  /** The manifest blob (OCI) or the configuration file (Docker save). */
  readonly blob: BlobCheck;
  readonly configPath: string | null;
  readonly configDescriptor: Descriptor | null;
  /** Null when the manifest could not be read. */
  readonly layers: readonly LayerRef[] | null;
  /** Docker save: layer descriptors by diff id, when the archive carries them. */
  readonly layerSources: ReadonlyMap<string, Descriptor>;
}

export interface LoadedImage {
  readonly layoutVersion: string | null;
  readonly hasOciIndex: boolean;
  readonly indexAnnotations: readonly (readonly [string, string])[];
  readonly candidates: readonly Candidate[];
  readonly diagnostics: readonly ImageDiagnostic[];
}

/** Bytes of one JSON document (index, manifest or configuration) kept in memory. */
export const MAX_JSON_BYTES = 16 * 1024 ** 2;
const MAX_INDEX_DEPTH = 4;
/** Most images one index or manifest.json is read for. */
export const MAX_CANDIDATES = 1024;

const INDEX_TYPES: ReadonlySet<string> = new Set([
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
]);
const MANIFEST_TYPES: ReadonlySet<string> = new Set([
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
]);

type Json = Record<string, unknown>;
const record = (value: unknown): Json | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
export const text = (value: unknown): string | null =>
  typeof value === "string" ? value : null;
const whole = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
export const textList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
export const pairs = (value: unknown): [string, string][] => {
  const source = record(value);
  if (source === null) return [];
  return Object.entries(source)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
};

export const parseJson = (bytes: Uint8Array): unknown => {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    return undefined;
  }
};

const DIGEST = /^([a-z0-9]+(?:[+._-][a-z0-9]+)*):([a-zA-Z0-9=_-]{16,})$/u;

export const parseDigest = (
  digest: string | null,
): { readonly algorithm: string; readonly encoded: string } | null => {
  const match = digest === null ? null : DIGEST.exec(digest);
  return match === null
    ? null
    : { algorithm: match[1] as string, encoded: match[2] as string };
};

/** Where an OCI layout keeps the blob a descriptor names. */
export const blobPathOf = (digest: string | null): string | null => {
  const parsed = parseDigest(digest);
  return parsed === null ? null : `blobs/${parsed.algorithm}/${parsed.encoded}`;
};

const COMPUTABLE = new Set(["sha256", "sha512"]);

/** Recompute a blob's digest and size against its descriptor. */
export const checkBytes = (
  path: string | null,
  bytes: Uint8Array | null,
  digest: string | null,
  size: number | null,
): BlobCheck => {
  const parsed = parseDigest(digest);
  if (bytes === null)
    return {
      path,
      algorithm: parsed?.algorithm ?? null,
      declared: digest,
      computed: null,
      declared_size: size,
      actual_size: null,
      state: "missing",
    };
  const computable = parsed !== null && COMPUTABLE.has(parsed.algorithm);
  const computed = computable
    ? `${parsed.algorithm}:${createHash(parsed.algorithm).update(bytes).digest("hex")}`
    : null;
  const state: BlobCheck["state"] =
    computed !== null && computed !== digest
      ? "digest_mismatch"
      : size !== null && size !== bytes.length
        ? "size_mismatch"
        : computed === null
          ? "unverifiable"
          : "verified";
  return {
    path,
    algorithm: parsed?.algorithm ?? null,
    declared: digest,
    computed,
    declared_size: size,
    actual_size: bytes.length,
    state,
  };
};

const descriptor = (value: unknown): Descriptor | null => {
  const source = record(value);
  if (source === null) return null;
  const platform = record(source.platform);
  return {
    mediaType: text(source.mediaType),
    digest: text(source.digest),
    size: whole(source.size),
    urls: textList(source.urls),
    platform:
      platform === null
        ? null
        : {
            os: text(platform.os),
            architecture: text(platform.architecture),
            variant: text(platform.variant),
            os_version: text(platform["os.version"]),
          },
    annotations: pairs(source.annotations),
  };
};

export const isForeign = (value: Descriptor | null): boolean =>
  value !== null &&
  (value.urls.length > 0 || (value.mediaType ?? "").includes(".foreign."));

const annotation = (
  annotations: readonly (readonly [string, string])[],
  key: string,
): string | null => annotations.find(([name]) => name === key)?.[1] ?? null;

/** Read a JSON document through the store; absence or damage becomes a diagnostic. */
export const readJson = async (
  store: BlobStore,
  path: string,
  diagnostics: ImageDiagnostic[],
  signal?: AbortSignal,
): Promise<{ readonly value: unknown; readonly bytes: Buffer } | null> => {
  let bytes: Buffer;
  try {
    bytes = await store.read(path, MAX_JSON_BYTES, signal);
  } catch (cause) {
    if (!(cause instanceof BlobUnavailable)) throw cause;
    diagnostics.push({ location: path, message: cause.message });
    return null;
  }
  const value = parseJson(bytes);
  if (value === undefined) {
    diagnostics.push({
      location: path,
      message: "The file is not valid JSON.",
    });
    return null;
  }
  return { value, bytes };
};

/** Read a blob by descriptor and check it; the bytes are null when it is absent. */
export const readBlob = async (
  store: BlobStore,
  path: string | null,
  digest: string | null,
  size: number | null,
  limit: number,
  diagnostics: ImageDiagnostic[],
  signal?: AbortSignal,
): Promise<{ readonly bytes: Buffer | null; readonly check: BlobCheck }> => {
  let bytes: Buffer | null = null;
  if (path !== null)
    try {
      bytes = await store.read(path, limit, signal);
    } catch (cause) {
      if (!(cause instanceof BlobUnavailable)) throw cause;
      if (cause.reason === "too_large")
        diagnostics.push({ location: path, message: cause.message });
    }
  return { bytes, check: checkBytes(path, bytes, digest, size) };
};

const unreadable = (
  id: string,
  mediaType: string | null,
  blob: BlobCheck,
  extra: Partial<Candidate> = {},
): Candidate => ({
  id,
  kind: "image",
  mediaType,
  platform: null,
  refNames: [],
  annotations: [],
  blob,
  configPath: null,
  configDescriptor: null,
  layers: null,
  layerSources: new Map(),
  ...extra,
});

const ATTESTATION_KEY = "vnd.docker.reference.type";

const layerRefs = (value: unknown): LayerRef[] =>
  Array.isArray(value)
    ? value.map((item) => {
        const layer = descriptor(item);
        return {
          path: blobPathOf(layer?.digest ?? null),
          descriptor: layer,
          foreign: isForeign(layer),
        };
      })
    : [];

/** The images an OCI layout names: index.json, and any index it nests. */
export const loadOci = async (
  store: BlobStore,
  signal?: AbortSignal,
): Promise<LoadedImage> => {
  const diagnostics: ImageDiagnostic[] = [];
  const layout = await readJson(store, "oci-layout", diagnostics, signal);
  const layoutVersion = text(record(layout?.value)?.imageLayoutVersion);
  const rootIndex = await readJson(store, "index.json", diagnostics, signal);
  const root = record(rootIndex?.value);
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  let capped = false;
  const capDiagnostic: ImageDiagnostic = {
    location: "index.json",
    message: `Only the first ${String(MAX_CANDIDATES)} images the index lists were read.`,
  };

  const visit = async (
    entries: unknown,
    depth: number,
    inherited: readonly (readonly [string, string])[],
  ): Promise<void> => {
    if (!Array.isArray(entries)) return;
    for (const raw of entries) {
      if (candidates.length >= MAX_CANDIDATES) {
        if (!capped) diagnostics.push(capDiagnostic);
        capped = true;
        return;
      }
      const entry = descriptor(raw);
      if (entry === null) continue;
      const media = entry.mediaType;
      const path = blobPathOf(entry.digest);
      const names = [
        annotation(entry.annotations, "org.opencontainers.image.ref.name"),
        annotation(entry.annotations, "io.containerd.image.name"),
      ].filter((name): name is string => name !== null);
      if (media !== null && INDEX_TYPES.has(media)) {
        if (depth >= MAX_INDEX_DEPTH) {
          diagnostics.push({
            location: path,
            message: `A nested index is deeper than ${String(MAX_INDEX_DEPTH)} levels and was not followed.`,
          });
          continue;
        }
        if (path !== null && seen.has(path)) continue;
        if (path !== null) seen.add(path);
        const read = await readBlob(
          store,
          path,
          entry.digest,
          entry.size,
          MAX_JSON_BYTES,
          diagnostics,
          signal,
        );
        const nested = record(
          read.bytes === null ? null : parseJson(read.bytes),
        );
        if (nested === null) {
          candidates.push(
            unreadable(
              entry.digest ?? `index:${String(candidates.length)}`,
              media,
              read.check,
              { refNames: names },
            ),
          );
          continue;
        }
        await visit(nested.manifests, depth + 1, [
          ...inherited,
          ...entry.annotations,
        ]);
        continue;
      }
      if (media === null || !MANIFEST_TYPES.has(media)) {
        diagnostics.push({
          location: path,
          message: `Descriptor media type ${media === null ? "(none)" : JSON.stringify(media)} is not an image manifest or index and was skipped.`,
        });
        continue;
      }
      const id = entry.digest ?? `manifest:${String(candidates.length)}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const read = await readBlob(
        store,
        path,
        entry.digest,
        entry.size,
        MAX_JSON_BYTES,
        diagnostics,
        signal,
      );
      const manifest = record(
        read.bytes === null ? null : parseJson(read.bytes),
      );
      const config = descriptor(manifest?.config);
      const platform = entry.platform;
      const attestation =
        annotation(entry.annotations, ATTESTATION_KEY) ===
          "attestation-manifest" ||
        (platform?.os === "unknown" && platform.architecture === "unknown");
      candidates.push({
        ...unreadable(id, media, read.check),
        kind: attestation ? "attestation" : "image",
        platform,
        refNames: names,
        annotations: [
          ...inherited,
          ...entry.annotations,
          ...pairs(manifest?.annotations),
        ],
        configPath: blobPathOf(config?.digest ?? null),
        configDescriptor: config,
        layers: manifest === null ? null : layerRefs(manifest.layers),
      });
    }
  };

  await visit(root?.manifests, 0, []);
  return {
    layoutVersion,
    hasOciIndex: root !== null,
    indexAnnotations: pairs(root?.annotations),
    candidates,
    diagnostics,
  };
};

const CONFIG_NAME = /^(?:blobs\/sha256\/)?([a-f0-9]{64})(?:\.json)?$/u;

/** The images a Docker save archive lists in manifest.json. */
export const loadDocker = async (
  store: BlobStore,
  hasOciIndex: boolean,
  signal?: AbortSignal,
): Promise<LoadedImage> => {
  const diagnostics: ImageDiagnostic[] = [];
  // Newer Docker archives carry an OCI layout beside manifest.json.
  const layout = hasOciIndex
    ? await readJson(store, "oci-layout", diagnostics, signal)
    : null;
  const layoutVersion = text(record(layout?.value)?.imageLayoutVersion);
  const manifest = await readJson(store, "manifest.json", diagnostics, signal);
  const candidates: Candidate[] = [];
  const entries = Array.isArray(manifest?.value) ? manifest.value : [];
  if (entries.length > MAX_CANDIDATES)
    diagnostics.push({
      location: "manifest.json",
      message: `Only the first ${String(MAX_CANDIDATES)} of ${String(entries.length)} images were read.`,
    });
  for (const [index, raw] of entries.slice(0, MAX_CANDIDATES).entries()) {
    const entry = record(raw);
    const configName = text(entry?.Config);
    const clean = configName === null ? null : normalizeLayerPath(configName);
    const path = clean?.kind === "path" ? clean.path : null;
    const layerNames = textList(entry?.Layers);
    const sources = new Map<string, Descriptor>();
    for (const [diffId, source] of Object.entries(
      record(entry?.LayerSources) ?? {},
    )) {
      const parsed = descriptor(source);
      if (parsed !== null) sources.set(diffId, parsed);
    }
    const read = await readBlob(
      store,
      path,
      null,
      null,
      MAX_JSON_BYTES,
      diagnostics,
      signal,
    );
    const declared =
      path === null ? null : (CONFIG_NAME.exec(path)?.[1] ?? null);
    const computed =
      read.bytes === null
        ? null
        : `sha256:${createHash("sha256").update(read.bytes).digest("hex")}`;
    // The image id is the SHA-256 of the configuration file.
    const id = computed ?? `image:${String(index)}`;
    const blob: BlobCheck =
      read.bytes === null
        ? read.check
        : declared === null
          ? {
              ...read.check,
              algorithm: "sha256",
              computed,
              state: "unverifiable",
            }
          : {
              ...read.check,
              algorithm: "sha256",
              declared: `sha256:${declared}`,
              computed,
              state:
                computed === `sha256:${declared}`
                  ? "verified"
                  : "digest_mismatch",
            };
    candidates.push({
      ...unreadable(id, null, blob),
      refNames: textList(entry?.RepoTags),
      configPath: path,
      layers: layerNames.map((name) => {
        const layer = normalizeLayerPath(name);
        return {
          path: layer.kind === "path" ? layer.path : null,
          descriptor: null,
          foreign: false,
        };
      }),
      layerSources: sources,
    });
  }
  if (entries.length === 0)
    diagnostics.push({
      location: "manifest.json",
      message: "The manifest lists no images.",
    });
  return {
    layoutVersion,
    hasOciIndex,
    indexAnnotations: [],
    candidates,
    diagnostics,
  };
};
