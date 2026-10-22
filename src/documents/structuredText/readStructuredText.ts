import {
  type DocumentEncoding,
  type DocumentSegment,
  type StructuredTextDocument,
  type StructuredTextFormat,
  type TextEncoding,
  MAX_DOCUMENT_DEPTH,
  MAX_NODE_PATH_CHARACTERS,
  MAX_NODE_VALUE_CHARACTERS,
  STRUCTURED_TEXT_FORMATS,
} from "../../domain/document/structuredText.js";
import { formatsHintedByName } from "../../domain/formatRegistry.js";
import { err, ok, type Result } from "../../domain/result.js";
import { DocumentBuilder, NestingTooDeepError } from "./DocumentBuilder.js";
import { walkDelimited } from "./delimited.js";
import { walkJson, walkJsonLines } from "./json.js";
import { walkMarkdown } from "./markdown.js";
import { walkPlainText } from "./plainText.js";
import { documentSegments } from "./segments.js";
import {
  byteOrderMark,
  encodingForXmlLabel,
  SourceText,
  xmlDeclaredEncoding,
} from "./SourceText.js";
import { walkToml } from "./toml.js";
import { walkXml } from "./xml.js";
import { walkYaml } from "./yaml.js";

/** Parsers each profile uses, with their pinned package versions. */
export const STRUCTURED_TEXT_PARSERS: Readonly<
  Record<StructuredTextFormat, string>
> = {
  markdown: "markdown-it 14.3.3",
  json: "jsonc-parser 3.3.1 + JSON.parse",
  jsonl: "jsonc-parser 3.3.1 + JSON.parse",
  yaml: "yaml 2.9.0",
  toml: "smol-toml 1.9.0",
  xml: "@xmldom/xmldom 0.9.12",
  csv: "csv-parse 7.0.3",
  tsv: "csv-parse 7.0.3",
  "plain-text": "line reader",
};

/** Profiles whose values are meaningless once bytes failed to decode. */
const STRICT: ReadonlySet<StructuredTextFormat> = new Set([
  "json",
  "jsonl",
  "yaml",
  "toml",
  "xml",
]);

const FORMAT_LIMITATIONS: Readonly<Record<StructuredTextFormat, string[]>> = {
  markdown: [
    "Links and images are located at their block's first line, not their column.",
    "Inline formatting other than links and images is not listed as structure.",
  ],
  json: [
    "Numbers are the exact source text; string values are decoded from their escapes.",
  ],
  jsonl: [
    "Numbers are the exact source text; string values are decoded from their escapes.",
  ],
  yaml: [
    "Aliases are listed as references and never expanded; tags are reported, never constructed.",
    "Non-scalar mapping keys are shown as ?complex-key.",
  ],
  toml: [
    "smol-toml reports locations for errors only, so TOML values carry no source location.",
    "Floats and dates are normalized; integer-like keys follow JavaScript object order.",
  ],
  xml: [
    "Whitespace-only text between elements is not listed.",
    "DTDs are never processed or fetched; only the five predefined entities and character references are decoded.",
  ],
  csv: ["The first row is listed as data; no header meaning is assumed."],
  tsv: ["The first row is listed as data; no header meaning is assumed."],
  "plain-text": [],
};

/** A name suffix that hints no structured-text profile, with none requested. */
export class DocumentFormatUnresolvedError extends Error {
  readonly _tag = "DocumentFormatUnresolvedError";

  constructor(readonly fileName: string) {
    super(
      `The name ${fileName} does not hint a structured-text format; choose one of ${STRUCTURED_TEXT_FORMATS.join(", ")}.`,
    );
  }
}

/** What to read and which page of nodes to keep. */
export interface StructuredTextRequest {
  readonly bytes: Uint8Array;
  /** File name used for the suffix hint. */
  readonly name: string;
  readonly format?: StructuredTextFormat | undefined;
  readonly encoding?: TextEncoding | undefined;
  readonly delimiter?: string | undefined;
  readonly start: number;
  readonly limit: number;
}

/** A reading without artifact identity, which the caller owns. */
export type StructuredTextReading = Omit<StructuredTextDocument, "artifact">;

/** Structured-text profile hinted by a name suffix, if any. */
export const structuredTextFormatForName = (
  name: string,
): {
  readonly format: StructuredTextFormat;
  readonly extension: string;
} | null => {
  const hinted = formatsHintedByName(name);
  const format = hinted.formats.find((id): id is StructuredTextFormat =>
    (STRUCTURED_TEXT_FORMATS as readonly string[]).includes(id),
  );
  return format === undefined || hinted.extension === null
    ? null
    : { format, extension: hinted.extension };
};

const chooseEncoding = (
  bytes: Uint8Array,
  format: StructuredTextFormat,
  requested: TextEncoding | undefined,
): {
  readonly encoding: TextEncoding;
  readonly basis: DocumentEncoding["basis"];
  readonly bomBytes: number;
  readonly declared: string | null;
  readonly notes: readonly [string, string][];
} => {
  const bom = byteOrderMark(bytes);
  const declared = format === "xml" ? xmlDeclaredEncoding(bytes) : null;
  const notes: [string, string][] = [];
  if (requested !== undefined) {
    if (bom !== null && bom.encoding !== requested)
      notes.push([
        "encoding_bom_conflict",
        `The file starts with a ${bom.encoding} byte-order mark, but ${requested} was requested; the requested encoding is used and the mark is decoded as text.`,
      ]);
    return {
      encoding: requested,
      basis: "requested",
      bomBytes: bom?.encoding === requested ? bom.bytes : 0,
      declared,
      notes,
    };
  }
  if (bom !== null)
    return {
      encoding: bom.encoding,
      basis: "byte-order-mark",
      bomBytes: bom.bytes,
      declared,
      notes,
    };
  if (declared !== null) {
    const mapped = encodingForXmlLabel(declared);
    if (mapped !== null)
      return {
        encoding: mapped,
        basis: "xml-declaration",
        bomBytes: 0,
        declared,
        notes,
      };
    notes.push([
      "encoding_declared_unsupported",
      `The XML declaration names ${declared}, which this reader does not decode without a byte-order mark; UTF-8 is used. Choose an encoding explicitly if the text looks wrong.`,
    ]);
  }
  return { encoding: "utf-8", basis: "default", bomBytes: 0, declared, notes };
};

const walk = (
  builder: DocumentBuilder,
  format: StructuredTextFormat,
  delimiter: string | undefined,
): number | null => {
  switch (format) {
    case "markdown":
      walkMarkdown(builder);
      return null;
    case "json":
      walkJson(builder);
      return null;
    case "jsonl":
      return walkJsonLines(builder).records;
    case "yaml":
      return walkYaml(builder);
    case "toml":
      walkToml(builder);
      return null;
    case "xml":
      walkXml(builder);
      return null;
    case "csv":
      return walkDelimited(builder, delimiter ?? ",").rows;
    case "tsv":
      return walkDelimited(builder, delimiter ?? "\t").rows;
    case "plain-text":
      return walkPlainText(builder);
  }
};

/** Decoding problems: undecodable runs are errors, NUL characters warnings. */
const reportDecoding = (
  builder: DocumentBuilder,
  encoding: DocumentEncoding,
  format: StructuredTextFormat,
): void => {
  if (encoding.undecodable_count > 0) {
    const first = encoding.undecodable[0];
    builder.diagnostic(
      "error",
      "encoding_undecodable",
      `${String(encoding.undecodable_count)} byte run(s) are not valid ${encoding.name}${first === undefined ? "" : `, the first at byte ${String(first.offset)}`}. ${STRICT.has(format) ? "The document was not parsed; choose the right encoding." : "Each run is shown as U+FFFD."}`,
    );
  }
  if (encoding.nul_characters > 0)
    builder.diagnostic(
      "warning",
      "text_nul_characters",
      `${String(encoding.nul_characters)} NUL character(s) were decoded; the file may be binary or use another encoding.`,
    );
};

/** Walk, turning a parser's stack exhaustion into an explicit finding. */
const walkGuarded = (
  builder: DocumentBuilder,
  format: StructuredTextFormat,
  delimiter: string | undefined,
): number | null => {
  try {
    return walk(builder, format, delimiter);
  } catch (cause) {
    if (cause instanceof NestingTooDeepError) {
      builder.diagnostic("error", "nesting_too_deep", cause.message, cause.at);
      return null;
    }
    if (!(cause instanceof RangeError)) throw cause;
    builder.diagnostic(
      "error",
      "nesting_too_deep",
      "The document nests deeper than the parser's call stack allows; structure before that point is kept.",
    );
    return null;
  }
};

const NO_MEMBERS = "A structured-text document has no member files.";

/** Facet coverage of one reading, per the registry's coverage contract. */
const coverageOf = (reading: {
  readonly format: StructuredTextFormat;
  readonly origin: string;
  readonly parser: string;
  readonly status: StructuredTextReading["parse"]["status"];
  readonly count: number;
  readonly returned: number;
  readonly start: number;
  readonly next: number | null;
  readonly reason: string;
}): StructuredTextReading["coverage"] => {
  const parsed = reading.status === "parsed";
  const locationsMissing = parsed && reading.format === "toml";
  const page = `this page holds ${String(reading.returned)} from index ${String(reading.start)}.`;
  const continuation =
    reading.next === null ? null : `start=${String(reading.next)}`;
  const unsupported = (
    facet: "inventory" | "extract" | "reconstruct",
    reason: string,
  ) => ({
    facet,
    state: "unsupported" as const,
    examined: null,
    omitted: null,
    reason,
    continuation: null,
  });
  return [
    parsed
      ? {
          facet: "identify",
          state: "complete",
          examined: `Profile ${reading.format} from ${reading.origin}, confirmed by a complete ${reading.parser} parse.`,
          omitted: null,
          reason: null,
          continuation: null,
        }
      : {
          facet: "identify",
          state: "partial",
          examined: `Profile ${reading.format} from ${reading.origin}.`,
          omitted: "Confirmation by a successful parse.",
          reason: reading.reason,
          continuation: null,
        },
    parsed && !locationsMissing
      ? {
          facet: "inspect",
          state: "complete",
          examined: `All ${String(reading.count)} structural nodes; ${page}`,
          omitted: null,
          reason: null,
          continuation,
        }
      : {
          facet: "inspect",
          state: "partial",
          examined: `${String(reading.count)} structural nodes; ${page}`,
          omitted: locationsMissing
            ? "Source locations of TOML values."
            : "Structure after the first error.",
          reason: locationsMissing
            ? "smol-toml reports locations for errors only."
            : reading.reason,
          continuation,
        },
    unsupported("inventory", NO_MEMBERS),
    unsupported("extract", NO_MEMBERS),
    unsupported(
      "reconstruct",
      "Reading never rewrites the document; the original bytes are the only source.",
    ),
  ];
};

/**
 * Read one structured-text document: choose the profile and encoding
 * explicitly, decode with exact byte mapping, walk the parser's structure and
 * keep the requested page of nodes. Parse and decoding failures are findings
 * in the reading, not thrown errors.
 */
export const readStructuredText = (
  request: StructuredTextRequest,
  options: { readonly segments?: boolean } = {},
): Result<
  {
    readonly reading: StructuredTextReading;
    readonly segments: DocumentSegment[] | null;
    readonly encoding: TextEncoding;
  },
  DocumentFormatUnresolvedError
> => {
  const hinted = structuredTextFormatForName(request.name);
  const format = request.format ?? hinted?.format;
  if (format === undefined)
    return err(new DocumentFormatUnresolvedError(request.name));
  const chosen = chooseEncoding(request.bytes, format, request.encoding);
  const source = SourceText.decode(
    request.bytes,
    chosen.encoding,
    chosen.bomBytes,
  );
  const builder = new DocumentBuilder(source, {
    start: request.start,
    limit: request.limit,
  });
  for (const [code, message] of chosen.notes)
    builder.diagnostic("warning", code, message);
  const encoding = source.describe(chosen.basis, chosen.declared);
  reportDecoding(builder, encoding, format);
  const records =
    STRICT.has(format) && encoding.undecodable_count > 0
      ? null
      : walkGuarded(builder, format, request.delimiter);
  const status = builder.hasErrors()
    ? builder.count > 0
      ? "partial"
      : "failed"
    : "parsed";
  const firstError = builder.diagnostics.find(
    ({ severity }) => severity === "error",
  );
  const errorReason = firstError?.message ?? "The parser reported errors.";
  const returned = builder.kept.length;
  const next =
    request.start + returned < builder.count ? request.start + returned : null;
  const parser = STRUCTURED_TEXT_PARSERS[format];
  const basis = request.format === undefined ? "name-hint" : "requested";
  const reading: StructuredTextReading = {
    format: {
      profile: format,
      basis,
      extension: hinted?.extension ?? null,
      name_hint:
        hinted !== null && hinted.format !== format ? hinted.format : null,
    },
    encoding,
    parse: { status, parser, records },
    diagnostics: builder.diagnostics,
    diagnostics_omitted: builder.diagnosticsOmitted,
    node_count: builder.count,
    page: {
      start: request.start,
      limit: request.limit,
      returned,
      next,
    },
    nodes: builder.kept,
    coverage: coverageOf({
      format,
      origin:
        basis === "requested"
          ? "the caller's choice"
          : `the ${hinted?.extension ?? ""} name suffix`,
      parser,
      status,
      count: builder.count,
      returned,
      start: request.start,
      next,
      reason: errorReason,
    }),
    limitations: [
      "Parsing reads decoded text in process; the original bytes are never rewritten or reformatted.",
      `Node values longer than ${String(MAX_NODE_VALUE_CHARACTERS)} characters are cut and state their full length; paths longer than ${String(MAX_NODE_PATH_CHARACTERS)} are cut and marked path_cut.`,
      `Structure nested deeper than ${String(MAX_DOCUMENT_DEPTH)} levels is reported as an error, not walked.`,
      ...FORMAT_LIMITATIONS[format],
    ],
  };
  return ok({
    reading,
    segments:
      options.segments === true
        ? documentSegments(source, builder.unitStarts, builder.unit)
        : null,
    encoding: chosen.encoding,
  });
};
