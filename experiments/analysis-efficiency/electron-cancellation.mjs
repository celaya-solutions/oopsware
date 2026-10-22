#!/usr/bin/env node
// Real applications run unchanged. Fault cases hold a REA-side Playwright reply;
// they do not establish that the application naturally exhibits that failure.
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { _electron } from "playwright-core";

const { values } = parseArgs({
  options: {
    executable: { type: "string" },
    application: { type: "string" },
    "profile-root": { type: "string" },
    "runtime-root": { type: "string" },
    case: { type: "string", default: "normal-wait" },
  },
});
const cases = ["normal-wait", "window-wait", "initial-state", "final-state"];
assert.equal(
  process.platform,
  "linux",
  "This verifier checks process identity through Linux /proc",
);
assert.ok(cases.includes(values.case));
assert.ok(values.executable && values.application && values["profile-root"]);
const runtime = resolve(
  values["runtime-root"] ?? fileURLToPath(new URL("../..", import.meta.url)),
);
const { PlaywrightElectronActiveProvider } = await import(
  pathToFileURL(
    join(runtime, "dist/browser/PlaywrightElectronActiveProvider.js"),
  )
);
const { captureElectronScenario } = await import(
  pathToFileURL(
    join(
      runtime,
      "dist/application/javascript/ElectronActiveObservationService.js",
    ),
  )
);
const { runWithExecutionLimits } = await import(
  pathToFileURL(
    join(runtime, "dist/browser/PlaywrightElectronActiveActions.js"),
  )
);
const profile = await mkdtemp(join(resolve(values["profile-root"]), "joplin-"));
const controller = new AbortController();
const reason = new Error(`real-application cancellation: ${values.case}`);
const started = performance.now();
let application;
let child;
let initialBirth;
let evaluateCalls = 0;
let injected = false;
let cancelledAt;
let cancelTimer;
let watchdog;
let rejectDeadline;
const deadline = new Promise((_, reject) => {
  rejectDeadline = reject;
});
const birth = async (pid) => {
  try {
    const text = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
    return fields[0] === "Z" ? null : fields[19];
  } catch (cause) {
    if (cause.code === "ENOENT") return null;
    throw cause;
  }
};
const armCancellation = () => {
  if (cancelTimer !== undefined) return;
  cancelTimer = setTimeout(
    () => {
      cancelledAt = performance.now();
      controller.abort(reason);
      watchdog = setTimeout(
        () =>
          rejectDeadline(
            new Error("Cancellation did not settle within 20 seconds"),
          ),
        20_000,
      );
    },
    values.case === "normal-wait" ? 1_000 : 100,
  );
};
const launch = async (options) => {
  application = await _electron.launch(options);
  child = application.process();
  initialBirth = await birth(child.pid);
  assert.ok(initialBirth, "Launched process identity is unavailable");
  return new Proxy(application, {
    get(target, key) {
      if (key === "evaluate")
        return (...args) => {
          evaluateCalls += 1;
          if (
            (values.case === "initial-state" && evaluateCalls === 1) ||
            (values.case === "final-state" && evaluateCalls === 5)
          ) {
            injected = true;
            armCancellation();
            return new Promise(() => {});
          }
          const result = target.evaluate(...args);
          if (values.case === "normal-wait" && evaluateCalls === 4)
            void result.then(armCancellation, () => undefined);
          return result;
        };
      if (key === "firstWindow" && values.case === "window-wait")
        return () => {
          injected = true;
          armCancellation();
          return new Promise(() => {});
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};
let record;
try {
  const input = {
    executable_path: resolve(values.executable),
    application_path: resolve(values.application),
    args: [
      "--no-sandbox",
      "--disable-gpu",
      `--user-data-dir=${profile}/chromium`,
      "--profile",
      profile,
    ],
    actions: values.case.endsWith("state")
      ? []
      : [{ step_id: "settle", kind: "wait", duration_ms: 60_000 }],
  };
  const result = await Promise.race([
    captureElectronScenario(
      new PlaywrightElectronActiveProvider(process.env, launch),
      input,
      { signal: controller.signal },
    ),
    deadline,
  ]);
  assert.equal(result.ok, false, "Expected a typed cancellation");
  const error = result.error;
  const partial = error.partialObservation?.capture;
  const causes = [];
  const seen = new Set();
  for (
    let cause = error;
    cause instanceof Error && !seen.has(cause);
    cause = cause.cause
  ) {
    seen.add(cause);
    causes.push({
      tag: cause._tag ?? null,
      reason: cause.reason ?? null,
      message: cause.message,
      diagnostics: cause.diagnostics ?? null,
    });
  }
  record = {
    case: values.case,
    fault_injected: injected,
    input,
    profile,
    evaluate_calls: evaluateCalls,
    elapsed_ms: performance.now() - started,
    cancellation_to_result_ms:
      cancelledAt === undefined ? null : performance.now() - cancelledAt,
    tag: error._tag,
    reason: error.reason,
    user_category: error.userCategory,
    diagnostics: error.diagnostics ?? null,
    message: error.message,
    user_message: error.userMessage ?? null,
    cleanup: error.cleanup ?? null,
    cause: error.cause instanceof Error ? error.cause.message : null,
    causes,
    cleanup_incomplete: error.cleanupIncomplete,
    partial:
      partial === undefined
        ? null
        : {
            application: partial.application,
            actions: partial.actions,
            coverage: partial.coverage,
            window_count: partial.windows.length,
            limitations: partial.limitations,
          },
    launched_process_exited:
      child !== undefined && (await birth(child.pid)) !== initialBirth,
  };
  assert.equal(controller.signal.aborted, true);
  assert.equal(error.userCategory, "cancelled");
  if (values.case !== "normal-wait") assert.equal(injected, true);
  if (values.case.endsWith("wait"))
    assert.ok(partial?.actions.some((action) => action.status === "cancelled"));
  if (values.case === "initial-state") assert.equal(partial, undefined);
  if (values.case === "final-state") {
    assert.ok(
      partial?.limitations.some((text) =>
        text.includes("initial pre-action snapshot"),
      ),
    );
    assert.ok(
      causes.some(
        (cause) =>
          cause.diagnostics?.final_state_read === "cancellation_grace_expired",
      ),
    );
  }
  // Cleanup is a separate oracle. A known Linux lineage limitation must remain
  // visible, rather than turning cancellation coverage into a cleanup claim.
  record.cancellation_phase = "verified";
  record.cleanup_phase =
    record.launched_process_exited && !error.cleanupIncomplete
      ? "verified"
      : "unverified";
  record.workflow_status =
    record.cleanup_phase === "verified" ? "verified" : "partial";
  console.log(JSON.stringify(record));
  assert.equal(
    record.cleanup_phase,
    "verified",
    "Provider cleanup remains unverified; cancellation alone is a partial result",
  );
} catch (cause) {
  console.log(
    JSON.stringify({
      case: values.case,
      fault_injected: injected,
      evaluate_calls: evaluateCalls,
      elapsed_ms: performance.now() - started,
      cancellation_to_failure_ms:
        cancelledAt === undefined ? null : performance.now() - cancelledAt,
      completed: false,
      observed: record ?? null,
      verifier_error: cause instanceof Error ? cause.message : String(cause),
    }),
  );
  throw cause;
} finally {
  clearTimeout(cancelTimer);
  clearTimeout(watchdog);
  if (
    application !== undefined &&
    child?.exitCode === null &&
    child?.signalCode === null
  )
    await runWithExecutionLimits(
      application.close(),
      undefined,
      performance.now() + 5_000,
    ).catch((cause) => {
      console.error(
        JSON.stringify({
          verifier_cleanup: "unverified",
          message: cause.message,
        }),
      );
      process.exitCode = 1;
    });
  // The external resource scope owns any leftovers; do not leave a failed
  // verifier awaiting an application whose ownership the provider cannot prove.
  if (child?.exitCode === null && child?.signalCode === null) process.exit(1);
}
