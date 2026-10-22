import { expect, it } from "vitest";
import { EnhancedTools } from "./EnhancedTools.js";
import { createAnalysisExecution } from "./AnalysisProvider.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import { err, ok } from "../domain/result.js";

it("uses the provider-owned overview without requesting complete inventories", async () => {
  const calls: string[] = [];
  const result = {
    document: "selected",
    procedure_count: 12,
    string_count: 34,
  };
  const tools = new EnhancedTools({
    execute: async (operation) => {
      calls.push(operation);
      return ok(
        createAnalysisExecution(result, {
          id: "fixture",
          name: "Fixture",
          version: "1",
        }),
      );
    },
  });
  expect(await tools.execute("binary_overview", {})).toEqual(ok(result));
  expect(calls).toEqual(["read_binary_inventory_summary"]);
});

it.each([
  new AnalysisOutputError("binary_overview", "Malformed aggregate"),
  new AnalysisCancelledError("binary_overview"),
  new AnalysisCapabilityUnavailableError(
    "fixture",
    "binary_overview",
    "Cleanup pending",
    {
      cleanup: {
        reason: "Owned process is still closing",
        resources: ["session"],
      },
    },
  ),
])(
  "preserves an aggregate failure rather than silently repeating analysis: %s",
  async (failure) => {
    const calls: string[] = [];
    const tools = new EnhancedTools({
      execute: async (operation) => {
        calls.push(operation);
        return err(failure);
      },
    });
    expect(await tools.execute("binary_overview", {})).toEqual(err(failure));
    expect(calls).toEqual(["read_binary_inventory_summary"]);
  },
);
