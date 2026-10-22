import { expect, it, onTestFinished } from "vitest";
import {
  AnalysisInputError,
  AnalysisOutputError,
} from "../../../src/domain/analysisErrorCore.js";
import { ProviderCleanupError } from "../../../src/domain/providerCleanupError.js";
import { CutterBridgeClient } from "../../../src/cutter/CutterBridgeClient.js";
import { CutterBridgeService } from "../../../src/cutter/CutterBridgeService.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it.each([
  new AnalysisInputError("opaque caller metadata"),
  new ProviderCleanupError("caller-owned", ["opaque caller resource"], {
    reason: "caller metadata",
  }),
])(
  "keeps a typed caller abort reason opaque at command admission: $_tag",
  async (reason) => {
    const directory = await createTestTempDirectory(
      "rea-cutter-command-cancel-",
    );
    const client = new CutterBridgeClient({ REA_CUTTER_BRIDGE_DIR: directory });
    const service = new CutterBridgeService(client);
    onTestFinished(() => service.close());
    const controller = new AbortController();
    const executing = service.execute(
      {
        session_id: "27d3e3f1-f1e5-49ae-91ec-95af1f343a5a",
        expected_generation: 0,
        command: "ij",
      },
      { signal: controller.signal },
    );
    queueMicrotask(() => controller.abort(reason));
    const result = await executing;
    expect(result).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisCancelledError",
        operation: "cutter_command",
        cleanupIncomplete: false,
      },
    });
    if (result.ok) throw new Error("Expected cancellation");
    expect(result.error.cause).toBe(reason);
    expect(result.error.cleanupResources).toEqual([]);
  },
);

it.each([
  new AnalysisOutputError("cutter_command", "physical provider failure"),
  new ProviderCleanupError("cutter", ["actual producer resource"], {
    reason: "physical producer close failure",
  }),
])(
  "preserves a genuine typed provider failure also selected as abort reason: $_tag",
  async (physical) => {
    const controller = new AbortController();
    const service = new CutterBridgeService({
      listSessions: async () => {
        throw new Error("Unexpected discovery");
      },
      execute: async () => {
        controller.abort(physical);
        throw physical;
      },
    });
    const result = await service.execute(
      {
        session_id: "27d3e3f1-f1e5-49ae-91ec-95af1f343a5a",
        expected_generation: 0,
        command: "ij",
      },
      { signal: controller.signal },
    );
    if (result.ok) throw new Error("Expected provider failure");
    expect(result.error).toBe(physical);
  },
);
