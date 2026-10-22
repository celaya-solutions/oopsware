import { z } from "zod";
import { localPathStringSchema } from "../localPath.js";

export const checkVulnerabilitiesInputSchema = z.strictObject({
  path: localPathStringSchema.describe(
    "Local CycloneDX 1.6 JSON SBOM, or generate_sbom Evidence containing normalized_result.sbom",
  ),
  database: localPathStringSchema.describe(
    "Explicit local OSV JSON snapshot file or directory; never downloaded or updated",
  ),
});
export type CheckVulnerabilitiesInput = z.infer<
  typeof checkVulnerabilitiesInputSchema
>;

const count = z.number().int().nonnegative();
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const vulnerabilityComponentSchema = z.strictObject({
  bom_ref: z.string(),
  name: z.string(),
  version: z.string().nullable(),
  purl: z.string().nullable(),
  ecosystem: z.enum(["npm", "PyPI", "Maven", "Go", "crates.io"]).nullable(),
  package_name: z.string().nullable(),
});
export type VulnerabilityComponent = z.infer<
  typeof vulnerabilityComponentSchema
>;

const assessmentSchema = z.strictObject({
  component: vulnerabilityComponentSchema,
  advisory_ids: z.array(z.string()),
  reasons: z.array(z.string()),
});
export const vulnerabilityReportSchema = z.strictObject({
  artifact: z.strictObject({ path: z.string(), sha256: digest, bytes: count }),
  database: z.strictObject({
    path: z.string(),
    sha256: digest,
    bytes: count,
    files: count,
    digest_basis: z.enum(["file-bytes", "sorted-relative-path-sha256-bytes"]),
    records: count,
    withdrawn_records: count,
    generated_at: z.string().nullable(),
    age_days: z.number().nullable(),
    freshness: z.enum(["dated", "stale", "undated", "future-dated"]),
    stale_after_days: count,
    coverage: z.literal("unknown"),
    coverage_detail: z.string(),
  }),
  findings: z.array(
    z.strictObject({
      component: vulnerabilityComponentSchema,
      id: z.string(),
      aliases: z.array(z.string()),
      summary: z.string().nullable(),
      modified: z.string(),
      published: z.string().nullable(),
      severity: z.array(
        z.strictObject({ type: z.string(), score: z.string() }),
      ),
      references: z.array(
        z.strictObject({ type: z.string(), url: z.string() }),
      ),
      source: z.strictObject({
        file: z.string(),
        sha256: digest,
        record_index: count,
      }),
      evidence: z.array(
        z.strictObject({
          affected_index: count,
          basis: z.enum(["explicit-version", "range"]),
          version: z.string(),
          range_index: count.nullable(),
          range_type: z.string().nullable(),
          events: z.array(z.record(z.string(), z.string())),
        }),
      ),
    }),
  ),
  unmatched_components: z.array(assessmentSchema),
  unassessed_components: z.array(assessmentSchema),
  summary: z.strictObject({
    components: count,
    findings: count,
    affected_components: count,
    unmatched_components: count,
    unassessed_components: count,
  }),
  limitations: z.array(z.string()),
});
export type VulnerabilityReport = z.infer<typeof vulnerabilityReportSchema>;
