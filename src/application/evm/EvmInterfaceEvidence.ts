import { createEvidence } from "../../domain/evidence.js";
import type { InspectEvmInterfaceInput } from "../../domain/evm/evmInterface.js";
import type { EvmInterfaceExecution } from "./EvmInterfacePort.js";

/** Preserve the same validated inference and provenance on success and failed finalization. */
export const evmInterfaceEvidence = (
  input: InspectEvmInterfaceInput,
  execution: EvmInterfaceExecution,
) =>
  createEvidence(execution.subject, execution.provider, {
    operation: "inspect_evm_interface",
    parameters: input,
    result: execution.result,
    ...(execution.rawResult === null ? {} : { rawResult: execution.rawResult }),
    confidence: "inferred",
    locations: execution.locations,
    limitations: execution.limitations,
  });
