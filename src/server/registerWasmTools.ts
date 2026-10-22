import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { WebAssemblyService } from "../application/wasm/WebAssemblyService.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { Logger } from "pino";
import { createEvidenceToolHandler } from "./contractToolHandler.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

/** Register the explicit-file WebAssembly workflows and retain their Evidence. */
export const registerWasmTools = (
  server: EvidenceMcpServer,
  service: WebAssemblyService,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  withAdmittedAnalysis?: WithAdmittedAnalysis,
): void => {
  const operations = {
    inspect_wasm_module: service.inspectModule.bind(service),
    inspect_wasm_function: service.inspectFunction.bind(service),
    convert_wasm_to_text: service.convertToText.bind(service),
    convert_wasm_to_c: service.convertToC.bind(service),
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
