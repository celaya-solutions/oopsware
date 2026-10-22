import {
  semanticOpaqueBindingReadMayHaveChanged,
  semanticOpaqueNameMayHaveChanged,
} from "./javascriptSemanticOpaqueEffects.js";
import * as t from "@babel/types";

import {
  isNullishJavaScriptSyntax,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  isErasedJavaScriptDeclaration,
  isUnmodeledJavaScriptRuntimeScope,
} from "./javascriptModuleDeclaration.js";
import { semanticBindingAtRead } from "./javascriptSemanticMutationInitializers.js";
import { SEMANTIC_EXPRESSION_DEPTH_LIMIT } from "./javascriptSemanticResourceLimits.js";
import {
  isUnshadowedGlobal,
  resolveSemanticBindingState,
  semanticStableInitializer,
  type JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";
import { traverseJavaScriptAst } from "./javascriptSemanticTraversal.js";
import { javaScriptRuntimeContext } from "./javascriptSourceParser.js";

type Shape = "array" | "callback" | "unknown";
const commonJsWrapperParameterNames = new Set([
  "exports",
  "require",
  "module",
  "__filename",
  "__dirname",
]);

/** Bounded child-argument identity only; never recover named object contents. */
export const createSemanticExpressionShapeResolver = (
  state: JavaScriptSemanticAnalysisState,
) => {
  const hoistedFunction = (node: t.Node): boolean => {
    const parent = state.parentsByNode.get(node);
    return (
      t.isFunctionDeclaration(node) &&
      (t.isProgram(parent) ||
        (t.isBlockStatement(parent) &&
          t.isFunction(state.parentsByNode.get(parent))))
    );
  };
  // Most modules have no named child arguments. Collect source-wide blockers
  // only when a query actually needs a named binding or ambient undefined.
  let blocked: boolean | undefined;
  const blockFunctionNames = new Set<string>();
  const namedProofBlocked = (): boolean => {
    if (blocked !== undefined) return blocked;
    blocked = false;
    traverseJavaScriptAst(state.program, {
      enter(node) {
        blocked ||=
          isErasedJavaScriptDeclaration(node) ||
          isUnmodeledJavaScriptRuntimeScope(node);
        if (
          javaScriptRuntimeContext(state.program) !== "module" &&
          t.isFunctionDeclaration(node) &&
          node.id != null &&
          !hoistedFunction(node)
        )
          blockFunctionNames.add(node.id.name);
      },
    });
    return blocked;
  };
  const shape = (input: t.Node): Shape => {
    const seen = new Set<t.Node>();
    let node = input;
    let depth = 0;
    while (true) {
      const unwrapped = unwrapJavaScriptExpression(node);
      node = unwrapped.node;
      depth += unwrapped.depth;
      if (depth > SEMANTIC_EXPRESSION_DEPTH_LIMIT) {
        state.valueResourceLimits.add("expression-depth");
        return "unknown";
      }
      if (seen.has(node)) return "unknown";
      seen.add(node);
      if (t.isArrayExpression(node)) return "array";
      if (t.isFunction(node) && !("declare" in node && node.declare))
        return "callback";
      if (!t.isIdentifier(node)) return "unknown";
      const binding = resolveSemanticBindingState(state, node, node.name);
      if (binding === undefined || binding.referenceInitializers.length > 0)
        return "unknown";
      if (state.scopesById.get(binding.scopeId)?.kind === "program") {
        const context = javaScriptRuntimeContext(state.program);
        // Unknown scripts expose globals; wrapper parameters can alias arguments.
        // Neither environment has a proven stable local initializer here.
        if (
          context === "unknown" ||
          (context === "commonjs" &&
            commonJsWrapperParameterNames.has(binding.name))
        )
          return "unknown";
      }
      // Annex B may copy a block function into an outer var without an indexed
      // assignment. Keep same-named vars unknown rather than model that copy.
      if (
        namedProofBlocked() ||
        semanticOpaqueBindingReadMayHaveChanged(binding, node, state) ||
        (binding.declarationKinds.has("var") &&
          blockFunctionNames.has(binding.name))
      )
        return "unknown";
      const initializer = semanticStableInitializer(binding, state);
      if (initializer === undefined || initializer.projection.length > 0)
        return "unknown";
      const read = semanticBindingAtRead(binding, node, state.parentsByNode);
      // Hoisted function declarations are the only accepted unordered source.
      if (
        !hoistedFunction(initializer.node) &&
        (read.status !== "ordered" || !read.hasDefiniteInitializer)
      )
        return "unknown";
      node = initializer.node;
      depth++;
    }
  };
  return {
    isArray: (node: t.Node) => shape(node) === "array",
    isCallback: (node: t.Node) => shape(node) === "callback",
    isNullish: (input: t.Node) => {
      const { node } = unwrapJavaScriptExpression(input);
      return (
        isNullishJavaScriptSyntax(node) ||
        (isUnshadowedGlobal(node, state, "undefined") &&
          !namedProofBlocked() &&
          !semanticOpaqueNameMayHaveChanged(node, state))
      );
    },
  };
};
