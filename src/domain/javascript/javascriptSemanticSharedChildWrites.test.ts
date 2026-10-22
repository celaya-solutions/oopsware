import { expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";
import * as t from "@babel/types";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";
import { indexJavaScriptBindingsWithReceiversSteps } from "./javascriptSemanticAnalysis.js";
import { semanticProjectedSourcesAtRead } from "./javascriptSemanticProjectedSources.js";

const shapes = [
  {
    before: "const old={child:{inner:INITIAL}};const box={...old};",
    shared: "old.child={inner:box.child.inner};",
    fresh: "old.child={inner:INITIAL};",
    write: "old.child.inner.SLOT=NEXT;",
    read: "box.child.inner.READ",
  },
  {
    before: "const old={child:{inner:INITIAL}};const {...box}=old;",
    shared: "old.child={inner:box.child.inner};",
    fresh: "old.child={inner:INITIAL};",
    write: "old.child.inner.SLOT=NEXT;",
    read: "box.child.inner.READ",
  },
  {
    before: "const old=[{inner:INITIAL}];const box=[...old];",
    shared: "old[0]={inner:box[0].inner};",
    fresh: "old[0]={inner:INITIAL};",
    write: "old[0].inner.SLOT=NEXT;",
    read: "box[0].inner.READ",
  },
  {
    before: "const old=[{inner:INITIAL}];const [...box]=old;",
    shared: "old[0]={inner:box[0].inner};",
    fresh: "old[0]={inner:INITIAL};",
    write: "old[0].inner.SLOT=NEXT;",
    read: "box[0].inner.READ",
  },
  {
    before: "const old={child:[INITIAL]};const box={...old};",
    shared: "old.child=[box.child[0]];",
    fresh: "old.child=[INITIAL];",
    write: "old.child[0].SLOT=NEXT;",
    read: "box.child[0].READ",
  },
] as const;
const values = [
  {
    initial: "{make:()=>({})}",
    next: "()=>module",
    slot: "make",
    read: "make().require('./shared.cjs')",
    host: false,
  },
  {
    initial: "{make:()=>module}",
    next: "()=>({})",
    slot: "make",
    read: "make().require('./shared.cjs')",
    host: true,
  },
  {
    initial: "{loader:{}}",
    next: "module",
    slot: "loader",
    read: "loader.require('./shared.cjs')",
    host: false,
  },
  {
    initial: "{loader:module}",
    next: "{}",
    slot: "loader",
    read: "loader.require('./shared.cjs')",
    host: true,
  },
  {
    initial: "{load:()=>({})}",
    next: "module.require",
    slot: "load",
    read: "load('./shared.cjs')",
    host: false,
  },
  {
    initial: "{load:module.require}",
    next: "()=>({})",
    slot: "load",
    read: "load('./shared.cjs')",
    host: true,
  },
] as const;

it.each(
  shapes.flatMap((shape) =>
    values.flatMap((value) =>
      [true, false].map((shared) => ({
        source: (
          shape.before +
          (shared ? shape.shared : shape.fresh) +
          shape.write +
          shape.read +
          ";"
        )
          .replaceAll("INITIAL", value.initial)
          .replaceAll("NEXT", value.next)
          .replaceAll("SLOT", value.slot)
          .replaceAll("READ", value.read),
        expression: shape.read.replaceAll("READ", value.read),
        // The public module/delegate owner retains unknown after the copy's child
        // escapes into the new parent. Factory result selection can exclude it.
        expected: shared ? !value.host || value.slot !== "make" : value.host,
      })),
    ),
  ),
)(
  "distinguishes shared and newly allocated descendant receivers: $source",
  ({ source, expression, expected }) => {
    const result = analyzeJavaScriptStaticSource(source);
    expect(result.parse_error_count).toBe(0);
    expect(
      result.references.filter(
        (reference) => reference.expression === expression,
      ),
    ).toEqual(
      expected
        ? [expect.objectContaining({ kind: "require", specifier: null })]
        : [],
    );
  },
);

it.each(["module", "{}"])(
  "selects the later write to a shared projected receiver: %s",
  (next) => {
    const parsed = parseJavaScriptSource(
      `const old={child:{inner:{loader:module}}};const box={...old};old.child={inner:box.child.inner};old.child.inner.loader=${next};box.child.inner.loader.require('./shared.cjs');`,
      "shared-child.cjs",
    );
    if (parsed === null) throw new Error("Expected parsed fixture");
    const steps = indexJavaScriptBindingsWithReceiversSteps(parsed.program);
    let step = steps.next();
    while (!step.done) step = steps.next();
    const index = step.value;
    const effects = index.indexMemberMutationFactsSteps();
    let effect = effects.next();
    while (!effect.done) effect = effects.next();
    const binding = [...index.bindings.bindingsById.values()].find(
      (candidate) => candidate.name === "old",
    );
    let capture: t.Node | undefined;
    let assignment: t.AssignmentExpression | undefined;
    t.traverseFast(parsed.program, (node) => {
      if (t.isSpreadElement(node)) capture = node.argument;
      if (t.isAssignmentExpression(node)) assignment = node;
    });
    if (
      binding === undefined ||
      capture === undefined ||
      assignment === undefined
    )
      throw new Error("Missing selected receiver");
    const statement = parsed.program.body.at(-1)!;
    if (!t.isExpressionStatement(statement))
      throw new Error("Missing receiver use");
    const use = statement.expression;
    expect(
      semanticProjectedSourcesAtRead(
        binding,
        capture,
        ["child", "inner", "loader"],
        index.bindings,
        true,
        use,
        [{ at: capture, depth: 1 }],
      ),
    ).toEqual([{ node: assignment.right, path: [] }]);
  },
);

it.each([
  "old.child={inner:flag?box.child.inner:{make:()=>({})}};",
  "old.child={get inner(){return box.child.inner}};",
  "old.child={...box.child};",
])(
  "retains a possible shared receiver when identity is incomplete: %s",
  (replacement) => {
    const expression = "box.child.inner.make().require('./shared.cjs')";
    const result = analyzeJavaScriptStaticSource(
      `const old={child:{inner:{make:()=>({})}}};const box={...old};${replacement}old.child.inner.make=()=>module;${expression};`,
    );
    expect(result.parse_error_count).toBe(0);
    expect(result.references).toContainEqual(
      expect.objectContaining({ kind: "require", specifier: null, expression }),
    );
  },
);

it.each([16, 600])(
  "bounds descendant receiver alternatives before expanding %i selections",
  (count) => {
    const properties = Array.from(
      { length: count },
      (_, index) => `p${index}:{make:()=>({})}`,
    ).join(",");
    const expression = "box.child.inner.make().require('./shared.cjs')";
    const result = analyzeJavaScriptStaticSource(
      `const old={child:{inner:{make:()=>({})}}};const box={...old};old.child={${properties}};old.child[key].make=()=>module;${expression};`,
    );
    expect(result.parse_error_count).toBe(0);
    const limited = result.limitations.some((limitation) =>
      limitation.includes(
        "Alias selection expansion was conservatively bounded",
      ),
    );
    expect(limited).toBe(count === 600);
    const selected = result.references.filter(
      (reference) => reference.expression === expression,
    );
    expect(selected).toEqual(
      count === 600
        ? [expect.objectContaining({ kind: "require", specifier: null })]
        : [],
    );
  },
);
