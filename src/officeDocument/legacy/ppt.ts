import { MemberReadFailure } from "../../artifacts/zipMemberView.js";
import type {
  OfficeContentPart,
  OfficeSlide,
} from "../../domain/officeDocument/officeDocument.js";
import type { DocumentReader } from "../reader.js";
import {
  LegacyFormatError,
  type LegacyReaderArgs,
  type LegacyStreams,
} from "./legacy.js";
import {
  Hyperlinks,
  SlideActions,
  buildSlide,
  hyperlinkTarget,
  type WalkContext,
} from "./pptAssemble.js";
import { SlideList, readDocument, type PptDocument } from "./pptDocument.js";
import { MAX_CURRENT_USER, readLayout, type PptLayout } from "./pptEdits.js";
import { Outline } from "./pptOutline.js";
import {
  IdIndex,
  OffsetSet,
  PptStepLimit,
  PptStream,
  RT,
  at,
  type PptRecord,
} from "./pptRecords.js";
import { SlideWalker, type Container } from "./pptSlides.js";
import { cleanText } from "./pptText.js";

/**
 * Legacy PowerPoint 97-2003 presentations ([MS-PPT]): the edit history
 * chooses the newest version of every persist object, the document's slide
 * list gives the slide order and outline text, and each slide container gives
 * its shapes' text, hidden flag, layout and notes. Embedded objects, ActiveX
 * controls and the VBA project inside the PowerPoint Document stream are
 * declared when the file is opened; hyperlinks while the slides are walked.
 */

const PART: OfficeContentPart = {
  id: "slides",
  label: "Slides",
  kind: "slides",
  hidden: false,
};

const EMPTY: PptDocument = {
  slides: new SlideList(),
  notes: new IdIndex(),
  hyperlinks: new IdIndex(),
};

/** Budget, size and cancel failures end the read; a damaged stream does not. */
const rethrowLimits = (cause: unknown): void => {
  if (cause instanceof MemberReadFailure && cause.reason !== "format")
    throw cause;
};

const message = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** The Current User stream's bytes, or why it cannot be used. */
const readCurrentUser = async (
  streams: LegacyStreams,
): Promise<Uint8Array | string> => {
  const entry = streams.find(["Current User"]);
  if (entry?.type !== "stream") return "The file has no Current User stream.";
  if (entry.size > MAX_CURRENT_USER)
    return "The Current User stream is larger than a CurrentUserAtom can be.";
  try {
    return await streams.read(entry);
  } catch (cause) {
    rethrowLimits(cause);
    return `The Current User stream cannot be read: ${message(cause)}`;
  }
};

const readMain = async (streams: LegacyStreams): Promise<Uint8Array> => {
  const entry = streams.find(["PowerPoint Document"]);
  if (entry?.type !== "stream")
    throw new LegacyFormatError("The file has no PowerPoint Document stream.");
  try {
    return await streams.read(entry);
  } catch (cause) {
    rethrowLimits(cause);
    throw new LegacyFormatError(
      `The PowerPoint Document stream cannot be read: ${message(cause)}`,
    );
  }
};

/** A persisted SlideContainer or NotesContainer, or null when the directory leads to none. */
const persisted = (
  stream: PptStream,
  layout: PptLayout,
  persistId: number,
  type: number,
): PptRecord | null => {
  const record = stream.recordAt(layout.directory.get(persistId) ?? -1);
  return record?.type === type && record.version === 0xf ? record : null;
};

interface Opened {
  readonly bytes: Uint8Array;
  readonly layout: PptLayout;
  readonly document: PptDocument;
  readonly args: LegacyReaderArgs;
}

type Visit = Parameters<DocumentReader["forEach"]>[1];

/** One walk over the slides: each slide, drawing and notes record is read once, all charged to a fresh step budget. */
class SlideWalk {
  readonly #opened: Opened;
  readonly #stream: PptStream;
  readonly #walker: SlideWalker;
  readonly #context: WalkContext;
  readonly #seen: OffsetSet;
  readonly #notes = new Map<number, string | null>();
  #withNotes = 0;

  constructor(opened: Opened) {
    const { args, bytes } = opened;
    this.#opened = opened;
    this.#stream = new PptStream(bytes, args.signal);
    this.#seen = new OffsetSet(bytes.length);
    this.#walker = new SlideWalker(
      this.#stream,
      args.counters,
      new OffsetSet(bytes.length),
    );
    this.#context = {
      stream: this.#stream,
      counters: args.counters,
      external: args.external,
      hyperlinks: new Hyperlinks(
        this.#stream,
        opened.document.hyperlinks,
        args.counters,
      ),
    };
  }

  async run(visit: Visit): Promise<void> {
    const { args, document, layout } = this.#opened;
    const scanned = layout.scanned;
    try {
      const count = scanned?.slides.length ?? document.slides.length;
      for (let index = 0; index < count; index += 1) {
        // Building a slide item costs work even when it has no records; a slide list entry is 28 bytes.
        this.#stream.tick(8);
        if (this.#stream.due) await this.#stream.pause();
        visit(
          scanned === null
            ? await this.#slide(index)
            : await this.#scanned(index + 1, scanned.slides.get(index)),
        );
      }
      await this.#unreferenced();
    } catch (cause) {
      if (!(cause instanceof PptStepLimit)) throw cause;
      args.counters.diagnose("PowerPoint Document", cause.message);
    }
    args.counters.set("slides_with_notes", this.#withNotes);
  }

  /** A slide found by scanning: no outline text, no notes. */
  async #scanned(number: number, offset: number): Promise<OfficeSlide> {
    const actions = new SlideActions(this.#context, number);
    const slide = await this.#container(
      this.#stream.recordAt(offset),
      number,
      null,
      actions,
    );
    return buildSlide(
      {
        number,
        location: at(offset),
        hidden: slide?.hidden ?? false,
        layout: slide?.layout ?? null,
        items: slide?.items ?? [],
        notes: null,
        links: actions.links,
      },
      this.#opened.args.counters,
    );
  }

  async #slide(index: number): Promise<OfficeSlide> {
    const { args, document, layout } = this.#opened;
    const number = index + 1;
    const persistId = document.slides.persistIds.get(index);
    const record = persisted(this.#stream, layout, persistId, RT.slide);
    if (record === null)
      args.counters.diagnose(
        `slide ${String(number)}`,
        `Slide ${String(number)} (persist id ${String(persistId)}) has no readable slide record in the persist directory.`,
      );
    const start = document.slides.starts.get(index);
    const outline = new Outline(
      this.#stream,
      args.counters,
      { start, length: document.slides.ends.get(index) - start },
      at(start),
    );
    const actions = new SlideActions(this.#context, number);
    const slide = await this.#container(record, number, outline, actions);
    // Outline text no shape took is still the slide's text.
    const rest = await outline.rest(actions);
    if (slide === null && rest.length > 0)
      args.counters.diagnose(
        `slide ${String(number)}`,
        "The slide record cannot be read; its text comes from the slide list's outline text only.",
      );
    else if (rest.length > 0)
      args.counters.add("outline_texts_unplaced", rest.length);
    const items = [...(slide?.items ?? [])];
    for (const body of rest) {
      const text = cleanText(body.raw);
      if (text.trim() !== "") items.push({ textType: body.textType, text });
    }
    const notes = await this.#notesFor(slide);
    if (notes !== null) this.#withNotes += 1;
    return buildSlide(
      {
        number,
        location:
          record === null
            ? `PowerPoint Document (slide list entry ${String(number)})`
            : at(record.offset),
        hidden: slide?.hidden ?? false,
        layout: slide?.layout ?? null,
        items,
        notes,
        links: actions.links,
      },
      args.counters,
    );
  }

  async #container(
    record: PptRecord | null,
    number: number,
    outline: Outline | null,
    actions: SlideActions,
  ): Promise<Container | null> {
    if (record === null) return null;
    if (!this.#seen.add(record.offset)) {
      this.#opened.args.counters.diagnose(
        `slide ${String(number)}`,
        `Slide ${String(number)} refers to a slide record already read for an earlier slide; it is not read again.`,
      );
      return null;
    }
    return await this.#walker.read(record, outline, actions);
  }

  /** SlideAtom.notesIdRef to NotesPersistAtom.notesId to the notes record; each notes record is read once. */
  async #notesFor(slide: Container | null): Promise<string | null> {
    const persistId =
      slide === null || slide.notesId === 0
        ? undefined
        : this.#opened.document.notes.get(slide.notesId);
    if (persistId === undefined) return null;
    const record = persisted(
      this.#stream,
      this.#opened.layout,
      persistId,
      RT.notes,
    );
    if (record === null) return null;
    if (!this.#notes.has(record.offset))
      this.#notes.set(record.offset, await this.#walker.notesText(record));
    return this.#notes.get(record.offset) ?? null;
  }

  /** Hyperlinks no slide refers to (on masters or notes) still point outside the file. */
  async #unreferenced(): Promise<void> {
    const { hyperlinks } = this.#context;
    for (const [id] of this.#opened.document.hyperlinks.entries()) {
      if (this.#stream.due) await this.#stream.pause();
      if (hyperlinks.used.has(id)) continue;
      const hyperlink = await hyperlinks.get(id, false);
      if (hyperlink !== undefined && hyperlink.target !== "")
        this.#opened.args.external({
          source: "PowerPoint Document",
          kind: "hyperlink",
          target: hyperlinkTarget(hyperlink),
          id: String(id),
        });
    }
  }
}

export const openPpt = async (
  args: LegacyReaderArgs,
): Promise<DocumentReader> => {
  const { counters, signal } = args;
  const bytes = await readMain(args.streams);
  const currentUser = await readCurrentUser(args.streams);
  const stream = new PptStream(bytes, signal);
  let layout: PptLayout;
  let document = EMPTY;
  try {
    layout = await readLayout(stream, currentUser, counters);
    if (layout.document !== null)
      document = await readDocument(
        stream,
        layout.document,
        layout.directory,
        args,
      );
  } catch (cause) {
    if (!(cause instanceof PptStepLimit)) throw cause;
    throw new LegacyFormatError(cause.message);
  }
  counters.set("edits", layout.edits);
  const scanned = layout.scanned;
  counters.set("slides", scanned?.slides.length ?? document.slides.length);
  counters.set("notes_slides", scanned?.notes.length ?? document.notes.length);
  if (scanned !== null && scanned.notes.length > 0)
    counters.omit(
      "unlinked-notes",
      "Notes slides found by scanning the stream cannot be tied to their slides, so their text is not read.",
      scanned.notes.length,
    );
  const opened: Opened = { bytes, layout, document, args };
  return {
    family: "powerpoint",
    contentParts: () => [PART],
    defaultPart: () => PART,
    forEach: async (_part, visit) => {
      await new SlideWalk(opened).run(visit);
    },
  };
};
