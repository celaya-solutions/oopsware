import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { LinuxPackageService } from "../application/linuxPackage/LinuxPackageService.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { Logger } from "pino";
import { createEvidenceToolHandler } from "./contractToolHandler.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

/** Register the explicit-file Linux package workflow and retain its Evidence. */
export const registerLinuxPackageTools = (
  server: EvidenceMcpServer,
  service: LinuxPackageService,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  withAdmittedAnalysis?: WithAdmittedAnalysis,
): void => {
  const contract = toolContract("inspect_linux_package");
  const handler = createEvidenceToolHandler(
    server,
    service.inspectPackage.bind(service),
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
