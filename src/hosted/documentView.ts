import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import {
  type StructuredTextFormat,
  documentDiagnosticSchema,
  documentEncodingSchema,
  documentSegmentSchema,
  structuralNodeSchema,
  structuredTextDocumentSchema,
  textEncodingSchema,
} from "../domain/document/structuredText.js";
import {
  readStructuredText,
  structuredTextFormatForName,
} from "../documents/structuredText/readStructuredText.js";
import {
  formatCapabilities,
  HOSTED_CAPABILITY_CONTEXT,
} from "../domain/formatRegistry.js";
import { HostedError } from "./types.js";
import { runViewWorker } from "./viewWorker.js";

/** Versioned on-disk shape of a hosted structured-text view. */
export const DOCUMENT_VIEW_SCHEMA = "oopsware.structured-text.v1";
/** Uploaded originals larger than this keep the byte preview only. */
export const HOSTED_DOCUMENT_MAX_BYTES = 16 * 1024 ** 2;
/**
 * Markdown, YAML, XML and TOML parsers build a whole tree in memory; a typical
 * 8 MiB file of these already exceeds the parse budget, so they stop at 4 MiB.
 */
export const HOSTED_TREE_DOCUMENT_MAX_BYTES = 4 * 1024 ** 2;
const TREE_FORMATS: ReadonlySet<StructuredTextFormat> = new Set([
  "markdown",
  "yaml",
  "xml",
  "toml",
]);

/** Largest original of one profile the hosted reader parses. */
export const hostedDocumentMaxBytes = (format: StructuredTextFormat): number =>
  TREE_FORMATS.has(format)
    ? HOSTED_TREE_DOCUMENT_MAX_BYTES
    : HOSTED_DOCUMENT_MAX_BYTES;
/** Structural nodes kept browsable per submission. */
export const HOSTED_DOCUMENT_MAX_NODES = 100_000;
/** Structural nodes per stored page. */
export const HOSTED_DOCUMENT_PAGE_NODES = 500;
/** Heap of the separate process that parses one original. */
export const HOSTED_DOCUMENT_HEAP_MIB = 384;
/** Wall-clock budget of that process. */
export const HOSTED_DOCUMENT_TIME_MS = 3 * 60_000;

const DIRECTORY = "document";

const indexSchema = z.strictObject({
  schema: z.literal(DOCUMENT_VIEW_SCHEMA),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  bytes: z.number().int().min(0),
  format: structuredTextDocumentSchema.shape.format,
  encoding: documentEncodingSchema,
  parse: structuredTextDocumentSchema.shape.parse,
  diagnostics: z.array(documentDiagnosticSchema),
  diagnostics_omitted: z.number().int().min(0),
  node_count: z.number().int().min(0),
  stored_nodes: z.number().int().min(0),
  page_nodes: z.number().int().min(1),
  node_pages: z.number().int().min(0),
  segments: z.array(documentSegmentSchema),
  coverage: structuredTextDocumentSchema.shape.coverage,
  limitations: z.array(z.string()),
});
export type DocumentViewIndex = z.infer<typeof indexSchema>;

const documentViewSummarySchema = z.union([
  z.strictObject({
    schema: z.literal(DOCUMENT_VIEW_SCHEMA),
    status: z.enum(["parsed", "partial", "failed"]),
    profile: z.string(),
    encoding: z.string(),
    node_count: z.number().int().min(0),
    stored_nodes: z.number().int().min(0),
    diagnostics: z.number().int().min(0),
    first_error: z.string().nullable(),
    capabilities: z.custom<ReturnType<typeof formatCapabilities>>(
      (value) => typeof value === "object" && value !== null,
    ),
  }),
  z.null(),
]);

/** Report summary of the hosted structured-text view. */
export type DocumentViewSummary =
  | {
      readonly schema: typeof DOCUMENT_VIEW_SCHEMA;
      readonly status: "parsed" | "partial" | "failed";
      readonly profile: string;
      readonly encoding: string;
      readonly node_count: number;
      readonly stored_nodes: number;
      readonly diagnostics: number;
      readonly first_error: string | null;
      readonly capabilities: ReturnType<typeof formatCapabilities>;
    }
  | {
      readonly schema: typeof DOCUMENT_VIEW_SCHEMA;
      readonly status: "skipped";
      readonly reason: string;
    };

/** Command-line mode of the hosted worker that builds one structured-text view. */
export const DOCUMENT_VIEW_WORKER_MODE = "document-view";

const skipped = (reason: string): DocumentViewSummary => ({
  schema: DOCUMENT_VIEW_SCHEMA,
  status: "skipped",
  reason,
});

/**
 * Parse an uploaded structured-text original once and store its node pages
 * and reading segments. Parsing runs in its own process with a fixed heap and
 * time budget, so a file that is too large or too complex to read here loses
 * only its structured view: the inspection, byte preview and download remain.
 * Returns null when the name hints no structured-text profile. The original
 * bytes are never changed.
 */
export const writeDocumentView = async (
  source: string,
  name: string,
  folder: string,
  sha256: string,
  worker: string,
): Promise<DocumentViewSummary | null> => {
  const target = join(folder, DIRECTORY);
  const staging = join(folder, `${DIRECTORY}.staging`);
  await rm(target, { recursive: true, force: true });
  const hinted = structuredTextFormatForName(name);
  if (hinted === null) return null;
  const { size } = await stat(source);
  const limit = hostedDocumentMaxBytes(hinted.format);
  if (size > limit)
    return skipped(
      `Structured reading of ${hinted.format} is limited to ${String(limit / 1024 ** 2)} MiB on this service; the byte preview and the original download remain.`,
    );
  const outcome = await runViewWorker(
    worker,
    [DOCUMENT_VIEW_WORKER_MODE, source, name, folder, sha256],
    { heapMiB: HOSTED_DOCUMENT_HEAP_MIB, timeMs: HOSTED_DOCUMENT_TIME_MS },
  );
  const summary = documentViewSummarySchema.safeParse(outcome);
  if (summary.success) return summary.data;
  // A killed or failed parse may leave a partial staging folder; never serve it.
  await rm(staging, { recursive: true, force: true });
  await rm(target, { recursive: true, force: true });
  return skipped(
    `Structured reading of this file did not finish within this service's ${String(HOSTED_DOCUMENT_HEAP_MIB)} MiB memory and ${String(HOSTED_DOCUMENT_TIME_MS / 60_000)}-minute budget; the byte preview and the original download remain.`,
  );
};

/**
 * Build and store the view in the current process. The hosted worker runs
 * this in its document-view mode, inside the budget {@link writeDocumentView}
 * sets; it is not meant to run in the analysis or server process.
 */
export const buildDocumentView = async (
  source: string,
  name: string,
  folder: string,
  sha256: string,
): Promise<DocumentViewSummary | null> => {
  const target = join(folder, DIRECTORY);
  if (structuredTextFormatForName(name) === null) return null;
  const bytes = await readFile(source);
  const read = readStructuredText(
    { bytes, name, start: 0, limit: HOSTED_DOCUMENT_MAX_NODES },
    { segments: true },
  );
  if (!read.ok) return null;
  const { reading, segments } = read.value;
  const stored = reading.nodes;
  const pages = Math.ceil(stored.length / HOSTED_DOCUMENT_PAGE_NODES);
  const limitations = [...reading.limitations];
  if (reading.node_count > stored.length)
    limitations.push(
      `Only the first ${stored.length.toLocaleString("en-US")} of ${reading.node_count.toLocaleString("en-US")} structural nodes are browsable here; the original download is complete.`,
    );
  const index: DocumentViewIndex = {
    schema: DOCUMENT_VIEW_SCHEMA,
    sha256,
    bytes: bytes.length,
    format: reading.format,
    encoding: reading.encoding,
    parse: reading.parse,
    diagnostics: reading.diagnostics,
    diagnostics_omitted: reading.diagnostics_omitted,
    node_count: reading.node_count,
    stored_nodes: stored.length,
    page_nodes: HOSTED_DOCUMENT_PAGE_NODES,
    node_pages: pages,
    segments: segments ?? [],
    coverage: reading.coverage,
    limitations,
  };
  // Write beside the final name, then rename, so readers never see half a view.
  const staging = join(folder, `${DIRECTORY}.staging`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { mode: 0o700 });
  for (let page = 0; page < pages; page += 1)
    await writeFile(
      join(staging, `nodes-${String(page)}.json`),
      JSON.stringify(
        stored.slice(
          page * HOSTED_DOCUMENT_PAGE_NODES,
          (page + 1) * HOSTED_DOCUMENT_PAGE_NODES,
        ),
      ),
      { mode: 0o600 },
    );
  await writeFile(join(staging, "index.json"), JSON.stringify(index), {
    mode: 0o600,
  });
  await rename(staging, target);
  const firstError = reading.diagnostics.find(
    ({ severity }) => severity === "error",
  );
  return {
    schema: DOCUMENT_VIEW_SCHEMA,
    status: reading.parse.status,
    profile: reading.format.profile,
    encoding: reading.encoding.name,
    node_count: reading.node_count,
    stored_nodes: stored.length,
    diagnostics: reading.diagnostics.length + reading.diagnostics_omitted,
    first_error: firstError?.message ?? null,
    capabilities: formatCapabilities(
      reading.format.profile,
      HOSTED_CAPABILITY_CONTEXT,
    ),
  };
};

const missing = () =>
  new HostedError(404, "No structured-text view exists for this upload.");

const readJson = async (path: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      throw missing();
    throw cause;
  }
};

/** The stored view index, validated before it is served. */
export const readDocumentIndex = async (
  folder: string,
): Promise<DocumentViewIndex> =>
  indexSchema.parse(await readJson(join(folder, DIRECTORY, "index.json")));

/** One stored page of structural nodes. */
export const readDocumentNodes = async (folder: string, page: number) => {
  const index = await readDocumentIndex(folder);
  if (page >= index.node_pages)
    throw new HostedError(404, "That structure page does not exist.");
  const nodes = z
    .array(structuralNodeSchema)
    .parse(
      await readJson(join(folder, DIRECTORY, `nodes-${String(page)}.json`)),
    );
  return {
    page,
    pages: index.node_pages,
    page_nodes: index.page_nodes,
    stored_nodes: index.stored_nodes,
    node_count: index.node_count,
    nodes,
  };
};

/**
 * Decoded text of one reading segment, read from the untouched original by
 * its recorded byte range and the encoding the parser used.
 */
export const readDocumentSegment = async (
  folder: string,
  source: string,
  segmentIndex: number,
) => {
  const index = await readDocumentIndex(folder);
  const segment = index.segments[segmentIndex];
  if (segment === undefined)
    throw new HostedError(404, "That reading page does not exist.");
  const handle = await open(source, "r");
  try {
    const buffer = Buffer.alloc(segment.end - segment.start);
    const { bytesRead } = await handle.read(
      buffer,
      0,
      buffer.length,
      segment.start,
    );
    const encoding = textEncodingSchema.parse(index.encoding.name);
    const text = new TextDecoder(encoding, { ignoreBOM: true }).decode(
      buffer.subarray(0, bytesRead),
    );
    return {
      segment,
      segments: index.segments.length,
      profile: index.format.profile,
      encoding,
      text,
    };
  } finally {
    await handle.close();
  }
};
