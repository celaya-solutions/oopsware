import type {
  OfficeContentPart,
  OfficeItem,
  OfficeParagraph,
  OfficeTable,
} from "../domain/officeDocument/officeDocument.js";
import { byId, byKind, type OpcPackage, type Relationship } from "./package.js";
import { attr, child, childrenOf, type XmlElement } from "./xml.js";
import type { DocumentReader, ReaderCounters } from "./reader.js";
import { capText } from "./reader.js";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const M = "http://schemas.openxmlformats.org/officeDocument/2006/math";
const MC = "http://schemas.openxmlformats.org/markup-compatibility/2006";

/** Table cells and rows kept per table item; the item says when it is cut. */
const MAX_TABLE_ROWS = 200;
const MAX_TABLE_COLUMNS = 50;
const MAX_NESTING = 64;
/** Links and field instructions kept per paragraph; the rest are counted as omissions. */
const MAX_PARAGRAPH_LISTED = 100;
const MAX_FIELD_TEXT = 2_048;
/** Deepest list level Word allows is 9 (0 to 8). */
const MAX_LIST_LEVEL = 8;

const NESTING_NOTE = "Content nested deeper than 64 levels is not read.";

const clip = (value: string): string =>
  value.length > MAX_FIELD_TEXT ? `${value.slice(0, MAX_FIELD_TEXT)}…` : value;

const wval = (element: XmlElement | undefined): string | undefined =>
  element === undefined ? undefined : attr(element, "val", W);

/** An on/off property: present without a value, or with a value other than false, 0 or off. */
const on = (element: XmlElement | undefined): boolean => {
  if (element === undefined) return false;
  const value = wval(element)?.toLowerCase();
  return value === undefined || !["0", "false", "off"].includes(value);
};

interface Styles {
  readonly names: ReadonlyMap<string, string>;
  /** Styles whose run properties hide their text (w:vanish). */
  readonly hidden: ReadonlySet<string>;
}

const readStyles = (root: XmlElement | undefined): Styles => {
  const names = new Map<string, string>();
  const hidden = new Set<string>();
  for (const style of root === undefined ? [] : childrenOf(root, W, "style")) {
    const id = attr(style, "styleId", W);
    const name = wval(child(style, W, "name"));
    if (id !== undefined && name !== undefined) names.set(id, name);
    const runProperties = child(style, W, "rPr");
    if (id !== undefined && on(child(runProperties ?? style, W, "vanish")))
      hidden.add(id);
  }
  return { names, hidden };
};

const HEADING = /^heading\s*([1-9])$/iu;

interface PartContext {
  readonly part: string;
  readonly rels: readonly Relationship[];
  readonly styles: Styles;
  readonly counters: ReaderCounters;
  paragraph: number;
  table: number;
  /** Complex fields open across runs and paragraphs; a field is reported where it ends. */
  readonly fieldStack: { instr: string; result: boolean }[];
}

interface RunState {
  text: string;
  links: { text: string; target: string; external: boolean }[];
  fields: string[];
  /** The paragraph's style hides its text. */
  styleHidden: boolean;
  visible: number;
  hiddenRuns: number;
  inserted: number;
  deleted: number;
}

const descendants = (
  element: XmlElement,
  ns: string,
  local: string,
  depth = 0,
): number => {
  if (depth > MAX_NESTING) return 0;
  let found = 0;
  for (const entry of element.children) {
    if (entry.ns === ns && entry.local === local) found += 1;
    found += descendants(entry, ns, local, depth + 1);
  }
  return found;
};

const mathText = (element: XmlElement, depth = 0): string => {
  if (depth > MAX_NESTING) return "";
  let out = element.ns === M && element.local === "t" ? element.text : "";
  for (const entry of element.children) out += mathText(entry, depth + 1);
  return out;
};

/** Pick the content of a markup-compatibility alternate: the first Choice, else the Fallback. */
const alternate = (element: XmlElement): readonly XmlElement[] => {
  const choice = child(element, MC, "Choice");
  const picked = choice ?? child(element, MC, "Fallback");
  return picked === undefined ? [] : picked.children;
};

/** A part's children with markup-compatibility alternates replaced by the content a reader should use. */
const expanded = (parent: XmlElement): readonly XmlElement[] =>
  parent.children.flatMap((entry) =>
    entry.ns === MC && entry.local === "AlternateContent"
      ? alternate(entry)
      : [entry],
  );

/** Keep a field instruction on its paragraph, up to the per-paragraph limit. */
const addField = (
  state: RunState,
  context: PartContext,
  instruction: string,
): void => {
  context.counters.add("fields");
  if (state.fields.length >= MAX_PARAGRAPH_LISTED)
    context.counters.omit(
      "fields-past-limit",
      `A paragraph lists at most ${String(MAX_PARAGRAPH_LISTED)} field instructions; the rest are counted here.`,
    );
  else state.fields.push(clip(instruction.trim()));
};

const readRun = (
  run: XmlElement,
  state: RunState,
  context: PartContext,
  mode: "normal" | "inserted" | "deleted",
): void => {
  const properties = child(run, W, "rPr");
  const vanish =
    properties === undefined ? undefined : child(properties, W, "vanish");
  const runStyle =
    properties === undefined ? undefined : wval(child(properties, W, "rStyle"));
  // An explicit w:vanish on the run decides; otherwise its character style, then the paragraph's.
  const hidden =
    vanish !== undefined
      ? on(vanish)
      : runStyle !== undefined && context.styles.hidden.has(runStyle)
        ? true
        : state.styleHidden;
  let produced = "";
  for (const entry of expanded(run)) {
    if (entry.ns === W) {
      switch (entry.local) {
        case "t":
          if (mode !== "deleted") produced += entry.text;
          break;
        case "delText":
          break;
        case "tab":
          if (mode !== "deleted") produced += "\t";
          break;
        case "br":
        case "cr":
          if (mode !== "deleted") produced += "\n";
          break;
        case "noBreakHyphen":
          if (mode !== "deleted") produced += "-";
          break;
        case "instrText": {
          const top = context.fieldStack[context.fieldStack.length - 1];
          if (
            top !== undefined &&
            !top.result &&
            top.instr.length < MAX_FIELD_TEXT
          )
            top.instr += entry.text;
          break;
        }
        case "fldChar": {
          const type = attr(entry, "fldCharType", W);
          if (type === "begin") {
            if (context.fieldStack.length < MAX_NESTING)
              context.fieldStack.push({ instr: "", result: false });
          } else if (type === "separate") {
            const top = context.fieldStack[context.fieldStack.length - 1];
            if (top !== undefined) top.result = true;
          } else if (type === "end") {
            const top = context.fieldStack.pop();
            if (top !== undefined && top.instr.trim() !== "")
              addField(state, context, top.instr);
          }
          break;
        }
        case "footnoteReference":
        case "endnoteReference": {
          const id = attr(entry, "id", W);
          if (mode !== "deleted" && id !== undefined)
            produced += `[^${entry.local === "footnoteReference" ? "fn" : "en"}${id}]`;
          break;
        }
        case "drawing":
        case "pict":
          context.counters.omit(
            entry.local === "drawing" ? "drawing" : "legacy-drawing",
            "Pictures, shapes, charts and diagrams are counted, not described.",
          );
          if (descendants(entry, W, "txbxContent") > 0)
            context.counters.omit(
              "text-box",
              "Text inside text boxes is not read.",
            );
          break;
        case "object":
          context.counters.omit(
            "embedded-object",
            "Embedded objects are listed in the package view; their content is not read.",
          );
          break;
        case "sym":
          context.counters.omit(
            "symbol",
            "Symbol characters are font-specific and are not mapped to text.",
          );
          break;
        default:
          break;
      }
    } else if (
      entry.ns === M &&
      (entry.local === "oMath" || entry.local === "oMathPara")
    ) {
      const flat = mathText(entry);
      if (mode !== "deleted") produced += flat;
      context.counters.omit(
        "equation",
        "Equations are flattened to their text; structure and layout are lost.",
      );
    }
  }
  if (produced !== "" || mode === "deleted") {
    if (mode === "deleted") state.deleted += 1;
    else {
      state.text += produced;
      if (produced.trim() !== "") {
        if (hidden) state.hiddenRuns += 1;
        else state.visible += 1;
      }
      if (mode === "inserted") state.inserted += 1;
    }
  }
  if (hidden && produced.trim() !== "")
    context.counters.add("hidden_text_runs");
};

const walkInline = (
  parent: XmlElement,
  state: RunState,
  context: PartContext,
  mode: "normal" | "inserted" | "deleted",
  depth: number,
): void => {
  if (depth > MAX_NESTING) {
    context.counters.omit("nesting-limit", NESTING_NOTE);
    return;
  }
  for (const entry of expanded(parent)) {
    if (
      entry.ns === M &&
      (entry.local === "oMath" || entry.local === "oMathPara")
    ) {
      const flat = mathText(entry);
      if (mode !== "deleted") state.text += flat;
      context.counters.omit(
        "equation",
        "Equations are flattened to their text; structure and layout are lost.",
      );
      continue;
    }
    if (entry.ns !== W) continue;
    switch (entry.local) {
      case "r":
        readRun(entry, state, context, mode);
        break;
      case "hyperlink": {
        const before = state.text.length;
        walkInline(entry, state, context, mode, depth + 1);
        const id = attr(entry, "id", R);
        const anchor = attr(entry, "anchor", W);
        const relationship = byId(context.rels, id);
        const target =
          relationship !== undefined
            ? relationship.target
            : anchor !== undefined
              ? `#${anchor}`
              : undefined;
        if (target !== undefined) {
          context.counters.add("hyperlinks");
          if (state.links.length >= MAX_PARAGRAPH_LISTED)
            context.counters.omit(
              "links-past-limit",
              `A paragraph lists at most ${String(MAX_PARAGRAPH_LISTED)} hyperlinks; the rest are counted here.`,
            );
          else
            state.links.push({
              text: clip(state.text.slice(before)),
              target: clip(
                anchor !== undefined && relationship !== undefined
                  ? `${relationship.target}#${anchor}`
                  : target,
              ),
              external: relationship?.external ?? false,
            });
        }
        break;
      }
      case "ins":
      case "moveTo":
        context.counters.add("tracked_insertions");
        walkInline(entry, state, context, "inserted", depth + 1);
        break;
      case "del":
      case "moveFrom":
        context.counters.add("tracked_deletions");
        walkInline(entry, state, context, "deleted", depth + 1);
        break;
      case "fldSimple": {
        const instr = attr(entry, "instr", W);
        if (instr !== undefined && instr.trim() !== "")
          addField(state, context, instr);
        walkInline(entry, state, context, mode, depth + 1);
        break;
      }
      case "sdt": {
        const content = child(entry, W, "sdtContent");
        if (content !== undefined)
          walkInline(content, state, context, mode, depth + 1);
        break;
      }
      case "smartTag":
      case "customXml":
      case "sdtContent":
        walkInline(entry, state, context, mode, depth + 1);
        break;
      default:
        break;
    }
  }
};

const readParagraph = (
  p: XmlElement,
  context: PartContext,
): Omit<OfficeParagraph, "kind" | "index" | "location"> => {
  const properties = child(p, W, "pPr");
  const styleId = wval(child(properties ?? p, W, "pStyle"));
  const style =
    styleId === undefined
      ? null
      : (context.styles.names.get(styleId) ?? styleId);
  const numbering =
    properties === undefined ? undefined : child(properties, W, "numPr");
  const numId =
    numbering === undefined ? undefined : wval(child(numbering, W, "numId"));
  const level =
    numbering === undefined ? undefined : wval(child(numbering, W, "ilvl"));
  const listLevel =
    numbering !== undefined && numId !== "0"
      ? Math.min(
          MAX_LIST_LEVEL,
          Math.max(0, Number.parseInt(level ?? "0", 10) || 0),
        )
      : null;
  const outline = wval(
    properties === undefined ? undefined : child(properties, W, "outlineLvl"),
  );
  const headingMatch = HEADING.exec(style ?? "") ?? HEADING.exec(styleId ?? "");
  const headingLevel =
    headingMatch?.[1] !== undefined
      ? Number.parseInt(headingMatch[1], 10)
      : outline !== undefined && /^[0-8]$/u.test(outline)
        ? Number.parseInt(outline, 10) + 1
        : null;
  const state: RunState = {
    text: "",
    links: [],
    fields: [],
    styleHidden: styleId !== undefined && context.styles.hidden.has(styleId),
    visible: 0,
    hiddenRuns: 0,
    inserted: 0,
    deleted: 0,
  };
  walkInline(p, state, context, "normal", 0);
  const revision: OfficeParagraph["revision"] =
    state.inserted > 0 && state.deleted > 0
      ? "mixed"
      : state.inserted > 0
        ? "inserted"
        : state.deleted > 0
          ? "deleted"
          : null;
  const text = capText(state.text, context.counters);
  return {
    style,
    heading_level: headingLevel,
    list_level: listLevel,
    hidden: state.hiddenRuns > 0 && state.visible === 0,
    revision:
      state.text.trim() === "" && state.deleted > 0 ? "deleted" : revision,
    text,
    links: state.links,
    fields: state.fields,
  };
};

/** Children with content controls and custom-XML wrappers replaced by what they hold. */
const unwrapped = (
  parent: XmlElement,
  context: PartContext,
  depth = 0,
): readonly XmlElement[] => {
  if (depth > MAX_NESTING) {
    context.counters.omit("nesting-limit", NESTING_NOTE);
    return [];
  }
  return expanded(parent).flatMap((entry) => {
    if (entry.ns !== W) return [entry];
    if (entry.local === "sdt") {
      const content = child(entry, W, "sdtContent");
      return content === undefined
        ? []
        : unwrapped(content, context, depth + 1);
    }
    return entry.local === "customXml" || entry.local === "sdtContent"
      ? unwrapped(entry, context, depth + 1)
      : [entry];
  });
};

const cellText = (
  cell: XmlElement,
  context: PartContext,
  depth: number,
): string => {
  const lines: string[] = [];
  for (const entry of unwrapped(cell, context)) {
    if (entry.ns !== W) continue;
    if (entry.local === "p") lines.push(readParagraph(entry, context).text);
    else if (entry.local === "tbl") {
      if (depth < MAX_NESTING)
        lines.push(
          readTable(entry, context, depth + 1)
            .map((row) => row.join(" | "))
            .join("\n"),
        );
      else context.counters.omit("nesting-limit", NESTING_NOTE);
    }
  }
  return lines.join("\n");
};

const readTable = (
  tbl: XmlElement,
  context: PartContext,
  depth: number,
): string[][] => {
  const rows: string[][] = [];
  for (const tr of unwrapped(tbl, context)) {
    if (tr.ns !== W || tr.local !== "tr") continue;
    const cells: string[] = [];
    for (const entry of unwrapped(tr, context))
      if (entry.ns === W && entry.local === "tc")
        cells.push(cellText(entry, context, depth));
    rows.push(cells);
  }
  return rows;
};

const tableItem = (
  tbl: XmlElement,
  context: PartContext,
  index: number,
  location: string,
): OfficeTable => {
  const grid = readTable(tbl, context, 0);
  const columns = grid.reduce((most, row) => Math.max(most, row.length), 0);
  const truncated = grid.length > MAX_TABLE_ROWS || columns > MAX_TABLE_COLUMNS;
  return {
    kind: "table",
    index,
    location,
    rows: grid.length,
    columns,
    cells: grid
      .slice(0, MAX_TABLE_ROWS)
      .map((row) =>
        row
          .slice(0, MAX_TABLE_COLUMNS)
          .map((cell) => capText(cell, context.counters)),
      ),
    truncated,
  };
};

/** Block-level content in order: paragraphs and tables, descending into content controls. */
const walkBlocks = (
  parent: XmlElement,
  context: PartContext,
  visit: (item: OfficeItem) => void,
  next: () => number,
  depth = 0,
): void => {
  if (depth > MAX_NESTING) {
    context.counters.omit("nesting-limit", NESTING_NOTE);
    return;
  }
  for (const entry of expanded(parent)) {
    if (entry.ns !== W) continue;
    switch (entry.local) {
      case "p": {
        context.paragraph += 1;
        context.counters.add("paragraphs");
        visit({
          kind: "paragraph",
          index: next(),
          location: `${context.part}#p${String(context.paragraph)}`,
          ...readParagraph(entry, context),
        });
        break;
      }
      case "tbl": {
        context.table += 1;
        context.counters.add("tables");
        visit(
          tableItem(
            entry,
            context,
            next(),
            `${context.part}#tbl${String(context.table)}`,
          ),
        );
        break;
      }
      case "sdt": {
        const content = child(entry, W, "sdtContent");
        if (content !== undefined)
          walkBlocks(content, context, visit, next, depth + 1);
        break;
      }
      case "sdtContent":
      case "customXml":
      case "ins":
      case "del":
        walkBlocks(entry, context, visit, next, depth + 1);
        break;
      default:
        break;
    }
  }
};

export interface DocxReaderInput {
  readonly pack: OpcPackage;
  readonly mainPart: string;
  readonly counters: ReaderCounters;
  readonly signal: AbortSignal | undefined;
}

const partLabel = (path: string): string =>
  path.slice(path.lastIndexOf("/") + 1);

export const openDocx = async (
  input: DocxReaderInput,
): Promise<DocumentReader> => {
  const { pack, mainPart, counters, signal } = input;
  const mainRels = await pack.relationships(mainPart, signal);
  const stylesRel = byKind(mainRels, "styles");
  const stylesRoot =
    stylesRel?.part === null || stylesRel === undefined
      ? undefined
      : await pack.readXml(stylesRel.part, signal);
  if (stylesRoot !== undefined && !stylesRoot.ok)
    counters.diagnose(stylesRel?.part ?? null, stylesRoot.reason);
  const styles = readStyles(
    stylesRoot?.ok === true ? stylesRoot.root : undefined,
  );

  const parts: OfficeContentPart[] = [
    { id: "body", label: "Document body", kind: "body", hidden: false },
  ];
  const sources = new Map<
    string,
    { path: string; rels: readonly Relationship[] }
  >();
  sources.set("body", { path: mainPart, rels: mainRels });
  const extras: [string, string, OfficeContentPart["kind"]][] = [
    ["comments", "Comments", "comments"],
    ["footnotes", "Footnotes", "footnotes"],
    ["endnotes", "Endnotes", "endnotes"],
  ];
  for (const [kind, label, partKind] of extras) {
    const rel = byKind(mainRels, kind);
    if (rel?.part != null) {
      parts.push({ id: kind, label, kind: partKind, hidden: false });
      sources.set(kind, {
        path: rel.part,
        rels: await pack.relationships(rel.part, signal),
      });
    }
  }
  for (const rel of mainRels) {
    if ((rel.kind === "header" || rel.kind === "footer") && rel.part !== null) {
      const id = `${rel.kind}:${partLabel(rel.part)}`;
      if (sources.has(id)) continue;
      parts.push({
        id,
        label: `${rel.kind === "header" ? "Header" : "Footer"} ${partLabel(rel.part)}`,
        kind: rel.kind,
        hidden: false,
      });
      sources.set(id, {
        path: rel.part,
        rels: await pack.relationships(rel.part, signal),
      });
    }
  }

  const settingsRel = byKind(mainRels, "settings");
  if (settingsRel?.part != null) {
    const settings = await pack.readXml(settingsRel.part, signal);
    if (settings.ok) {
      if (child(settings.root, W, "documentProtection") !== undefined)
        counters.set("document_protection", 1);
      if (on(child(settings.root, W, "trackRevisions")))
        counters.set("track_revisions_on", 1);
    }
  }

  return {
    family: "word",
    contentParts: () => parts,
    defaultPart: () => parts[0],
    async forEach(part, visit) {
      const source = sources.get(part.id);
      if (source === undefined) return;
      const parsed = await pack.readXml(source.path, signal);
      if (!parsed.ok) {
        counters.diagnose(source.path, parsed.reason);
        return;
      }
      const context: PartContext = {
        part: source.path,
        rels: source.rels,
        styles,
        counters,
        paragraph: 0,
        table: 0,
        fieldStack: [],
      };
      let index = 0;
      const next = (): number => index++;
      if (part.kind === "comments") {
        for (const comment of childrenOf(parsed.root, W, "comment")) {
          const text = capText(
            childrenOf(comment, W, "p")
              .map((p) => readParagraph(p, context).text)
              .join("\n"),
            counters,
          );
          counters.add("comments");
          visit({
            kind: "comment",
            index: next(),
            location: `${source.path}#comment${attr(comment, "id", W) ?? String(index)}`,
            id: attr(comment, "id", W) ?? null,
            author: attr(comment, "author", W) ?? null,
            date: attr(comment, "date", W) ?? null,
            text,
          });
        }
      } else if (part.kind === "footnotes" || part.kind === "endnotes") {
        const local = part.kind === "footnotes" ? "footnote" : "endnote";
        for (const note of childrenOf(parsed.root, W, local)) {
          const type = attr(note, "type", W);
          if (
            type === "separator" ||
            type === "continuationSeparator" ||
            type === "continuationNotice"
          )
            continue;
          counters.add(part.kind);
          const text = capText(
            childrenOf(note, W, "p")
              .map((p) => readParagraph(p, context).text)
              .join("\n"),
            counters,
          );
          visit({
            kind: "note",
            index: next(),
            location: `${source.path}#${local}${attr(note, "id", W) ?? String(index)}`,
            id: attr(note, "id", W) ?? null,
            text,
          });
        }
      } else {
        const body = child(parsed.root, W, "body") ?? parsed.root;
        walkBlocks(body, context, visit, next);
        if (part.kind === "body") {
          counters.set("sections", descendants(body, W, "sectPr"));
          if (descendants(body, W, "bookmarkStart") > 0)
            counters.set("bookmarks", descendants(body, W, "bookmarkStart"));
        }
      }
    },
  };
};
