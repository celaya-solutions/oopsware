import {
  AnalysisCancelledError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import { expect, it } from "vitest";
import { NativeUiInterruptionControl } from "./NativeUiInterruptionControl.js";

it("gives a pre-aborted caller priority over a pre-aborted deadline", () => {
  const reason = { phase: "shared" };
  const caller = new AbortController();
  const deadline = new AbortController();
  caller.abort(reason);
  deadline.abort(reason);
  const control = new NativeUiInterruptionControl(
    caller.signal,
    deadline.signal,
  );
  expect(control.error("observe_native_ui")).toBeInstanceOf(
    AnalysisCancelledError,
  );
  expect(control.error("observe_native_ui")?.cause).toBe(reason);
  control.dispose();
});

it("keeps the first observed source when caller and deadline share a reason", () => {
  const reason = { phase: "shared" };
  const caller = new AbortController();
  const deadline = new AbortController();
  const control = new NativeUiInterruptionControl(
    caller.signal,
    deadline.signal,
  );
  deadline.abort(reason);
  caller.abort(reason);
  expect(control.error("observe_native_ui")).toBeInstanceOf(
    AnalysisTimeoutError,
  );
  expect(control.error("observe_native_ui")?.cause).toBe(reason);
  control.dispose();
});

it("records a caller interruption before a later deadline", () => {
  const reason = { phase: "shared" };
  const caller = new AbortController();
  const deadline = new AbortController();
  const control = new NativeUiInterruptionControl(
    caller.signal,
    deadline.signal,
  );
  caller.abort(reason);
  deadline.abort(reason);
  expect(control.error("observe_native_ui")).toBeInstanceOf(
    AnalysisCancelledError,
  );
  expect(control.error("observe_native_ui")?.cause).toBe(reason);
  control.dispose();
});
