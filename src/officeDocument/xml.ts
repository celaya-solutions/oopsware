import { err, ok, type Result } from "../domain/result.js";

/**
 * A bounded XML reader for Office Open XML parts. It resolves namespaces,
 * refuses any DOCTYPE (so no entity is declared, expanded or fetched), decodes
 * only the five predefined entities and numeric character references, and
 * reports anything else as not well-formed. Strict OOXML namespaces are mapped
 * to the transitional ones so readers match one name per element.
 */

export type XmlProblemCode =
  | "too_large"
  | "not_utf8"
  | "doctype"
  | "too_many_nodes"
  | "too_deep"
  | "not_well_formed";

export interface XmlProblem {
  readonly code: XmlProblemCode;
  readonly message: string;
}

export interface XmlLimits {
  readonly maxBytes: number;
  /** Upper bound on elements in one part. */
  readonly maxNodes: number;
  readonly maxDepth: number;
}

/** A part parsed into a tree: about 300 bytes per element stay in memory, so the cap is 2 million. */
export const DEFAULT_XML_LIMITS: XmlLimits = Object.freeze({
  maxBytes: 128 * 1024 ** 2,
  maxNodes: 2_000_000,
  maxDepth: 256,
});

/** A part streamed without keeping elements: bounded by its 128 MiB of bytes, not by memory. */
export const STREAM_XML_LIMITS: XmlLimits = Object.freeze({
  maxBytes: 128 * 1024 ** 2,
  maxNodes: 64_000_000,
  maxDepth: 256,
});

/** Attributes keyed by local name, or `<namespace>#<local>` when prefixed. */
export type XmlAttributes = Readonly<Record<string, string>>;

export interface XmlElement {
  readonly ns: string;
  readonly local: string;
  readonly attrs: XmlAttributes;
  readonly children: XmlElement[];
  /** Character data directly inside this element, in order. */
  text: string;
}

export interface XmlHandler {
  start?(element: XmlElement): void;
  end?(element: XmlElement): void;
}

const STRICT_NAMESPACES: ReadonlyMap<string, string> = new Map([
  [
    "http://purl.oclc.org/ooxml/wordprocessingml/main",
    "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  ],
  [
    "http://purl.oclc.org/ooxml/spreadsheetml/main",
    "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
  ],
  [
    "http://purl.oclc.org/ooxml/presentationml/main",
    "http://schemas.openxmlformats.org/presentationml/2006/main",
  ],
  [
    "http://purl.oclc.org/ooxml/drawingml/main",
    "http://schemas.openxmlformats.org/drawingml/2006/main",
  ],
  [
    "http://purl.oclc.org/ooxml/officeDocument/relationships",
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  ],
  [
    "http://purl.oclc.org/ooxml/officeDocument/math",
    "http://schemas.openxmlformats.org/officeDocument/2006/math",
  ],
]);

const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";

const canonical = (ns: string): string => STRICT_NAMESPACES.get(ns) ?? ns;

const problem = (code: XmlProblemCode, message: string): XmlProblem => ({
  code,
  message,
});

/** Thrown inside the scanner and turned into a Result at the boundary. */
class XmlFailure extends Error {
  constructor(readonly problem: XmlProblem) {
    super(problem.message);
  }
}

const fail = (code: XmlProblemCode, message: string, at: number): never => {
  throw new XmlFailure(problem(code, `${message} (offset ${String(at)})`));
};

const UTF8 = new TextDecoder("utf-8", { fatal: true });
const UTF16LE = new TextDecoder("utf-16le", { fatal: true });
const UTF16BE = new TextDecoder("utf-16be", { fatal: true });

/** Decode a part's bytes: a UTF-16 byte order mark selects UTF-16, otherwise UTF-8 (BOM dropped). */
export const decodeXmlBytes = (
  bytes: Uint8Array,
  limits: XmlLimits = DEFAULT_XML_LIMITS,
): Result<string, XmlProblem> => {
  if (bytes.length > limits.maxBytes)
    return err(
      problem(
        "too_large",
        `The part is ${String(bytes.length)} bytes; this reader parses at most ${String(limits.maxBytes)} per part.`,
      ),
    );
  try {
    if (bytes[0] === 0xff && bytes[1] === 0xfe)
      return ok(UTF16LE.decode(bytes.subarray(2)));
    if (bytes[0] === 0xfe && bytes[1] === 0xff)
      return ok(UTF16BE.decode(bytes.subarray(2)));
    return ok(UTF8.decode(bytes));
  } catch {
    return err(problem("not_utf8", "The part is not valid UTF-8 or UTF-16."));
  }
};

const NAME_END = /[\s=/>]/u;

const isXmlChar = (code: number): boolean =>
  code === 0x9 ||
  code === 0xa ||
  code === 0xd ||
  (code >= 0x20 && code <= 0xd7ff) ||
  (code >= 0xe000 && code <= 0xfffd) ||
  (code >= 0x10000 && code <= 0x10ffff);

const PREDEFINED: ReadonlyMap<string, string> = new Map([
  ["lt", "<"],
  ["gt", ">"],
  ["amp", "&"],
  ["quot", '"'],
  ["apos", "'"],
]);

const decodeEntities = (raw: string, at: number): string => {
  if (!raw.includes("&")) return raw;
  return raw.replace(
    /&([^;&\s]{1,32});|&/gu,
    (whole, name: string | undefined) => {
      if (name === undefined)
        return fail("not_well_formed", "A bare '&' is not an entity", at);
      const predefined = PREDEFINED.get(name);
      if (predefined !== undefined) return predefined;
      const hex = /^#x([0-9a-fA-F]{1,6})$/u.exec(name);
      const dec = /^#([0-9]{1,7})$/u.exec(name);
      const digits = hex?.[1] ?? dec?.[1];
      if (digits !== undefined) {
        const code = Number.parseInt(digits, hex === null ? 10 : 16);
        if (isXmlChar(code)) return String.fromCodePoint(code);
        return fail(
          "not_well_formed",
          `Character reference ${whole} is not an XML character`,
          at,
        );
      }
      return fail(
        "not_well_formed",
        `Entity ${whole} is not declared (no DOCTYPE is read)`,
        at,
      );
    },
  );
};

const unescapeText = (raw: string, at: number): string => {
  const decoded = decodeEntities(raw, at);
  // XML line-end normalization: CRLF and lone CR become LF.
  return decoded.includes("\r") ? decoded.replace(/\r\n?/gu, "\n") : decoded;
};

/** Namespace declarations of one element, chained to its parent so a declaring child costs nothing per ancestor prefix. */
interface Scope {
  readonly parent: Scope | null;
  readonly declared: ReadonlyMap<string, string> | null;
}

const ROOT_SCOPE: Scope = {
  parent: null,
  declared: new Map([["xml", XML_NAMESPACE]]),
};

const lookupPrefix = (scope: Scope, prefix: string): string | undefined => {
  for (let at: Scope | null = scope; at !== null; at = at.parent) {
    const found = at.declared?.get(prefix);
    if (found !== undefined) return found;
  }
  return undefined;
};

interface RawAttribute {
  readonly name: string;
  readonly value: string;
}

/** Read a name starting at `from`; returns the name and the offset after it. */
const readName = (text: string, from: number): readonly [string, number] => {
  let end = from;
  while (end < text.length && !NAME_END.test(text.charAt(end))) end += 1;
  if (end === from) return fail("not_well_formed", "A name is missing", from);
  return [text.slice(from, end), end];
};

const skipSpace = (text: string, from: number): number => {
  let at = from;
  while (at < text.length && /\s/u.test(text.charAt(at))) at += 1;
  return at;
};

interface StartTag {
  readonly name: string;
  readonly attributes: RawAttribute[];
  readonly selfClosing: boolean;
  readonly next: number;
}

const readStartTag = (text: string, from: number): StartTag => {
  const [name, afterName] = readName(text, from);
  const attributes: RawAttribute[] = [];
  const seen = new Set<string>();
  let at = afterName;
  for (;;) {
    at = skipSpace(text, at);
    const ch = text.charAt(at);
    if (ch === ">")
      return { name, attributes, selfClosing: false, next: at + 1 };
    if (ch === "/") {
      if (text.charAt(at + 1) !== ">")
        return fail("not_well_formed", "A '/' is not followed by '>'", at);
      return { name, attributes, selfClosing: true, next: at + 2 };
    }
    if (at >= text.length)
      return fail("not_well_formed", "A start tag is not closed", from);
    const [attrName, afterAttr] = readName(text, at);
    at = skipSpace(text, afterAttr);
    if (text.charAt(at) !== "=")
      return fail("not_well_formed", `Attribute ${attrName} has no value`, at);
    at = skipSpace(text, at + 1);
    const quote = text.charAt(at);
    if (quote !== '"' && quote !== "'")
      return fail(
        "not_well_formed",
        `Attribute ${attrName} value is not quoted`,
        at,
      );
    const close = text.indexOf(quote, at + 1);
    if (close === -1)
      return fail("not_well_formed", "An attribute value is not closed", at);
    const raw = text.slice(at + 1, close);
    if (raw.includes("<"))
      return fail("not_well_formed", "'<' inside an attribute value", at);
    if (seen.has(attrName))
      return fail("not_well_formed", `Attribute ${attrName} repeats`, at);
    seen.add(attrName);
    attributes.push({
      name: attrName,
      value: decodeEntities(raw, at).replace(/[\t\n\r]/gu, " "),
    });
    at = close + 1;
  }
};

const splitQName = (qname: string): readonly [string | null, string] => {
  const colon = qname.indexOf(":");
  return colon === -1
    ? [null, qname]
    : [qname.slice(0, colon), qname.slice(colon + 1)];
};

const resolveName = (
  qname: string,
  scope: Scope,
  at: number,
  isAttribute: boolean,
): { readonly ns: string; readonly local: string } => {
  const [prefix, local] = splitQName(qname);
  if (prefix === null) {
    // An unprefixed attribute has no namespace; an element takes the default one.
    return {
      ns: isAttribute ? "" : canonical(lookupPrefix(scope, "") ?? ""),
      local,
    };
  }
  const ns = lookupPrefix(scope, prefix);
  if (ns === undefined)
    return fail("not_well_formed", `Prefix ${prefix} is not bound`, at);
  return { ns: canonical(ns), local };
};

const buildElement = (
  tag: StartTag,
  parent: Scope,
  at: number,
): { readonly element: XmlElement; readonly scope: Scope } => {
  let declared: Map<string, string> | undefined;
  for (const attribute of tag.attributes) {
    if (attribute.name === "xmlns") {
      declared ??= new Map();
      declared.set("", attribute.value);
    } else if (attribute.name.startsWith("xmlns:")) {
      declared ??= new Map();
      declared.set(attribute.name.slice(6), attribute.value);
    }
  }
  const scope: Scope = declared === undefined ? parent : { parent, declared };
  const name = resolveName(tag.name, scope, at, false);
  const attrs: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  for (const attribute of tag.attributes) {
    if (attribute.name === "xmlns" || attribute.name.startsWith("xmlns:"))
      continue;
    const resolved = resolveName(attribute.name, scope, at, true);
    attrs[
      resolved.ns === "" ? resolved.local : `${resolved.ns}#${resolved.local}`
    ] = attribute.value;
  }
  return {
    element: { ns: name.ns, local: name.local, attrs, children: [], text: "" },
    scope,
  };
};

/**
 * Scan one decoded XML part, calling `start` and `end` for every element in
 * document order. The element handed to `end` has its text and children.
 * Nothing is retained unless the handler keeps it.
 */
export const scanXml = (
  text: string,
  handler: XmlHandler,
  limits: XmlLimits = DEFAULT_XML_LIMITS,
  /** Keep children on their parents. A streaming scan passes false so memory stays flat. */
  retain = true,
): Result<{ readonly elements: number }, XmlProblem> => {
  try {
    const open: { element: XmlElement; scope: Scope; qname: string }[] = [];
    let elements = 0;
    let at = 0;
    let rootSeen = false;
    let rootClosed = false;
    while (at < text.length) {
      const lt = text.indexOf("<", at);
      const chunkEnd = lt === -1 ? text.length : lt;
      if (chunkEnd > at) {
        const chunk = text.slice(at, chunkEnd);
        const top = open[open.length - 1];
        if (top === undefined) {
          if (/\S/u.test(chunk))
            fail(
              "not_well_formed",
              rootClosed
                ? "Text follows the root element"
                : "Text precedes the root element",
              at,
            );
        } else {
          top.element.text += unescapeText(chunk, at);
        }
      }
      if (lt === -1) break;
      if (text.startsWith("<!--", lt)) {
        const close = text.indexOf("-->", lt + 4);
        if (close === -1)
          fail("not_well_formed", "A comment is not closed", lt);
        at = close + 3;
        continue;
      }
      if (text.startsWith("<![CDATA[", lt)) {
        const close = text.indexOf("]]>", lt + 9);
        const top = open[open.length - 1];
        if (close === -1 || top === undefined)
          fail("not_well_formed", "A CDATA section is misplaced", lt);
        else
          top.element.text += text
            .slice(lt + 9, close)
            .replace(/\r\n?/gu, "\n");
        at = close + 3;
        continue;
      }
      if (text.startsWith("<!", lt))
        fail(
          "doctype",
          "A DOCTYPE or markup declaration is not read: no entity or external resource is declared or fetched",
          lt,
        );
      if (text.startsWith("<?", lt)) {
        const close = text.indexOf("?>", lt + 2);
        if (close === -1)
          fail("not_well_formed", "A processing instruction is not closed", lt);
        at = close + 2;
        continue;
      }
      if (text.startsWith("</", lt)) {
        const [qname, afterName] = readName(text, lt + 2);
        const gt = text.indexOf(">", afterName);
        if (gt === -1 || text.slice(afterName, gt).trim() !== "")
          fail("not_well_formed", "An end tag is malformed", lt);
        const top = open.pop();
        if (top === undefined || top.qname !== qname)
          fail("not_well_formed", `End tag ${qname} does not match`, lt);
        else {
          handler.end?.(top.element);
          if (open.length === 0) rootClosed = true;
        }
        at = gt + 1;
        continue;
      }
      if (rootClosed)
        fail("not_well_formed", "A second root element follows", lt);
      const tag = readStartTag(text, lt + 1);
      elements += 1;
      if (elements > limits.maxNodes)
        fail(
          "too_many_nodes",
          `The part has more than ${String(limits.maxNodes)} elements`,
          lt,
        );
      const parentScope = open[open.length - 1]?.scope ?? ROOT_SCOPE;
      const built = buildElement(tag, parentScope, lt);
      rootSeen = true;
      if (retain) open[open.length - 1]?.element.children.push(built.element);
      handler.start?.(built.element);
      if (tag.selfClosing) {
        handler.end?.(built.element);
        if (open.length === 0) rootClosed = true;
      } else {
        if (open.length >= limits.maxDepth)
          fail(
            "too_deep",
            `Elements nest deeper than ${String(limits.maxDepth)} levels`,
            lt,
          );
        open.push({
          element: built.element,
          scope: built.scope,
          qname: tag.name,
        });
      }
      at = tag.next;
    }
    if (open.length > 0)
      fail("not_well_formed", "The part ends inside an element", text.length);
    if (!rootSeen) fail("not_well_formed", "The part has no root element", 0);
    return ok({ elements });
  } catch (cause) {
    if (cause instanceof XmlFailure) return err(cause.problem);
    throw cause;
  }
};

/** Parse a decoded part into a tree. */
export const parseXml = (
  text: string,
  limits: XmlLimits = DEFAULT_XML_LIMITS,
): Result<XmlElement, XmlProblem> => {
  let root: XmlElement | undefined;
  const result = scanXml(
    text,
    {
      start(element) {
        root ??= element;
      },
    },
    limits,
  );
  if (!result.ok) return result;
  return root === undefined
    ? err(problem("not_well_formed", "The part has no root element."))
    : ok(root);
};

/** Decode and parse one part's bytes. */
export const parseXmlBytes = (
  bytes: Uint8Array,
  limits: XmlLimits = DEFAULT_XML_LIMITS,
): Result<XmlElement, XmlProblem> => {
  const decoded = decodeXmlBytes(bytes, limits);
  return decoded.ok ? parseXml(decoded.value, limits) : decoded;
};

/** The first child with this namespace and local name. */
export const child = (
  element: XmlElement,
  ns: string,
  local: string,
): XmlElement | undefined =>
  element.children.find((entry) => entry.ns === ns && entry.local === local);

export const childrenOf = (
  element: XmlElement,
  ns: string,
  local: string,
): XmlElement[] =>
  element.children.filter((entry) => entry.ns === ns && entry.local === local);

/** An unprefixed attribute, or a prefixed one when `ns` is given. */
export const attr = (
  element: XmlElement,
  local: string,
  ns?: string,
): string | undefined =>
  element.attrs[ns === undefined ? local : `${ns}#${local}`];
