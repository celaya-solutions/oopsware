import { DOMParser, type Element, ParseError } from "@xmldom/xmldom";

import { err, ok, type Result } from "../../domain/result.js";

export type AppxXmlProblemCode =
  | "too_large"
  | "not_utf8"
  | "doctype"
  | "too_many_nodes"
  | "not_well_formed"
  | "unexpected_root";

/** Why an AppX XML part was not read; nothing in it was fetched or expanded. */
export interface AppxXmlProblem {
  readonly code: AppxXmlProblemCode;
  readonly message: string;
}

export interface AppxXmlLimits {
  readonly max_bytes: number;
  /** Upper bound on `<` characters: every element, comment and instruction starts with one. */
  readonly max_markup: number;
}

export interface AppxRoot {
  readonly namespace: string;
  readonly name: string;
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });

const firstLine = (message: string): string =>
  message.split("\n")[0] ?? message;

const problem = (
  code: AppxXmlProblemCode,
  message: string,
): Result<never, AppxXmlProblem> => err({ code, message });

/**
 * Parse one AppX/MSIX XML part with xmldom. The parts are UTF-8 by schema;
 * any DOCTYPE is refused before parsing (the schemas allow none), so no
 * entity is declared, expanded or fetched. Errors xmldom would recover from
 * (an undefined entity, a mismatched prefix) are treated as not well-formed.
 */
export const parseAppxXml = (
  bytes: Uint8Array,
  what: string,
  limits: AppxXmlLimits,
  roots: readonly AppxRoot[],
): Result<{ root: Element; warnings: string[] }, AppxXmlProblem> => {
  if (bytes.length > limits.max_bytes)
    return problem(
      "too_large",
      `${what} is ${String(bytes.length)} bytes; this reader parses at most ${String(limits.max_bytes)}.`,
    );
  let text: string;
  try {
    // TextDecoder drops a leading UTF-8 byte order mark.
    text = UTF8.decode(bytes);
  } catch {
    return problem("not_utf8", `${what} is not valid UTF-8.`);
  }
  if (/<!DOCTYPE/iu.test(text))
    return problem(
      "doctype",
      `${what} contains a DOCTYPE; it is refused unparsed, so no entity is expanded or fetched.`,
    );
  let markup = 0;
  for (let at = text.indexOf("<"); at >= 0; at = text.indexOf("<", at + 1))
    if (++markup > limits.max_markup)
      return problem(
        "too_many_nodes",
        `${what} has more than ${String(limits.max_markup)} markup items.`,
      );
  const warnings: string[] = [];
  let root: Element | null;
  try {
    root = new DOMParser({
      onError: (level, message) => {
        if (level === "warning") warnings.push(firstLine(message));
        // Thrown from onError, xmldom stops and raises a ParseError.
        else throw new Error(firstLine(message));
      },
    }).parseFromString(text, "text/xml").documentElement;
  } catch (cause) {
    if (!(cause instanceof ParseError)) throw cause;
    return problem(
      "not_well_formed",
      `${what} is not well-formed XML: ${firstLine(cause.message)}`,
    );
  }
  const expected = roots
    .map((entry) => `{${entry.namespace}}${entry.name}`)
    .join(" or ");
  if (
    root === null ||
    !roots.some(
      (entry) =>
        root?.namespaceURI === entry.namespace && root.localName === entry.name,
    )
  )
    return problem(
      "unexpected_root",
      `${what}'s root is ${root === null ? "missing" : `{${root.namespaceURI ?? ""}}${root.localName ?? root.nodeName}`}; ${expected} was expected.`,
    );
  return ok({ root, warnings });
};

/** Direct child elements, optionally only those with `name` as local name. */
export const elements = (parent: Element, name?: string): Element[] =>
  Array.from(parent.children).filter(
    (child) => name === undefined || child.localName === name,
  );

export const element = (parent: Element, name: string): Element | null =>
  elements(parent, name)[0] ?? null;

/** An attribute by local name: the unprefixed one first, else one in any namespace (uap:Scale). */
export const attribute = (node: Element, name: string): string | null => {
  const plain = node.getAttributeNode(name);
  if (plain !== null) return plain.value;
  for (const item of Array.from(node.attributes))
    if (item.localName === name && item.namespaceURI !== null)
      return item.value;
  return null;
};

/** Trimmed text of a child element, or null when the child is absent. */
export const childText = (parent: Element, name: string): string | null => {
  const child = element(parent, name);
  return child === null ? null : (child.textContent ?? "").trim();
};

/** An xs:boolean value; null (with a problem) for anything else. */
export const xsBoolean = (
  value: string | null,
  what: string,
  problems: string[],
): boolean | null => {
  if (value === null) return null;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  problems.push(`${what} is "${value}", not an xs:boolean.`);
  return null;
};

/** An unsigned decimal integer attribute; null (with a problem) when absent or not a safe integer. */
export const unsigned = (
  value: string | null,
  what: string,
  problems: string[],
): number | null => {
  if (value === null) return null;
  const number = /^\d+$/u.test(value) ? Number(value) : Number.NaN;
  if (Number.isSafeInteger(number)) return number;
  problems.push(`${what} is "${value}", not an unsigned integer.`);
  return null;
};

/** The schema's Identity element: Name, Publisher, Version and, for packages, architecture and resource ID. */
export interface AppxIdentity {
  readonly name: string | null;
  readonly publisher: string | null;
  readonly version: string | null;
  readonly processor_architecture: string | null;
  readonly resource_id: string | null;
}

export const readIdentity = (
  parent: Element,
  problems: string[],
): AppxIdentity | null => {
  const identity = element(parent, "Identity");
  if (identity === null) {
    problems.push("There is no Identity element.");
    return null;
  }
  const read = (name: string) => attribute(identity, name);
  for (const required of ["Name", "Publisher", "Version"])
    if (read(required) === null)
      problems.push(`Identity has no ${required} attribute.`);
  return {
    name: read("Name"),
    publisher: read("Publisher"),
    version: read("Version"),
    processor_architecture: read("ProcessorArchitecture"),
    resource_id: read("ResourceId"),
  };
};

export interface AppxResource {
  readonly language: string | null;
  readonly scale: string | null;
  readonly dx_feature_level: string | null;
}

/** Resource qualifiers; Scale and DXFeatureLevel may sit in an extension namespace. */
export const readResources = (parent: Element): AppxResource[] => {
  const resources = element(parent, "Resources");
  return resources === null
    ? []
    : elements(resources, "Resource").map((resource) => ({
        language: attribute(resource, "Language"),
        scale: attribute(resource, "Scale"),
        dx_feature_level: attribute(resource, "DXFeatureLevel"),
      }));
};

export interface AppxDeviceFamily {
  readonly name: string | null;
  readonly min_version: string | null;
  readonly max_version_tested: string | null;
}

/** TargetDeviceFamily elements of a Dependencies element (any namespace, as bundles use b4:). */
export const readDeviceFamilies = (
  dependencies: Element | null,
): AppxDeviceFamily[] =>
  dependencies === null
    ? []
    : elements(dependencies, "TargetDeviceFamily").map((family) => ({
        name: attribute(family, "Name"),
        min_version: attribute(family, "MinVersion"),
        max_version_tested: attribute(family, "MaxVersionTested"),
      }));
