import type { Logger } from "pino";
import type { SupplyChainService } from "../application/supplyChain/SupplyChainService.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import { createEvidenceToolHandler } from "./contractToolHandler.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

export const registerSupplyChainTools = (
  server: EvidenceMcpServer,
  service: SupplyChainService,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  withAdmittedAnalysis?: WithAdmittedAnalysis,
): void => {
  for (const [name, invoke] of [
    ["generate_sbom", service.generateSbom.bind(service)],
    ["check_vulnerabilities", service.checkVulnerabilities.bind(service)],
    ["verify_artifact_signature", service.verifySignature.bind(service)],
  ] as const) {
    const contract = toolContract(name);
    const handler = createEvidenceToolHandler(
      server,
      invoke,
      logger,
      recordEvidence,
      withAdmittedAnalysis,
    );
    server.registerTool(
      contract.name,
      toolRegistrationOptions(contract),
      handler(contract),
    );
  }
};
