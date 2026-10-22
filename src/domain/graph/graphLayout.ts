import type { GraphEdge, GraphNode } from "./graphModel.js";

/**
 * Layered top-to-bottom layout (Sugiyama style): break cycles, assign layers
 * by longest path, add bend points for long edges, order each layer by
 * barycenter sweeps, then place. Pure and deterministic: only arrays and
 * source order decide ties, so the screen and a report draw the same picture.
 * Own code instead of a layout library: no runtime dependency, and the draw
 * limit (300 nodes) keeps the quadratic parts small.
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface PlacedNode {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PlacedEdge {
  readonly index: number;
  readonly from: string;
  readonly to: string;
  readonly points: readonly Point[];
  /** A self-call; its points already sit on the node's border. */
  readonly loop?: boolean;
}

export interface GraphLayout {
  readonly width: number;
  readonly height: number;
  readonly nodes: readonly PlacedNode[];
  readonly edges: readonly PlacedEdge[];
}

export const NODE_HEIGHT = 34;
const LAYER_GAP = 70;
const NODE_GAP = 24;
const MARGIN = 20;
const DUMMY_WIDTH = 8;
const SWEEPS = 6;
// Bend points for long edges; past this, an edge is drawn straight.
const MAX_BEND_POINTS = 20_000;
const LOOP = 18;
export const MAX_LABEL_CHARS = 28;

export const nodeWidth = (label: string) =>
  Math.min(MAX_LABEL_CHARS, Math.max(6, [...label].length)) * 7.2 + 24;

export function layoutGraph(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
): GraphLayout {
  const index = new Map(nodes.map((node, i) => [node.id, i]));
  const known = edges
    .map((edge, i) => ({ i, a: index.get(edge.from), b: index.get(edge.to) }))
    .filter(
      (link): link is { i: number; a: number; b: number } =>
        link.a !== undefined && link.b !== undefined,
    );
  const links = known.filter((link) => link.a !== link.b);
  const loops = known.filter((link) => link.a === link.b);
  const reversed = backEdges(nodes.length, links);
  const forward = links.map((link) =>
    reversed.has(link.i) ? { i: link.i, a: link.b, b: link.a } : link,
  );
  const layer = longestPath(nodes.length, forward);

  // Real nodes first, then bend points for edges spanning several layers.
  const width = nodes.map((node) => nodeWidth(node.label));
  const rank = [...layer];
  const chains = forward.map((link) => {
    const chain = [link.a];
    const span = layer[link.b]! - layer[link.a]! - 1;
    if (rank.length - nodes.length + span > MAX_BEND_POINTS)
      return { i: link.i, chain: [link.a, link.b] };
    for (let r = layer[link.a]! + 1; r < layer[link.b]!; r++) {
      chain.push(rank.length);
      rank.push(r);
      width.push(DUMMY_WIDTH);
    }
    chain.push(link.b);
    return { i: link.i, chain };
  });
  const up: number[][] = rank.map(() => []);
  const down: number[][] = rank.map(() => []);
  for (const { chain } of chains)
    for (let k = 1; k < chain.length; k++) {
      down[chain[k - 1]!]!.push(chain[k]!);
      up[chain[k]!]!.push(chain[k - 1]!);
    }

  const layers: number[][] = [];
  rank.forEach((r, v) => (layers[r] ??= []).push(v));
  const order = orderLayers(layers, up, down);

  const x = placeX(order, width);
  const y = (v: number) => MARGIN + rank[v]! * (NODE_HEIGHT + LAYER_GAP);
  const loopRoom = loops.length ? LOOP : 0;
  const span = Math.max(
    0,
    ...order.flat().map((v) => x[v]! + width[v]! + loopRoom),
  );
  const center = (v: number): Point => ({
    x: x[v]! + width[v]! / 2,
    y: y(v) + NODE_HEIGHT / 2,
  });

  return {
    width: span + MARGIN,
    height: order.length
      ? MARGIN * 2 + order.length * (NODE_HEIGHT + LAYER_GAP) - LAYER_GAP
      : MARGIN * 2,
    nodes: nodes.map((node, v) => ({
      id: node.id,
      x: x[v]!,
      y: y(v),
      width: width[v]!,
      height: NODE_HEIGHT,
    })),
    edges: [
      ...chains.map(({ i, chain }) => {
        const path = (reversed.has(i) ? [...chain].reverse() : chain).map(
          center,
        );
        return {
          index: i,
          from: edges[i]!.from,
          to: edges[i]!.to,
          points: path,
        };
      }),
      // A call to itself: a small loop on the node's right side.
      ...loops.map(({ i, a }) => {
        const right = x[a]! + width[a]!;
        const top = y(a);
        return {
          index: i,
          from: edges[i]!.from,
          to: edges[i]!.to,
          loop: true,
          points: [
            { x: right, y: top + NODE_HEIGHT * 0.25 },
            { x: right + LOOP, y: top + NODE_HEIGHT * 0.5 },
            { x: right, y: top + NODE_HEIGHT * 0.75 },
          ],
        };
      }),
    ],
  };
}

/** Edges that close a cycle in a depth-first walk in source order. */
function backEdges(
  count: number,
  links: readonly { i: number; a: number; b: number }[],
): Set<number> {
  const out: { i: number; b: number }[][] = Array.from(
    { length: count },
    () => [],
  );
  for (const link of links) out[link.a]!.push(link);
  const state = new Uint8Array(count); // 0 new, 1 on stack, 2 done
  const back = new Set<number>();
  for (let start = 0; start < count; start++) {
    if (state[start]) continue;
    const stack: { v: number; k: number }[] = [{ v: start, k: 0 }];
    state[start] = 1;
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      const next = out[top.v]![top.k++];
      if (!next) {
        state[top.v] = 2;
        stack.pop();
      } else if (state[next.b] === 1) back.add(next.i);
      else if (state[next.b] === 0) {
        state[next.b] = 1;
        stack.push({ v: next.b, k: 0 });
      }
    }
  }
  return back;
}

/** Layer = longest path from a source, over the now acyclic edges. */
function longestPath(
  count: number,
  links: readonly { a: number; b: number }[],
): number[] {
  const layer = new Array<number>(count).fill(0);
  const indegree = new Array<number>(count).fill(0);
  const out: number[][] = Array.from({ length: count }, () => []);
  for (const { a, b } of links) {
    out[a]!.push(b);
    indegree[b]!++;
  }
  const queue = layer.map((_, v) => v).filter((v) => indegree[v] === 0);
  for (let head = 0; head < queue.length; head++) {
    const v = queue[head]!;
    for (const w of out[v]!) {
      layer[w] = Math.max(layer[w]!, layer[v]! + 1);
      if (--indegree[w]! === 0) queue.push(w);
    }
  }
  return layer;
}

/** Barycenter sweeps down and up; stable sort keeps ties in place. */
function orderLayers(
  layers: number[][],
  up: readonly number[][],
  down: readonly number[][],
): number[][] {
  const order = layers.map((layer) => [...layer]);
  const position = new Map<number, number>();
  const mark = (layer: readonly number[]) =>
    layer.forEach((v, p) => position.set(v, p));
  order.forEach(mark);
  const sort = (layer: number[], neighbors: readonly number[][]) => {
    const score = new Map(
      layer.map((v, p) => {
        const list = neighbors[v]!;
        return [
          v,
          list.length
            ? list.reduce((sum, w) => sum + position.get(w)!, 0) / list.length
            : p,
        ];
      }),
    );
    layer.sort((a, b) => score.get(a)! - score.get(b)!);
    mark(layer);
  };
  for (let sweep = 0; sweep < SWEEPS; sweep++) {
    if (sweep % 2 === 0)
      for (let r = 1; r < order.length; r++) sort(order[r]!, up);
    else for (let r = order.length - 2; r >= 0; r--) sort(order[r]!, down);
  }
  return order;
}

/** Left-to-right in order, each layer centred on the widest one. */
function placeX(
  order: readonly number[][],
  width: readonly number[],
): number[] {
  const rowWidth = order.map(
    (layer) =>
      layer.reduce((sum, v) => sum + width[v]!, 0) +
      Math.max(0, layer.length - 1) * NODE_GAP,
  );
  const widest = Math.max(0, ...rowWidth);
  const x: number[] = new Array<number>(width.length).fill(0);
  order.forEach((layer, r) => {
    let at = MARGIN + (widest - rowWidth[r]!) / 2;
    for (const v of layer) {
      x[v] = at;
      at += width[v]! + NODE_GAP;
    }
  });
  return x;
}
