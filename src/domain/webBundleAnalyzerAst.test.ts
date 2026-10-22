import * as t from "@babel/types";
import { expect, it } from "vitest";

import { parseJavaScriptSource } from "./javascript/javascriptSourceParser.js";
import { objectString } from "./webBundleAnalyzerAst.js";

it("reads WebMCP declaration strings through the exact-literal owner", () => {
  const file = parseJavaScriptSource(
    "const declaration = { name: `catalog`, description: `Browse catalog` }; const dynamic = { name: `catalog ${scope}` };",
  );
  const declaration = file?.program.body[0];
  if (!t.isVariableDeclaration(declaration))
    throw new Error("Expected declaration fixture");
  const object = declaration.declarations[0]?.init;
  if (!t.isObjectExpression(object))
    throw new Error("Expected object expression fixture");
  const dynamicDeclaration = file?.program.body[1];
  if (!t.isVariableDeclaration(dynamicDeclaration))
    throw new Error("Expected dynamic declaration fixture");
  const dynamic = dynamicDeclaration.declarations[0]?.init;
  if (!t.isObjectExpression(dynamic))
    throw new Error("Expected dynamic object expression fixture");

  expect(objectString(object, "name")).toBe("catalog");
  expect(objectString(object, "description")).toBe("Browse catalog");
  expect(objectString(dynamic, "name")).toBeUndefined();
});
