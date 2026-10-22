#!/usr/bin/env node
// Unchanged Joplin ASAR and its shipped welcome note/attachment. The actual
// resource context menu, bridge and shell call execute; menu automation is explicit.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { _electron } from "playwright-core";

const { values } = parseArgs({
  options: {
    "runtime-root": { type: "string" },
    executable: { type: "string" },
    application: { type: "string" },
    "profile-root": { type: "string" },
    "argv-shim-transport": { type: "boolean", default: false },
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
const profile = await mkdtemp(
  join(resolve(values["profile-root"]), "joplin-shell-"),
);
let application;
let child;
let probe;
let stagedHookHashes;
const started = performance.now();
const controller = new AbortController();
const deadline = setTimeout(
  () => controller.abort(new Error("Verifier deadline")),
  45_000,
);

const verifyHookSources = async (stagedHook) => {
  const hashes = {};
  for (const name of [
    "electron-active-hook.cjs",
    "electron-active-hook-boundaries.cjs",
  ]) {
    const hash = (data) => createHash("sha256").update(data).digest("hex");
    const actualPath =
      name === "electron-active-hook.cjs"
        ? stagedHook
        : join(dirname(stagedHook), name);
    const [actual, expected] = await Promise.all([
      readFile(actualPath).then(hash),
      readFile(join(runtime, "scripts", name)).then(hash),
    ]);
    assert.equal(
      actual,
      expected,
      `The staged ${name} must match the selected runtime source`,
    );
    hashes[name] = actual;
  }
  return hashes;
};

const launch = async (options) => {
  const stagedIndex = options.args.indexOf("-r");
  assert.notEqual(
    stagedIndex,
    -1,
    "Expected the provider's staged require pair",
  );
  stagedHookHashes = await verifyHookSources(options.args[stagedIndex + 1]);
  let launchOptions = options;
  if (values["argv-shim-transport"]) {
    // Explicit test adapter for #2974, not the public provider launch path.
    const args = [...options.args];
    const index = args.indexOf("-r");
    assert.notEqual(index, -1, "Expected the provider's staged require pair");
    const hook = args[index + 1];
    const shim = join(profile, "launch-shim.cjs");
    await writeFile(
      shim,
      `require(${JSON.stringify(hook)});\nconst index = process.argv.indexOf("-r");\nif (index < 0 || process.argv[index + 1] !== __filename) throw new Error("Unexpected staged argv");\nprocess.argv.splice(index, 2);\n`,
    );
    args[index + 1] = shim;
    launchOptions = { ...options, args };
  }
  application = await _electron.launch(launchOptions);
  child = application.process();
  assert.equal(
    await application.evaluate(
      () => typeof globalThis.__reaElectronActiveSnapshot,
    ),
    "function",
    "The staged active hook must be installed before app actions",
  );
  const page = await application.firstWindow({ timeout: 15_000 });
  const pageErrors = [];
  page.on("pageerror", (error) => {
    if (pageErrors.length < 5) pageErrors.push(String(error).slice(0, 600));
  });
  await page.getByPlaceholder("Search...").waitFor({ timeout: 15_000 });
  await page
    .getByText("1. Welcome to Joplin!", { exact: true })
    .first()
    .click({ timeout: 20_000 });
  const viewer = page.locator("iframe.noteTextViewer");
  for (
    let attempt = 0;
    attempt < 3 && !(await viewer.isVisible());
    attempt += 1
  ) {
    await application.evaluate(({ Menu }) => {
      const item =
        Menu.getApplicationMenu()?.getMenuItemById("toggleVisiblePanes");
      if (!item) throw new Error("Missing Joplin editor layout menu");
      item.click();
    });
    await viewer
      .waitFor({ state: "visible", timeout: 3_000 })
      .catch(() => undefined);
  }
  const image = page
    .frameLocator("iframe.noteTextViewer")
    .locator("img")
    .first();
  try {
    await image.waitFor({ timeout: 15_000 });
  } catch (cause) {
    console.log(
      JSON.stringify({
        viewer_visible: await viewer.isVisible(),
        frames: await Promise.all(
          page
            .frames()
            .slice(0, 5)
            .map(async (frame) => ({
              url: frame.url(),
              state: await frame.evaluate(() => ({
                text: document.body?.innerText.slice(0, 500),
                images: document.images.length,
              })),
            })),
        ),
      }),
    );
    throw cause;
  }
  const attachment = await image.evaluate((element) => ({
    src: element.getAttribute("src"),
    alt: element.getAttribute("alt"),
    width: element.naturalWidth,
    height: element.naturalHeight,
  }));
  assert.ok(
    attachment.width > 0 && attachment.height > 0,
    "The shipped welcome attachment must render",
  );
  const beforeShellCount = await application.evaluate(
    () =>
      globalThis
        .__reaElectronActiveSnapshot()
        .events.filter(
          (event) =>
            event.kind === "shell-attempt" &&
            event.event === "showItemInFolder",
        ).length,
  );
  assert.equal(
    beforeShellCount,
    0,
    "A startup event cannot prove the requested reveal",
  );
  // Capture the app's actual context menu instead of opening a native popup.
  await application.evaluate(({ Menu }) => {
    const original = Menu.prototype.popup;
    globalThis.__reaShellMenuProbe = { original, menu: null };
    Menu.prototype.popup = function captureMenu() {
      globalThis.__reaShellMenuProbe.menu = this;
    };
  });
  await image.click({ button: "right" });
  const revealed = await application.evaluate(async ({ Menu }) => {
    const state = globalThis.__reaShellMenuProbe;
    const deadline = Date.now() + 5_000;
    while (state.menu === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    Menu.prototype.popup = state.original;
    delete globalThis.__reaShellMenuProbe;
    const item = state.menu?.items.find(
      (entry) => entry.label === "Reveal file in folder",
    );
    if (!item) throw new Error("Missing actual Joplin resource reveal menu");
    await item.click();
    return item.label;
  });
  const shell = await application.evaluate(async () => {
    const read = () =>
      globalThis
        .__reaElectronActiveSnapshot()
        .events.filter(
          (event) =>
            event.kind === "shell-attempt" &&
            event.event === "showItemInFolder",
        );
    const deadline = Date.now() + 5_000;
    let events = read();
    while (events.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      events = read();
    }
    return events;
  });
  assert.equal(shell.length, 1);
  assert.equal(shell[0].phase, "blocked");
  assert.deepEqual(shell[0].argument_shapes, ["string"]);
  probe = {
    before_shell_count: beforeShellCount,
    note: "1. Welcome to Joplin!",
    attachment,
    revealed,
    image_visible: await image.isVisible(),
    shell,
    page_errors: pageErrors,
  };
  return application;
};

try {
  const result = await captureElectronScenario(
    new PlaywrightElectronActiveProvider(process.env, launch),
    {
      executable_path: resolve(values.executable),
      application_path: resolve(values.application),
      args: [
        "--no-sandbox",
        "--disable-gpu",
        `--user-data-dir=${profile}`,
        "--profile",
        profile,
      ],
      actions: [
        {
          step_id: "settle-after-reveal",
          kind: "wait",
          window_index: 0,
          duration_ms: 100,
        },
      ],
    },
    { signal: controller.signal },
  );
  await writeFile(join(profile, "result.json"), JSON.stringify(result));
  const capture = result.ok
    ? result.value.normalized_result
    : result.error.partialObservation?.capture;
  const retainedShell = capture?.timeline.events.filter(
    (event) =>
      event.kind === "shell-attempt" && event.event === "showItemInFolder",
  );
  if (probe)
    assert.deepEqual(
      retainedShell,
      probe.shell,
      "The shared capture must retain the observed shell event",
    );
  console.log(
    JSON.stringify({
      profile,
      runtime,
      staged_hook_sha256: stagedHookHashes,
      elapsed_ms: performance.now() - started,
      launch_transport: values["argv-shim-transport"]
        ? "controlled-argv-shim"
        : "standard-staged-argv",
      probe: probe ?? null,
      provider_ok: result.ok,
      error: result.ok
        ? null
        : {
            tag: result.error._tag,
            reason: result.error.reason,
            diagnostics: result.error.diagnostics,
          },
      coverage: capture?.coverage,
      retention: capture?.retention,
      actions: capture?.actions,
      deadline_triggered: controller.signal.aborted,
      workflow_status:
        result.ok && probe !== undefined ? "verified" : "partial-or-failed",
    }),
  );
  assert.ok(probe, "Real Joplin resource reveal was not verified");
  assert.ok(result.ok, "Provider cleanup remains unverified");
} catch (cause) {
  console.log(
    JSON.stringify({ verifier_failure: String(cause), probe: probe ?? null }),
  );
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  if (application && child?.exitCode === null && child?.signalCode === null) {
    let timer;
    await Promise.race([
      application.close().catch(() => undefined),
      new Promise((resolve) => {
        timer = setTimeout(resolve, 5_000);
      }),
    ]);
    clearTimeout(timer);
  }
}
// The external owned scope recovers leftovers; that is not provider cleanup.
process.exit(process.exitCode ?? 0);
