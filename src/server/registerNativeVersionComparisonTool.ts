import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { NativeVersionComparison } from "../application/NativeVersionComparison.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { nativeVersionComparisonResultSchema } from "../domain/nativeVersionComparisonSchemas.js";

/** Register the independent two-binary workflow without changing the active session. */
export const registerNativeVersionComparisonTool = (
  server: EvidenceMcpServer,
  service: NativeVersionComparison,
  recordEvidence?: EvidenceWriter["recordEvidence"],
): void => {
  const contract = toolContract("compare_native_versions");
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async (input, context) => {
      const result = await service.compare(input, context.mcpReq.signal);
      if (!result.ok) return server.delivery.toCallToolResult(result, contract);
      const comparison = nativeVersionComparisonResultSchema.parse(
        result.value.normalized_result,
      );
      for (const evidence of [
        comparison.left.inventory,
        ...comparison.left.functions,
        comparison.right.inventory,
        ...comparison.right.functions,
      ]) {
        const recorded = recordEvidence?.(evidence);
        if (recorded !== undefined && !recorded.ok)
          return server.delivery.toCallToolResult(recorded, contract);
      }
      return server.delivery.toEvidenceToolResult(
        result.value,
        contract,
        recordEvidence?.(result.value),
      );
    },
  );
};
