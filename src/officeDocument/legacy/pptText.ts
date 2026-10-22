import { MAX_ITEM_TEXT, type ReaderCounters } from "../reader.js";
import { RT, at, type PptRecord, type PptStream } from "./pptRecords.js";

/**
 * Text bodies ([MS-PPT] 2.9.41-2.9.43, 2.9.76): a TextHeaderAtom starts a
 * body, a TextCharsAtom (UTF-16) or TextBytesAtom (one byte per character)
 * holds its characters, and InteractiveInfo + TextInteractiveInfoAtom pairs
 * anchor actions (hyperlinks, programs, macros) to a range of it. The same
 * sequence appears in the slide list (outline text) and in a shape's
 * OfficeArtClientTextbox. Anchored actions go to a sink as they are read, so
 * nothing but the text itself is kept.
 */

/** TextTypeEnum ([MS-PPT] 2.13.33). */
export const TEXT_TITLE = 0;
export const TEXT_NOTES = 2;
export const TEXT_OTHER = 4;
export const TEXT_CENTER_TITLE = 6;

/** InteractiveInfoActionEnum ([MS-PPT] 2.13.13). */
export const ACTION_MACRO = 1;
export const ACTION_PROGRAM = 2;
export const ACTION_HYPERLINK = 4;

/** A shape's client textbox holds one text body; more are a damaged file. */
const MAX_BODIES = 64;
/** Program and macro names longer than an external reference can list are cut when decoded. */
const MAX_NAME = 2_001;

export interface Interaction {
  /** 0 for a mouse click, 1 for mouse over. */
  readonly instance: number;
  readonly action: number;
  readonly hyperlinkId: number;
  /** LinkToEnum ([MS-PPT] 2.13.15). */
  readonly hyperlinkType: number;
  /** MacroNameAtom: a macro name, a program's file name or a named show. */
  readonly name: string | null;
}

export interface TextBody {
  readonly textType: number;
  raw: string;
}

/** Receives each action anchored to a range of text, while the text is read. */
export interface ActionSink {
  range(
    interaction: Interaction,
    body: TextBody,
    begin: number,
    end: number,
  ): Promise<void>;
}

/** An InteractiveInfo container ([MS-PPT] 2.6.8, 2.6.9): its InteractiveInfoAtom and MacroNameAtom. */
export const readInteraction = async (
  stream: PptStream,
  container: PptRecord,
  counters: ReaderCounters,
): Promise<Interaction | null> => {
  let atom: PptRecord | undefined;
  let name: string | null = null;
  const cursor = stream.cursor(container, at(container.offset));
  for (let record = cursor.next(); record !== null; record = cursor.next()) {
    if (stream.due) await stream.pause();
    if (record.type === RT.interactiveInfoAtom) atom ??= record;
    else if (record.type === RT.cString && record.instance === 2)
      name ??= stream.utf16(record, MAX_NAME);
  }
  cursor.report(counters);
  if (atom === undefined || atom.length < 13) return null;
  return {
    instance: container.instance,
    hyperlinkId: stream.u32(atom, 4) ?? 0,
    action: stream.u8(atom, 8) ?? 0,
    hyperlinkType: stream.u8(atom, 12) ?? 0xff,
    name,
  };
};

/** Collects text bodies and outline references from one record sequence; anchored actions go to the sink. */
export class TextReader {
  readonly bodies: TextBody[] = [];
  /** OutlineTextRefAtom indices: the shape's text lives in the slide list. */
  readonly outline: number[] = [];
  readonly #pending = new Map<number, Interaction>();
  readonly #stream: PptStream;
  readonly #counters: ReaderCounters;
  readonly #sink: ActionSink;
  #skipping = false;

  constructor(stream: PptStream, counters: ReaderCounters, sink: ActionSink) {
    this.#stream = stream;
    this.#counters = counters;
    this.#sink = sink;
  }

  /** The body text atoms go to; characters before any TextHeaderAtom get a body of their own, flagged. */
  #current(record: PptRecord): TextBody | null {
    if (this.#skipping) return null;
    const last = this.bodies.at(-1);
    if (last !== undefined) return last;
    this.#counters.diagnose(
      at(record.offset),
      "Text characters come before any TextHeaderAtom; they are kept as other text.",
    );
    const body: TextBody = { textType: TEXT_OTHER, raw: "" };
    this.bodies.push(body);
    return body;
  }

  async feed(record: PptRecord): Promise<void> {
    const stream = this.#stream;
    switch (record.type) {
      case RT.textHeaderAtom:
        this.#pending.clear();
        this.#skipping = this.bodies.length >= MAX_BODIES;
        if (this.#skipping)
          this.#counters.omit(
            "text-bodies-past-limit",
            `A shape holds at most ${String(MAX_BODIES)} text bodies; the rest are not read.`,
          );
        else
          this.bodies.push({
            textType: stream.u32(record, 0) ?? TEXT_OTHER,
            raw: "",
          });
        break;
      case RT.textCharsAtom:
      case RT.textBytesAtom:
        this.#characters(record);
        break;
      case RT.interactiveInfo: {
        const interaction = await readInteraction(
          stream,
          record,
          this.#counters,
        );
        if (interaction !== null)
          this.#pending.set(record.instance, interaction);
        break;
      }
      case RT.textInteractiveInfoAtom:
        await this.#anchor(record);
        break;
      case RT.outlineTextRefAtom:
        if (this.outline.length < MAX_BODIES)
          this.outline.push(stream.i32(record, 0) ?? -1);
        break;
      default:
        break;
    }
  }

  #characters(record: PptRecord): void {
    const body = this.#current(record);
    if (body === null) return;
    if (record.type === RT.textBytesAtom) {
      body.raw += this.#stream.latin1(record);
      return;
    }
    if (record.length % 2 === 1)
      this.#counters.diagnose(
        at(record.offset),
        "A TextCharsAtom has an odd byte length; its last byte is not read.",
      );
    body.raw += this.#stream.utf16(record);
  }

  async #anchor(record: PptRecord): Promise<void> {
    const interaction = this.#pending.get(record.instance);
    this.#pending.delete(record.instance);
    const begin = this.#stream.i32(record, 0);
    const end = this.#stream.i32(record, 4);
    const body = this.#skipping ? undefined : this.bodies.at(-1);
    if (interaction === undefined || begin === null || end === null) return;
    if (body === undefined || begin < 0 || end < begin) {
      this.#counters.diagnose(
        at(record.offset),
        `A text action's range ${String(begin)} to ${String(end)} has no text it can anchor to; the action is not listed.`,
      );
      return;
    }
    await this.#sink.range(interaction, body, begin, end);
  }
}

// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u0008\u000c\u000e-\u001f]/gu;

/** Text as the item shows it: paragraph (0x0D) and line (0x0B) breaks become newlines, other C0 controls are dropped. */
export const cleanText = (raw: string): string =>
  raw.replace(/[\r\v]/gu, "\n").replace(CONTROLS, "");

/** The characters a range anchors, cut one past the item limit so the item says it was cut. */
export const rangeText = (
  stream: PptStream,
  body: TextBody,
  begin: number,
  end: number,
): string => {
  const stop = Math.min(end, begin + MAX_ITEM_TEXT + 1, body.raw.length);
  stream.tick(1 + Math.max(0, stop - begin));
  return cleanText(body.raw.slice(begin, stop));
};

/** TextTypeEnum to the label a slide's text item carries; "other" text is numbered by its place on the slide. */
export const shapeLabel = (textType: number, place: number): string => {
  switch (textType) {
    case 0:
      return "title";
    case 1:
      return "body";
    case 2:
      return "notes";
    case 5:
      return "subtitle";
    case 6:
      return "center title";
    case 7:
      return "half body";
    case 8:
      return "quarter body";
    default:
      return `textbox ${String(place)}`;
  }
};
