import { SupplyChainService } from "../application/supplyChain/SupplyChainService.js";
import { SUPPLY_CHAIN_PROVIDER } from "../application/InvestigationProviders.js";
import { generateSbom } from "../supplyChain/sbom.js";
import { checkVulnerabilities } from "../supplyChain/vulnerabilities.js";
import { verifyArtifactSignature } from "../supplyChain/signatures.js";

export const createSupplyChainService = (): SupplyChainService =>
  new SupplyChainService({
    identity: SUPPLY_CHAIN_PROVIDER,
    generateSbom,
    checkVulnerabilities,
    verifySignature: verifyArtifactSignature,
  });
