import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { ContainerImageService } from "../application/containerImage/ContainerImageService.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { Logger } from "pino";
import { createEvidenceToolHandler } from "./contractToolHandler.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

/** Register the explicit-path container image workflow and retain its Evidence. */
export const registerContainerImageTools = (
  server: EvidenceMcpServer,
  service: ContainerImageService,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  withAdmittedAnalysis?: WithAdmittedAnalysis,
): void => {
  const contract = toolContract("inspect_container_image");
  const handler = createEvidenceToolHandler(
    server,
    service.inspectImage.bind(service),
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
