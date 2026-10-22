import { describe, expect, it } from "vitest";

import type { ImageFile } from "../domain/containerImage/containerImage.js";
import {
  normalizeLayerPath,
  parseWhiteout,
  resolveLinkTarget,
} from "./layerPaths.js";
import { LayerView } from "./layerView.js";

const file = (
  path: string,
  layer: number,
  type: ImageFile["type"] = "file",
): ImageFile => ({
  path,
  type,
  mode: "0644",
  special: [],
  uid: 0,
  gid: 0,
  user: null,
  group: null,
  size: type === "file" ? 1 : null,
  mtime: null,
  link_target: null,
  link_status: null,
  layer,
  implicit: false,
  hides: null,
});

const paths = (view: LayerView): string[] =>
  [...view.entries()].map((entry) => entry.path);

describe("layer paths", () => {
  it("normalizes rooted and dotted names and refuses climbing ones", () => {
    expect(normalizeLayerPath("./etc//passwd")).toEqual({
      kind: "path",
      path: "etc/passwd",
    });
    expect(normalizeLayerPath("/usr/bin/")).toEqual({
      kind: "path",
      path: "usr/bin",
    });
    expect(normalizeLayerPath("./")).toEqual({ kind: "root" });
    expect(normalizeLayerPath("a/../../b").kind).toBe("unsafe");
    expect(normalizeLayerPath("a\0b").kind).toBe("unsafe");
  });

  it("reads whiteouts, opaque markers and reserved names", () => {
    expect(parseWhiteout("etc/.wh.passwd")).toEqual({
      kind: "whiteout",
      hides: "etc/passwd",
    });
    expect(parseWhiteout(".wh.top")).toEqual({
      kind: "whiteout",
      hides: "top",
    });
    expect(parseWhiteout("var/cache/.wh..wh..opq")).toEqual({
      kind: "opaque",
      directory: "var/cache",
    });
    expect(parseWhiteout("a/.wh..wh.plnk")).toEqual({ kind: "reserved" });
    expect(parseWhiteout("a/.wh...")).toEqual({ kind: "reserved" });
    expect(parseWhiteout("a/.wh.")).toBeNull();
    expect(parseWhiteout("a/.whale")).toBeNull();
  });

  it("resolves link targets inside the root", () => {
    expect(resolveLinkTarget("usr/bin/sh", "bash")).toEqual({
      path: "usr/bin/bash",
    });
    expect(resolveLinkTarget("usr/bin/sh", "../lib/x")).toEqual({
      path: "usr/lib/x",
    });
    expect(resolveLinkTarget("usr/bin/sh", "/etc/../bin")).toEqual({
      path: "bin",
    });
    expect(resolveLinkTarget("sh", "../../etc")).toEqual({ escapes: true });
    expect(resolveLinkTarget("a/b", "/../etc")).toEqual({ path: "etc" });
  });
});

describe("composed layer view", () => {
  it("adds implicit parents, replaces files and merges directories", () => {
    const view = new LayerView();
    view.set(file("etc", 0, "directory"));
    view.set(file("etc/a", 0));
    expect(view.set(file("opt/tool/bin", 0)).implicit).toBe(2);
    expect(paths(view)).toEqual([
      "etc",
      "etc/a",
      "opt",
      "opt/tool",
      "opt/tool/bin",
    ]);
    expect(view.get("opt")?.implicit).toBe(true);
    const merged = view.set({ ...file("etc", 1, "directory"), mode: "0700" });
    expect(merged.removed).toBe(0);
    expect(view.get("etc")?.mode).toBe("0700");
    expect(view.get("etc/a")?.layer).toBe(0);
    expect(view.size).toBe(5);
  });

  it("drops a directory's contents when a file replaces it", () => {
    const view = new LayerView();
    view.set(file("data/x", 0));
    view.set(file("data/y", 0));
    const effect = view.set(file("data", 1));
    expect(effect.removed).toBe(3);
    expect(paths(view)).toEqual(["data"]);
    expect(view.get("data")?.type).toBe("file");
    expect(view.size).toBe(1);
  });

  it("replaces a file ancestor with a directory when a child arrives", () => {
    const view = new LayerView();
    view.set(file("a", 0));
    const effect = view.set(file("a/b", 1));
    expect(effect.removed).toBe(1);
    expect(view.get("a")?.type).toBe("directory");
    expect(view.get("a")?.implicit).toBe(true);
    expect(paths(view)).toEqual(["a", "a/b"]);
    expect(view.size).toBe(2);
  });

  it("counts only lower-layer entries as removed", () => {
    const view = new LayerView();
    view.set(file("a/x", 0));
    // Same layer, twice: the second write replaces nothing from below.
    view.set(file("b", 1));
    expect(view.set(file("b", 1)).removed).toBe(0);
    // A layer-1 file over a layer-0 directory hides the directory and its child.
    expect(view.set(file("a", 1)).removed).toBe(2);
  });

  it("removes a subtree and clears children without touching the directory", () => {
    const view = new LayerView();
    for (const name of ["d/a", "d/b/c", "e"]) view.set(file(name, 0));
    expect(view.remove("d/b")).toBe(2);
    expect(paths(view)).toEqual(["d", "d/a", "e"]);
    expect(view.clearChildren("d")).toBe(1);
    expect(paths(view)).toEqual(["d", "e"]);
    expect(view.remove("missing")).toBe(0);
    expect(view.size).toBe(2);
  });
});
