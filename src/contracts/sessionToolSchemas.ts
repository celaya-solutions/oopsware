import { z } from "zod";

import { absoluteLocalPathStringSchema } from "../domain/localPath.js";
import { bundleComparisonInputSchema } from "../domain/bundleComparison.js";

import { processTraceSpecificationSchema } from "../domain/process/processTraceSpecification.js";
import { evidenceSchema } from "../domain/evidence.js";
import { prefixedDigestSchema } from "./../domain/digests.js";
import { evidenceRecordFiltersSchema } from "../domain/evidenceRecordSummary.js";

/** Complete retained Evidence, or selected discovery metadata without payloads. */
export const getEvidenceBundleInputSchema = z.strictObject({
  detail: z.enum(["complete", "summary"]).default("complete"),
  filters: evidenceRecordFiltersSchema.optional(),
});

/** Optional document selection for volatile navigation context. */
export const navigationContextInputSchema = z.strictObject({
  document: z.string().min(1).optional(),
});

/** Explicit reproducible address context query. */
export const addressContextInputSchema = z.strictObject({
  address: z.string().min(1),
  document: z.string().min(1).optional(),
});

/** Session-owned Evidence bundle import options. */
export const importEvidenceBundleInputSchema = z.strictObject({
  path: absoluteLocalPathStringSchema.describe(
    "Absolute local filesystem path for the evidence bundle to import; relative paths are rejected.",
  ),
});

/** MCP compares files selected on the server host, so require explicit paths. */
export const bundleComparisonMcpInputSchema =
  bundleComparisonInputSchema.extend({
    left_bundle_path: absoluteLocalPathStringSchema.describe(
      "Absolute local filesystem path to the left Evidence bundle.",
    ),
    right_bundle_path: absoluteLocalPathStringSchema.describe(
      "Absolute local filesystem path to the right Evidence bundle.",
    ),
  });

/** Evidence references for deterministic process comparison. */
export const processComparisonInputSchema = z.strictObject({
  left: evidenceSchema,
  right: evidenceSchema,
  trace_spec: processTraceSpecificationSchema.optional(),
  max_capture_age_ms: z.number().int().nonnegative().optional(),
});

/** Residual-unknown list filters. */
export const listUnknownsInputSchema = z.strictObject({
  status: z
    .enum(["open", "investigating", "blocked", "contradicted", "resolved"])
    .optional(),
  severity: z.enum(["low", "medium", "high", "critical"]).optional(),
  domain: z.string().trim().min(1).optional(),
  offset: z
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .default(0)
    .describe("Zero-based offset in the stable filtered unknown ID order."),
  limit: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .optional()
    .describe(
      "Optional maximum number of heads to return. Omit to return every matching head from offset.",
    ),
});

/** Exact residual-unknown identity to revalidate. */
export const verifyUnknownResolutionInputSchema = z.strictObject({
  unknown_id: prefixedDigestSchema("unk"),
});
