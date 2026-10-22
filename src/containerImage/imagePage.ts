import type {
  ContainerImageReport,
  ImageFile,
} from "../domain/containerImage/containerImage.js";
import type { FacetCoverage } from "../domain/formatRegistry.js";
import { resolveLinkTarget } from "./layerPaths.js";
import type { LayerView } from "./layerView.js";
import type { Selection } from "./imageSelect.js";

type Layer = ContainerImageReport["layers"][number];

const COUNT_KEY: Partial<Record<ImageFile["type"], keyof Counts>> = {
  file: "files",
  directory: "directories",
  symlink: "symlinks",
  hardlink: "hardlinks",
  whiteout: "whiteouts",
  "opaque-marker": "opaque_directories",
};

type Counts = Pick<
  Layer,
  | "files"
  | "directories"
  | "symlinks"
  | "hardlinks"
  | "special_files"
  | "whiteouts"
  | "opaque_directories"
>;

export const countMembers = (members: readonly ImageFile[]): Counts => {
  const counts: Counts = {
    files: 0,
    directories: 0,
    symlinks: 0,
    hardlinks: 0,
    special_files: 0,
    whiteouts: 0,
    opaque_directories: 0,
  };
  for (const member of members)
    counts[COUNT_KEY[member.type] ?? "special_files"] += 1;
  return counts;
};

type Lookup = (path: string) => ImageFile | undefined;

/** Fill in link_status (and a hard link's size) from the paths the view holds. */
const withLinkStatus = (file: ImageFile, lookup: Lookup | null): ImageFile => {
  // A hard link was resolved against its own layer when it was applied.
  if (file.link_target === null || file.link_status !== null) return file;
  if (file.type === "symlink") {
    const target = resolveLinkTarget(file.path, file.link_target);
    if ("escapes" in target) return { ...file, link_status: "escapes_root" };
    if (lookup === null) return file;
    return {
      ...file,
      link_status: lookup(target.path) === undefined ? "dangling" : "resolved",
    };
  }
  if (file.type === "hardlink" && lookup !== null) {
    const target = resolveLinkTarget("", file.link_target);
    const found = "path" in target ? lookup(target.path) : undefined;
    return found === undefined
      ? { ...file, link_status: "dangling" }
      : { ...file, link_status: "resolved", size: found.size };
  }
  return file;
};

export interface FilePage {
  readonly fileCount: number;
  readonly files: ImageFile[];
  readonly next: number | null;
}

interface Window {
  readonly start: number;
  readonly limit: number;
}

/** One window of the composed view in its stable order. */
export const pageComposed = (view: LayerView, window: Window): FilePage => {
  const files: ImageFile[] = [];
  const lookup: Lookup = (path) => view.get(path);
  let seen = 0;
  for (const entry of view.entries()) {
    if (seen >= window.start + window.limit) break;
    if (seen >= window.start) files.push(withLinkStatus(entry, lookup));
    seen += 1;
  }
  return page(files, view.size, window);
};

/** One window of a single layer's own entries, in tar order. */
export const pageLayer = (
  members: readonly ImageFile[] | null,
  window: Window,
): FilePage =>
  page(
    (members ?? [])
      .slice(window.start, window.start + window.limit)
      .map((entry) => withLinkStatus(entry, null)),
    members?.length ?? 0,
    window,
  );

const page = (
  files: ImageFile[],
  fileCount: number,
  window: Window,
): FilePage => ({
  fileCount,
  files,
  next:
    window.start + files.length < fileCount
      ? window.start + files.length
      : null,
});

const facet = (
  name: FacetCoverage["facet"],
  state: FacetCoverage["state"],
  rest: Partial<Omit<FacetCoverage, "facet" | "state">>,
): FacetCoverage => ({
  facet: name,
  state,
  examined: null,
  omitted: null,
  reason: null,
  continuation: null,
  ...rest,
});

export interface CoverageInput {
  readonly selected: boolean;
  readonly selection: Selection;
  readonly composed: boolean;
  readonly inventoryComplete: boolean;
  readonly inspectComplete: boolean;
}

export const coverageOf = (input: CoverageInput): FacetCoverage[] => {
  const scope = input.composed
    ? "every layer, applied in order to a virtual filesystem"
    : "one layer's own entries";
  return [
    facet("identify", "complete", {
      examined: "image archive or layout structure, index and manifests",
    }),
    !input.selected
      ? facet("inventory", "partial", {
          examined: "the index and the images it lists",
          omitted: "layers and the composed filesystem",
          reason: input.selection.reason,
          continuation: "Pass platform or manifest to select one image.",
        })
      : input.inventoryComplete
        ? facet("inventory", "complete", { examined: scope })
        : facet("inventory", "partial", {
            examined: input.composed
              ? "the layers that could be read and trusted"
              : scope,
            omitted:
              "layers that were missing, foreign, damaged or did not match their digests",
            reason: "See diagnostics and each layer's blob and diff_id checks.",
          }),
    input.inspectComplete
      ? facet("inspect", "complete", {
          examined: "manifests, configuration, layer digests and diff ids",
        })
      : facet("inspect", "partial", {
          examined: "manifests, configuration, layer digests and diff ids",
          omitted: "items listed in diagnostics",
          reason:
            "Some blobs are missing, foreign, unverifiable or do not match their descriptors.",
        }),
    facet("extract", "not_requested", {
      reason:
        "extract_artifact materializes the composed filesystem into owned scratch space.",
    }),
  ];
};
