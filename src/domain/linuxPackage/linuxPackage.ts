import { z } from "zod";

import { facetCoverageSchema } from "../formatRegistry.js";

/**
 * Linux packages read from their bytes (format expansion F05): Debian
 * packages, RPM packages, Type 2 AppImages and bare SquashFS images. Nothing
 * is installed, no maintainer script or scriptlet runs, no AppImage is
 * executed or mounted, and declared signatures are recorded, never verified
 * or trusted. Declarations (dependencies, scripts, conffiles) are data.
 */

/** Default and maximum bytes read for one local package. */
export const DEFAULT_LINUX_FILE_BYTES = 256 * 1024 ** 2;
export const MAX_LINUX_FILE_BYTES = 1024 ** 3;
/** Default and maximum bytes decoded from compressed members in one call. */
export const DEFAULT_LINUX_DECODED_BYTES = 512 * 1024 ** 2;
export const MAX_LINUX_DECODED_BYTES = 2 * 1024 ** 3;
/** Largest page of files one call returns. */
export const MAX_LINUX_FILE_PAGE = 10_000;
/** Script and desktop-entry text beyond this many bytes is cut and says so. */
export const MAX_LINUX_SCRIPT_BYTES = 256 * 1024;

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const count = z.number().int().min(0);
const offset = z.number().int().min(0);
const nullableString = z.string().nullable();

export const inspectLinuxPackageInputSchema = z.strictObject({
  path: z
    .string()
    .min(1)
    .describe(
      "Absolute path to a caller-selected local .deb, .rpm, .AppImage or SquashFS image",
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
    .max(MAX_LINUX_FILE_PAGE)
    .default(1000)
    .describe("Maximum files to return in this page"),
  max_file_bytes: z
    .number()
    .int()
    .min(1)
    .max(MAX_LINUX_FILE_BYTES)
    .default(DEFAULT_LINUX_FILE_BYTES)
    .describe("Maximum stable bytes to read from the file (default 256 MiB)"),
  max_decoded_bytes: z
    .number()
    .int()
    .min(1)
    .max(MAX_LINUX_DECODED_BYTES)
    .default(DEFAULT_LINUX_DECODED_BYTES)
    .describe(
      "Maximum bytes to decode from compressed members in this call (default 512 MiB)",
    ),
});
export type InspectLinuxPackageInput = z.infer<
  typeof inspectLinuxPackageInputSchema
>;

const diagnosticSchema = z.strictObject({
  /** Where in the package: a member, a header, or a file path. */
  location: nullableString,
  offset: offset.nullable(),
  message: z.string().min(1),
});
export type LinuxDiagnostic = z.infer<typeof diagnosticSchema>;

const dependencySchema = z.strictObject({
  /** Declaration field, e.g. depends, pre-depends, requires, provides, conflicts. */
  kind: z.string().min(1),
  /** Alternatives any one of which satisfies the declaration (a | b in Debian). */
  alternatives: z.array(
    z.strictObject({
      name: z.string(),
      operator: z.enum(["<<", "<=", "=", ">=", ">>", "<", ">"]).nullable(),
      version: nullableString,
      /** Debian `:arch` qualifier. */
      architecture: nullableString,
      /** RPM sense flags such as pre, post, interp, rpmlib. */
      flags: z.array(z.string()),
    }),
  ),
  /** RPM rich (boolean) dependency kept as written. */
  rich: z.boolean(),
  text: z.string(),
});

const scriptSchema = z.strictObject({
  /** preinst, postinst, prerm, postrm, config (Debian); pre, post, preun, postun, pretrans, posttrans ... (RPM). */
  name: z.string().min(1),
  interpreter: nullableString,
  bytes: count,
  sha256,
  /** The script as text (UTF-8); null when it is not text. Never run. */
  text: nullableString,
  truncated: z.boolean(),
});

const triggerSchema = z.strictObject({
  kind: z.string().min(1),
  condition: z.string(),
  interpreter: nullableString,
  text: nullableString,
});

const digestCheckSchema = z.strictObject({
  algorithm: z.string(),
  declared: z.string(),
  computed: nullableString,
  /** Null when the bytes were not available to compare. */
  valid: z.boolean().nullable(),
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
    "socket",
    "unknown",
  ]),
  /** Permission bits as octal text, e.g. "0755", "4755". */
  mode: nullableString,
  /** setuid, setgid and sticky, as declared; never applied. */
  special: z.array(z.enum(["setuid", "setgid", "sticky"])),
  uid: count.nullable(),
  gid: count.nullable(),
  user: nullableString,
  group: nullableString,
  size: count.nullable(),
  mtime: z.number().int().nullable(),
  link_target: nullableString,
  /** conffile, config, noreplace, doc, license, ghost, missingok ... */
  flags: z.array(z.string()),
  digest: digestCheckSchema.nullable(),
});

const debSchema = z.strictObject({
  format_version: nullableString,
  members: z.array(z.strictObject({ name: z.string(), offset, size: count })),
  control_compression: nullableString,
  data_compression: nullableString,
  /** Control fields in file order, values as written. */
  fields: z.array(z.strictObject({ name: z.string(), value: z.string() })),
  conffiles: z.array(z.string()),
  /** md5sums declared in the control archive, recomputed over the data members. */
  md5sums: z
    .strictObject({
      declared: count,
      matched: count,
      mismatched: z.array(z.string()),
      missing: z.array(z.string()),
      /** Regular files the data archive holds that md5sums does not list. */
      unlisted: count,
    })
    .nullable(),
  /** Control archive members other than control, md5sums, conffiles, triggers and scripts. */
  other_control_files: z.array(z.string()),
  /** _gpg* members: present, never verified. */
  signatures: z.array(z.string()),
});

const rpmSchema = z.strictObject({
  lead: z.strictObject({
    version: z.string(),
    type: z.string(),
    name: z.string(),
  }),
  license: nullableString,
  url: nullableString,
  vendor: nullableString,
  packager: nullableString,
  group: nullableString,
  build_time: z.number().int().nullable(),
  build_host: nullableString,
  source_rpm: nullableString,
  installed_size: count.nullable(),
  description: nullableString,
  payload: z.strictObject({
    format: nullableString,
    compressor: nullableString,
    flags: nullableString,
    /** PAYLOADDIGEST over the compressed payload, recomputed. */
    digest: digestCheckSchema.nullable(),
  }),
  header_digests: z.array(digestCheckSchema),
  file_digest_algorithm: nullableString,
  /** Signature packets present (byte lengths); none is verified or trusted. */
  signatures: z.array(z.strictObject({ tag: z.string(), bytes: count })),
  changelog_entries: count,
});

const desktopSchema = z.strictObject({
  path: z.string(),
  /** Desktop Entry group keys as written (localized keys keep their locale). */
  entries: z.array(
    z.strictObject({
      key: z.string(),
      locale: nullableString,
      value: z.string(),
    }),
  ),
  problems: z.array(z.string()),
});

const superblockSchema = z.strictObject({
  version: z.string(),
  compression: z.string(),
  block_size: count,
  inode_count: count,
  fragment_count: count,
  bytes_used: count,
  mkfs_time: count,
  flags: z.array(z.string()),
});

const appImageSchema = z.strictObject({
  type: z.union([z.literal(1), z.literal(2)]),
  runtime: z.strictObject({
    bytes: count,
    sha256,
    elf_class: z.enum(["32", "64"]),
    machine: z.string(),
  }),
  update_information: nullableString,
  /** .sha256_sig / .sig_key sections: present, never verified. */
  signature_bytes: count.nullable(),
  signing_key_bytes: count.nullable(),
  digest_md5: nullableString,
  squashfs_offset: offset.nullable(),
  desktop: desktopSchema.nullable(),
  /** AppRun, the entry point the runtime would execute; recorded, never run. */
  app_run: z
    .strictObject({
      type: z.string(),
      interpreter: nullableString,
      elf_machine: nullableString,
      link_target: nullableString,
    })
    .nullable(),
  icon: nullableString,
});

export const linuxPackageReportSchema = z.strictObject({
  artifact: z.strictObject({ path: z.string().min(1), sha256, bytes: count }),
  package: z.strictObject({
    kind: z.enum(["deb", "rpm", "appimage", "squashfs"]),
    /** Set when the file name suggests a different kind than the bytes. */
    name_conflict: nullableString,
  }),
  identity: z.strictObject({
    name: nullableString,
    version: nullableString,
    release: nullableString,
    epoch: z.number().int().nullable(),
    architecture: nullableString,
    summary: nullableString,
  }),
  dependencies: z.array(dependencySchema),
  scripts: z.array(scriptSchema),
  triggers: z.array(triggerSchema),
  deb: debSchema.nullable(),
  rpm: rpmSchema.nullable(),
  appimage: appImageSchema.nullable(),
  squashfs: superblockSchema.nullable(),
  /** Every file the package declares or holds, in package order. */
  file_count: count,
  page: z.strictObject({
    start: count,
    limit: z.number().int().min(1),
    returned: count,
    next: count.nullable(),
  }),
  files: z.array(fileSchema),
  /** Decoders that ran (in process or installed xz), as provenance. */
  decoders: z.array(
    z.strictObject({
      tool: z.string(),
      version: nullableString,
      executable_sha256: sha256.nullable(),
    }),
  ),
  diagnostics: z.array(diagnosticSchema),
  coverage: z.array(facetCoverageSchema),
  limitations: z.array(z.string()),
});
export type LinuxPackageReport = z.infer<typeof linuxPackageReportSchema>;
