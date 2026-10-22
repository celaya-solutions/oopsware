import * as t from "@babel/types";

import { builtinDataEffectCallablePath } from "./javascriptSemanticDataEffectHelpers.js";
import type { JavaScriptBindingIndex } from "./javascriptSemanticState.js";
import { completeSemanticSteps } from "./javascriptSemanticTraversal.js";
import { evaluateSemanticExpressionProvenance } from "./javascriptSemanticValues.js";
import {
  isUnmodifiedGlobalReference,
  isUnmodifiedImportMetaUrl,
} from "./javascriptSemanticAmbientWrites.js";
import { unwrapJavaScriptExpression } from "./javascriptAstValues.js";
import type { JavaScriptStaticPathIntrinsicQuery } from "./javascriptStaticAnalysisHelpers.js";

/** Prove Node's path resolver before applying its argument-selection semantics. */
export const createStaticNodePathResolveQuery = (
  index: JavaScriptBindingIndex,
): JavaScriptStaticPathIntrinsicQuery => {
  const facts = new WeakMap<t.Node, boolean>();
  const nativeMethod = (
    callee: t.Node,
    method: string,
    modules: readonly string[],
  ): boolean => {
    const provenance = evaluateSemanticExpressionProvenance(
      callee,
      index.bindings,
    );
    if (
      provenance.status !== "module" ||
      provenance.origins[0].importedPath.at(-1) !== method ||
      !modules.includes(provenance.origins[0].specifier.replace(/^node:/u, ""))
    )
      return false;
    completeSemanticSteps(index.indexMemberMutationFactsSteps());
    const path = builtinDataEffectCallablePath(callee, index.bindings, modules);
    return (
      path !== null &&
      ((path.length === 1 && path[0] === method) ||
        (modules.includes("path") &&
          path.length === 2 &&
          path[0] === "posix" &&
          path[1] === method))
    );
  };
  const sourceFile = (node: t.Node | undefined): boolean => {
    if (node === undefined) return false;
    node = unwrapJavaScriptExpression(node).node;
    if (t.isIdentifier(node, { name: "__filename" }))
      return isUnmodifiedGlobalReference(node, index.bindings, "__filename");
    return (
      t.isCallExpression(node) &&
      node.arguments.length === 1 &&
      nativeMethod(node.callee, "fileURLToPath", ["url"]) &&
      isUnmodifiedImportMetaUrl(node.arguments[0], index.bindings)
    );
  };
  return (callee, fact) => {
    if (fact === "source-directory") {
      callee = unwrapJavaScriptExpression(callee).node;
      return t.isIdentifier(callee, { name: "__dirname" })
        ? isUnmodifiedGlobalReference(callee, index.bindings, "__dirname")
        : t.isCallExpression(callee) &&
            callee.arguments.length === 1 &&
            nativeMethod(callee.callee, "dirname", ["path", "path/posix"]) &&
            sourceFile(callee.arguments[0]);
    }
    const cached = facts.get(callee);
    if (cached !== undefined) return cached;
    const proven = nativeMethod(callee, "resolve", ["path", "path/posix"]);
    facts.set(callee, proven);
    return proven;
  };
};
