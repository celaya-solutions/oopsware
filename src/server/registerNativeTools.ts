import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";

import { NATIVE_TOOL_CONTRACTS } from "../contracts/native/nativeToolContracts.js";
import { registerEvidenceTools } from "./registerEvidenceTools.js";
import {
  retainedSummaryDelivery,
  withoutDeliveryDetail,
  type EvidenceToolFamilyOptions,
} from "./retainedSummaryDelivery.js";

const SUMMARY_DELIVERY: ReadonlySet<string> = new Set(["inspect_macho"]);

/** Register macOS native contracts; Mach-O inspection can deliver a retained summary. */
export const registerNativeTools = (
  server: EvidenceMcpServer,
  options: EvidenceToolFamilyOptions,
): void => {
  const withoutDelivery = withoutDeliveryDetail(SUMMARY_DELIVERY);
  registerEvidenceTools(server, NATIVE_TOOL_CONTRACTS, {
    ...options,
    ...retainedSummaryDelivery(SUMMARY_DELIVERY, options),
    parametersForExecution: withoutDelivery,
    parametersForEvidence: withoutDelivery,
  });
};
