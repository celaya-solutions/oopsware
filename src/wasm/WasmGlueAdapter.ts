import { basename, dirname } from "node:path";
import * as t from "@babel/types";
import { parseJavaScriptSource } from "../domain/javascript/javascriptSourceParser.js";
import { traverseJavaScriptAst } from "../domain/javascript/javascriptSemanticTraversal.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
/** Associate visible literals with selected candidates without asserting data flow or URL identity. */
export const associateWasmGlue = (
  source: string,
  path: string,
  candidates: readonly string[],
) => {
  // Babel requires a hashbang at offset zero. Removing only its preceding BOM
  // leaves reference coordinates intact: all code starts on a later line.
  const file = parseJavaScriptSource(
    source.startsWith("\uFEFF#!") ? source.slice(1) : source,
  );
  const references: {
    value: string;
    line: number;
    column: number;
    candidate_paths: string[];
    association: "local-path-candidate" | "basename-candidates" | "unresolved";
    evidence_kind: "static-literal";
  }[] = [];
  if (file === null) return { parse_status: "failed" as const, references };
  traverseJavaScriptAst(file, {
    enter(node) {
      // Babel retains the source spelling in DirectiveLiteral.value, while
      // extra.expressionValue is the same cooked value used by StringLiteral.
      const directiveValue = t.isDirectiveLiteral(node)
        ? node.extra?.expressionValue
        : undefined;
      const value = t.isStringLiteral(node)
        ? node.value
        : typeof directiveValue === "string"
          ? directiveValue
          : t.isTemplateLiteral(node) && node.expressions.length === 0
            ? node.quasis[0]?.value.cooked
            : undefined;
      if (
        value === undefined ||
        value === null ||
        !/\.wasm(?:[?#].*)?$/iu.test(value) ||
        node.loc == null
      )
        return;
      const stripped = value.split(/[?#]/u)[0] ?? value;
      const local =
        !/^[a-z][a-z\d+.-]*:|^\/\//iu.test(value) &&
        !value.startsWith("/") &&
        !/[?#]/u.test(value);
      // Compare through the caller-path owner so `.` spellings match and a
      // symlink followed by `..` is never collapsed onto a sibling.
      const target = local
        ? absoluteCallerPath(value, { cwd: dirname(path) })
        : undefined;
      const exact =
        target === undefined
          ? []
          : candidates.filter(
              (candidate) => absoluteCallerPath(candidate) === target,
            );
      const matches =
        exact.length > 0
          ? exact
          : candidates.filter(
              (candidate) => basename(candidate) === basename(stripped),
            );
      references.push({
        value,
        line: node.loc.start.line,
        column: node.loc.start.column,
        candidate_paths: [...matches],
        association:
          exact.length > 0
            ? "local-path-candidate"
            : matches.length > 0
              ? "basename-candidates"
              : "unresolved",
        evidence_kind: "static-literal",
      });
    },
  });
  return {
    parse_status:
      file.errors.length === 0 ? ("complete" as const) : ("partial" as const),
    references,
  };
};
