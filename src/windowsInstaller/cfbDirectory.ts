import {
  ENTRY_BYTES,
  formatGuid,
  NOSTREAM,
  u16,
  u32,
  type CfbEntry,
} from "./cfbFormat.js";

/** One 128-byte directory entry as stored. */
export interface RawEntry {
  readonly name: string;
  readonly objectType: number;
  readonly left: number;
  readonly right: number;
  readonly child: number;
  readonly clsid: string | null;
  readonly start: number;
  readonly size: number;
}

export const OBJECT_TYPES: Readonly<Record<number, CfbEntry["type"]>> = {
  1: "storage",
  2: "stream",
  5: "root",
};

const UNALLOCATED: RawEntry = {
  name: "",
  objectType: 0,
  left: NOSTREAM,
  right: NOSTREAM,
  child: NOSTREAM,
  clsid: null,
  start: 0,
  size: 0,
};

const decodeName = (
  bytes: Uint8Array,
  id: number,
  problems: string[],
): string => {
  const declared = u16(bytes, 64);
  let units = declared / 2 - 1;
  if (
    declared % 2 !== 0 ||
    declared < 2 ||
    declared > 64 ||
    u16(bytes, declared - 2) !== 0
  ) {
    problems.push(
      `Directory entry ${String(id)} declares a ${String(declared)}-byte name; read up to its first NUL.`,
    );
    units = 0;
    while (units < 32 && u16(bytes, units * 2) !== 0) units += 1;
  }
  let name = "";
  for (let index = 0; index < units; index += 1)
    name += String.fromCharCode(u16(bytes, index * 2));
  return name;
};

/** Directory entries in stream ID order; version 3 sizes ignore the high word ([MS-CFB] 2.6.3). */
export const parseEntries = (
  bytes: Uint8Array,
  version: 3 | 4,
  problems: string[],
): RawEntry[] => {
  const entries: RawEntry[] = [];
  for (let at = 0; at + ENTRY_BYTES <= bytes.length; at += ENTRY_BYTES) {
    const entry = bytes.subarray(at, at + ENTRY_BYTES);
    const id = at / ENTRY_BYTES;
    const objectType = entry[66] ?? 0;
    if (objectType === 0) {
      entries.push(UNALLOCATED);
      continue;
    }
    const low = u32(entry, 120);
    const high = u32(entry, 124);
    if (version === 3 && high !== 0)
      problems.push(
        `Directory entry ${String(id)} has a nonzero high size word in a version 3 file; it is ignored.`,
      );
    entries.push({
      name: decodeName(entry, id, problems),
      objectType,
      left: u32(entry, 68),
      right: u32(entry, 72),
      child: u32(entry, 76),
      clsid: formatGuid(entry, 80),
      start: u32(entry, 116),
      size: version === 4 ? high * 2 ** 32 + low : low,
    });
  }
  return entries;
};

/** The IDs of one storage's children in tree (name) order; bad links are problems. */
interface Tree {
  readonly raw: readonly RawEntry[];
  /** 1 once an entry is placed (or skipped), so a second link to it is a cycle. */
  readonly seen: Uint8Array;
  readonly problems: string[];
}

const siblings = (
  { raw, seen, problems }: Tree,
  start: number,
  parent: number,
): number[] => {
  const ordered: number[] = [];
  const stack: number[] = [];
  let node = start;
  while (node !== NOSTREAM || stack.length > 0) {
    while (node !== NOSTREAM) {
      const entry = raw[node];
      let problem: string | null = null;
      if (entry === undefined)
        problem = `Directory entry ${String(parent)}'s tree points to entry ${String(node)}, past the ${String(raw.length)} entries.`;
      else if (seen[node] === 1)
        problem = `Directory entry ${String(node)} is reached twice (a cycle or shared subtree); the second link is ignored.`;
      else if (
        OBJECT_TYPES[entry.objectType] === undefined ||
        entry.objectType === 5
      ) {
        seen[node] = 1;
        problem = `Directory entry ${String(node)} under entry ${String(parent)} has object type ${String(entry.objectType)}; it is skipped.`;
      }
      if (problem !== null || entry === undefined) {
        if (problem !== null) problems.push(problem);
        break;
      }
      seen[node] = 1;
      stack.push(node);
      node = entry.left;
    }
    const top = stack.pop();
    if (top === undefined) break;
    ordered.push(top);
    node = raw[top]?.right ?? NOSTREAM;
  }
  return ordered;
};

/** Root first, then each storage's children in tree order, depth first; iterative, so depth is unbounded. */
export const walkTree = (
  raw: readonly RawEntry[],
  problems: string[],
): { id: number; path: string[] }[] => {
  const tree: Tree = { raw, seen: new Uint8Array(raw.length), problems };
  tree.seen[0] = 1;
  const out: { id: number; path: string[] }[] = [{ id: 0, path: [] }];
  const work = siblings(tree, raw[0]?.child ?? NOSTREAM, 0)
    .reverse()
    .map((id) => ({ id, path: [raw[id]?.name ?? ""] }));
  for (let next = work.pop(); next !== undefined; next = work.pop()) {
    out.push(next);
    const entry = raw[next.id];
    if (entry?.objectType !== 1) continue;
    const children = siblings(tree, entry.child, next.id);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index] ?? 0;
      work.push({ id: child, path: [...next.path, raw[child]?.name ?? ""] });
    }
  }
  const orphans = raw.filter(
    (entry, id) => entry.objectType !== 0 && tree.seen[id] === 0,
  ).length;
  if (orphans > 0)
    problems.push(
      `${String(orphans)} allocated directory entries are not reachable from the root.`,
    );
  return out;
};
