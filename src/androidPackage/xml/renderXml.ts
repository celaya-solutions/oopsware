import {
  attributeText,
  isReference,
  type AndroidXmlAttribute,
  type AndroidXmlDocument,
  type AndroidXmlElement,
} from "./androidXml.js";

/**
 * Readable, deterministic XML text for a decoded compiled document. Typed
 * primitives keep aapt2's rendering, references name their target when the
 * caller can resolve it, and whitespace-only text between elements is
 * dropped. The output is for reading, not for recompiling.
 */

const escapeText = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const escapeAttribute = (text: string): string =>
  escapeText(text)
    .replaceAll('"', "&quot;")
    .replaceAll("\n", "&#10;")
    .replaceAll("\r", "&#13;")
    .replaceAll("\t", "&#9;");

type Resolver = (id: number) => string | null;

class Scope {
  readonly #prefixes: Map<string, string>[] = [new Map()];
  #generated = 0;

  /** Declare an element's namespaces; returns extra declarations needed for undeclared URIs. */
  enter(element: AndroidXmlElement): { prefix: string; uri: string }[] {
    const own = new Map<string, string>();
    for (const { prefix, uri } of element.namespaces) own.set(uri, prefix);
    this.#prefixes.push(own);
    const extra: { prefix: string; uri: string }[] = [];
    const uris = [
      element.namespace,
      ...element.attributes.map((attribute) => attribute.namespace),
    ];
    for (const uri of uris)
      if (uri !== null && this.prefix(uri) === null) {
        const prefix = `ns${String(this.#generated)}`;
        this.#generated += 1;
        own.set(uri, prefix);
        extra.push({ prefix, uri });
      }
    return extra;
  }

  leave(): void {
    this.#prefixes.pop();
  }

  prefix(uri: string): string | null {
    for (let index = this.#prefixes.length - 1; index >= 0; index -= 1) {
      const prefix = this.#prefixes[index]?.get(uri);
      if (prefix !== undefined) return prefix;
    }
    return null;
  }

  qualify(uri: string | null, name: string): string {
    if (uri === null) return name;
    const prefix = this.prefix(uri);
    return prefix === null || prefix === "" ? name : `${prefix}:${name}`;
  }
}

const referenceText = (
  attribute: AndroidXmlAttribute,
  resolveName: Resolver | undefined,
): string | null => {
  const value = attribute.value;
  if (value === null || !isReference(value)) return null;
  const name =
    value.data === null || value.data === 0
      ? null
      : (resolveName?.(value.data) ?? null);
  if (name === null) return value.text;
  return `${value.type.endsWith("attribute") ? "?" : "@"}${name}`;
};

const attributeValue = (
  attribute: AndroidXmlAttribute,
  resolveName: Resolver | undefined,
): string => {
  const reference = referenceText(attribute, resolveName);
  if (reference !== null) return reference;
  const value = attribute.value;
  if (value !== null && value.type !== "string") return value.text;
  return attributeText(attribute) ?? value?.text ?? "";
};

class Renderer {
  readonly lines = ['<?xml version="1.0" encoding="utf-8"?>'];
  readonly scope = new Scope();

  constructor(readonly resolveName: Resolver | undefined) {}

  openTag(element: AndroidXmlElement, indent: string): string {
    const extra = this.scope.enter(element);
    const parts = [
      ...[...element.namespaces, ...extra].map(({ prefix, uri }) =>
        prefix === ""
          ? `xmlns="${escapeAttribute(uri)}"`
          : `xmlns:${prefix}="${escapeAttribute(uri)}"`,
      ),
      ...element.attributes.map(
        (attribute) =>
          `${this.scope.qualify(attribute.namespace, attribute.name)}="${escapeAttribute(attributeValue(attribute, this.resolveName))}"`,
      ),
    ];
    const name = this.scope.qualify(element.namespace, element.name);
    if (parts.length <= 1) return `${indent}<${[name, ...parts].join(" ")}`;
    return `${indent}<${name}\n${parts.map((part) => `${indent}    ${part}`).join("\n")}`;
  }

  element(element: AndroidXmlElement, depth: number): void {
    const indent = "  ".repeat(depth);
    const tag = this.openTag(element, indent);
    const name = this.scope.qualify(element.namespace, element.name);
    const hasElements = element.children.some(
      (child) => child.kind === "element",
    );
    if (!hasElements) {
      const text = element.children
        .map((child) => (child.kind === "text" ? escapeText(child.text) : ""))
        .join("");
      this.lines.push(text === "" ? `${tag} />` : `${tag}>${text}</${name}>`);
    } else {
      this.lines.push(`${tag}>`);
      for (const child of element.children)
        if (child.kind === "element") this.element(child, depth + 1);
        else if (child.text.trim() !== "")
          this.lines.push(
            `${"  ".repeat(depth + 1)}${escapeText(child.text.trim())}`,
          );
      this.lines.push(`${indent}</${name}>`);
    }
    this.scope.leave();
  }
}

/**
 * Render a decoded document as XML text. `resolveName` maps a resource id
 * to "type/name" (for example "string/app_name"); unresolved references
 * keep aapt2's "@0x7f040000" form.
 */
export const renderAndroidXml = (
  doc: AndroidXmlDocument,
  resolveName?: (id: number) => string | null,
): string => {
  const renderer = new Renderer(resolveName);
  renderer.element(doc.root, 0);
  return `${renderer.lines.join("\n")}\n`;
};
