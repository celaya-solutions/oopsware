import { z } from "zod";

import { facetCoverageSchema } from "../formatRegistry.js";

/**
 * Office documents read from their bytes (format expansion F12, parts 1 and 3):
 * Office Open XML Word, Excel and PowerPoint documents, templates and
 * macro-enabled variants, and legacy Word, Excel and PowerPoint 97-2003 files
 * (OLE compound files). Nothing is opened in an application, recalculated,
 * converted, executed or fetched; references that point outside the document
 * are listed, never followed.
 */

/** Default and maximum bytes read for one document. */
export const DEFAULT_OFFICE_FILE_BYTES = 128 * 1024 ** 2;
export const MAX_OFFICE_FILE_BYTES = 1024 ** 3;
/** Default and maximum bytes decompressed from the package in one call. */
export const DEFAULT_OFFICE_DECODED_BYTES = 512 * 1024 ** 2;
export const MAX_OFFICE_DECODED_BYTES = 2 * 1024 ** 3;
export const MAX_OFFICE_PAGE = 5_000;

const count = z.number().int().min(0);
const nullableString = z.string().nullable();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);

export const OFFICE_VIEWS = ["package", "parts", "content", "text"] as const;

export const inspectOfficeDocumentInputSchema = z.strictObject({
  path: z
    .string()
    .min(1)
    .describe(
      "Absolute path to a local Office file: Open XML (.docx, .dotx, .docm, .dotm, .xlsx, .xltx, .xlsm, .xltm, .xlam, .pptx, .potx, .pptm, .potm, .ppsx, .ppsm, .ppam) or legacy 97-2003 (.doc, .dot, .xls, .xlt, .ppt, .pot, .pps). The kind is read from the bytes, never from the name",
    ),
  view: z
    .enum(OFFICE_VIEWS)
    .default("package")
    .describe(
      "package: kind, properties, macros, embedded objects, external references and counts (default). parts: every package part with its content type and size. content: typed units of one content part (paragraphs and tables, worksheet rows with formulas and cached values, slides with notes). text: the same content as readable Markdown lines",
    ),
  part: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Content part for the content and text views, as listed in the package view's content_parts (for example body, comments, sheet:2, slides). Defaults to the document body, the first worksheet or the slides",
    ),
  start: count.default(0).describe("Index of the first row to return"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_OFFICE_PAGE)
    .default(100)
    .describe("Maximum rows to return in this page"),
  max_file_bytes: z
    .number()
    .int()
    .min(1)
    .max(MAX_OFFICE_FILE_BYTES)
    .default(DEFAULT_OFFICE_FILE_BYTES)
    .describe("Maximum stable bytes to read from the file (default 128 MiB)"),
  max_decoded_bytes: z
    .number()
    .int()
    .min(1)
    .max(MAX_OFFICE_DECODED_BYTES)
    .default(DEFAULT_OFFICE_DECODED_BYTES)
    .describe(
      "Maximum bytes to decompress from the package in this call (default 512 MiB)",
    ),
});
export type InspectOfficeDocumentInput = z.infer<
  typeof inspectOfficeDocumentInputSchema
>;

export const OFFICE_KINDS = [
  "docx",
  "dotx",
  "docm",
  "dotm",
  "xlsx",
  "xltx",
  "xlsm",
  "xltm",
  "xlam",
  "xlsb",
  "doc",
  "xls",
  "ppt",
  "pptx",
  "potx",
  "pptm",
  "potm",
  "ppsx",
  "ppsm",
  "ppam",
  "unknown",
] as const;

const NOTABLE_KINDS = [
  "macro-project",
  "macro-signature",
  "macro-data",
  "macro-sheet",
  "ole-object",
  "embedded-package",
  "activex",
  "digital-signature",
  "custom-xml",
  "comments",
  "thumbnail",
] as const;

const notableSchema = z.strictObject({
  kind: z.enum(NOTABLE_KINDS),
  part: z.string(),
  content_type: nullableString,
  bytes: count,
  /** SHA-256 of the part's bytes when they were read inside the decoding budget. */
  sha256: sha256.nullable(),
  note: nullableString,
});
export type OfficeNotable = z.infer<typeof notableSchema>;

const externalSchema = z.strictObject({
  /** The part that declares it; null for the package's own relationships. */
  source: nullableString,
  kind: z.string(),
  target: z.string(),
  id: z.string(),
});
export type OfficeExternalReference = z.infer<typeof externalSchema>;

const customPropertySchema = z.strictObject({
  name: z.string(),
  type: z.string(),
  value: z.string(),
});

const packageSchema = z.strictObject({
  kind: z.enum(OFFICE_KINDS),
  family: z.enum(["word", "excel", "powerpoint"]).nullable(),
  /**
   * Open XML: decided by the main part's content type. Legacy: true when the
   * file carries a VBA project or an Excel 4.0 macro sheet, because those
   * formats have no macro-enabled type. Never decided by the file name.
   */
  macro_enabled: z.boolean(),
  main_part: nullableString,
  main_content_type: nullableString,
  name_conflict: nullableString,
  conformance: z.enum(["transitional", "strict", "unknown"]),
  part_count: count,
  decoded_bytes: count,
  properties: z.strictObject({
    core: z.record(z.string(), z.string()),
    app: z.record(z.string(), z.string()),
    custom: z.array(customPropertySchema),
    custom_total: count,
  }),
  /** Counts the reader observed, named by what they count. */
  statistics: z.record(z.string(), count),
  notable: z.array(notableSchema),
  notable_total: count,
  external_references: z.array(externalSchema),
  external_total: count,
  problems: z.array(z.string()),
});
export type OfficePackage = z.infer<typeof packageSchema>;

const partSchema = z.strictObject({
  path: z.string(),
  content_type: nullableString,
  bytes: count,
  encrypted: z.boolean(),
});

const contentPartSchema = z.strictObject({
  id: z.string(),
  label: z.string(),
  kind: z.enum([
    "body",
    "comments",
    "footnotes",
    "endnotes",
    "header",
    "footer",
    "worksheet",
    "chartsheet",
    "macro-sheet",
    "dialog-sheet",
    "slides",
  ]),
  hidden: z.boolean(),
});
export type OfficeContentPart = z.infer<typeof contentPartSchema>;

const linkSchema = z.strictObject({
  text: z.string(),
  target: z.string(),
  external: z.boolean(),
});

const paragraphSchema = z.strictObject({
  kind: z.literal("paragraph"),
  index: count,
  location: z.string(),
  style: nullableString,
  heading_level: count.nullable(),
  list_level: count.nullable(),
  /** Every run is marked hidden (w:vanish). */
  hidden: z.boolean(),
  revision: z.enum(["inserted", "deleted", "mixed"]).nullable(),
  text: z.string(),
  links: z.array(linkSchema),
  /** Field instructions as written, never evaluated. */
  fields: z.array(z.string()),
});

const tableSchema = z.strictObject({
  kind: z.literal("table"),
  index: count,
  location: z.string(),
  rows: count,
  columns: count,
  cells: z.array(z.array(z.string())),
  truncated: z.boolean(),
});

const commentSchema = z.strictObject({
  kind: z.literal("comment"),
  index: count,
  location: z.string(),
  id: nullableString,
  author: nullableString,
  date: nullableString,
  text: z.string(),
});

const noteSchema = z.strictObject({
  kind: z.literal("note"),
  index: count,
  location: z.string(),
  id: nullableString,
  text: z.string(),
});

const cellSchema = z.strictObject({
  ref: z.string(),
  type: z.enum([
    "number",
    "string",
    "inline-string",
    "boolean",
    "error",
    "date",
    "blank",
  ]),
  /** The stored value, or the cached result of a formula; null when none is stored. */
  value: nullableString,
  /** For a date, the stored serial number exactly as written. */
  serial: nullableString,
  formula: nullableString,
  formula_kind: z.enum(["normal", "shared", "array", "data-table"]).nullable(),
  /** For a shared formula's other cells, the cell that holds its text. */
  formula_from: nullableString,
  number_format: nullableString,
});

const rowSchema = z.strictObject({
  kind: z.literal("row"),
  index: count,
  row: count,
  hidden: z.boolean(),
  cells: z.array(cellSchema),
});

const slideSchema = z.strictObject({
  kind: z.literal("slide"),
  index: count,
  number: count,
  location: z.string(),
  hidden: z.boolean(),
  layout: nullableString,
  title: nullableString,
  texts: z.array(z.strictObject({ shape: z.string(), text: z.string() })),
  tables: z.array(z.array(z.array(z.string()))),
  notes: nullableString,
  links: z.array(linkSchema),
});

const itemSchema = z.discriminatedUnion("kind", [
  paragraphSchema,
  tableSchema,
  commentSchema,
  noteSchema,
  rowSchema,
  slideSchema,
]);
export type OfficeItem = z.infer<typeof itemSchema>;
export type OfficeParagraph = z.infer<typeof paragraphSchema>;
export type OfficeTable = z.infer<typeof tableSchema>;
export type OfficeRow = z.infer<typeof rowSchema>;
export type OfficeCell = z.infer<typeof cellSchema>;
export type OfficeSlide = z.infer<typeof slideSchema>;

const omissionSchema = z.strictObject({
  kind: z.string(),
  count,
  note: z.string(),
});
export type OfficeOmission = z.infer<typeof omissionSchema>;

const diagnosticSchema = z.strictObject({
  location: nullableString,
  message: z.string().min(1),
});
export type OfficeDiagnostic = z.infer<typeof diagnosticSchema>;

export const officeDocumentReportSchema = z.strictObject({
  artifact: z.strictObject({
    path: z.string().min(1),
    sha256,
    bytes: count,
  }),
  package: packageSchema,
  /** Content parts the document has, selectable with part. */
  content_parts: z.array(contentPartSchema),
  view: z.enum(OFFICE_VIEWS),
  /** The content part the content and text views read. */
  part: contentPartSchema.nullable(),
  total: count.nullable(),
  page: z.strictObject({
    start: count,
    limit: z.number().int().min(1),
    returned: count,
    next: count.nullable(),
  }),
  parts: z.array(partSchema),
  items: z.array(itemSchema),
  text: z.array(z.string()),
  /** What the content and text views leave out, so a gap is never read as emptiness. */
  omissions: z.array(omissionSchema),
  diagnostics: z.array(diagnosticSchema),
  coverage: z.array(facetCoverageSchema),
  limitations: z.array(z.string()),
});
export type OfficeDocumentReport = z.infer<typeof officeDocumentReportSchema>;
