import { DOMParser, ParseError } from "@xmldom/xmldom";

import type { StructuralNode } from "../../domain/document/structuredText.js";
import { boundedPath, type DocumentBuilder } from "./DocumentBuilder.js";

const XINCLUDE = "http://www.w3.org/2001/XInclude";

interface Locator {
  readonly lineNumber?: number;
  readonly columnNumber?: number;
}

/** DOM node fields read here; xmldom adds 1-based line/column when its locator is on. */
interface XmlNode extends Locator {
  readonly nodeType: number;
  readonly nodeName: string;
  readonly nodeValue: string | null;
  readonly namespaceURI?: string | null;
  readonly prefix?: string | null;
  readonly localName?: string | null;
  readonly childNodes?: ArrayLike<XmlNode>;
  readonly attributes?: ArrayLike<XmlNode & { readonly value: string }>;
  readonly publicId?: string;
  readonly systemId?: string;
  readonly internalSubset?: string;
  readonly getAttribute?: (name: string) => string | null;
}

interface Pending {
  readonly node: XmlNode;
  readonly path: string;
  readonly depth: number;
  /** Per-name position counters shared by this node's siblings. */
  readonly siblings: Map<string, number>;
}

const firstLine = (message: string) => message.split("\n")[0] ?? message;

const positionOf = (builder: DocumentBuilder, node: Locator) =>
  node.lineNumber === undefined || node.columnNumber === undefined
    ? null
    : builder.source.indexOf(node.lineNumber, node.columnNumber);

const locatorOf = (context: unknown): Locator | undefined =>
  typeof context === "object" &&
  context !== null &&
  "locator" in context &&
  typeof context.locator === "object" &&
  context.locator !== null
    ? (context.locator as Locator)
    : undefined;

/** Parse with xmldom, recording recoverable problems; undefined when not well-formed. */
const parseXml = (builder: DocumentBuilder): XmlNode | undefined => {
  const at = (locator: Locator | undefined) =>
    locator === undefined ? null : positionOf(builder, locator);
  try {
    return new DOMParser({
      locator: true,
      // Keep xmldom's line count equal to the reader's: only CR LF and CR are line breaks here.
      normalizeLineEndings: (text: string) => text.replace(/\r\n?/gu, "\n"),
      onError: (level, message, context: unknown) => {
        if (level === "fatalError") return;
        const undefinedEntity = message.startsWith("entity not found");
        builder.diagnostic(
          level === "error" ? "error" : "warning",
          undefinedEntity ? "xml_undefined_entity" : `xml_${level}`,
          undefinedEntity
            ? `${firstLine(message)}; the reference is kept as literal text and nothing is expanded.`
            : firstLine(message),
          at(locatorOf(context)),
        );
      },
    }).parseFromString(builder.source.text, "text/xml") as unknown as XmlNode;
  } catch (cause) {
    if (!(cause instanceof ParseError)) throw cause;
    builder.diagnostic(
      "error",
      "xml_not_well_formed",
      `XML is not well-formed: ${firstLine(cause.message)}`,
      at(cause.locator as Locator | undefined),
    );
    return undefined;
  }
};

/** Emit an element and its attributes; XInclude is listed, never resolved. */
const emitElement = (
  builder: DocumentBuilder,
  item: Pending,
  path: string,
): void => {
  const { node, depth } = item;
  const at = positionOf(builder, node);
  const namespace = node.namespaceURI ?? null;
  builder.node({
    depth,
    at,
    kind: "element",
    path,
    name: node.nodeName,
    details: {
      namespace,
      prefix: node.prefix ?? null,
      local_name: node.localName ?? node.nodeName,
    },
  });
  if (namespace === XINCLUDE && node.localName === "include")
    builder.diagnostic(
      "warning",
      "xml_xinclude_not_resolved",
      `XInclude of "${node.getAttribute?.("href") ?? ""}" is listed but never fetched or merged.`,
      at,
    );
  for (const attribute of Array.from(node.attributes ?? []))
    builder.node({
      depth: depth + 1,
      kind: "attribute",
      path: `${path}/@${attribute.nodeName}`,
      name: attribute.nodeName,
      value: attribute.value,
      at: positionOf(builder, attribute),
      details: {
        namespace: attribute.namespaceURI ?? null,
        prefix: attribute.prefix ?? null,
        local_name: attribute.localName ?? attribute.nodeName,
      },
    });
};

/** xmldom keeps the quotes around DOCTYPE literals; report the literal itself. */
const unquoted = (literal: string | undefined): string | null => {
  if (literal === undefined || literal === "") return null;
  const quote = literal[0];
  return (quote === '"' || quote === "'") && literal.endsWith(quote)
    ? literal.slice(1, -1)
    : literal;
};

/** Record a document type; an internal subset is refused, an external DTD never fetched. */
const emitDoctype = (builder: DocumentBuilder, item: Pending): void => {
  const { node, depth } = item;
  const at = positionOf(builder, node);
  const internal = node.internalSubset ?? "";
  const systemId = unquoted(node.systemId);
  builder.node({
    depth,
    at,
    kind: "doctype",
    path: "/!DOCTYPE",
    name: node.nodeName,
    value: internal === "" ? null : internal,
    details: {
      public_id: unquoted(node.publicId),
      system_id: systemId,
      internal_subset: internal !== "",
      fetched: false,
    },
  });
  if (internal !== "")
    builder.diagnostic(
      "error",
      "xml_dtd_internal_subset_refused",
      "The document type has an internal subset. Its entity and attribute declarations are not processed, so entity references stay unexpanded text.",
      at,
    );
  if (systemId !== null)
    builder.diagnostic(
      "info",
      "xml_external_dtd_not_fetched",
      `External DTD "${systemId}" is recorded and never fetched.`,
      at,
    );
};

/** Text-like nodes by DOM node type; whitespace-only text is skipped. */
const emitLeaf = (builder: DocumentBuilder, item: Pending): void => {
  const { node, depth } = item;
  const value = node.nodeValue;
  const leaf: Readonly<
    Record<number, { kind: StructuralNode["kind"]; path: string } | undefined>
  > = {
    3: { kind: "text", path: `${item.path}/text()` },
    4: { kind: "cdata", path: `${item.path}/text()` },
    7: {
      kind: node.nodeName === "xml" ? "declaration" : "processing-instruction",
      path: `${item.path}/processing-instruction(${node.nodeName})`,
    },
    8: { kind: "comment", path: `${item.path}/comment()` },
  };
  const shape = leaf[node.nodeType];
  if (shape === undefined) return;
  if (node.nodeType === 3 && (value === null || value.trim() === "")) return;
  builder.node({
    depth,
    at: positionOf(builder, node),
    ...shape,
    name: node.nodeType === 7 ? node.nodeName : null,
    value,
  });
};

/**
 * Walk XML with xmldom. Nothing is fetched or expanded beyond the five
 * predefined entities and character references: DTD declarations are not
 * processed, external identifiers are only recorded, XInclude is never
 * resolved. Namespaces, attributes and document order are kept.
 */
export const walkXml = (builder: DocumentBuilder): boolean => {
  builder.unit = "line";
  const document = parseXml(builder);
  if (document === undefined) return false;
  const stack: Pending[] = [];
  // Pushed in reverse with a loop: an element may have more children than a call takes arguments.
  const pushChildren = (parent: XmlNode, path: string, depth: number) => {
    const children = parent.childNodes ?? { length: 0 };
    const siblings = new Map<string, number>();
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const node = children[index];
      if (node !== undefined) stack.push({ node, path, depth, siblings });
    }
  };
  pushChildren(document, "", 0);
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const { node, depth } = item;
    if (node.nodeType === 1) {
      const position = (item.siblings.get(node.nodeName) ?? 0) + 1;
      item.siblings.set(node.nodeName, position);
      const path = boundedPath(
        `${item.path}/${node.nodeName}[${String(position)}]`,
      );
      emitElement(builder, item, path);
      pushChildren(node, path, depth + 1);
    } else if (node.nodeType === 10) emitDoctype(builder, item);
    else emitLeaf(builder, item);
  }
  return !builder.hasErrors();
};
