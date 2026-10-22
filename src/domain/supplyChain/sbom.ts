import { z } from "zod";
import { digestSchema } from "../digests.js";
import { localPathStringSchema } from "../localPath.js";

export const generateSbomInputSchema = z.strictObject({
  path: localPathStringSchema.describe(
    "Local file or directory; links are not followed.",
  ),
  max_files: z
    .number()
    .int()
    .min(1)
    .max(100_000)
    .default(10_000)
    .describe("Maximum examined directory entries or ZIP members."),
  max_input_bytes: z
    .number()
    .int()
    .min(1)
    .max(256 * 1024 * 1024)
    .default(64 * 1024 * 1024)
    .describe("Maximum aggregate file bytes and decoded ZIP metadata bytes."),
  max_components: z.number().int().min(1).max(50_000).default(5_000),
  max_output_bytes: z
    .number()
    .int()
    .min(1)
    .max(16 * 1024 * 1024)
    .default(4 * 1024 * 1024),
});

const propertySchema = z.strictObject({ name: z.string(), value: z.string() });
const componentSchema = z.strictObject({
  type: z.literal("library"),
  "bom-ref": z.string().min(1),
  name: z.string().min(1),
  group: z.string().optional(),
  version: z.string().min(1).optional(),
  purl: z.string().optional(),
  licenses: z
    .array(
      z.strictObject({ license: z.strictObject({ name: z.string().min(1) }) }),
    )
    .optional(),
  properties: z.array(propertySchema),
});

/** A deliberately small, valid subset of the CycloneDX 1.6 JSON vocabulary. */
export const cycloneDxSchema = z.strictObject({
  bomFormat: z.literal("CycloneDX"),
  specVersion: z.literal("1.6"),
  version: z.literal(1),
  components: z.array(componentSchema),
  dependencies: z.array(
    z.strictObject({ ref: z.string(), dependsOn: z.array(z.string()) }),
  ),
});

export const licenseFindingSchema = z.strictObject({
  source: z.string(),
  sha256: digestSchema,
  component_ref: z.string().nullable(),
  evidence_kind: z.enum(["declared", "inferred", "unknown"]),
  value: z.string(),
  matched_license: z.string().nullable(),
});

export const sbomReportSchema = z.strictObject({
  artifact: z.strictObject({
    path: localPathStringSchema,
    sha256: digestSchema.nullable(),
    bytes: z.number().int().nonnegative().nullable(),
  }),
  sbom: cycloneDxSchema,
  licenses: z.array(licenseFindingSchema),
  coverage: z.strictObject({
    state: z.enum(["partial", "unknown"]),
    files_examined: z.number().int().nonnegative(),
    files_read: z.number().int().nonnegative(),
    bytes_read: z.number().int().nonnegative(),
    decoded_bytes: z.number().int().nonnegative(),
    ecosystems: z.array(z.enum(["npm", "pypi", "maven", "golang", "cargo"])),
    dependency_relationships: z.enum(["partial", "unknown"]),
    license_detection: z.literal("partial"),
  }),
  limitations: z.array(z.string()),
});

export type GenerateSbomInput = z.infer<typeof generateSbomInputSchema>;
export type SbomReport = z.infer<typeof sbomReportSchema>;
export type SbomComponent = z.infer<typeof componentSchema>;
export type LicenseFinding = z.infer<typeof licenseFindingSchema>;
