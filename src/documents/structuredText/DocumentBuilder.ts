import {
  MAX_DOCUMENT_DEPTH,
  MAX_DOCUMENT_DIAGNOSTICS,
  MAX_NODE_PATH_CHARACTERS,
  MAX_NODE_VALUE_CHARACTERS,
  type DocumentDiagnostic,
  type DocumentSegment,
  type StructuralNode,
} from "../../domain/document/structuredText.js";
import type { SourceText } from "./SourceText.js";

/** Fields a format walker supplies; the builder assigns index and source offsets. */
export interface NodeDraft {
  readonly depth: number;
  readonly kind: StructuralNode["kind"];
  readonly path: string;
  readonly name?: string | null;
  readonly value?: string | null;
  readonly fields?: readonly string[] | null;
  readonly record?: number | null;
  /** Decoded text position of the node's first character; null when the parser reports none. */
  readonly at: number | null;
  /** Decoded text position just past the node, when known. */
  readonly end?: number | null;
  readonly details?: StructuralNode["details"];
}

/** Which nodes to keep while every node is still counted. */
export interface NodeSelection {
  readonly start: number;
  readonly limit: number;
}

/** A node nested deeper than {@link MAX_DOCUMENT_DEPTH}; the walk stops there. */
export class NestingTooDeepError extends Error {
  readonly _tag = "NestingTooDeepError";

  constructor(readonly at: number | null) {
    super(
      `The document nests deeper than ${String(MAX_DOCUMENT_DEPTH)} levels; structure before that point is kept.`,
    );
  }
}

/**
 * A path cut to {@link MAX_NODE_PATH_CHARACTERS}. Walkers store parent paths
 * through this, so one long key or name is copied at most once, not into
 * every descendant.
 */
export const boundedPath = (path: string): string =>
  path.length > MAX_NODE_PATH_CHARACTERS
    ? path.slice(0, MAX_NODE_PATH_CHARACTERS)
    : path;

const cut = (value: string | null | undefined) =>
  value === null || value === undefined
    ? { value: null, value_length: null }
    : value.length > MAX_NODE_VALUE_CHARACTERS
      ? {
          value: value.slice(0, MAX_NODE_VALUE_CHARACTERS),
          value_length: value.length,
        }
      : { value, value_length: null };

/**
 * Collects one walk of a document. Every node is counted so totals are exact;
 * only the selected window is materialized, so memory follows the page size.
 */
export class DocumentBuilder {
  readonly kept: StructuralNode[] = [];
  readonly diagnostics: DocumentDiagnostic[] = [];
  diagnosticsOmitted = 0;
  errors = 0;
  count = 0;
  /** Text positions where the format's own reading units begin. */
  readonly unitStarts: number[] = [];
  unit: DocumentSegment["unit"] = "line";

  constructor(
    readonly source: SourceText,
    readonly selection: NodeSelection,
  ) {}

  /** Count a node and keep it when it falls inside the selection. */
  node(draft: NodeDraft): StructuralNode | undefined {
    if (draft.depth > MAX_DOCUMENT_DEPTH)
      throw new NestingTooDeepError(draft.at);
    const index = this.count;
    this.count += 1;
    if (
      index < this.selection.start ||
      index >= this.selection.start + this.selection.limit
    )
      return undefined;
    const node: StructuralNode = {
      index,
      depth: draft.depth,
      kind: draft.kind,
      path: boundedPath(draft.path),
      name: draft.name ?? null,
      ...cut(draft.value),
      fields:
        draft.fields === undefined || draft.fields === null
          ? null
          : draft.fields.map((field) =>
              field.length > MAX_NODE_VALUE_CHARACTERS
                ? field.slice(0, MAX_NODE_VALUE_CHARACTERS)
                : field,
            ),
      record: draft.record ?? null,
      location: draft.at === null ? null : this.source.locate(draft.at),
      end_offset:
        draft.end === null || draft.end === undefined
          ? null
          : this.source.byteOffset(draft.end),
      details: { ...draft.details },
    };
    if (draft.fields?.some((field) => field.length > MAX_NODE_VALUE_CHARACTERS))
      node.details.fields_cut = true;
    if (draft.path.length > MAX_NODE_PATH_CHARACTERS)
      node.details.path_cut = true;
    this.kept.push(node);
    return node;
  }

  /** Record a finding about the document itself, bounded in count. */
  diagnostic(
    severity: DocumentDiagnostic["severity"],
    code: string,
    message: string,
    at: number | null = null,
    record: number | null = null,
  ): void {
    if (severity === "error") this.errors += 1;
    if (this.diagnostics.length >= MAX_DOCUMENT_DIAGNOSTICS) {
      this.diagnosticsOmitted += 1;
      return;
    }
    this.diagnostics.push({
      severity,
      code,
      message,
      location: at === null ? null : this.source.locate(at),
      record,
    });
  }

  /** Set the end of a kept node once its closing position is known. */
  close(node: StructuralNode | undefined, end: number): void {
    if (node !== undefined) node.end_offset = this.source.byteOffset(end);
  }

  hasErrors(): boolean {
    return this.errors > 0;
  }
}

/** RFC 6901 JSON Pointer token. */
export const pointerToken = (key: string | number): string =>
  String(key).replaceAll("~", "~0").replaceAll("/", "~1");
