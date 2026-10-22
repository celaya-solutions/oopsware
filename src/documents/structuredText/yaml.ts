import {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseAllDocuments,
  type Document as YamlDocument,
  type Node as YamlNode,
  type Scalar,
} from "yaml";

import {
  boundedPath,
  pointerToken,
  type DocumentBuilder,
} from "./DocumentBuilder.js";

interface Pending {
  readonly node: unknown;
  readonly path: string;
  readonly name: string | null;
  readonly depth: number;
  readonly key?: unknown;
}

const keyName = (key: unknown): string =>
  isScalar(key)
    ? String(key.value)
    : key === null || key === undefined
      ? ""
      : "?complex-key";

const firstLine = (message: string) => message.split("\n")[0] ?? message;

/** Parser errors and warnings, with unresolved tags named as never constructed. */
const reportProblems = (
  builder: DocumentBuilder,
  document: YamlDocument.Parsed,
  record: number,
): void => {
  for (const error of document.errors)
    builder.diagnostic(
      "error",
      `yaml_${error.code.toLowerCase()}`,
      firstLine(error.message),
      error.pos[0],
      record,
    );
  for (const warning of document.warnings) {
    const unresolved = warning.code === "TAG_RESOLVE_FAILED";
    builder.diagnostic(
      "warning",
      unresolved ? "yaml_unresolved_tag" : `yaml_${warning.code.toLowerCase()}`,
      unresolved
        ? `${firstLine(warning.message)} The tagged value is shown as source text; no object is constructed.`
        : firstLine(warning.message),
      warning.pos[0],
      record,
    );
  }
};

/** Exact source text for numbers and booleans; decoded text for strings. */
const scalarValue = (value: unknown, source: string | null): string | null =>
  typeof value === "string"
    ? value
    : value === null && (source === null || source === "")
      ? null
      : (source ?? String(value));

const scalarType = (value: unknown): string =>
  value === null
    ? "null"
    : typeof value === "bigint"
      ? "integer"
      : typeof value;

/** Children of a collection, in source order, ready for a depth-first stack. */
const childrenOf = (item: Pending, node: YamlNode): Pending[] =>
  isMap(node)
    ? node.items.map((pair) => ({
        node: pair.value,
        path: boundedPath(`${item.path}/${pointerToken(keyName(pair.key))}`),
        name: keyName(pair.key),
        depth: item.depth + 1,
        key: pair.key,
      }))
    : isSeq(node)
      ? node.items.map((child, index) => ({
          node: child,
          path: boundedPath(`${item.path}/${String(index)}`),
          name: null,
          depth: item.depth + 1,
        }))
      : [];

/** Emit one YAML node; returns whether it was an alias. */
const emitNode = (
  builder: DocumentBuilder,
  item: Pending,
  record: number,
): boolean => {
  if (item.node === null || item.node === undefined) {
    // A key without a value is an explicit null in the mapping.
    if (item.name !== null) {
      const keyRange = isScalar(item.key) ? (item.key.range ?? null) : null;
      builder.node({
        depth: item.depth,
        kind: "scalar",
        path: item.path,
        name: item.name,
        value: null,
        record,
        at: keyRange === null ? null : keyRange[0],
        details: {
          type: "null",
          style: null,
          anchor: null,
          tag: null,
          source: null,
        },
      });
    }
    return false;
  }
  const node = item.node as YamlNode;
  const range = node.range ?? null;
  const common = {
    depth: item.depth,
    path: item.path,
    name: item.name,
    record,
    at: range === null ? null : range[0],
    end: range === null ? null : range[1],
  };
  const anchor = "anchor" in node ? (node.anchor ?? null) : null;
  const tag = node.tag ?? null;
  if (isAlias(node)) {
    builder.node({
      ...common,
      kind: "alias",
      value: `*${node.source}`,
      details: { target_anchor: node.source, expanded: false },
    });
    return true;
  }
  if (isMap(node) || isSeq(node)) {
    builder.node({
      ...common,
      kind: isMap(node) ? "mapping" : "sequence",
      details: {
        children: node.items.length,
        anchor,
        tag,
        flow: node.flow ?? false,
      },
    });
    return false;
  }
  if (isScalar(node)) {
    const scalar: Scalar = node;
    const source =
      range === null ? null : builder.source.text.slice(range[0], range[1]);
    builder.node({
      ...common,
      kind: "scalar",
      value: scalarValue(scalar.value, source),
      details: {
        type: scalarType(scalar.value),
        style: scalar.type ?? null,
        anchor,
        tag,
        source: source !== null && source.length <= 256 ? source : null,
      },
    });
  }
  return false;
};

/**
 * Walk YAML documents as parsed nodes. Aliases stay references (never
 * expanded), tags are reported but never constructed, and duplicate keys are
 * parser errors. Returns the number of documents.
 */
export const walkYaml = (builder: DocumentBuilder): number => {
  builder.unit = "document";
  const documents = parseAllDocuments(builder.source.text, {
    version: "1.2",
    schema: "core",
    customTags: [],
    merge: false,
    uniqueKeys: true,
    strict: true,
    intAsBigInt: true,
    prettyErrors: false,
  });
  let count = 0;
  let aliases = 0;
  for (const document of documents) {
    count += 1;
    const record = count;
    const [start, , end] = document.range;
    builder.unitStarts.push(start);
    reportProblems(builder, document, record);
    builder.node({
      depth: 0,
      kind: "document",
      path: `#${String(record)}`,
      record,
      at: start,
      end,
      details: { explicit_start: document.directives.docStart !== null },
    });
    const stack: Pending[] = [
      { node: document.contents, path: "", name: null, depth: 1 },
    ];
    for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
      if (emitNode(builder, item, record)) aliases += 1;
      if (item.node !== null && item.node !== undefined) {
        // A loop, not a spread: a collection may have more items than a call takes arguments.
        const children = childrenOf(item, item.node as YamlNode);
        for (let child = children.length - 1; child >= 0; child -= 1)
          stack.push(children[child] as Pending);
      }
    }
  }
  if (aliases > 0)
    builder.diagnostic(
      "info",
      "yaml_aliases_not_expanded",
      `${String(aliases)} alias reference(s) are listed as references to their anchors and never expanded.`,
    );
  return count;
};
