import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Result } from "../../domain/result.js";
import type {
  GenerateSbomInput,
  SbomReport,
} from "../../domain/supplyChain/sbom.js";
import type {
  CheckVulnerabilitiesInput,
  VulnerabilityReport,
} from "../../domain/supplyChain/vulnerabilities.js";
import type {
  VerifyArtifactSignatureInput,
  SignatureReport,
} from "../../domain/supplyChain/signatures.js";

export interface SupplyChainPort {
  readonly identity: ProviderIdentity;
  generateSbom(
    input: GenerateSbomInput,
    options?: ExecutionOptions,
  ): Promise<Result<SbomReport, AnalysisError>>;
  checkVulnerabilities(
    input: CheckVulnerabilitiesInput,
    options?: ExecutionOptions,
  ): Promise<Result<VulnerabilityReport, AnalysisError>>;
  verifySignature(
    input: VerifyArtifactSignatureInput,
    options?: ExecutionOptions,
  ): Promise<Result<SignatureReport, AnalysisError>>;
}
