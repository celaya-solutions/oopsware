import { basename } from "node:path";

import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import { OFFICE_DOCUMENT_PROVIDER } from "../application/InvestigationProviders.js";
import type { OfficeDocumentPort } from "../application/officeDocument/OfficeDocumentPort.js";
import { readStableArtifact } from "../artifacts/readStableArtifact.js";
import { stableReadFailure } from "../artifacts/stableReadFailure.js";
import { DecodeBudget, MemberReadFailure } from "../artifacts/zipMemberView.js";
import { CompoundFile } from "../windowsInstaller/cfb.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
  AnalysisUnsupportedTargetError,
} from "../domain/analysisErrorCore.js";
import { ArtifactOperationError } from "../domain/artifactOperationError.js";
import type { FacetCoverage } from "../domain/formatRegistry.js";
import type {
  InspectOfficeDocumentInput,
  OfficeContentPart,
  OfficeDocumentReport,
  OfficeItem,
  OfficePackage,
} from "../domain/officeDocument/officeDocument.js";
import { err, ok, type Result } from "../domain/result.js";
import { openDocx } from "./docx.js";
import {
  MAX_XML_PART_BYTES,
  OpcPackage,
  PackageFormatError,
} from "./package.js";
import { summarizePackage } from "./packageSummary.js";
import { openPptx } from "./pptx.js";
import { ReaderCounters, type DocumentReader } from "./reader.js";
import {
  LegacyEncryptedError,
  LegacyFormatError,
  LegacyStreams,
  type LegacyReaderArgs,
} from "./legacy/legacy.js";
import {
  collectorSinks,
  displayPath,
  newCollected,
  summarizeLegacy,
  type LegacyKind,
} from "./legacy/legacyPackage.js";
import { openDoc } from "./legacy/doc.js";
import { openPpt } from "./legacy/ppt.js";
import { openXls } from "./legacy/xls.js";
import { renderMarkdown } from "./render.js";
import { openXlsx } from "./xlsx.js";

const OPERATION = "inspect_office_document";

const LIMITATIONS: readonly string[] = [
  "Office Open XML here: Word, Excel and PowerPoint documents, templates, add-ins and their macro-enabled variants. Binary workbooks (.xlsb) and PDF are not read by this tool, and a password-protected document is refused: no password is tried.",
  "Nothing is opened in an application, recalculated, converted or run. A VBA project, OLE object or ActiveX control is listed with its hash, never executed or unpacked; its presence is a declaration, not a safety verdict. Package signatures are recorded, not verified.",
  "Relationships that point outside the package (linked templates, hyperlinks, linked images and objects, external workbook links) are listed as written and are never fetched.",
  "Text is a derived reading in document order. Layout, styles, pictures, charts, shapes, text boxes, diagrams and equation structure are not preserved; the omissions list says what each read left out. Word: inserted tracked text is included, deleted tracked text is not, and hidden text is included and flagged. Excel: a formula and its cached value are separate fields, the cached value may be stale, and dates are derived from the cell's number format. PowerPoint: text is read in shape order, not reading order.",
  "A part, sheet or slide that cannot be decoded is named in diagnostics and the rest is still read. Counts in the package view describe what this call read.",
];

/** Largest single stream a legacy document's real files need (a Word or Excel main stream). */
const MAX_STREAM_BYTES = 1024 ** 3;

const LEGACY_LIMITATIONS: readonly string[] = [
  "Legacy Word, Excel and PowerPoint 97-2003 binary files only, read from their bytes. A password-protected or encrypted document is refused: no password is tried. Word 6/95, Excel 5/95 and earlier formats are named and not read.",
  "Nothing is opened in an application, recalculated, converted or run. A VBA project, Excel 4.0 macro sheet, embedded OLE object or package is listed with its hash where one can be taken, never executed or unpacked; its presence is a declaration, not a safety verdict. Signatures are recorded, not verified.",
  "References that point outside the document (hyperlinks, linked files, external workbooks) are listed as written and are never fetched.",
  "Text is a derived reading in document order. Layout, styles, pictures, charts, drawings, text boxes and equation structure are not preserved; the omissions list says what each read left out. Excel: a formula and its cached value are separate fields, the cached value may be stale, and dates come from the cell's number format. PowerPoint: text is read in shape order, not reading order.",
  "A stream, sheet or slide that cannot be decoded is named in diagnostics and the rest is still read. Counts in the package view describe what this call read.",
];

const EMPTY_READER: DocumentReader = {
  family: "word",
  contentParts: () => [],
  defaultPart: () => undefined,
  forEach: async () => {},
};

/** Most JSON characters one page carries; a page always holds at least one item. */
const MAX_PAGE_BYTES = 2 * 1024 ** 2;

const OOXML_ZIP = [0x50, 0x4b];
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

const startsWith = (bytes: Uint8Array, magic: readonly number[]): boolean =>
  magic.every((byte, at) => bytes[at] === byte);

const ENCRYPTED_PACKAGE =
  "The document is password-protected (an encrypted Office Open XML package inside an OLE compound file). No password is tried and nothing is decrypted.";

const refusal = (path: string): AnalysisUnsupportedTargetError =>
  new AnalysisUnsupportedTargetError(
    OPERATION,
    path,
    "The file is neither a ZIP package (Office Open XML) nor an OLE compound file (legacy Word, Excel or PowerPoint), so it is not an Office document this tool reads.",
  );

const cancelled = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted === true) throw new AnalysisCancelledError(OPERATION);
};

const failure = (
  cause: unknown,
  input: InspectOfficeDocumentInput,
  signal: AbortSignal | undefined,
): AnalysisError => {
  if (signal?.aborted === true)
    return new AnalysisCancelledError(OPERATION, { cause });
  if (
    cause instanceof AnalysisUnsupportedTargetError ||
    cause instanceof AnalysisInputError ||
    cause instanceof ArtifactOperationError ||
    cause instanceof AnalysisResourceConstraintError ||
    cause instanceof AnalysisCancelledError
  )
    return cause;
  if (cause instanceof LegacyEncryptedError)
    return new AnalysisUnsupportedTargetError(
      OPERATION,
      input.path,
      cause.message,
    );
  if (cause instanceof PackageFormatError || cause instanceof LegacyFormatError)
    return new AnalysisUnsupportedTargetError(
      OPERATION,
      input.path,
      cause.message,
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

const openReader = async (
  kind: string,
  pack: OpcPackage,
  mainPart: string,
  counters: ReaderCounters,
  signal: AbortSignal | undefined,
): Promise<DocumentReader> => {
  const args = { pack, mainPart, counters, signal };
  switch (kind) {
    case "docx":
    case "dotx":
    case "docm":
    case "dotm":
      return await openDocx(args);
    case "xlsx":
    case "xltx":
    case "xlsm":
    case "xltm":
    case "xlam":
      return await openXlsx(args);
    case "pptx":
    case "potx":
    case "pptm":
    case "potm":
    case "ppsx":
    case "ppsm":
    case "ppam":
      return await openPptx(args);
    case "xlsb":
      counters.diagnose(
        mainPart,
        "A binary workbook (BIFF12 .xlsb) stores its cells in binary records; this reader decodes XML parts only.",
      );
      return EMPTY_READER;
    default:
      return EMPTY_READER;
  }
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

type Snapshot = Awaited<ReturnType<typeof readStableArtifact>>;

interface PartRow {
  readonly path: string;
  readonly content_type: string | null;
  readonly bytes: number;
  readonly encrypted: boolean;
}

/** What the shared paging and coverage code needs, whichever container the document came from. */
interface Assembly {
  readonly input: InspectOfficeDocumentInput;
  readonly snapshot: Snapshot;
  readonly signal: AbortSignal | undefined;
  readonly reader: DocumentReader;
  readonly counters: ReaderCounters;
  /** The package facts after the content was read, so readers' own findings are included. */
  readonly facts: () => Omit<OfficePackage, "decoded_bytes" | "statistics">;
  readonly partRows: readonly PartRow[];
  readonly containerProblems: () => {
    list: readonly string[];
    dropped: number;
  };
  readonly decodedBytes: () => number;
  readonly limitations: readonly string[];
  readonly identified: string;
}

const openLegacyReader = async (
  kind: LegacyKind,
  args: LegacyReaderArgs,
): Promise<DocumentReader> => {
  switch (kind) {
    case "doc":
      return await openDoc(args);
    case "xls":
      return await openXls(args);
    case "ppt":
      return await openPpt(args);
  }
};

export class OfficeDocumentProvider implements OfficeDocumentPort {
  readonly identity = OFFICE_DOCUMENT_PROVIDER;

  async inspectDocument(
    input: InspectOfficeDocumentInput,
    options?: ExecutionOptions,
  ): Promise<Result<OfficeDocumentReport, AnalysisError>> {
    const signal = options?.signal;
    try {
      return ok(await this.#inspect(input, signal));
    } catch (cause) {
      return err(failure(cause, input, signal));
    }
  }

  async #inspect(
    input: InspectOfficeDocumentInput,
    signal: AbortSignal | undefined,
  ): Promise<OfficeDocumentReport> {
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
    if (startsWith(snapshot.bytes, OLE_MAGIC))
      return await this.#inspectLegacy(input, snapshot, signal);
    if (!startsWith(snapshot.bytes, OOXML_ZIP)) throw refusal(input.path);

    const budget = new DecodeBudget(
      input.max_decoded_bytes,
      MAX_XML_PART_BYTES,
    );
    const pack = await OpcPackage.open(snapshot.bytes, budget, signal);
    try {
      const counters = new ReaderCounters();
      const summary = await summarizePackage(
        pack,
        basename(input.path),
        counters,
        signal,
      );
      const reader =
        summary.mainPart === null
          ? EMPTY_READER
          : await openReader(
              summary.kind,
              pack,
              summary.mainPart,
              counters,
              signal,
            );
      return await this.#assemble({
        input,
        snapshot,
        signal,
        reader,
        counters,
        facts: () => summary.package,
        partRows: pack.parts.map((part) => ({
          path: part.path,
          content_type: part.contentType,
          bytes: part.bytes,
          encrypted: part.encrypted,
        })),
        containerProblems: () => ({
          list: pack.problems,
          dropped: pack.problemsDropped,
        }),
        decodedBytes: () => budget.used,
        limitations: LIMITATIONS,
        identified:
          "the package's content types, relationships, main part and properties",
      });
    } finally {
      await pack.close();
    }
  }

  async #inspectLegacy(
    input: InspectOfficeDocumentInput,
    snapshot: Snapshot,
    signal: AbortSignal | undefined,
  ): Promise<OfficeDocumentReport> {
    const bytes = snapshot.bytes;
    let file: CompoundFile;
    try {
      file = await CompoundFile.open(
        async (offset, length) => bytes.subarray(offset, offset + length),
        bytes.length,
      );
    } catch (cause) {
      throw new AnalysisUnsupportedTargetError(
        OPERATION,
        input.path,
        `The file starts like an OLE compound file but its container cannot be read: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    if (
      file.entries.some(
        (entry) =>
          entry.type === "stream" &&
          entry.path.length === 1 &&
          entry.name === "EncryptedPackage",
      )
    )
      throw new LegacyEncryptedError(ENCRYPTED_PACKAGE);
    const budget = new DecodeBudget(input.max_decoded_bytes, MAX_STREAM_BYTES);
    const streams = new LegacyStreams(file, budget);
    const counters = new ReaderCounters();
    const collected = newCollected();
    const summary = await summarizeLegacy(
      streams,
      basename(input.path),
      file.problems,
      counters,
      collected,
      signal,
    );
    if (summary === null)
      throw new AnalysisUnsupportedTargetError(
        OPERATION,
        input.path,
        "The file is an OLE compound file that is not a Word, Excel or PowerPoint 97-2003 document (it has no WordDocument, Workbook or PowerPoint Document stream).",
      );
    const reader = await openLegacyReader(summary.kind, {
      streams,
      counters,
      signal,
      ...collectorSinks(collected, counters),
    });
    return await this.#assemble({
      input,
      snapshot,
      signal,
      reader,
      counters,
      facts: () => summary.finish(),
      partRows: file.entries
        .filter((entry) => entry.type !== "root")
        .map((entry) => ({
          path: displayPath(entry),
          content_type: null,
          bytes: entry.size,
          encrypted: false,
        })),
      containerProblems: () => ({ list: [], dropped: 0 }),
      decodedBytes: () => budget.used,
      limitations: LEGACY_LIMITATIONS,
      identified:
        "the compound file's directory, main stream, document properties and embedded storages",
    });
  }

  async #assemble(a: Assembly): Promise<OfficeDocumentReport> {
    const { input, snapshot, signal, reader, counters } = a;
    const parts = reader.contentParts();

    let selected: OfficeContentPart | null = null;
    if (input.view === "content" || input.view === "text") {
      selected =
        input.part === undefined
          ? (reader.defaultPart() ?? null)
          : (parts.find((part) => part.id === input.part) ?? null);
      if (input.part !== undefined && selected === null)
        throw new AnalysisInputError(OPERATION, undefined, [
          {
            path: ["part"],
            reason: "invalid_value",
            message: `This document has no content part ${input.part}. Choose one of: ${parts.map((part) => part.id).join(", ") || "(none)"}.`,
          },
        ]);
    }

    const window = { start: input.start, end: input.start + input.limit };
    const items: OfficeItem[] = [];
    const lines: string[] = [];
    let total: number | null = null;
    let count = 0;
    let pageBytes = 0;
    let cut = false;
    // Items already in the window are kept until the page is full; the next page starts after them.
    const take = (size: number): boolean => {
      if (cut) return false;
      if (pageBytes > 0 && pageBytes + size > MAX_PAGE_BYTES) {
        cut = true;
        return false;
      }
      pageBytes += size;
      return true;
    };

    if (input.view === "package") {
      // The package view counts what the document holds; sheets are not scanned (they can be huge).
      for (const part of parts)
        if (reader.family !== "excel") await reader.forEach(part, () => {});
    } else if (input.view === "parts") {
      total = a.partRows.length;
    } else if (selected !== null) {
      await reader.forEach(selected, (item) => {
        if (input.view === "content") {
          if (
            count >= window.start &&
            count < window.end &&
            take(JSON.stringify(item).length)
          )
            items.push(item);
          count += 1;
        } else {
          for (const line of renderMarkdown(item)) {
            if (
              count >= window.start &&
              count < window.end &&
              take(line.length + 1)
            )
              lines.push(line);
            count += 1;
          }
        }
      });
      total = count;
    }
    cancelled(signal);

    const partRows =
      input.view === "parts" ? a.partRows.slice(window.start, window.end) : [];
    const returned =
      input.view === "parts"
        ? partRows.length
        : input.view === "content"
          ? items.length
          : lines.length;
    const next =
      total !== null && input.start + returned < total
        ? input.start + returned
        : null;

    const diagnostics = [...counters.diagnostics];
    const readDone = input.view === "content" || input.view === "text";
    const container = a.containerProblems();
    const facts = a.facts();
    for (const problem of container.list) {
      if (!facts.problems.includes(problem)) facts.problems.push(problem);
      // A problem found while reading affects what the content view could show.
      if (readDone) diagnostics.push({ location: null, message: problem });
    }
    if (container.dropped > 0)
      facts.problems.push(
        `${String(container.dropped)} more problems were not listed.`,
      );
    if (counters.diagnosticsDropped > 0)
      diagnostics.push({
        location: null,
        message: `${String(counters.diagnosticsDropped)} more diagnostics were not listed.`,
      });
    const budgetHit = diagnostics.some((entry) =>
      entry.message.includes("max_decoded_bytes"),
    );
    const omissions = counters.omissions;

    const coverage: FacetCoverage[] = [
      facet("identify", "complete", {
        examined: a.identified,
      }),
      readDone && selected === null
        ? facet("inspect", "partial", {
            examined: "the package structure",
            omitted: "document content",
            reason:
              "This document has no readable content part; see the package problems.",
          })
        : diagnostics.length > 0 || budgetHit
          ? facet("inspect", "partial", {
              examined: readDone
                ? `${selected?.label ?? "the selected part"}, as far as it could be decoded`
                : "the package structure",
              omitted: "parts listed in diagnostics",
              reason: budgetHit
                ? "The decompression budget ran out."
                : "Some parts could not be decoded; see diagnostics.",
              continuation: budgetHit
                ? "Raise max_decoded_bytes (up to 2 GiB)."
                : null,
            })
          : readDone && next === null
            ? facet(
                "inspect",
                omissions.length > 0 ? "partial" : "complete",
                omissions.length > 0
                  ? {
                      examined: `${selected?.label ?? "the selected part"}, all items`,
                      omitted: omissions.map((entry) => entry.kind).join(", "),
                      reason:
                        "Some content is counted but not described; see omissions.",
                    }
                  : {
                      examined: `${selected?.label ?? "the selected part"}, all items`,
                    },
              )
            : facet("inspect", "partial", {
                examined: readDone
                  ? `${selected?.label ?? "the selected part"}, rows ${String(input.start)} to ${String(input.start + returned)}`
                  : input.view === "parts"
                    ? `parts ${String(input.start)} to ${String(input.start + returned)}`
                    : "the package structure, properties, notable parts and external references",
                omitted: readDone
                  ? "later items"
                  : input.view === "parts"
                    ? "later parts"
                    : "document content",
                reason:
                  input.view === "package"
                    ? "The package view summarizes structure; content is read with the content or text view."
                    : cut
                      ? `The page was cut near ${String(MAX_PAGE_BYTES)} characters.`
                      : "The page is not the whole result.",
                continuation:
                  next !== null
                    ? `Pass start=${String(next)} for the next page.`
                    : input.view === "package"
                      ? "Use view=content or view=text."
                      : null,
              }),
    ];

    return {
      artifact: {
        path: input.path,
        sha256: snapshot.sha256,
        bytes: snapshot.bytes.length,
      },
      package: {
        ...facts,
        decoded_bytes: a.decodedBytes(),
        statistics: counters.counts,
      },
      content_parts: [...parts],
      view: input.view,
      part: selected,
      total,
      page: {
        start: input.start,
        limit: input.limit,
        returned,
        next,
      },
      parts: partRows,
      items,
      text: lines,
      omissions: readDone ? omissions : [],
      diagnostics,
      coverage,
      limitations: [...a.limitations],
    };
  }
}
