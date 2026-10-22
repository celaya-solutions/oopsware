import type { ReaderCounters } from "../reader.js";
import type { Item, SlideActions } from "./pptAssemble.js";
import { countChildren, countHeadersFooters } from "./pptDocument.js";
import type { Outline } from "./pptOutline.js";
import {
  RT,
  at,
  type OffsetSet,
  type PptRecord,
  type PptStream,
} from "./pptRecords.js";
import {
  TEXT_NOTES,
  TEXT_OTHER,
  TextReader,
  cleanText,
  readInteraction,
  type ActionSink,
  type Interaction,
  type TextBody,
} from "./pptText.js";

/**
 * One slide or notes container ([MS-PPT] 2.5.1, 2.5.6): its SlideAtom
 * (layout, notes reference), SlideShowSlideInfoAtom (hidden flag), the shapes
 * of its drawing ([MS-ODRAW] OfficeArtDgContainer, 2.2.13) walked in shape
 * order with an explicit stack, and its comments and header/footer text,
 * which are counted. A shape's text is either written in its client textbox
 * or referenced in the slide list (OutlineTextRefAtom). Deleted shapes (FSP
 * fDeleted, and the drawing's deletedShapes blocks) are counted, not read.
 */

const MAX_NESTING = 64;
/** msosptPictureFrame ([MS-ODRAW] 2.4.24): the shape type of a picture. */
const PICTURE_FRAME = 75;
/** SlideShowSlideInfoAtom flags (2.6.6): fHidden is bit 2. */
const HIDDEN = 0x0004;
/** OfficeArtFSP flags ([MS-ODRAW] 2.2.40): fDeleted is bit 3. */
const DELETED = 0x0008;
const DELETED_NOTE =
  "Deleted shapes kept in the drawing are counted, not read.";
const COMMENTS_NOTE = "Slide comments are counted, not read.";

/** SlideLayoutType ([MS-PPT] 2.13.25) names. */
const LAYOUTS: ReadonlyMap<number, string> = new Map([
  [0x00, "Title Slide"],
  [0x01, "Title and Body"],
  [0x02, "Title Master"],
  [0x07, "Title Only"],
  [0x08, "Two Columns"],
  [0x09, "Two Rows"],
  [0x0a, "Column and Two Rows"],
  [0x0b, "Two Rows and Column"],
  [0x0d, "Two Columns and Row"],
  [0x0e, "Four Objects"],
  [0x0f, "Big Object"],
  [0x10, "Blank"],
  [0x11, "Vertical Title and Body"],
  [0x12, "Vertical Two Rows"],
]);

export interface Container {
  readonly layout: string | null;
  readonly notesId: number;
  readonly hidden: boolean;
  readonly items: readonly Item[];
}

/** What one container's walk needs: its outline text and where its actions go. */
interface Scope {
  readonly location: string;
  readonly outline: Outline | null;
  readonly sink: ActionSink & Pick<SlideActions, "shape">;
  readonly items: Item[];
}

const IGNORE: Scope["sink"] = {
  range: async () => {},
  shape: async () => {},
};

export class SlideWalker {
  readonly #stream: PptStream;
  readonly #counters: ReaderCounters;
  readonly #drawings: OffsetSet;

  constructor(
    stream: PptStream,
    counters: ReaderCounters,
    drawings: OffsetSet,
  ) {
    this.#stream = stream;
    this.#counters = counters;
    this.#drawings = drawings;
  }

  /** A SlideContainer or NotesContainer: its atoms, its drawing's text in shape order, its comments. */
  async read(
    container: PptRecord,
    outline: Outline | null,
    sink: SlideActions | null,
  ): Promise<Container> {
    const stream = this.#stream;
    const scope: Scope = {
      location: at(container.offset),
      outline,
      sink: sink ?? IGNORE,
      items: [],
    };
    let layout: string | null = null;
    let notesId = 0;
    let hidden = false;
    const cursor = stream.cursor(container, at(container.offset));
    for (let record = cursor.next(); record !== null; record = cursor.next()) {
      if (stream.due) await stream.pause();
      if (record.type === RT.slideAtom) {
        // SlideAtom: geom at 0, notesIdRef at 16.
        layout = LAYOUTS.get(stream.u32(record, 0) ?? -1) ?? null;
        notesId = stream.u32(record, 16) ?? 0;
      } else if (record.type === RT.slideShowSlideInfoAtom)
        hidden = ((stream.u16(record, 10) ?? 0) & HIDDEN) !== 0;
      else if (record.type === RT.drawing) await this.#drawing(record, scope);
      else if (record.type === RT.progTags) await this.#comments(record);
      else if (record.type === RT.headersFooters)
        await countHeadersFooters(stream, record, this.#counters);
    }
    cursor.report(this.#counters);
    return { layout, notesId, hidden, items: scope.items };
  }

  /** A notes slide's speaker notes: the text of its notes placeholder (TextTypeEnum 2). */
  async notesText(container: PptRecord): Promise<string | null> {
    const text = (await this.read(container, null, null)).items
      .filter((item) => item.textType === TEXT_NOTES)
      .map((item) => item.text)
      .join("\n");
    return text === "" ? null : text;
  }

  /** Comment10Container records inside the slide's ___PPT10 binary tag (2.5.19-2.5.25). */
  async #comments(tags: PptRecord): Promise<void> {
    const stream = this.#stream;
    let comments = 0;
    const cursor = stream.cursor(tags, at(tags.offset));
    for (let tag = cursor.next(); tag !== null; tag = cursor.next()) {
      if (stream.due) await stream.pause();
      if (tag.type !== RT.progBinaryTag) continue;
      const inner = stream.cursor(tag, at(tag.offset));
      for (let part = inner.next(); part !== null; part = inner.next()) {
        if (stream.due) await stream.pause();
        if (part.type === RT.binaryTagDataBlob)
          comments += await countChildren(
            stream,
            part,
            RT.comment10,
            this.#counters,
          );
      }
      inner.report(this.#counters);
    }
    cursor.report(this.#counters);
    if (comments > 0) this.#counters.omit("comments", COMMENTS_NOTE, comments);
  }

  async #drawing(drawing: PptRecord, scope: Scope): Promise<void> {
    if (!this.#drawings.add(drawing.offset)) {
      this.#counters.diagnose(
        at(drawing.offset),
        "Two slides share one drawing record; its shapes are read once.",
      );
      return;
    }
    const cursor = this.#stream.cursor(drawing, at(drawing.offset));
    for (let record = cursor.next(); record !== null; record = cursor.next())
      if (record.type === RT.dgContainer) await this.#dg(record, scope);
    cursor.report(this.#counters);
  }

  /** OfficeArtDgContainer: the group shape, the background shape, then deleted shapes. */
  async #dg(dg: PptRecord, scope: Scope): Promise<void> {
    const stream = this.#stream;
    let group = false;
    let background = false;
    let deleted = 0;
    const cursor = stream.cursor(dg, at(dg.offset));
    for (let record = cursor.next(); record !== null; record = cursor.next()) {
      if (stream.due) await stream.pause();
      if (record.type === RT.spgrContainer && !group) {
        group = true;
        await this.#group(record, scope);
      } else if (
        record.type === RT.spContainer &&
        (!group || (!background && deleted === 0))
      ) {
        background = group;
        await this.#shape(record, scope);
      } else if (
        record.type === RT.spgrContainer ||
        record.type === RT.spContainer
      )
        deleted += 1;
    }
    cursor.report(this.#counters);
    if (deleted > 0)
      this.#counters.omit("deleted-shapes", DELETED_NOTE, deleted);
  }

  /** The shapes of a group in order; nested groups are entered with an explicit stack. */
  async #group(root: PptRecord, scope: Scope): Promise<void> {
    const stream = this.#stream;
    const frames = [{ at: root.start, end: root.start + root.length }];
    for (
      let frame = frames.at(-1);
      frame !== undefined;
      frame = frames.at(-1)
    ) {
      if (frame.at >= frame.end) {
        frames.pop();
        continue;
      }
      if (stream.due) await stream.pause();
      stream.tick();
      const record = stream.recordAt(frame.at, frame.end);
      if (record === null) {
        this.#counters.diagnose(
          at(frame.at),
          "A drawing record overruns its group; the rest of the group is not read.",
        );
        frames.pop();
        continue;
      }
      frame.at = record.start + record.length;
      if (record.type === RT.spgrContainer) {
        if (frames.length > MAX_NESTING)
          this.#counters.omit(
            "nesting-limit",
            "Shapes nested deeper than 64 groups are not read.",
          );
        else
          frames.push({ at: record.start, end: record.start + record.length });
      } else if (record.type === RT.spContainer)
        await this.#shape(record, scope);
    }
  }

  /** OfficeArtSpContainer: shape type and flags (FSP), client data (actions) and client textbox (text). */
  async #shape(container: PptRecord, scope: Scope): Promise<void> {
    const stream = this.#stream;
    // Most shapes carry no text or action, so these are made only when needed.
    let reader: TextReader | undefined;
    const actions: Interaction[] = [];
    let type = -1;
    let objectRef = false;
    const cursor = stream.cursor(container, at(container.offset));
    for (let record = cursor.next(); record !== null; record = cursor.next()) {
      if (stream.due) await stream.pause();
      if (record.type === RT.fsp) {
        type = record.instance;
        if (((stream.u32(record, 4) ?? 0) & DELETED) !== 0) {
          this.#counters.omit("deleted-shapes", DELETED_NOTE);
          return;
        }
      } else if (record.type === RT.clientData)
        objectRef = (await this.#clientData(record, actions)) || objectRef;
      else if (record.type === RT.clientTextbox) {
        reader ??= new TextReader(stream, this.#counters, scope.sink);
        await this.#textbox(record, reader);
      }
    }
    cursor.report(this.#counters);
    if (type === PICTURE_FRAME && !objectRef) {
      this.#counters.add("pictures");
      this.#counters.omit(
        "picture",
        "Pictures and video are counted, not described.",
      );
    }
    if (reader !== undefined || actions.length > 0)
      await this.#emit(reader, actions, scope);
  }

  /** The shape's text (outline references first, then its own) and the actions on the whole shape. */
  async #emit(
    reader: TextReader | undefined,
    actions: readonly Interaction[],
    scope: Scope,
  ): Promise<void> {
    const bodies = await this.#outlineBodies(reader?.outline ?? [], scope);
    bodies.push(...(reader?.bodies ?? []));
    const text = bodies.map((body) => cleanText(body.raw)).join("\n");
    for (const action of actions) await scope.sink.shape(action, text);
    if (text.trim() !== "")
      scope.items.push({ textType: bodies[0]?.textType ?? TEXT_OTHER, text });
  }

  async #textbox(record: PptRecord, reader: TextReader): Promise<void> {
    const stream = this.#stream;
    const cursor = stream.cursor(record, at(record.offset));
    for (let child = cursor.next(); child !== null; child = cursor.next()) {
      if (stream.due) await stream.pause();
      await reader.feed(child);
    }
    cursor.report(this.#counters);
  }

  async #outlineBodies(
    indices: readonly number[],
    scope: Scope,
  ): Promise<TextBody[]> {
    const bodies: TextBody[] = [];
    for (const index of indices) {
      const body = await scope.outline?.body(index, scope.sink);
      if (body === undefined && scope.outline !== null)
        this.#counters.diagnose(
          scope.location,
          `A shape refers to outline text ${String(index)}, which the slide list does not hold for its slide.`,
        );
      else if (body !== undefined && body !== null) bodies.push(body);
    }
    return bodies;
  }

  /** OfficeArtClientData: an object reference marks an OLE or media frame; one action per mouse event is kept. */
  async #clientData(
    record: PptRecord,
    actions: Interaction[],
  ): Promise<boolean> {
    const stream = this.#stream;
    let objectRef = false;
    const cursor = stream.cursor(record, at(record.offset));
    for (let child = cursor.next(); child !== null; child = cursor.next()) {
      if (stream.due) await stream.pause();
      if (child.type === RT.externalObjectRefAtom) objectRef = true;
      else if (child.type === RT.interactiveInfo) {
        const action = await readInteraction(stream, child, this.#counters);
        if (action === null) continue;
        if (actions.some((kept) => kept.instance === action.instance))
          this.#counters.diagnose(
            at(child.offset),
            "A shape has more than one action for the same mouse event; only the first is read.",
          );
        else actions.push(action);
      }
    }
    cursor.report(this.#counters);
    return objectRef;
  }
}
