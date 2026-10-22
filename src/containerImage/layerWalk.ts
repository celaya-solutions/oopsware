import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { createGunzip, createZstdDecompress } from "node:zlib";

import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { ByteSource } from "../artifacts/archives/ByteSource.js";
import { TarStream, type TarMember } from "../artifacts/archives/TarStream.js";
import type {
  ImageDiagnostic,
  ImageFile,
} from "../domain/containerImage/containerImage.js";
import { hasTarHeader } from "../domain/archiveStreamFormat.js";
import { PayloadDecodeFailure } from "../linuxPackage/decode.js";
import { normalizeLayerPath, parseWhiteout } from "./layerPaths.js";

export type LayerCompression = "none" | "gzip" | "zstd" | "unknown";

/** Decoded bytes one call may still produce, shared by every layer. */
export interface DecodeBudget {
  remaining: number;
  readonly limit: number;
}

/** Where one layer entry's bytes sit in the layer's decoded tar. */
export interface TarData {
  readonly layer: number;
  readonly dataOffset: number;
  readonly size: number;
}

export interface WalkOptions {
  readonly budget: DecodeBudget;
  readonly maximumEntries: number;
  readonly signal?: AbortSignal | undefined;
  /** Receives the data position of each entry that lands in the walk. */
  readonly sources?: WeakMap<ImageFile, TarData> | undefined;
}

export interface LayerWalk {
  readonly compression: LayerCompression;
  /** Entries in tar order, names normalized, whiteouts and opaque markers marked. */
  readonly members: readonly ImageFile[];
  readonly uncompressedBytes: number | null;
  /** `sha256:<hex>` of every decoded byte, or null when the layer was not read to its end. */
  readonly diffId: string | null;
  readonly read: "complete" | "partial" | "not_read";
  readonly diagnostics: readonly ImageDiagnostic[];
}

export const detectCompression = (bytes: Uint8Array): LayerCompression =>
  bytes[0] === 0x1f && bytes[1] === 0x8b
    ? "gzip"
    : bytes[0] === 0x28 &&
        bytes[1] === 0xb5 &&
        bytes[2] === 0x2f &&
        bytes[3] === 0xfd
      ? "zstd"
      : hasTarHeader(bytes) || bytes.length === 0
        ? "none"
        : "unknown";

const SPECIAL_BITS: readonly (readonly [
  number,
  "setuid" | "setgid" | "sticky",
])[] = [
  [0o4000, "setuid"],
  [0o2000, "setgid"],
  [0o1000, "sticky"],
];

const TYPE_BY_FLAG: Readonly<Record<string, ImageFile["type"]>> = {
  "0": "file",
  "7": "file",
  "5": "directory",
  "2": "symlink",
  "1": "hardlink",
  "3": "char-device",
  "4": "block-device",
  "6": "fifo",
};

const entryOf = (member: TarMember, path: string, layer: number): ImageFile => {
  const type = TYPE_BY_FLAG[member.typeflag] ?? "unknown";
  const link =
    member.linkName === null ? null : member.linkName.replace(/\0+$/u, "");
  return {
    path,
    type,
    mode:
      member.mode === null
        ? null
        : (member.mode & 0o7777).toString(8).padStart(4, "0"),
    special:
      member.mode === null
        ? []
        : SPECIAL_BITS.filter(([bit]) => (member.mode ?? 0) & bit).map(
            ([, name]) => name,
          ),
    uid: member.uid,
    gid: member.gid,
    user: member.uname,
    group: member.gname,
    size: type === "file" ? member.size : null,
    mtime: member.mtime,
    link_target: type === "symlink" || type === "hardlink" ? link : null,
    link_status: null,
    layer,
    implicit: false,
    hides: null,
  };
};

/** Decoded chunks, counted against the shared budget (and hashed when a tally is given). */
export async function* decodedChunks(
  blob: Buffer,
  compression: Exclude<LayerCompression, "unknown">,
  context: {
    readonly tally?: {
      bytes: number;
      readonly hash: ReturnType<typeof createHash>;
    };
    readonly budget: DecodeBudget;
    readonly signal: AbortSignal | undefined;
  },
): AsyncGenerator<Buffer> {
  const { tally, budget, signal } = context;
  const raw = Readable.from([blob]);
  const stream: Readable =
    compression === "none"
      ? raw
      : raw.pipe(
          compression === "gzip" ? createGunzip() : createZstdDecompress(),
        );
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      if (signal?.aborted === true)
        throw new PayloadDecodeFailure("cancelled", "The read was cancelled.");
      budget.remaining -= chunk.length;
      if (budget.remaining < 0)
        throw new PayloadDecodeFailure(
          "budget",
          `Decoding passes the ${String(budget.limit)}-byte budget (max_decoded_bytes).`,
        );
      if (tally !== undefined) {
        tally.bytes += chunk.length;
        tally.hash.update(chunk);
      }
      yield chunk;
    }
  } finally {
    stream.destroy();
    raw.destroy();
  }
}

interface Classified {
  readonly entry: ImageFile | null;
  readonly diagnostic?: ImageDiagnostic;
  /** A real entry was dropped, so the layer's listing is not complete. */
  readonly dropped?: boolean;
}

/** Longest entry name or link target kept, in bytes (Linux PATH_MAX). */
const MAX_NAME_BYTES = 4096;
/** Deepest path kept; bounds every recursive walk over the composed tree. */
const MAX_COMPONENTS = 512;
/** Bytes of entry names and link targets kept for one layer, or for the whole composed view. */
export const MAX_METADATA_BYTES = 256 * 1024 ** 2;
/** Diagnostics listed per layer before the rest are only counted. */
const MAX_LAYER_DIAGNOSTICS = 100;

/** Turn one tar member into a layer entry, a whiteout or opaque marker, or a skip with a reason. */
const classifyMember = (member: TarMember, layer: number): Classified => {
  const location = `layer ${String(layer)}`;
  if (member.name === null)
    return {
      entry: null,
      dropped: true,
      diagnostic: {
        location,
        message: `An entry name is not valid UTF-8 and was skipped (stored bytes ${member.rawNameHex}).`,
      },
    };
  const dropped = (message: string, name: string): Classified => ({
    entry: null,
    dropped: true,
    diagnostic: {
      location: `${location}: ${name.slice(0, 200)}`,
      message: `The entry was skipped because ${message}.`,
    },
  });
  if (Buffer.byteLength(member.name) > MAX_NAME_BYTES)
    return dropped(
      `its name is over ${String(MAX_NAME_BYTES)} bytes`,
      member.name,
    );
  if (Buffer.byteLength(member.linkName ?? "") > MAX_NAME_BYTES)
    return dropped(
      `its link target is over ${String(MAX_NAME_BYTES)} bytes`,
      member.name,
    );
  if (member.sparse)
    return dropped(
      "it is a sparse file, whose stored bytes are not the file's content",
      member.name,
    );
  const normalized = normalizeLayerPath(member.name);
  if (normalized.kind === "root") return { entry: null };
  if (normalized.kind === "unsafe")
    return dropped(normalized.reason, member.name);
  if (normalized.path.split("/").length > MAX_COMPONENTS)
    return dropped(
      `its path is deeper than ${String(MAX_COMPONENTS)} directories`,
      member.name,
    );
  const file = entryOf(member, normalized.path, layer);
  const whiteout = parseWhiteout(normalized.path);
  const where = `${location}: ${normalized.path}`;
  switch (whiteout?.kind) {
    case "reserved":
      return {
        entry: null,
        diagnostic: {
          location: where,
          message: "A reserved whiteout bookkeeping name was ignored.",
        },
      };
    case "opaque":
      return {
        entry: {
          ...file,
          type: "opaque-marker",
          size: null,
          hides: whiteout.directory,
        },
      };
    case "whiteout":
      return {
        entry: { ...file, type: "whiteout", size: null, hides: whiteout.hides },
      };
    default:
      return file.type === "unknown"
        ? {
            entry: file,
            diagnostic: {
              location: where,
              message: `Tar type flag ${JSON.stringify(member.typeflag)} is not a file, directory, link, device or fifo.`,
            },
          }
        : { entry: file };
  }
};

const damage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * Decode one layer blob and list its tar entries. Only metadata is kept; file
 * contents are skipped. A damaged layer keeps the entries read before the
 * damage and says so. Budget exhaustion and cancellation propagate.
 */
export const walkLayer = async (
  blob: Buffer,
  layer: number,
  options: WalkOptions,
): Promise<LayerWalk> => {
  const { budget, maximumEntries, signal, sources } = options;
  const compression = detectCompression(blob);
  const location = `layer ${String(layer)}`;
  if (compression === "unknown")
    return {
      compression,
      members: [],
      uncompressedBytes: null,
      diffId: null,
      read: "not_read",
      diagnostics: [
        {
          location,
          message:
            "The layer is neither a tar archive nor gzip or zstd data, so its entries were not read.",
        },
      ],
    };
  const tally = { bytes: 0, hash: createHash("sha256") };
  const source = new ByteSource(
    decodedChunks(blob, compression, { tally, budget, signal }),
  );
  const tar = new TarStream(source);
  const members: ImageFile[] = [];
  const diagnostics: ImageDiagnostic[] = [];
  let suppressed = 0;
  const note = (diagnostic: ImageDiagnostic): void => {
    if (diagnostics.length < MAX_LAYER_DIAGNOSTICS)
      diagnostics.push(diagnostic);
    else suppressed += 1;
  };
  let complete = false;
  let dropped = 0;
  let examined = 0;
  let metadataBytes = 0;
  // A member counts only once its data was skipped, so a cut-off one is not kept.
  let pending: { entry: ImageFile; data: TarData } | null = null;
  const commit = (): void => {
    if (pending === null) return;
    members.push(pending.entry);
    sources?.set(pending.entry, pending.data);
    pending = null;
  };
  try {
    for (;;) {
      const member = await tar.next();
      commit();
      if (member === null) break;
      examined += 1;
      if (examined > maximumEntries)
        throw new PayloadDecodeFailure(
          "budget",
          `The layer holds more than ${String(maximumEntries)} entries.`,
        );
      const classified = classifyMember(member, layer);
      if (classified.diagnostic !== undefined) note(classified.diagnostic);
      if (classified.dropped === true) dropped += 1;
      if (classified.entry !== null) {
        metadataBytes +=
          Buffer.byteLength(classified.entry.path) +
          Buffer.byteLength(classified.entry.link_target ?? "");
        if (metadataBytes > MAX_METADATA_BYTES)
          throw new PayloadDecodeFailure(
            "budget",
            `The layer's entry names and link targets total more than ${String(MAX_METADATA_BYTES)} bytes.`,
          );
        pending = {
          entry: classified.entry,
          data: { layer, dataOffset: member.dataOffset, size: member.size },
        };
      }
    }
    // The diff id covers every decoded byte, padding and trailing zeros included.
    await source.skip(Number.MAX_SAFE_INTEGER);
    complete = true;
    if (tar.end?.marker !== "two-zero-blocks")
      note({
        location,
        message: `The layer tar ends without the two zero blocks (${tar.end?.marker ?? "unknown"}).`,
      });
  } catch (cause) {
    if (cause instanceof PayloadDecodeFailure) throw cause;
    note({
      location,
      message: `The layer data is damaged after ${String(members.length)} entries: ${
        cause instanceof ArtifactReaderFailure ? cause.message : damage(cause)
      }`,
    });
  } finally {
    await source.return().catch(() => undefined);
  }
  if (suppressed > 0)
    diagnostics.push({
      location,
      message: `${String(suppressed)} more problems in this layer were not listed.`,
    });
  return {
    compression,
    members,
    uncompressedBytes: complete ? tally.bytes : null,
    diffId: complete ? `sha256:${tally.hash.digest("hex")}` : null,
    // A dropped entry means the listing lacks something the layer holds.
    read: complete && dropped === 0 ? "complete" : "partial",
    diagnostics,
  };
};
