import * as t from "@babel/types";
import { isIntrinsicMapLookup } from "./javascriptSemanticMapOperations.js";

import {
  semanticGlobalProcessOrigin,
  semanticGlobalProcessPathOrigin,
  semanticOriginalGlobalProcessAt,
  semanticMutableBuiltinOrigin,
  semanticRequireExportsIdentity,
  semanticRequireOrigin,
  hasSemanticCreateRequireFactoryOrigin,
} from "./javascriptSemanticRequireOrigin.js";

import {
  resolveSemanticBindingState,
  type JavaScriptBindingIndex,
  type JavaScriptSemanticBindingState,
  type JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";
import {
  clearSemanticValueCaches,
  evaluateSemanticBinding,
  evaluateSemanticExpression,
} from "./javascriptSemanticValues.js";
import { semanticContainer } from "./javascriptSemanticSlots.js";
import {
  semanticArrayPropertyReferences,
  semanticClassCandidates,
  semanticClassPropertyReferences,
  semanticObjectPropertyReferences,
  type JavaScriptSemanticObjectReference,
} from "./javascriptSemanticObjectReferences.js";
import {
  semanticIterationSources,
  type SemanticIterationSource,
} from "./javascriptSemanticIterationSources.js";
import { semanticCallableResultExpressions } from "./javascriptSemanticCallableResults.js";
import { createSemanticReturnedReferences } from "./javascriptSemanticReturnedReferences.js";
import { semanticMutationInitializers } from "./javascriptSemanticMutationInitializers.js";
import {
  semanticCopiedReferencePath,
  semanticKnownArrayIteration,
  semanticReferenceSourcesInactive,
  semanticSelectedReferenceSlot,
} from "./javascriptSemanticReferenceSources.js";
import {
  semanticArrayIndex,
  SemanticPropertyPathCoverage,
  semanticPropertyPathKeyMatches,
  type JavaScriptSemanticPropertyPath,
} from "./javascriptSemanticPropertyPaths.js";
import { compareUnicodeCodePoints } from "../unicodeCodePointOrder.js";
import { traverseJavaScriptAstSteps } from "./javascriptSemanticTraversal.js";
import {
  semanticStaticPropertyKey,
  semanticWriteSiteTarget,
  semanticWriteTargets,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";

type PropertyPath = JavaScriptSemanticPropertyPath;
type ValueEffect = "write" | "escape";

/** Only replacing or possibly selecting an iterator-bearing prototype slot changes iteration. */
const arrayPrototypeIterationMayChange = (path: PropertyPath): boolean => {
  // Array.prototype and Object.prototype are on native arrays' prototype
  // chain. Their default constructor.prototype pairs return to the same owner.
  let offset = 0;
  while (path[offset] === "constructor" && path[offset + 1] === "prototype")
    offset += 2;
  const key = path[offset];
  return (
    key === undefined ||
    key === null ||
    typeof key === "object" ||
    semanticArrayIndex(key) !== null ||
    key === "__proto__"
  );
};

/** Preserve uncertainty from property writes and references exposed to calls, yielding during traversal and fixpoint iteration. */

/** Setter keys of one object literal; a computed setter key may match any key. */
interface SetterKeys {
  readonly names: ReadonlySet<string>;
  readonly computed: boolean;
}

// Writes to one literal repeat; scan its properties once, including the
// common result that it defines no setter.
const setterKeysByObject = new WeakMap<t.ObjectExpression, SetterKeys | null>();

const setterKeys = (object: t.ObjectExpression): SetterKeys | null => {
  const cached = setterKeysByObject.get(object);
  if (cached !== undefined) return cached;
  const names = new Set<string>();
  let computed = false;
  // Follow definition order: a later data property or method with the same
  // static name replaces the accessor, so its setter no longer runs. Spreads
  // and unknown computed keys may or may not replace it and keep it.
  for (const property of object.properties) {
    if (t.isSpreadElement(property)) continue;
    const name = semanticStaticPropertyKey(property.key, property.computed);
    if (t.isObjectMethod(property) && property.kind === "set") {
      if (name === null) computed = true;
      else names.add(name);
    } else if (
      name !== null &&
      !(t.isObjectMethod(property) && property.kind === "get")
    )
      names.delete(name);
  }
  const keys = names.size === 0 && !computed ? null : { names, computed };
  setterKeysByObject.set(object, keys);
  return keys;
};

/**
 * The receiver path whose own object-literal setter an assignment to `path`
 * runs, following nested literal members from the binding's initializer.
 */
const localSetterReceiver = (
  initializers: readonly {
    readonly node: t.Node;
    readonly projection: readonly unknown[];
  }[],
  path: readonly unknown[],
): readonly string[] | undefined => {
  const key = path.at(-1);
  if (typeof key !== "string") return undefined;
  const receiver = path.slice(0, -1);
  if (!receiver.every((segment) => typeof segment === "string"))
    return undefined;
  for (const { node, projection } of initializers) {
    if (projection.length !== 0) continue;
    let object: t.Node | undefined = unwrapJavaScriptExpression(node).node;
    for (const segment of receiver) {
      if (!t.isObjectExpression(object)) break;
      const member: t.ObjectExpression["properties"][number] | undefined =
        object.properties.findLast(
          (property) =>
            t.isObjectProperty(property) &&
            semanticStaticPropertyKey(property.key, property.computed) ===
              segment,
        );
      object = t.isObjectProperty(member)
        ? unwrapJavaScriptExpression(member.value).node
        : undefined;
    }
    if (!t.isObjectExpression(object)) continue;
    const keys = setterKeys(object);
    if (keys !== null && (keys.computed || keys.names.has(key)))
      return receiver as readonly string[];
  }
  return undefined;
};

export function* collectSemanticMemberMutationsSteps(
  program: t.Program,
  state: JavaScriptSemanticAnalysisState,
  referenceMayHaveChangedAt: JavaScriptBindingIndex["referenceMayHaveChangedAt"],
): Generator<void, void> {
  const deferredMapReceivers = new Set<
    t.CallExpression | t.OptionalCallExpression
  >();
  const parents = state.parentsByNode;
  const observablePaths = observableMutationPaths(state);
  const returnedReferences = createSemanticReturnedReferences(state);
  const recordedRequiredEffects = new Set<string>();
  let recordedEffectCount = 0;
  const recordRequiredEffect = (
    specifier: string,
    path: PropertyPath,
    effect: ValueEffect,
    node: t.Node | undefined,
  ): void => {
    const identity = semanticRequireExportsIdentity(specifier, path);
    let effectPath = identity.path;
    // Only known value slots are primitive. Unknown or inherited selections
    // can expose the container prototype and affect any subsequently read slot.
    if (
      effect === "escape" &&
      identity.specifier === "process" &&
      effectPath.length === 2 &&
      (effectPath[0] === "env" || effectPath[0] === "argv")
    ) {
      const selected = effectPath[1];
      if (
        (typeof selected === "string" || typeof selected === "number") &&
        (effectPath[0] === "env"
          ? !Object.hasOwn(Object.prototype, selected)
          : selected === "length" || semanticArrayIndex(selected) !== null)
      )
        return;
      effectPath = [effectPath[0], null];
    }
    const key = JSON.stringify([
      "required",
      identity.specifier,
      effect,
      effectPath,
      node?.start,
      node?.end,
    ]);
    if (recordedRequiredEffects.has(key)) return;
    recordedRequiredEffects.add(key);
    recordedEffectCount += 1;
    const effects = state.requiredModuleEffects.get(identity.specifier) ?? [];
    effects.push({ path: effectPath, node, kind: effect });
    state.requiredModuleEffects.set(identity.specifier, effects);
  };
  // Ambient indexing owns aliases of global objects. Consume its canonical
  // writes instead of reparsing qualified or aliased process assignments.
  for (const { path, node } of state.ambientWriteEffects)
    if (
      path[0] === "global" &&
      path[1] === "process" &&
      path.length > 2 &&
      node !== undefined &&
      semanticOriginalGlobalProcessAt(node, state)
    )
      recordRequiredEffect("node:process", path.slice(2), "write", node);
  const selections = new Map<string, readonly string[]>();
  const coveringPaths = new Map<string, SemanticPropertyPathCoverage>();
  state.arrayIterationUnknown = false;
  // Definition collection finishes before this phase, so a scope's bindings no
  // longer change and one node resolves to one binding. Repeated visits of the
  // same node otherwise repeat the same scope walk.
  const resolvedBindings = new WeakMap<
    t.Node,
    JavaScriptSemanticBindingState | null
  >();
  const resolveBinding = (
    node: t.Node,
    name: string,
  ): JavaScriptSemanticBindingState | undefined => {
    const cached = resolvedBindings.get(node);
    if (cached !== undefined) return cached ?? undefined;
    const resolved = resolveSemanticBindingState(state, node, name);
    resolvedBindings.set(node, resolved ?? null);
    return resolved;
  };
  // One capture tuple recurs across every alias it reaches. Re-encoding it
  // would rebuild the same long key and force a fresh string hash per lookup.
  const captureKeys = new WeakMap<
    JavaScriptSemanticBindingState,
    Map<string, string>
  >();
  const captureKeyOf = (
    binding: JavaScriptSemanticBindingState,
    originAt: t.Node | undefined,
    ownerInitializer: t.Node | undefined,
  ): string => {
    let byPosition = captureKeys.get(binding);
    if (byPosition === undefined) {
      byPosition = new Map();
      captureKeys.set(binding, byPosition);
    }
    const positionKey = `${originAt?.start ?? "u"}:${originAt?.end ?? "u"}:${
      ownerInitializer?.start ?? "u"
    }:${ownerInitializer?.end ?? "u"}`;
    const cached = byPosition.get(positionKey);
    if (cached !== undefined) return cached;
    const created = JSON.stringify([
      binding.bindingId,
      originAt?.start,
      originAt?.end,
      ownerInitializer?.start,
      ownerInitializer?.end,
    ]);
    byPosition.set(positionKey, created);
    return created;
  };
  // A capture key already ends the array; a path stays one nested element.
  const lifetimeKey = (captureKey: string, path: PropertyPath): string =>
    `${captureKey.slice(0, -1)},${JSON.stringify(path)}]`;
  const pendingReferences: {
    readonly initializer: JavaScriptSemanticBindingState["referenceInitializers"][number];
    readonly path: PropertyPath;
    readonly bindings: ReadonlySet<string>;
    readonly effect: ValueEffect;
    readonly mutation?: t.Node;
    readonly originAt: t.Node | undefined;
    readonly widenedGetterResult?: true;
  }[] = [];
  const iterableReferences: IterableReference[] = [];
  const iterableReferenceKeys = new WeakMap<t.Node, Set<string>>();
  const deferIterable = (reference: IterableReference): void => {
    const keys = iterableReferenceKeys.get(reference.node) ?? new Set<string>();
    const key = JSON.stringify([
      reference.projection,
      reference.path,
      reference.fallbackPath,
      reference.effect,
      reference.mutation?.start,
      reference.mutation?.end,
      reference.originAt?.start,
      reference.originAt?.end,
      reference.iterationOnly,
      reference.widenedGetterResult === true,
      reference.requiredSources?.map((source) => [
        source.node.start,
        source.node.end,
        source.projection,
        source.iterationSources?.map((iterable) => [
          iterable.node.start,
          iterable.node.end,
          iterable.projection,
        ]),
      ]),
      reference.fallbackSources?.map((source) => [
        source.node.start,
        source.node.end,
        source.projection,
        source.iterationSources?.map((iterable) => [
          iterable.node.start,
          iterable.node.end,
          iterable.projection,
        ]),
      ]),
      [...reference.bindings].sort(compareUnicodeCodePoints),
    ]);
    if (keys.has(key)) return;
    keys.add(key);
    iterableReferenceKeys.set(reference.node, keys);
    iterableReferences.push(reference);
  };
  const markValue = (
    node: t.Node,
    path: PropertyPath,
    bindings: ReadonlySet<string>,
    effect: ValueEffect = "write",
    mutation?: t.Node,
    originAt: t.Node | undefined = mutation,
    ownerInitializer?: t.Node,
    widenedGetterResult = false,
    assignedSources?: readonly SemanticIterationSource[],
  ): void => {
    const pending: (ReferencedValue & {
      readonly bindings: ReadonlySet<string>;
      readonly originAt: t.Node | undefined;
    })[] = [
      {
        node,
        path,
        bindings,
        originAt,
        ...(ownerInitializer === undefined ? {} : { ownerInitializer }),
      },
    ];
    // Visit shallower alias traversals first so their exact prefixes suppress
    // longer loop paths before those paths enumerate every assignment order.
    for (let cursor = 0; cursor < pending.length; cursor++) {
      const current = pending[cursor];
      if (current === undefined) break;
      const expression = unwrapJavaScriptExpression(current.node).node;
      const required = semanticRequireOrigin(expression, state);
      if (required !== undefined) {
        recordRequiredEffect(
          required.origin.specifier,
          [...required.origin.importedPath, ...current.path],
          effect,
          mutation,
        );
        continue;
      }
      const globalProcess = semanticGlobalProcessPathOrigin(expression, state);
      if (globalProcess !== undefined) {
        recordRequiredEffect(
          globalProcess.specifier,
          [...globalProcess.importedPath, ...current.path],
          effect,
          mutation,
        );
        continue;
      }
      if (t.isIdentifier(expression)) {
        const binding = resolveBinding(expression, expression.name);
        if (binding === undefined) {
          const processOrigin = semanticGlobalProcessOrigin(expression, state);
          if (processOrigin !== undefined)
            recordRequiredEffect(
              processOrigin.specifier,
              current.path,
              effect,
              mutation,
            );
          if (
            (["Array", "Object"].includes(expression.name) &&
              (current.path[0] === "prototype" || current.path[0] === null) &&
              arrayPrototypeIterationMayChange(current.path.slice(1))) ||
            (["globalThis", "global", "window", "self"].includes(
              expression.name,
            ) &&
              (["Array", "Object"].includes(String(current.path[0])) ||
                current.path[0] === null) &&
              (current.path[1] === "prototype" || current.path[1] === null) &&
              arrayPrototypeIterationMayChange(current.path.slice(2)))
          )
            state.arrayIterationUnknown = true;
          continue;
        }
        // An alias restored from a saved reference can revisit the same binding
        // at an earlier capture or a shorter getter-receiver path. Only a
        // repeated capture and path closes a cycle.
        const captureKey = captureKeyOf(
          binding,
          current.originAt,
          current.ownerInitializer,
        );
        const lifetime = lifetimeKey(captureKey, current.path);
        if (current.bindings.has(lifetime)) continue;
        // A self alias such as `node = node[key]` revisits its capture with the
        // same prefix added on every cycle, so exact paths never repeat. When
        // that prefix can never be pruned, escaping it once covers every longer
        // effect, including writes below shared children.
        // Only a capture already on this alias chain can repeat a prefix.
        const revisited = current.bindings.has(captureKey);
        let repeatedPrefix: PropertyPath | undefined;
        for (
          let start = 1;
          revisited && start <= current.path.length;
          start++
        ) {
          const suffix = current.path.slice(start);
          if (!current.bindings.has(lifetimeKey(captureKey, suffix))) continue;
          repeatedPrefix = current.path.slice(0, start);
          break;
        }
        if (
          repeatedPrefix !== undefined &&
          observablePaths.repeatsUnpruned(binding.bindingId, repeatedPrefix)
        ) {
          markValue(
            current.node,
            repeatedPrefix,
            new Set(),
            "escape",
            mutation,
            current.originAt,
            current.ownerInitializer,
            widenedGetterResult,
          );
          continue;
        }
        // Union compatible copied-slot selections at each binding. Carrying every
        // combination of exclusions through branch diamonds is exponential.
        // Preserve paths that can change observed slots or Array prototype
        // effects; canonicalize suffixes that cannot distinguish lattice facts.
        let path = observablePaths.normalize(
          binding.bindingId,
          current.path,
          effect,
        );
        if (path === null) continue;
        const selectorIndex = path.findIndex(
          (key) => key !== null && typeof key === "object",
        );
        const selector = path[selectorIndex];
        if (selector !== null && typeof selector === "object") {
          const selectionIdentity = JSON.stringify([
            binding.bindingId,
            effect,
            path.map((key, index) =>
              index === selectorIndex
                ? { startIndex: selector.startIndex }
                : key,
            ),
            mutation?.start,
            mutation?.end,
            current.originAt?.start,
            current.originAt?.end,
            current.ownerInitializer?.start,
            current.ownerInitializer?.end,
          ]);
          const previous = selections.get(selectionIdentity);
          const excludedKeys =
            previous === undefined
              ? selector.excludedKeys
              : previous.filter((key) => selector.excludedKeys.includes(key));
          if (previous !== undefined && excludedKeys.length === previous.length)
            continue;
          selections.set(selectionIdentity, excludedKeys);
          path = path.map((key, index) =>
            index === selectorIndex ? { ...selector, excludedKeys } : key,
          );
        }
        const origins =
          current.ownerInitializer !== undefined
            ? {
                initializers: binding.initializers.filter(
                  ({ node }) => node === current.ownerInitializer,
                ),
                referenceInitializers: [],
                directOrigins: [],
              }
            : current.originAt === undefined
              ? binding
              : semanticMutationInitializers(
                  binding,
                  current.originAt,
                  parents,
                );
        // A setter on the binding's own literal runs on assignment and may
        // replace any member of its receiver, so the written key is unknown.
        // Deleting the accessor never calls it.
        if (
          effect === "write" &&
          !t.isUnaryExpression(mutation, { operator: "delete" })
        ) {
          const receiver = localSetterReceiver(origins.initializers, path);
          if (receiver !== undefined) path = [...receiver, null];
        }
        // Keep an antichain of exact paths. Widening distinct member keys would
        // also invalidate unrelated siblings that never reach this effect.
        // This map is local to the file scan. Escaping the binding id keeps a
        // field separator injective while avoiding a fresh JSON array encode.
        const pathState = `${JSON.stringify(binding.bindingId)}\u0001${
          effect
        }\u0001${
          // Short writes stop at owned literal slots, whereas longer writes
          // reach shared children. Only equal-depth writes cover one another.
          effect === "write" ? path.length : -1
        }\u0001${mutation?.start ?? -1}\u0001${mutation?.end ?? -1}\u0001${
          current.originAt?.start ?? -1
        }\u0001${current.originAt?.end ?? -1}\u0001${
          current.ownerInitializer?.start ?? -1
        }\u0001${current.ownerInitializer?.end ?? -1}\u0001${widenedGetterResult}\u0001${assignedSources?.[0]?.target?.start ?? -1}`;
        let covering = coveringPaths.get(pathState);
        if (covering === undefined) {
          covering = new SemanticPropertyPathCoverage();
          coveringPaths.set(pathState, covering);
        }
        if (!covering.retain(path)) continue;
        // A recorded write invalidates the binding to a non-primitive value, so
        // only its first write can target a primitive. Re-evaluating it would
        // replay every earlier write and make repeated writes superlinear.
        const value =
          effect === "write" && binding.memberWrites.length === 0
            ? evaluateSemanticBinding(binding, state)
            : undefined;
        const primitiveWrite =
          value?.status === "literal" || value?.status === "union";
        // The coverage index already owns binding-effect deduplication.
        recordedEffectCount += 1;
        const nested = new Set(current.bindings);
        nested.add(lifetime);
        nested.add(captureKey);
        // Returning a literal's receiver reaches that allocation, not the
        // binding's older values read while evaluating its initializer.
        if (!primitiveWrite) {
          for (const origin of origins.directOrigins) {
            const shared = semanticMutableBuiltinOrigin(origin, path);
            if (shared !== undefined)
              recordRequiredEffect(
                shared.specifier,
                shared.path,
                effect,
                mutation,
              );
          }
          const receiverInitializers = [
            ...origins.initializers,
            ...origins.referenceInitializers,
          ];
          if (effect === "escape")
            binding.escapedPaths.push({
              path,
              node: mutation,
              receiverInitializers,
              ...(current.originAt === undefined
                ? {}
                : { receiverAt: current.originAt }),
            });
          else
            binding.memberWrites.push({
              path,
              node: mutation,
              receiverInitializers,
              ...(current.originAt === undefined
                ? {}
                : { receiverAt: current.originAt }),
              ...(assignedSources === undefined ? {} : { assignedSources }),
            });
          clearSemanticValueCaches(state);
          for (const initializer of origins.initializers)
            pending.push({
              node: initializer.node,
              path: [...initializer.projection, ...path],
              bindings: nested,
              originAt: initializer.node,
            });
        }
        for (const initializer of origins.referenceInitializers) {
          const copiedPath = semanticCopiedReferencePath(
            initializer,
            path,
            effect,
          );
          if (copiedPath === null) continue;
          pendingReferences.push({
            initializer,
            path: copiedPath,
            bindings: nested,
            effect,
            ...(widenedGetterResult ? { widenedGetterResult: true } : {}),
            originAt: initializer.node,
            ...(mutation === undefined ? {} : { mutation }),
          });
        }
      } else if (
        t.isMemberExpression(expression) ||
        t.isOptionalMemberExpression(expression)
      ) {
        pending.push({
          node: expression.object,
          path: [
            semanticStaticPropertyKey(expression.property, expression.computed),
            ...current.path,
          ],
          bindings: current.bindings,
          originAt: current.originAt,
        });
      } else {
        for (const value of effect === "escape"
          ? escapedReferenceLeaves(
              expression,
              current.path,
              widenedGetterResult,
            )
          : expandedValues(expression, current.path, effect)) {
          if (
            value.escapes &&
            (effect !== "escape" ||
              (value.widenedGetterResult && !widenedGetterResult))
          )
            markValue(
              value.node,
              value.path,
              new Set(),
              "escape",
              mutation,
              current.originAt,
              value.ownerInitializer,
              widenedGetterResult || value.widenedGetterResult === true,
            );
          else if (value.iterableFallbackPath !== undefined)
            deferIterable({
              node: value.node,
              projection: [],
              path: value.path,
              fallbackPath: value.iterableFallbackPath,
              bindings: current.bindings,
              effect,
              originAt: current.originAt,
              ...(widenedGetterResult ? { widenedGetterResult: true } : {}),
              ...(mutation === undefined ? {} : { mutation }),
            });
          else
            pending.push({
              ...value,
              bindings: current.bindings,
              originAt: current.originAt,
            });
        }
      }
    }
  };
  const markEscaped = (
    node: t.Node,
    mutation: t.Node,
    path: PropertyPath = [],
  ): void => markValue(node, path, new Set(), "escape", mutation);
  function expandedValues(
    expression: t.Node,
    path: PropertyPath,
    effect: ValueEffect,
    widenedGetterResult = false,
  ): readonly ReferencedValue[] {
    if (
      t.isArrayExpression(expression) &&
      ((path[0] === "__proto__" &&
        (effect === "escape" || path.length > 1) &&
        arrayPrototypeIterationMayChange(path.slice(1))) ||
        (path[0] === "constructor" &&
          path[1] === "prototype" &&
          arrayPrototypeIterationMayChange(path.slice(2))))
    )
      state.arrayIterationUnknown = true;
    const references = referencedValues(
      expression,
      path,
      effect,
      state,
      widenedGetterResult,
    );
    return widenedGetterResult
      ? references.map((reference) => ({
          ...reference,
          escapes: true,
          widenedGetterResult: true,
        }))
      : references;
  }
  // Expanding a value below its references depends only on syntax, not on the
  // escape site. Escaping an object reaches every method's results, so
  // re-expanding it at each call through that object made N calls over N
  // methods quadratic. Identifiers that resolve to the same binding and path
  // are processed identically, so one stands for all of them.
  const escapedLeaves = new WeakMap<
    t.Node,
    Map<string, readonly ReferencedValue[]>
  >();
  function escapedReferenceLeaves(
    root: t.Node,
    rootPath: PropertyPath,
    widenedGetterResult: boolean,
  ): readonly ReferencedValue[] {
    // Parser recovery can leave an argument hole, which expands to nothing.
    if (!t.isNode(root)) return [];
    const rootKey = JSON.stringify([rootPath, widenedGetterResult]);
    const cached = escapedLeaves.get(root)?.get(rootKey);
    if (cached !== undefined) return cached;
    const leaves = collectEscapedLeaves([
      ...expandedValues(root, rootPath, "escape", widenedGetterResult),
    ]);
    const byPath = escapedLeaves.get(root) ?? new Map();
    byPath.set(rootKey, leaves);
    escapedLeaves.set(root, byPath);
    return leaves;
  }
  function retainEscapedLeaf(
    value: ReferencedValue,
    node: t.Node,
    leaves: ReferencedValue[],
    identities: Set<string>,
  ): boolean {
    if (
      value.iterableFallbackPath !== undefined ||
      t.isMemberExpression(node) ||
      t.isOptionalMemberExpression(node)
    ) {
      leaves.push(value);
      return true;
    }
    if (!t.isIdentifier(node)) return false;
    const binding = resolveBinding(node, node.name);
    const identity = JSON.stringify([
      binding === undefined ? null : binding.bindingId,
      binding === undefined ? node.name : null,
      value.path,
      value.widenedGetterResult === true,
      value.ownerInitializer?.start,
      value.ownerInitializer?.end,
    ]);
    if (!identities.has(identity)) {
      identities.add(identity);
      leaves.push(value);
    }
    return true;
  }
  function collectEscapedLeaves(
    pending: ReferencedValue[],
  ): readonly ReferencedValue[] {
    const leaves: ReferencedValue[] = [];
    const identities = new Set<string>();
    const expanded = new WeakMap<t.Node, Set<string>>();
    for (let cursor = 0; cursor < pending.length; cursor++) {
      const value = pending[cursor];
      if (value === undefined) break;
      const node = unwrapJavaScriptExpression(value.node).node;
      if (!t.isNode(node) || retainEscapedLeaf(value, node, leaves, identities))
        continue;
      const key = JSON.stringify([
        value.path,
        value.widenedGetterResult === true,
      ]);
      const paths = expanded.get(node) ?? new Set<string>();
      if (paths.has(key)) continue;
      paths.add(key);
      expanded.set(node, paths);
      for (const reference of expandedValues(
        node,
        value.path,
        "escape",
        value.widenedGetterResult === true,
      ))
        pending.push(reference);
    }
    return leaves;
  }
  const markReceiver = (callee: t.Node, mutation: t.Node): void => {
    const expression = unwrapJavaScriptExpression(callee).node;
    if (
      t.isMemberExpression(expression) ||
      t.isOptionalMemberExpression(expression)
    )
      markEscaped(expression.object, mutation);
  };
  const markTarget = (node: t.Node, mutation: t.Node): void => {
    const sources = semanticIterationSources(
      mutation,
      state.parentsByNode.get(mutation) ?? null,
    );
    const sourcesByTarget = new Map<
      t.MemberExpression | t.OptionalMemberExpression,
      SemanticIterationSource[]
    >();
    for (const source of sources) {
      if (source.kind !== "reference-store" || source.target === undefined)
        continue;
      const selected = sourcesByTarget.get(source.target) ?? [];
      selected.push(source);
      sourcesByTarget.set(source.target, selected);
    }
    for (const target of semanticWriteTargets(node))
      if (!t.isIdentifier(target))
        markValue(
          target.object,
          [semanticStaticPropertyKey(target.property, target.computed)],
          new Set(),
          "write",
          mutation,
          mutation,
          undefined,
          false,
          sourcesByTarget.get(target) ?? [],
        );
  };
  yield* traverseJavaScriptAstSteps(program, {
    enter: (node, parent) => {
      for (const source of semanticIterationSources(node, parent))
        deferIterable({
          ...source,
          path: source.projection,
          fallbackPath: source.projection,
          bindings: new Set(),
          effect: "escape",
          originAt: source.mutation,
          iterationOnly: source.kind === "iteration",
        });
      const writeTarget = semanticWriteSiteTarget(node);
      if (writeTarget !== null) markTarget(writeTarget, node);
      else if (
        t.isCallExpression(node) ||
        t.isOptionalCallExpression(node) ||
        t.isNewExpression(node)
      ) {
        for (const source of returnedReferences(node.callee).references)
          markEscaped(source.node, node, source.projection);
        for (const argument of node.arguments)
          if (t.isSpreadElement(argument))
            deferIterable({
              node: argument.argument,
              projection: [],
              path: [null],
              fallbackPath: [],
              bindings: new Set(),
              effect: "escape",
              mutation: node,
              originAt: node,
            });
          else markEscaped(argument, node);
        // Constructing a member does not pass its container as `this`.
        if (!t.isNewExpression(node)) {
          const mapLookup = isIntrinsicMapLookup(node, state);
          if (mapLookup === undefined) deferredMapReceivers.add(node);
          else if (!mapLookup) markReceiver(node.callee, node);
        }
      } else if (t.isTaggedTemplateExpression(node)) {
        markReceiver(node.tag, node);
        for (const expression of node.quasi.expressions)
          markEscaped(expression, node);
      }
    },
  });
  // A later effect can make a previously defined destructuring source uncertain.
  // Reconsider defaults and iterable origins until their effects are stable.
  while (
    pendingReferences.length > 0 ||
    iterableReferences.length > 0 ||
    deferredMapReceivers.size > 0
  ) {
    const effectsBefore = recordedEffectCount;
    const iterablesBefore = iterableReferences.length;
    const iterationBefore: boolean = state.arrayIterationUnknown;
    for (const [index, reference] of pendingReferences.splice(0).entries()) {
      if (index % 64 === 0) yield;
      const { initializer } = reference;
      if (semanticReferenceSourcesInactive(initializer, state))
        pendingReferences.push(reference);
      else if (t.isForOfStatement(initializer.node))
        deferIterable({
          node: initializer.node.right,
          projection: [],
          path: [null, ...reference.path],
          fallbackPath: [],
          bindings: reference.bindings,
          effect: reference.effect,
          ...(reference.widenedGetterResult
            ? { widenedGetterResult: true }
            : {}),
          originAt: initializer.node,
          ...(reference.mutation === undefined
            ? {}
            : { mutation: reference.mutation }),
        });
      else if (
        initializer.copyKind === "array-rest" &&
        initializer.copyProjectionOffset !== undefined
      ) {
        const offset = initializer.copyProjectionOffset;
        const projection = initializer.projection.slice(0, offset);
        deferIterable({
          node: initializer.node,
          projection,
          path: reference.path,
          fallbackPath: projection,
          bindings: reference.bindings,
          effect: reference.effect,
          ...(reference.widenedGetterResult
            ? { widenedGetterResult: true }
            : {}),
          originAt: reference.originAt,
          ...(reference.mutation === undefined
            ? {}
            : { mutation: reference.mutation }),
        });
      } else
        markValue(
          initializer.node,
          reference.path,
          reference.bindings,
          reference.effect,
          reference.mutation,
          reference.originAt,
          undefined,
          reference.widenedGetterResult === true,
        );
    }
    for (const [index, reference] of [...iterableReferences].entries()) {
      if (index % 64 === 0) yield;
      if (semanticReferenceSourcesInactive(reference, state)) continue;
      if (reference.iterationOnly) {
        const expanded = expandedIterationReferences(reference, state);
        if (expanded !== null) {
          for (const selected of expanded) deferIterable(selected);
          continue;
        }
      }
      const slot = semanticSelectedReferenceSlot(reference, state);
      // Custom iteration can yield the iterable itself as well as any child.
      // Treat its root as escaped, including writes through yielded references.
      const knownArray = semanticKnownArrayIteration(slot?.value, state);
      if (knownArray && reference.iterationOnly) continue;
      markValue(
        reference.node,
        knownArray ? reference.path : reference.fallbackPath,
        reference.bindings,
        knownArray ? reference.effect : "escape",
        reference.mutation,
        reference.originAt,
        undefined,
        reference.widenedGetterResult === true,
      );
    }
    // Native Map lookup methods do not expose their receiver to user code.
    // Settle genuine effects first, then replay every unproven receiver escape.
    // Keep proven sites until convergence: later propagated effects can revoke them.
    let receiverIndex = 0;
    for (const node of deferredMapReceivers) {
      if (receiverIndex++ % 64 === 0) yield;
      if (
        isIntrinsicMapLookup(node, state, { referenceMayHaveChangedAt }) ===
        true
      )
        continue;
      deferredMapReceivers.delete(node);
      markReceiver(node.callee, node);
    }
    if (
      recordedEffectCount === effectsBefore &&
      iterableReferences.length === iterablesBefore &&
      state.arrayIterationUnknown === iterationBefore
    )
      break;
  }
  // Gathering effects can evaluate a primitive projection before its object
  // escapes. Final values must use the completed mutation state.
  clearSemanticValueCaches(state);
}

interface ReferencedValue extends JavaScriptSemanticObjectReference {
  readonly iterableFallbackPath?: PropertyPath;
}

interface IterableReference extends ReferencedValue {
  readonly projection: PropertyPath;
  readonly fallbackPath: PropertyPath;
  readonly bindings: ReadonlySet<string>;
  readonly effect: ValueEffect;
  readonly mutation?: t.Node;
  readonly originAt: t.Node | undefined;
  readonly iterationOnly?: boolean;
  readonly requiredSources?: NonNullable<
    SemanticIterationSource["requiredSources"]
  >;
  readonly fallbackSources?: NonNullable<
    SemanticIterationSource["fallbackSources"]
  >;
}

const expandedIterationReferences = (
  reference: IterableReference,
  state: JavaScriptSemanticAnalysisState,
): readonly IterableReference[] | null => {
  if (!t.isForOfStatement(reference.mutation)) return null;
  const iterable = reference.mutation.right;
  // Expand only the loop's yielded-item selector. Enumerating dynamic property
  // selections would multiply paths through shared object aliases.
  const source = [
    reference,
    ...(reference.requiredSources ?? []),
    ...(reference.fallbackSources ?? []),
  ].find((source) => source.node === iterable && source.projection[0] === null);
  if (source === undefined) return null;
  const slot = semanticSelectedReferenceSlot(
    { node: iterable, projection: [] },
    state,
  );
  const container = slot === undefined ? null : semanticContainer(slot.value);
  if (container?.coverage.status !== "complete") return null;
  const select = (
    candidate: { readonly node: t.Node; readonly projection: PropertyPath },
    name: string,
  ) => ({
    ...candidate,
    projection:
      candidate.node === iterable && candidate.projection[0] === null
        ? [name, ...candidate.projection.slice(1)]
        : candidate.projection,
  });
  return container.slots.map((slot) => {
    const { projection } = select(reference, slot.name);
    return {
      ...reference,
      projection,
      path: projection,
      fallbackPath: projection,
      ...(reference.requiredSources === undefined
        ? {}
        : {
            requiredSources: reference.requiredSources.map((source) =>
              select(source, slot.name),
            ),
          }),
      ...(reference.fallbackSources === undefined
        ? {}
        : {
            fallbackSources: reference.fallbackSources.map((source) =>
              select(source, slot.name),
            ),
          }),
    };
  });
};

const referencedValues = (
  node: t.Node,
  path: PropertyPath,
  effect: ValueEffect,
  state: JavaScriptSemanticAnalysisState,
  widenedGetterResult = false,
): readonly ReferencedValue[] => {
  if (effect === "escape" && t.isFunction(node))
    return semanticCallableResultExpressions(node).flatMap(
      ({ node, delegated }) =>
        node === null ? [] : [{ node, path: delegated ? [null] : [] }],
    );
  // An initializer owns its slots; only deeper writes can affect shared children.
  if (t.isObjectExpression(node) || t.isArrayExpression(node)) {
    if (effect === "write" && path.length < 2) return [];
    return t.isObjectExpression(node)
      ? semanticObjectPropertyReferences(node, path, state)
      : semanticArrayPropertyReferences(node, path);
  }
  if (t.isClass(node) || t.isNewExpression(node))
    return constructedReferenceValues(
      node,
      path,
      effect,
      state,
      widenedGetterResult,
    );
  return branchReferenceValues(node, path);
};

const constructedReferenceValues = (
  node: t.ClassDeclaration | t.ClassExpression | t.NewExpression,
  path: PropertyPath,
  effect: ValueEffect,
  state: JavaScriptSemanticAnalysisState,
  widenedGetterResult: boolean,
): readonly ReferencedValue[] => {
  // Only retry results lost a suffix that could reach any constructed field.
  // Preserve that reachability through aliases and nested allocations, without
  // broadening ordinary whole-receiver escapes.
  const [key = widenedGetterResult ? null : undefined, ...remaining] = path;
  // Replacing a receiver property does not mutate the object it previously held.
  if (key === undefined || (effect === "write" && remaining.length === 0))
    return [];
  const classes = t.isClass(node)
    ? [node]
    : semanticClassCandidates(node.callee, state);
  return classes.flatMap((owner) =>
    semanticClassPropertyReferences(
      { owner, kind: t.isClass(node) ? "static" : "instance" },
      [key, ...remaining],
      state,
    ),
  );
};

const branchReferenceValues = (
  node: t.Node,
  path: PropertyPath,
): readonly ReferencedValue[] => {
  if (t.isAssignmentExpression(node))
    return node.operator === "||=" || node.operator === "??="
      ? [
          { node: node.left, path },
          { node: node.right, path },
        ]
      : [{ node: node.right, path }];
  if (t.isAwaitExpression(node)) return [{ node: node.argument, path }];
  if (t.isSequenceExpression(node)) {
    const last = node.expressions.at(-1);
    return last === undefined ? [] : [{ node: last, path }];
  }
  if (t.isConditionalExpression(node))
    return [
      { node: node.consequent, path },
      { node: node.alternate, path },
    ];
  if (t.isLogicalExpression(node))
    return [
      { node: node.left, path },
      { node: node.right, path },
    ];
  return [];
};

type MutationObservableOrigin =
  | t.ObjectExpression
  | t.ArrayExpression
  | t.ClassDeclaration
  | t.ClassExpression
  | t.NewExpression
  | "ambient"
  | "array"
  | "array-prototype"
  | "function"
  | "opaque";

interface MutationObserverNode {
  origins?: Set<MutationObservableOrigin>;
  sources?: Set<MutationObserverNode>;
  dependents?: Set<MutationObserverNode>;
  projections?: Map<string, MutationObserverNode>;
  readonly read?: {
    readonly source: MutationObserverNode;
    readonly key: PropertyPath[number];
  };
}

const observableMutationPaths = (
  state: JavaScriptSemanticAnalysisState,
): {
  readonly normalize: (
    bindingId: string,
    path: PropertyPath,
    effect: ValueEffect,
  ) => PropertyPath | null;
  readonly repeatsUnpruned: (
    bindingId: string,
    prefix: PropertyPath,
  ) => boolean;
} => {
  const bindingNodes = new Map<string, MutationObserverNode>();
  const expressions = new WeakMap<t.Node, MutationObserverNode>();
  const pendingExpressions: {
    readonly expression: t.Node;
    readonly observer: MutationObserverNode;
  }[] = [];
  const pending: MutationObserverNode[] = [];
  const queued = new Set<MutationObserverNode>();
  const schedule = (node: MutationObserverNode): void => {
    if (queued.has(node)) return;
    queued.add(node);
    pending.push(node);
  };
  const create = (read?: MutationObserverNode["read"]): MutationObserverNode =>
    // Most bindings have no object origin or property projection. Materialize
    // each collection only when it contains a fact or relationship.
    read === undefined ? {} : { read };
  const link = (
    source: MutationObserverNode,
    target: MutationObserverNode,
  ): void => {
    if (target.sources?.has(source) === true) return;
    (target.sources ??= new Set()).add(source);
    (source.dependents ??= new Set()).add(target);
    schedule(target);
  };
  const expressionNode = (node: t.Node): MutationObserverNode => {
    const expression = unwrapJavaScriptExpression(node).node;
    const existing = expressions.get(expression);
    if (existing !== undefined) return existing;
    const observer = create();
    expressions.set(expression, observer);
    pendingExpressions.push({ expression, observer });
    return observer;
  };
  const project = (
    source: MutationObserverNode,
    path: PropertyPath,
  ): MutationObserverNode => {
    let observer = source;
    for (const key of path) {
      const identity = JSON.stringify(
        key === null || typeof key === "object" ? key : String(key),
      );
      let selected = observer.projections?.get(identity);
      if (selected === undefined) {
        selected = create({ source: observer, key });
        (observer.projections ??= new Map()).set(identity, selected);
        (observer.dependents ??= new Set()).add(selected);
        schedule(selected);
      }
      observer = selected;
    }
    return observer;
  };
  for (const binding of state.bindingsById.values())
    bindingNodes.set(binding.bindingId, create());
  for (const binding of state.bindingsById.values()) {
    const observer = bindingNodes.get(binding.bindingId);
    if (observer === undefined) continue;
    // Imported values are external objects with observable member slots even
    // when their syntax has no local object-allocation node (for example a
    // CommonJS namespace from `require("node:fs")`). Keep those writes at their
    // exact member paths instead of widening the first path to a wildcard.
    const hasParsedRequireOrigin = binding.initializers.some(
      ({ node }) =>
        semanticRequireOrigin(node, state) !== undefined ||
        hasSemanticCreateRequireFactoryOrigin(node, state),
    );
    if (
      binding.directOrigins.length > 0 ||
      hasParsedRequireOrigin ||
      binding.hostOrigin !== undefined
    )
      (observer.origins ??= new Set()).add("opaque");
    for (const initializer of binding.initializers) {
      link(
        project(expressionNode(initializer.node), initializer.projection),
        observer,
      );
    }
    // Preserve exact paths where copies, defaults or iteration need their
    // reference-specific projections; an opaque origin prevents pruning.
    if (binding.referenceInitializers.length > 0)
      (observer.origins ??= new Set()).add("opaque");
    for (const initializer of binding.referenceInitializers) {
      for (const source of [
        initializer,
        ...(initializer.requiredSources ?? []),
        ...(initializer.fallbackSources ?? []),
      ])
        link(expressionNode(source.node), observer);
    }
  }
  const settle = (): void => {
    while (pendingExpressions.length > 0 || pending.length > 0) {
      while (pendingExpressions.length > 0) {
        const selected = pendingExpressions.pop();
        if (selected === undefined) break;
        const { expression, observer } = selected;
        if (t.isFunction(expression))
          // Keep own-member writes precise without replacing the existing
          // links to references handed to a function's eventual caller.
          (observer.origins ??= new Set()).add("function");
        // Keep class/getter projections distinct so cycle pruning does not
        // discard observable escapes through a shared getter result.
        if (
          t.isNewExpression(expression) &&
          semanticClassCandidates(expression.callee, state).length === 0
        )
          (observer.origins ??= new Set()).add("opaque");
        else if (
          t.isObjectExpression(expression) ||
          t.isArrayExpression(expression) ||
          t.isClass(expression) ||
          t.isNewExpression(expression)
        )
          (observer.origins ??= new Set()).add(expression);
        else if (t.isIdentifier(expression)) {
          const binding = resolveSemanticBindingState(
            state,
            expression,
            expression.name,
          );
          if (binding !== undefined) {
            const origin = bindingNodes.get(binding.bindingId);
            if (origin !== undefined) link(origin, observer);
          } else if (expression.name === "Array")
            (observer.origins ??= new Set()).add("array");
          else if (
            ["globalThis", "global", "window", "self"].includes(expression.name)
          )
            (observer.origins ??= new Set()).add("ambient");
        } else if (
          t.isMemberExpression(expression) ||
          t.isOptionalMemberExpression(expression)
        )
          link(
            project(expressionNode(expression.object), [
              semanticStaticPropertyKey(
                expression.property,
                expression.computed,
              ),
            ]),
            observer,
          );
        else
          for (const reference of referencedValues(
            expression,
            [],
            "escape",
            state,
          ))
            link(
              project(expressionNode(reference.node), reference.path),
              observer,
            );
        schedule(observer);
      }
      const observer = pending.pop();
      if (observer === undefined) continue;
      queued.delete(observer);
      let changed = false;
      const add = (origin: MutationObservableOrigin): void => {
        if (observer.origins?.has(origin) === true) return;
        (observer.origins ??= new Set()).add(origin);
        changed = true;
      };
      for (const source of observer.sources ?? [])
        for (const origin of source.origins ?? []) add(origin);
      if (observer.read !== undefined) {
        const { source, key } = observer.read;
        if (key === null || typeof key === "object") {
          // Dynamic keys and copied-slot masks retain their original paths.
          // Enumerating their exclusion combinations would recreate the growth
          // that the mutation collector's selection union already prevents.
          if ((source.origins?.size ?? 0) > 0) add("opaque");
        } else
          for (const origin of source.origins ?? []) {
            if (typeof origin === "string") {
              if (origin === "array-prototype" || origin === "opaque")
                add(origin);
              else if (
                origin === "ambient" &&
                semanticPropertyPathKeyMatches(key, "Array")
              )
                add("array");
              else if (
                origin === "array" &&
                semanticPropertyPathKeyMatches(key, "prototype")
              )
                add("array-prototype");
            } else {
              for (const reference of referencedValues(
                origin,
                [key],
                "escape",
                state,
              )) {
                link(
                  project(expressionNode(reference.node), reference.path),
                  observer,
                );
                if (reference.iterableFallbackPath !== undefined)
                  link(
                    project(
                      expressionNode(reference.node),
                      reference.iterableFallbackPath,
                    ),
                    observer,
                  );
              }
            }
          }
      }
      if (changed)
        for (const dependent of observer.dependents ?? []) schedule(dependent);
    }
  };
  settle();
  const normalize = (
    bindingId: string,
    path: PropertyPath,
    effect: ValueEffect,
  ): PropertyPath | null => {
    let observer = bindingNodes.get(bindingId);
    if (observer === undefined) return path;
    if (path.some((key) => key !== null && typeof key === "object"))
      return path;
    if (effect === "escape") {
      observer = project(observer, path);
      settle();
      return (observer.origins?.size ?? 0) === 0 ? null : path;
    }
    if ((observer.origins?.size ?? 0) === 0)
      return path.length === 0 ? path : [null];
    for (let offset = 0; offset < path.length; offset++) {
      const key = path[offset];
      if (key === undefined) break;
      observer = project(observer, [key]);
      settle();
      if ((observer.origins?.size ?? 0) === 0 && offset + 1 < path.length)
        return [...path.slice(0, offset + 1), null];
    }
    return path;
  };
  // A projection's origins depend only on its source origins and key. Once
  // repeating a prefix revisits an origin set, every longer repetition stays
  // observable and normalization can never prune it. The answer depends only
  // on the binding and prefix, so every revisit of a long chain shares it.
  const repeated = new Map<string, boolean>();
  const repeatsUnpruned = (
    bindingId: string,
    prefix: PropertyPath,
  ): boolean => {
    const key = JSON.stringify([bindingId, prefix]);
    const cached = repeated.get(key);
    if (cached !== undefined) return cached;
    let observer = bindingNodes.get(bindingId);
    const signatures = new Set<string>();
    let result = false;
    while (observer !== undefined && prefix.length > 0) {
      observer = project(observer, prefix);
      settle();
      if ((observer.origins?.size ?? 0) === 0) break;
      const signature = JSON.stringify(
        [...(observer.origins ?? [])]
          .map((origin) =>
            typeof origin === "string"
              ? origin
              : `${String(origin.start)}:${String(origin.end)}`,
          )
          .sort(compareUnicodeCodePoints),
      );
      if (signatures.has(signature)) {
        result = true;
        break;
      }
      signatures.add(signature);
    }
    repeated.set(key, result);
    return result;
  };
  return { normalize, repeatsUnpruned };
};
