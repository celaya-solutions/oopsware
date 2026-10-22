import { expect, it } from "vitest";
import { HopperRegexSearch } from "./HopperRegexSearch.js";
import { err, ok } from "../domain/result.js";
import { AnalysisCapabilityUnavailableError } from "../domain/analysisErrorCore.js";
import {
  HopperRemoteError,
  HopperTimeoutError,
  HopperProcessError,
} from "../domain/hopperErrors.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";

it.each(
  (["search_strings", "search_procedures"] as const).flatMap((operation) =>
    (["remote", "capability", "timeout", "process"] as const).map((family) => ({
      operation,
      family,
    })),
  ),
)(
  "attributes $family inventory failure to accepted $operation with live cleanup",
  async ({ operation, family }) => {
    const inventory =
      operation === "search_strings" ? "list_strings" : "list_procedures";
    const diagnostics = {
      provider_request: { operation: inventory, request_id: 17 },
    };
    const context = {
      diagnostics,
      cleanup: {
        reason: "controlled close refusal",
        resources: ["exact-owner"],
      },
      capturedOutput: {
        stdout: "retained stdout",
        stderr: "retained stderr",
        truncated: false,
      },
    };
    const original = {
      remote: () =>
        new HopperRemoteError(-32000, "fixture inventory unavailable", {
          ...context,
          operation: inventory,
          requestId: 17,
          diagnosticType: "bridge_exception",
        }),
      capability: () =>
        new AnalysisCapabilityUnavailableError(
          "hopper",
          inventory,
          "fixture API unavailable",
          context,
        ),
      timeout: () =>
        new HopperTimeoutError(
          42,
          inventory,
          17,
          "busy",
          "analysis",
          undefined,
          context,
        ),
      process: () =>
        new HopperProcessError(7, {
          ...context,
          operation: inventory,
          requestId: 17,
          providerState: "exited",
          stage: "analysis",
        }),
    }[family]();
    const search = new HopperRegexSearch({
      callTool: async (name) => {
        expect(name).toBe(inventory);
        return err(original);
      },
    });
    try {
      const result = await search.execute(operation, {
        pattern: "fixture",
        mode: "regex",
        case_sensitive: false,
      });
      if (result.ok) throw new Error("Expected inventory failure");
      expect(projectAnalysisError(result.error).details).toMatchObject({
        operation,
      });
      expect(result.error._tag).toBe(original._tag);
      if (original instanceof AnalysisCapabilityUnavailableError)
        expect(result.error.diagnostics).toEqual(diagnostics);
      else
        expect(result.error.diagnostics).toMatchObject({
          provider_request: { operation: inventory, request_id: 17 },
          provider_diagnostics: diagnostics,
        });
      expect(result.error.capturedOutput).toEqual(context.capturedOutput);
      expect(result.error.cleanupIncomplete).toBe(true);
      expect(result.error.cleanupResources).toEqual(["exact-owner"]);
      if (result.error instanceof HopperRemoteError)
        expect(result.error).toMatchObject({
          code: -32000,
          safeMessage: "fixture inventory unavailable",
          diagnosticType: "bridge_exception",
          requestId: 17,
        });
      if (result.error instanceof HopperTimeoutError)
        expect(result.error).toMatchObject({
          timeoutMs: 42,
          requestId: 17,
          providerState: "busy",
          stage: "analysis",
        });
      if (result.error instanceof HopperProcessError)
        expect(result.error).toMatchObject({
          exitCode: 7,
          requestId: 17,
          providerState: "exited",
          stage: "analysis",
        });
      expect(original.operation).toBe(inventory);
      original.resolveCleanup();
      expect(result.error.cleanupIncomplete).toBe(false);
    } finally {
      await search.close();
    }
  },
);

it.each(
  [null, "caller stopped", { requested: "stop" }].flatMap((reason) =>
    (["inventory", "progress"] as const).map((stage) => ({ reason, stage })),
  ),
)(
  "keeps the exact reason at $stage completion cancellation",
  async ({ reason, stage }) => {
    const controller = new AbortController();
    const search = new HopperRegexSearch({
      callTool: async () => {
        if (stage === "inventory") controller.abort(reason);
        return ok([]);
      },
    });
    try {
      expect(
        await search.execute(
          "search_strings",
          { pattern: "fixture", mode: "regex", case_sensitive: false },
          {
            signal: controller.signal,
            progress: {
              report: async () => {
                if (stage === "progress") controller.abort(reason);
              },
            },
          },
        ),
      ).toMatchObject({
        ok: false,
        error: { _tag: "AnalysisCancelledError", cause: reason },
      });
    } finally {
      await search.close();
    }
  },
);

it("preserves an inventory failure when cancellation arrives after the physical outcome", async () => {
  const controller = new AbortController();
  const failure = new HopperRemoteError(-32000, "inventory failed", {
    operation: "list_strings",
    requestId: 17,
    diagnosticType: "bridge_exception",
  });
  const search = new HopperRegexSearch({
    callTool: async () => {
      controller.abort("late cancellation");
      return err(failure);
    },
  });
  try {
    const result = await search.execute(
      "search_strings",
      { pattern: "fixture", mode: "regex", case_sensitive: false },
      { signal: controller.signal },
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        _tag: "HopperRemoteError",
        operation: "search_strings",
        cause: failure,
      },
    });
  } finally {
    await search.close();
  }
});
