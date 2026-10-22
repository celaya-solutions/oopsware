import * as t from "@babel/types";

import type {
  JavaScriptSemanticCallable,
  JavaScriptSemanticChildProcessInteraction,
  JavaScriptSemanticChildProcessSpawn,
} from "./javascriptSemanticIr.js";
import { createSemanticCallableIdStack } from "./javascriptSemanticCallableStack.js";
import { createSemanticExpressionShapeResolver } from "./javascriptSemanticExpressionShapes.js";
import {
  semanticStaticPropertyName,
  staticObjectProperty,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  isUnshadowedGlobal,
  resolveSemanticBindingState,
  semanticStableInitializer,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
} from "./javascriptSemanticState.js";
import { compareUnicodeCodePoints } from "../unicodeCodePointOrder.js";
import { traverseJavaScriptAst } from "./javascriptSemanticTraversal.js";
import { range } from "./javascriptStaticAnalysisHelpers.js";
import { semanticBindingAtRead } from "./javascriptSemanticMutationInitializers.js";
import {
  builtinDataEffectMethod,
  dataEffectLiteralString,
  dataEffectMemberCallee,
  assignedSemanticResultBindings,
  scalarAssignedResultBinding,
  semanticProjectedBindingFacts,
} from "./javascriptSemanticDataEffectHelpers.js";

const CHILD_PROCESS_METHODS = ["spawn", "exec", "execFile", "fork"] as const;
const CHILD_LISTENER_METHODS = ["on", "once", "addListener"] as const;

interface ChildProcessAnalysis {
  readonly childProcessSpawns: readonly JavaScriptSemanticChildProcessSpawn[];
  readonly childProcessInteractions: readonly JavaScriptSemanticChildProcessInteraction[];
}

type ChildSpawnContext = ReturnType<
  typeof createSemanticExpressionShapeResolver
>;

interface SpawnCandidate {
  readonly node: t.CallExpression | t.OptionalCallExpression;
  readonly method: JavaScriptSemanticChildProcessSpawn["method"];
  readonly ownerCallableId: string | null;
  readonly resultBindingId: string | null;
  readonly projectedResultBindings: readonly {
    readonly bindingId: string;
    readonly projectionPath: readonly (string | number | null)[];
    readonly resolution: "complete" | "partial";
  }[];
}

interface ChildInteractionContext {
  readonly state: JavaScriptSemanticAnalysisState;
  readonly spawnByNode: WeakMap<t.Node, SpawnCandidate>;
  readonly spawnsByBinding: ReadonlyMap<string, readonly SpawnCandidate[]>;
}

/** Recover explicit asynchronous node:child_process ownership candidates. */
export const collectJavaScriptSemanticChildProcesses = (
  program: t.Program,
  state: JavaScriptSemanticAnalysisState,
  callables: readonly JavaScriptSemanticCallable[],
): ChildProcessAnalysis => {
  const candidates = collectSpawns(program, state, callables);
  const context = createSemanticExpressionShapeResolver(state);
  const childProcessSpawns = candidates.map((candidate) =>
    immutableSpawn(candidate, context),
  );
  return {
    childProcessSpawns,
    childProcessInteractions: collectInteractions(
      program,
      state,
      callables,
      candidates,
    ),
  };
};

const collectSpawns = (
  program: t.Program,
  state: JavaScriptSemanticAnalysisState,
  callables: readonly JavaScriptSemanticCallable[],
): SpawnCandidate[] => {
  const output: SpawnCandidate[] = [];
  const admittedCallables = new Set(
    callables.map(({ callableId }) => callableId),
  );
  const callableStack = createSemanticCallableIdStack(admittedCallables);
  const ancestors: t.Node[] = [];
  traverseJavaScriptAst(program, {
    enter: (node, parent) => {
      callableStack.enter(node, parent);
      if (t.isCallExpression(node) || t.isOptionalCallExpression(node)) {
        const method = childProcessMethod(node.callee, state);
        if (method !== null) {
          const projectedResultBindings = assignedSemanticResultBindings(
            node,
            ancestors,
            state,
          );
          output.push({
            node,
            method,
            ownerCallableId: callableStack.callables.at(-1) ?? null,
            resultBindingId: scalarAssignedResultBinding(
              projectedResultBindings,
            ),
            projectedResultBindings: semanticProjectedBindingFacts(
              projectedResultBindings.filter(
                ({ projectionPath }) => projectionPath.length > 0,
              ),
            ),
          });
        }
      }
      ancestors.push(node);
    },
    exit: (node) => {
      ancestors.pop();
      callableStack.exit(node);
    },
  });
  return output;
};

const immutableSpawn = (
  candidate: SpawnCandidate,
  context: ChildSpawnContext,
): JavaScriptSemanticChildProcessSpawn => {
  const { options, argvCount } = spawnArguments(candidate, context);
  const command = dataEffectLiteralString(candidate.node.arguments[0]);
  return {
    processId: spawnId(candidate),
    method: candidate.method,
    location: range(candidate.node),
    ownerCallableId: candidate.ownerCallableId,
    resultBindingId: candidate.resultBindingId,
    projectedResultBindings: candidate.projectedResultBindings,
    command,
    argvCount,
    environmentSupplied: objectHasProperty(options, "env"),
    stdioMode: stdioMode(options, candidate.method, context),
    resolution: command === null ? "partial" : "complete",
  };
};

const collectInteractions = (
  program: t.Program,
  state: JavaScriptSemanticAnalysisState,
  callables: readonly JavaScriptSemanticCallable[],
  spawns: readonly SpawnCandidate[],
): JavaScriptSemanticChildProcessInteraction[] => {
  const output: JavaScriptSemanticChildProcessInteraction[] = [];
  const callableIds = new Set(callables.map(({ callableId }) => callableId));
  const callableStack = createSemanticCallableIdStack(callableIds);
  const spawnByNode = new WeakMap<t.Node, SpawnCandidate>();
  const spawnsByBinding = new Map<string, SpawnCandidate[]>();
  for (const spawn of spawns) {
    spawnByNode.set(spawn.node, spawn);
    const ids = [
      ...(spawn.resultBindingId === null ? [] : [spawn.resultBindingId]),
      ...spawn.projectedResultBindings.map(({ bindingId }) => bindingId),
    ];
    for (const id of ids) {
      const existing = spawnsByBinding.get(id) ?? [];
      existing.push(spawn);
      spawnsByBinding.set(id, existing);
    }
  }
  const context: ChildInteractionContext = {
    state,
    spawnByNode,
    spawnsByBinding,
  };
  traverseJavaScriptAst(program, {
    enter: (node, parent) => {
      callableStack.enter(node, parent);
      if (!t.isCallExpression(node) && !t.isOptionalCallExpression(node))
        return;
      const interaction = childInteraction(
        node,
        callableStack.callables.at(-1) ?? null,
        context,
      );
      if (interaction === null) return;
      output.push(interaction);
    },
    exit: (node) => callableStack.exit(node),
  });
  return output;
};

const childInteraction = (
  node: t.CallExpression | t.OptionalCallExpression,
  ownerCallableId: string | null,
  context: ChildInteractionContext,
): JavaScriptSemanticChildProcessInteraction | null => {
  const { state } = context;
  const member = dataEffectMemberCallee(node);
  if (member === null) return null;
  const method = semanticStaticPropertyName(member.property, member.computed);
  const classification = classifyInteraction(method, node.arguments[0]);
  if (classification === null) return null;
  const binding = objectBinding(member.object, state);
  const { candidates: linked, complete } = resolveChildCandidates(
    member.object,
    context,
  );
  if (linked.length === 0) return null;
  const { kind, interactionMethod, eventName } = classification;
  const listener = node.arguments[1];
  return {
    interactionId: `child:${kind}:${String(node.start ?? -1)}:${String(node.end ?? -1)}`,
    kind,
    method: interactionMethod,
    location: range(node),
    ownerCallableId,
    processBindingId: binding?.bindingId ?? null,
    linkedProcessIds: linked
      .map((candidate) => spawnId(candidate))
      .sort(compareUnicodeCodePoints),
    eventName: kind === "listener" ? eventName : null,
    signalName:
      kind === "signal" ? killSignalName(node.arguments, state) : null,
    listenerLocation:
      kind === "listener" && t.isNode(listener) ? range(listener) : null,
    resolution: complete ? "complete" : "partial",
  };
};

// Only an omitted argument or the unshadowed global undefined selects the
// SIGTERM default; an unresolved argument leaves the signal unknown.
const killSignalName = (
  args: t.CallExpression["arguments"],
  state: JavaScriptSemanticAnalysisState,
): string | null => {
  const [signal] = args;
  if (signal === undefined) return "SIGTERM";
  const expression = unwrapJavaScriptExpression(signal).node;
  if (
    t.isUnaryExpression(expression, { operator: "void" }) ||
    isUnshadowedGlobal(expression, state, "undefined")
  )
    return "SIGTERM";
  return dataEffectLiteralString(signal);
};

const classifyInteraction = (
  method: string,
  argument:
    | t.Expression
    | t.SpreadElement
    | t.JSXNamespacedName
    | t.ArgumentPlaceholder
    | undefined,
): {
  readonly kind: JavaScriptSemanticChildProcessInteraction["kind"];
  readonly interactionMethod: JavaScriptSemanticChildProcessInteraction["method"];
  readonly eventName: "exit" | "error" | null;
} | null => {
  if (method === "kill")
    return { kind: "signal", interactionMethod: "kill", eventName: null };
  const listenerMethod = CHILD_LISTENER_METHODS.find(
    (candidate) => candidate === method,
  );
  const eventName = dataEffectLiteralString(argument);
  return listenerMethod !== undefined &&
    (eventName === "exit" || eventName === "error")
    ? { kind: "listener", interactionMethod: listenerMethod, eventName }
    : null;
};

const childProcessMethod = (
  callee: t.Node,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptSemanticChildProcessSpawn["method"] | null => {
  const method = builtinDataEffectMethod(callee, state, [
    "child_process",
    "node:child_process",
  ]);
  return (
    CHILD_PROCESS_METHODS.find((candidate) => candidate === method) ?? null
  );
};

const resolveChildCandidates = (
  node: t.Node,
  context: ChildInteractionContext,
): {
  readonly candidates: readonly SpawnCandidate[];
  readonly complete: boolean;
} => {
  const { state, spawnByNode, spawnsByBinding } = context;
  const candidates = new Set<SpawnCandidate>();
  const fallback = new Set<SpawnCandidate>();
  const pending = [node];
  const visited = new Set<t.Node>();
  let complete = true;
  while (pending.length > 0) {
    const current = unwrapJavaScriptExpression(pending.pop()!).node;
    if (visited.has(current)) {
      complete = false;
      continue;
    }
    visited.add(current);
    // Spawn-result assignment already admits await as an identity wrapper.
    if (t.isAwaitExpression(current)) {
      pending.push(current.argument);
      continue;
    }
    const direct = spawnByNode.get(current);
    if (direct !== undefined) {
      candidates.add(direct);
      continue;
    }
    const binding = t.isIdentifier(current)
      ? resolveSemanticBindingState(state, current, current.name)
      : undefined;
    if (binding === undefined) {
      complete = false;
      continue;
    }
    for (const candidate of spawnsByBinding.get(binding.bindingId) ?? [])
      fallback.add(candidate);
    // An alias captures its source at its initializer read, not at the later
    // interaction. The shared selector retains all sources across uncertain
    // control flow, loops and writes in other activations.
    const snapshot = semanticBindingAtRead(
      binding,
      current,
      state.parentsByNode,
    );
    const selected = snapshot.binding;
    const initializers = [
      ...selected.initializers,
      ...selected.referenceInitializers,
    ];
    // Defaults and other reference sources do not exclude a caller-supplied
    // value, even when they are the binding's only retained source.
    if (initializers.length !== 1 || selected.referenceInitializers.length > 0)
      complete = false;
    const stable = semanticStableInitializer(binding, state);
    for (const initializer of initializers) {
      if (state.conditionallySkippedExpressions.has(initializer.node))
        complete = false;
      if (initializer.projection.length > 0) {
        complete = false;
        continue;
      }
      // A lone assignment can still be later or belong to another activation.
      // Only initialized lexical declarations exclude an earlier undefined value
      // without a same-body ordering proof.
      if (
        !(stable === initializer && !binding.declarationKinds.has("var")) &&
        snapshot.status !== "ordered"
      )
        complete = false;
      pending.push(initializer.node);
    }
  }
  // Preserve historical candidates with explicit uncertainty when the selected
  // value cannot be established; a binding inventory alone never proves identity.
  if (!complete) for (const candidate of fallback) candidates.add(candidate);
  return {
    candidates: [...candidates],
    complete: complete && candidates.size === 1,
  };
};
const spawnArguments = (
  candidate: SpawnCandidate,
  context: ChildSpawnContext,
): {
  readonly options: t.Node | undefined;
  readonly argvCount: number | null;
} => {
  const args = candidate.node.arguments;
  if (t.isSpreadElement(args[0])) return { options: args[0], argvCount: null };
  const second = args[1] && unwrapJavaScriptExpression(args[1]).node;
  const third = args[2] && unwrapJavaScriptExpression(args[2]).node;
  const expressionShape = context;
  const argv =
    candidate.method !== "exec" && t.isArrayExpression(second)
      ? second
      : undefined;
  // Only a proven argv array or nullish placeholder admits third-slot options.
  // Otherwise the second argument may itself be options, ignoring the third.
  const options =
    candidate.method === "exec" || second === undefined
      ? second
      : argv !== undefined ||
          expressionShape.isArray(second) ||
          expressionShape.isNullish(second)
        ? third
        : second;
  return {
    options,
    argvCount:
      argv !== undefined &&
      !argv.elements.some((element) => t.isSpreadElement(element))
        ? argv.elements.length
        : null,
  };
};

const objectHasProperty = (object: t.Node | undefined, name: string): boolean =>
  t.isObjectExpression(object) &&
  object.properties.some(
    (property) =>
      !t.isSpreadElement(property) &&
      semanticStaticPropertyName(property.key, property.computed) === name,
  );

const stdioMode = (
  options: t.Node | undefined,
  method: JavaScriptSemanticChildProcessSpawn["method"],
  context: ChildSpawnContext,
): string => {
  if (options === undefined) return "default";
  const expression = unwrapJavaScriptExpression(options).node;
  if (
    context.isNullish(expression) ||
    ((method === "exec" || method === "execFile") &&
      context.isCallback(expression))
  )
    return "default";
  const lookup = staticObjectProperty(expression, "stdio", context.isNullish);
  if (lookup.status === "missing") return "default";
  if (lookup.status !== "explicit") return "dynamic";
  const value = unwrapJavaScriptExpression(lookup.property.value).node;
  if (context.isNullish(value)) return "default";
  if (t.isStringLiteral(value)) return value.value;
  if (t.isArrayExpression(value)) return "array";
  return "dynamic";
};

const objectBinding = (
  node: t.Expression | t.Super,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptSemanticBindingState | undefined =>
  t.isIdentifier(node)
    ? resolveSemanticBindingState(state, node, node.name)
    : undefined;

const spawnId = (candidate: SpawnCandidate): string =>
  `child:spawn:${String(candidate.node.start ?? -1)}:${String(candidate.node.end ?? -1)}`;
