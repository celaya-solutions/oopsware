import { printParseErrorCode, visit, type JSONVisitor } from "jsonc-parser";

import type { StructuralNode } from "../../domain/document/structuredText.js";
import {
  boundedPath,
  NestingTooDeepError,
  pointerToken,
  type DocumentBuilder,
} from "./DocumentBuilder.js";

interface Frame {
  readonly kind: "object" | "array";
  readonly pointer: string;
  readonly node: StructuralNode | undefined;
  readonly keys: Set<string>;
  key: string | null;
  children: number;
}

/** Where one JSON text sits inside the document. */
interface JsonSpan {
  readonly text: string;
  /** Decoded text position of the span's first character. */
  readonly base: number;
  readonly depth: number;
  /** JSON Lines record number, or null for a whole JSON document. */
  readonly record: number | null;
}

/** Whether a JSON number literal survives a round trip through a float64. */
const float64Exact = (raw: string): boolean | null => {
  if (!/^-?\d+$/u.test(raw)) return null;
  try {
    return BigInt(raw) === BigInt(Number(raw));
  } catch {
    return null;
  }
};

const literalKind = (value: unknown): StructuralNode["kind"] =>
  value === null
    ? "null"
    : typeof value === "boolean"
      ? "boolean"
      : typeof value === "number"
        ? "number"
        : "string";

/** Keys and pointers quoted in messages stay short; nodes carry the full text. */
const shortened = (text: string) =>
  text.length > 200 ? `${text.slice(0, 200)}…` : text;

/** Position of a JSON.parse failure from its message, or the end of the text. */
const parseFailure = (text: string, cause: unknown) => {
  const message = cause instanceof Error ? cause.message : "Invalid JSON";
  const position = /\bposition (\d+)/u.exec(message)?.[1];
  return {
    offset: position === undefined ? text.length : Number(position),
    message,
  };
};

/** One visitor pass over a JSON text, emitting nodes without building values. */
class JsonWalk {
  readonly #stack: Frame[] = [];
  firstError: { offset: number; message: string } | undefined;
  roots = 0;

  constructor(
    readonly builder: DocumentBuilder,
    readonly span: JsonSpan,
  ) {}

  /** Path, name and depth of the value that begins next. */
  #slot() {
    const { depth } = this.span;
    const parent = this.#stack.at(-1);
    if (parent === undefined) {
      this.roots += 1;
      return { path: "", name: null, depth };
    }
    parent.children += 1;
    const nested = depth + this.#stack.length;
    if (parent.kind === "array")
      return {
        path: `${parent.pointer}/${String(parent.children - 1)}`,
        name: null,
        depth: nested,
      };
    const key = parent.key ?? "";
    return {
      path: `${parent.pointer}/${pointerToken(key)}`,
      name: key,
      depth: nested,
    };
  }

  #open(kind: "object" | "array", offset: number) {
    const position = this.#slot();
    const node = this.builder.node({
      ...position,
      kind,
      record: this.span.record,
      at: this.span.base + offset,
      details: { children: 0 },
    });
    this.#stack.push({
      kind,
      pointer: boundedPath(position.path),
      node,
      keys: new Set(),
      key: null,
      children: 0,
    });
  }

  #close(offset: number, length: number) {
    const frame = this.#stack.pop();
    if (frame === undefined) return;
    this.builder.close(frame.node, this.span.base + offset + length);
    if (frame.node !== undefined) frame.node.details.children = frame.children;
  }

  #property(property: string, offset: number) {
    const frame = this.#stack.at(-1);
    if (frame === undefined) return;
    if (frame.keys.has(property))
      this.builder.diagnostic(
        "warning",
        "json_duplicate_key",
        `Duplicate key "${shortened(property)}" in ${shortened(frame.pointer) || "the root object"}; every occurrence is listed, while most JSON readers keep only the last.`,
        this.span.base + offset,
        this.span.record,
      );
    frame.keys.add(property);
    frame.key = property;
  }

  #literal(value: unknown, offset: number, length: number) {
    const raw = this.span.text.slice(offset, offset + length);
    const kind = literalKind(value);
    this.builder.node({
      ...this.#slot(),
      kind,
      value: kind === "string" ? String(value) : raw,
      record: this.span.record,
      at: this.span.base + offset,
      end: this.span.base + offset + length,
      details:
        kind === "number"
          ? { source: raw, float64_exact: float64Exact(raw) }
          : kind === "string"
            ? { source_length: length }
            : {},
    });
  }

  visitor(): JSONVisitor {
    return {
      onObjectBegin: (offset) => this.#open("object", offset),
      onArrayBegin: (offset) => this.#open("array", offset),
      onObjectEnd: (offset, length) => this.#close(offset, length),
      onArrayEnd: (offset, length) => this.#close(offset, length),
      onObjectProperty: (property: string, offset) =>
        this.#property(property, offset),
      onLiteralValue: (value: unknown, offset, length) =>
        this.#literal(value, offset, length),
      onError: (error, offset) => {
        this.firstError ??= { offset, message: printParseErrorCode(error) };
      },
    };
  }
}

/**
 * Walk one JSON text without building its value. Numbers keep their exact
 * source text; duplicate keys are reported and every occurrence is listed.
 * Returns whether the text is a complete, valid JSON value.
 */
export const walkJsonValue = (
  builder: DocumentBuilder,
  span: JsonSpan,
): boolean => {
  const pass = new JsonWalk(builder, span);
  visit(span.text, pass.visitor(), {
    disallowComments: true,
    allowTrailingComma: false,
    allowEmptyContent: false,
  });
  let failure = pass.firstError;
  if (failure === undefined)
    // The tolerant visitor is cross-checked by the strict platform parser.
    try {
      JSON.parse(span.text);
    } catch (cause) {
      failure = parseFailure(span.text, cause);
    }
  if (failure !== undefined) {
    builder.diagnostic(
      "error",
      "json_syntax",
      `Invalid JSON (${failure.message}); structure before this point is kept.`,
      span.base + failure.offset,
      span.record,
    );
    return false;
  }
  return pass.roots === 1;
};

/** A whole JSON document. */
export const walkJson = (builder: DocumentBuilder): boolean => {
  builder.unit = "line";
  return walkJsonValue(builder, {
    text: builder.source.text,
    base: 0,
    depth: 0,
    record: null,
  });
};

/** One JSON Lines record; a record nested too deeply fails alone. */
const walkRecord = (builder: DocumentBuilder, span: JsonSpan): boolean => {
  try {
    return walkJsonValue(builder, span);
  } catch (cause) {
    if (!(cause instanceof NestingTooDeepError || cause instanceof RangeError))
      throw cause;
    builder.diagnostic(
      "error",
      "nesting_too_deep",
      cause instanceof NestingTooDeepError
        ? cause.message
        : "The record nests deeper than the parser's call stack allows; structure before that point is kept.",
      span.base,
      span.record,
    );
    return false;
  }
};

/** JSON Lines: each line is an independent value; bad records do not hide good ones. */
export const walkJsonLines = (
  builder: DocumentBuilder,
): { readonly records: number; readonly failed: number[] } => {
  builder.unit = "record";
  const { text, lineStarts } = builder.source;
  let records = 0;
  const failed: number[] = [];
  for (const [line, start] of lineStarts.entries()) {
    const next = lineStarts[line + 1] ?? text.length;
    let end = next;
    while (end > start && /[\r\n]/u.test(text[end - 1] ?? "")) end -= 1;
    const content = text.slice(start, end);
    if (content.trim() === "") {
      if (next < text.length || content !== "")
        builder.diagnostic(
          "warning",
          "jsonl_blank_line",
          `Line ${String(line + 1)} is blank and holds no record.`,
          start,
        );
      continue;
    }
    records += 1;
    builder.unitStarts.push(start);
    const recordNode = builder.node({
      depth: 0,
      kind: "record",
      path: `#${String(records)}`,
      record: records,
      at: start,
      end,
      details: { line: line + 1 },
    });
    const valid = walkRecord(builder, {
      text: content,
      base: start,
      depth: 1,
      record: records,
    });
    if (recordNode !== undefined) recordNode.details.valid = valid;
    if (!valid) failed.push(records);
  }
  return { records, failed };
};
