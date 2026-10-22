import { MemberReadFailure } from "../../artifacts/zipMemberView.js";
import type {
  OfficeContentPart,
  OfficeItem,
} from "../../domain/officeDocument/officeDocument.js";
import {
  capText,
  type DocumentReader,
  type ReaderCounters,
} from "../reader.js";
import { Blocks, itemText } from "./docBlocks.js";
import { FC, readFib, type StoryCounts } from "./docFib.js";
import {
  chpxPage,
  expandHugePapx,
  papxPage,
  readFkpRuns,
  type FcRun,
} from "./docFkp.js";
import type { ParaSprms } from "./docProps.js";
import { readPieces, type Piece } from "./docPieces.js";
import {
  attachedTemplate,
  readStoryIndex,
  type Range,
  type StoryIndex,
} from "./docStories.js";
import { readStyles } from "./docStyles.js";
import { segments, type TextSource } from "./docText.js";
import { walkStory, type WalkContext } from "./docWalk.js";
import {
  LegacyFormatError,
  checkpoint,
  type LegacyReaderArgs,
} from "./legacy.js";

/**
 * Word 97-2003 documents ([MS-DOC]): the FIB, piece table, property pages,
 * stylesheet and story index are read once; each content part is walked on
 * demand from its story (main text, comments, footnotes, endnotes, headers and
 * footers). Text boxes, pictures, drawn objects and embedded objects are
 * counted and named as omissions, never decoded. Fields are recorded as
 * written and never evaluated; hyperlinks are listed, never followed.
 */

const TEXT_BOX_NOTE = "Text inside text boxes is not read.";

type Visit = (item: OfficeItem) => void;

interface DocState {
  /** Header text boxes are counted once, by whichever header or footer walk runs first. */
  headerBoxesCounted: boolean;
  readonly ccp: StoryCounts;
  readonly index: StoryIndex;
  readonly source: TextSource;
  readonly context: WalkContext;
  readonly counters: ReaderCounters;
  readonly signal: AbortSignal | undefined;
}

const part = (
  id: string,
  label: string,
  kind: OfficeContentPart["kind"],
): OfficeContentPart => ({ id, label, kind, hidden: false });

const contentParts = (
  ccp: StoryCounts,
  index: StoryIndex,
): OfficeContentPart[] => {
  const parts = [part("body", "Document body", "body")];
  if (ccp.atn > 0) parts.push(part("comments", "Comments", "comments"));
  if (ccp.ftn > 0) parts.push(part("footnotes", "Footnotes", "footnotes"));
  if (ccp.edn > 0) parts.push(part("endnotes", "Endnotes", "endnotes"));
  if (index.headerFallback)
    parts.push(part("header", "Headers and footers", "header"));
  else {
    if (index.headers.length > 0)
      parts.push(part("header", "Headers", "header"));
    if (index.footers.length > 0)
      parts.push(part("footer", "Footers", "footer"));
  }
  return parts;
};

/** Walk one range into paragraph and table items. */
const blocks = async (
  state: DocState,
  range: Range,
  source: string,
  sink: { visit: Visit; next: () => number; count: boolean },
): Promise<void> => {
  const assembler = new Blocks(state.counters, range.label, sink);
  await walkStory(
    await segments(state.source, range.from, range.to, range.label),
    state.context,
    source,
    (record) => assembler.add(record),
  );
  assembler.finish();
};

/** A comment's or note's text: its paragraphs (and flattened tables) as lines. */
const text = async (
  state: DocState,
  range: Range,
  source: string,
): Promise<string> => {
  const lines: string[] = [];
  await blocks(state, range, source, {
    visit: (item) => lines.push(itemText(item)),
    next: () => 0,
    count: false,
  });
  return capText(lines.join("\n"), state.counters);
};

const walkNotes = async (
  state: DocState,
  id: "footnotes" | "endnotes",
  visit: Visit,
  next: () => number,
): Promise<void> => {
  const ranges =
    id === "footnotes" ? state.index.footnotes : state.index.endnotes;
  const from = id === "footnotes" ? state.index.base.ftn : state.index.base.edn;
  const length = id === "footnotes" ? state.ccp.ftn : state.ccp.edn;
  if (ranges === null) {
    await blocks(state, { from, to: from + length, label: id }, id, {
      visit,
      next,
      count: false,
    });
    return;
  }
  for (const [at, range] of ranges.entries()) {
    if (at % 256 === 255) await checkpoint(state.signal);
    state.counters.add(id);
    visit({
      kind: "note",
      index: next(),
      location: range.label,
      id: String(at + 1),
      text: await text(state, range, id),
    });
  }
};

const walkComments = async (
  state: DocState,
  visit: Visit,
  next: () => number,
): Promise<void> => {
  const comments = state.index.comments;
  if (comments === null) {
    const from = state.index.base.atn;
    await blocks(
      state,
      { from, to: from + state.ccp.atn, label: "comments" },
      "comments",
      { visit, next, count: false },
    );
    return;
  }
  for (const [at, comment] of comments.entries()) {
    if (at % 256 === 255) await checkpoint(state.signal);
    state.counters.add("comments");
    visit({
      kind: "comment",
      index: next(),
      location: comment.label,
      id: String(at + 1),
      author: comment.author,
      date: comment.date,
      text: await text(state, comment, "comments"),
    });
  }
};

const walkHeaders = async (
  state: DocState,
  id: "header" | "footer",
  visit: Visit,
  next: () => number,
): Promise<void> => {
  const sink = { visit, next, count: true };
  if (state.index.headerFallback) {
    const from = state.index.base.hdd;
    await blocks(
      state,
      { from, to: from + state.ccp.hdd, label: "header" },
      id,
      sink,
    );
  } else
    for (const range of id === "header"
      ? state.index.headers
      : state.index.footers)
      await blocks(state, range, id, sink);
  if (!state.headerBoxesCounted && state.index.headerBoxes > 0)
    state.counters.omit("text-box", TEXT_BOX_NOTE, state.index.headerBoxes);
  state.headerBoxesCounted = true;
};

/**
 * What the reader declares once per call: the comment story (inside the
 * WordDocument stream) as notable, the attached template as an external
 * reference, and header text boxes when no header or footer part will count
 * them. Returns whether a header or footer walk still has to count them.
 */
const declareAtOpen = (
  args: LegacyReaderArgs,
  found: {
    readonly index: StoryIndex;
    readonly pieces: readonly Piece[];
    readonly parts: readonly OfficeContentPart[];
    readonly template: string | null;
    readonly tableName: string;
  },
): boolean => {
  const { index, pieces, parts, template } = found;
  if (index.comments !== null && index.comments.length > 0) {
    let bytes = 0;
    for (const piece of pieces)
      bytes +=
        Math.max(
          0,
          Math.min(piece.end, index.base.edn) -
            Math.max(piece.cp, index.base.atn),
        ) * piece.width;
    args.notable({
      kind: "comments",
      part: "WordDocument",
      content_type: null,
      bytes,
      sha256: null,
      note: `${String(index.comments.length)} comments in the document's comment story; they are read in the comments content part.`,
    });
  }
  if (template !== null)
    args.external({
      source: found.tableName,
      kind: "attached-template",
      target: template,
      id: "SttbfAssoc:1",
    });
  const headerWalk = parts.some(
    (entry) => entry.kind === "header" || entry.kind === "footer",
  );
  if (!headerWalk && index.headerBoxes > 0)
    args.counters.omit("text-box", TEXT_BOX_NOTE, index.headerBoxes);
  return headerWalk;
};

/** Paragraph property runs, with those too large for their page read from the Data stream; null when unreadable. */
const paragraphRuns = async (
  args: LegacyReaderArgs,
  pages: Parameters<typeof readFkpRuns>[0],
  entry: { fc: number; lcb: number } | null,
): Promise<FcRun<ParaSprms>[] | null> => {
  const runs = await readFkpRuns(pages, entry, "PlcfBtePapx", papxPage);
  if (runs === null) {
    args.counters.diagnose(
      "PlcfBtePapx",
      "Paragraph properties are not available; tables are not recognised (cell marks end paragraphs), and styles, headings and list levels are not known.",
    );
    return null;
  }
  if (!runs.some((run) => run.props.huge !== undefined)) return runs;
  // The Data stream mostly holds pictures: only the property blocks named are read and charged.
  const dataEntry = args.streams.find(["Data"]);
  let failed = false;
  const read =
    dataEntry?.type !== "stream"
      ? null
      : async (ranges: readonly { offset: number; length: number }[]) => {
          try {
            return failed
              ? []
              : await args.streams.readRanges(dataEntry, ranges);
          } catch (cause) {
            if (
              cause instanceof MemberReadFailure &&
              cause.reason === "cancelled"
            )
              throw cause;
            failed = true;
            args.counters.diagnose(
              "Data",
              `The Data stream was not read: ${cause instanceof Error ? cause.message : String(cause)}`,
            );
            return [];
          }
        };
  return await expandHugePapx(runs, read, args.counters, args.signal);
};

export const openDoc = async (
  args: LegacyReaderArgs,
): Promise<DocumentReader> => {
  const { streams, counters, signal } = args;
  const wordEntry = streams.find(["WordDocument"]);
  if (wordEntry?.type !== "stream")
    throw new LegacyFormatError("The file has no WordDocument stream.");
  const word = await streams.read(wordEntry);
  const fib = readFib(word);
  for (const problem of fib.problems) counters.diagnose("FIB", problem);
  if (fib.template) counters.set("template", 1);
  const tableEntry = streams.find([fib.tableName]);
  if (tableEntry?.type !== "stream")
    throw new LegacyFormatError(
      `The file information block names the ${fib.tableName} stream, which the file does not have.`,
    );
  const table = await streams.read(tableEntry);
  const pieces = await readPieces(fib, table, word.length, {
    counters,
    signal,
  });
  const pages = { table, word, counters, signal };
  const chpRuns = await readFkpRuns(
    pages,
    fib.fcLcb(FC.plcfBteChpx),
    "PlcfBteChpx",
    chpxPage,
  );
  if (chpRuns === null)
    counters.diagnose(
      "PlcfBteChpx",
      "Character properties are not available; hidden text, tracked changes and embedded objects are not recognised.",
    );
  const papRuns = await paragraphRuns(args, pages, fib.fcLcb(FC.plcfBtePapx));
  const index = readStoryIndex(fib, table, counters);
  const parts = contentParts(fib.ccp, index);
  const headerWalk = declareAtOpen(args, {
    index,
    pieces,
    parts,
    template: attachedTemplate(table, fib.fcLcb(FC.sttbfAssoc)),
    tableName: fib.tableName,
  });
  const state: DocState = {
    headerBoxesCounted: !headerWalk,
    ccp: fib.ccp,
    index,
    counters,
    signal,
    source: { word, pieces, chpRuns: chpRuns ?? [], streams, counters, signal },
    context: {
      counters,
      styles: readStyles(table, fib.fcLcb(FC.stshf), counters),
      papRuns,
      sectionEnds: index.sectionEnds,
      noteRefs: index.noteRefs,
      external: args.external,
      signal,
    },
  };

  return {
    family: "word",
    contentParts: () => parts,
    defaultPart: () => parts[0],
    async forEach(selected, visit) {
      let position = 0;
      const next = (): number => position++;
      switch (selected.id) {
        case "body":
          await blocks(
            state,
            { from: 0, to: fib.ccp.text, label: "body" },
            "body",
            {
              visit,
              next,
              count: true,
            },
          );
          counters.set("sections", index.sections);
          if (index.bodyBoxes > 0)
            counters.omit("text-box", TEXT_BOX_NOTE, index.bodyBoxes);
          return;
        case "footnotes":
        case "endnotes":
          await walkNotes(state, selected.id, visit, next);
          return;
        case "comments":
          await walkComments(state, visit, next);
          return;
        case "header":
        case "footer":
          await walkHeaders(state, selected.id, visit, next);
          return;
        default:
          return;
      }
    },
  };
};
