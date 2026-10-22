import type { OfficeParagraph } from "../../domain/officeDocument/officeDocument.js";
import type { ReaderCounters } from "../reader.js";
import { runAt, type FcRun } from "./docFkp.js";
import { toggle, type ParaSprms } from "./docProps.js";
import type { DocStyles } from "./docStyles.js";
import { fieldReference, hyperlinkTarget } from "./docFields.js";
import type { Segment } from "./docText.js";
import { checkpoint, type LegacyReaderArgs } from "./legacy.js";

/**
 * Walk one Word 97-2003 story character by character ([MS-DOC] 2.4, 2.8.25):
 * paragraph, cell and section marks end paragraphs, fields (0x13 begin, 0x14
 * separator, 0x15 end) keep their instruction apart from their displayed
 * result, and special characters become text, a note reference or a counted
 * omission. Tracked and hidden text follow the Open XML reader: inserted text
 * is kept and flagged, deleted text is left out, hidden text is kept and
 * flagged. Fields nest at most 64 deep.
 */

const MAX_NESTING = 64;
const MAX_PARAGRAPH_LISTED = 100;
const MAX_FIELD_TEXT = 2_048;
const MAX_LIST_LEVEL = 8;
/** sprmPIlfo 0xF801: "not in a list". */
const ILFO_NONE = -2047;

const clip = (value: string): string =>
  value.length > MAX_FIELD_TEXT ? `${value.slice(0, MAX_FIELD_TEXT)}…` : value;

export interface WalkContext {
  readonly counters: ReaderCounters;
  readonly styles: DocStyles;
  /** Paragraph property runs; null when the PlcBtePapx could not be read. */
  readonly papRuns: readonly FcRun<ParaSprms>[] | null;
  /** CPs of end-of-section marks (0x0C ending a section, not a page break). */
  readonly sectionEnds: ReadonlySet<number>;
  /** Note reference text by the CP of its 0x02 character in the main document. */
  readonly noteRefs: ReadonlyMap<number, string>;
  readonly external: LegacyReaderArgs["external"];
  readonly signal: AbortSignal | undefined;
}

export interface ParagraphProps {
  readonly style: string | null;
  readonly heading: number | null;
  readonly list: number | null;
  /** Table depth: 0 outside tables, 1 in a table, 2 or more in nested tables. */
  readonly depth: number;
  readonly ttp: boolean;
  readonly innerCell: boolean;
  readonly innerTtp: boolean;
}

export interface Link {
  readonly text: string;
  readonly target: string;
  readonly external: boolean;
}

export interface ParagraphRecord {
  readonly text: string;
  readonly links: Link[];
  readonly fields: string[];
  readonly hidden: boolean;
  readonly revision: OfficeParagraph["revision"];
  /** What ended it: 0x0D, 0x07, an end-of-section 0x0C, or the end of the story. */
  readonly mark: "paragraph" | "cell" | "section" | "end";
  /** Null when paragraph properties are not available. */
  readonly props: ParagraphProps | null;
}

interface OpenField {
  instr: string;
  result: boolean;
  from: number;
  serial: number;
  readonly cp: number;
}

/** One segment's share of one paragraph, the unit hidden and tracked text are counted by. */
interface Part {
  readonly vanish: number | undefined;
  readonly charIstd: number | undefined;
  readonly del: boolean;
  readonly ins: boolean;
  chars: boolean;
  produced: boolean;
  text: boolean;
}

/** Paragraph properties of the paragraph whose mark is at stream offset `fc`. */
const paragraphProps = (
  context: WalkContext,
  fc: number,
  piece: ParaSprms | null,
): { props: ParagraphProps; vanish: boolean; known: boolean } | null => {
  if (context.papRuns === null) return null;
  const run = runAt(context.papRuns, fc);
  const sprms: ParaSprms = { ...(run?.props ?? { istd: 0 }), ...piece };
  const style = context.styles.resolve(sprms.istd ?? 0);
  const outline = sprms.outLvl ?? style.outLvl;
  const ilfo = sprms.ilfo ?? style.ilfo;
  const inList = ilfo !== undefined && ilfo !== 0 && ilfo !== ILFO_NONE;
  return {
    vanish: style.vanish,
    known: run !== undefined,
    props: {
      style: style.name,
      heading:
        style.heading ??
        (outline !== undefined && outline <= 8 ? outline + 1 : null),
      list: inList
        ? Math.min(MAX_LIST_LEVEL, Math.max(0, sprms.ilvl ?? style.ilvl ?? 0))
        : null,
      depth: Math.max(
        0,
        (sprms.itap ?? (sprms.inTable === true ? 1 : 0)) + (sprms.dtap ?? 0),
      ),
      ttp: sprms.ttp === true,
      innerCell: sprms.innerCell === true,
      innerTtp: sprms.innerTtp === true,
    },
  };
};

const openPart = (segment: Segment): Part => ({
  vanish: segment.chp.vanish,
  charIstd: segment.chp.istd,
  del: toggle(segment.chp.del, false),
  ins: toggle(segment.chp.ins, false),
  chars: false,
  produced: false,
  text: false,
});

const revisionOf = (
  text: string,
  inserted: number,
  deleted: number,
): OfficeParagraph["revision"] => {
  if (text.trim() === "" && deleted > 0) return "deleted";
  if (inserted > 0 && deleted > 0) return "mixed";
  if (inserted > 0) return "inserted";
  return deleted > 0 ? "deleted" : null;
};

/** The state of one story walk: open fields, the paragraph being built and its parts. */
class StoryWalker {
  readonly #context: WalkContext;
  readonly #counters: ReaderCounters;
  readonly #source: string;
  readonly #emit: (record: ParagraphRecord) => void;
  readonly #fields: OpenField[] = [];
  /** Fields opened past the nesting limit, closed without being read. */
  #overflow = 0;
  /** Index of the innermost field still reading its instruction, or -1. */
  #instrAt = -1;
  /** Number of the paragraph being built, so a link knows where its text starts. */
  #serial = 0;
  #chunks: string[] = [];
  #length = 0;
  #links: Link[] = [];
  #fieldTexts: string[] = [];
  #parts: Part[] = [];
  #part: Part | null = null;
  #steps = 0;
  #missing = 0;

  constructor(
    context: WalkContext,
    source: string,
    emit: (record: ParagraphRecord) => void,
  ) {
    this.#context = context;
    this.#counters = context.counters;
    this.#source = source;
    this.#emit = emit;
  }

  async walk(segments: readonly Segment[]): Promise<void> {
    for (const [index, segment] of segments.entries()) {
      if (index % 4096 === 4095) await checkpoint(this.#context.signal);
      if (this.#part !== null) this.#parts.push(this.#part);
      this.#part = openPart(segment);
      const text = segment.text;
      let plain = 0;
      for (let offset = 0; offset < text.length; offset += 1) {
        const code = text.charCodeAt(offset);
        if (code >= 0x20) continue;
        if ((this.#steps += 1) % 4096 === 0)
          await checkpoint(this.#context.signal);
        if (offset > plain) this.#put(text.slice(plain, offset), segment);
        plain = offset + 1;
        this.#special(code, segment, offset);
      }
      if (text.length > plain) this.#put(text.slice(plain), segment);
    }
    if (
      this.#length > 0 ||
      this.#links.length > 0 ||
      this.#fieldTexts.length > 0
    )
      this.#endParagraph("end", null, 0);
    const open = this.#fields.length + this.#overflow;
    if (open > 0)
      this.#counters.diagnose(
        this.#source,
        `${String(open)} fields are not closed by the end of this story.`,
      );
    if (this.#missing > 0)
      this.#counters.diagnose(
        this.#source,
        `${String(this.#missing)} paragraph marks have no paragraph properties; they are read as plain paragraphs.`,
      );
  }

  #refreshInstr(): void {
    this.#instrAt = -1;
    for (let at = this.#fields.length - 1; at >= 0; at -= 1)
      if (this.#fields[at]?.result === false) {
        this.#instrAt = at;
        return;
      }
  }

  /** The paragraph's text so far, joined once and kept joined. */
  #current(): string {
    if (this.#chunks.length > 1) this.#chunks = [this.#chunks.join("")];
    return this.#chunks[0] ?? "";
  }

  /** Text goes to the innermost field instruction being read, else to the paragraph; deleted text goes nowhere. */
  #put(value: string, segment: Segment): void {
    const part = this.#part;
    if (part === null || value === "") return;
    part.chars = true;
    if (part.del) return;
    const field = this.#instrAt >= 0 ? this.#fields[this.#instrAt] : undefined;
    if (field !== undefined) {
      if (field.instr.length < MAX_FIELD_TEXT)
        field.instr += value.slice(0, MAX_FIELD_TEXT - field.instr.length);
      return;
    }
    if (segment.chp.symbol === true && toggle(segment.chp.spec, false)) {
      this.#counters.omit(
        "symbol",
        "Symbol characters are font-specific and are not mapped to text.",
      );
      return;
    }
    this.#chunks.push(value);
    this.#length += value.length;
    part.produced = true;
    if (/\S/u.test(value)) part.text = true;
  }

  #finishField(field: OpenField): void {
    const instruction = field.instr.trim();
    if (instruction === "") return;
    this.#counters.add("fields");
    if (this.#fieldTexts.length >= MAX_PARAGRAPH_LISTED)
      this.#counters.omit(
        "fields-past-limit",
        `A paragraph lists at most ${String(MAX_PARAGRAPH_LISTED)} field instructions; the rest are counted here.`,
      );
    else this.#fieldTexts.push(clip(instruction));
    if (/^HYPERLINK\b/iu.test(instruction)) {
      this.#link(field, instruction);
      return;
    }
    const reference = fieldReference(instruction);
    if (reference !== null)
      this.#context.external({
        source: this.#source,
        kind: reference.kind,
        target: reference.target,
        id: `field-cp${String(field.cp)}`,
      });
  }

  #link(field: OpenField, instruction: string): void {
    const target = hyperlinkTarget(instruction);
    if (target === null) return;
    this.#counters.add("hyperlinks");
    if (target.external)
      this.#context.external({
        source: this.#source,
        kind: "hyperlink",
        target: target.target,
        id: `field-cp${String(field.cp)}`,
      });
    if (this.#links.length >= MAX_PARAGRAPH_LISTED) {
      this.#counters.omit(
        "links-past-limit",
        `A paragraph lists at most ${String(MAX_PARAGRAPH_LISTED)} hyperlinks; the rest are counted here.`,
      );
      return;
    }
    // The displayed text is the field's result; a result that began in an earlier paragraph counts from this one's start.
    const text = !field.result
      ? ""
      : field.serial === this.#serial
        ? this.#current().slice(field.from)
        : this.#current();
    this.#links.push({
      text: clip(text),
      target: clip(target.target),
      external: target.external,
    });
  }

  /** Count the paragraph's parts: visible and hidden text, tracked insertions and deletions. */
  #tally(paragraphVanish: boolean): {
    hidden: boolean;
    inserted: number;
    deleted: number;
  } {
    let visible = 0;
    let hiddenRuns = 0;
    let inserted = 0;
    let deleted = 0;
    for (const entry of this.#parts) {
      if (entry.del) {
        if (entry.chars) deleted += 1;
        continue;
      }
      const styleVanish =
        (entry.charIstd !== undefined &&
          this.#context.styles.resolve(entry.charIstd).vanish) ||
        paragraphVanish;
      if (entry.text) {
        if (toggle(entry.vanish, styleVanish)) {
          hiddenRuns += 1;
          this.#counters.add("hidden_text_runs");
        } else visible += 1;
      }
      if (entry.ins && entry.produced) inserted += 1;
    }
    if (inserted > 0) this.#counters.add("tracked_insertions", inserted);
    if (deleted > 0) {
      this.#counters.add("tracked_deletions", deleted);
      this.#counters.omit(
        "deleted-text",
        "Text deleted with tracked changes is not part of the text.",
        deleted,
      );
    }
    return { hidden: hiddenRuns > 0 && visible === 0, inserted, deleted };
  }

  #endParagraph(
    mark: ParagraphRecord["mark"],
    segment: Segment | null,
    offset: number,
  ): void {
    const resolved =
      segment === null
        ? null
        : paragraphProps(
            this.#context,
            segment.fc + offset * segment.width,
            segment.pap,
          );
    if (resolved?.known === false) this.#missing += 1;
    if (this.#part !== null) this.#parts.push(this.#part);
    const { hidden, inserted, deleted } = this.#tally(
      resolved?.vanish ?? false,
    );
    const text = this.#current();
    this.#emit({
      text,
      links: this.#links,
      fields: this.#fieldTexts,
      hidden,
      revision: revisionOf(text, inserted, deleted),
      mark,
      props: resolved?.props ?? null,
    });
    this.#serial += 1;
    this.#chunks = [];
    this.#length = 0;
    this.#links = [];
    this.#fieldTexts = [];
    this.#parts = [];
    this.#part = segment === null ? null : openPart(segment);
  }

  #special(code: number, segment: Segment, offset: number): void {
    const cp = segment.cp + offset;
    switch (code) {
      case 0x0d:
        this.#endParagraph("paragraph", segment, offset);
        return;
      case 0x07:
        this.#endParagraph("cell", segment, offset);
        return;
      case 0x0c:
        // An end-of-section mark ends a paragraph; any other 0x0C is a page break.
        if (this.#context.sectionEnds.has(cp))
          this.#endParagraph("section", segment, offset);
        else this.#put("\n", segment);
        return;
      case 0x0b:
      case 0x0e:
        // Line break and column break.
        this.#put("\n", segment);
        return;
      case 0x09:
        this.#put("\t", segment);
        return;
      case 0x1e:
        this.#put("-", segment);
        return;
      case 0x13:
      case 0x14:
      case 0x15:
        if (this.#part !== null) this.#part.chars = true;
        this.#field(code, segment, cp);
        return;
      default:
        this.#object(code, segment, cp);
    }
  }

  #field(code: number, segment: Segment, cp: number): void {
    if (code === 0x13) {
      if (this.#fields.length >= MAX_NESTING) {
        this.#overflow += 1;
        this.#counters.omit(
          "nesting-limit",
          "Fields nested deeper than 64 levels are not read.",
        );
      } else
        this.#fields.push({
          instr: "",
          result: false,
          from: 0,
          serial: this.#serial,
          cp,
        });
    } else if (code === 0x14) {
      const top = this.#fields[this.#fields.length - 1];
      if (this.#overflow === 0 && top !== undefined && !top.result) {
        top.result = true;
        top.from = this.#length;
        top.serial = this.#serial;
        if (segment.chp.ole === true) {
          this.#counters.add("ole_objects");
          this.#counters.omit(
            "embedded-object",
            "Embedded objects are listed in the package view; their content is not read.",
          );
        }
      }
    } else if (this.#overflow > 0) this.#overflow -= 1;
    else {
      const field = this.#fields.pop();
      this.#refreshInstr();
      if (field !== undefined) this.#finishField(field);
    }
    this.#refreshInstr();
  }

  /** Note references, pictures and drawn objects; other control characters carry no text. */
  #object(code: number, segment: Segment, cp: number): void {
    const part = this.#part;
    if (part === null) return;
    part.chars = true;
    if (part.del || this.#instrAt >= 0) return;
    if (code === 0x02) {
      const reference = this.#context.noteRefs.get(cp);
      if (reference !== undefined) this.#put(reference, segment);
    } else if (code === 0x01) {
      this.#counters.add("pictures");
      this.#counters.omit("picture", "Pictures are counted, not described.");
    } else if (code === 0x08) {
      this.#counters.add("drawn_objects");
      this.#counters.omit(
        "drawing",
        "Pictures, shapes, charts and diagrams are counted, not described.",
      );
    }
  }
}

/** Walk a story's segments and call `emit` for each paragraph in order. */
export const walkStory = async (
  segments: readonly Segment[],
  context: WalkContext,
  source: string,
  emit: (record: ParagraphRecord) => void,
): Promise<void> => {
  await new StoryWalker(context, source, emit).walk(segments);
};
