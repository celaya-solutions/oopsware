import { expect } from "vitest";
import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import { createPackageWithOptions } from "@electron/asar";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { aliasSelectionBudgetSource } from "../../fixtures/javascriptAliasSelectionBudget.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { analyzeJavaScriptDirectory } from "../../support/cli/javascriptApplication.js";
import { writeFixtureFiles } from "../../support/javascriptApplicationFixture.js";

const fixtureImports = (loader: string) => {
  switch (loader) {
    case "pattern alias":
      return { "#window/*": "./proxy/*.cjs" };
    case "recursive alias":
      return { "#entry": "#window", "#window": "./proxy/window.cjs" };
    case "external-package alias":
      return { "#entry": "fixture-window" };
    case "builtin alias":
      return { "#entry": "fs" };
    case "electron alias":
      return { "#entry": "electron" };
    case "electron main alias":
      return { "#entry": "electron/main" };
    default:
      return { "#entry": null };
  }
};

cliTest.for(
  (["CLI", "stdio MCP"] as const).flatMap((surface) =>
    [
      "direct",
      "alias",
      "call",
      "apply",
      "bind",
      "reflect",
      "captured reflect",
      "local",
    ].map((setter) => ({
      surface,
      setter,
    })),
  ),
)(
  "keeps loadFile roots unknown after an Electron application path setter through $surface ($setter)",
  async ({ surface, setter }, { cli }) => {
    const root = await createTestTempDirectory("rea-app-path-setter-");
    const change =
      setter === "direct"
        ? 'const { app } = require("electron"); app.setAppPath("/runtime/changed");'
        : setter === "alias"
          ? 'const { app: runtime } = require("electron/main"); const current = runtime; current["setAppPath"]("/runtime/changed");'
          : setter === "call"
            ? 'const { app } = require("electron"); app.setAppPath.call(app, "/runtime/changed");'
            : setter === "apply"
              ? 'const { app } = require("electron"); app.setAppPath.apply(app, ["/runtime/changed"]);'
              : setter === "bind"
                ? 'const { app } = require("electron"); const change = app.setAppPath.bind(app); change("/runtime/changed");'
                : setter === "reflect"
                  ? 'const { app } = require("electron"); Reflect.apply(app.setAppPath, app, ["/runtime/changed"]);'
                  : setter === "captured reflect"
                    ? 'const { app } = require("electron"); const invoke = Reflect.apply; invoke(app.setAppPath, app, ["/runtime/changed"]);'
                    : 'const app = { setAppPath() {} }; app.setAppPath("/runtime/changed");';
    await writeFixtureFiles(root, {
      "a/package.json": JSON.stringify({ main: "main.cjs" }),
      "a/main.cjs": `${change} require("./window.cjs");`,
      "a/window.cjs":
        'const { BrowserWindow } = require("electron"); new BrowserWindow().loadFile("index.html");',
      "a/index.html": "package-root page",
      "index.html": "artifact-root decoy",
    });
    const { graph } = await analyzeJavaScriptDirectory(surface, cli, root);
    const role = graph.nodes.find(({ kind }) => kind === "electron-renderer");
    const target = setter === "local" ? "a/index.html" : null;
    expect(role?.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          properties: expect.objectContaining({
            resolution_status: target === null ? "unavailable" : "resolved",
            resolved_path: target,
          }),
        }),
      ]),
    );
    expect(
      graph.edges
        .filter(
          ({ source_node_id, relation }) =>
            source_node_id === role?.node_id && relation === "maps_to",
        )
        .map(({ properties }) => properties.resolved_path),
    ).toEqual(target === null ? [] : [target]);
  },
);

const unprovenLoaderSources: Readonly<Record<string, string>> = {
  "custom iterator assignment module loader":
    'const values = { *[Symbol.iterator]() { yield module; } }; const holder = {}; [holder.loader] = values; holder.loader.require("../shared/window.cjs");',
  "replaced iterator assignment module loader":
    'const values = [{}]; values[Symbol.iterator] = function* () { yield module; }; const holder = {}; [holder.loader] = values; holder.loader.require("../shared/window.cjs");',
  "custom iterator rest declaration module loader":
    'const values = { *[Symbol.iterator]() { yield module; } }; const [...holder] = values; holder[0].require("../shared/window.cjs");',
  "native array assignment local loader":
    'const holder = { loader: module }; [holder.loader] = [{ require() {} }]; holder.loader.require("../shared/window.cjs");',
  "logical rewrite assignment module loader":
    'const holder = {}; holder.loader ??= module; holder.loader.require = replacement; require("../shared/window.cjs");',
  "object rest declaration module loader":
    'const { ...holder } = { loader: module }; holder.loader.require("../shared/window.cjs");',
  "array rest declaration module loader":
    'const [...holder] = [module]; holder[0].require("../shared/window.cjs");',
  "object assignment module loader":
    'const holder = {}; ({ loader: holder.loader } = { loader: module }); holder.loader.require("../shared/window.cjs");',
  "array assignment module loader":
    'const holder = {}; [holder.loader] = [module]; holder.loader.require("../shared/window.cjs");',
  "nested assignment module loader":
    'const holder = {}; ({ inner: { loader: holder.loader } } = { inner: { loader: module } }); holder.loader.require("../shared/window.cjs");',
  "default assignment module loader":
    'const holder = {}; ({ loader: holder.loader = module } = {}); holder.loader.require("../shared/window.cjs");',
  "rest array assignment module loader":
    'const holder = {}; let ignored; [ignored, ...holder.loaders] = [{}, module]; holder.loaders[0].require("../shared/window.cjs");',
  "delegate assignment module loader":
    'const holder = {}; ({ load: holder.load } = { load: module.require }); holder.load.call(module, "../shared/window.cjs");',
  "rewrite assignment module loader":
    'const holder = {}; ({ loader: holder.loader } = { loader: module }); holder.loader.require = replacement; require("../shared/window.cjs");',
  "exports assignment local loader":
    'const holder = {}; ({ exports: holder.loader } = module); holder.loader.require("../shared/window.cjs");',
  "rest assignment local loader":
    'const holder = {}; ({ ...holder.loader } = module); holder.loader.require("../shared/window.cjs");',
  "excluded assignment local loader":
    'const holder = {}; let ignored; ({ loader: ignored, ...holder.copy } = { loader: module }); holder.copy.loader.require("../shared/window.cjs");',
  "inactive default assignment local loader":
    'const holder = {}; ({ loader: holder.loader = module } = { loader: { require() {} } }); holder.loader.require("../shared/window.cjs");',
  "overwritten assignment local loader":
    'const holder = { loader: module }; ({ loader: holder.loader } = { loader: { require() {} } }); holder.loader.require("../shared/window.cjs");',
  "bounded alias selection": aliasSelectionBudgetSource(),
  "captured module delegate":
    'const load = module.require; load.call(module, "../shared/window.cjs");',
  "destructured module delegate":
    'const { require: load } = module; load.apply(module, ["../shared/window.cjs"]);',
  "selected local delegate slots":
    'const table = { x: {}, y: {}, z: module }; const target = flag ? table.x : table.y; target.require = replacement; require("../shared/window.cjs");',
  "local assigned loader":
    'const holder = {}; holder.loader = { require() {} }; holder.loader.require("../shared/window.cjs");',
  "overwritten local loader":
    'const holder = { loader: module }; holder.loader = { require() {} }; holder.loader.require("../shared/window.cjs");',
  "normalized absolute ESM": 'import "/discard%2F/../shared/window.cjs";',
  "normalized absolute dynamic import":
    'import("/discard%5C/../shared/window.cjs");',
  "rewritten CommonJS delegate":
    'module.require = replacement; require("../shared/window.cjs");',
  "nested rewritten CommonJS delegate":
    'const holder = { loader: module }; holder.loader.require = replacement; require("../shared/window.cjs");',
  "assigned rewritten CommonJS delegate":
    'const holder = {}; holder.loader = module; holder.loader.require = replacement; require("../shared/window.cjs");',
  "assigned module loader":
    'const holder = {}; holder.loader = module; holder.loader.require("../shared/window.cjs");',
  "nested module loader":
    'const holder = { loader: module }; holder.loader.require("../shared/window.cjs");',
  "destructured module loader":
    'const holder = { loader: module }; const { loader } = holder; loader.require("../shared/window.cjs");',
  "array module loader":
    'const holder = [module]; holder[0].require("../shared/window.cjs");',
  "bound module loader":
    'const load = module.require.bind(module); load("../shared/window.cjs");',
  "bound module alias loader":
    'const current = module; const load = current.require.bind(current); load("../shared/window.cjs");',
  "computed bound module loader":
    'const load = module["require"].bind(module); load("../shared/window.cjs");',
  "fallback module alias":
    'const { loader = module } = options; loader.require("../shared/window.cjs");',
  "inactive fallback":
    'const { loader = module } = { loader: {} }; loader.require("../shared/window.cjs");',
  "absolute ESM": 'import "/shared/window.cjs";',
  "invalid absolute ESM": 'import "/shared%2Fwindow.cjs";',
  "invalid absolute dynamic import": 'import("/shared%5Cwindow.cjs");',
  "absolute dynamic import": 'import("/shared/window.cjs");',
  "absolute file URL": 'import "file:///shared/window.cjs";',
  "dynamic file URL": 'import("file:///shared/window.cjs");',
  "createRequire base":
    'import { createRequire } from "node:module"; const require = createRequire(new URL("../other/nested/main.cjs", import.meta.url)); require("../shared/window.cjs");',
};

const uncheckedModuleLoaders = new Set([
  "custom iterator assignment module loader",
  "replaced iterator assignment module loader",
  "custom iterator rest declaration module loader",
  "logical rewrite assignment module loader",
  "object rest declaration module loader",
  "array rest declaration module loader",
  "object assignment module loader",
  "array assignment module loader",
  "nested assignment module loader",
  "default assignment module loader",
  "rest array assignment module loader",
  "delegate assignment module loader",
  "rewrite assignment module loader",
  "bounded alias selection",
  "captured module delegate",
  "destructured module delegate",
  "rewritten CommonJS delegate",
  "nested rewritten CommonJS delegate",
  "assigned rewritten CommonJS delegate",
  "assigned module loader",
  "module.require",
  "computed module.require",
  "module alias",
  "later reassigned module alias",
  "conditional module alias",
  "fallback module alias",
  "bound module loader",
  "bound module alias loader",
  "computed bound module loader",
  "nested module loader",
  "destructured module loader",
  "array module loader",
]);

const fixtureMainPath = (loader: string): string => {
  switch (loader) {
    case "absolute ESM":
    case "normalized absolute ESM":
    case "normalized absolute dynamic import":
    case "invalid absolute ESM":
    case "invalid absolute dynamic import":
    case "absolute dynamic import":
    case "absolute file URL":
    case "dynamic file URL":
    case "createRequire base":
      return "main.mjs";
    case "absolute main":
      return "/opt/app/main.cjs";
    case "Windows relative main":
      return "sub\\main.cjs";
    case "Windows drive-relative main":
      return "C:main.cjs";
    case "percent main":
    case "single percent main":
      return "main%2Fentry.cjs";
    default:
      return "main.cjs";
  }
};

const fixtureMainInventoryPath = (loader: string, main: string): string => {
  if (loader === "absolute main") return "opt/app/main.cjs";
  if (loader === "Windows relative main") return "b/sub/main.cjs";
  if (loader === "Windows drive-relative main") return "b/main.cjs";
  return `b/${main}`;
};

const fixtureLoaderSource = (loader: string): string =>
  unprovenLoaderSources[loader] ??
  (loader === "resolve-only"
    ? 'require.resolve("../shared/window.cjs");'
    : loader === "missing wildcard alias"
      ? 'require("#missing/*");'
      : loader === "absolute require"
        ? 'require("/shared/window.cjs");'
        : loader === "projected module"
          ? 'const { exports: api } = module; api.require = () => {}; api.require("../shared/window.cjs");'
          : loader === "absolute main"
            ? 'require("../../shared/window.cjs");'
            : loader === "later reassigned module alias"
              ? 'let current = module; current.require("../shared/window.cjs"); current = other;'
              : loader === "earlier reassigned module alias"
                ? 'let current = module; current = { require() {} }; current.require("../shared/window.cjs");'
                : loader === "conditional module alias"
                  ? 'let current = module; if (flag) current = other; current.require("../shared/window.cjs");'
                  : loader === "module.require"
                    ? 'module.require("../shared/window.cjs");'
                    : loader === "computed module.require"
                      ? 'module["require"]("../shared/window.cjs");'
                      : loader === "module alias"
                        ? 'const current = module; current.require("../shared/window.cjs");'
                        : loader === "local module"
                          ? 'function local(module) { module.require("../shared/window.cjs"); }'
                          : loader === "pattern alias"
                            ? 'require("#window/window");'
                            : loader.endsWith("alias")
                              ? 'require("#entry");'
                              : 'require("../shared/window.cjs");');

cliTest.for(
  (["CLI", "stdio MCP"] as const).flatMap((surface) =>
    [
      "module.require",
      "computed module.require",
      "module alias",
      "later reassigned module alias",
      "earlier reassigned module alias",
      "conditional module alias",
      "absolute main",
      "Windows relative main",
      "Windows drive-relative main",
      "percent main",
      "pattern alias",
      "recursive alias",
      "external-package alias",
      "builtin alias",
      "electron alias",
      "electron main alias",
      "blocked alias",
      "local module",
      "projected module",
      "resolve-only",
      "missing wildcard alias",
      "absolute require",
      ...Object.keys(unprovenLoaderSources),
      "single percent main",
    ].map((loader) => ({ surface, loader })),
  ),
)(
  "preserves competing loader ownership for $loader through $surface",
  async ({ surface, loader }, { cli }) => {
    const root = await createTestTempDirectory("rea-loader-owner-");
    const single = loader === "single percent main";
    const inert = [
      "native array assignment local loader",
      "exports assignment local loader",
      "rest assignment local loader",
      "excluded assignment local loader",
      "inactive default assignment local loader",
      "overwritten assignment local loader",
      "local assigned loader",
      "overwritten local loader",
      "invalid absolute ESM",
      "invalid absolute dynamic import",
      "builtin alias",
      "electron alias",
      "electron main alias",
      "inactive fallback",
      "blocked alias",
      "local module",
      "projected module",
      "resolve-only",
      "missing wildcard alias",
      "earlier reassigned module alias",
    ].includes(loader);
    const absolute = loader === "absolute main";
    const main = fixtureMainPath(loader);
    const imports = fixtureImports(loader);
    const load = fixtureLoaderSource(loader);
    await writeFixtureFiles(root, {
      "a/package.json": JSON.stringify({ main: "main.cjs" }),
      "a/main.cjs":
        single || absolute
          ? "module.exports = 1;"
          : 'require("../shared/window.cjs");',
      "b/package.json": JSON.stringify({ main, imports }),
      [fixtureMainInventoryPath(loader, main)]: load,
      "b/proxy/window.cjs": 'require("../../shared/window.cjs");',
      "b/node_modules/fixture-window/package.json": JSON.stringify({
        main: "index.cjs",
      }),
      "b/node_modules/fixture-window/index.cjs":
        'require("../../../shared/window.cjs");',
      "shared/window.cjs":
        'const { BrowserWindow } = require("electron"); new BrowserWindow().loadFile("index.html");',
      "a/index.html": "first application page",
      "b/index.html": "second application page",
      "shared/index.html": "source-relative decoy",
      "index.html": "artifact-root decoy",
    });
    const { graph } = await analyzeJavaScriptDirectory(surface, cli, root);
    if (loader.startsWith("Windows "))
      expect(graph.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            relation: "loads",
            properties: expect.objectContaining({
              declared_path: main,
              resolution_status: "unavailable",
              resolved_path: null,
            }),
          }),
        ]),
      );
    if (
      ["absolute require", "absolute ESM", "absolute dynamic import"].includes(
        loader,
      )
    )
      expect(graph.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            relation: "imports",
            properties: expect.objectContaining({
              specifier: "/shared/window.cjs",
              resolution_status: "unavailable",
              resolved_path: null,
            }),
          }),
        ]),
      );
    if (loader === "createRequire base")
      expect(graph.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            relation: "imports",
            properties: expect.objectContaining({
              kind: "require",
              specifier: null,
              resolved_path: null,
            }),
          }),
        ]),
      );
    if (loader.endsWith("alias") && !inert && !loader.includes("module alias"))
      expect(graph.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            relation: "imports",
            properties: expect.objectContaining({
              specifier:
                loader === "pattern alias" ? "#window/window" : "#entry",
              resolution_status: "unavailable",
            }),
          }),
        ]),
      );
    if (uncheckedModuleLoaders.has(loader))
      expect(graph.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            relation: "imports",
            properties: expect.objectContaining({
              kind: "require",
              specifier: null,
              resolved_path: null,
            }),
          }),
        ]),
      );
    const roles = graph.nodes.filter(
      ({ kind }) => kind === "electron-renderer",
    );
    expect(roles).toHaveLength(1);
    const role = roles[0];
    const target = single ? "b/index.html" : inert ? "a/index.html" : null;
    expect(role?.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          properties: expect.objectContaining({
            resolved_path: target,
            resolution_status: target === null ? "unavailable" : "resolved",
          }),
        }),
      ]),
    );
    expect(
      graph.edges
        .filter(
          ({ source_node_id, relation }) =>
            source_node_id === role?.node_id && relation === "maps_to",
        )
        .map(({ properties }) => properties.resolved_path),
    ).toEqual(target === null ? [] : [target]);
  },
);

cliTest.for(["CLI", "stdio MCP"] as const)(
  "propagates the application owner into an inventoried ASAR through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-asar-inward-");
    const source = join(root, "source");
    const application = join(root, "application");
    await writeFixtureFiles(source, {
      "window.cjs":
        'const { BrowserWindow } = require("electron"); new BrowserWindow().loadFile("index.html");',
      "index.html": "archive-root decoy",
    });
    await writeFixtureFiles(application, {
      "a/package.json": JSON.stringify({ main: "main.cjs" }),
      "a/main.cjs": 'require("../resources/code.asar/window.cjs");',
      "a/index.html": "proven application page",
    });
    await createPackageWithOptions(
      source,
      join(application, "resources/code.asar"),
      {},
    );
    const { graph } = await analyzeJavaScriptDirectory(
      surface,
      cli,
      application,
    );
    const role = graph.nodes.find(({ kind }) => kind === "electron-renderer");
    expect(role?.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          properties: expect.objectContaining({
            resolution_status: "resolved",
            resolved_path: "a/index.html",
          }),
        }),
      ]),
    );
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relation: "imports",
          properties: expect.objectContaining({
            specifier: "../resources/code.asar/window.cjs",
            resolution_status: "resolved",
            resolved_path: "resources/code.asar/window.cjs",
          }),
        }),
      ]),
    );
    expect(
      graph.edges
        .filter(
          ({ source_node_id, relation }) =>
            source_node_id === role?.node_id && relation === "maps_to",
        )
        .map(({ properties }) => properties.resolved_path),
    ).toEqual(["a/index.html"]);
  },
);

cliTest.for(
  (["CLI", "stdio MCP"] as const).flatMap((surface) =>
    [false, true].map((dynamic) => ({ surface, dynamic })),
  ),
)(
  "retains possible owners for a module across a nested ASAR boundary through $surface (dynamic=$dynamic)",
  async ({ surface, dynamic }, { cli }) => {
    const root = await createTestTempDirectory("rea-asar-module-gap-");
    const source = join(root, "source");
    const application = join(root, "application");
    await writeFixtureFiles(source, {
      "package.json": JSON.stringify({ main: "main.cjs" }),
      "main.cjs": dynamic
        ? "require(process.env.WINDOW_MODULE);"
        : 'require("../window.cjs");',
    });
    await writeFixtureFiles(application, {
      "other/package.json": JSON.stringify({ main: "main.cjs" }),
      "other/main.cjs": 'require("../resources/window.cjs");',
      "resources/window.cjs":
        'const { BrowserWindow } = require("electron"); new BrowserWindow().loadFile("index.html");',
      "other/index.html": "false unique owner decoy",
    });
    await createPackageWithOptions(
      source,
      join(application, "resources/app.asar"),
      {},
    );
    const { graph } = await analyzeJavaScriptDirectory(
      surface,
      cli,
      application,
    );
    const role = graph.nodes.find(({ kind }) => kind === "electron-renderer");
    expect(role?.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          properties: expect.objectContaining({
            resolution_status: "unavailable",
            resolved_path: null,
          }),
        }),
      ]),
    );
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relation: "imports",
          properties: expect.objectContaining({
            specifier: dynamic ? null : "../window.cjs",
            ...(dynamic ? {} : { resolution_status: "resolved" }),
            resolved_path: dynamic ? null : "resources/window.cjs",
          }),
        }),
      ]),
    );
    expect(
      graph.edges.filter(
        ({ source_node_id, relation }) =>
          source_node_id === role?.node_id && relation === "maps_to",
      ),
    ).toEqual([]);
  },
);

cliTest.for(["CLI", "stdio MCP"] as const)(
  "resolves a proven application page across a nested ASAR boundary through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-asar-outer-page-");
    const source = join(root, "source");
    const application = join(root, "application");
    await writeFixtureFiles(source, {
      "package.json": JSON.stringify({ main: "main.cjs" }),
      "main.cjs":
        'const { BrowserWindow } = require("electron"); new BrowserWindow().loadFile("../page.html");',
    });
    await writeFixtureFiles(application, {
      "resources/page.html": "owned outer page",
    });
    await createPackageWithOptions(
      source,
      join(application, "resources/app.asar"),
      {},
    );
    const { graph } = await analyzeJavaScriptDirectory(
      surface,
      cli,
      application,
    );
    const role = graph.nodes.find(({ kind }) => kind === "electron-renderer");
    expect(role?.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          properties: expect.objectContaining({
            resolved_path: "resources/page.html",
            resolution_status: "resolved",
          }),
        }),
      ]),
    );
    expect(
      graph.edges
        .filter(
          ({ source_node_id, relation }) =>
            source_node_id === role?.node_id && relation === "maps_to",
        )
        .map(({ properties }) => properties.resolved_path),
    ).toEqual(["resources/page.html"]);
  },
);

const cases = [
  ...[
    "C:/app/preload.cjs",
    "C:\\app\\preload.cjs",
    "\\\\server\\share\\preload.cjs",
  ].map((path, index) => ({
    directory: `windows-absolute-${index}`,
    expression: JSON.stringify(path),
    target: null,
    status: "unavailable",
  })),
  {
    directory: "absolute-runtime",
    expression: '"/outside%2Fname.cjs"',
    target: null,
    status: "unavailable",
  },
  {
    directory: "literal",
    expression: 'path.join(__dirname, "preload%2F%5C%2E.cjs")',
    target: "preload%2F%5C%2E.cjs",
    status: "resolved",
  },
  {
    directory: "converted",
    expression:
      'fileURLToPath(new URL("./preload%252Fname.cjs", import.meta.url))',
    target: "preload%2Fname.cjs",
    status: "resolved",
  },
  {
    directory: "escaped",
    expression: 'path.join(__dirname, "../../outside%2Fname.cjs")',
    target: null,
    status: "rejected",
  },
  {
    directory: "ignored-prefix",
    expression:
      'path.resolve(new URL("./", import.meta.url), path.dirname(fileURLToPath(import.meta.url)), "preload%2Fname.cjs")',
    target: "preload%2Fname.cjs",
    status: "resolved",
  },
] as const;

const writeRuntimeFixture = async (root: string): Promise<void> => {
  const inert = 'throw new Error("fixture source must never execute");';
  const loadFileSource = `const { BrowserWindow } = require("electron");
      const win = new BrowserWindow();
      win.loadFile("dist%2Findex.html");
      win.loadFile("plain.html");
      win.loadFile("absent.html");`;
  await writeFixtureFiles(root, {
    "package.json": JSON.stringify({ private: true, workspaces: ["app"] }),
    ...Object.fromEntries(
      cases.map(({ directory, expression }) => [
        `${directory}/main.mjs`,
        `import { BrowserWindow, utilityProcess } from "electron";
         import path from "node:path";
         import { fileURLToPath } from "node:url";
         new BrowserWindow({ webPreferences: { preload: ${expression} } });
         utilityProcess.fork(${expression});`,
      ]),
    ),
    "literal/preload%2F%5C%2E.cjs": inert,
    "converted/preload%2Fname.cjs": inert,
    "converted/preload%252Fname.cjs": inert,
    "converted/preload/name.cjs": inert,
    "outside%2Fname.cjs": inert,
    "ignored-prefix/preload%2Fname.cjs": inert,
    "sub/main.cjs": loadFileSource,
    "dist%2Findex.html": "application target",
    "plain.html": "application target",
    "sub/dist%2Findex.html": "nested decoy",
    "sub/plain.html": "nested decoy",
    "sub/absent.html": "nested-only decoy",
    "app/package.json": JSON.stringify({ main: "sub/main.cjs" }),
    "app/sub/package.json": JSON.stringify({ type: "commonjs" }),
    "app/sub/main.cjs": loadFileSource,
    "app/dist%2Findex.html": "wrapped application target",
    "app/plain.html": "wrapped application target",
    "app/sub/dist%2Findex.html": "wrapped source decoy",
    "app/sub/plain.html": "wrapped source decoy",
    "app/sub/absent.html": "wrapped missing-target decoy",
    "external-app/package.json": JSON.stringify({ main: "../shared/main.cjs" }),
    "shared/main.cjs": loadFileSource,
    "external-app/dist%2Findex.html": "external-main application target",
    "external-app/plain.html": "external-main application target",
    "competition/package.json": JSON.stringify({ main: "main.cjs" }),
    "competition/main.cjs": 'require("./bridge.cjs");',
    "competition/bridge.cjs": 'require("./nested/main.cjs");',
    "competition/nested/package.json": JSON.stringify({ main: "main.cjs" }),
    "competition/nested/main.cjs": `${loadFileSource}\nrequire("../main.cjs");`,
    "competition/dist%2Findex.html": "running application page",
    "competition/nested/dist%2Findex.html": "competing application page",
    "import-owner/package.json": JSON.stringify({
      main: "../imported/start.cjs",
    }),
    "imported/start.cjs": 'require("./child.cjs");',
    "imported/child.cjs": loadFileSource,
    "import-owner/dist%2Findex.html": "imported application target",
    "import-owner/plain.html": "imported application target",
    "default-app/package.json": JSON.stringify({ name: "default-entry-app" }),
    "default-app/index.js": `${loadFileSource}\nrequire("./nested/main.cjs");`,
    "default-app/nested/package.json": JSON.stringify({ main: "main.cjs" }),
    "default-app/nested/main.cjs": loadFileSource,
    "default-app/nested/dist%2Findex.html": "competing default-entry page",
    "default-app/dist%2Findex.html": "default-entry application target",
    "default-app/plain.html": "default-entry application target",
    "ambiguous/package.json": JSON.stringify({ main: "sub/main.cjs" }),
    "ambiguous/sub/package.json": JSON.stringify({ main: "main.cjs" }),
    "ambiguous/third/package.json": JSON.stringify({ main: "../sub/main.cjs" }),
    "ambiguous/sub/main.cjs": loadFileSource,
    "ambiguous/dist%2Findex.html": "unproven application target",
    "ambiguous/sub/dist%2Findex.html": "unproven nested application target",
  });
  const archiveSource = await createTestTempDirectory("rea-loadfile-asar-");
  await writeFixtureFiles(archiveSource, {
    "package.json": JSON.stringify({ main: "sub/main.cjs" }),
    "sub/package.json": JSON.stringify({ type: "commonjs" }),
    "sub/main.cjs": loadFileSource,
    "dist%2Findex.html": "application target",
    "plain.html": "application target",
    "sub/dist%2Findex.html": "nested decoy",
    "sub/plain.html": "nested decoy",
    "sub/absent.html": "nested-only decoy",
    "external-app/package.json": JSON.stringify({ main: "../shared/main.cjs" }),
    "shared/main.cjs": loadFileSource,
    "external-app/dist%2Findex.html": "external-main application target",
    "external-app/plain.html": "external-main application target",
  });
  await createPackageWithOptions(archiveSource, join(root, "a.asar"), {});
  // Equal container digests must not select the other archive occurrence.
  await copyFile(join(root, "a.asar"), join(root, "b.asar"));
};

cliTest.for(["CLI", "stdio MCP"] as const)(
  "does not invent a nested default-entry owner without index.js through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-empty-default-owner-");
    for (const [directory, metadata] of [
      ["empty", { main: "" }],
      ["absent", {}],
    ] as const)
      await writeFixtureFiles(root, {
        [`${directory}/package.json`]: JSON.stringify(metadata),
        [`${directory}/helper.cjs`]:
          'const {BrowserWindow} = require("electron"); const w = new BrowserWindow(); w.loadFile("index.html");',
        [`${directory}/index.html`]: "nested decoy without launch entry",
        "index.html": "artifact-root page",
      });
    const { graph } = await analyzeJavaScriptDirectory(surface, cli, root);
    const roles = graph.nodes.filter(
      ({ kind }) => kind === "electron-renderer",
    );
    expect(roles).toHaveLength(2);
    for (const role of roles) {
      expect(role.observations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            properties: expect.objectContaining({
              resolution_status: "resolved",
              resolved_path: "index.html",
            }),
          }),
        ]),
      );
      expect(
        graph.edges
          .filter(
            ({ source_node_id, relation }) =>
              source_node_id === role.node_id && relation === "maps_to",
          )
          .map(({ properties }) => properties.resolved_path),
      ).toEqual(["index.html"]);
    }
  },
);

cliTest.for(["CLI", "stdio MCP"] as const)(
  "retains non-string main evidence while following Node index entries through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-invalid-main-owner-");
    for (const [index, main] of [123, false, null, {}, []].entries()) {
      await writeFixtureFiles(root, {
        [`a${index}/package.json`]: JSON.stringify({
          name: `invalid-${index}`,
          main,
        }),
        [`a${index}/index.js`]: `require("../shared/window${index}.cjs");`,
        [`shared/window${index}.cjs`]:
          'const { BrowserWindow } = require("electron"); const win = new BrowserWindow(); win.loadFile("index.html");',
        [`a${index}/index.html`]: "package index launch page",
        "index.html": "artifact root decoy",
      });
    }
    const { graph } = await analyzeJavaScriptDirectory(surface, cli, root);
    const packages = graph.nodes.filter(({ kind }) => kind === "package");
    expect(packages).toHaveLength(5);
    for (const node of packages)
      expect(node.observations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            properties: expect.objectContaining({
              main: null,
              main_status: "invalid",
              parse_status: "included",
              name: expect.stringMatching(/^invalid-\d$/u),
            }),
          }),
        ]),
      );
    const roles = graph.nodes.filter(
      ({ kind }) => kind === "electron-renderer",
    );
    expect(roles).toHaveLength(5);
    for (const role of roles) {
      const location = role.observations[0]?.evidence.location;
      const source =
        location?.available && location.value.kind === "source-range"
          ? location.value.source
          : null;
      const match = /^shared\/window(\d)\.cjs$/u.exec(source ?? "");
      expect(match).not.toBeNull();
      const target = `a${match?.[1]}/index.html`;
      expect(role.observations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            properties: expect.objectContaining({
              resolved_path: target,
              resolution_status: "resolved",
            }),
          }),
        ]),
      );
      expect(
        graph.edges
          .filter(
            ({ source_node_id, relation }) =>
              source_node_id === role.node_id && relation === "maps_to",
          )
          .map(({ properties }) => properties.resolved_path),
      ).toEqual([target]);
    }
  },
);

cliTest.for(
  (["CLI", "stdio MCP"] as const).flatMap((surface) => [
    { surface, source: "app/sub/main.cjs", selectedOwner: false },
    { surface, source: "shared/main.cjs", selectedOwner: false },
    { surface, source: "shared/main.cjs", selectedOwner: true },
  ]),
)(
  "keeps unselected package ownership unknown through $surface for $source (selected owner: $selectedOwner)",
  async ({ surface, source, selectedOwner }, { cli }) => {
    const root = await createTestTempDirectory("rea-selected-loadfile-");
    await writeRuntimeFixture(root);
    if (selectedOwner)
      await writeFixtureFiles(root, {
        "other-owner/package.json": JSON.stringify({
          main: "../shared/main.cjs",
        }),
        "other-owner/dist%2Findex.html": "unselected competing page",
      });
    const { graph } = await analyzeJavaScriptDirectory(surface, cli, root, {
      sourcePaths: [
        "package.json",
        ...(selectedOwner ? ["external-app/package.json"] : []),
        source,
      ],
    });
    const roles = graph.nodes.filter(
      ({ kind, observations }) =>
        kind === "electron-renderer" &&
        observations.some(
          ({ properties }) =>
            properties.runtime_path_base === "application-root",
        ),
    );
    expect(roles).toHaveLength(3);
    for (const role of roles) {
      expect(role.observations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            properties: expect.objectContaining({
              resolved_path: null,
              resolution_status: "unavailable",
            }),
          }),
        ]),
      );
      expect(
        graph.edges.filter(
          ({ source_node_id, relation }) =>
            source_node_id === role.node_id && relation === "maps_to",
        ),
      ).toEqual([]);
    }
  },
);

cliTest.for(["CLI", "stdio MCP"] as const)(
  "keeps omitted launch owners unknown between identical ASAR occurrences through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-selected-asar-owner-");
    await writeRuntimeFixture(root);
    const { graph } = await analyzeJavaScriptDirectory(surface, cli, root, {
      sourcePaths: [
        "a.asar/package.json",
        "a.asar/sub/package.json",
        "a.asar/external-app/package.json",
        "a.asar/sub/main.cjs",
        "a.asar/shared/main.cjs",
      ],
    });
    const roles = graph.nodes.filter(
      ({ kind }) => kind === "electron-renderer",
    );
    expect(roles).toHaveLength(6);
    for (const role of roles) {
      expect(role.observations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            evidence: expect.objectContaining({
              location: expect.objectContaining({
                available: true,
                value: expect.objectContaining({
                  source: expect.stringMatching(/^a\.asar\//u),
                }),
              }),
            }),
          }),
        ]),
      );
      expect(role.observations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            properties: expect.objectContaining({
              resolved_path: null,
              resolution_status: "unavailable",
            }),
          }),
        ]),
      );
      expect(
        graph.edges
          .filter(
            ({ source_node_id, relation }) =>
              source_node_id === role.node_id && relation === "maps_to",
          )
          .map(({ properties }) => properties.resolved_path),
      ).toEqual([]);
    }
  },
);

cliTest.for(["CLI", "stdio MCP"] as const)(
  "retains a selected entry owner and confines loadFile after applying its root through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-proven-partial-owner-");
    await writeFixtureFiles(root, {
      "app/package.json": JSON.stringify({ main: "main.cjs" }),
      "app/main.cjs":
        'const { BrowserWindow } = require("electron"); const win = new BrowserWindow(); win.loadFile("index.html"); win.loadFile("../shared/index.html"); win.loadFile("../../escape.html");',
      "app/helper.cjs": 'module.exports = "unrelated omitted module";',
      "index.html": "artifact-root decoy",
      "app/index.html": "proven application page",
      "shared/index.html": "valid sibling page",
      "escape.html": "escape decoy",
    });
    const { graph } = await analyzeJavaScriptDirectory(surface, cli, root, {
      sourcePaths: ["app/package.json", "app/main.cjs"],
    });
    const roles = graph.nodes.filter(
      ({ kind }) => kind === "electron-renderer",
    );
    expect(roles).toHaveLength(3);
    for (const [declaration, target, status] of [
      ["index.html", "app/index.html", "resolved"],
      ["../shared/index.html", "shared/index.html", "resolved"],
      ["../../escape.html", null, "rejected"],
    ] as const) {
      const role = roles.find(({ observations }) =>
        observations.some(
          ({ properties }) => properties.declared_path === declaration,
        ),
      );
      expect(role).toBeDefined();
      expect(role?.observations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            properties: expect.objectContaining({
              resolved_path: target,
              resolution_status: status,
            }),
          }),
        ]),
      );
      expect(
        graph.edges
          .filter(
            ({ source_node_id, relation }) =>
              source_node_id === role?.node_id && relation === "maps_to",
          )
          .map(({ properties }) => properties.resolved_path),
      ).toEqual(target === null ? [] : [target]);
    }
  },
);

cliTest.for(["CLI", "stdio MCP"] as const)(
  "keeps absolute loadFile host paths unknown through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-loadfile-absolute-");
    await writeFixtureFiles(root, {
      "app/package.json": JSON.stringify({ main: "main.cjs" }),
      "app/main.cjs":
        'const { BrowserWindow } = require("electron"); new BrowserWindow().loadFile("/dist/index.html");',
      "app/dist/index.html": "application-relative decoy",
      "dist/index.html": "artifact-root decoy",
    });
    const { graph } = await analyzeJavaScriptDirectory(surface, cli, root);
    const roles = graph.nodes.filter(
      ({ kind }) => kind === "electron-renderer",
    );
    expect(roles).toHaveLength(1);
    const role = roles[0];
    if (role === undefined) throw new Error("Missing renderer declaration");
    expect(role.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          properties: expect.objectContaining({
            declared_path: "/dist/index.html",
            resolved_path: null,
            resolution_status: "unavailable",
          }),
        }),
      ]),
    );
    expect(
      graph.edges.filter(
        ({ source_node_id, relation }) =>
          source_node_id === role.node_id && relation === "maps_to",
      ),
    ).toEqual([]);
  },
);

cliTest.for(["CLI", "stdio MCP"] as const)(
  "preserves literal-percent runtime paths through %s without executing source",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-runtime-percent-");
    await writeRuntimeFixture(root);
    const { graph } = await analyzeJavaScriptDirectory(surface, cli, root);
    for (const [sourcePath, targetRoot, declared] of (
      [
        ["sub/main.cjs", ""],
        ["app/sub/main.cjs", "app/"],
        ["shared/main.cjs", "external-app/"],
        ["default-app/index.js", "default-app/"],
        ["default-app/nested/main.cjs", null],
        ["ambiguous/sub/main.cjs", null],
        ["competition/nested/main.cjs", null],
        ["imported/child.cjs", "import-owner/"],
        ["a.asar/sub/main.cjs", "a.asar/"],
        ["b.asar/sub/main.cjs", "b.asar/"],
        ["a.asar/shared/main.cjs", "a.asar/external-app/"],
        ["b.asar/shared/main.cjs", "b.asar/external-app/"],
      ] as const
    ).flatMap(([sourcePath, targetRoot]) =>
      ["dist%2Findex.html", "plain.html", "absent.html"].map(
        (declared) => [sourcePath, targetRoot, declared] as const,
      ),
    )) {
      const role = graph.nodes.find(
        ({ kind, observations }) =>
          kind === "electron-renderer" &&
          observations.some(
            ({ properties, evidence }) =>
              properties.declared_path === declared &&
              evidence.location.available &&
              evidence.location.value.kind === "source-range" &&
              evidence.location.value.source === sourcePath,
          ),
      );
      expect(role).toBeDefined();
      if (role === undefined) throw new Error(`Missing loadFile ${declared}`);
      const expected =
        declared === "absent.html" || targetRoot === null
          ? null
          : `${targetRoot}${declared}`;
      expect(role.observations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            properties: expect.objectContaining({
              declared_path: declared,
              runtime_path_base: "application-root",
              resolved_path: expected,
              resolution_status:
                targetRoot === null
                  ? "unavailable"
                  : expected === null
                    ? "not-found"
                    : "resolved",
            }),
          }),
        ]),
      );
      expect(
        graph.edges
          .filter(
            ({ relation, source_node_id }) =>
              relation === "maps_to" && source_node_id === role.node_id,
          )
          .map(({ properties }) => properties.resolved_path),
      ).toEqual(expected === null ? [] : [expected]);
    }
    for (const { directory, target, status } of cases) {
      for (const kind of ["electron-preload", "electron-utility"] as const) {
        const nodes = graph.nodes.filter(
          ({ kind: nodeKind, observations }) =>
            nodeKind === kind &&
            observations.some(
              ({ evidence }) =>
                evidence.location.available &&
                evidence.location.value.kind === "source-range" &&
                evidence.location.value.source === `${directory}/main.mjs`,
            ),
        );
        expect(nodes).toHaveLength(1);
        const node = nodes[0];
        if (node === undefined) throw new Error(`Missing ${directory} ${kind}`);
        const resolutions = node.observations.filter(
          ({ properties }) => "resolution_status" in properties,
        );
        expect(resolutions).not.toHaveLength(0);
        for (const { properties } of resolutions) {
          expect(properties).toMatchObject({
            resolved_path: target === null ? null : `${directory}/${target}`,
            resolution_status: status,
          });
        }
        const mappedPaths = graph.edges
          .filter(
            ({ relation, source_node_id }) =>
              relation === "maps_to" && source_node_id === node.node_id,
          )
          .map(({ properties }) => properties.resolved_path);
        expect([...new Set(mappedPaths)]).toEqual(
          target === null ? [] : [`${directory}/${target}`],
        );
      }
    }
  },
);

cliTest.for(
  (["CLI", "stdio MCP"] as const).flatMap((surface) =>
    ["unread", "included-inert", "included-competing"].map((owner) => ({
      surface,
      owner,
    })),
  ),
)(
  "retains unread competing launch owners across an ASAR boundary through $surface ($owner)",
  async ({ surface, owner }, { cli }) => {
    const root = await createTestTempDirectory("rea-unread-asar-owner-");
    const source = join(root, "source");
    const application = join(root, "application");
    await writeFixtureFiles(source, {
      "window.cjs":
        'const { BrowserWindow } = require("electron"); new BrowserWindow().loadFile("index.html");',
      "index.html": "archive-root decoy",
    });
    await writeFixtureFiles(application, {
      "a/package.json": JSON.stringify({ main: "main.cjs" }),
      "a/main.cjs": 'require("../resources/shared.asar/window.cjs");',
      "a/index.html": "first application page",
      "b/package.json": JSON.stringify({ main: "main.cjs" }),
      "b/main.cjs":
        owner === "included-inert"
          ? "module.exports = 1;"
          : 'require("../resources/shared.asar/window.cjs");',
      "b/index.html": "competing application page",
    });
    await createPackageWithOptions(
      source,
      join(application, "resources/shared.asar"),
      {},
    );
    const { graph } = await analyzeJavaScriptDirectory(
      surface,
      cli,
      application,
      {
        sourcePaths: [
          "a/package.json",
          "a/main.cjs",
          "a/index.html",
          "resources/shared.asar/window.cjs",
          "resources/shared.asar/index.html",
          ...(owner === "unread"
            ? []
            : ["b/package.json", "b/main.cjs", "b/index.html"]),
        ],
      },
    );
    const roles = graph.nodes.filter(
      ({ kind }) => kind === "electron-renderer",
    );
    expect(roles).toHaveLength(1);
    const role = roles[0];
    const target = owner === "included-inert" ? "a/index.html" : null;
    expect(role?.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          properties: expect.objectContaining({
            resolved_path: target,
            resolution_status: target === null ? "unavailable" : "resolved",
          }),
        }),
      ]),
    );
    expect(
      graph.edges
        .filter(
          ({ relation, source_node_id }) =>
            relation === "maps_to" && source_node_id === role?.node_id,
        )
        .map(({ properties }) => properties.resolved_path),
    ).toEqual(target === null ? [] : [target]);
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relation: "imports",
          properties: expect.objectContaining({
            specifier: "../resources/shared.asar/window.cjs",
            resolution_status: "resolved",
            resolved_path: "resources/shared.asar/window.cjs",
          }),
        }),
      ]),
    );
  },
);

cliTest.for(["CLI", "stdio MCP"] as const)(
  "keeps every application root unknown when three owners import one setter through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-shared-app-setter-");
    await writeFixtureFiles(root, {
      "shared/change.cjs":
        'const { app } = require("electron"); app.setAppPath("/runtime/changed");',
      ...Object.fromEntries(
        ["a", "b", "c"].flatMap((owner) => [
          [`${owner}/package.json`, JSON.stringify({ main: "main.cjs" })],
          [
            `${owner}/main.cjs`,
            'require("../shared/change.cjs"); require("./window.cjs");',
          ],
          [
            `${owner}/window.cjs`,
            `// Application ${owner}\nconst { BrowserWindow } = require("electron"); new BrowserWindow().loadFile("index.html");`,
          ],
          [`${owner}/index.html`, `application ${owner} page`],
        ]),
      ),
    });
    const { graph } = await analyzeJavaScriptDirectory(surface, cli, root);
    const roles = graph.nodes.filter(
      ({ kind }) => kind === "electron-renderer",
    );
    expect(roles).toHaveLength(3);
    for (const role of roles) {
      expect(role.observations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            properties: expect.objectContaining({
              resolution_status: "unavailable",
              resolved_path: null,
            }),
          }),
        ]),
      );
      expect(
        graph.edges.filter(
          ({ relation, source_node_id }) =>
            relation === "maps_to" && source_node_id === role.node_id,
        ),
      ).toEqual([]);
    }
  },
);

cliTest.for(
  (["CLI", "stdio MCP"] as const).flatMap((surface) =>
    ["relative", "bare"].map((request) => ({ surface, request })),
  ),
)(
  "retains package main ownership after an ASAR escape through $surface ($request)",
  async ({ surface, request }, { cli }) => {
    const root = await createTestTempDirectory("rea-asar-metadata-");
    const source = join(root, "source");
    const application = join(root, "application");
    const directory =
      request === "bare" ? "resources/node_modules/fixture" : "resources/pkg";
    await writeFixtureFiles(source, {
      "package.json": JSON.stringify({ main: "main.cjs" }),
      "main.cjs":
        request === "bare" ? 'require("fixture");' : 'require("../pkg");',
    });
    await writeFixtureFiles(application, {
      [`${directory}/package.json`]: JSON.stringify({ main: "actual.cjs" }),
      [`${directory}/actual.cjs`]:
        request === "bare"
          ? 'require("../../window.cjs");'
          : 'require("../window.cjs");',
      [`${directory}/index.js`]: "module.exports = 1;",
      "other/package.json": JSON.stringify({ main: "main.cjs" }),
      "other/main.cjs": 'require("../resources/window.cjs");',
      "resources/window.cjs":
        'const { BrowserWindow } = require("electron"); new BrowserWindow().loadFile("index.html");',
      "other/index.html": "false unique owner decoy",
    });
    await createPackageWithOptions(
      source,
      join(application, "resources/app.asar"),
      {},
    );
    const { graph } = await analyzeJavaScriptDirectory(
      surface,
      cli,
      application,
    );
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relation: "imports",
          properties: expect.objectContaining({
            specifier: request === "bare" ? "fixture" : "../pkg",
            resolution_status: "resolved",
            resolved_path: `${directory}/actual.cjs`,
          }),
        }),
      ]),
    );
    const roles = graph.nodes.filter(
      ({ kind }) => kind === "electron-renderer",
    );
    expect(roles).toHaveLength(1);
    expect(roles[0]?.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          properties: expect.objectContaining({
            resolution_status: "unavailable",
            resolved_path: null,
          }),
        }),
      ]),
    );
    expect(
      graph.edges.filter(
        ({ relation, source_node_id }) =>
          relation === "maps_to" && source_node_id === roles[0]?.node_id,
      ),
    ).toEqual([]);
  },
);
