import { createHash } from "node:crypto";

import canonicalize from "canonicalize";
import { z } from "zod";

import {
  hasCompleteInventoryCoverage,
  type ParsedInventorySet,
} from "./artifactInventoryEvidence.js";
import { evidenceSchema } from "./evidence.js";
import { digestSchema } from "./digests.js";
import { prefixedDigestSchema } from "./digests.js";
import {
  bridgeCandidateCoverageSchema,
  projectCartesianCandidates,
} from "./bridgeCandidateProjection.js";

/** Evidence-scoped identifier schemas shared by application graph projections. */
export const projectionEvidenceIdSchema = prefixedDigestSchema("ev");
export const projectionPathSchema = z.string().min(1);

/** Inventory pages accepted by every application graph projection. */
export const applicationInventoryProjectionInputSchema = z.strictObject({
  inventory_evidence: z.array(evidenceSchema).min(1),
});

/** One authenticated inventory entry retained by application graph projections. */
export const projectedComponentSchema = z.strictObject({
  path: projectionPathSchema,
  artifact_id: prefixedDigestSchema("art"),
  sha256: digestSchema,
  format: z.string().min(1),
});

/** Inventoried paths whose content identity is unavailable, retained as unknown. */
export const unavailableComponentSchema = z.strictObject({
  path: projectionPathSchema,
  artifact_id: z.null(),
  sha256: z.null(),
  format: z.string().min(1),
  encrypted: z.boolean(),
  limitations: z.array(z.string()),
});

export type ProjectedComponent = z.infer<typeof projectedComponentSchema>;

/** Path-pair hypotheses connecting managed content to a native library. */
export const projectedBridgeCandidateSchema = <
  Basis extends readonly [string, ...string[]],
>(
  basis: Basis,
) =>
  z.strictObject({
    managed_path: projectionPathSchema,
    native_path: projectionPathSchema,
    basis: z.enum(basis),
  });

/** Coverage status combining inventory completeness with a projection budget. */
export const projectionCoverage = (
  inventory: ParsedInventorySet["inventory"],
  budgetComplete: boolean,
): {
  status: "complete-within-inventory" | "partial";
  /** True when all manifest graph-member counts are present, independent of source coverage. */
  inventory_complete: boolean;
} => ({
  status:
    hasCompleteInventoryCoverage(inventory, "container-entries") &&
    budgetComplete
      ? ("complete-within-inventory" as const)
      : ("partial" as const),
  inventory_complete: inventory.complete,
});

/** One occurrence, preserving entry kind and either authenticated or unavailable content. */
export type ProjectedInventoryEntry = {
  readonly path: string;
  readonly kind: ParsedInventorySet["inventory"]["occurrences"][number]["entry_kind"];
} & (
  | { readonly component: ProjectedComponent; readonly unavailable: undefined }
  | {
      readonly component: undefined;
      readonly unavailable: z.infer<typeof unavailableComponentSchema>;
    }
);

/** Interpret identity once, before application-specific attribution and classification. */
export const projectedInventoryEntries = (
  inventory: ParsedInventorySet["inventory"],
): ProjectedInventoryEntry[] => {
  const nodes = new Map(
    inventory.nodes.map((node) => [node.artifact_id, node]),
  );
  return inventory.occurrences
    .filter(({ logical_path }) => logical_path !== ".")
    .map((occurrence): ProjectedInventoryEntry => {
      const path = occurrence.logical_path;
      const kind = occurrence.entry_kind;
      if (occurrence.artifact_id === null)
        return {
          path,
          kind,
          component: undefined,
          unavailable: {
            path,
            artifact_id: null,
            sha256: null,
            format: occurrence.artifact_format,
            encrypted: occurrence.encrypted,
            limitations: occurrence.limitations,
          },
        };
      const node = nodes.get(occurrence.artifact_id);
      if (node === undefined)
        throw new TypeError(
          "Application projection occurrence has no artifact node",
        );
      return {
        path,
        kind,
        component: {
          path,
          artifact_id: node.artifact_id,
          sha256: node.sha256,
          format: occurrence.artifact_format,
        },
        unavailable: undefined,
      };
    });
};

/** Directory trees and links retain inventory identity but are not file components. */
export const projectedFileComponents = (
  entries: readonly ProjectedInventoryEntry[],
): ProjectedComponent[] =>
  entries.flatMap(({ kind, component }) =>
    (kind === "file" || kind === "slice") && component !== undefined
      ? [component]
      : [],
  );

export { bridgeCandidateCoverageSchema, projectCartesianCandidates };

/** Digest a canonical JSON projection payload for its stable identifier. */
export const projectionDigest = (value: unknown, label: string): string => {
  const encoded = canonicalize(value);
  if (encoded === undefined)
    throw new TypeError(`${label} is not canonical JSON`);
  return createHash("sha256").update(encoded).digest("hex");
};
