import { z } from "zod";

import { formatDetectionSchema } from "../formatDetection.js";
import {
  formatDimensionSchema,
  formatIdSchema,
  type FormatId,
} from "../formatIdentifiers.js";
import { jsonObjectSchema } from "../jsonValue.js";

/**
 * "What is this?" for one explicit local file or folder: byte-based format
 * detection, the reader that owns each format run in its cheapest mode for a
 * headline, nested containers opened to a chosen depth, and a folder
 * inventory. Nothing is executed, installed or fetched; container members
 * copied to open them live in a private scratch directory that is removed
 * before the answer returns. A detected format is a candidate, not a claim
 * that every facet of it was read.
 */

/** Nested container levels a caller may ask to open. */
export const MAX_IDENTIFY_DEPTH = 6;
/** Depth used when the caller omits it: files open nested containers, folders do not. */
export const DEFAULT_FILE_DEPTH = 3;
export const DEFAULT_FOLDER_DEPTH = 0;
/** Folder entries plus container members examined in one call. */
export const DEFAULT_IDENTIFY_ENTRIES = 100_000;
export const MAX_IDENTIFY_ENTRIES = 2_000_000;
/** Built-in readers run for headlines in one call. */
export const DEFAULT_IDENTIFY_READERS = 8;
export const MAX_IDENTIFY_READERS = 64;
/** Bytes copied to the private scratch directory to open nested pieces. */
export const DEFAULT_IDENTIFY_SPOOL_BYTES = 1024 ** 3;
export const MAX_IDENTIFY_SPOOL_BYTES = 16 * 1024 ** 3;
/** Bytes decoded from one compressed archive stream before it stops. */
export const DEFAULT_IDENTIFY_DECODED_BYTES = 4 * 1024 ** 3;
export const MAX_IDENTIFY_DECODED_BYTES = 16 * 1024 ** 3;
/** Largest page of pieces one call returns. */
export const MAX_IDENTIFY_PAGE = 5_000;
/** Diagnostics listed in one answer; the rest are counted. */
export const MAX_IDENTIFY_DIAGNOSTICS = 200;
/** Extensions of unrecognized files named in one answer. */
export const MAX_UNRECOGNIZED_EXTENSIONS = 8;
/** Facts a headline carries. */
export const MAX_HEADLINE_FACTS = 6;

const count = z.number().int().min(0);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const text = z.string().min(1);

export const identifyArtifactInputSchema = z.strictObject({
  path: z
    .string()
    .min(1)
    .describe("Absolute path to a local file or folder to identify"),
  depth: z
    .number()
    .int()
    .min(0)
    .max(MAX_IDENTIFY_DEPTH)
    .optional()
    .describe(
      "Nested container levels to open (an archive inside an archive counts one level each). Omitted: 3 for a file, 0 for a folder.",
    ),
  max_entries: z
    .number()
    .int()
    .min(1)
    .max(MAX_IDENTIFY_ENTRIES)
    .default(DEFAULT_IDENTIFY_ENTRIES)
    .describe(
      "Folder entries plus container members examined; the walk stops and says so when reached",
    ),
  max_readers: z
    .number()
    .int()
    .min(0)
    .max(MAX_IDENTIFY_READERS)
    .default(DEFAULT_IDENTIFY_READERS)
    .describe(
      "Built-in readers run for headlines, the root first and then pieces in walk order; 0 runs none",
    ),
  max_spool_bytes: z
    .number()
    .int()
    .min(0)
    .max(MAX_IDENTIFY_SPOOL_BYTES)
    .default(DEFAULT_IDENTIFY_SPOOL_BYTES)
    .describe(
      "Bytes copied to a private scratch directory to open nested containers or read nested pieces; removed before the answer returns",
    ),
  max_decoded_bytes: z
    .number()
    .int()
    .min(1)
    .max(MAX_IDENTIFY_DECODED_BYTES)
    .default(DEFAULT_IDENTIFY_DECODED_BYTES)
    .describe(
      "Bytes decoded from one compressed archive stream (gzip, xz, 7z) before reading it stops and says so",
    ),
  start: count.default(0).describe("Index of the first piece to return"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_IDENTIFY_PAGE)
    .default(20)
    .describe("Maximum pieces to return in this page"),
});
export type IdentifyArtifactInput = z.infer<typeof identifyArtifactInputSchema>;

/** One labelled fact taken from a reader's typed report. */
export const headlineFactSchema = z.strictObject({ label: text, value: text });
export type HeadlineFact = z.infer<typeof headlineFactSchema>;

/** What a reader said a piece is, in one title and a few facts. */
export const headlineSchema = z.strictObject({
  tool: text,
  title: text,
  facts: z.array(headlineFactSchema).max(MAX_HEADLINE_FACTS),
});
export type Headline = z.infer<typeof headlineSchema>;

/** Why the best format was chosen. */
const formatBasisSchema = z.enum([
  /** Leading bytes (or the trailer) carry the format's signature or structure. */
  "bytes",
  /** The name names a role whose storage the bytes show; contents unchecked. */
  "name",
  /** The host reports a folder. */
  "filesystem",
  /** Only the name named it, and the reader that owns the format confirmed it. */
  "reader",
]);

const containerSchema = z.strictObject({
  state: z.enum(["opened", "not_opened", "not_container"]),
  /** Members seen while it was open; null when it was not opened. */
  members: count.nullable(),
  reason: text.nullable(),
});

const readerStateSchema = z.strictObject({
  tool: text.nullable(),
  state: z.enum([
    /** The reader ran and its headline is attached. */
    "ran",
    /** The reader ran and reported an error; the message is the reason. */
    "failed",
    /** A built-in reader exists but was not run here; the reason says why. */
    "skipped",
    /** The reader needs an installed program or engine; see next steps. */
    "needs_provider",
    /** No reader is routed for this format. */
    "none",
  ]),
  reason: text.nullable(),
});

export const identifiedPieceSchema = z.strictObject({
  /** Walk order: `p0` is the root. */
  id: z.string().regex(/^p\d+$/u),
  parent: z
    .string()
    .regex(/^p\d+$/u)
    .nullable(),
  /** Container levels above this piece; folder entries stay at depth 0. */
  depth: count,
  /** Logical path below the root, members joined with `/`; `""` is the root. */
  path: z.string(),
  name: text,
  kind: z.enum(["file", "directory", "symlink", "other"]),
  bytes: count.nullable(),
  format: formatIdSchema.nullable(),
  format_basis: formatBasisSchema.nullable(),
  label: text.nullable(),
  /** Every format the examined bytes (or bytes plus name) are consistent with. */
  candidates: z.array(formatIdSchema),
  /** The name suggests a format the bytes do not show. */
  name_conflict: text.nullable(),
  container: containerSchema,
  reader: readerStateSchema,
  headline: headlineSchema.nullable(),
});
export type IdentifiedPiece = z.infer<typeof identifiedPieceSchema>;

/** A walked piece plus what the answer needs after the page is cut. */
export interface WalkedPiece extends IdentifiedPiece {
  /** The real path of a root or folder entry; null inside a container. */
  readonly onDisk: string | null;
  /** The on-disk piece a nested piece was read out of. */
  readonly outer: string | null;
  /** Formats only the name suggests, offered as next steps, never run. */
  hinted: readonly FormatId[];
  /** The best format the bytes alone establish, kept when a reader refutes the name. */
  fallback: FormatId | null;
  /** The registry says a reader lists this piece's contents on this host. */
  openable: boolean;
}

/** Counts a walk keeps while it runs. */
export interface IdentificationCounters {
  entries: number;
  entryLimit: boolean;
  containersOpened: number;
  containersNotOpened: number;
  containersStopped: number;
  readersRun: number;
  readersNotRun: number;
  spooledBytes: number;
  spoolLimit: boolean;
  symlinks: number;
  special: number;
  unreadable: number;
  diagnosticsOmitted: number;
}

/** Everything a walk observed, before the answer is assembled. */
export interface IdentificationWalk {
  readonly kind: "file" | "directory";
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly detection: z.infer<typeof formatDetectionSchema> | null;
  readonly pieces: readonly WalkedPiece[];
  readonly depth: number;
  readonly counters: IdentificationCounters;
  readonly diagnostics: readonly {
    readonly piece: string | null;
    readonly message: string;
  }[];
  readonly limitations: readonly string[];
}

/** One exact call that reads a piece more deeply. */
export const identifyNextStepSchema = z.strictObject({
  piece: z.string().regex(/^p\d+$/u),
  tool: text,
  label: text,
  /** Arguments for the tool; nested pieces name the on-disk container. */
  arguments: jsonObjectSchema,
  /** What must be installed or done first; null when nothing is. */
  requires: text.nullable(),
  /** The path to open with open_binary before this call; null when none. */
  open_first: text.nullable(),
  why: text,
});
export type IdentifyNextStep = z.infer<typeof identifyNextStepSchema>;

const formatTallySchema = z.strictObject({
  format: formatIdSchema.nullable(),
  label: text,
  dimension: formatDimensionSchema.nullable(),
  count,
  bytes: count,
});

export const artifactIdentificationSchema = z.strictObject({
  subject: z.strictObject({
    path: text,
    kind: z.enum(["file", "directory"]),
    /** File size, or the sum of examined regular files for a folder. */
    bytes: count,
    /** File content digest, or a digest of the examined folder listing. */
    sha256,
    sha256_of: z.enum(["content", "listing"]),
  }),
  answer: z.strictObject({
    /** One sentence built only from the facts below. */
    summary: text,
    format: formatIdSchema.nullable(),
    label: text.nullable(),
    headline: headlineSchema.nullable(),
  }),
  /** Detection for a file root; null for a folder. */
  detection: formatDetectionSchema.nullable(),
  /** Pieces by best format, most frequent first. */
  formats: z.array(formatTallySchema),
  /** Extensions of unrecognized files (names only, never a format claim), most frequent first. */
  unrecognized_extensions: z.array(
    z.strictObject({ extension: z.string(), count }),
  ),
  /** The ten largest regular files examined below the root. */
  largest: z.array(
    z.strictObject({ piece: z.string().regex(/^p\d+$/u), bytes: count }),
  ),
  piece_count: count,
  page: z.strictObject({
    start: count,
    limit: z.number().int().min(1),
    returned: count,
    next: count.nullable(),
  }),
  pieces: z.array(identifiedPieceSchema),
  next_steps: z.array(identifyNextStepSchema),
  /** Steps left out to keep the answer short; the pieces still carry their readers. */
  next_steps_omitted: count,
  coverage: z.strictObject({
    depth: count,
    entries_examined: count,
    entry_limit_reached: z.boolean(),
    containers_opened: count,
    containers_not_opened: count,
    /** Containers opened but not read to the end; each piece says why. */
    containers_stopped: count,
    readers_run: count,
    readers_not_run: count,
    spooled_bytes: count,
    spool_limit_reached: z.boolean(),
    symlinks: count,
    special_files: count,
    unreadable: count,
    /** Diagnostics beyond the listed ones. */
    diagnostics_omitted: count,
  }),
  diagnostics: z.array(
    z.strictObject({ piece: z.string().nullable(), message: text }),
  ),
  limitations: z.array(text),
});
export type ArtifactIdentification = z.infer<
  typeof artifactIdentificationSchema
>;
