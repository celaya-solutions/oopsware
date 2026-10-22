import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import { PDF_DOCUMENT_PROVIDER } from "../application/InvestigationProviders.js";
import type { PdfDocumentPort } from "../application/pdfDocument/PdfDocumentPort.js";
import { readStableArtifact } from "../artifacts/readStableArtifact.js";
import { stableReadFailure } from "../artifacts/stableReadFailure.js";
import { DecodeBudget, MemberReadFailure } from "../artifacts/zipMemberView.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
  AnalysisUnsupportedTargetError,
} from "../domain/analysisErrorCore.js";
import { ArtifactOperationError } from "../domain/artifactOperationError.js";
import type { FacetCoverage } from "../domain/formatRegistry.js";
import {
  resolvePdfLimit,
  type InspectPdfDocumentInput,
  type PdfDiagnostic,
  type PdfDocumentReport,
  type PdfLayoutPage,
  type PdfObjectRow,
  type PdfPageRow,
} from "../domain/pdfDocument/pdfDocument.js";
import { err, ok, type Result } from "../domain/result.js";
import { PdfDeadlineError, PdfEncryptedError, PdfFile } from "./file.js";
import {
  ANNOTATION_SCAN_PAGES,
  collectInventories,
  MAX_ANNOTATIONS_SCANNED,
  MAX_LISTED,
  type Inventories,
} from "./inventory.js";
import {
  parseTsv,
  PdftotextFailure,
  PdftotextUnavailable,
  resolvePdftotext,
  runPdftotext,
} from "./poppler.js";
import { CONTENT_SAMPLE_PAGES, PdfStructure } from "./structure.js";
import { PdfSyntaxError } from "./syntax.js";

const OPERATION = "inspect_pdf_document";

/** Largest single stream this reader will decode, whatever max_decoded_bytes allows. */
const MEMBER_LIMIT = 256 * 1024 ** 2;
/** Most JSON characters one page carries; a page always holds at least one row. */
const MAX_PAGE_BYTES = 2 * 1024 ** 2;

const LIMITATIONS: readonly string[] = [
  "The file's bytes are read in process: nothing is rendered, repaired, rewritten, executed or fetched. JavaScript, launch targets, URIs and form submission targets are listed as written and never run or followed; a script's text is evidence of what the file contains, not a safety verdict. Digital signatures are recorded with how far their byte ranges reach, never verified.",
  "An encrypted document is described (handler, method, key size, declared permissions) and refused for content: no password is tried and nothing is decrypted, so its metadata, text, attachments and page contents are not read. A document that opens without a password in a viewer can still be encrypted here.",
  "Page text comes from an admitted Poppler pdftotext run on a private copy, in Poppler's own layout order, which is not guaranteed to be reading order: columns, tables, sidebars and rotated text can interleave. Coordinates are points from the page's top-left corner. Text hidden by the file (invisible render mode, white or clipped text) is returned like any other. Characters a font cannot map to Unicode can come back wrong or missing. OCR is not run: a scanned page returns no text and the pages view names it image-only. Markdown characters that start a line of page text are escaped so a page cannot forge a heading or a note.",
  "Page kinds come from scanning each page's content stream for text-showing operators, image draws and paint operators, including form XObjects four levels deep; they describe what the stream draws, not what a viewer would show. Annotations, form field appearances, patterns and Type 3 glyph procedures are not scanned for text.",
  "The cross-reference chain is read as written; when it is missing or leads to a wrong offset the objects are found by scanning the file (bytes inside streams are skipped) and the report says so. Indirect references are matched by object number; the generation number is not compared. Objects in an unreferenced revision, and free objects, are not shown in the package view. Annotation inventories cover the first pages only; the pages view lists annotations per page.",
  "Parsing runs on the calling thread and is stopped between steps by cancellation or by timeout_ms; a single step (one decompression, one very long token) is bounded by size limits, not by the clock.",
];

const cancelled = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted === true) throw new AnalysisCancelledError(OPERATION);
};

const failure = (
  cause: unknown,
  input: InspectPdfDocumentInput,
  signal: AbortSignal | undefined,
): AnalysisError => {
  if (signal?.aborted === true)
    return new AnalysisCancelledError(OPERATION, { cause });
  if (
    cause instanceof AnalysisUnsupportedTargetError ||
    cause instanceof ArtifactOperationError ||
    cause instanceof AnalysisResourceConstraintError ||
    cause instanceof AnalysisCancelledError ||
    cause instanceof AnalysisCapabilityUnavailableError ||
    cause instanceof AnalysisTimeoutError
  )
    return cause;
  if (cause instanceof PdfDeadlineError)
    return new AnalysisTimeoutError(OPERATION, input.timeout_ms, { cause });
  if (cause instanceof PdftotextUnavailable)
    return new AnalysisCapabilityUnavailableError(
      "pdftotext",
      OPERATION,
      cause.message,
      { cause },
    );
  if (cause instanceof PdftotextFailure)
    return cause.reason === "timeout"
      ? new AnalysisTimeoutError(OPERATION, input.timeout_ms, { cause })
      : cause.reason === "too-large"
        ? new AnalysisResourceConstraintError(
            OPERATION,
            "memory",
            cause.message,
            { limit: input.limit ?? null },
            { cause, remediationAction: "Read fewer pages with limit." },
          )
        : new AnalysisUnsupportedTargetError(
            OPERATION,
            input.path,
            cause.message,
            { cause },
          );
  if (cause instanceof PdfEncryptedError || cause instanceof PdfSyntaxError)
    return new AnalysisUnsupportedTargetError(
      OPERATION,
      input.path,
      cause.message,
      { cause },
    );
  if (
    cause instanceof MemberReadFailure &&
    (cause.reason === "budget" || cause.reason === "size")
  )
    return new AnalysisResourceConstraintError(
      OPERATION,
      "memory",
      cause.message,
      { max_decoded_bytes: input.max_decoded_bytes },
      {
        cause,
        ...(cause.message.includes("max_decoded_bytes")
          ? { remediationAction: "Raise max_decoded_bytes (up to 2 GiB)." }
          : {}),
      },
    );
  return new ArtifactOperationError(
    OPERATION,
    "format",
    undefined,
    `The document could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
    { cause },
  );
};

const facet = (
  name: FacetCoverage["facet"],
  state: FacetCoverage["state"],
  rest: Partial<Omit<FacetCoverage, "facet" | "state">>,
): FacetCoverage => ({
  facet: name,
  state,
  examined: null,
  omitted: null,
  reason: null,
  continuation: null,
  ...rest,
});

const refusal = (
  path: string,
  bytes: Uint8Array,
): AnalysisUnsupportedTargetError => {
  const zip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  const ole = bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11;
  return new AnalysisUnsupportedTargetError(
    OPERATION,
    path,
    zip
      ? "The file has no %PDF- header in its first 1,024 bytes; it is a ZIP package. For a Word, Excel or PowerPoint document use inspect_office_document."
      : ole
        ? "The file has no %PDF- header in its first 1,024 bytes; it is an OLE compound file, not a PDF."
        : "The file has no %PDF- header in its first 1,024 bytes, so it is not read as a PDF.",
  );
};

/** Page text is untrusted: a line that starts with Markdown syntax is escaped so it cannot pose as a heading, list or note. */
const escapeLine = (line: string): string =>
  line.replace(/^(\s*)([#>*+\-|`~]|\d+[.)])/u, "$1\\$2");

/** Keeps a JSON page near the size budget: always takes the first item, then stops when the next would not fit. */
class Pager {
  cut = false;
  #bytes = 0;

  take(size: number): boolean {
    if (this.cut) return false;
    if (this.#bytes > 0 && this.#bytes + size > MAX_PAGE_BYTES) {
      this.cut = true;
      return false;
    }
    this.#bytes += size;
    return true;
  }
}

interface ViewState {
  pages: PdfPageRow[];
  objects: PdfObjectRow[];
  layout: PdfLayoutPage[];
  text: string[];
  total: number | null;
  returned: number;
  textTool: PdfDocumentReport["text_tool"];
  inventories: Inventories | null;
  metadata: PdfDocumentReport["metadata"];
  sample: PdfDocumentReport["content_sample"];
  pager: Pager;
}

interface Run {
  readonly input: InspectPdfDocumentInput;
  readonly signal: AbortSignal | undefined;
  readonly bytes: Uint8Array;
  readonly file: PdfFile;
  readonly structure: PdfStructure;
  readonly diagnostics: PdfDiagnostic[];
  readonly window: { start: number; end: number };
  readonly state: ViewState;
}

const packageView = ({ signal, file, structure, state }: Run): void => {
  state.inventories = collectInventories(structure);
  state.metadata = structure.metadata();
  if (file.encrypted) return;
  const byKind: Record<string, number> = {};
  let examined = 0;
  for (const entry of structure
    .pages()
    .entries.slice(0, CONTENT_SAMPLE_PAGES)) {
    cancelled(signal);
    if (structure.budgetHit) break;
    const row = structure.pageRow(entry, true);
    byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;
    examined += 1;
  }
  state.sample = { pages_examined: examined, by_kind: byKind };
};

const pagesView = ({ signal, file, structure, window, state }: Run): void => {
  const entries = structure.pages().entries;
  state.total = entries.length;
  for (const entry of entries.slice(window.start, window.end)) {
    cancelled(signal);
    const row = structure.pageRow(entry, !file.encrypted);
    if (!state.pager.take(JSON.stringify(row).length)) break;
    state.pages.push(row);
  }
  state.returned = state.pages.length;
};

const objectsView = ({ signal, file, structure, window, state }: Run): void => {
  const numbers = file.numbers();
  state.total = numbers.length;
  for (const number of numbers.slice(window.start, window.end)) {
    cancelled(signal);
    const row = structure.objectRow(number);
    if (!state.pager.take(JSON.stringify(row).length)) break;
    state.objects.push(row);
  }
  state.returned = state.objects.length;
};

const NO_TEXT: Readonly<Record<string, string>> = {
  "image-only":
    "No text layer: this page draws images only (likely scanned). OCR is not run.",
  blank: "This page draws nothing.",
};

const textView = async (run: Run): Promise<void> => {
  const { input, signal, structure, diagnostics, window, state } = run;
  if (run.file.encrypted)
    throw new AnalysisUnsupportedTargetError(
      OPERATION,
      input.path,
      "The document is encrypted. No password is tried and nothing is decrypted, so its text is not read; the package view describes the encryption.",
    );
  const tree = structure.pages();
  const entries = tree.entries;
  state.total = entries.length;
  const last = Math.min(window.end, entries.length);
  if (window.start >= last) return;
  const tool = await resolvePdftotext();
  state.textTool = {
    name: "pdftotext",
    version: tool.version,
    sha256: tool.sha256,
  };
  const ran = await runPdftotext({
    tool,
    bytes: run.bytes,
    first: window.start + 1,
    last,
    timeoutMs: input.timeout_ms,
    signal,
  });
  for (const warning of ran.warnings)
    diagnostics.push({ location: "pdftotext", message: warning });
  if (tree.irregular)
    diagnostics.push({
      location: null,
      message:
        "The page tree repeats a node or its Count is wrong. Poppler follows the declared tree and this reader the distinct pages, so a page's text may belong to a neighbouring page.",
    });
  const byIndex = new Map(parseTsv(ran.tsv).map((page) => [page.page, page]));
  for (let index = window.start; index < last; index += 1) {
    cancelled(signal);
    const found = byIndex.get(index);
    if (found === undefined)
      diagnostics.push({
        location: `page ${String(index + 1)}`,
        message: "pdftotext returned nothing for this page.",
      });
    const page: PdfLayoutPage = found ?? {
      page: index,
      width: 0,
      height: 0,
      words: 0,
      lines: [],
    };
    let note: string | null = null;
    if (page.words === 0) {
      const entry = entries[index];
      const row = entry === undefined ? null : structure.pageRow(entry, true);
      note =
        found === undefined
          ? "pdftotext returned nothing for this page."
          : (NO_TEXT[row?.kind ?? ""] ??
            "No text was extracted from this page.");
    }
    const lines = [
      `## Page ${String(index + 1)}`,
      ...(note === null
        ? page.lines.map((line) => escapeLine(line.text))
        : [`*${note}*`]),
      "",
    ];
    const size =
      input.view === "layout"
        ? JSON.stringify(page).length
        : lines.reduce((sum, line) => sum + line.length + 1, 0);
    if (!state.pager.take(size)) break;
    if (input.view === "layout") state.layout.push(page);
    else state.text.push(...lines);
    state.returned += 1;
  }
};

/** Where a list or walk stopped short, so a cap is never read as completeness. */
const capDiagnostics = (
  inventories: Inventories,
  structure: PdfStructure,
  metadata: PdfDocumentReport["metadata"],
): PdfDiagnostic[] => {
  const out: PdfDiagnostic[] = [];
  const add = (message: string) => out.push({ location: null, message });
  if (inventories.attachmentTotal > inventories.attachments.length)
    add(
      `${String(inventories.attachmentTotal)} attachments were found; the first ${String(MAX_LISTED)} are listed.`,
    );
  if (inventories.actionTotal > inventories.actions.length)
    add(
      `${String(inventories.actionTotal)} actions were found; the first ${String(MAX_LISTED)} are listed.`,
    );
  if (inventories.signatureTotal > inventories.signatures.length)
    add(
      `${String(inventories.signatureTotal)} signatures were found; the first ${String(MAX_LISTED)} are listed.`,
    );
  if (metadata !== null && metadata.info_total > metadata.info.length)
    add(
      `The Info dictionary has ${String(metadata.info_total)} entries; the first ${String(metadata.info.length)} are listed.`,
    );
  const pageCount = structure.pages().entries.length;
  if (inventories.annotationPagesScanned < pageCount)
    add(
      `Annotations were inventoried on the first ${String(inventories.annotationPagesScanned)} of ${String(pageCount)} pages (at most ${String(ANNOTATION_SCAN_PAGES)} pages and ${String(MAX_ANNOTATIONS_SCANNED)} annotations); the pages view lists the rest per page.`,
    );
  for (const note of inventories.notes) add(note);
  return out;
};

const coverageOf = (
  run: Run,
  facts: PdfDocumentReport["document"],
  budgetHit: boolean,
  next: number | null,
): FacetCoverage[] => {
  const { input, state, file } = run;
  const textual = input.view === "text" || input.view === "layout";
  const damaged =
    file.state === "rebuilt" ||
    file.state === "none" ||
    facts.problems.length > 0;
  const identified =
    "the header, cross-reference data, trailer and document catalog";
  const identify = damaged
    ? facet("identify", "partial", {
        examined: identified,
        omitted: "parts of the structure that could not be read",
        reason:
          "The structure needed repair or has problems; see document.problems.",
      })
    : facet("identify", "complete", { examined: identified });
  if (input.view === "package")
    return [
      identify,
      facet("inspect", "partial", {
        examined:
          "the file structure, metadata, attachments, actions and signatures, and the first pages' kinds",
        omitted:
          "page text, annotations on later pages, and the contents of attached files",
        reason:
          "The package view summarizes structure; page text is read with the text or layout view.",
        continuation:
          "Use view=pages for per-page detail and view=text or view=layout for text.",
      }),
    ];
  const { returned, pager } = state;
  if (budgetHit || next !== null || pager.cut)
    return [
      identify,
      facet("inspect", "partial", {
        examined: textual
          ? `pages ${String(input.start + 1)} to ${String(input.start + returned)}`
          : `rows ${String(input.start)} to ${String(input.start + returned)}`,
        omitted:
          input.view === "pages" || input.view === "objects"
            ? "later rows"
            : "later pages",
        reason: budgetHit
          ? "The decompression budget ran out."
          : pager.cut
            ? `The page was cut near ${String(MAX_PAGE_BYTES)} characters.`
            : "The page is not the whole result.",
        continuation: budgetHit
          ? "Raise max_decoded_bytes (up to 2 GiB)."
          : next === null
            ? null
            : `Pass start=${String(next)} for the next page.`,
      }),
    ];
  return [
    identify,
    textual
      ? facet("inspect", "partial", {
          examined: "all requested pages",
          omitted: "reading order, and text a font cannot map to Unicode",
          reason:
            "Text is Poppler's layout reading, not a guarantee of reading order; scanned pages have no text layer.",
        })
      : facet("inspect", "complete", { examined: "all rows" }),
  ];
};

export class PdfDocumentProvider implements PdfDocumentPort {
  readonly identity = PDF_DOCUMENT_PROVIDER;

  async inspectDocument(
    input: InspectPdfDocumentInput,
    options?: ExecutionOptions,
  ): Promise<Result<PdfDocumentReport, AnalysisError>> {
    const signal = options?.signal;
    try {
      return ok(await this.#inspect(input, signal));
    } catch (cause) {
      return err(failure(cause, input, signal));
    }
  }

  async #inspect(
    input: InspectPdfDocumentInput,
    signal: AbortSignal | undefined,
  ): Promise<PdfDocumentReport> {
    let snapshot: Awaited<ReturnType<typeof readStableArtifact>>;
    try {
      snapshot = await readStableArtifact(
        input.path,
        input.max_file_bytes,
        signal,
      );
    } catch (cause) {
      throw stableReadFailure(OPERATION, input.path, cause, {
        cancelled: signal?.aborted === true,
        maxFileBytes: input.max_file_bytes,
        remediationAction:
          "Raise max_file_bytes (up to 1 GiB) or read a smaller document.",
      });
    }
    cancelled(signal);
    const head = Buffer.from(
      snapshot.bytes.buffer,
      snapshot.bytes.byteOffset,
      Math.min(snapshot.bytes.length, 1024),
    );
    if (head.indexOf("%PDF-") < 0) throw refusal(input.path, snapshot.bytes);

    const limit = resolvePdfLimit(input.view, input.limit);
    const budget = new DecodeBudget(input.max_decoded_bytes, MEMBER_LIMIT);
    const file = PdfFile.open(snapshot.bytes, budget, {
      signal,
      deadline: Date.now() + input.timeout_ms,
    });
    const run: Run = {
      input,
      signal,
      bytes: snapshot.bytes,
      file,
      structure: new PdfStructure(file),
      diagnostics: [],
      window: { start: input.start, end: input.start + limit },
      state: {
        pages: [],
        objects: [],
        layout: [],
        text: [],
        total: null,
        returned: 0,
        textTool: null,
        inventories: null,
        metadata: null,
        sample: null,
        pager: new Pager(),
      },
    };
    switch (input.view) {
      case "package":
        packageView(run);
        break;
      case "pages":
        pagesView(run);
        break;
      case "objects":
        objectsView(run);
        break;
      case "text":
      case "layout":
        await textView(run);
        break;
    }
    cancelled(signal);

    const { structure, diagnostics, state } = run;
    const { inventories } = state;
    const facts = structure.facts(budget.used);
    if (inventories?.form != null) facts.form = inventories.form;
    const budgetHit = structure.budgetHit || (inventories?.budgetHit ?? false);
    if (budgetHit)
      diagnostics.push({
        location: null,
        message:
          "The decompression budget ran out; some streams were not decoded (max_decoded_bytes).",
      });
    if (file.encrypted && input.view === "pages")
      diagnostics.push({
        location: null,
        message:
          "The document is encrypted; page content and annotation details are not read.",
      });
    if (inventories !== null)
      diagnostics.push(
        ...capDiagnostics(inventories, structure, state.metadata),
      );

    const { total, returned } = state;
    const next =
      total !== null && input.start + returned < total && returned > 0
        ? input.start + returned
        : null;
    return {
      artifact: {
        path: input.path,
        sha256: snapshot.sha256,
        bytes: snapshot.bytes.length,
      },
      document: facts,
      metadata: state.metadata,
      attachments: inventories?.attachments ?? [],
      attachment_total: inventories?.attachmentTotal ?? 0,
      actions: inventories?.actions ?? [],
      action_total: inventories?.actionTotal ?? 0,
      signatures: inventories?.signatures ?? [],
      signature_total: inventories?.signatureTotal ?? 0,
      content_sample: state.sample,
      view: input.view,
      total,
      page: { start: input.start, limit, returned, next },
      pages: state.pages,
      objects: state.objects,
      layout: state.layout,
      text: state.text,
      text_tool: state.textTool,
      diagnostics,
      coverage: coverageOf(run, facts, budgetHit, next),
      limitations: [...LIMITATIONS],
    };
  }
}
