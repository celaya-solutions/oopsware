import { afterEach, describe, expect, it, vi } from "vitest";

import { withPlaywrightExecutionBoundary } from "./PlaywrightExecutionBoundary.js";
import {
  AnalysisCancelledError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";

describe("withPlaywrightExecutionBoundary", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("rejects work that exceeds its absolute remaining duration", async () => {
    vi.useFakeTimers();
    const result = withPlaywrightExecutionBoundary(
      () => new Promise<never>(() => undefined),
      25,
    );
    const rejection =
      expect(result).rejects.toBeInstanceOf(AnalysisTimeoutError);
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
  });

  it("rejects when the caller cancels active work", async () => {
    const controller = new AbortController();
    const result = withPlaywrightExecutionBoundary(
      () => new Promise<never>(() => undefined),
      1_000,
      controller.signal,
    );
    controller.abort();
    await expect(result).rejects.toBeInstanceOf(AnalysisCancelledError);
  });

  it("keeps its timeout stable across a wall-clock jump", async () => {
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(1_000)
      .mockReturnValue(10_000_000);

    await expect(
      withPlaywrightExecutionBoundary(
        () =>
          new Promise<string>((resolve) =>
            setTimeout(() => resolve("done"), 5),
          ),
        1_000,
      ),
    ).resolves.toBe("done");
  });
});

it.each(["before", "during"] as const)(
  "keeps typed caller reasons opaque when cancelled %s work",
  async (phase) => {
    const caller = new AbortController();
    const reason = new AnalysisTimeoutError("capture_browser_scenario", 123);
    if (phase === "before") caller.abort(reason);
    const pending = withPlaywrightExecutionBoundary(
      () => new Promise<never>(() => {}),
      undefined,
      caller.signal,
    );
    if (phase === "during") caller.abort(reason);
    const error: unknown = await pending.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AnalysisCancelledError);
    if (!(error instanceof AnalysisCancelledError))
      throw new Error("Expected typed cancellation");
    expect(error.cause).toBe(reason);
  },
);
