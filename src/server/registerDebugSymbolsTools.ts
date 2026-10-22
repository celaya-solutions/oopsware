import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { DebugSymbolsService } from "../application/debugSymbols/DebugSymbolsService.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { Logger } from "pino";
import { createEvidenceToolHandler } from "./contractToolHandler.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

/** Register the explicit-path debug symbols workflow and retain its Evidence. */
export const registerDebugSymbolsTools = (
  server: EvidenceMcpServer,
  service: DebugSymbolsService,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  withAdmittedAnalysis?: WithAdmittedAnalysis,
): void => {
  const contract = toolContract("inspect_debug_symbols");
  const handler = createEvidenceToolHandler(
    server,
    service.inspectSymbols.bind(service),
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
