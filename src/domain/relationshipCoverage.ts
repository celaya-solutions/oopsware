import { z } from "zod";

import { fixedTupleSchema } from "./fixedTupleSchema.js";

const diagnostics = z.array(z.string().min(1)).min(1).exactOptional();
const completeCoverage = z.strictObject({
  status: z.literal("complete"),
  diagnostics,
});
const limitedDirections = z.union([
  fixedTupleSchema([z.literal("callers")]),
  fixedTupleSchema([z.literal("callees")]),
  fixedTupleSchema([z.literal("callers"), z.literal("callees")]),
]);
const partialCoverage = z.strictObject({
  status: z.literal("partial"),
  limitations: z.array(z.string().min(1)).min(1),
  limited_directions: limitedDirections.exactOptional(),
  diagnostics,
});
const unknownCoverage = z.strictObject({
  status: z.literal("unknown"),
  reason: z.string().min(1),
  limited_directions: limitedDirections.exactOptional(),
  diagnostics,
});

/** Explicit coverage state for a provider's observed caller/callee set. */
export const relationshipCoverageSchema = z.discriminatedUnion("status", [
  completeCoverage,
  partialCoverage,
  unknownCoverage,
]);

export type RelationshipCoverage = z.infer<typeof relationshipCoverageSchema>;

/** Reasons the observed relationship inventory cannot establish completeness. */
export const relationshipCoverageLimitations = (
  coverage: RelationshipCoverage | null | undefined,
): readonly string[] => {
  switch (coverage?.status) {
    case undefined:
      return ["Provider did not report relationship coverage."];
    case "complete":
      return [];
    case "partial":
      return coverage.limitations;
    case "unknown":
      return [coverage.reason];
  }
};
