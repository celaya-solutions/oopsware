import { parseOpenStep } from "plist";

import { decodeXmlPropertyList } from "./propertyListXml.js";
import {
  createPlistNumberCollector,
  type PlistNumberLiterals,
} from "./apple/plistNumbers.js";
import { UnknownPlistScalar } from "./apple/unknownPlistScalar.js";

import { MAX_PLIST_DEPTH } from "./apple/plistValue.js";

/** The dictionary key Oopsware results cannot carry: validation strips it. */
const PROTOTYPE_KEY = "__proto__";

/** A decoded plist without `__proto__` entries, and how many were omitted. */
export interface PropertyListWithoutPrototypeKeys {
  readonly value: unknown;
  readonly omittedPrototypeKeys: number;
}

/** Value and numeric facts decoded together; OpenStep numeric facts remain unknown. */
export interface ParsedPropertyList extends PropertyListWithoutPrototypeKeys {
  readonly numberLiterals: PlistNumberLiterals;
}

/** Limitation for results whose source plist held `__proto__` entries. */
export const omittedPrototypeKeysLimitation = (count: number | null): string =>
  count === null
    ? "Dictionary entries keyed __proto__ were omitted because Oopsware results cannot represent that key."
    : `${String(count)} dictionary ${count === 1 ? "entry" : "entries"} keyed __proto__ ${count === 1 ? "was" : "were"} omitted because Oopsware results cannot represent that key.`;

/** Remove own `__proto__` entries, such as JSON.parse creates, and count them. */
export const omitPrototypeKeys = (
  value: unknown,
): PropertyListWithoutPrototypeKeys => {
  let omitted = 0;
  const strip = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(strip);
    if (
      item === null ||
      typeof item !== "object" ||
      item instanceof Date ||
      item instanceof Uint8Array ||
      item instanceof UnknownPlistScalar
    )
      return item;
    return Object.fromEntries(
      Object.entries(item).flatMap(([name, entry]) => {
        if (name !== PROTOTYPE_KEY) return [[name, strip(entry)]];
        omitted += 1;
        return [];
      }),
    );
  };
  const stripped = strip(value);
  return { value: stripped, omittedPrototypeKeys: omitted };
};

/**
 * Decode one validated XML DOM into values and numeric source facts.
 * Entries keyed `__proto__` are omitted and counted at the same boundary.
 */
export const parseXmlPropertyList = (text: string): ParsedPropertyList => {
  // Preserve the pinned decoder's existing OpenStep autodetection, also used
  // by app Info.plist resolution.
  const first = text.trimStart()[0];
  if (first === "{" || first === "(") {
    // The pinned decoder assigns a `__proto__` key to the object prototype, so
    // the entry is gone before the decoded value can be counted. Count keys in
    // the source instead; the rebuild still drops any prototype it replaced.
    const prototypeKeys = scanOpenStep(text);
    return {
      value: omitPrototypeKeys(parseOpenStep(text)).value,
      numberLiterals: createPlistNumberCollector().result(true),
      omittedPrototypeKeys: prototypeKeys,
    };
  }
  const decoded = decodeXmlPropertyList(text);
  return {
    ...omitPrototypeKeys(decoded.value),
    numberLiterals: decoded.numberLiterals,
  };
};

interface OpenStepContainer {
  end: string;
  next: "key" | "equals" | "value" | "separator" | "after-value";
  /** Source offset of a container that is itself a dictionary key. */
  keyStart?: number;
}

/** Consume only the punctuation expected between the pinned decoder's values. */
const consumeOpenStepSeparator = (
  parent: OpenStepContainer | undefined,
  character: string,
): "consumed" | "invalid" | "none" => {
  if (parent?.next === "after-value") {
    parent.next = "key";
    return character === ";" ? "consumed" : "none";
  }
  if (parent?.next !== "equals" && parent?.next !== "separator") return "none";
  if (character !== (parent.next === "equals" ? "=" : ",")) return "invalid";
  parent.next = "value";
  return "consumed";
};

/** An array may close after a comma; a dictionary still needs its assigned value. */
const admitsOpenStepCloser = (
  parent: OpenStepContainer | undefined,
  character: string,
): boolean =>
  parent?.end === character &&
  parent.next !== "equals" &&
  !(parent.end === "}" && parent.next === "value");

/**
 * Bound OpenStep value nesting before the pinned decoder recursively reads it,
 * and count the dictionary keys that decode to `__proto__`.
 */
const scanOpenStep = (text: string): number => {
  let prototypeKeys = 0;
  const containers: OpenStepContainer[] = [];
  const completeValue = (): void => {
    const parent = containers.at(-1);
    if (parent !== undefined)
      parent.next =
        parent.next === "key"
          ? "equals"
          : parent.end === "}"
            ? "after-value"
            : "separator";
  };
  const assertDepth = (): void => {
    if (containers.length > MAX_PLIST_DEPTH)
      throw new RangeError(
        `Plist exceeds ${String(MAX_PLIST_DEPTH)} nesting levels`,
      );
  };
  let cursor = 0;
  while (cursor < text.length) {
    const afterTrivia = skipOpenStepTrivia(text, cursor);
    if (afterTrivia !== cursor) {
      cursor = afterTrivia;
      continue;
    }
    const character = text[cursor] ?? "";
    const parent = containers.at(-1);
    // Stop at the first impossible token: only the pinned decoder owns syntax
    // diagnostics. A later deep suffix cannot change that failure into a limit.
    if (character === "}" || character === ")") {
      if (!admitsOpenStepCloser(parent, character)) return prototypeKeys;
      const closed = containers.pop();
      if (
        closed?.keyStart !== undefined &&
        isOpenStepPrototypeKey(text.slice(closed.keyStart, cursor + 1))
      )
        prototypeKeys += 1;
      // parseOpenStep returns the first root value without reading trailing text.
      if (containers.length === 0) return prototypeKeys;
      completeValue();
      cursor += 1;
      continue;
    }
    const separator = consumeOpenStepSeparator(parent, character);
    if (separator === "invalid") return prototypeKeys;
    if (separator === "consumed") {
      cursor += 1;
      continue;
    }
    if (character === "{" || character === "(") {
      assertDepth();
      containers.push({
        end: character === "{" ? "}" : ")",
        next: character === "{" ? "key" : "value",
        // A compound key is coerced to a string, e.g. `(__proto__)`.
        ...(parent?.next === "key" ? { keyStart: cursor } : {}),
      });
      cursor += 1;
      continue;
    }
    const end = skipOpenStepScalar(text, cursor);
    if (end === cursor) return prototypeKeys;
    if (parent?.next === "key") {
      if (isOpenStepPrototypeKey(text.slice(cursor, end))) prototypeKeys += 1;
    } else assertDepth();
    cursor = end;
    completeValue();
  }
  return prototypeKeys;
};

/**
 * Whether one OpenStep key, scalar or compound, becomes the property name
 * `__proto__` when the decoder assigns `obj[key]`. Plain strings compare
 * directly; any other key is decoded by the pinned decoder itself and
 * coerced to a property name the same way that assignment does.
 */
const isOpenStepPrototypeKey = (token: string): boolean => {
  if (!/^["({<]/u.test(token)) return token === PROTOTYPE_KEY;
  if (token.startsWith('"') && !token.includes("\\"))
    return token === `"${PROTOTYPE_KEY}"`;
  try {
    return String(parseOpenStep(token)) === PROTOTYPE_KEY;
  } catch {
    // An unterminated token is the decoder's syntax error to report.
    return false;
  }
};

/** Skip grammar trivia without interpreting delimiter examples inside comments. */
const skipOpenStepTrivia = (text: string, cursor: number): number => {
  if (/\s/u.test(text[cursor] ?? "")) return cursor + 1;
  if (!text.startsWith("//", cursor) && !text.startsWith("/*", cursor))
    return cursor;
  const line = text[cursor + 1] === "/";
  const end = text.indexOf(line ? "\n" : "*/", cursor + 2);
  return end === -1 ? text.length : end + (line ? 1 : 2);
};

/** Read the extent of one opaque scalar; the pinned decoder still owns its value. */
const skipOpenStepScalar = (text: string, start: number): number => {
  let cursor = start;
  const character = text[cursor];
  if (character === '"') {
    cursor += 1;
    while (cursor < text.length) {
      const next = text[cursor];
      cursor += next === "\\" ? 2 : 1;
      if (next === '"') break;
    }
  } else if (character === "<") {
    const end = text.indexOf(">", cursor + 1);
    cursor = end === -1 ? text.length : end + 1;
  } else {
    // Match the pinned OpenStep decoder's unquoted-string alphabet. Other
    // syntax remains for the decoder to reject; preflight only owns depth.
    while (
      cursor < text.length &&
      /[a-zA-Z0-9._/$:-]/u.test(text[cursor] ?? "")
    )
      cursor += 1;
  }
  return cursor;
};
