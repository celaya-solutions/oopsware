import { z } from "zod";

import { facetCoverageSchema } from "../formatRegistry.js";

/**
 * Container images read from their bytes (format expansion F09): OCI image
 * layout directories, OCI image archives and Docker save archives. Nothing is
 * pulled, started, mounted or run; foreign layers are named and never fetched.
 * Environment, entrypoint, command, ports and labels are declarations in the
 * image configuration, not observed runtime behavior.
 */

/** Default and maximum bytes read for one archive or one blob. */
export const DEFAULT_IMAGE_FILE_BYTES = 256 * 1024 ** 2;
export const MAX_IMAGE_FILE_BYTES = 1024 ** 3;
/** Default and maximum bytes decoded from compressed layers in one call. */
export const DEFAULT_IMAGE_DECODED_BYTES = 512 * 1024 ** 2;
export const MAX_IMAGE_DECODED_BYTES = 2 * 1024 ** 3;
/** Largest page of files one call returns. */
export const MAX_IMAGE_FILE_PAGE = 10_000;
/** Most entries one composed filesystem view holds. */
export const MAX_IMAGE_VIEW_ENTRIES = 1_000_000;

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const count = z.number().int().min(0);
const nullableString = z.string().nullable();

export const IMAGE_FORMATS = [
  "oci-image-layout",
  "oci-image-archive",
  "docker-save-archive",
] as const;
export type ImageFormat = (typeof IMAGE_FORMATS)[number];

export const inspectContainerImageInputSchema = z
  .strictObject({
    path: z
      .string()
      .min(1)
      .describe(
        "Absolute path to a caller-selected local OCI image layout directory, OCI image archive or Docker save archive (.tar)",
      ),
    platform: z
      .string()
      .regex(/^[^\s/]+\/[^\s/]+(\/[^\s/]+)?$/u)
      .optional()
      .describe(
        "os/architecture[/variant] such as linux/amd64 or linux/arm64/v8; selects one image of a multi-platform index",
      ),
    manifest: z
      .string()
      .regex(/^[A-Za-z0-9_+.-]+:[A-Za-z0-9=_-]{16,256}$/u)
      .optional()
      .describe(
        "Image id to select, as listed in manifests[].id (an OCI manifest digest, or a Docker image id); use it when platform is ambiguous",
      ),
    layer: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        "Index of one layer: list that layer's own entries, whiteouts included, instead of the composed filesystem",
      ),
    start: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("Index of the first file to return"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_IMAGE_FILE_PAGE)
      .default(1000)
      .describe("Maximum files to return in this page"),
    max_file_bytes: z
      .number()
      .int()
      .min(1)
      .max(MAX_IMAGE_FILE_BYTES)
      .default(DEFAULT_IMAGE_FILE_BYTES)
      .describe(
        "Maximum stable bytes to read from an archive or one blob (default 256 MiB)",
      ),
    max_decoded_bytes: z
      .number()
      .int()
      .min(1)
      .max(MAX_IMAGE_DECODED_BYTES)
      .default(DEFAULT_IMAGE_DECODED_BYTES)
      .describe(
        "Maximum bytes to decode from compressed layers in this call (default 512 MiB)",
      ),
  })
  .refine(
    (input) => input.platform === undefined || input.manifest === undefined,
    {
      message: "Select an image with platform or manifest, not both.",
      path: ["manifest"],
    },
  );
export type InspectContainerImageInput = z.infer<
  typeof inspectContainerImageInputSchema
>;

const diagnosticSchema = z.strictObject({
  /** Where in the image: a blob path, a layer, or a file path. */
  location: nullableString,
  message: z.string().min(1),
});
export type ImageDiagnostic = z.infer<typeof diagnosticSchema>;

export const BLOB_STATES = [
  "verified",
  "digest_mismatch",
  "size_mismatch",
  "missing",
  "foreign",
  "unverifiable",
] as const;

/** One referenced blob checked against its descriptor: bytes recomputed, never trusted. */
export const blobCheckSchema = z.strictObject({
  /** Path inside the layout or archive that holds the blob. */
  path: nullableString,
  algorithm: nullableString,
  declared: nullableString,
  computed: nullableString,
  declared_size: count.nullable(),
  actual_size: count.nullable(),
  state: z.enum(BLOB_STATES),
});
export type BlobCheck = z.infer<typeof blobCheckSchema>;

const platformSchema = z.strictObject({
  os: nullableString,
  architecture: nullableString,
  variant: nullableString,
  os_version: nullableString,
});
export type ImagePlatform = z.infer<typeof platformSchema>;

const manifestSchema = z.strictObject({
  /** Selection key: the manifest digest (OCI) or the image id (Docker). */
  id: z.string(),
  kind: z.enum(["image", "attestation"]),
  media_type: nullableString,
  platform: platformSchema.nullable(),
  /** RepoTags, or the ref.name annotation. */
  ref_names: z.array(z.string()),
  annotations: z.array(z.strictObject({ key: z.string(), value: z.string() })),
  layer_count: count.nullable(),
  blob: blobCheckSchema,
  selected: z.boolean(),
});

const selectionSchema = z.strictObject({
  state: z.enum(["selected", "ambiguous", "none"]),
  by: z.enum(["only", "platform", "manifest"]).nullable(),
  id: nullableString,
  reason: nullableString,
});

const historySchema = z.strictObject({
  created: nullableString,
  created_by: nullableString,
  author: nullableString,
  comment: nullableString,
  empty_layer: z.boolean(),
  /** Index into layers, or null for a step that made no layer. */
  layer_index: count.nullable(),
});

/** Declarations in the image configuration, not observed runtime behavior. */
const configSchema = z.strictObject({
  blob: blobCheckSchema,
  architecture: nullableString,
  os: nullableString,
  variant: nullableString,
  created: nullableString,
  author: nullableString,
  user: nullableString,
  working_dir: nullableString,
  stop_signal: nullableString,
  env: z.array(z.string()),
  entrypoint: z.array(z.string()).nullable(),
  cmd: z.array(z.string()).nullable(),
  exposed_ports: z.array(z.string()),
  volumes: z.array(z.string()),
  labels: z.array(z.strictObject({ key: z.string(), value: z.string() })),
  diff_ids: z.array(z.string()),
  history: z.array(historySchema),
});

const layerSchema = z.strictObject({
  index: count,
  media_type: nullableString,
  /** The compression the bytes carry; disagreement with media_type is a diagnostic. */
  compression: z.enum(["none", "gzip", "zstd", "unknown"]).nullable(),
  /** Layer blob as referenced (compressed digest). */
  blob: blobCheckSchema,
  /** Uncompressed digest against the configuration's rootfs.diff_ids. */
  diff_id: z.strictObject({
    declared: nullableString,
    computed: nullableString,
    valid: z.boolean().nullable(),
  }),
  /** A foreign layer's source URLs: recorded, never fetched. */
  urls: z.array(z.string()),
  /** Whether the layer was decoded and its tar read to the end. */
  read: z.enum(["complete", "partial", "not_read"]),
  uncompressed_bytes: count.nullable(),
  entries: count,
  files: count,
  directories: count,
  symlinks: count,
  hardlinks: count,
  special_files: count,
  whiteouts: count,
  opaque_directories: count,
  /** Lower-layer paths this layer hid or replaced. */
  removed_from_lower: count,
  /** Command from the matching history step. */
  created_by: nullableString,
});

const fileSchema = z.strictObject({
  path: z.string(),
  type: z.enum([
    "file",
    "directory",
    "symlink",
    "hardlink",
    "char-device",
    "block-device",
    "fifo",
    "whiteout",
    "opaque-marker",
    "unknown",
  ]),
  /** Permission bits as octal text. */
  mode: nullableString,
  /** setuid, setgid and sticky, as stored; never applied. */
  special: z.array(z.enum(["setuid", "setgid", "sticky"])),
  uid: count.nullable(),
  gid: count.nullable(),
  user: nullableString,
  group: nullableString,
  size: count.nullable(),
  mtime: z.number().int().nullable(),
  link_target: nullableString,
  /** Hard and symbolic links resolved inside the view. */
  link_status: z.enum(["resolved", "dangling", "escapes_root"]).nullable(),
  /** Layer whose entry is shown. */
  layer: count,
  /** A layer-directory entry created because the layer had none for a parent. */
  implicit: z.boolean(),
  /** For a whiteout or opaque marker: the path it hides in lower layers. */
  hides: nullableString,
});
export type ImageFile = z.infer<typeof fileSchema>;

export const containerImageReportSchema = z.strictObject({
  artifact: z.strictObject({
    path: z.string().min(1),
    kind: z.enum(["file", "directory"]),
    sha256,
    /** A file is hashed whole; a layout directory is identified by its index.json. */
    sha256_of: z.enum(["content", "index.json"]),
    bytes: count.nullable(),
  }),
  image: z.strictObject({
    format: z.enum(IMAGE_FORMATS),
    /** An OCI layout version, when an oci-layout file is present. */
    layout_version: nullableString,
    /** A Docker save archive that also carries an OCI index. */
    has_oci_index: z.boolean(),
    index_annotations: z.array(
      z.strictObject({ key: z.string(), value: z.string() }),
    ),
  }),
  manifests: z.array(manifestSchema),
  selection: selectionSchema,
  config: configSchema.nullable(),
  layers: z.array(layerSchema),
  /** composed = the layers applied in order; layer = one layer's own entries. */
  view: z.enum(["composed", "layer", "none"]),
  file_count: count,
  page: z.strictObject({
    start: count,
    limit: z.number().int().min(1),
    returned: count,
    next: count.nullable(),
  }),
  files: z.array(fileSchema),
  /** Decoders that ran, as provenance. */
  decoders: z.array(
    z.strictObject({
      tool: z.string(),
      version: nullableString,
    }),
  ),
  diagnostics: z.array(diagnosticSchema),
  coverage: z.array(facetCoverageSchema),
  limitations: z.array(z.string()),
});
export type ContainerImageReport = z.infer<typeof containerImageReportSchema>;
