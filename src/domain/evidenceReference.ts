import { z } from "zod";
import { prefixedDigestSchema } from "./digests.js";

/** Exact reference to Evidence already retained by the current session. */
export const retainedEvidenceReferenceSchema = z.strictObject({
  kind: z.literal("retained-evidence"),
  evidence_id: prefixedDigestSchema("ev"),
});

import { evidenceSchema } from "./evidence.js";

/** Portable observation or exact retained identity; semantic authentication follows admission. */
export const evidenceInputSchema = z.union([
  evidenceSchema,
  retainedEvidenceReferenceSchema,
]);
export type EvidenceInput = z.output<typeof evidenceInputSchema>;
