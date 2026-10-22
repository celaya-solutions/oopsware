import {
  generateSbomInputSchema,
  sbomReportSchema,
} from "../domain/supplyChain/sbom.js";
import {
  checkVulnerabilitiesInputSchema,
  vulnerabilityReportSchema,
} from "../domain/supplyChain/vulnerabilities.js";
import {
  verifyArtifactSignatureInputSchema,
  signatureReportSchema,
} from "../domain/supplyChain/signatures.js";
import type { ToolContract } from "./toolContractTypes.js";
import { toolContractMetadata } from "./toolEffects.js";
import { evidenceResultOf } from "./toolOutputSchemaPrimitives.js";

export const SUPPLY_CHAIN_TOOL_CONTRACTS = [
  {
    name: "generate_sbom",
    ...toolContractMetadata("generate_sbom"),
    kind: "artifact-provider",
    description:
      "Build a CycloneDX 1.6 software bill of materials from an explicit local file or directory. Reuse package metadata for npm, Python wheels, JVM JARs, Go and Rust where available, with source paths and digests. Return license declarations separately from inferred license-text matches. Missing versions, dependency relationships and unreadable profiles remain explicit coverage limits. No network, package installation, or target execution. The sbom field is portable CycloneDX JSON; check_vulnerabilities also accepts the complete saved Evidence reply.",
    inputSchema: generateSbomInputSchema,
    outputSchema: evidenceResultOf(sbomReportSchema),
    examples: [
      {
        title: "Inventory a local application",
        input: { path: "/artifacts/application" },
      },
    ],
  },
  {
    name: "check_vulnerabilities",
    ...toolContractMetadata("check_vulnerabilities"),
    kind: "artifact-provider",
    description:
      "Match a local CycloneDX 1.6 SBOM, or saved generate_sbom Evidence, against an explicitly supplied offline OSV snapshot file or directory. Return advisory matches, unresolved assessments, database identity and age, and version-comparison coverage. Exact package identities and supported affected-version ranges are required; unknown versions or unsupported ranges are unassessed. No matches means only no matches in this supplied snapshot, never a clean or safe verdict. No downloads or network access.",
    inputSchema: checkVulnerabilitiesInputSchema,
    outputSchema: evidenceResultOf(vulnerabilityReportSchema),
    examples: [
      {
        title: "Check against a local OSV snapshot",
        input: {
          path: "/artifacts/application-sbom.json",
          database: "/artifacts/osv-snapshot.json",
        },
      },
    ],
  },
  {
    name: "verify_artifact_signature",
    ...toolContractMetadata("verify_artifact_signature"),
    kind: "artifact-provider",
    description:
      "Verify a selected local JAR, Authenticode file, Apple Mach-O file, or Python wheel offline, using installed verification helpers or cryptographic libraries. Return integrity checks, signer identity, explicitly supplied trust, unsigned members and tool provenance separately. Wheel RECORD hashes alone are not a signature. Caller-supplied certificate or public-key files may establish the selected trust basis; unsupported options are rejected. No target execution or network access. Revocation and live Apple notarization status remain not checked; helper availability and format limits are explicit.",
    inputSchema: verifyArtifactSignatureInputSchema,
    outputSchema: evidenceResultOf(signatureReportSchema),
    examples: [
      {
        title: "Verify a local JAR",
        input: { path: "/artifacts/application.jar", kind: "jar" },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
