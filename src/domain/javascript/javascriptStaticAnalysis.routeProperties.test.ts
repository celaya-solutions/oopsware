import { expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

it("reads exact route-property templates and leaves interpolated values unknown", () => {
  const analysis = analyzeJavaScriptStaticSource(`
    const routes = [
      { path: \`settings\` },
      { route: \`users/\${userId}\` },
      { path: "/login" },
    ];
  `);

  expect(
    analysis.endpoints.map(({ value, mechanism, interpretation }) => ({
      value,
      mechanism,
      interpretation,
    })),
  ).toEqual([
    {
      value: "settings",
      mechanism: "property:path",
      interpretation: undefined,
    },
    {
      value: "/login",
      mechanism: "property:path",
      interpretation: undefined,
    },
  ]);
});
