import { createHash } from "node:crypto";

import type { OfficeContentPart } from "../../domain/officeDocument/officeDocument.js";
import type { DocumentReader } from "../reader.js";
import {
  checkpoint,
  LegacyFormatError,
  type LegacyReaderArgs,
} from "./legacy.js";
import {
  BIFF5,
  readWorkbook,
  type Substream,
  type Workbook,
} from "./xlsGlobals.js";
import { linkKind } from "./xlsLinks.js";
import { walkSheet } from "./xlsSheet.js";
import { formulaContext, readSharedStrings } from "./xlsStrings.js";

/**
 * Legacy Excel 97-2003 workbooks (BIFF8 in the Workbook stream, [MS-XLS]).
 * Opening reads the workbook globals and indexes the sheets, so the package
 * view gets its sheets, names, external links, hyperlinks and macro sheets
 * without reading cells; a sheet's cells are read when that sheet is walked.
 */

const MACRO_SHEET_NOTE =
  "An Excel 4.0 (XLM) macro sheet; its formulas are text, not run.";

const KINDS: ReadonlyMap<number, OfficeContentPart["kind"]> = new Map([
  [0x00, "worksheet"],
  [0x01, "macro-sheet"],
  [0x02, "chartsheet"],
]);

/** The BOF dt each BoundSheet8 dt expects ([MS-XLS] 2.4.21). */
const SUBSTREAM_DT: ReadonlyMap<number, number> = new Map([
  [0x00, 0x10],
  [0x01, 0x40],
  [0x02, 0x20],
]);

interface Sheet {
  readonly part: OfficeContentPart;
  readonly substream: Substream | null;
}

/** Content parts from the BoundSheet8 records; VBA module sheets and unknown types are not content. */
const listSheets = (
  workbook: Workbook,
  args: LegacyReaderArgs,
): { sheets: Sheet[]; modules: number } => {
  const sheets: Sheet[] = [];
  let modules = 0;
  for (const bound of workbook.boundSheets) {
    const kind = KINDS.get(bound.type);
    // A BoundSheet8 record that could not be read keeps its index and is already named in a diagnostic.
    if (bound.type === -1) continue;
    if (bound.type === 0x06) {
      modules += 1;
      continue;
    }
    if (kind === undefined) {
      args.counters.diagnose(
        bound.name,
        `The sheet has an unknown type (${String(bound.type)}); it is not read.`,
      );
      continue;
    }
    const substream = workbook.substreams.get(bound.position) ?? null;
    const label =
      bound.name === "" ? `Sheet ${String(sheets.length + 1)}` : bound.name;
    if (substream === null)
      args.counters.diagnose(
        label,
        `The sheet points at stream offset ${String(bound.position)}, where no sheet begins; it cannot be read.`,
      );
    else if (!substream.complete)
      args.counters.diagnose(
        label,
        "The sheet's records end without an EOF record; the stream may be cut off, and the sheet is read as far as it goes.",
      );
    else if (substream.dt !== SUBSTREAM_DT.get(bound.type))
      args.counters.diagnose(
        label,
        `The sheet is listed as a ${kind} but its substream begins as type 0x${substream.dt.toString(16)}.`,
      );
    sheets.push({
      part: {
        id: `sheet:${String(sheets.length + 1)}`,
        label,
        kind:
          kind === "worksheet" && substream?.dialog === true
            ? "dialog-sheet"
            : kind,
        hidden: bound.state !== 0,
      },
      substream,
    });
  }
  return { sheets, modules };
};

/** What the package view shows without reading cells: counts, macro sheets, links and hyperlinks. */
const declare = async (
  workbook: Workbook,
  sheets: readonly Sheet[],
  modules: number,
  args: LegacyReaderArgs,
): Promise<void> => {
  const { counters } = args;
  counters.set("sheets", sheets.length);
  counters.set(
    "hidden_sheets",
    sheets.filter((sheet) => sheet.part.hidden).length,
  );
  counters.set(
    "macro_sheets",
    sheets.filter((sheet) => sheet.part.kind === "macro-sheet").length,
  );
  counters.set("vba_module_sheets", modules);
  counters.set("defined_names", workbook.names.length);
  counters.set(
    "external_workbooks",
    workbook.supBooks.filter((book) => book.kind === "workbook").length,
  );
  for (const [at, book] of workbook.supBooks.entries()) {
    if (at % 4096 === 4095) await checkpoint(args.signal);
    if (book.target !== null && book.number !== null)
      args.external({
        source: "workbook",
        kind: book.kind === "workbook" ? "external-workbook" : linkKind(book),
        target: book.target,
        id: String(book.number),
      });
  }
  const seen = new Set<Substream>();
  for (const [at, sheet] of sheets.entries()) {
    if (at % 1024 === 1023) await checkpoint(args.signal);
    const substream = sheet.substream;
    if (substream === null) {
      if (sheet.part.kind === "macro-sheet")
        args.notable({
          kind: "macro-sheet",
          part: sheet.part.label,
          content_type: null,
          bytes: 0,
          sha256: null,
          note: `${MACRO_SHEET_NOTE} Its records cannot be found in the stream.`,
        });
      continue;
    }
    // Sheets that share one substream (a damaged or hostile file) are declared once.
    if (seen.has(substream)) continue;
    seen.add(substream);
    if (sheet.part.kind === "macro-sheet")
      args.notable({
        kind: "macro-sheet",
        part: sheet.part.label,
        content_type: null,
        bytes: substream.end - substream.start,
        sha256: createHash("sha256")
          .update(workbook.bytes.subarray(substream.start, substream.end))
          .digest("hex"),
        note: `${MACRO_SHEET_NOTE} SHA-256 is of its substream's records, BOF to EOF.`,
      });
    for (const link of substream.hyperlinks) {
      if (link.unread !== null)
        counters.diagnose(
          `${sheet.part.label}!${link.ref}`,
          `The hyperlink is ${link.unread}, which is not decoded.`,
        );
      if (link.assumedCodepage)
        counters.diagnose(
          `${sheet.part.label}!${link.ref}`,
          "The hyperlink's file path is in an unnamed ANSI code page; it was decoded as Windows-1252.",
        );
      if (link.target !== null)
        args.external({
          source: sheet.part.label,
          kind: "hyperlink",
          target: link.target,
          id: link.ref,
        });
    }
  }
  if (workbook.hyperlinksDropped > 0)
    counters.diagnose(
      null,
      `${String(workbook.hyperlinksDropped)} more hyperlinks were not read for the package view.`,
    );
};

export const openXls = async (
  args: LegacyReaderArgs,
): Promise<DocumentReader> => {
  const { streams, counters, signal } = args;
  const entry = streams.find(["Workbook"]);
  if (entry?.type !== "stream") {
    if (streams.find(["Book"])?.type === "stream")
      throw new LegacyFormatError(BIFF5);
    throw new LegacyFormatError("The file has no Workbook stream.");
  }
  const workbook = await readWorkbook(
    await streams.read(entry),
    counters,
    signal,
  );
  const { sheets, modules } = listSheets(workbook, args);
  await declare(workbook, sheets, modules, args);

  let strings: string[] | undefined;
  const context = formulaContext(workbook);
  return {
    family: "excel",
    contentParts: () => sheets.map((sheet) => sheet.part),
    defaultPart: () =>
      (sheets.find((sheet) => !sheet.part.hidden) ?? sheets[0])?.part,
    async forEach(part, visit) {
      const sheet = sheets.find((candidate) => candidate.part.id === part.id);
      if (sheet === undefined) return;
      if (sheet.part.kind === "chartsheet") {
        counters.omit(
          "chart-sheet",
          "A chart sheet holds a chart, which is not described.",
        );
        return;
      }
      if (sheet.substream === null) {
        counters.diagnose(
          part.label,
          "The sheet's records cannot be found in the Workbook stream.",
        );
        return;
      }
      strings ??= await readSharedStrings(workbook, counters, signal);
      await walkSheet({
        workbook,
        strings,
        context,
        start: sheet.substream.start,
        end: sheet.substream.end,
        counters,
        signal,
        visit,
      });
    },
  };
};
