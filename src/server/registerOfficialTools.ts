import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import { OFFICIAL_TOOL_CONTRACTS } from "../contracts/officialToolContracts.js";
import { NATIVE_INVENTORY_OPERATIONS } from "../domain/native/nativeInventory.js";
import { registerEvidenceTools } from "./registerEvidenceTools.js";
import {
  retainedSummaryDelivery,
  withoutDeliveryDetail,
  type EvidenceToolFamilyOptions,
} from "./retainedSummaryDelivery.js";

const SUMMARY_OPERATIONS: ReadonlySet<string> = new Set(
  NATIVE_INVENTORY_OPERATIONS,
);
const withoutDetail = withoutDeliveryDetail(SUMMARY_OPERATIONS);

/** Direct tools share Evidence recording/projection with the other provider-backed tools. */
export const registerOfficialTools = (
  server: EvidenceMcpServer,
  options: EvidenceToolFamilyOptions,
): void => {
  registerEvidenceTools(server, OFFICIAL_TOOL_CONTRACTS, {
    ...options,
    ...retainedSummaryDelivery(SUMMARY_OPERATIONS, options),
    parametersForExecution: withoutDetail,
    parametersForEvidence: withoutDetail,
  });
};
