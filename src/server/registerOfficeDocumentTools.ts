import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { OfficeDocumentService } from "../application/officeDocument/OfficeDocumentService.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { Logger } from "pino";
import { createEvidenceToolHandler } from "./contractToolHandler.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

/** Register the explicit-path Office document workflow and retain its Evidence. */
export const registerOfficeDocumentTools = (
  server: EvidenceMcpServer,
  service: OfficeDocumentService,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  withAdmittedAnalysis?: WithAdmittedAnalysis,
): void => {
  const contract = toolContract("inspect_office_document");
  const handler = createEvidenceToolHandler(
    server,
    service.inspectDocument.bind(service),
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
