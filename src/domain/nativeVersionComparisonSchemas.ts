import { z } from "zod";
import { evidenceSchema } from "./evidence.js";
import { jsonValueSchema } from "./jsonValue.js";
import { functionComparisonResultSchema } from "./functionComparisonSchemas.js";
import { analysisProviderSelectorSchema } from "../contracts/providerSelection.js";

const address = z.string().regex(/^0x[0-9a-f]+$/iu);
const target = z.strictObject({
  path: z.string().min(1),
  expected_sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .exactOptional(),
});
export const nativeVersionPairSchema = z.strictObject({
  left_address: address,
  right_address: address,
});
/** Two explicit binaries; selected pairs resolve analyst-disputed relationships. */
export const nativeVersionComparisonInputSchema = z.strictObject({
  left: target,
  right: target,
  provider_id: analysisProviderSelectorSchema.exactOptional(),
  selected_pairs: z.array(nativeVersionPairSchema).default([]),
});
const functionReference = z.strictObject({
  address,
  name: z.string(),
  evidence_id: z.string(),
});
const signal = z.strictObject({
  facet: z.enum([
    "artifact_address",
    "assembly",
    "cfg",
    "imports",
    "strings",
    "constants",
    "intermediate_representation",
  ]),
  method: z.string(),
  left: z.array(z.string()),
  right: z.array(z.string()),
  similarity: z.number().min(0).max(1),
});
const candidate = z.strictObject({
  left: functionReference,
  right: functionReference,
  score: z.number().min(0).max(1),
  method: z.enum([
    "artifact-address-identity",
    "unique-exact-representation",
    "structural-candidate",
    "analyst-selected",
  ]),
  selection: z.enum([
    "exact-identity",
    "unique-exact-representation",
    "disputed",
    "analyst-selected",
  ]),
  signals: z.array(signal),
  unavailable_facets: z.array(z.string()),
});
/** Discovery and exact comparison are separate result sections. Scores are rankings only. */
export const nativeCandidateDiscoverySchema = z.strictObject({
  candidates: z.array(candidate),
  changed_candidates: z.array(nativeVersionPairSchema),
  ambiguous: z.array(
    z.strictObject({
      side: z.enum(["left", "right"]),
      function: functionReference,
      alternatives: z.array(functionReference),
    }),
  ),
  collisions: z.array(
    z.strictObject({
      facet: z.string(),
      fingerprint: z.string(),
      left: z.array(functionReference),
      right: z.array(functionReference),
    }),
  ),
  removed_candidates: z.array(functionReference),
  added_candidates: z.array(functionReference),
  comparisons: z.array(
    z.strictObject({
      left: functionReference,
      right: functionReference,
      selection: z.enum([
        "exact-identity",
        "unique-exact-representation",
        "analyst-selected",
      ]),
      comparison: functionComparisonResultSchema,
    }),
  ),
});
const side = z.strictObject({
  path: z.string(),
  sha256: z.string(),
  format: z.enum(["mach-o", "elf"]),
  architecture: z.enum(["arm64", "x86_64"]),
  inventory: evidenceSchema,
  functions: z.array(evidenceSchema),
  failures: z.array(
    z.strictObject({
      address: z.string(),
      reason: z.string(),
      error: jsonValueSchema.nullable(),
    }),
  ),
});
export const nativeVersionComparisonResultSchema =
  nativeCandidateDiscoverySchema.extend({
    left: side,
    right: side,
    completeness: z.enum(["provider-inventory", "partial"]),
    limitations: z.array(z.string()),
  });
export type NativeVersionComparisonInput = z.output<
  typeof nativeVersionComparisonInputSchema
>;
export type NativeVersionSide = z.infer<typeof side>;
export type NativeCandidateDiscovery = z.infer<
  typeof nativeCandidateDiscoverySchema
>;
