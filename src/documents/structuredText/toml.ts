import { parse, TomlDate, TomlError } from "smol-toml";

import type { StructuralNode } from "../../domain/document/structuredText.js";
import {
  boundedPath,
  pointerToken,
  type DocumentBuilder,
} from "./DocumentBuilder.js";

interface Pending {
  readonly value: unknown;
  readonly path: string;
  readonly name: string | null;
  readonly depth: number;
}

const dateKind = (value: TomlDate): StructuralNode["kind"] =>
  value.isDateTime()
    ? value.isLocal()
      ? "local-datetime"
      : "offset-datetime"
    : value.isDate()
      ? "local-date"
      : "local-time";

/**
 * Walk a TOML document with its type and date semantics. smol-toml reports
 * error locations but not value locations, so value nodes carry none.
 */
export const walkToml = (builder: DocumentBuilder): boolean => {
  builder.unit = "line";
  const { text } = builder.source;
  let table: Record<string, unknown>;
  try {
    table = parse(text, {
      integersAsBigInt: true,
      unsafeKeyBehaviour: "keep",
    });
  } catch (cause) {
    if (!(cause instanceof TomlError)) throw cause;
    builder.diagnostic(
      "error",
      "toml_syntax",
      `Invalid TOML: ${cause.message.split("\n")[0] ?? cause.message}`,
      builder.source.indexOf(cause.line, cause.column),
    );
    return false;
  }
  const stack: Pending[] = [{ value: table, path: "", name: null, depth: 0 }];
  while (stack.length > 0) {
    const item = stack.pop();
    if (item === undefined) continue;
    const { value } = item;
    const common = {
      depth: item.depth,
      path: item.path,
      name: item.name,
      at: null,
    };
    if (value instanceof TomlDate) {
      builder.node({
        ...common,
        kind: dateKind(value),
        value: value.toISOString(),
        details: { normalized: true },
      });
    } else if (Array.isArray(value)) {
      builder.node({
        ...common,
        kind: "array",
        details: { children: value.length },
      });
      // Pushed in a loop, not spread: an array may exceed a call's argument limit.
      for (let index = value.length - 1; index >= 0; index -= 1)
        stack.push({
          value: value[index] as unknown,
          path: boundedPath(`${item.path}/${String(index)}`),
          name: null,
          depth: item.depth + 1,
        });
    } else if (typeof value === "object" && value !== null) {
      const entries = Object.entries(value);
      builder.node({
        ...common,
        kind: "table",
        details: { children: entries.length },
      });
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const [key, child] = entries[index] as [string, unknown];
        stack.push({
          value: child,
          path: boundedPath(`${item.path}/${pointerToken(key)}`),
          name: key,
          depth: item.depth + 1,
        });
      }
    } else if (typeof value === "bigint")
      builder.node({ ...common, kind: "integer", value: value.toString() });
    else if (typeof value === "number")
      builder.node({
        ...common,
        kind: "float",
        value: String(value),
        details: { normalized: true },
      });
    else if (typeof value === "boolean")
      builder.node({ ...common, kind: "boolean", value: String(value) });
    else builder.node({ ...common, kind: "string", value: String(value) });
  }
  return true;
};
