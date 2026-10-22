import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { JvmService } from "../application/jvm/JvmService.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { Logger } from "pino";
import { createEvidenceToolHandler } from "./contractToolHandler.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

/** Register the explicit-file JVM workflows and retain their Evidence. */
export const registerJvmTools = (
  server: EvidenceMcpServer,
  service: JvmService,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  withAdmittedAnalysis?: WithAdmittedAnalysis,
): void => {
  const operations = {
    inspect_jvm_artifact: service.inspectArtifact.bind(service),
    inspect_jvm_class: service.inspectClass.bind(service),
    inspect_jvm_method: service.inspectMethod.bind(service),
    decompile_jvm_class: service.decompileClass.bind(service),
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
