import {
  MAX_LABEL_CHARS,
  type GraphLayout,
  type Point,
} from "./graphLayout.js";
import type { GraphNode } from "./graphModel.js";
import type { GraphView } from "./graphView.js";

/**
 * Builds the graph picture as one standalone SVG string. The dashboard shows
 * it and downloads it, and reports embed it. Every value is escaped; colors
 * are presentation attributes (no style element), so it renders the same in
 * a page with a strict content security policy and as a file.
 */

const PALETTE = [
  "#dbeafe",
  "#dcfce7",
  "#fef3c7",
  "#f3e8ff",
  "#e0f2fe",
  "#ffe4e6",
  "#ecfccb",
  "#f5f5f4",
];
const INK = "#1c1917";
const LINE = "#57534e";
const FAILED = "#b91c1c";
const SELECTED = "#c2410c";

export const escapeXml = (value: string) =>
  // C0 controls are not allowed in XML 1.0; a downloaded SVG must still parse.
  value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "\uFFFD").replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c]!,
  );

/** Each kind's fill, by first appearance in the view (stable per view). */
export function kindColors(nodes: readonly GraphNode[]): Map<string, string> {
  const colors = new Map<string, string>();
  for (const node of nodes)
    if (!colors.has(node.kind))
      colors.set(node.kind, PALETTE[colors.size % PALETTE.length]!);
  return colors;
}

const truncate = (label: string) => {
  const chars = [...label];
  return chars.length > MAX_LABEL_CHARS
    ? `${chars.slice(0, MAX_LABEL_CHARS - 1).join("")}…`
    : label;
};

const QUIET_RELATIONS = new Set(["calls", "contains"]);

export function renderGraphSvg(
  title: string,
  view: GraphView,
  layout: GraphLayout,
  options: { selected?: string | null; idPrefix?: string } = {},
): string {
  const prefix = (options.idPrefix ?? "graph").replace(/[^\w-]/g, "");
  const colors = kindColors(view.nodes);
  const placed = new Map(layout.nodes.map((node) => [node.id, node]));
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${round(layout.width)} ${round(layout.height)}" width="${round(layout.width)}" height="${round(layout.height)}" role="img" aria-label="${escapeXml(title)}" font-family="ui-sans-serif, system-ui, sans-serif" font-size="12">`,
    `<title>${escapeXml(title)}</title>`,
    `<defs><marker id="${prefix}-arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${LINE}"/></marker></defs>`,
    `<rect width="100%" height="100%" fill="#fffdf8"/>`,
  ];
  for (const edge of layout.edges) {
    const source = view.edges[edge.index];
    const from = placed.get(edge.from);
    const to = placed.get(edge.to);
    if (!source || !from || !to) continue;
    const points = edge.loop
      ? edge.points
      : clipEnds(edge.points, from.height / 2, to.height / 2);
    parts.push(
      `<path data-edge-index="${edge.index}" d="${pathData(points)}" fill="none" stroke="${LINE}" stroke-width="1.2"${source.candidate ? ' stroke-dasharray="5 4"' : ""} marker-end="url(#${prefix}-arrow)"><title>${escapeXml(`${source.from} ${source.relation} ${source.to}${source.candidate ? " (candidate)" : ""}`)}</title></path>`,
    );
    if (source.candidate || !QUIET_RELATIONS.has(source.relation)) {
      const mid = midpoint(points);
      parts.push(
        `<text x="${round(mid.x + 4)}" y="${round(mid.y - 3)}" font-size="10" fill="${LINE}">${escapeXml(truncate(source.relation))}</text>`,
      );
    }
  }
  for (const node of view.nodes) {
    const box = placed.get(node.id);
    if (!box) continue;
    const selected = node.id === options.selected;
    const stroke = selected ? SELECTED : node.kind === "failed" ? FAILED : LINE;
    parts.push(
      `<g data-node-id="${escapeXml(node.id)}" tabindex="-1"><title>${escapeXml(`${node.label} (${node.kind})`)}</title><rect x="${round(box.x)}" y="${round(box.y)}" width="${round(box.width)}" height="${round(box.height)}" rx="6" fill="${colors.get(node.kind)}" stroke="${stroke}" stroke-width="${selected ? 2.5 : 1}"/><text x="${round(box.x + box.width / 2)}" y="${round(box.y + box.height / 2 + 4)}" text-anchor="middle" fill="${INK}">${escapeXml(truncate(node.label))}</text></g>`,
    );
  }
  parts.push("</svg>");
  return parts.join("");
}

const round = (value: number) => Math.round(value * 10) / 10;

const pathData = (points: readonly Point[]) =>
  points.map((p, i) => `${i ? "L" : "M"}${round(p.x)} ${round(p.y)}`).join("");

/** Moves the first and last points from node centres to their top/bottom edge. */
function clipEnds(
  points: readonly Point[],
  fromHalf: number,
  toHalf: number,
): Point[] {
  if (points.length < 2) return [...points];
  const out = [...points];
  const first = out[0]!;
  const second = out[1]!;
  out[0] = {
    x: first.x,
    y: first.y + Math.sign(second.y - first.y) * fromHalf,
  };
  const last = out[out.length - 1]!;
  const before = out[out.length - 2]!;
  out[out.length - 1] = {
    x: last.x,
    y: last.y - Math.sign(last.y - before.y) * toHalf,
  };
  return out;
}

function midpoint(points: readonly Point[]): Point {
  const a = points[Math.floor((points.length - 1) / 2)]!;
  const b = points[Math.ceil((points.length - 1) / 2)]!;
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
