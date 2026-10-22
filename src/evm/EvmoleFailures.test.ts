import { expect, it } from "vitest";
import { evmInterfaceFailure } from "./EvmoleFailures.js";
import { OwnedCommandFailure } from "../process/OwnedCommand.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import type { ProviderProcessSnapshot } from "../process/ProviderProcess.js";

const snapshot: ProviderProcessSnapshot = {
  stdout: { text: "selected output", bytes: 15, observedBytes: 15 },
  stderr: { text: "warning", bytes: 7, observedBytes: 7 },
  exitCode: 0,
  signal: null,
};

it.each([
  undefined,
  null,
  "caller stopped",
  { requested: "stop" },
  new AnalysisCancelledError("foreign", {
    cleanup: { reason: "foreign owner", resources: ["foreign-resource"] },
  }),
])(
  "retains the exact command cancellation reason as opaque data: %j",
  (reason) => {
    const source = new OwnedCommandFailure(
      "cancelled",
      "cancelled",
      snapshot,
      null,
      {
        cancellation: { reason },
      },
    );
    const result = evmInterfaceFailure(source, "worker", "/selected.hex");
    expect(result).toBeInstanceOf(AnalysisCancelledError);
    expect(result.cause).toBe(reason);
    expect(result.capturedOutput).toEqual({
      stdout: "selected output",
      stderr: "warning",
      truncated: false,
    });
    expect(result.cleanupIncomplete).toBe(false);
  },
);

it.each([
  { failure: "process" as const, cleanup: null, tag: "ProviderAdapterError" },
  { failure: "timeout" as const, cleanup: null, tag: "AnalysisTimeoutError" },
  {
    failure: "cancelled" as const,
    cleanup: "close refused",
    tag: "ProviderAdapterError",
  },
])("keeps $tag ahead of recorded cancellation", ({ failure, cleanup, tag }) => {
  const source = new OwnedCommandFailure(
    failure,
    "physical outcome",
    snapshot,
    cleanup,
    {
      cancellation: { reason: "later interruption" },
    },
    ["exact-owner"],
  );
  const result = evmInterfaceFailure(source, "worker", "/selected.hex");
  expect(result._tag).toBe(tag);
  if (cleanup !== null) {
    expect(result.cleanupIncomplete).toBe(true);
    expect(result.cleanupResources).toEqual(["exact-owner"]);
  }
});
