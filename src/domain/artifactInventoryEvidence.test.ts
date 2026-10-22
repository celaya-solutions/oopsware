import { freezeJsonSnapshot } from "./immutableJson.js";
import { expect, it } from "vitest";

import { ARTIFACT_COMPARISON_EXAMPLE } from "../contracts/artifactComparisonExample.js";
import { createArtifactInspection } from "./artifactInspection.js";
import {
  parseArtifactInventoryEvidence,
  parseArtifactInspectionInventoryResult,
} from "./artifactInventoryEvidence.js";
import { createEvidence } from "./evidence.js";
import { jsonValueSchema } from "./jsonValue.js";

const inventoryEvidence = ARTIFACT_COMPARISON_EXAMPLE.left;
const target = inventoryEvidence.subject;
if (target === null) throw new Error("Artifact fixture has no target");

const inspectionEvidence = (result: unknown, subject = target) =>
  createEvidence(
    {
      path: subject.local_path,
      sha256: subject.digest.sha256,
      format: subject.format,
    },
    inventoryEvidence.provider,
    {
      operation: "inspect_artifact",
      parameters: {},
      result: jsonValueSchema.parse(result),
      confidence: "observed",
      authority: "shipped-artifact",
    },
  );

const inspection = createArtifactInspection(inventoryEvidence);

it("accepts an inspection whose carrier, declaration, and substep identities agree", () => {
  expect(
    parseArtifactInventoryEvidence(inspectionEvidence(inspection)).inventory,
  ).toMatchObject({ complete: true, coverage: { status: "complete" } });
});

it("rejects an inspection carrier whose Evidence subject disagrees with its nested inventory", () => {
  const carrier = inspectionEvidence(inspection, {
    ...target,
    digest: { sha256: "a".repeat(64) },
  });
  expect(() => parseArtifactInventoryEvidence(carrier)).toThrow(
    "Artifact inspection Evidence subject does not match its root manifest",
  );
});

it("rejects an inspection declaration whose root manifest disagrees with its nested inventory", () => {
  const mismatched = {
    ...inspection,
    subject: {
      ...inspection.subject,
      root_artifact_id: `art_${"f".repeat(64)}`,
    },
  };
  expect(() =>
    parseArtifactInventoryEvidence(inspectionEvidence(mismatched)),
  ).toThrow(
    "Artifact inspection subject does not match its inventory manifest",
  );
});

it("rejects a substep evidence ID that disagrees with its authenticated nested Evidence", () => {
  const [first, ...remaining] = inspection.substeps;
  if (first === undefined) throw new Error("Expected inventory substep");
  const mismatched = {
    ...inspection,
    substeps: [{ ...first, evidence_id: `ev_${"f".repeat(64)}` }, ...remaining],
  };
  expect(() =>
    parseArtifactInventoryEvidence(inspectionEvidence(mismatched)),
  ).toThrow(
    "Artifact inspection substep evidence ID does not match nested Evidence",
  );
});

it("retains the authenticated parent's nested facts without a second inventory copy", () => {
  const owned = freezeJsonSnapshot(createArtifactInspection(inventoryEvidence));
  const parsed = parseArtifactInspectionInventoryResult(owned, target);
  expect(parsed.inspection).toBe(owned);
  expect(parsed.inventory.nodes[0]).toBe(
    owned.substeps[0]!.evidence.normalized_result.nodes[0],
  );
});
