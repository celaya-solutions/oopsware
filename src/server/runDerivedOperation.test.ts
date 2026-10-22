import { describe, expect, it } from "vitest";

import {
  runDerivedOperation,
  type DerivedOperationContext,
} from "./runDerivedOperation.js";
import { EvidenceIntegrityError } from "../domain/evidenceErrors.js";

const context = (
  controller: AbortController,
  notifications: unknown[] = [],
) => ({
  mcpReq: {
    signal: controller.signal,
    _meta: { progressToken: "derived-test" },
    notify: (notification: unknown) => {
      notifications.push(notification);
      return Promise.resolve();
    },
  },
});

describe("derived MCP operation boundary", () => {
  it("cancels before computation and never evaluates the operation", async () => {
    const controller = new AbortController();
    controller.abort();
    let computed = false;
    const result = await runDerivedOperation(
      context(controller),
      "compare",
      () => {
        computed = true;
        return "impossible";
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError" },
    });
    expect(computed).toBe(false);
  });

  it("lets cancellation win immediately before result publication", async () => {
    const controller = new AbortController();
    const result = await runDerivedOperation(
      context(controller),
      "compare",
      () => {
        controller.abort();
        return "must-not-publish";
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError" },
    });
  });

  it("lets cancellation win while terminal progress delivery is pending", async () => {
    const controller = new AbortController();
    let terminalReached = false;
    const notifications: DerivedOperationContext = {
      mcpReq: {
        ...context(controller).mcpReq,
        notify: async (notification) => {
          if (notification.params?.message === "complete: Completed compare") {
            terminalReached = true;
            await Promise.resolve();
            controller.abort();
          }
        },
      },
    };
    const result = await runDerivedOperation(
      notifications,
      "compare",
      () => "must-not-publish",
    );

    expect(terminalReached).toBe(true);
    expect(result).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError", operation: "compare" },
    });
  });

  it("emits bounded monotonic progress with one terminal state", async () => {
    const controller = new AbortController();
    const notifications: Array<{
      params?: { progress?: number; total?: number };
    }> = [];
    const result = await runDerivedOperation(
      context(controller, notifications),
      "compare",
      () => "complete",
    );

    expect(result).toEqual({ ok: true, value: "complete" });
    expect(notifications.map(({ params }) => params?.progress)).toEqual([1, 2]);
    expect(
      notifications.every(({ params }) => params?.total === undefined),
    ).toBe(true);
  });

  it("projects synchronous computation failures into a typed result", async () => {
    const result = await runDerivedOperation(
      context(new AbortController()),
      "compare_artifacts",
      () => {
        throw new TypeError("malformed comparison evidence");
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisInputError",
        operation: "compare_artifacts",
        issues: [
          {
            path: [],
            reason: "invalid_value",
            message: "malformed comparison evidence",
          },
        ],
      },
    });
  });

  it("preserves a tagged integrity failure instead of replacing it with invalid input", async () => {
    const failure = new EvidenceIntegrityError(
      "Source Evidence does not match its digest",
    );
    const result = await runDerivedOperation(
      context(new AbortController()),
      "compare_artifacts",
      () => {
        throw failure;
      },
    );
    expect(result).toEqual({ ok: false, error: failure });
  });
});
