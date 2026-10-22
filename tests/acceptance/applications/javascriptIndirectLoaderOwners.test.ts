import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { analyzeJavaScriptDirectory } from "../../support/cli/javascriptApplication.js";
import { writeFixtureFiles } from "../../support/javascriptApplicationFixture.js";

const cases = [
  {
    name: "typed member store retains returned module ownership",
    mainFile: "main.ts",
    load: 'const box={make:()=>({require(){}})};(box.make as any)=()=>module;box.make().require("../shared/window.cjs");',
    possible: true,
  },
  {
    name: "typed local member store stays inert",
    mainFile: "main.ts",
    load: 'const box={make:()=>module};(box.make as any)=()=>({require(){}});box.make().require("../shared/window.cjs");',
    possible: false,
  },
  {
    name: "assignment result retains module receiver",
    load: 'let holder;(holder=module).require("../shared/window.cjs");',
    possible: true,
  },
  {
    name: "assignment result retains local receiver",
    load: 'let holder;(holder={require(){}}).require("../shared/window.cjs");',
    possible: false,
  },
  {
    name: "captured wrapper require retains loader ownership",
    load: 'const load=require;load("../shared/window.cjs");',
    possible: true,
  },
  {
    name: "captured local callable stays inert",
    load: 'const local=()=>{};const load=local;load("../shared/window.cjs");',
    possible: false,
  },
  {
    name: "require.resolve does not execute its resolved module",
    load: 'require.resolve("../shared/window.cjs");',
    possible: false,
  },
  {
    name: "require.main is not an implicit module loader",
    load: 'require.main("../shared/window.cjs");',
    possible: false,
  },
  {
    name: "createRequire alias retains its source module base",
    mainFile: "main.mjs",
    load: 'import {createRequire} from "node:module";const load=createRequire(import.meta.url);load("../shared/window.cjs");',
    possible: true,
  },
  {
    name: "conditional opaque factory retains competing loader ownership",
    mainFile: "main.mjs",
    load: 'import {createRequire as native} from "node:module";const make=flag?native:getFactory();const load=make(import.meta.url);load("./window.cjs");',
    possible: true,
  },
  {
    name: "only local returned factory stays inert",
    mainFile: "main.mjs",
    load: 'const getFactory=()=>()=>()=>({});const make=getFactory();const load=make(import.meta.url);load("../shared/window.cjs");',
    possible: false,
  },
  {
    name: "local createRequire name stays inert",
    mainFile: "main.mjs",
    load: 'const createRequire=()=>()=>{};const load=createRequire(import.meta.url);load("../shared/window.cjs");',
    possible: false,
  },
  {
    name: "replaced createRequire factory stays inert",
    mainFile: "main.mjs",
    load: 'import * as mod from "node:module";mod.default.createRequire=()=>()=>({});const load=mod.default.createRequire(import.meta.url);load("../shared/window.cjs");',
    possible: false,
  },
  {
    name: "CommonJS module has no synthetic default factory",
    load: 'const load=require("node:module").default.createRequire(import.meta.url);load("../shared/window.cjs");',
    possible: false,
  },
  {
    name: "conditional call replacement retains native loader alternative",
    mainFile: "main.mjs",
    load: 'import {createRequire as make} from "node:module";const load=make(import.meta.url);if(flag)load.call=()=>{};load.call(null,"../shared/window.cjs");',
    possible: true,
  },
  {
    name: "conditional apply replacement retains native loader alternative",
    mainFile: "main.mjs",
    load: 'import {createRequire as make} from "node:module";const load=make(import.meta.url);if(flag)load.apply=()=>{};load.apply(null,["../shared/window.cjs"]);',
    possible: true,
  },
  {
    name: "replaced created-loader call stays inert",
    mainFile: "main.mjs",
    load: 'import {createRequire as make} from "node:module";const load=make(import.meta.url);load.call=()=>{};load.call(null,"../shared/window.cjs");',
    possible: false,
  },
  {
    name: "changed Function call retains loader argument uncertainty",
    mainFile: "main.mjs",
    load: 'import {createRequire as make} from "node:module";const load=make(import.meta.url);Function.prototype.call=()=>({});load.call(null,"./inert.cjs");',
    possible: true,
  },
  {
    name: "changed Function apply retains loader argument uncertainty",
    mainFile: "main.mjs",
    load: 'import {createRequire as make} from "node:module";const load=make(import.meta.url);Function.prototype.apply=()=>({});load.apply(null,["./inert.cjs"]);',
    possible: true,
  },
  {
    name: "custom array iterator preserves loader ownership",
    load: 'Array.prototype[Symbol.iterator]=function*(){yield "../shared/window.cjs"};require(...["./inert.cjs"]);',
    possible: true,
  },
  {
    name: "Reflect.apply retains module delegate ownership",
    load: 'Reflect.apply(module.require,module,["../shared/window.cjs"]);',
    possible: true,
  },
  {
    name: "local Reflect.apply stays inert",
    load: 'const Reflect={apply(){}};Reflect.apply(module.require,module,["../shared/window.cjs"]);',
    possible: false,
  },
  {
    name: "noncallable generic receiver excludes callable children",
    load: 'const get=()=>({});const invoke=get.call;const holder={invoke,other:()=>module};holder.invoke(null).require("../shared/window.cjs");',
    possible: false,
  },
  {
    name: "callable generic receiver retains its return",
    load: 'const get=()=>({});const invoke=get.call;const holder=()=>module;holder.invoke=invoke;holder.other=()=>({});holder.invoke(null).require("../shared/window.cjs");',
    possible: true,
  },
  {
    name: "destructured module alias retains own copied delegate",
    load: 'let selected;({selected}={selected:module});selected.require=module.require;const copy={...module};const load=copy.require;load.call(module,"../shared/window.cjs");',
    possible: true,
  },
  {
    name: "destructured local alias does not change module copies",
    load: 'let selected;({selected}={selected:{require(){}}});selected.require=module.require;const copy={...module};const load=copy.require;load.call(module,"../shared/window.cjs");',
    possible: false,
  },
  {
    name: "inherited delegate excluded from rest",
    load: 'const {...h}=module;h.require.call(module,"../shared/window.cjs");',
    possible: false,
  },
  {
    name: "own delegate retained in spread",
    load: 'module.require=module.require;const h={...module};h.require.call(module,"../shared/window.cjs");',
    possible: true,
  },
  {
    name: "nested module retained in spread",
    load: 'const h={...{loader:module}};h.loader.require("../shared/window.cjs");',
    possible: true,
  },
  {
    name: "require-named delegate",
    load: 'const h={require:module.require};h.require.call(module,"../shared/window.cjs");',
    possible: true,
  },
  {
    name: "require-named local",
    load: 'const h={require(){}};h.require.call(module,"../shared/window.cjs");',
    possible: false,
  },
  {
    name: "require-named applied delegate",
    load: 'const h={require:module.require};h.require.apply(module,["../shared/window.cjs"]);',
    possible: true,
  },
  {
    name: "require-named applied local",
    load: 'const h={require(){}};h.require.apply(module,["../shared/window.cjs"]);',
    possible: false,
  },
  {
    name: "module receiver",
    load: '(0,module).require("../shared/window.cjs");',
    possible: true,
  },
  {
    name: "main module receiver",
    load: 'require.main.require("../shared/window.cjs");',
    possible: true,
  },
  {
    name: "process main module receiver",
    load: 'process.mainModule.require("../shared/window.cjs");',
    possible: true,
  },
  {
    name: "local process main module receiver",
    load: 'const process={mainModule:{require(){}}};process.mainModule.require("../shared/window.cjs");',
    possible: false,
  },
  {
    name: "local main module receiver",
    load: 'const require={main:{require(){}}};require.main.require("../shared/window.cjs");',
    possible: false,
  },
  {
    name: "captured delegate",
    load: 'const load=(0,module.require);load("../shared/window.cjs");',
    possible: true,
  },
  {
    name: "local receiver",
    load: '(module,{require(){}}).require("../shared/window.cjs");',
    possible: false,
  },
  {
    name: "local final delegate",
    load: 'const load=(module.require,()=>{});load("../shared/window.cjs");',
    possible: false,
  },
] as const;

cliTest.for(
  (["CLI", "stdio MCP"] as const).flatMap((surface) =>
    cases.map((test) => ({ ...test, surface })),
  ),
)(
  "preserves $name loader owner uncertainty through $surface",
  async (testCase, { cli }) => {
    const { surface, load, possible } = testCase;
    const mainFile = "mainFile" in testCase ? testCase.mainFile : "main.cjs";
    const root = await createTestTempDirectory("rea-sequence-loader-");
    await writeFixtureFiles(root, {
      "a/package.json": JSON.stringify({ main: mainFile }),
      [`a/${mainFile}`]: `throw new Error('Static fixture must never execute');${load}`,
      "a/inert.cjs":
        "throw new Error('Static inert decoy must never execute');",
      "a/window.cjs":
        "throw new Error('Static factory-base decoy must never execute');",
      "a/index.html": "possible page",
      "b/package.json": '{"main":"main.cjs"}',
      "b/main.cjs": `throw new Error('Static fixture must never execute');require('../shared/window.cjs');`,
      "b/index.html": "proven page",
      "shared/window.cjs": `throw new Error('Static fixture must never execute');const {BrowserWindow}=require('electron');new BrowserWindow().loadFile('index.html');`,
      "shared/index.html": "source-relative decoy",
      "index.html": "artifact-root decoy",
    });
    const { graph, statistics } = await analyzeJavaScriptDirectory(
      surface,
      cli,
      root,
    );
    expect(statistics.parse_failures).toBe(0);
    const roles = graph.nodes.filter(
      ({ kind }) => kind === "electron-renderer",
    );
    expect(roles).toHaveLength(1);
    expect(roles[0]?.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          properties: expect.objectContaining({
            resolution_status: possible ? "unavailable" : "resolved",
          }),
        }),
      ]),
    );
    const mapped = graph.edges.filter(
      ({ relation, source_node_id }) =>
        relation === "maps_to" && source_node_id === roles[0]?.node_id,
    );
    expect(mapped).toHaveLength(possible ? 0 : 1);
    if (!possible)
      expect(mapped[0]?.properties.resolved_path).toBe("b/index.html");
  },
);
