import { z } from "zod";

import { facetCoverageSchema } from "../formatRegistry.js";

/**
 * PDF documents read from their bytes (format expansion F12, part 2). The file
 * structure, metadata, attachments and action inventory are read in process;
 * page text comes from an admitted Poppler `pdftotext` run on a private copy.
 * Nothing is rendered, decrypted, signed-checked, executed or fetched.
 */

export const DEFAULT_PDF_FILE_BYTES = 128 * 1024 ** 2;
export const MAX_PDF_FILE_BYTES = 1024 ** 3;
export const DEFAULT_PDF_DECODED_BYTES = 512 * 1024 ** 2;
export const MAX_PDF_DECODED_BYTES = 2 * 1024 ** 3;
export const MAX_PDF_ROWS = 5_000;
/** Most pages one text or layout call reads; Poppler lays out every page it is given. */
export const MAX_PDF_TEXT_PAGES = 200;
export const DEFAULT_PDF_TEXT_PAGES = 10;
export const DEFAULT_PDF_TIMEOUT_MS = 60_000;
export const MAX_PDF_TIMEOUT_MS = 600_000;

const count = z.number().int().min(0);
const nullableString = z.string().nullable();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);

export const PDF_VIEWS = [
  "package",
  "pages",
  "objects",
  "text",
  "layout",
] as const;

export const inspectPdfDocumentInputSchema = z.strictObject({
  path: z.string().min(1).describe("Absolute path to a local PDF file"),
  view: z
    .enum(PDF_VIEWS)
    .default("package")
    .describe(
      "package: header, cross-reference structure, encryption, metadata, attachments, actions and signatures (default). pages: one row per page with boxes, rotation, what the page draws and its annotations. objects: one row per indirect object. text: page text as Markdown lines. layout: page text as lines with bounding boxes",
    ),
  start: count
    .default(0)
    .describe(
      "Index of the first row to return; for text and layout, the first page (0-based)",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_PDF_ROWS)
    .optional()
    .describe(
      `Maximum rows to return (default 100); for text and layout, the number of pages (default ${String(DEFAULT_PDF_TEXT_PAGES)}, at most ${String(MAX_PDF_TEXT_PAGES)})`,
    ),
  max_file_bytes: z
    .number()
    .int()
    .min(1)
    .max(MAX_PDF_FILE_BYTES)
    .default(DEFAULT_PDF_FILE_BYTES)
    .describe("Maximum stable bytes to read from the file (default 128 MiB)"),
  max_decoded_bytes: z
    .number()
    .int()
    .min(1)
    .max(MAX_PDF_DECODED_BYTES)
    .default(DEFAULT_PDF_DECODED_BYTES)
    .describe(
      "Maximum bytes to decompress from the file in this call (default 512 MiB)",
    ),
  timeout_ms: z
    .number()
    .int()
    .min(1_000)
    .max(MAX_PDF_TIMEOUT_MS)
    .default(DEFAULT_PDF_TIMEOUT_MS)
    .describe(
      "Deadline for the in-process read (checked between steps) and for the Poppler text run in the text and layout views (default 60 s)",
    ),
});
export type InspectPdfDocumentInput = z.infer<
  typeof inspectPdfDocumentInputSchema
>;

/** The row or page count a call uses: the caller's choice, else the view's default. */
export const resolvePdfLimit = (
  view: (typeof PDF_VIEWS)[number],
  limit: number | undefined,
): number =>
  limit ??
  (view === "text" || view === "layout" ? DEFAULT_PDF_TEXT_PAGES : 100);

const permissionsSchema = z.strictObject({
  /** The P entry as stored: a signed 32-bit integer. */
  raw: z.number().int().nullable(),
  print: z.boolean().nullable(),
  print_high_quality: z.boolean().nullable(),
  modify: z.boolean().nullable(),
  copy: z.boolean().nullable(),
  annotate: z.boolean().nullable(),
  fill_forms: z.boolean().nullable(),
  accessibility_extract: z.boolean().nullable(),
  assemble: z.boolean().nullable(),
});

const encryptionSchema = z.strictObject({
  handler: nullableString,
  sub_filter: nullableString,
  version: z.number().int().nullable(),
  revision: z.number().int().nullable(),
  key_bits: z.number().int().nullable(),
  method: z
    .enum(["rc4", "aes-128", "aes-256", "identity", "unknown"])
    .nullable(),
  public_key: z.boolean(),
  encrypt_metadata: z.boolean().nullable(),
  permissions: permissionsSchema.nullable(),
  note: z.string(),
});
export type PdfEncryption = z.infer<typeof encryptionSchema>;

const formSchema = z.strictObject({
  fields: count,
  signature_fields: count,
  need_appearances: z.boolean(),
  xfa: z.boolean(),
});

export const XREF_STATES = [
  "table",
  "stream",
  "hybrid",
  "rebuilt",
  "none",
] as const;

const documentSchema = z.strictObject({
  header_version: nullableString,
  header_offset: count.nullable(),
  catalog_version: nullableString,
  linearized: z.boolean(),
  xref: z.strictObject({
    state: z.enum(XREF_STATES),
    sections: count,
    entries: count,
    startxref_markers: count,
  }),
  eof_markers: count,
  /** Bytes after the last %%EOF that are not white space. */
  trailing_bytes: count,
  ids: z.array(z.string()),
  encryption: encryptionSchema.nullable(),
  page_count: count.nullable(),
  declared_page_count: count.nullable(),
  tagged: z.boolean().nullable(),
  language: nullableString,
  page_layout: nullableString,
  page_mode: nullableString,
  outlines: z.boolean().nullable(),
  optional_content_groups: count.nullable(),
  portfolio: z.boolean().nullable(),
  form: formSchema.nullable(),
  decoded_bytes: count,
  problems: z.array(z.string()),
});
export type PdfDocumentFacts = z.infer<typeof documentSchema>;

const metadataSchema = z.strictObject({
  /** Document information dictionary entries as written (dates stay in PDF date syntax), in file order. */
  info: z.array(z.strictObject({ key: z.string(), value: z.string() })),
  /** Entries the dictionary holds with a value this reader can show; `info` lists up to 200. */
  info_total: count,
  xmp: z.strictObject({ bytes: count, sha256: sha256.nullable() }).nullable(),
});
export type PdfMetadata = z.infer<typeof metadataSchema>;

const attachmentSchema = z.strictObject({
  source: z.enum(["name-tree", "annotation"]),
  name: nullableString,
  description: nullableString,
  object: nullableString,
  media_type: nullableString,
  relationship: nullableString,
  declared_bytes: count.nullable(),
  decoded_bytes: count.nullable(),
  /** SHA-256 of the decoded bytes when they were read inside the decoding budget. */
  sha256: sha256.nullable(),
  /** The MD5 the file specification declares (Params CheckSum), as written. */
  declared_md5: nullableString,
  created: nullableString,
  modified: nullableString,
  filters: z.array(z.string()),
  state: z.enum(["read", "not-decoded", "over-budget", "unreadable"]),
  note: nullableString,
});
export type PdfAttachment = z.infer<typeof attachmentSchema>;

export const ACTION_KINDS = [
  "JavaScript",
  "Launch",
  "URI",
  "GoToR",
  "GoToE",
  "SubmitForm",
  "ImportData",
  "Rendition",
  "RichMedia",
  "Movie",
  "Sound",
  "ThreeD",
  "FileSpec",
] as const;

const actionSchema = z.strictObject({
  kind: z.enum(ACTION_KINDS),
  /** Where the action hangs: OpenAction, Catalog AA, Names JavaScript, page N AA, page N link, form field, outline. */
  trigger: z.string(),
  object: nullableString,
  /** The URI, file or URL as written; never followed. */
  target: nullableString,
  script_bytes: count.nullable(),
  script_sha256: sha256.nullable(),
  /** The start of a JavaScript action's text. Static script text is evidence, not a verdict. */
  script: nullableString,
  script_truncated: z.boolean(),
});
export type PdfAction = z.infer<typeof actionSchema>;

const signatureSchema = z.strictObject({
  field: nullableString,
  object: nullableString,
  type: z.enum(["signature", "timestamp"]),
  sub_filter: nullableString,
  byte_range: z.array(z.number().int()).nullable(),
  /**
   * How far the signed byte ranges reach in this file. `whole-file`: the gap between them is exactly the
   * Contents hex string and the second range ends at the end of the file. `earlier-revision`: bytes follow
   * (an update the signature does not cover). `gap-mismatch`: the bytes the ranges skip are not the Contents
   * hex string, so other bytes are unsigned. `invalid-range`: the ranges are impossible for this file.
   */
  coverage: z.enum([
    "whole-file",
    "earlier-revision",
    "gap-mismatch",
    "invalid-range",
    "no-range",
  ]),
  /** Bytes between the two ranges, which should be the Contents hex string alone. */
  gap_bytes: count.nullable(),
  uncovered_trailing_bytes: count.nullable(),
  contents_bytes: count.nullable(),
  signer: nullableString,
  reason: nullableString,
  location: nullableString,
  signing_time: nullableString,
  contact: nullableString,
  doc_mdp_permission: z.number().int().nullable(),
});
export type PdfSignature = z.infer<typeof signatureSchema>;

export const PDF_PAGE_KINDS = [
  "text",
  "text-and-images",
  "image-only",
  "image-with-hidden-text",
  "vector-only",
  "blank",
  "unreadable",
  "not-read",
] as const;

const box = z.tuple([z.number(), z.number(), z.number(), z.number()]);

const pageSchema = z.strictObject({
  index: count,
  object: nullableString,
  media_box: box.nullable(),
  crop_box: box.nullable(),
  rotate: z.number().int(),
  user_unit: z.number(),
  kind: z.enum(PDF_PAGE_KINDS),
  content_streams: count,
  text_operations: count,
  hidden_text_operations: count,
  images: count,
  vector_operations: count,
  fonts: count,
  annotations: z.strictObject({
    total: count,
    subtypes: z.array(z.strictObject({ subtype: z.string(), count })),
  }),
  /** URIs of link annotations, as written. */
  links: z.array(z.string()),
  note: nullableString,
});
export type PdfPageRow = z.infer<typeof pageSchema>;

const objectSchema = z.strictObject({
  number: count,
  generation: count,
  location: z.string(),
  kind: z.enum([
    "dictionary",
    "stream",
    "array",
    "string",
    "name",
    "number",
    "boolean",
    "null",
    "reference",
    "unreadable",
  ]),
  type: nullableString,
  subtype: nullableString,
  filters: z.array(z.string()),
  /** The stream's declared Length. */
  stream_bytes: count.nullable(),
});
export type PdfObjectRow = z.infer<typeof objectSchema>;

const layoutLineSchema = z.strictObject({
  /** Poppler's flow (paragraph), block and line numbers: a line is one (flow, block, line). */
  flow: count,
  block: count,
  line: count,
  /** left, top, right, bottom in points from the page's top-left corner, as Poppler reports them. */
  bbox: box,
  text: z.string(),
});

const layoutPageSchema = z.strictObject({
  page: count,
  width: z.number(),
  height: z.number(),
  words: count,
  lines: z.array(layoutLineSchema),
});
export type PdfLayoutPage = z.infer<typeof layoutPageSchema>;

const diagnosticSchema = z.strictObject({
  location: nullableString,
  message: z.string().min(1),
});
export type PdfDiagnostic = z.infer<typeof diagnosticSchema>;

export const pdfDocumentReportSchema = z.strictObject({
  artifact: z.strictObject({ path: z.string().min(1), sha256, bytes: count }),
  document: documentSchema,
  /** The package view's metadata; null in the other views and for an encrypted file. */
  metadata: metadataSchema.nullable(),
  attachments: z.array(attachmentSchema),
  attachment_total: count,
  actions: z.array(actionSchema),
  action_total: count,
  signatures: z.array(signatureSchema),
  signature_total: count,
  /** The package view classifies the first pages only; the pages view classifies each page it returns. */
  content_sample: z
    .strictObject({
      pages_examined: count,
      by_kind: z.record(z.string(), count),
    })
    .nullable(),
  view: z.enum(PDF_VIEWS),
  total: count.nullable(),
  page: z.strictObject({
    start: count,
    limit: z.number().int().min(1),
    returned: count,
    next: count.nullable(),
  }),
  pages: z.array(pageSchema),
  objects: z.array(objectSchema),
  layout: z.array(layoutPageSchema),
  text: z.array(z.string()),
  /** The Poppler build that read the text, when the text or layout view ran it. */
  text_tool: z
    .strictObject({ name: z.string(), version: z.string(), sha256 })
    .nullable(),
  diagnostics: z.array(diagnosticSchema),
  coverage: z.array(facetCoverageSchema),
  limitations: z.array(z.string()),
});
export type PdfDocumentReport = z.infer<typeof pdfDocumentReportSchema>;
