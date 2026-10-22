import { z } from "zod";

import { facetCoverageSchema } from "../formatRegistry.js";

/**
 * Windows Installer packages (.msi) read from their bytes (format expansion
 * F08). Nothing is installed: no msiexec, custom action, embedded program,
 * script, COM activation or registry change. Table rows are declarations of
 * what an installation could do; conditions are kept as written and never
 * evaluated. External cabinets are read only when the caller supplies them.
 */

export const DEFAULT_MSI_FILE_BYTES = 256 * 1024 ** 2;
export const MAX_MSI_FILE_BYTES = 1024 ** 3;
export const DEFAULT_MSI_DECODED_BYTES = 512 * 1024 ** 2;
export const MAX_MSI_DECODED_BYTES = 2 * 1024 ** 3;
export const MAX_MSI_FILE_PAGE = 10_000;
/** Companion cabinets one call accepts. */
export const MAX_MSI_CABINETS = 64;

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const count = z.number().int().min(0);
const nullableString = z.string().nullable();
const strings = z.array(z.string());

export const inspectWindowsInstallerInputSchema = z.strictObject({
  path: z
    .string()
    .min(1)
    .describe("Absolute path to a caller-selected local .msi file"),
  cabinets: z
    .array(z.string().min(1))
    .max(MAX_MSI_CABINETS)
    .optional()
    .describe(
      "Absolute paths of external cabinets the Media table names, matched by file name; nothing else is searched for",
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
    .max(MAX_MSI_FILE_PAGE)
    .default(1000)
    .describe("Maximum files to return in this page"),
  max_file_bytes: z
    .number()
    .int()
    .min(1)
    .max(MAX_MSI_FILE_BYTES)
    .default(DEFAULT_MSI_FILE_BYTES)
    .describe(
      "Maximum stable bytes to read from the package and from each cabinet (default 256 MiB)",
    ),
  max_decoded_bytes: z
    .number()
    .int()
    .min(1)
    .max(MAX_MSI_DECODED_BYTES)
    .default(DEFAULT_MSI_DECODED_BYTES)
    .describe(
      "Maximum bytes to decode from cabinets in this call (default 512 MiB)",
    ),
});
export type InspectWindowsInstallerInput = z.infer<
  typeof inspectWindowsInstallerInputSchema
>;

const md5Check = z.strictObject({
  declared: z.string(),
  computed: nullableString,
  valid: z.boolean().nullable(),
});

const fileSchema = z.strictObject({
  key: z.string(),
  component: z.string(),
  name: z.string(),
  short_name: nullableString,
  size: count.nullable(),
  version: nullableString,
  language: nullableString,
  attributes: strings,
  sequence: z.number().int().nullable(),
  target_path: z.string(),
  disk_id: z.number().int().nullable(),
  cabinet: nullableString,
  /** embedded: a stream of this database; external: a companion cabinet; uncompressed: beside the package. */
  location: z.enum(["embedded", "external", "uncompressed", "unknown"]),
  /** read: bytes digested; the other states say why they were not (not-read: uncompressed beside the package, or no Media row). */
  status: z.enum([
    "read",
    "cabinet-missing",
    "not-in-cabinet",
    "unsupported-compression",
    "damaged",
    "over-budget",
    "not-read",
  ]),
  sha256: sha256.nullable(),
  /** MsiFileHash recomputed over the cabinet bytes. */
  md5: md5Check.nullable(),
});

export const windowsInstallerReportSchema = z.strictObject({
  artifact: z.strictObject({ path: z.string().min(1), sha256, bytes: count }),
  package: z.strictObject({
    kind: z.literal("msi"),
    name_conflict: nullableString,
  }),
  compound: z.strictObject({
    version: z.union([z.literal(3), z.literal(4)]),
    sector_size: count,
    codepage: z.number().int(),
    streams: z.array(z.strictObject({ name: z.string(), bytes: count })),
    storages: strings,
  }),
  summary: z
    .strictObject({
      codepage: z.number().int().nullable(),
      title: nullableString,
      subject: nullableString,
      author: nullableString,
      keywords: nullableString,
      comments: nullableString,
      template: nullableString,
      platforms: strings,
      languages: z.array(z.number().int()),
      last_saved_by: nullableString,
      revision: nullableString,
      last_printed: nullableString,
      created: nullableString,
      last_saved: nullableString,
      page_count: z.number().int().nullable(),
      word_count: z.number().int().nullable(),
      source_flags: strings,
      character_count: z.number().int().nullable(),
      creating_application: nullableString,
      security: z.number().int().nullable(),
      unknown_properties: count,
      problems: strings,
    })
    .nullable(),
  product: z.strictObject({
    name: nullableString,
    version: nullableString,
    manufacturer: nullableString,
    product_code: nullableString,
    upgrade_code: nullableString,
    language: nullableString,
    all_users: nullableString,
  }),
  properties: z.array(z.strictObject({ name: z.string(), value: z.string() })),
  tables: z.array(
    z.strictObject({ name: z.string(), columns: count, rows: count }),
  ),
  features: z.array(
    z.strictObject({
      id: z.string(),
      parent: nullableString,
      title: nullableString,
      description: nullableString,
      level: z.number().int().nullable(),
      display: z.number().int().nullable(),
      attributes: strings,
      components: strings,
      conditions: z.array(
        z.strictObject({ level: z.number().int(), condition: z.string() }),
      ),
    }),
  ),
  components: z.array(
    z.strictObject({
      id: z.string(),
      guid: nullableString,
      directory: z.string(),
      attributes: strings,
      condition: nullableString,
      key_path: nullableString,
    }),
  ),
  directories: z.array(
    z.strictObject({
      id: z.string(),
      parent: nullableString,
      default_dir: z.string(),
      target_path: z.string(),
      source_path: z.string(),
    }),
  ),
  media: z.array(
    z.strictObject({
      disk_id: z.number().int(),
      last_sequence: z.number().int(),
      disk_prompt: nullableString,
      cabinet: nullableString,
      embedded: z.boolean(),
      volume_label: nullableString,
      source: nullableString,
    }),
  ),
  /** Cabinets that were opened: embedded streams and supplied companions. */
  cabinets: z.array(
    z.strictObject({
      name: z.string(),
      source: z.enum(["embedded", "companion"]),
      path: nullableString,
      sha256,
      bytes: count,
      folders: z.array(
        z.strictObject({ compression: z.string(), blocks: count }),
      ),
      files: count,
      problems: strings,
    }),
  ),
  registry: z.array(
    z.strictObject({
      id: z.string(),
      root: z.string(),
      key: z.string(),
      name: nullableString,
      value: nullableString,
      component: z.string(),
      action: z.enum(["write", "remove"]),
    }),
  ),
  services: z.array(
    z.strictObject({
      kind: z.enum(["install", "control"]),
      id: z.string(),
      name: z.string(),
      display_name: nullableString,
      type: strings,
      start: nullableString,
      error_control: nullableString,
      arguments: nullableString,
      account: nullableString,
      events: strings,
      component: z.string(),
    }),
  ),
  shortcuts: z.array(
    z.strictObject({
      id: z.string(),
      directory: z.string(),
      name: z.string(),
      target: z.string(),
      arguments: nullableString,
      component: z.string(),
    }),
  ),
  environment: z.array(
    z.strictObject({
      id: z.string(),
      name: z.string(),
      flags: strings,
      value: nullableString,
      component: z.string(),
    }),
  ),
  ini_files: z.array(
    z.strictObject({
      id: z.string(),
      file: z.string(),
      directory: nullableString,
      section: z.string(),
      key: z.string(),
      value: nullableString,
      action: z.string(),
      component: z.string(),
    }),
  ),
  /** Declared custom actions with what their Source and Target mean; none is run. */
  custom_actions: z.array(
    z.strictObject({
      id: z.string(),
      type: z.number().int(),
      source_kind: z.string(),
      script: z.enum(["jscript", "vbscript"]).nullable(),
      source: nullableString,
      target: nullableString,
      extended_type: z.number().int().nullable(),
      execution: strings,
      scheduled: z.array(
        z.strictObject({
          table: z.string(),
          sequence: z.number().int().nullable(),
          condition: nullableString,
        }),
      ),
    }),
  ),
  sequences: z.array(
    z.strictObject({
      table: z.string(),
      actions: z.array(
        z.strictObject({
          action: z.string(),
          condition: nullableString,
          sequence: z.number().int().nullable(),
        }),
      ),
    }),
  ),
  launch_conditions: z.array(
    z.strictObject({ condition: z.string(), message: nullableString }),
  ),
  upgrades: z.array(
    z.strictObject({
      upgrade_code: z.string(),
      version_min: nullableString,
      version_max: nullableString,
      language: nullableString,
      attributes: strings,
      remove: nullableString,
      action_property: z.string(),
    }),
  ),
  /** Binary table streams (custom action code or data), digested, never run. */
  binaries: z.array(
    z.strictObject({
      name: z.string(),
      stream: z.string(),
      bytes: count,
      sha256: sha256.nullable(),
      /** "pe" when the stream starts with MZ, "text" when it is UTF-8 without NUL, else "data". */
      kind: z.enum(["pe", "text", "data"]).nullable(),
    }),
  ),
  /** Signature streams by size; never verified. */
  signature: z.strictObject({
    digital_signature: count.nullable(),
    ex: count.nullable(),
    verified: z.literal(false),
  }),
  file_count: count,
  page: z.strictObject({
    start: count,
    limit: z.number().int().min(1),
    returned: count,
    next: count.nullable(),
  }),
  files: z.array(fileSchema),
  diagnostics: z.array(
    z.strictObject({ location: nullableString, message: z.string().min(1) }),
  ),
  coverage: z.array(facetCoverageSchema),
  limitations: strings,
});
export type WindowsInstallerReport = z.infer<
  typeof windowsInstallerReportSchema
>;
