import {
  DecodeBudget,
  MemberReadFailure,
  sha256Hex,
  ZipView,
  type ZipMember,
} from "../artifacts/zipMemberView.js";
import {
  attr,
  DEFAULT_XML_LIMITS,
  parseXmlBytes,
  type XmlElement,
  type XmlLimits,
} from "./xml.js";

/** Most ZIP members one package may hold. */
export const MAX_PACKAGE_MEMBERS = 200_000;
/** Largest single XML part, in decoded bytes, this reader parses. */
export const MAX_XML_PART_BYTES = DEFAULT_XML_LIMITS.maxBytes;

const CONTENT_TYPES = "[Content_Types].xml";
const PACKAGE_RELS = "_rels/.rels";
const CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types";
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";

export class PackageFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackageFormatError";
  }
}

export interface Relationship {
  readonly id: string;
  /** Last path segment of the relationship type, for example `officeDocument` or `hyperlink`. */
  readonly kind: string;
  readonly type: string;
  readonly target: string;
  readonly external: boolean;
  /** The package part a relationship points at, or null for an external or unresolvable target. */
  readonly part: string | null;
  /** The part holding the relationships; null for the package itself. */
  readonly source: string | null;
}

export interface PackagePart {
  readonly path: string;
  readonly bytes: number;
  readonly encrypted: boolean;
  readonly contentType: string | null;
}

export type ReadXml =
  | { readonly ok: true; readonly root: XmlElement }
  | {
      readonly ok: false;
      readonly reason: string;
      /** Set when the part could not be read within the decoding budget. */
      readonly failure?: MemberReadFailure;
    };

/** Normalize a part name for case-insensitive lookup (OPC part names compare ignoring case). */
const key = (path: string): string => path.replace(/^\/+/u, "").toLowerCase();

/** A part name as a percent-decoded path, or the name itself when it is not valid percent-encoding. */
const decoded = (path: string): string => {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
};

/** Most package problems kept; the rest are counted. */
const MAX_PROBLEMS = 200;

/** Relationship type families Office writes; a type outside them has no kind, so a decoy cannot pose as one. */
const KNOWN_TYPE_BASES: readonly string[] = [
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/",
  "http://purl.oclc.org/ooxml/officeDocument/relationships/",
  "http://schemas.openxmlformats.org/package/2006/relationships/",
  "http://schemas.microsoft.com/office/",
];

const kindOf = (type: string): string =>
  KNOWN_TYPE_BASES.some((base) => type.startsWith(base))
    ? type.slice(type.lastIndexOf("/") + 1)
    : `other:${type.slice(type.lastIndexOf("/") + 1)}`;

const directoryOf = (path: string): string => {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
};

/** Resolve a relationship target against the part that owns it; `..` cannot leave the package. */
export const resolveTarget = (
  source: string | null,
  target: string,
): string | null => {
  const base = target.startsWith("/")
    ? target.slice(1)
    : [directoryOf(source ?? ""), target].filter(Boolean).join("/");
  const pathOnly = base.split(/[?#]/u)[0] ?? base;
  const segments: string[] = [];
  for (const segment of pathOnly.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.pop() === undefined) return null;
      continue;
    }
    segments.push(segment);
  }
  return segments.length === 0 ? null : segments.join("/");
};

const relationshipsPath = (source: string | null): string => {
  if (source === null) return PACKAGE_RELS;
  const slash = source.lastIndexOf("/");
  return slash === -1
    ? `_rels/${source}.rels`
    : `${source.slice(0, slash)}/_rels/${source.slice(slash + 1)}.rels`;
};

/** A ZIP package read as Open Packaging Conventions parts, content types and relationships. */
export class OpcPackage {
  readonly #zip: ZipView;
  readonly #budget: DecodeBudget;
  readonly #names = new Map<string, string>();
  readonly #defaults = new Map<string, string>();
  readonly #overrides = new Map<string, string>();
  readonly #relationships = new Map<string, readonly Relationship[]>();
  readonly #xmlLimits: XmlLimits;
  #parts: readonly PackagePart[] = [];
  readonly problems: string[] = [];
  #problemsDropped = 0;
  readonly duplicates: readonly string[];

  private constructor(
    zip: ZipView,
    budget: DecodeBudget,
    xmlLimits: XmlLimits,
  ) {
    this.#zip = zip;
    this.#budget = budget;
    this.#xmlLimits = xmlLimits;
    this.duplicates = zip.duplicates;
    const files = zip.members.filter((member) => !member.directory);
    for (const member of files) {
      const at = key(member.path);
      const earlier = this.#names.get(at);
      if (earlier === undefined) this.#names.set(at, member.path);
      else
        this.problem(
          `Parts ${earlier} and ${member.path} differ only in letter case; part names compare ignoring case, so only the first is read.`,
        );
    }
  }

  /** Record a problem with the package, keeping the list bounded. */
  problem(message: string): void {
    if (this.problems.includes(message)) return;
    if (this.problems.length >= MAX_PROBLEMS) this.#problemsDropped += 1;
    else this.problems.push(message);
  }

  get problemsDropped(): number {
    return this.#problemsDropped;
  }

  get parts(): readonly PackagePart[] {
    return this.#parts;
  }

  static async open(
    bytes: Uint8Array,
    budget: DecodeBudget,
    signal?: AbortSignal,
  ): Promise<OpcPackage> {
    const zip = await ZipView.open(bytes, MAX_PACKAGE_MEMBERS);
    try {
      const pack = new OpcPackage(zip, budget, DEFAULT_XML_LIMITS);
      await pack.#readContentTypes(signal);
      pack.#parts = zip.members
        .filter((member) => !member.directory && member.path !== CONTENT_TYPES)
        .map((member: ZipMember): PackagePart => ({
          path: member.path,
          bytes: member.bytes,
          encrypted: member.encrypted,
          contentType: pack.contentTypeOf(member.path),
        }));
      return pack;
    } catch (cause) {
      await zip.close();
      throw cause;
    }
  }

  async #readContentTypes(signal?: AbortSignal): Promise<void> {
    const name = this.#names.get(key(CONTENT_TYPES));
    if (name === undefined)
      throw new PackageFormatError(
        "The ZIP has no [Content_Types].xml, so it is not an Office Open XML package.",
      );
    const parsed = await this.readXml(name, signal);
    if (
      !parsed.ok &&
      parsed.failure !== undefined &&
      parsed.failure.reason !== "format"
    )
      throw parsed.failure;
    if (!parsed.ok)
      throw new PackageFormatError(
        `[Content_Types].xml could not be read: ${parsed.reason}`,
      );
    if (parsed.root.ns !== CT_NS || parsed.root.local !== "Types")
      throw new PackageFormatError(
        "[Content_Types].xml does not have a Types root in the package content-types namespace.",
      );
    for (const entry of parsed.root.children) {
      if (entry.ns !== CT_NS) continue;
      const contentType = attr(entry, "ContentType");
      if (contentType === undefined) continue;
      if (entry.local === "Default") {
        const extension = attr(entry, "Extension");
        if (extension !== undefined)
          this.#defaults.set(extension.toLowerCase(), contentType);
      } else if (entry.local === "Override") {
        const partName = attr(entry, "PartName");
        if (partName !== undefined) {
          this.#overrides.set(key(partName), contentType);
          this.#overrides.set(key(decoded(partName)), contentType);
        }
      }
    }
  }

  /** The declared content type of a part: its override, else the default for its extension. */
  contentTypeOf(path: string): string | null {
    const override = this.#overrides.get(key(path));
    if (override !== undefined) return override;
    const dot = path.lastIndexOf(".");
    const slash = path.lastIndexOf("/");
    if (dot <= slash) return null;
    return this.#defaults.get(path.slice(dot + 1).toLowerCase()) ?? null;
  }

  /** The exact member name of a part, matched ignoring case and a leading slash. */
  find(path: string): string | undefined {
    return this.#names.get(key(path)) ?? this.#names.get(key(decoded(path)));
  }

  has(path: string): boolean {
    return this.find(path) !== undefined;
  }

  async read(path: string, signal?: AbortSignal): Promise<Uint8Array> {
    const name = this.find(path);
    if (name === undefined)
      throw new MemberReadFailure(
        "format",
        `${path} is not a part of the package.`,
      );
    return await this.#zip.read(name, this.#budget, signal);
  }

  async sha256(path: string, signal?: AbortSignal): Promise<string> {
    return sha256Hex(await this.read(path, signal));
  }

  async readXml(path: string, signal?: AbortSignal): Promise<ReadXml> {
    let bytes: Uint8Array;
    try {
      bytes = await this.read(path, signal);
    } catch (cause) {
      if (cause instanceof MemberReadFailure && cause.reason === "cancelled")
        throw cause;
      return {
        ok: false,
        reason: cause instanceof Error ? cause.message : String(cause),
        ...(cause instanceof MemberReadFailure ? { failure: cause } : {}),
      };
    }
    const parsed = parseXmlBytes(bytes, this.#xmlLimits);
    return parsed.ok
      ? { ok: true, root: parsed.value }
      : { ok: false, reason: `${path}: ${parsed.error.message}` };
  }

  /** Relationships declared for the package (`null`) or for one part. A bad relationships part is a problem, not a failure. */
  async relationships(
    source: string | null,
    signal?: AbortSignal,
  ): Promise<readonly Relationship[]> {
    const cacheKey = source === null ? "" : key(source);
    const cached = this.#relationships.get(cacheKey);
    if (cached !== undefined) return cached;
    const path = this.find(relationshipsPath(source));
    let list: Relationship[] = [];
    if (path !== undefined) {
      const parsed = await this.readXml(path, signal);
      if (!parsed.ok) this.problem(parsed.reason);
      else if (
        parsed.root.ns !== REL_NS ||
        parsed.root.local !== "Relationships"
      )
        this.problem(`${path}: the root is not a Relationships element.`);
      else {
        const ids = new Set<string>();
        list = parsed.root.children.flatMap((entry): Relationship[] => {
          if (entry.ns !== REL_NS || entry.local !== "Relationship") return [];
          const id = attr(entry, "Id");
          const type = attr(entry, "Type");
          const target = attr(entry, "Target");
          if (id === undefined || type === undefined || target === undefined) {
            this.problem(`${path}: a Relationship lacks Id, Type or Target.`);
            return [];
          }
          if (ids.has(id)) {
            this.problem(
              `${path}: relationship Id ${id} repeats; the first is used.`,
            );
            return [];
          }
          ids.add(id);
          const external =
            attr(entry, "TargetMode")?.toLowerCase() === "external";
          const resolved = external ? null : resolveTarget(source, target);
          return [
            {
              id,
              kind: kindOf(type),
              type,
              target,
              external,
              part: resolved === null ? null : (this.find(resolved) ?? null),
              source,
            },
          ];
        });
      }
    }
    this.#relationships.set(cacheKey, list);
    return list;
  }

  async close(): Promise<void> {
    await this.#zip.close();
  }
}

/** A relationship by kind from a part's list (the first). */
export const byKind = (
  list: readonly Relationship[],
  kind: string,
): Relationship | undefined => list.find((entry) => entry.kind === kind);

const INDEXES = new WeakMap<
  readonly Relationship[],
  Map<string, Relationship>
>();

export const byId = (
  list: readonly Relationship[],
  id: string | undefined,
): Relationship | undefined => {
  if (id === undefined) return undefined;
  let index = INDEXES.get(list);
  if (index === undefined) {
    index = new Map(list.map((entry) => [entry.id, entry]));
    INDEXES.set(list, index);
  }
  return index.get(id);
};
