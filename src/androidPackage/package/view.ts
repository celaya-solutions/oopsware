import type { AndroidPackageKind } from "../../domain/android/androidArtifact.js";
import { hasZipSignature } from "../../domain/zipPackageFormat.js";
import {
  type DecodeBudget,
  MemberReadFailure,
  sha256Hex,
  type ZipMember,
  ZipView,
} from "../../artifacts/zipMemberView.js";
import { hasDexMagic } from "../dex/dexFile.js";

/** Kinds a file name suffix proposes; the bytes decide. */
const SUFFIX_KINDS: readonly (readonly [string, AndroidPackageKind])[] = [
  [".dex", "dex"],
  [".apk", "apk"],
  [".aab", "aab"],
  [".apks", "apks"],
  [".xapk", "xapk"],
];

const suffixKind = (path: string): AndroidPackageKind | null => {
  const lower = path.toLowerCase();
  return SUFFIX_KINDS.find(([suffix]) => lower.endsWith(suffix))?.[1] ?? null;
};

const ROOT_DEX = /^classes\d*\.dex$/u;
const MODULE_MANIFEST = /^[^/]+\/manifest\/AndroidManifest\.xml$/u;

/** The package kind a ZIP's member layout establishes, or null when no Android layout matches. */
export const layoutKind = (
  members: readonly ZipMember[],
): AndroidPackageKind | null => {
  const names = new Set(members.map((member) => member.path));
  if (names.has("toc.pb")) return "apks";
  if (
    names.has("BundleConfig.pb") ||
    members.some((member) => MODULE_MANIFEST.test(member.path))
  )
    return "aab";
  if (
    names.has("manifest.json") &&
    members.some(
      (member) => !member.path.includes("/") && member.path.endsWith(".apk"),
    )
  )
    return "xapk";
  if (names.has("AndroidManifest.xml")) return "apk";
  return null;
};

/** Directory first; within one, classes.dex, classes2.dex, ... in numeric order, other names after. */
export const dexOrder = (left: string, right: string): number => {
  const directory = (path: string) => path.slice(0, path.lastIndexOf("/") + 1);
  const rank = (path: string) => {
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (!ROOT_DEX.test(name)) return Number.MAX_SAFE_INTEGER;
    const digits = name.slice(7, -4);
    return digits === "" ? 1 : Number(digits);
  };
  const [leftDirectory, rightDirectory] = [directory(left), directory(right)];
  if (leftDirectory !== rightDirectory)
    return leftDirectory < rightDirectory ? -1 : 1;
  const byRank = rank(left) - rank(right);
  if (byRank !== 0) return byRank;
  return left < right ? -1 : left > right ? 1 : 0;
};

/** True for a DEX member the platform loads as app code: classesN.dex at an APK's root or in a module's dex/ directory. */
export const isCodeDex = (path: string, module: string | null): boolean =>
  module === null
    ? ROOT_DEX.test(path)
    : path.startsWith(`${module}/dex/`) &&
      ROOT_DEX.test(path.slice(module.length + 5));

export interface NestedApk {
  readonly entry: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly zip: ZipView;
}

/**
 * One opened Android artifact: a bare DEX, or an outer ZIP plus nested APKs
 * opened on demand. Every member read shares one decode budget; `close`
 * releases every ZIP reader.
 */
export class AndroidPackageView {
  readonly #nested = new Map<string, NestedApk | MemberReadFailure>();
  /** Set once any member read was refused by the decode budget. */
  budgetExceeded = false;

  private constructor(
    readonly kind: AndroidPackageKind,
    readonly basis: "magic" | "layout" | "name-hint",
    readonly nameConflict: string | null,
    readonly zip: ZipView | null,
    readonly dex: Uint8Array | null,
    readonly budget: DecodeBudget,
    readonly signal: AbortSignal | undefined,
  ) {}

  /** Open `bytes` as DEX or as a ZIP-based package; null when it is neither. */
  static async open(
    bytes: Uint8Array,
    path: string,
    budget: DecodeBudget,
    signal?: AbortSignal,
  ): Promise<AndroidPackageView | null> {
    const hinted = suffixKind(path);
    const conflict = (kind: AndroidPackageKind): string | null =>
      hinted !== null && hinted !== kind
        ? `The name suggests ${hinted}; the bytes are ${kind === "zip" ? "a ZIP without an Android package layout" : kind}.`
        : null;
    if (hasDexMagic(bytes))
      return new AndroidPackageView(
        "dex",
        "magic",
        conflict("dex"),
        null,
        bytes,
        budget,
        signal,
      );
    if (!hasZipSignature(bytes)) return null;
    const zip = await ZipView.open(bytes);
    const layout = layoutKind(zip.members);
    if (layout !== null)
      return new AndroidPackageView(
        layout,
        "layout",
        conflict(layout),
        zip,
        null,
        budget,
        signal,
      );
    // An APK set without its table of contents still holds APKs; keep the suffix's claim visible as a hint.
    const holdsApks = zip.members.some((member) =>
      member.path.endsWith(".apk"),
    );
    if ((hinted === "apks" || hinted === "xapk") && holdsApks)
      return new AndroidPackageView(
        hinted,
        "name-hint",
        null,
        zip,
        null,
        budget,
        signal,
      );
    return new AndroidPackageView(
      "zip",
      "layout",
      conflict("zip"),
      zip,
      null,
      budget,
      signal,
    );
  }

  /** Members of the outer ZIP or of one nested APK. */
  members(container: string | null): readonly ZipMember[] {
    if (container === null) return this.zip?.members ?? [];
    const nested = this.#nested.get(container);
    return nested instanceof MemberReadFailure || nested === undefined
      ? []
      : nested.zip.members;
  }

  /** Open a nested APK once; a failure is remembered and rethrown. */
  async nested(entry: string): Promise<NestedApk> {
    const known = this.#nested.get(entry);
    if (known instanceof MemberReadFailure) throw known;
    if (known !== undefined) return known;
    if (this.zip === null)
      throw new MemberReadFailure(
        "format",
        `${entry} is not a member of a ZIP.`,
      );
    try {
      const bytes = await this.zip.read(entry, this.budget, this.signal);
      if (!hasZipSignature(bytes))
        throw new MemberReadFailure(
          "format",
          `${entry} is not a ZIP-based APK.`,
        );
      let zip: ZipView;
      try {
        zip = await ZipView.open(bytes);
      } catch (cause) {
        throw new MemberReadFailure(
          "format",
          `${entry} could not be opened as an APK: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
      const opened = { entry, bytes, sha256: sha256Hex(bytes), zip };
      this.#nested.set(entry, opened);
      return opened;
    } catch (cause) {
      if (cause instanceof MemberReadFailure && cause.reason === "budget")
        this.budgetExceeded = true;
      if (cause instanceof MemberReadFailure && cause.reason !== "cancelled")
        this.#nested.set(entry, cause);
      throw cause;
    }
  }

  /** Read one member of the outer ZIP or of a nested APK. */
  async read(container: string | null, entry: string): Promise<Uint8Array> {
    try {
      if (container === null) {
        if (this.zip === null)
          throw new MemberReadFailure(
            "format",
            `${entry} is not a member of a ZIP.`,
          );
        return await this.zip.read(entry, this.budget, this.signal);
      }
      const nested = await this.nested(container);
      return await nested.zip.read(entry, this.budget, this.signal);
    } catch (cause) {
      if (cause instanceof MemberReadFailure && cause.reason === "budget")
        this.budgetExceeded = true;
      throw cause;
    }
  }

  has(container: string | null, entry: string): boolean {
    return this.members(container).some(
      (member) => member.path === entry && !member.directory,
    );
  }

  /** Nested APK members (.apks and .xapk sets). */
  apkMembers(): string[] {
    return (this.zip?.members ?? [])
      .filter((member) => !member.directory && member.path.endsWith(".apk"))
      .map((member) => member.path);
  }

  async close(): Promise<void> {
    const readers = [
      ...[...this.#nested.values()].flatMap((entry) =>
        entry instanceof MemberReadFailure ? [] : [entry.zip],
      ),
      ...(this.zip === null ? [] : [this.zip]),
    ];
    this.#nested.clear();
    await Promise.allSettled(readers.map((reader) => reader.close()));
  }
}
