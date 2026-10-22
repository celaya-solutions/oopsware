import type { ImageFile } from "../domain/containerImage/containerImage.js";
import { parentOf } from "./layerPaths.js";

interface Node {
  entry: ImageFile | null;
  children: Map<string, Node> | null;
}

const countEntries = (node: Node): number => {
  let total = node.entry === null ? 0 : 1;
  for (const child of node.children?.values() ?? [])
    total += countEntries(child);
  return total;
};

/** Entries below a node that come from layers under `layer`: what a layer hid or replaced. */
const countBelow = (node: Node, layer: number): number => {
  let total = node.entry !== null && node.entry.layer < layer ? 1 : 0;
  for (const child of node.children?.values() ?? [])
    total += countBelow(child, layer);
  return total;
};

/** What one layer did to the paths below it. */
export interface LayerEffect {
  /** Lower-layer entries hidden by a whiteout or opaque marker, or replaced. */
  removed: number;
  /** Entries added for parent directories the layer never listed. */
  implicit: number;
}

/**
 * The composed filesystem as a virtual view: a tree of the entries each path
 * resolves to after the layers are applied in order. Nothing touches a disk.
 * Deleted content is dropped, so it is visible only through its own layer.
 */
export class LayerView {
  readonly #root: Node = { entry: null, children: new Map() };
  #size = 0;

  get size(): number {
    return this.#size;
  }

  #find(path: string): Node | undefined {
    let node: Node | undefined = this.#root;
    if (path === "") return node;
    for (const part of path.split("/")) {
      node = node.children?.get(part);
      if (node === undefined) return undefined;
    }
    return node;
  }

  get(path: string): ImageFile | undefined {
    return this.#find(path)?.entry ?? undefined;
  }

  /** Remove a path and everything below it; returns how many entries went. */
  remove(path: string): number {
    if (path === "") return this.clearChildren("");
    const parent = this.#find(parentOf(path));
    const name = path.slice(path.lastIndexOf("/") + 1);
    const node = parent?.children?.get(name);
    if (parent === undefined || node === undefined) return 0;
    parent.children?.delete(name);
    const removed = countEntries(node);
    this.#size -= removed;
    return removed;
  }

  /** Remove everything below a directory, keeping the directory itself. */
  clearChildren(path: string): number {
    const node = this.#find(path);
    if (node?.children === undefined || node.children === null) return 0;
    let removed = 0;
    for (const child of node.children.values()) removed += countEntries(child);
    node.children.clear();
    this.#size -= removed;
    return removed;
  }

  /**
   * Put one layer entry at its path. Missing parent directories are created as
   * implicit directories; a non-directory ancestor is replaced by one, as a
   * layer applier does when a layer adds a child below a file.
   */
  set(entry: ImageFile): LayerEffect {
    const effect: LayerEffect = { removed: 0, implicit: 0 };
    const parts = entry.path.split("/");
    let node = this.#root;
    let walked = "";
    for (const [index, part] of parts.entries()) {
      walked = walked === "" ? part : `${walked}/${part}`;
      node.children ??= new Map();
      let child = node.children.get(part);
      const last = index === parts.length - 1;
      if (child === undefined) {
        child = { entry: null, children: null };
        node.children.set(part, child);
      }
      if (last) {
        const existing = child.entry;
        // Replacing anything but directory-over-directory drops what was below.
        if (
          existing !== null &&
          !(existing.type === "directory" && entry.type === "directory")
        ) {
          effect.removed += countBelow(child, entry.layer);
          this.#size -= countEntries(child);
          child.children = null;
          child.entry = null;
        }
        if (child.entry === null) this.#size += 1;
        child.entry = entry;
      } else if (child.entry === null || child.entry.type !== "directory") {
        if (child.entry !== null && child.entry.type !== "symlink") {
          effect.removed += countBelow(child, entry.layer);
          this.#size -= countEntries(child);
          child.children = null;
          this.#size += 1;
          effect.implicit += 1;
          child.entry = implicitDirectory(walked, entry.layer);
        } else if (child.entry === null) {
          this.#size += 1;
          effect.implicit += 1;
          child.entry = implicitDirectory(walked, entry.layer);
        }
      }
      node = child;
    }
    return effect;
  }

  /** Every entry, parents before children, siblings in name order. */
  *entries(): Generator<ImageFile> {
    function* walk(node: Node): Generator<ImageFile> {
      if (node.entry !== null) yield node.entry;
      if (node.children === null) return;
      for (const name of [...node.children.keys()].sort())
        yield* walk(node.children.get(name) as Node);
    }
    yield* walk(this.#root);
  }
}

const implicitDirectory = (path: string, layer: number): ImageFile => ({
  path,
  type: "directory",
  mode: null,
  special: [],
  uid: null,
  gid: null,
  user: null,
  group: null,
  size: null,
  mtime: null,
  link_target: null,
  link_status: null,
  layer,
  implicit: true,
  hides: null,
});
