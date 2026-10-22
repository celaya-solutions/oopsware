import type { OfficeSlide } from "../../domain/officeDocument/officeDocument.js";
import { MAX_ITEM_TEXT, capText, type ReaderCounters } from "../reader.js";
import type { LegacyReaderArgs } from "./legacy.js";
import { readParts } from "./pptObjects.js";
import { RT, type IdIndex, type PptStream } from "./pptRecords.js";
import {
  ACTION_HYPERLINK,
  ACTION_MACRO,
  ACTION_PROGRAM,
  TEXT_CENTER_TITLE,
  TEXT_TITLE,
  rangeText,
  shapeLabel,
  type ActionSink,
  type Interaction,
  type TextBody,
} from "./pptText.js";

/**
 * Slide actions and slide items. Hyperlinks are decoded when a slide first
 * refers to them and declared as external references once per walk; a link's
 * text is cut from its range only when the link is listed (at most 100 per
 * slide). Actions that run a program or macro are counted; a program's file
 * name is listed as an external reference, never run.
 */

const MAX_LISTED_LINKS = 100;

export interface Hyperlink {
  readonly friendly: string;
  readonly target: string;
  readonly location: string;
}

/** The destination as written: target file or URL, with its location inside it; a slide location alone for an internal link. */
export const hyperlinkTarget = (hyperlink: Hyperlink): string =>
  hyperlink.target === ""
    ? hyperlink.location
    : hyperlink.location === ""
      ? hyperlink.target
      : `${hyperlink.target}#${hyperlink.location}`;

/** ExHyperlink containers by id, decoded on first use: friendly name (CString 0), target (1), location (3). */
export class Hyperlinks {
  /** Ids some slide referred to during this walk; each is declared once. */
  readonly used = new Set<number>();
  readonly #stream: PptStream;
  readonly #offsets: IdIndex;
  readonly #counters: ReaderCounters;
  readonly #cache = new Map<number, Hyperlink | undefined>();

  constructor(stream: PptStream, offsets: IdIndex, counters: ReaderCounters) {
    this.#stream = stream;
    this.#offsets = offsets;
    this.#counters = counters;
  }

  /** The hyperlink with this id, or undefined when the object list has none; `keep` caches it for later slides. */
  async get(id: number, keep = true): Promise<Hyperlink | undefined> {
    if (this.#cache.has(id)) return this.#cache.get(id);
    const record = this.#stream.recordAt(this.#offsets.get(id) ?? -1);
    let hyperlink: Hyperlink | undefined;
    if (record !== null) {
      // Strings are cut one past the item limit, so items and references say they were cut.
      const { strings } = await readParts(this.#stream, record, {
        type: RT.externalHyperlinkAtom,
        max: MAX_ITEM_TEXT + 1,
        counters: this.#counters,
      });
      hyperlink = {
        friendly: strings.get(0) ?? "",
        target: strings.get(1) ?? "",
        location: strings.get(3) ?? "",
      };
    }
    if (keep) this.#cache.set(id, hyperlink);
    return hyperlink;
  }
}

export interface WalkContext {
  readonly stream: PptStream;
  readonly counters: ReaderCounters;
  readonly external: LegacyReaderArgs["external"];
  readonly hyperlinks: Hyperlinks;
}

type Link = OfficeSlide["links"][number];

/** One slide's actions: anchored to text ranges or to whole shapes. */
export class SlideActions implements ActionSink {
  readonly links: Link[] = [];
  readonly #context: WalkContext;
  readonly #source: string;

  constructor(context: WalkContext, number: number) {
    this.#context = context;
    this.#source = `slide ${String(number)}`;
  }

  async range(
    interaction: Interaction,
    body: TextBody,
    begin: number,
    end: number,
  ): Promise<void> {
    await this.#act(interaction, () =>
      rangeText(this.#context.stream, body, begin, end),
    );
  }

  async shape(interaction: Interaction, text: string): Promise<void> {
    await this.#act(interaction, () => text);
  }

  async #act(interaction: Interaction, text: () => string): Promise<void> {
    const { counters, external, hyperlinks } = this.#context;
    if (interaction.action === ACTION_PROGRAM) {
      counters.add("action_programs");
      if (interaction.name !== null && interaction.name !== "")
        external({
          source: this.#source,
          kind: "run-program",
          target: interaction.name,
          id: "",
        });
      return;
    }
    if (interaction.action === ACTION_MACRO) {
      counters.add("action_macros");
      return;
    }
    if (interaction.action !== ACTION_HYPERLINK || interaction.instance !== 0)
      return;
    const id = interaction.hyperlinkId;
    const hyperlink = await hyperlinks.get(id);
    if (hyperlink === undefined) {
      counters.diagnose(
        this.#source,
        `A hyperlink refers to id ${String(id)}, which the external object list does not hold.`,
      );
      return;
    }
    const target = hyperlinkTarget(hyperlink);
    if (target === "") return;
    const isExternal = hyperlink.target !== "";
    counters.add("hyperlinks");
    if (!hyperlinks.used.has(id)) {
      hyperlinks.used.add(id);
      if (isExternal)
        external({
          source: this.#source,
          kind: "hyperlink",
          target,
          id: String(id),
        });
    }
    if (this.links.length >= MAX_LISTED_LINKS)
      counters.omit(
        "links-past-limit",
        `A slide lists at most ${String(MAX_LISTED_LINKS)} hyperlinks; the rest are counted here.`,
      );
    else
      this.links.push({
        text: capText(text(), counters),
        target: capText(target, counters),
        external: isExternal,
      });
  }
}

/** One shape's text on a slide, in shape order. */
export interface Item {
  readonly textType: number;
  readonly text: string;
}

export interface SlideInput {
  readonly number: number;
  readonly location: string;
  readonly hidden: boolean;
  readonly layout: string | null;
  readonly items: readonly Item[];
  readonly notes: string | null;
  readonly links: Link[];
}

/** The slide item: the first title-type text is the title; the rest are labelled by type and place. */
export const buildSlide = (
  input: SlideInput,
  counters: ReaderCounters,
): OfficeSlide => {
  const title = input.items.find(
    (item) =>
      item.textType === TEXT_TITLE || item.textType === TEXT_CENTER_TITLE,
  );
  if (input.hidden) counters.add("hidden_slides");
  return {
    kind: "slide",
    index: input.number - 1,
    number: input.number,
    location: input.location,
    hidden: input.hidden,
    layout: input.layout,
    title: title === undefined ? null : capText(title.text, counters),
    texts: input.items.flatMap((item, place) =>
      item === title
        ? []
        : [
            {
              shape: shapeLabel(item.textType, place + 1),
              text: capText(item.text, counters),
            },
          ],
    ),
    tables: [],
    notes: input.notes === null ? null : capText(input.notes, counters),
    links: input.links,
  };
};
