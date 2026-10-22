import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { AndroidPackageService } from "../application/androidPackage/AndroidPackageService.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { Logger } from "pino";
import { createEvidenceToolHandler } from "./contractToolHandler.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

/** Register the explicit-file Android package workflows and retain their Evidence. */
export const registerAndroidPackageTools = (
  server: EvidenceMcpServer,
  service: AndroidPackageService,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  withAdmittedAnalysis?: WithAdmittedAnalysis,
): void => {
  const operations = {
    inspect_android_artifact: service.inspectArtifact.bind(service),
    inspect_dex_class: service.inspectClass.bind(service),
    inspect_dex_method: service.inspectMethod.bind(service),
    decompile_dex_class: service.decompileClass.bind(service),
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
