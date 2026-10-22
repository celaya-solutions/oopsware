import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { IdentificationService } from "../application/identification/IdentificationService.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { Logger } from "pino";
import { createEvidenceToolHandler } from "./contractToolHandler.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

/** Register "What is this?" for explicit files and folders and retain its Evidence. */
export const registerIdentificationTools = (
  server: EvidenceMcpServer,
  service: IdentificationService,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  withAdmittedAnalysis?: WithAdmittedAnalysis,
): void => {
  const contract = toolContract("identify_artifact");
  const handler = createEvidenceToolHandler(
    server,
    service.identify.bind(service),
    logger,
    recordEvidence,
    withAdmittedAnalysis,
  );
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    handler(contract),
  );
};
