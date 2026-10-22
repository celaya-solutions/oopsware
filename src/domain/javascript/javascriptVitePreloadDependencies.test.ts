import { describe, expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

describe("Vite preload dependency recovery", () => {
  it("decodes helper table values and preserves sparse and dynamic slots", () => {
    const source = String.raw`
      const __vite__mapDeps = (indexes, map = __vite__mapDeps, dependencies =
        (map.f || (map.f = ["./caf\u00e9.js", , getDependency(), "./last.js"]))) =>
        indexes.map((index) => dependencies[index]);
      const dynamicIndex = chooseIndex();
      __vite__mapDeps([0, , 3, dynamicIndex]);
    `;
    const analysis = analyzeJavaScriptStaticSource(source);
    const references = analysis.references.filter(
      ({ kind }) => kind === "dynamic-import",
    );

    expect(references.map(({ specifier }) => specifier).sort()).toEqual([
      "./café.js",
      "./last.js",
      null,
    ]);
    expect(references.every(({ location }) => location.start.line === 6)).toBe(
      true,
    );
    expect(references.filter(({ specifier }) => specifier === null)).toEqual([
      expect.objectContaining({
        expression: expect.stringContaining(
          "__vite__mapDeps([0, , 3, dynamicIndex])",
        ),
      }),
    ]);
  });

  it("does not take dependency strings from comments or unrelated helpers", () => {
    const analysis = analyzeJavaScriptStaticSource(`
      // cache.f = ["./comment.js"]
      const unrelated = (cache) => cache.f || (cache.f = ["./unrelated.js"]);
      __vite__mapDeps([0]);
    `);

    expect(
      analysis.references.filter(({ kind }) => kind === "dynamic-import"),
    ).toEqual([]);
  });

  it("keeps cache escapes and explicit cache overrides unknown", () => {
    const helper = `
      const __vite__mapDeps = (indexes, map = __vite__mapDeps, dependencies =
        (map.f || (map.f = ["./original.js"]))) =>
        indexes.map((index) => dependencies[index]);
    `;
    const escaped = analyzeJavaScriptStaticSource(`
      ${helper}
      const dependencies = __vite__mapDeps.f;
      dependencies[0] = "./changed.js";
      __vite__mapDeps([0]);
    `);
    expect(
      escaped.references
        .filter(({ kind }) => kind === "dynamic-import")
        .map(({ specifier }) => specifier),
    ).toEqual([null]);

    const overridden = analyzeJavaScriptStaticSource(`
      ${helper}
      __vite__mapDeps([0], customMap);
    `);
    expect(
      overridden.references
        .filter(({ kind }) => kind === "dynamic-import")
        .map(({ specifier }) => specifier),
    ).toEqual([null]);

    const defaulted = analyzeJavaScriptStaticSource(`
      ${helper}
      __vite__mapDeps([0], undefined, void 0);
    `);
    expect(
      defaulted.references
        .filter(({ kind }) => kind === "dynamic-import")
        .map(({ specifier }) => specifier),
    ).toEqual(["./original.js"]);
  });
});
