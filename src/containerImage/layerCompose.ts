import { createHash } from "node:crypto";

import type {
  BlobCheck,
  ContainerImageReport,
  ImageDiagnostic,
  ImageFile,
} from "../domain/containerImage/containerImage.js";
import { MAX_IMAGE_VIEW_ENTRIES } from "../domain/containerImage/containerImage.js";
import { PayloadDecodeFailure } from "../linuxPackage/decode.js";
import type { BlobStore } from "./blobStore.js";
import { countMembers } from "./imagePage.js";
import {
  isForeign,
  readBlob,
  type Candidate,
  type Descriptor,
  type LayerRef,
} from "./imageModel.js";
import { resolveLinkTarget } from "./layerPaths.js";
import { LayerView } from "./layerView.js";
import {
  MAX_METADATA_BYTES,
  walkLayer,
  type DecodeBudget,
  type LayerWalk,
  type TarData,
} from "./layerWalk.js";

type Layer = ContainerImageReport["layers"][number];
type Config = NonNullable<ContainerImageReport["config"]>;

/** A Docker save layer path that names its content: `blobs/<algorithm>/<encoded>`. */
const BLOB_PATH = /^blobs\/([a-z0-9]+)\/([a-zA-Z0-9=_-]{16,})$/u;

export interface ComposeInput {
  readonly store: BlobStore;
  readonly chosen: Candidate;
  readonly config: Config | null;
  /** Keep this layer's own entries for a layer-level listing. */
  readonly keepLayer: number | undefined;
  readonly budget: DecodeBudget;
  readonly maxFileBytes: number;
  readonly signal: AbortSignal | undefined;
  readonly diagnostics: ImageDiagnostic[];
  /** Receives where each entry's bytes sit, for a caller that reads file contents later. */
  readonly sources?: WeakMap<ImageFile, TarData>;
  /** Receives the SHA-256 of each layer blob as read, so a later re-read can be compared. */
  readonly blobSha256s?: Map<number, string>;
}

/** Most layers read from one manifest (overlay filesystems stop near 128). */
export const MAX_LAYERS = 1024;

export interface Composition {
  readonly layers: Layer[];
  readonly view: LayerView;
  readonly kept: readonly ImageFile[] | null;
  /** Every layer was read to its end, verified and applied. */
  readonly complete: boolean;
  /** One line for each reason the composed listing is not complete. */
  readonly problems: readonly string[];
  readonly compressions: ReadonlySet<string>;
}

export const trusted = (check: BlobCheck): boolean =>
  check.state === "verified" || check.state === "unverifiable";

interface Described {
  readonly descriptor: Descriptor | null;
  readonly declaredDigest: string | null;
  readonly foreign: boolean;
}

/** What the manifest, or a Docker layer map, says about one layer. */
const describeLayer = (
  ref: LayerRef,
  diffId: string | null,
  chosen: Candidate,
): Described => {
  const descriptor =
    ref.descriptor ??
    (diffId === null ? null : (chosen.layerSources.get(diffId) ?? null));
  const named = ref.path === null ? null : BLOB_PATH.exec(ref.path);
  return {
    descriptor,
    // The file name says what the stored bytes hash to; a Docker layer map may
    // describe the compressed form instead.
    declaredDigest:
      named === null ? (descriptor?.digest ?? null) : `${named[1]}:${named[2]}`,
    foreign: ref.foreign || isForeign(descriptor),
  };
};

/** The compression a layer media type names, or null when it names none. */
const declaredCompression = (mediaType: string | null): string | null => {
  if (mediaType === null) return null;
  if (/(\+gzip|\.gzip)$/u.test(mediaType)) return "gzip";
  if (/(\+zstd|\.zstd)$/u.test(mediaType)) return "zstd";
  return /(\.tar|\+tar)$/u.test(mediaType) ? "none" : null;
};

interface Verdict {
  readonly check: BlobCheck;
  readonly diffValid: boolean | null;
  readonly manifestTrusted: boolean;
}

/** Why a layer was kept out of the composed view, or null when it belongs in it. */
const refusal = (verdict: Verdict): string | null => {
  if (!verdict.manifestTrusted)
    return "the manifest does not match its digest, so its layer list is not trusted";
  if (!trusted(verdict.check))
    return `its blob ${verdict.check.state === "digest_mismatch" ? "digest" : "size"} does not match the descriptor`;
  if (verdict.diffValid === false)
    return "its uncompressed digest does not match the configuration's diff id";
  // Nothing vouches for the bytes: no blob digest to check and no diff id.
  if (verdict.check.state === "unverifiable" && verdict.diffValid === null)
    return "no digest or diff id vouches for its bytes";
  return null;
};

/**
 * A hard link shares its target's bytes as of its own layer: resolve it now,
 * against the view built so far, not the final one.
 */
const placeLink = (
  view: LayerView,
  link: ImageFile,
  sources: WeakMap<ImageFile, TarData> | undefined,
): ImageFile => {
  const target = resolveLinkTarget("", link.link_target ?? "");
  const found = "path" in target ? view.get(target.path) : undefined;
  const data = found === undefined ? undefined : sources?.get(found);
  const usable =
    found !== undefined &&
    (found.type === "file" ||
      (found.type === "hardlink" && found.link_status === "resolved")) &&
    (sources === undefined || data !== undefined);
  if (!usable) return { ...link, link_status: "dangling" };
  const placed: ImageFile = {
    ...link,
    size: found.size,
    link_status: "resolved",
  };
  if (sources !== undefined && data !== undefined) sources.set(placed, data);
  return placed;
};

/** Whiteouts and opaque markers hide lower layers only; then the layer's entries land. */
const applyLayer = (
  view: LayerView,
  members: readonly ImageFile[],
  sources: WeakMap<ImageFile, TarData> | undefined,
  names: { bytes: number },
): number => {
  let removed = 0;
  for (const member of members)
    if (member.type === "opaque-marker")
      removed += view.clearChildren(member.hides ?? "");
  for (const member of members)
    if (member.type === "whiteout") removed += view.remove(member.hides ?? "");
  for (const member of members) {
    if (member.type === "opaque-marker" || member.type === "whiteout") continue;
    // Counted as applied, never given back: a bound on what the view can hold.
    names.bytes +=
      Buffer.byteLength(member.path) +
      Buffer.byteLength(member.link_target ?? "");
    if (names.bytes > MAX_METADATA_BYTES)
      throw new PayloadDecodeFailure(
        "budget",
        `The composed view's names and link targets total more than ${String(MAX_METADATA_BYTES)} bytes.`,
      );
    removed += view.set(
      member.type === "hardlink" ? placeLink(view, member, sources) : member,
    ).removed;
    if (view.size > MAX_IMAGE_VIEW_ENTRIES)
      throw new PayloadDecodeFailure(
        "budget",
        `The composed view holds more than ${String(MAX_IMAGE_VIEW_ENTRIES)} entries.`,
      );
  }
  return removed;
};

interface LayerOutcome {
  readonly record: Layer;
  readonly walk: LayerWalk | null;
  readonly applied: boolean;
}

const processLayer = async (
  context: ComposeInput,
  view: LayerView,
  index: number,
  ref: LayerRef,
  manifestTrusted: boolean,
  names: { bytes: number },
): Promise<LayerOutcome> => {
  const { config, diagnostics } = context;
  const diffId = config?.diff_ids[index] ?? null;
  const { descriptor, declaredDigest, foreign } = describeLayer(
    ref,
    diffId,
    context.chosen,
  );
  const read = await readBlob(
    context.store,
    ref.path,
    declaredDigest,
    declaredDigest === descriptor?.digest ? (descriptor?.size ?? null) : null,
    context.maxFileBytes,
    diagnostics,
    context.signal,
  );
  const check: BlobCheck =
    read.bytes === null && foreign
      ? { ...read.check, state: "foreign" }
      : read.check;
  const where = `layer ${String(index)}`;
  if (read.bytes !== null)
    context.blobSha256s?.set(
      index,
      createHash("sha256").update(read.bytes).digest("hex"),
    );
  if (read.bytes === null && check.state === "missing")
    diagnostics.push({
      location: where,
      message: `The layer blob ${ref.path ?? "(no path)"} is not in the image.`,
    });
  const walk =
    read.bytes === null
      ? null
      : await walkLayer(read.bytes, index, {
          budget: context.budget,
          maximumEntries: MAX_IMAGE_VIEW_ENTRIES,
          signal: context.signal,
          sources: context.sources,
        });
  if (walk !== null)
    for (const diagnostic of walk.diagnostics) diagnostics.push(diagnostic);
  const named = declaredCompression(descriptor?.mediaType ?? null);
  if (walk !== null && named !== null && walk.compression !== named)
    diagnostics.push({
      location: where,
      message: `The media type names ${named} but the layer bytes are ${walk.compression}; the bytes decide.`,
    });
  const diff = {
    declared: diffId,
    computed: walk?.diffId ?? null,
    valid:
      diffId === null || walk?.diffId == null ? null : diffId === walk.diffId,
  };
  const why = refusal({ check, diffValid: diff.valid, manifestTrusted });
  const applied = walk !== null && walk.read !== "not_read" && why === null;
  if (walk !== null && !applied)
    diagnostics.push({
      location: where,
      message: `The layer was not applied to the composed view: ${why ?? "its entries could not be read"}.`,
    });
  const removed = applied
    ? applyLayer(view, walk.members, context.sources, names)
    : 0;
  return {
    walk,
    applied,
    record: {
      index,
      media_type: descriptor?.mediaType ?? null,
      compression: walk?.compression ?? null,
      blob: check,
      diff_id: diff,
      urls: [...(descriptor?.urls ?? [])],
      read: walk?.read ?? "not_read",
      uncompressed_bytes: walk?.uncompressedBytes ?? null,
      entries: walk?.members.length ?? 0,
      ...countMembers(walk?.members ?? []),
      removed_from_lower: removed,
      created_by:
        config?.history.find((step) => step.layer_index === index)
          ?.created_by ?? null,
    },
  };
};

/** Decode, verify and apply every layer of the chosen image, in order. */
export const composeLayers = async (
  context: ComposeInput,
): Promise<Composition> => {
  const view = new LayerView();
  const layers: Layer[] = [];
  const problems: string[] = [];
  const compressions = new Set<string>();
  const names = { bytes: 0 };
  let kept: readonly ImageFile[] | null = null;
  const manifestTrusted = trusted(context.chosen.blob);
  if (context.chosen.layers === null) {
    problems.push("The manifest could not be read, so its layers are unknown.");
    context.diagnostics.push({
      location: context.chosen.blob.path,
      message: problems[0] ?? "",
    });
  }
  if (!manifestTrusted)
    problems.push(
      `The manifest does not match its digest (${context.chosen.blob.state}); no layer was applied.`,
    );
  if (context.config !== null && !trusted(context.config.blob))
    problems.push(
      `The configuration does not match its digest (${context.config.blob.state}); its diff ids are not trusted.`,
    );
  const refs = context.chosen.layers ?? [];
  if (refs.length > MAX_LAYERS)
    problems.push(
      `The manifest lists ${String(refs.length)} layers; only the first ${String(MAX_LAYERS)} were read.`,
    );
  for (const [index, ref] of refs.slice(0, MAX_LAYERS).entries()) {
    const outcome = await processLayer(
      context,
      view,
      index,
      ref,
      manifestTrusted,
      names,
    );
    layers.push(outcome.record);
    const compression = outcome.walk?.compression;
    if (compression === "gzip" || compression === "zstd")
      compressions.add(compression);
    if (!outcome.applied || outcome.walk?.read !== "complete")
      problems.push(
        `Layer ${String(index)} was not fully applied (blob ${outcome.record.blob.state}, read ${outcome.record.read}${
          outcome.record.diff_id.valid === false ? ", diff id mismatch" : ""
        }); the composed listing is incomplete.`,
      );
    if (index === context.keepLayer) kept = outcome.walk?.members ?? null;
  }
  return {
    layers,
    view,
    kept,
    complete: problems.length === 0,
    problems,
    compressions,
  };
};
