import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { WindowsInstallerService } from "../application/windowsInstaller/WindowsInstallerService.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { Logger } from "pino";
import { createEvidenceToolHandler } from "./contractToolHandler.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

/** Register the explicit-file Windows installer workflows and retain their Evidence. */
export const registerWindowsInstallerTools = (
  server: EvidenceMcpServer,
  service: WindowsInstallerService,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  withAdmittedAnalysis?: WithAdmittedAnalysis,
): void => {
  const operations = {
    inspect_windows_installer: service.inspectInstaller.bind(service),
    inspect_msix_package: service.inspectMsix.bind(service),
  } as const;
  for (const [name, operation] of Object.entries(operations)) {
    const contract = toolContract(name as keyof typeof operations);
    const handler = createEvidenceToolHandler(
      server,
      operation,
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
