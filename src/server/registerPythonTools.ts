import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { PythonService } from "../application/python/PythonService.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { Logger } from "pino";
import { createEvidenceToolHandler } from "./contractToolHandler.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

/** Register the explicit-file Python workflows and retain their Evidence. */
export const registerPythonTools = (
  server: EvidenceMcpServer,
  service: PythonService,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  withAdmittedAnalysis?: WithAdmittedAnalysis,
): void => {
  const operations = {
    inspect_python_artifact: service.inspectArtifact.bind(service),
    inspect_python_module: service.inspectModule.bind(service),
    inspect_python_code: service.inspectCode.bind(service),
    decompile_python_code: service.decompileCode.bind(service),
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
