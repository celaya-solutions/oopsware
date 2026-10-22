#!/usr/bin/env node
// Real draw.io ASAR, renderer and declared actions; DOM reads are independent
// verification probes. No fabricated IPC channels or replacement app callbacks.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { _electron } from "playwright-core";

const { values } = parseArgs({
  options: {
    "runtime-root": { type: "string" },
    executable: { type: "string" },
    application: { type: "string" },
    "profile-root": { type: "string" },
    selector: { type: "string" },
    "dismiss-error": { type: "boolean", default: false },
  },
});
for (const key of ["runtime-root", "executable", "application", "profile-root"])
  assert.ok(values[key], `Missing --${key}`);
const runtime = resolve(values["runtime-root"]);
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
const profile = await mkdtemp(
  join(resolve(values["profile-root"]), "drawio-ui-"),
);
const controller = new AbortController();
const timer = setTimeout(
  () => controller.abort(new Error("Verifier deadline")),
  40_000,
);
let application;
let child;
let page;
let before;
let after;
let checkedFinalState = false;
const inspect = () =>
  page.evaluate(() => {
    const diagram = document.querySelector(".geDiagramContainer svg");
    return {
      title: document.title,
      invalid_file_dialog:
        document.body.innerText.includes("Invalid file data"),
      unsaved_changes: document.body.innerText.includes("Unsaved changes"),
      diagram_svg_elements:
        diagram?.querySelectorAll("rect,path,ellipse,text").length ?? null,
      cells: document.querySelectorAll(".geDiagramContainer [data-cell-id]")
        .length,
    };
  });
const started = performance.now();
try {
  const actions = values["dismiss-error"]
    ? [
        {
          step_id: "dismiss-invalid-file",
          kind: "click",
          window_index: 0,
          selector: 'button:has-text("OK"):visible',
        },
      ]
    : [];
  if (values.selector !== undefined)
    actions.push({
      step_id: "insert-shape",
      kind: "click",
      window_index: 0,
      selector: values.selector,
    });
  actions.push({
    step_id: "settle-renderer",
    kind: "wait",
    window_index: 0,
    duration_ms: 500,
  });
  const result = await captureElectronScenario(
    new PlaywrightElectronActiveProvider(process.env, async (options) => {
      application = await _electron.launch(options);
      child = application.process();
      page = await application.firstWindow({ timeout: 15_000 });
      await page
        .locator(".geDiagramContainer")
        .waitFor({ state: "visible", timeout: 15_000 });
      if (values["dismiss-error"])
        await page
          .getByText("Invalid file data", { exact: true })
          .waitFor({ state: "visible", timeout: 15_000 });
      before = await inspect();
      return new Proxy(application, {
        get(target, key) {
          if (key === "close")
            return async () => {
              if (!checkedFinalState) {
                checkedFinalState = true;
                after = await inspect();
              }
              return target.close();
            };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }),
    {
      executable_path: resolve(values.executable),
      application_path: resolve(values.application),
      args: ["--no-sandbox", "--disable-gpu", `--user-data-dir=${profile}`],
      actions,
    },
    { signal: controller.signal },
  );
  const capture = result.ok
    ? result.value.normalized_result
    : result.error.partialObservation?.capture;
  await writeFile(join(profile, "result.json"), JSON.stringify(result));
  const actionsCompleted =
    capture?.actions.every((action) => action.status === "completed") === true;
  const inserted =
    values.selector === undefined
      ? null
      : after?.diagram_svg_elements > before?.diagram_svg_elements;
  console.log(
    JSON.stringify({
      profile,
      runtime,
      elapsed_ms: performance.now() - started,
      deadline_triggered: controller.signal.aborted,
      selected_shape: values.selector ?? null,
      before,
      after,
      actions_completed: actionsCompleted,
      shape_inserted: inserted,
      provider_ok: result.ok,
      cleanup_verified: result.ok,
      reason: result.ok ? null : result.error.reason,
      coverage: capture?.coverage,
      retention: capture?.retention,
      ipc: capture?.ipc,
      actions: capture?.actions,
      workflow_status:
        result.ok && actionsCompleted && inserted !== false
          ? "verified"
          : "partial-or-failed",
    }),
  );
  assert.ok(actionsCompleted, "Declared real-app actions did not complete");
  assert.ok(before && after, "Real renderer state was not verified");
  assert.notEqual(inserted, false, "Click did not insert a diagram shape");
  if (values["dismiss-error"]) assert.equal(after.invalid_file_dialog, false);
  assert.equal(
    controller.signal.aborted,
    false,
    "Verifier deadline was reached",
  );
  assert.ok(result.ok, "Provider cleanup remains unverified");
} finally {
  clearTimeout(timer);
  if (
    application !== undefined &&
    child?.exitCode === null &&
    child?.signalCode === null
  )
    await runWithExecutionLimits(
      application.close(),
      undefined,
      performance.now() + 5_000,
    ).catch(() => {
      process.exitCode = 1;
    });
  // The resource scope owns any unresolved descendants; no PID/path-only kill.
  if (child?.exitCode === null && child?.signalCode === null) process.exit(1);
}
