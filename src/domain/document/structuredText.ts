import { z } from "zod";

import { facetCoverageSchema } from "../formatRegistry.js";

/**
 * Structured-text reading (format expansion F11). Parsing never rewrites the
 * original bytes: every node keeps its source location, values that a parser
 * normalizes say so, and failures stay explicit instead of becoming an empty
 * result.
 */

/** Registry profiles this reader parses. */
export const STRUCTURED_TEXT_FORMATS = [
  "markdown",
  "json",
  "jsonl",
  "yaml",
  "toml",
  "xml",
  "csv",
  "tsv",
  "plain-text",
] as const;
export const structuredTextFormatSchema = z.enum(STRUCTURED_TEXT_FORMATS);
export type StructuredTextFormat = z.infer<typeof structuredTextFormatSchema>;

/** Decodings a caller may choose; the reader never guesses beyond a BOM or XML declaration. */
export const TEXT_ENCODINGS = [
  "utf-8",
  "utf-16le",
  "utf-16be",
  "windows-1252",
] as const;
export const textEncodingSchema = z.enum(TEXT_ENCODINGS);
export type TextEncoding = z.infer<typeof textEncodingSchema>;

/** Largest page of structural nodes one call returns. */
export const MAX_DOCUMENT_PAGE_NODES = 2000;
/** Default and maximum bytes read for one local document. */
export const DEFAULT_DOCUMENT_FILE_BYTES = 64 * 1024 ** 2;
export const MAX_DOCUMENT_FILE_BYTES = 256 * 1024 ** 2;
/** Node values longer than this are cut; the node states the full length. */
export const MAX_NODE_VALUE_CHARACTERS = 4096;
/** Node paths longer than this are cut and marked `path_cut`, so long keys cannot multiply into every descendant. */
export const MAX_NODE_PATH_CHARACTERS = 1024;
/** Structure nested deeper than this is reported, not walked; it bounds path length and parser stacks. */
export const MAX_DOCUMENT_DEPTH = 1000;
/** Diagnostics beyond this count are counted, not listed. */
export const MAX_DOCUMENT_DIAGNOSTICS = 200;
/** Undecodable byte ranges beyond this count are counted, not listed. */
export const MAX_LISTED_UNDECODABLE = 100;

const DELIMITED: readonly StructuredTextFormat[] = ["csv", "tsv"];

/** One caller-selected local document and the page of its structure to return. */
export const inspectDocumentInputSchema = z
  .strictObject({
    path: z
      .string()
      .min(1)
      .describe("Absolute path to a caller-selected local text document"),
    format: structuredTextFormatSchema
      .optional()
      .describe(
        "Parse as this profile instead of the one the name suffix suggests; the parser still validates the bytes",
      ),
    encoding: textEncodingSchema
      .optional()
      .describe(
        "Decode with this encoding instead of a byte-order mark, XML declaration or the UTF-8 default",
      ),
    delimiter: z
      .string()
      .length(1)
      .optional()
      .describe(
        "CSV/TSV field delimiter; defaults to comma for CSV and tab for TSV",
      ),
    start: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("Index of the first structural node to return"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_DOCUMENT_PAGE_NODES)
      .default(500)
      .describe("Maximum structural nodes to return in this page"),
    max_file_bytes: z
      .number()
      .int()
      .min(1)
      .max(MAX_DOCUMENT_FILE_BYTES)
      .default(DEFAULT_DOCUMENT_FILE_BYTES)
      .describe(
        "Maximum stable bytes to read and parse in process (default 64 MiB)",
      ),
  })
  .superRefine((input, context) => {
    if (input.delimiter === undefined) return;
    if (input.format !== undefined && !DELIMITED.includes(input.format))
      context.addIssue({
        code: "custom",
        path: ["delimiter"],
        message: "A delimiter applies only to the csv or tsv format.",
      });
    if (/["\r\n]/u.test(input.delimiter))
      context.addIssue({
        code: "custom",
        path: ["delimiter"],
        message:
          "The delimiter cannot be a double quote, carriage return or line feed.",
      });
  });
export type InspectDocumentInput = z.infer<typeof inspectDocumentInputSchema>;

/** A position in the original bytes: 1-based line and column, 0-based byte offset. */
export const sourceLocationSchema = z.strictObject({
  line: z.number().int().min(1),
  /** 1-based UTF-16 code unit within the decoded line. */
  column: z.number().int().min(1),
  offset: z.number().int().min(0),
});
export type SourceLocation = z.infer<typeof sourceLocationSchema>;

export const structuralNodeKindSchema = z.enum([
  // JSON and JSON Lines
  "record",
  "object",
  "array",
  "string",
  "number",
  "boolean",
  "null",
  // YAML
  "document",
  "mapping",
  "sequence",
  "scalar",
  "alias",
  // TOML
  "table",
  "integer",
  "float",
  "offset-datetime",
  "local-datetime",
  "local-date",
  "local-time",
  // XML
  "declaration",
  "doctype",
  "element",
  "attribute",
  "text",
  "cdata",
  "comment",
  "processing-instruction",
  // CSV/TSV
  "row",
  // Markdown
  "heading",
  "paragraph",
  "list",
  "code-block",
  "blockquote",
  "markdown-table",
  "thematic-break",
  "link",
  "image",
  // Plain text
  "line",
]);

const detailValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/** One parsed structure in source order with where it came from. */
export const structuralNodeSchema = z.strictObject({
  /** Pre-order position across the whole document. */
  index: z.number().int().min(0),
  depth: z.number().int().min(0),
  kind: structuralNodeKindSchema,
  /** JSON Pointer for data formats, XPath-like for XML, heading trail for Markdown. */
  path: z.string(),
  /** Key, element/attribute name, heading text or link text. */
  name: z.string().nullable(),
  /** Source text of a scalar, or its decoded text where the format defines one. */
  value: z.string().nullable(),
  /** Full value length in UTF-16 code units when `value` was cut. */
  value_length: z.number().int().min(0).nullable(),
  /** Fields of a CSV/TSV row, in order. */
  fields: z.array(z.string()).nullable(),
  /** 1-based JSON Lines record, CSV row, YAML document or text line. */
  record: z.number().int().min(1).nullable(),
  location: sourceLocationSchema.nullable(),
  end_offset: z.number().int().min(0).nullable(),
  details: z.record(z.string(), detailValue),
});
export type StructuralNode = z.infer<typeof structuralNodeSchema>;

export const documentDiagnosticSchema = z.strictObject({
  severity: z.enum(["error", "warning", "info"]),
  code: z.string().min(1),
  message: z.string().min(1),
  location: sourceLocationSchema.nullable(),
  record: z.number().int().min(1).nullable(),
});
export type DocumentDiagnostic = z.infer<typeof documentDiagnosticSchema>;

export const documentEncodingSchema = z.strictObject({
  name: textEncodingSchema,
  basis: z.enum(["byte-order-mark", "requested", "xml-declaration", "default"]),
  /** Label from an XML declaration, verbatim, when one was read. */
  declared: z.string().nullable(),
  bom_bytes: z.number().int().min(0),
  undecodable: z.array(
    z.strictObject({
      offset: z.number().int().min(0),
      bytes: z.number().int().min(1),
    }),
  ),
  undecodable_count: z.number().int().min(0),
  nul_characters: z.number().int().min(0),
  newlines: z.strictObject({
    lf: z.number().int().min(0),
    crlf: z.number().int().min(0),
    cr: z.number().int().min(0),
  }),
  lines: z.number().int().min(0),
  final_newline: z.boolean(),
});
export type DocumentEncoding = z.infer<typeof documentEncodingSchema>;

/** A reading page aligned to whole parser units where the units allow it. */
export const documentSegmentSchema = z.strictObject({
  index: z.number().int().min(0),
  start: z.number().int().min(0),
  end: z.number().int().min(0),
  first_line: z.number().int().min(1),
  last_line: z.number().int().min(1),
  unit: z.enum(["block", "record", "row", "document", "line", "bytes"]),
  /** Both ends fall on boundaries of the format's own unit. */
  complete_units: z.boolean(),
});
export type DocumentSegment = z.infer<typeof documentSegmentSchema>;

export const documentFormatSchema = z.strictObject({
  profile: structuredTextFormatSchema,
  basis: z.enum(["requested", "name-hint"]),
  /** Name suffix the profile was hinted by, if any. */
  extension: z.string().nullable(),
  /** A request that disagrees with the name suffix stays visible. */
  name_hint: structuredTextFormatSchema.nullable(),
});

export const documentParseSchema = z.strictObject({
  status: z.enum(["parsed", "partial", "failed"]),
  parser: z.string().min(1),
  /** JSON Lines records, CSV/TSV rows, YAML documents or text lines; null where not counted. */
  records: z.number().int().min(0).nullable(),
});

/** Complete structural reading of one local document, one node page at a time. */
export const structuredTextDocumentSchema = z.strictObject({
  artifact: z.strictObject({
    path: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    bytes: z.number().int().min(0),
  }),
  format: documentFormatSchema,
  encoding: documentEncodingSchema,
  parse: documentParseSchema,
  diagnostics: z.array(documentDiagnosticSchema),
  diagnostics_omitted: z.number().int().min(0),
  node_count: z.number().int().min(0),
  page: z.strictObject({
    start: z.number().int().min(0),
    limit: z.number().int().min(1),
    returned: z.number().int().min(0),
    next: z.number().int().min(0).nullable(),
  }),
  nodes: z.array(structuralNodeSchema),
  coverage: z.array(facetCoverageSchema),
  limitations: z.array(z.string()),
});
export type StructuredTextDocument = z.infer<
  typeof structuredTextDocumentSchema
>;
