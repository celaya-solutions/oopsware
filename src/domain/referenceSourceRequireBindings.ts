import * as t from "@babel/types";

import { semanticStaticPropertyKey } from "./javascript/javascriptAstValues.js";
import {
  indexJavaScriptBindingsWithReceiversSteps,
  type JavaScriptReceiverIndex,
} from "./javascript/javascriptSemanticAnalysis.js";
import { semanticRequireLoaderAt } from "./javascript/javascriptSemanticRequireOrigin.js";
import {
  completeSemanticSteps,
  traverseJavaScriptAst,
} from "./javascript/javascriptSemanticTraversal.js";
import {
  isExplicitModuleSourcePath,
  type ParsedJavaScriptSource,
} from "./javascript/javascriptSourceParser.js";

/** Recover source dependencies using the shared loader and mutation owners. */
export const unshadowedReferenceSourceRequireCalls = (
  file: Pick<ParsedJavaScriptSource, "program">,
  path: string,
): ReadonlySet<t.CallExpression> => {
  // Unmarked paths depend on package scope or compiler options. Preserve their
  // candidate CommonJS edges; explicit module paths have no wrapper loader.
  const wrapperMode = commonJsWrapperMode(path);
  const index = completeSemanticSteps(
    indexJavaScriptBindingsWithReceiversSteps(
      file.program,
      wrapperMode === "absent" ? undefined : "commonjs-wrapper",
    ),
  );
  const factoryBindings: ReadonlySet<string> = new Set();
  const candidates: {
    readonly call: t.CallExpression;
    readonly identifier: t.Identifier;
  }[] = [];
  traverseJavaScriptAst(file.program, {
    enter: (node) => {
      if (!t.isCallExpression(node)) return;
      const identifier = requireCalleeIdentifier(node.callee);
      if (identifier === undefined) return;
      let fact = semanticRequireLoaderAt(node, index.bindings, factoryBindings);
      if (fact === "create-require") {
        // Definitions identify a possible factory. Its mutable member reads
        // need the shared write index before they can prove an association.
        completeSemanticSteps(index.indexMemberMutationFactsSteps());
        fact = semanticRequireLoaderAt(node, index.bindings, factoryBindings);
      }
      if (
        fact === "create-require" ||
        (fact === "commonjs-loader" && wrapperMode !== "absent")
      )
        candidates.push({ call: node, identifier });
    },
  });
  if (candidates.some(({ call }) => !t.isIdentifier(call.callee)))
    completeSemanticSteps(index.indexMemberMutationFactsSteps());
  return new Set(
    candidates
      .filter(
        ({ call, identifier }) =>
          t.isIdentifier(call.callee) ||
          !hasPriorMemberMutation(index, call, identifier),
      )
      .map(({ call }) => call),
  );
};

type CommonJsWrapperMode = "present" | "absent" | "unknown";

const commonJsWrapperMode = (path: string): CommonJsWrapperMode =>
  path.endsWith(".cjs")
    ? "present"
    : path.endsWith(".mjs")
      ? "absent"
      : isExplicitModuleSourcePath(path)
        ? "absent"
        : "unknown";

const hasPriorMemberMutation = (
  index: JavaScriptReceiverIndex,
  site: t.CallExpression,
  identifier: t.Identifier,
): boolean => {
  const callee = site.callee;
  const property = t.isMemberExpression(callee)
    ? semanticStaticPropertyKey(callee.property, callee.computed)
    : undefined;
  if (property === undefined || property === null) return true;
  const facts = index.effectsForReferenceAt(site, identifier, [property]);
  return (
    !facts.memberEffectsIndexed ||
    facts.effects.some(
      ({ kind, timing }) =>
        (kind === "member-write" || kind === "escape") && timing !== "after",
    )
  );
};

const requireCalleeIdentifier = (
  callee: t.Node | null | undefined,
): t.Identifier | undefined => {
  if (t.isIdentifier(callee, { name: "require" })) return callee;
  if (
    !t.isMemberExpression(callee) ||
    !t.isIdentifier(callee.object, { name: "require" }) ||
    ((!t.isIdentifier(callee.property) || callee.computed) &&
      !t.isStringLiteral(callee.property))
  )
    return undefined;
  const propertyName = t.isIdentifier(callee.property)
    ? callee.property.name
    : t.isStringLiteral(callee.property)
      ? callee.property.value
      : undefined;
  return propertyName === "resolve" || propertyName === "main"
    ? callee.object
    : undefined;
};
