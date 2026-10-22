import { Cli } from "incur";
import { afterEach, expect, it, vi } from "vitest";

import { WasmArtifactService } from "../../src/application/wasm/WasmArtifactService.js";
import { registerWasmArtifactCommands } from "../../src/cli/wasmArtifactCommands.js";
import { wasmArtifactModule } from "../../src/composition/wasmArtifact.js";
import { AnalysisOutputError } from "../../src/domain/analysisErrorCore.js";
import { ProviderCleanupError } from "../../src/domain/providerCleanupError.js";
import { err, ok } from "../../src/domain/result.js";
import { silentLogger } from "../../src/logger.js";
import {
  wasmArtifactExecution,
  wasmArtifactFixture,
} from "../fixtures/wasm/artifact.js";

const host = vi.hoisted(() => ({
  listeners: new Map<string, () => void>(),
  exitCode: undefined as number | undefined,
  on(signal: string, listener: () => void) {
    this.listeners.set(signal, listener);
  },
  off(signal: string, listener: () => void) {
    if (this.listeners.get(signal) === listener) this.listeners.delete(signal);
  },
}));

vi.mock("../../src/cli/commandCancellation.js", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("../../src/cli/commandCancellation.js")
    >();
  return {
    ...original,
    withCommandCancellation: <Value>(
      operation: (signal: AbortSignal) => Promise<Value>,
    ) => original.withCommandCancellation(operation, host),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  host.listeners.clear();
  host.exitCode = undefined;
});

it.each([
  "control",
  "interrupt",
  "primary-failure",
  "cleanup-failure",
  "interrupt-cleanup-failure",
] as const)(
  "finishes the registered WASM command through final close: %s",
  async (scenario) => {
    const value = wasmArtifactFixture();
    const primary = new AnalysisOutputError(
      "inspect_wasm_artifact",
      "primary reply failure",
    );
    const cleanup = new ProviderCleanupError(
      "wabt-artifact",
      ["exact-owned-root"],
      { reason: "close refused" },
      { operation: "inspect_wasm_artifact" },
    );
    let closed = false;
    const service = new WasmArtifactService({
      inspect: async () =>
        scenario === "primary-failure"
          ? err(primary)
          : ok(wasmArtifactExecution(value)),
      close: async () => {
        await Promise.resolve();
        if (scenario !== "control" && scenario !== "cleanup-failure")
          host.listeners.get("SIGINT")?.();
        closed = true;
        if (
          scenario === "cleanup-failure" ||
          scenario === "interrupt-cleanup-failure"
        )
          throw cleanup;
      },
    });
    vi.spyOn(wasmArtifactModule, "create").mockReturnValue(service);
    const cli = Cli.create("finalization-test", { sync: false });
    registerWasmArtifactCommands(cli, silentLogger, {});
    let output = "";
    const previousExitCode = process.exitCode;
    try {
      await cli.serve(
        ["inspect-wasm-artifact", value.artifact.path, "--json"],
        {
          stdout: (part) => {
            output += part;
          },
          exit: () => {},
        },
      );
    } finally {
      process.exitCode = previousExitCode;
    }
    const result = JSON.parse(output);
    expect(closed).toBe(true);
    expect(host.listeners.size).toBe(0);
    if (scenario === "control") {
      expect(result.normalized_result).toEqual(value);
      expect(host.exitCode).toBeUndefined();
    } else if (scenario === "primary-failure") {
      expect(result).toMatchObject({
        code: "unreadable_output",
        details: { reason: "primary reply failure" },
      });
      expect(host.exitCode).toBe(130);
    } else {
      expect(result).toMatchObject({
        code: scenario === "interrupt" ? "cancelled" : "cleanup_incomplete",
        details: {
          partial_observation: {
            operation: "inspect_wasm_artifact",
            normalized_result: value,
          },
          ...(scenario === "interrupt"
            ? {}
            : { resources: ["exact-owned-root"] }),
        },
      });
      if (scenario !== "cleanup-failure") expect(host.exitCode).toBe(130);
    }
  },
);
