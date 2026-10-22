import type {
  OfficeContentPart,
  OfficeSlide,
} from "../domain/officeDocument/officeDocument.js";
import { byId, byKind, type OpcPackage, type Relationship } from "./package.js";
import { capText, type DocumentReader, type ReaderCounters } from "./reader.js";
import { attr, child, childrenOf, type XmlElement } from "./xml.js";

const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const MC = "http://schemas.openxmlformats.org/markup-compatibility/2006";
const CHART_URI = "http://schemas.openxmlformats.org/drawingml/2006/chart";

const MAX_NESTING = 64;
const MAX_LISTED_LINKS = 100;
const MAX_TABLE_ROWS = 100;
const MAX_TABLE_COLUMNS = 30;
/** Placeholder kinds on a notes page that are not the speaker's notes. */
const NOT_NOTES = new Set(["sldImg", "sldNum", "hdr", "ftr", "dt"]);

const expanded = (parent: XmlElement): readonly XmlElement[] =>
  parent.children.flatMap((entry) => {
    if (entry.ns !== MC || entry.local !== "AlternateContent") return [entry];
    const picked = child(entry, MC, "Choice") ?? child(entry, MC, "Fallback");
    return picked === undefined ? [] : picked.children;
  });

interface Shape {
  readonly name: string;
  readonly placeholder: string | null;
  readonly text: string;
}

interface SlideContext {
  readonly rels: readonly Relationship[];
  readonly counters: ReaderCounters;
  readonly links: { text: string; target: string; external: boolean }[];
  readonly shapes: Shape[];
  readonly tables: string[][][];
}

const readRuns = (paragraph: XmlElement, context: SlideContext): string => {
  let text = "";
  for (const entry of paragraph.children) {
    if (entry.ns !== A) continue;
    if (entry.local === "r" || entry.local === "fld") {
      const run = child(entry, A, "t")?.text ?? "";
      text += run;
      const link = child(child(entry, A, "rPr") ?? entry, A, "hlinkClick");
      const id = link === undefined ? undefined : attr(link, "id", R);
      const relationship = byId(context.rels, id);
      if (relationship !== undefined && run !== "") {
        context.counters.add("hyperlinks");
        if (context.links.length >= MAX_LISTED_LINKS)
          context.counters.omit(
            "links-past-limit",
            `A slide lists at most ${String(MAX_LISTED_LINKS)} hyperlinks; the rest are counted here.`,
          );
        else
          context.links.push({
            text: capText(run, context.counters),
            target: capText(relationship.target, context.counters),
            external: relationship.external,
          });
      }
    } else if (entry.local === "br") text += "\n";
  }
  return text;
};

const readText = (body: XmlElement, context: SlideContext): string => {
  const lines: string[] = [];
  for (const paragraph of childrenOf(body, A, "p")) {
    const level = Number.parseInt(
      attr(child(paragraph, A, "pPr") ?? paragraph, "lvl") ?? "0",
      10,
    );
    const text = readRuns(paragraph, context);
    // Outline levels run 0 to 8.
    lines.push(
      `${"  ".repeat(Number.isInteger(level) ? Math.min(8, Math.max(0, level)) : 0)}${text}`,
    );
  }
  return lines.join("\n");
};

const readTable = (table: XmlElement, context: SlideContext): string[][] => {
  const rows = childrenOf(table, A, "tr");
  if (
    rows.length > MAX_TABLE_ROWS ||
    rows.some((row) => childrenOf(row, A, "tc").length > MAX_TABLE_COLUMNS)
  )
    context.counters.omit(
      "table-cut",
      `A slide table lists at most ${String(MAX_TABLE_ROWS)} rows and ${String(MAX_TABLE_COLUMNS)} columns; the rest is not listed.`,
    );
  return rows.slice(0, MAX_TABLE_ROWS).map((row) =>
    childrenOf(row, A, "tc")
      .slice(0, MAX_TABLE_COLUMNS)
      .map((cell) => {
        const body = child(cell, A, "txBody");
        return body === undefined
          ? ""
          : capText(readText(body, context), context.counters);
      }),
  );
};

const walkShapes = (
  tree: XmlElement,
  context: SlideContext,
  depth: number,
): void => {
  if (depth > MAX_NESTING) {
    context.counters.omit(
      "nesting-limit",
      "Shapes nested deeper than 64 groups are not read.",
    );
    return;
  }
  for (const entry of expanded(tree)) {
    if (entry.ns !== P) continue;
    switch (entry.local) {
      case "sp": {
        const nonVisual = child(entry, P, "nvSpPr");
        const name =
          attr(child(nonVisual ?? entry, P, "cNvPr") ?? entry, "name") ?? "";
        const placeholder =
          attr(
            child(child(nonVisual ?? entry, P, "nvPr") ?? entry, P, "ph") ??
              entry,
            "type",
          ) ?? null;
        const hasPlaceholder =
          child(child(nonVisual ?? entry, P, "nvPr") ?? entry, P, "ph") !==
          undefined;
        const body = child(entry, P, "txBody");
        const text = body === undefined ? "" : readText(body, context);
        if (text.trim() !== "")
          context.shapes.push({
            name,
            placeholder: hasPlaceholder ? (placeholder ?? "body") : null,
            text,
          });
        break;
      }
      case "grpSp":
        walkShapes(entry, context, depth + 1);
        break;
      case "graphicFrame": {
        const data = child(
          child(entry, A, "graphic") ?? entry,
          A,
          "graphicData",
        );
        const table = data === undefined ? undefined : child(data, A, "tbl");
        if (table !== undefined) {
          context.tables.push(readTable(table, context));
          context.counters.add("tables");
        } else if (data !== undefined && attr(data, "uri") === CHART_URI)
          context.counters.omit("chart", "Charts are counted, not described.");
        else
          context.counters.omit(
            "graphic-frame",
            "Diagrams, embedded objects and other graphic frames are counted, not described.",
          );
        break;
      }
      case "pic":
        context.counters.omit(
          "picture",
          "Pictures and video are counted, not described.",
        );
        break;
      default:
        break;
    }
  }
};

const readSlideShapes = (
  root: XmlElement,
  rels: readonly Relationship[],
  counters: ReaderCounters,
): SlideContext => {
  const context: SlideContext = {
    rels,
    counters,
    links: [],
    shapes: [],
    tables: [],
  };
  const tree = child(child(root, P, "cSld") ?? root, P, "spTree");
  if (tree !== undefined) walkShapes(tree, context, 0);
  return context;
};

export interface PptxReaderInput {
  readonly pack: OpcPackage;
  readonly mainPart: string;
  readonly counters: ReaderCounters;
  readonly signal: AbortSignal | undefined;
}

export const openPptx = async (
  input: PptxReaderInput,
): Promise<DocumentReader> => {
  const { pack, mainPart, counters, signal } = input;
  const presentation = await pack.readXml(mainPart, signal);
  const rels = await pack.relationships(mainPart, signal);
  const part: OfficeContentPart = {
    id: "slides",
    label: "Slides",
    kind: "slides",
    hidden: false,
  };
  if (!presentation.ok) counters.diagnose(mainPart, presentation.reason);
  const list =
    presentation.ok === true
      ? child(presentation.root, P, "sldIdLst")
      : undefined;
  const slideRels = (
    list === undefined ? [] : childrenOf(list, P, "sldId")
  ).map((entry) => byId(rels, attr(entry, "id", R)));
  counters.set("slides", slideRels.length);
  const layouts = new Map<string, string | null>();

  return {
    family: "powerpoint",
    contentParts: () => (presentation.ok ? [part] : []),
    defaultPart: () => (presentation.ok ? part : undefined),
    async forEach(_part, visit) {
      let number = 0;
      let notesCount = 0;
      for (const relationship of slideRels) {
        number += 1;
        if (relationship?.part == null) {
          counters.diagnose(null, `Slide ${String(number)} has no slide part.`);
          continue;
        }
        const slide = await pack.readXml(relationship.part, signal);
        if (!slide.ok) {
          counters.diagnose(relationship.part, slide.reason);
          continue;
        }
        const slideRelationships = await pack.relationships(
          relationship.part,
          signal,
        );
        const context = readSlideShapes(
          slide.root,
          slideRelationships,
          counters,
        );
        const hidden = ["0", "false"].includes(
          (attr(slide.root, "show") ?? "").toLowerCase(),
        );
        if (hidden) counters.add("hidden_slides");
        const layoutRel = byKind(slideRelationships, "slideLayout");
        let layout: string | null = null;
        if (layoutRel?.part != null) {
          // Slides share a few layouts, so each one is read once.
          if (!layouts.has(layoutRel.part)) {
            const layoutXml = await pack.readXml(layoutRel.part, signal);
            layouts.set(
              layoutRel.part,
              layoutXml.ok
                ? (attr(
                    child(layoutXml.root, P, "cSld") ?? layoutXml.root,
                    "name",
                  ) ?? null)
                : null,
            );
          }
          layout = layouts.get(layoutRel.part) ?? null;
        }
        const titleShape = context.shapes.find(
          (shape) =>
            shape.placeholder === "title" || shape.placeholder === "ctrTitle",
        );
        let notes: string | null = null;
        const notesRel = byKind(slideRelationships, "notesSlide");
        if (notesRel?.part != null) {
          const notesXml = await pack.readXml(notesRel.part, signal);
          if (notesXml.ok) {
            const notesContext = readSlideShapes(
              notesXml.root,
              await pack.relationships(notesRel.part, signal),
              counters,
            );
            const text = notesContext.shapes
              .filter((shape) => !NOT_NOTES.has(shape.placeholder ?? ""))
              .map((shape) => shape.text)
              .join("\n");
            if (text.trim() !== "") {
              notes = capText(text, counters);
              notesCount += 1;
            }
          } else counters.diagnose(notesRel.part, notesXml.reason);
        }
        for (const entry of slideRelationships) {
          if (entry.kind === "comments" || entry.kind === "commentAuthors")
            counters.omit(
              "comments",
              "Slide comments are listed in the package view, not read.",
            );
          else if (
            entry.kind === "video" ||
            entry.kind === "audio" ||
            entry.kind === "media"
          )
            counters.omit(
              "media",
              "Audio and video are counted, not described.",
            );
        }
        const item: OfficeSlide = {
          kind: "slide",
          index: number - 1,
          number,
          location: relationship.part,
          hidden,
          layout,
          title:
            titleShape === undefined
              ? null
              : capText(titleShape.text, counters),
          texts: context.shapes
            .filter((shape) => shape !== titleShape)
            .map((shape) => ({
              shape: shape.name,
              text: capText(shape.text, counters),
            })),
          tables: context.tables,
          notes,
          links: context.links,
        };
        visit(item);
      }
      counters.set("slides_with_notes", notesCount);
    },
  };
};
