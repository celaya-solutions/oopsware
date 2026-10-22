import { Module, createRequire } from "node:module";
import * as path from "node:path";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";
import { unshadowedReferenceSourceRequireCalls } from "../referenceSourceRequireBindings.js";

it.each(["require", "require.resolve", "require.main"])(
  "distinguishes invoked loading from reference association for %s",
  (callee) => {
    const source = `${callee}('node:path');`;
    const execute = () =>
      runInNewContext(source, { require: createRequire(import.meta.url) });
    if (callee === "require") expect(execute().join).toBe(path.join);
    else if (callee === "require.resolve") expect(execute()).toBe("node:path");
    else expect(execute).toThrow();
    const analysis = analyzeJavaScriptStaticSource(source);
    expect(analysis.parse_error_count).toBe(0);
    expect(analysis.references).toEqual(
      callee === "require"
        ? [expect.objectContaining({ kind: "require", specifier: "node:path" })]
        : [],
    );
    const parsed = parseJavaScriptSource(source);
    if (parsed === null) throw new Error("Expected loader association fixture");
    expect(
      unshadowedReferenceSourceRequireCalls(parsed, "entry.cjs").size,
    ).toBe(1);
  },
);

const imported = "import {createRequire as make} from 'node:module';";
it.each([
  [
    "proven factory",
    `${imported}const require=make(import.meta.url);require('node:path');`,
    1,
    "node:path",
  ],
  [
    "opaque replacement factory",
    "import*as mod from'node:module';mod.default.createRequire=replacement;const require=mod.default.createRequire(import.meta.url);require('node:path');",
    0,
    null,
  ],
] as const)(
  "uses invocation proof for external source association after a %s",
  (_name, source, associated, specifier) => {
    const parsed = parseJavaScriptSource(source);
    if (parsed === null) throw new Error("Expected factory proof fixture");
    expect(
      unshadowedReferenceSourceRequireCalls(parsed, "entry.mjs").size,
    ).toBe(associated);
    const analysis = analyzeJavaScriptStaticSource(source);
    expect(analysis.parse_error_count).toBe(0);
    expect(
      analysis.references.filter(({ kind }) => kind === "require"),
    ).toEqual([expect.objectContaining({ kind: "require", specifier })]);
  },
);

it.each([
  [
    "captured wrapper",
    "const load=require;load('node:path')",
    "node:path",
    true,
  ],
  [
    "wrapper member",
    "const box={load:require};box.load('node:path')",
    "node:path",
    true,
  ],
  [
    "wrapper array",
    "const box=[require];box[0]('node:path')",
    "node:path",
    true,
  ],
  [
    "projected wrapper",
    "const {load}={load:require};load('node:path')",
    "node:path",
    true,
  ],
  [
    "captured before wrapper replacement",
    "const load=require;require=()=>({});load('node:path')",
    "node:path",
    true,
  ],
  [
    "shadowed wrapper",
    "const require=()=>({});const load=require;load('node:path')",
    undefined,
    false,
  ],
  [
    "delegate replaced after capture",
    "const load=require;module.require=()=>({});load('node:path')",
    null,
    false,
  ],
] as const)(
  "retains the selected native %s value",
  (_name, source, specifier, host) => {
    const module = new Module("wrapper-alias.cjs");
    const result = runInNewContext(source, {
      module,
      require: (request: string) => module.require(request),
    });
    expect(result.join === path.join).toBe(host);
    const analysis = analyzeJavaScriptStaticSource(source);
    expect(analysis.parse_error_count).toBe(0);
    expect(analysis.references).toEqual(
      specifier === undefined
        ? []
        : [expect.objectContaining({ kind: "require", specifier })],
    );
  },
);

it.each([
  [
    "renamed loader",
    "const load=make(import.meta.url);load('./shared.cjs')",
    "./shared.cjs",
  ],
  [
    "captured renamed loader",
    "const load=make(import.meta.url);const saved=load;saved('./shared.cjs')",
    "./shared.cjs",
  ],
  [
    "object member loader",
    "const box={load:make(import.meta.url)};box.load('./shared.cjs')",
    "./shared.cjs",
  ],
  [
    "destructured loader",
    "const {load}={load:make(import.meta.url)};load('./shared.cjs')",
    "./shared.cjs",
  ],
  [
    "array member loader",
    "const box=[make(import.meta.url)];box[0]('./shared.cjs')",
    "./shared.cjs",
  ],
  [
    "generic loader invocation",
    "const load=make(import.meta.url);load.call(null,'./shared.cjs')",
    "./shared.cjs",
  ],
  [
    "reflected created loader",
    "const load=make(import.meta.url);Reflect.apply(load,null,['./shared.cjs'])",
    "./shared.cjs",
  ],
  [
    "unknown create base",
    "const load=make('/elsewhere/entry.cjs');load('./shared.cjs')",
    null,
  ],
  [
    "conditional create bases",
    "const load=flag?make(import.meta.url):make('/elsewhere/entry.cjs');load('./shared.cjs')",
    null,
  ],
  [
    "opaque loader replacement",
    "let load=make(import.meta.url);load=replacement;load('./shared.cjs')",
    null,
  ],
  [
    "copied child with a later leaf replacement",
    "const box={child:{load:make(import.meta.url)}};const copy={...box};box.child.load=make('/elsewhere/entry.cjs');copy.child.load('./shared.cjs')",
    null,
  ],
  [
    "copied child before a parent replacement",
    "const box={child:{load:make(import.meta.url)}};const copy={...box};box.child={load:make('/elsewhere/entry.cjs')};copy.child.load('./shared.cjs')",
    "./shared.cjs",
  ],
  [
    "spread excludes an inherited loader",
    "const box={__proto__:{load:make(import.meta.url)}};const copy={...box};copy.load('./shared.cjs')",
    undefined,
  ],
  [
    "local loader replacement",
    "let load=make(import.meta.url);load=()=>({});load('./shared.cjs')",
    undefined,
  ],
  ["local loader", "const load=()=>({});load('./shared.cjs')", undefined],
  [
    "shadowed create factory",
    "function f(make){const load=make(import.meta.url);load('./shared.cjs')}",
    undefined,
  ],
] as const)(
  "classifies %s from the selected loader value",
  (_name, body, specifier) => {
    const result = analyzeJavaScriptStaticSource(`${imported}${body};`);
    expect(result.parse_error_count).toBe(0);
    const calls = result.references.filter(({ kind }) => kind === "require");
    expect(calls).toEqual(
      specifier === undefined ? [] : [expect.objectContaining({ specifier })],
    );
  },
);

it("preserves a renamed native createRequire callable", () => {
  const load = createRequire(import.meta.url);
  const saved = load;
  expect(saved("node:path").join).toBe(path.join);
});

it.each(["leaf", "parent"])(
  "keeps the native created loader identity after a copied child %s write",
  (write) => {
    const selected = runInNewContext(
      `const original=make(base);const outside=make(outsideBase);
       const box={child:{load:original}};const copy={...box};
       ${write === "leaf" ? "box.child.load=outside" : "box.child={load:outside}"};
       ({actual:copy.child.load,expected:${write === "leaf" ? "outside" : "original"}});`,
      {
        make: createRequire,
        base: import.meta.url,
        outsideBase: new URL("./elsewhere/entry.cjs", import.meta.url).href,
      },
    );
    expect(selected.actual).toBe(selected.expected);
  },
);

it.each([
  [
    "direct Reflect.apply",
    "Reflect.apply(module.require,module,['node:path'])",
    true,
  ],
  [
    "captured Reflect.apply",
    "const invoke=Reflect.apply;invoke(module.require,module,['node:path'])",
    true,
  ],
  [
    "generic Reflect.apply",
    "Reflect.apply.call(null,module.require,module,['node:path'])",
    true,
  ],
  [
    "Reflect.apply captured before replacement",
    "const invoke=Reflect.apply;Reflect.apply=()=>({join:false});invoke(module.require,module,['node:path'])",
    true,
  ],
  [
    "local Reflect",
    "const Reflect={apply(){return {join:false}}};Reflect.apply(module.require,module,['node:path'])",
    false,
  ],
  [
    "local callable",
    "Reflect.apply(()=>({join:false}),module,['node:path'])",
    false,
  ],
  [
    "local module",
    "const module={require(){return {join:false}}};Reflect.apply(module.require,module,['node:path'])",
    false,
  ],
] as const)(
  "preserves module delegate provenance through %s",
  (_name, source, host) => {
    const result = runInNewContext(source, {
      module: new Module("reflected-loader.cjs"),
    });
    expect(result.join === path.join).toBe(host);
    const analysis = analyzeJavaScriptStaticSource(source);
    expect(analysis.parse_error_count).toBe(0);
    expect(analysis.references).toEqual(
      host
        ? [expect.objectContaining({ kind: "require", specifier: null })]
        : [],
    );
  },
);
