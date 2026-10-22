import MarkdownIt from "markdown-it";

import {
  MAX_NODE_PATH_CHARACTERS,
  type StructuralNode,
} from "../../domain/document/structuredText.js";
import type { DocumentBuilder } from "./DocumentBuilder.js";

/** Same options as the hosted reader: raw HTML stays text, no linkify or typography. */
const OPTIONS = { html: false, linkify: false, typographer: false } as const;
const SAFE = new MarkdownIt(OPTIONS);
// Structure lists every link, including the ones the safe renderer refuses.
const PERMISSIVE = new MarkdownIt(OPTIONS);
PERMISSIVE.validateLink = () => true;

const BLOCKS: Readonly<Record<string, StructuralNode["kind"]>> = {
  heading_open: "heading",
  paragraph_open: "paragraph",
  bullet_list_open: "list",
  ordered_list_open: "list",
  blockquote_open: "blockquote",
  table_open: "markdown-table",
  fence: "code-block",
  code_block: "code-block",
  hr: "thematic-break",
};

const RAW_HTML = /<\/?[A-Za-z][^>]*>/gu;

type Token = ReturnType<typeof PERMISSIVE.parse>[number];

const blockDetails = (kind: StructuralNode["kind"], token: Token) =>
  kind === "code-block"
    ? { info: token.info || null, fenced: token.type === "fence" }
    : kind === "list"
      ? { ordered: token.type === "ordered_list_open" }
      : {};

/** Text of an inline link, up to its closing token. */
const linkText = (children: readonly Token[], open: number): string => {
  let text = "";
  for (const next of children.slice(open + 1)) {
    if (next.type === "link_close") break;
    text += next.content;
  }
  return text;
};

/** Links and images of one inline token; returns how many links the safe renderer refuses. */
const emitInline = (
  builder: DocumentBuilder,
  children: readonly Token[],
  path: string,
  at: number | null,
): number => {
  let refused = 0;
  for (const [index, child] of children.entries())
    if (child.type === "link_open") {
      const href = child.attrGet("href") ?? "";
      const rendered = SAFE.validateLink(href);
      if (!rendered) refused += 1;
      builder.node({
        depth: 1,
        kind: "link",
        path,
        name: linkText(children, index),
        value: href,
        at,
        details: { rendered_as_link: rendered, location_precision: "block" },
      });
    } else if (child.type === "image")
      builder.node({
        depth: 1,
        kind: "image",
        path,
        name: child.content,
        value: child.attrGet("src") ?? "",
        at,
        details: { fetched: false, location_precision: "block" },
      });
  return refused;
};

/** Outline Markdown blocks, headings, links and images with their source lines. */
export const walkMarkdown = (builder: DocumentBuilder): void => {
  builder.unit = "block";
  const { source } = builder;
  const tokens = PERMISSIVE.parse(source.text, {});
  const lineAt = (line: number) =>
    source.lineStarts[line] ?? source.text.length;
  const trail: { level: number; text: string }[] = [];
  // Joined once per heading, not per block: a long heading is copied once.
  let trailPath = "";
  const path = () => trailPath;
  let rawHtml = 0;
  let refused = 0;
  for (const [position, token] of tokens.entries()) {
    const kind = BLOCKS[token.type];
    const map = token.map;
    if (kind !== undefined && token.level === 0 && map !== null) {
      const at = lineAt(map[0]);
      builder.unitStarts.push(at);
      const heading = kind === "heading";
      const level = heading ? Number(token.tag.slice(1)) : 0;
      const text = heading ? (tokens[position + 1]?.content ?? "") : null;
      if (heading) {
        while ((trail.at(-1)?.level ?? 0) >= level) trail.pop();
        trail.push({ level, text: text ?? "" });
        const joined = trail.map((entry) => entry.text).join(" › ");
        // One character over the limit lets the builder cut and mark every block under it.
        trailPath =
          joined.length > MAX_NODE_PATH_CHARACTERS
            ? joined.slice(0, MAX_NODE_PATH_CHARACTERS + 1)
            : joined;
      }
      builder.node({
        depth: 0,
        kind,
        path: path(),
        name: text,
        value: kind === "code-block" ? token.content : null,
        at,
        end: lineAt(map[1]),
        details: heading
          ? { level, markup: token.markup }
          : blockDetails(kind, token),
      });
    }
    if (token.type !== "inline" || token.children === null) continue;
    rawHtml += token.content.match(RAW_HTML)?.length ?? 0;
    refused += emitInline(
      builder,
      token.children,
      path(),
      map === null ? null : lineAt(map[0]),
    );
  }
  if (rawHtml > 0)
    builder.diagnostic(
      "info",
      "markdown_raw_html_as_text",
      `${String(rawHtml)} raw HTML tag(s) are shown as text; no embedded HTML, script or frame is rendered.`,
    );
  if (refused > 0)
    builder.diagnostic(
      "info",
      "markdown_link_refused",
      `${String(refused)} link(s) use a protocol the reader does not open (such as javascript: or data:); they are shown as text.`,
    );
};
