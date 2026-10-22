import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { AnalysisOperationPort } from "../application/AnalysisProvider.js";
import { MANAGED_TOOL_CONTRACTS } from "../contracts/managed/managedToolContracts.js";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import { err } from "../domain/result.js";
import { registerEvidenceTools } from "./registerEvidenceTools.js";
import {
  retainedSummaryDelivery,
  withoutDeliveryDetail,
  type EvidenceToolFamilyOptions,
} from "./retainedSummaryDelivery.js";
import { runManagedProviderExecution } from "../composition/directAnalysis.js";
import { isManagedToolName } from "../contracts/managed/managedToolContracts.js";

/** Operations whose MCP delivery may be a retained summary view. */
const SUMMARY_DELIVERY: ReadonlySet<string> = new Set([
  "inspect_managed_artifact",
  "inspect_managed_members",
]);

/** Register execution-free managed PE/CLI inspection. */
export const registerManagedTools = (
  server: EvidenceMcpServer,
  options: EvidenceToolFamilyOptions,
): void => {
  let selectedManagedPath: string | undefined;
  const withoutDelivery = withoutDeliveryDetail(SUMMARY_DELIVERY);
  const analysisForAdmission = (
    analysis: AnalysisOperationPort,
  ): AnalysisOperationPort => ({
    execute: async (operation, parameters, executionOptions) => {
      if (!isManagedToolName(operation))
        return analysis.execute(operation, parameters, executionOptions);
      const requestedPath = parameters.path;
      const activeTarget = options.activeTarget?.();
      const path =
        typeof requestedPath === "string"
          ? requestedPath
          : (selectedManagedPath ??
            (activeTarget?.format === "pe" && activeTarget.managed
              ? activeTarget.path
              : undefined));
      if (path === undefined)
        return err(
          new AnalysisInputError(operation, undefined, [
            {
              path: ["path"],
              reason: "missing_argument",
              message:
                "Provide a managed PE/CLI path or first select one with inspect_managed_artifact.",
            },
          ]),
        );
      const execution = await runManagedProviderExecution(
        path,
        operation,
        executionOptions?.signal,
        parameters,
      );
      if (execution.ok && typeof requestedPath === "string")
        selectedManagedPath = requestedPath;
      return execution;
    },
  });
  registerEvidenceTools(server, MANAGED_TOOL_CONTRACTS, {
    ...options,
    ...retainedSummaryDelivery(SUMMARY_DELIVERY, options),
    parametersForExecution: withoutDelivery,
    parametersForEvidence: withoutDelivery,
    analysisForAdmission,
  });
};
