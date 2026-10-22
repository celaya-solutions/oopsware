import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { PdfDocumentService } from "../application/pdfDocument/PdfDocumentService.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { Logger } from "pino";
import { createEvidenceToolHandler } from "./contractToolHandler.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

/** Register the explicit-path PDF workflow and retain its Evidence. */
export const registerPdfDocumentTools = (
  server: EvidenceMcpServer,
  service: PdfDocumentService,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  withAdmittedAnalysis?: WithAdmittedAnalysis,
): void => {
  const contract = toolContract("inspect_pdf_document");
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
