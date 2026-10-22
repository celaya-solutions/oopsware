import type { AnalysisProviderSelector } from "./contracts/providerSelection.js";

/**
 * Supported MCP startup deadlines and operation headroom.
 *
 * Client timeouts are caller-facing configuration. The smaller phase budgets
 * preserve operational headroom, while the doctor deadline covers additional
 * inventory requests after initialization.
 */
export const MCP_STARTUP_POLICY = {
  codexStartupTimeoutSeconds: 30,
  kimiStartupTimeoutMs: 30_000,
  toolOperationHeadroomMs: 120_000,
  initializeBudgetMs: 15_000,
  toolsListBudgetMs: 5_000,
  firstCatalogBudgetMs: 20_000,
  doctorDeadlineMs: 30_000,
  doctorStderrBytes: 64 * 1024,
} as const;

/** Parsed startup and upstream request budgets affecting a client's tool deadline. */
export interface McpToolTimeoutInputs {
  readonly analysisProvider: AnalysisProviderSelector;
  readonly ghidraStartupTimeoutMs: number;
  readonly hopperStartupTimeoutMs: number;
  readonly jebMcpTimeoutMs?: number;
  readonly providerRequestTimeoutMs?: number;
}

/** Allow for known startup phases and caller-selected upstream request budgets. */
export const mcpProviderDeadlineAllowanceMs = (
  inputs: McpToolTimeoutInputs,
): number => {
  const selectedProvider = inputs.analysisProvider;
  const selectedTimeout =
    selectedProvider === "ghidra"
      ? inputs.ghidraStartupTimeoutMs
      : selectedProvider === "hopper"
        ? inputs.hopperStartupTimeoutMs
        : Math.max(
            inputs.ghidraStartupTimeoutMs,
            inputs.hopperStartupTimeoutMs,
          );
  return Math.max(
    selectedTimeout,
    inputs.jebMcpTimeoutMs ?? 0,
    inputs.providerRequestTimeoutMs ?? 0,
  );
};

/** Add operation headroom to the parsed provider deadline allowance. */
export const recommendedMcpToolTimeoutMs = (
  inputs: McpToolTimeoutInputs,
): number =>
  mcpProviderDeadlineAllowanceMs(inputs) +
  MCP_STARTUP_POLICY.toolOperationHeadroomMs;

/** Round up so Codex's whole-second deadline still covers the millisecond budget. */
export const recommendedMcpToolTimeoutSeconds = (
  inputs: McpToolTimeoutInputs,
): number => Math.ceil(recommendedMcpToolTimeoutMs(inputs) / 1000);
