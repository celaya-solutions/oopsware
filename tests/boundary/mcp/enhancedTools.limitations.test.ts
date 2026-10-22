import { afterEach, expect, it } from "vitest";
import { createAnalysisExecution } from "../../../src/application/AnalysisProvider.js";
import { err, ok } from "../../../src/domain/result.js";
import { AnalysisCapabilityUnavailableError } from "../../../src/domain/analysisErrorCore.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { connect, closeEnhancedToolResources } from "./enhancedToolsHarness.js";

afterEach(closeEnhancedToolResources);

it("retains provider coverage caveats in a composed MCP overview without repeated reads", async () => {
  const calls: string[] = [];
  const limitation = "Companion PDB symbol coverage is unverified.";
  const client = await connect({
    execute: async (operation) => {
      if (operation === "read_binary_inventory_summary")
        return err(
          new AnalysisCapabilityUnavailableError(
            "fixture",
            operation,
            "No native overview",
          ),
        );
      calls.push(operation);
      const value = operation === "current_document" ? "fixture" : [];
      return ok(
        createAnalysisExecution(
          value,
          { id: "fixture", name: "Fixture", version: "1" },
          { limitations: [limitation] },
        ),
      );
    },
  });
  const response = await client.callTool({
    name: "binary_overview",
    arguments: {},
  });
  expect(response.isError).not.toBe(true);
  const evidence = parseEvidence(response.structuredContent);
  expect(evidence.limitations).toEqual([
    "Artifact identity is unavailable for this observation.",
    "Derived by an Oopsware composed workflow.",
    `Fixture (fixture 1) current_document, list_procedures, list_segments, list_strings: ${limitation}`,
  ]);
  expect(evidence.normalized_result).toMatchObject({
    document: "fixture",
    procedure_count: 0,
    string_count: 0,
  });
  expect(calls.length).toBe(new Set(calls).size);
});
