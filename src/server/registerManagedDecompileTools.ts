import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { ManagedDecompileService } from "../application/managedDecompile/ManagedDecompileService.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { Logger } from "pino";
import { createEvidenceToolHandler } from "./contractToolHandler.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

/** Register the explicit-file .NET decompiler and retain its Evidence. */
export const registerManagedDecompileTools = (
  server: EvidenceMcpServer,
  service: ManagedDecompileService,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  withAdmittedAnalysis?: WithAdmittedAnalysis,
): void => {
  const contract = toolContract("decompile_managed_type");
  const handler = createEvidenceToolHandler(
    server,
    service.decompileType.bind(service),
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
