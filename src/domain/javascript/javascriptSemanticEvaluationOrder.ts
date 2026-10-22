import * as t from "@babel/types";

import {
  readExactJavaScriptLiteral,
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";

const preserveGrouping = { stopAtParentheses: true } as const;

export type JavaScriptSemanticIterationCardinality =
  | "empty"
  | "nonempty"
  | "unknown";

/** Whether a method's computed key executes in the enclosing environment. */
export const semanticComputedMethodKey = (
  parent: t.Node | undefined,
  child: t.Node,
): boolean =>
  (t.isObjectMethod(parent) || t.isClassMethod(parent)) &&
  parent.computed &&
  parent.key === child;

/** Exact source-only cardinality for literal loop heads. */
export const semanticIterationCardinality = (
  loop: t.ForInStatement | t.ForOfStatement,
  prototypeMayAffectEnumeration: boolean | undefined,
): JavaScriptSemanticIterationCardinality => {
  const iterable = unwrapJavaScriptExpression(loop.right).node;
  const literal = readExactJavaScriptLiteral(iterable);
  if (t.isForOfStatement(loop)) {
    if (prototypeMayAffectEnumeration !== false) return "unknown";
    if (t.isArrayExpression(iterable)) {
      if (iterable.elements.length === 0) return "empty";
      if (
        iterable.elements.some(
          (element) => element === null || !t.isSpreadElement(element),
        )
      )
        return "nonempty";
      return "unknown";
    }
    if (literal.found && typeof literal.value === "string")
      return literal.value.length === 0 ? "empty" : "nonempty";
    return "unknown";
  }
  if (t.isObjectExpression(iterable)) {
    let prototype: t.Node | undefined;
    for (const property of iterable.properties) {
      if (t.isSpreadElement(property)) return "unknown";
      const key = semanticStaticPropertyKey(property.key, property.computed);
      if (
        t.isObjectProperty(property) &&
        !property.computed &&
        !property.shorthand &&
        key === "__proto__"
      ) {
        prototype = unwrapJavaScriptExpression(property.value).node;
        continue;
      }
      if (key === null) return "unknown";
      return "nonempty";
    }
    if (t.isNullLiteral(prototype)) return "empty";
    if (prototype !== undefined && !readExactJavaScriptLiteral(prototype).found)
      return "unknown";
    return prototypeMayAffectEnumeration === false ? "empty" : "unknown";
  }
  if (literal.found && literal.value === null) return "empty";
  if (
    literal.found &&
    typeof literal.value === "string" &&
    literal.value.length > 0
  )
    return "nonempty";
  if (literal.found)
    return prototypeMayAffectEnumeration === false ? "empty" : "unknown";
  return "unknown";
};

/** Instance values run on construction; their computed keys run at definition. */
export const delayedInstanceFieldValue = (
  parent: t.Node | undefined,
  child: t.Node | undefined,
): boolean =>
  (t.isClassProperty(parent) ||
    t.isClassPrivateProperty(parent) ||
    t.isClassAccessorProperty(parent)) &&
  !parent.static &&
  parent.value === child;

/** Shared branch facts for binding writes and their possible execution positions. */
export const semanticBranchMayBeSkipped = (
  parent: t.Node,
  child: t.Node,
): boolean => {
  if (delayedInstanceFieldValue(parent, child)) return true;
  if (t.isIfStatement(parent))
    return child === parent.consequent || child === parent.alternate;
  if (t.isSwitchCase(parent)) return true;
  if (t.isTryStatement(parent))
    return child === parent.block || child === parent.handler;
  if (t.isForStatement(parent))
    return child === parent.body || child === parent.update;
  if (t.isWhileStatement(parent)) return child === parent.body;
  if (t.isDoWhileStatement(parent)) return child === parent.test;
  if (t.isForInStatement(parent) || t.isForOfStatement(parent))
    return child === parent.left || child === parent.body;
  if (t.isLogicalExpression(parent)) return child === parent.right;
  if (t.isAssignmentPattern(parent)) return child === parent.right;
  if (t.isAssignmentExpression(parent))
    return (
      ["&&=", "||=", "??="].includes(parent.operator) && child === parent.right
    );
  if (t.isConditionalExpression(parent))
    return child === parent.consequent || child === parent.alternate;
  if (t.isOptionalCallExpression(parent) || t.isCallExpression(parent))
    return (
      parent.arguments.includes(child as t.Expression) &&
      ((t.isOptionalCallExpression(parent) && parent.optional) ||
        optionalChainMayShortCircuit(parent.callee))
    );
  if (t.isOptionalMemberExpression(parent))
    return (
      parent.computed &&
      child === parent.property &&
      (parent.optional || optionalChainMayShortCircuit(parent.object))
    );
  return false;
};

const optionalChainMayShortCircuit = (expression: t.Node): boolean => {
  let current = expression;
  while (true) {
    // Parentheses terminate optional-chain short-circuiting. In particular,
    // `(foo?.bar)(arg)` evaluates arg before attempting the call.
    if (current.extra?.parenthesized === true) return false;
    const unwrapped = unwrapJavaScriptExpression(
      current,
      preserveGrouping,
    ).node;
    if (unwrapped !== current) {
      current = unwrapped;
      continue;
    }
    if (t.isOptionalMemberExpression(current)) {
      if (current.optional) return true;
      current = current.object;
    } else if (t.isMemberExpression(current)) current = current.object;
    else if (t.isOptionalCallExpression(current)) {
      if (current.optional) return true;
      current = current.callee;
    } else if (t.isCallExpression(current)) current = current.callee;
    else return false;
  }
};
