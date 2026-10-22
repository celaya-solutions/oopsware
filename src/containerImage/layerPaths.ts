/**
 * Layer entry names, normalized once. Layer tars store names relative to the
 * image root, often as `./etc/passwd` or `/etc/passwd`; both mean `etc/passwd`.
 * A name that climbs above the root is refused here, so nothing downstream
 * ever joins an unsafe path.
 */
export type LayerPath =
  | { readonly kind: "path"; readonly path: string }
  | { readonly kind: "root" }
  | { readonly kind: "unsafe"; readonly reason: string };

export const normalizeLayerPath = (name: string): LayerPath => {
  if (name.includes("\0"))
    return { kind: "unsafe", reason: "the name contains a NUL byte" };
  const parts = name.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.length === 0) return { kind: "root" };
  if (parts.includes(".."))
    return { kind: "unsafe", reason: "the name climbs above the image root" };
  return { kind: "path", path: parts.join("/") };
};

/** What a layer entry name means to the layer applier. */
export type Whiteout =
  | { readonly kind: "whiteout"; readonly hides: string }
  | { readonly kind: "opaque"; readonly directory: string }
  | { readonly kind: "reserved" };

const WHITEOUT_PREFIX = ".wh.";
const OPAQUE_NAME = ".wh..wh..opq";
/** AUFS bookkeeping such as `.wh..wh.plnk` and `.wh..wh.aufs`. */
const RESERVED_PREFIX = ".wh..wh.";

/** Classify a normalized layer path as a whiteout, an opaque marker, or neither. */
export const parseWhiteout = (path: string): Whiteout | null => {
  const slash = path.lastIndexOf("/");
  const directory = slash < 0 ? "" : path.slice(0, slash);
  const name = path.slice(slash + 1);
  if (name === OPAQUE_NAME) return { kind: "opaque", directory };
  if (name.startsWith(RESERVED_PREFIX)) return { kind: "reserved" };
  if (
    !name.startsWith(WHITEOUT_PREFIX) ||
    name.length === WHITEOUT_PREFIX.length
  )
    return null;
  const hidden = name.slice(WHITEOUT_PREFIX.length);
  if (hidden === "." || hidden === "..") return { kind: "reserved" };
  return {
    kind: "whiteout",
    hides: directory === "" ? hidden : `${directory}/${hidden}`,
  };
};

/** Parent of a normalized path; the empty string is the root. */
export const parentOf = (path: string): string => {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
};

/**
 * Resolve a link target lexically against the link's own directory. Absolute
 * targets are rooted at the image root, as a container runtime would; a
 * relative target that climbs above the root `escapes`.
 */
export const resolveLinkTarget = (
  linkPath: string,
  target: string,
): { readonly path: string } | { readonly escapes: true } => {
  const absolute = target.startsWith("/");
  const base = absolute ? [] : parentOf(linkPath).split("/").filter(Boolean);
  for (const part of target.split("/")) {
    if (part === "" || part === ".") continue;
    if (part !== "..") base.push(part);
    else if (base.length > 0) base.pop();
    // At the root a runtime stays at the root for an absolute target.
    else if (!absolute) return { escapes: true };
  }
  return { path: base.join("/") };
};
