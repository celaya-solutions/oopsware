import { z } from "zod";

import { facetCoverageSchema } from "../formatRegistry.js";

/**
 * MSIX and AppX packages and bundles read from their bytes (format
 * expansion F08). Nothing is installed, registered or run; manifests are
 * declarations, block maps are recomputed, and signature parts are recorded,
 * never verified or trusted. A bundle's packages keep their own identities;
 * reading one in full takes an explicit `container`.
 */

export const DEFAULT_MSIX_FILE_BYTES = 256 * 1024 ** 2;
export const MAX_MSIX_FILE_BYTES = 1024 ** 3;
export const DEFAULT_MSIX_DECODED_BYTES = 512 * 1024 ** 2;
export const MAX_MSIX_DECODED_BYTES = 2 * 1024 ** 3;
/** Largest single member read (a nested package). */
export const MAX_MSIX_MEMBER_BYTES = 512 * 1024 ** 2;

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const count = z.number().int().min(0);
const nullableString = z.string().nullable();

export const inspectMsixPackageInputSchema = z.strictObject({
  path: z
    .string()
    .min(1)
    .describe(
      "Absolute path to a caller-selected local .msix, .appx, .msixbundle or .appxbundle file",
    ),
  container: z
    .string()
    .min(1)
    .optional()
    .describe(
      "File name of one package inside a bundle to read in full, e.g. App_1.0.0.0_x64.msix",
    ),
  max_file_bytes: z
    .number()
    .int()
    .min(1)
    .max(MAX_MSIX_FILE_BYTES)
    .default(DEFAULT_MSIX_FILE_BYTES)
    .describe("Maximum stable bytes to read from the file (default 256 MiB)"),
  max_decoded_bytes: z
    .number()
    .int()
    .min(1)
    .max(MAX_MSIX_DECODED_BYTES)
    .default(DEFAULT_MSIX_DECODED_BYTES)
    .describe(
      "Maximum bytes to decompress from members in this call (default 512 MiB)",
    ),
});
export type InspectMsixPackageInput = z.infer<
  typeof inspectMsixPackageInputSchema
>;

const identitySchema = z.strictObject({
  name: nullableString,
  publisher: nullableString,
  version: nullableString,
  processor_architecture: nullableString,
  resource_id: nullableString,
});
const resourceSchema = z.strictObject({
  language: nullableString,
  scale: nullableString,
  dx_feature_level: nullableString,
});
const deviceFamilySchema = z.strictObject({
  name: nullableString,
  min_version: nullableString,
  max_version_tested: nullableString,
});
const extensionSchema = z.strictObject({
  category: nullableString,
  namespace: nullableString,
  executable: nullableString,
  entry_point: nullableString,
  names: z.array(z.string()),
});

/** AppxManifest.xml declarations; a declared capability or extension is never a grant. */
export const appxManifestSchema = z.strictObject({
  namespace: z.string(),
  schema: z.enum(["windows10", "windows8"]),
  identity: identitySchema.nullable(),
  properties: z.strictObject({
    display_name: nullableString,
    publisher_display_name: nullableString,
    logo: nullableString,
    description: nullableString,
    resource_package: z.boolean().nullable(),
    framework: z.boolean().nullable(),
  }),
  target_device_families: z.array(deviceFamilySchema),
  os_min_version: nullableString,
  os_max_version_tested: nullableString,
  package_dependencies: z.array(
    z.strictObject({
      kind: z.enum(["package", "main"]),
      name: nullableString,
      publisher: nullableString,
      min_version: nullableString,
      max_major_version_tested: nullableString,
    }),
  ),
  resources: z.array(resourceSchema),
  applications: z.array(
    z.strictObject({
      id: nullableString,
      executable: nullableString,
      entry_point: nullableString,
      trust_level: nullableString,
      runtime_behavior: nullableString,
      extensions: z.array(extensionSchema),
    }),
  ),
  package_extensions: z.array(extensionSchema),
  capabilities: z.array(
    z.strictObject({
      name: nullableString,
      kind: z.enum([
        "general",
        "uap",
        "restricted",
        "device",
        "custom",
        "other",
      ]),
      namespace: nullableString,
    }),
  ),
  problems: z.array(z.string()),
});

const bundlePackageSchema = z.strictObject({
  type: nullableString,
  version: nullableString,
  architecture: nullableString,
  resource_id: nullableString,
  file_name: nullableString,
  offset: count.nullable(),
  size: count.nullable(),
  resources: z.array(resourceSchema),
  target_device_families: z.array(deviceFamilySchema),
});

const blockMapSchema = z.strictObject({
  hash: z.enum(["sha256", "sha384", "sha512"]).nullable(),
  files: count,
  /** Every listed block's digest matches the member's bytes, sizes agree and nothing is missing. */
  verified: z.boolean(),
  mismatched: z.array(
    z.strictObject({ path: z.string(), blocks: z.array(count) }),
  ),
  missing: z.array(z.string()),
  /** Present but refused by the ZIP reader (for example a CRC-32 mismatch); diagnostics say why. */
  unreadable: z.array(z.string()),
  size_mismatches: z.array(z.string()),
  unlisted: z.array(z.string()),
});

const signatureSchema = z.strictObject({
  bytes: count,
  magic: z.boolean(),
  pkcs7_bytes: count,
  pkcs7_sha256: sha256,
  der_length: count.nullable(),
  problems: z.array(z.string()),
  /** Always false: the signature, its signer and its chain are recorded, never checked. */
  verified: z.literal(false),
});

/** The parts of one package (the file itself, or a package inside a bundle). */
const packagePartsSchema = z.strictObject({
  container: nullableString,
  manifest: appxManifestSchema.nullable(),
  manifest_error: nullableString,
  block_map: blockMapSchema.nullable(),
  block_map_error: nullableString,
  signature: signatureSchema.nullable(),
  code_integrity_catalog: z.boolean(),
  content_types: z.boolean(),
  members: count,
});

export const msixPackageReportSchema = z.strictObject({
  artifact: z.strictObject({ path: z.string().min(1), sha256, bytes: count }),
  package: z.strictObject({
    kind: z.enum(["msix", "appx", "msixbundle", "appxbundle"]),
    /** `layout`: an AppxManifest or bundle manifest establishes it; the msix/appx naming comes from the suffix. */
    basis: z.enum(["layout"]),
    name_conflict: nullableString,
  }),
  /** The file itself when it is a package, or the bundle package `container` names. */
  parts: packagePartsSchema.nullable(),
  bundle: z
    .strictObject({
      schema_version: nullableString,
      identity: identitySchema.nullable(),
      packages: z.array(
        bundlePackageSchema.extend({
          /** The declared offset and size checked against the bundle's ZIP. */
          layout_matches: z.boolean().nullable(),
          actual_offset: count.nullable(),
          actual_size: count.nullable(),
          /** The nested package's own manifest identity and block map, read for every package. */
          manifest_identity: identitySchema.nullable(),
          block_map_verified: z.boolean().nullable(),
          error: nullableString,
        }),
      ),
      optional_bundles: z.array(
        z.strictObject({
          name: nullableString,
          publisher: nullableString,
          version: nullableString,
          file_name: nullableString,
          packages: z.array(bundlePackageSchema),
        }),
      ),
      /** Architectures of the application packages; several mean a choice that depends on the device. */
      architectures: z.array(z.string()),
      problems: z.array(z.string()),
      /** The bundle's own block map and signature part. */
      parts: packagePartsSchema,
    })
    .nullable(),
  diagnostics: z.array(
    z.strictObject({ location: nullableString, message: z.string().min(1) }),
  ),
  coverage: z.array(facetCoverageSchema),
  limitations: z.array(z.string()),
});
export type MsixPackageReport = z.infer<typeof msixPackageReportSchema>;
