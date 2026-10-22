import type { ReaderCounters } from "../reader.js";
import type { LegacyReaderArgs } from "./legacy.js";
import { ObjectReader } from "./pptObjects.js";
import {
  IdIndex,
  OffsetList,
  RT,
  at,
  type PersistDirectory,
  type PptRecord,
  type PptStream,
} from "./pptRecords.js";

/**
 * The DocumentContainer ([MS-PPT] 2.4.1): the slide list in presentation
 * order (SlideListWithTextContainer, instance 0), whose outline text is kept
 * as an offset range per slide and read when the slide is walked; the master
 * and notes lists (instances 1 and 2); the external object list and the VBA
 * project reference. Objects and macros are declared here, when the file is
 * opened.
 */

/** The slide list as three parallel offset lists, so a huge list stays a few bytes per slide. */
export class SlideList {
  readonly persistIds = new OffsetList();
  /** Each slide's outline text: the records after its SlidePersistAtom, up to the next. */
  readonly starts = new OffsetList();
  readonly ends = new OffsetList();

  get length(): number {
    return this.persistIds.length;
  }
}

export interface PptDocument {
  readonly slides: SlideList;
  /** NotesPersistAtom.notesId to the notes slide's persist id. */
  readonly notes: IdIndex;
  /** ExHyperlinkId to the offset of its container. */
  readonly hyperlinks: IdIndex;
}

const SLIDES = 0;
const MASTERS = 1;
const NOTES = 2;
const TEXT_RECORDS: ReadonlySet<number> = new Set([
  RT.textHeaderAtom,
  RT.textCharsAtom,
  RT.textBytesAtom,
]);
const HEADERS_FOOTERS_NOTE =
  "Header, footer and date text is counted, not read.";

/** SlideListWithTextContainer instance 0: each SlidePersistAtom and the offset range of its outline text. */
const readSlideList = async (
  stream: PptStream,
  list: PptRecord,
  counters: ReaderCounters,
): Promise<SlideList> => {
  const slides = new SlideList();
  let stray = false;
  let end = list.start;
  const cursor = stream.cursor(list, at(list.offset));
  for (let record = cursor.next(); record !== null; record = cursor.next()) {
    if (stream.due) await stream.pause();
    if (record.type === RT.slidePersistAtom) {
      if (slides.length > 0) slides.ends.set(slides.length - 1, record.offset);
      slides.persistIds.push(stream.u32(record, 0) ?? 0);
      slides.starts.push(record.start + record.length);
      slides.ends.push(record.start + record.length);
    } else if (slides.length === 0 && TEXT_RECORDS.has(record.type))
      stray = true;
    end = record.start + record.length;
  }
  if (slides.length > 0) slides.ends.set(slides.length - 1, end);
  cursor.report(counters);
  if (stray)
    counters.diagnose(
      at(list.offset),
      "The slide list has text records before its first slide; they are not read.",
    );
  return slides;
};

/** NotesPersistAtom records ([MS-PPT] 2.4.14.7): notesId to persist id. */
const readNotesList = async (
  stream: PptStream,
  list: PptRecord,
  notes: IdIndex,
  counters: ReaderCounters,
): Promise<void> => {
  const cursor = stream.cursor(list, at(list.offset));
  for (let record = cursor.next(); record !== null; record = cursor.next()) {
    if (stream.due) await stream.pause();
    if (record.type !== RT.slidePersistAtom) continue;
    const notesId = stream.u32(record, 12);
    const persistId = stream.u32(record, 0);
    if (notesId !== null && persistId !== null) notes.add(notesId, persistId);
  }
  cursor.report(counters);
};

/** Count the records of one type in a container: masters in the master list, texts in a header/footer container. */
export const countChildren = async (
  stream: PptStream,
  container: PptRecord,
  type: number,
  counters: ReaderCounters,
): Promise<number> => {
  let count = 0;
  const cursor = stream.cursor(container, at(container.offset));
  for (let record = cursor.next(); record !== null; record = cursor.next()) {
    if (stream.due) await stream.pause();
    if (record.type === type && record.length > 0) count += 1;
  }
  cursor.report(counters);
  return count;
};

/** Header and footer text (HeadersFooters containers' CStrings) is counted, never read. */
export const countHeadersFooters = async (
  stream: PptStream,
  container: PptRecord,
  counters: ReaderCounters,
): Promise<void> => {
  const texts = await countChildren(stream, container, RT.cString, counters);
  if (texts > 0) counters.omit("headers-footers", HEADERS_FOOTERS_NOTE, texts);
};

/** DocumentAtom: notesMasterPersistIdRef at 24, handoutMasterPersistIdRef at 28. */
const countMasters = (
  stream: PptStream,
  atom: PptRecord,
  counters: ReaderCounters,
): void => {
  if ((stream.u32(atom, 24) ?? 0) !== 0) counters.set("notes_masters", 1);
  if ((stream.u32(atom, 28) ?? 0) !== 0) counters.set("handout_masters", 1);
};

export const readDocument = async (
  stream: PptStream,
  document: PptRecord,
  directory: PersistDirectory,
  args: LegacyReaderArgs,
): Promise<PptDocument> => {
  const { counters } = args;
  const objects = new ObjectReader(stream, directory, args);
  const notes = new IdIndex();
  let slides = new SlideList();
  let slideLists = 0;
  const cursor = stream.cursor(document, at(document.offset));
  for (let record = cursor.next(); record !== null; record = cursor.next()) {
    if (stream.due) await stream.pause();
    switch (record.type) {
      case RT.documentAtom:
        countMasters(stream, record, counters);
        break;
      case RT.externalObjectList:
        await objects.readObjectList(record);
        break;
      case RT.list:
        await objects.readDocInfo(record);
        break;
      case RT.headersFooters:
        await countHeadersFooters(stream, record, counters);
        break;
      case RT.slideListWithText:
        if (record.instance === SLIDES && slideLists++ === 0)
          slides = await readSlideList(stream, record, counters);
        else if (record.instance === MASTERS)
          counters.add(
            "master_slides",
            await countChildren(stream, record, RT.slidePersistAtom, counters),
          );
        else if (record.instance === NOTES)
          await readNotesList(stream, record, notes, counters);
        break;
      default:
        break;
    }
  }
  cursor.report(counters);
  if (slideLists > 1)
    counters.diagnose(
      at(document.offset),
      "The document has more than one slide list; only the first is read.",
    );
  return { slides, notes, hyperlinks: objects.hyperlinks };
};
