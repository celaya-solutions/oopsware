import * as t from "@babel/types";
import { expect, it } from "vitest";

import {
  analyzeParsedJavaScriptSemantics,
  indexJavaScriptBindingsSteps,
} from "./javascriptSemanticAnalysis.js";
import { createSemanticExpressionShapeResolver } from "./javascriptSemanticExpressionShapes.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";
import {
  completeSemanticSteps,
  traverseJavaScriptAst,
} from "./javascriptSemanticTraversal.js";

it.each([
  ["function f(){read(cb);function cb(){}}", ["callback"]],
  ["function f(){const cb=()=>{};const alias=cb;read(alias)}", ["callback"]],
  ["function f(cb){cb=()=>{};arguments[0]={};read(cb)}", ["unknown"]],
  ["declare let erased:any;function f(){const a=[];read(a)}", ["unknown"]],
  ["namespace X{};function f(){const a=[];read(a)}", ["unknown"]],
  ["var a=[];(()=>{}).constructor('a={}')();read(a);", ["unknown"]],
  ["let a=[];(()=>{}).constructor('a={}')();read(a);", ["unknown"]],
  [
    "read(null); read(void effect()); read(undefined);",
    ["nullish", "nullish", "nullish"],
  ],
  ["function f(undefined){read(undefined)}", ["unknown"]],
  ["const a=null; read(a);", ["unknown"]],
  ["function f(a){a=null;arguments[0]={};read(a)}", ["unknown"]],
  ["var a=null;Function('a={}');read(a);", ["unknown"]],
  ["var a=null;frames.a={};read(a);", ["unknown"]],
  ["function f(){const a=[];a.push(1);read(a);}", ["array"]],
  ["function f(){const a=[];const saved=a;read(saved);}", ["array"]],
  ['const a=[];function f(){eval("var a={}");read(a)}', ["unknown"]],
  ['function f(){const a=[];eval("a={}");read(a)}', ["array"]],
  ["function f(){let a=[];eval('a={}');read(a)}", ["unknown"]],
  ["function f(){eval('var undefined={}');read(undefined)}", ["unknown"]],
  ["var a=[];Function('a={}');read(a);", ["unknown"]],
  ["var a=[];frames.a={};read(a);", ["unknown"]],
  ["let a; if(flag)a=[];read(a);", ["unknown"]],
] as const)(
  "bounds shape proofs without refining named nullish values: %s",
  (source, expected) => {
    const file = parseJavaScriptSource(source, "fixture.ts");
    if (file === null) throw new Error("Expected valid source");
    const state = completeSemanticSteps(
      indexJavaScriptBindingsSteps(file.program),
    );
    const resolver = createSemanticExpressionShapeResolver(state);
    const shapes: string[] = [];
    traverseJavaScriptAst(file.program, {
      enter(node) {
        if (
          !t.isCallExpression(node) ||
          !t.isIdentifier(node.callee, { name: "read" })
        )
          return;
        const arg = node.arguments[0];
        if (arg === undefined) throw new Error("Expected read argument");
        shapes.push(
          resolver.isArray(arg)
            ? "array"
            : resolver.isCallback(arg)
              ? "callback"
              : resolver.isNullish(arg)
                ? "nullish"
                : "unknown",
        );
      },
    });
    expect(shapes).toEqual(expected);
  },
);

it("bounds long callback aliases without invoking the shared callable resolver", () => {
  const source = `export function run(){const cb=()=>{};
    ${Array.from({ length: 4096 }, (_, i) => `const a${i}=${i === 0 ? "cb" : `a${i - 1}`};`).join("\n")}
    read(a4095);read(a10);read(cb);}`;
  const file = parseJavaScriptSource(source, "deep.mjs");
  if (file === null) throw new Error("Expected valid deep source");
  const state = completeSemanticSteps(
    indexJavaScriptBindingsSteps(file.program),
  );
  const resolver = createSemanticExpressionShapeResolver(state);
  const results: boolean[] = [];
  traverseJavaScriptAst(file.program, {
    enter(node) {
      if (
        t.isCallExpression(node) &&
        t.isIdentifier(node.callee, { name: "read" })
      )
        results.push(resolver.isCallback(node.arguments[0]!));
    },
  });
  expect(results).toEqual([false, true, true]);
  expect(state.valueResourceLimits).toContain("expression-depth");
});

it.each([
  ["fixture.cjs", "const argv=[];const done=()=>{};", ["inherit", "default"]],
  ["fixture.cts", "const argv=[];const done=()=>{};", ["inherit", "default"]],
  [
    "fixture.cjs",
    "var argv=[];{function argv(){}}const done=()=>{};",
    ["dynamic", "default"],
  ],
  [
    "fixture.mjs",
    "var argv=[];{function argv(){}}const done=()=>{};",
    ["inherit", "default"],
  ],
  ["fixture.js", "const argv=[];const done=()=>{};", ["dynamic", "dynamic"]],
  [
    "fixture.cjs",
    "let argv=[];argv=input;const done=()=>{};",
    ["dynamic", "default"],
  ],
  [
    "fixture.cts",
    "const argv=[];const done=()=>{};eval(input);",
    ["inherit", "default"],
  ],
  [
    "fixture.cts",
    "namespace N{};const argv=[];const done=()=>{};",
    ["dynamic", "dynamic"],
  ],
  [
    "fixture.cjs",
    "var module=[];const argv=module;const done=()=>{};const args=arguments;args[2]={};",
    ["dynamic", "default"],
  ],
  [
    "fixture.cts",
    "const argv=[];function exports(){};const args=arguments;args[0]={};const done=exports;",
    ["inherit", "dynamic"],
  ],
] as const)(
  "distinguishes wrapper-local child identities and uncertain bindings: %s (%s)",
  (path, declarations, expected) => {
    const file = parseJavaScriptSource(
      `
      const {spawn,exec}=require("node:child_process");
      ${declarations}
      spawn("argv",argv,{stdio:"inherit"}); exec("callback",done);
    `,
      path,
    );
    if (file === null) throw new Error("Expected parsed source");
    expect(
      analyzeParsedJavaScriptSemantics(file).childProcessSpawns.map(
        ({ stdioMode }) => stdioMode,
      ),
    ).toEqual(expected);
  },
);
