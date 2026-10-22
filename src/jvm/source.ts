import type { JvmContainerKind } from "../domain/jvm/jvm.js";
import { classLocation } from "./archive.js";
import {
  DecodeBudget,
  MemberReadFailure,
  ZipView,
  type ZipMember,
} from "../artifacts/zipMemberView.js";
import { looksLikeClassFile } from "./classfile/parseClass.js";
import { attribute, parseManifest, type Manifest } from "./jarMetadata.js";

export const MANIFEST_ENTRY = "META-INF/MANIFEST.MF";

/** One ZIP whose classes are reported: the file itself (container null) or an embedded JAR. */
export interface ArchiveView {
  readonly container: string | null;
  readonly zip: ZipView;
  readonly manifest: Manifest | null;
  readonly manifestError: string | null;
  readonly multiRelease: boolean;
}

export interface EmbeddedJar {
  readonly entry: string;
  readonly bytes: number;
  readonly sha256: string | null;
  readonly view: ArchiveView | null;
  readonly failure: MemberReadFailure | null;
}

export type JvmSource =
  | {
      readonly kind: "class";
      readonly basis: "magic";
      readonly nameConflict: string | null;
      readonly bytes: Uint8Array;
    }
  | {
      readonly kind: Exclude<JvmContainerKind, "class">;
      readonly basis: "layout" | "name-hint";
      readonly nameConflict: string | null;
      readonly outer: ArchiveView;
      readonly embedded: readonly EmbeddedJar[];
    };

export interface ClassMember {
  readonly view: ArchiveView;
  readonly member: ZipMember;
  readonly release: number | null;
  /** The path a JVM resolves the class under, with any META-INF/versions/N prefix removed. */
  readonly logical: string;
}

const ZIP_MAGIC = [0x50, 0x4b];
const EMPTY_ZIP = [0x50, 0x4b, 0x05, 0x06];

const suffixKind = (path: string): JvmContainerKind | null => {
  const lower = path.toLowerCase();
  if (lower.endsWith(".class")) return "class";
  if (lower.endsWith(".jar")) return "jar";
  if (lower.endsWith(".aar")) return "aar";
  return null;
};

const conflict = (path: string, kind: JvmContainerKind): string | null => {
  const hinted = suffixKind(path);
  return hinted === null || hinted === kind
    ? null
    : `The name suggests ${hinted}, but the bytes are ${kind === "zip" ? "a plain ZIP" : kind}.`;
};

export const isZip = (bytes: Uint8Array): boolean =>
  bytes.length >= 4 &&
  (ZIP_MAGIC.every((value, index) => bytes[index] === value) ||
    EMPTY_ZIP.every((value, index) => bytes[index] === value));

export const hasClassMagic = looksLikeClassFile;

const readView = async (
  container: string | null,
  zip: ZipView,
  budget: DecodeBudget,
  signal?: AbortSignal,
): Promise<ArchiveView> => {
  if (!zip.has(MANIFEST_ENTRY))
    return {
      container,
      zip,
      manifest: null,
      manifestError: null,
      multiRelease: false,
    };
  try {
    const manifest = parseManifest(
      await zip.read(MANIFEST_ENTRY, budget, signal),
    );
    return {
      container,
      zip,
      manifest,
      manifestError: null,
      multiRelease:
        attribute(manifest.main, "Multi-Release")?.toLowerCase() === "true",
    };
  } catch (cause) {
    if (!(cause instanceof MemberReadFailure)) throw cause;
    if (cause.reason === "cancelled") throw cause;
    return {
      container,
      zip,
      manifest: null,
      manifestError: cause.message,
      multiRelease: false,
    };
  }
};

const isEmbeddedJar = (member: ZipMember): boolean =>
  !member.directory && member.path.toLowerCase().endsWith(".jar");

/**
 * Open a file's bytes as a class file or a JAR/AAR/ZIP. Embedded JARs (an
 * AAR's classes.jar and libs/, or libraries packed in a JAR) are opened one
 * level deep inside the same decompression budget; deeper nesting is listed
 * but not opened. Returns null when the bytes are neither.
 */
export const openJvmSource = async (
  bytes: Uint8Array,
  path: string,
  budget: DecodeBudget,
  sha256: (bytes: Uint8Array) => string,
  signal?: AbortSignal,
): Promise<JvmSource | null> => {
  if (looksLikeClassFile(bytes))
    return {
      kind: "class",
      basis: "magic",
      nameConflict: conflict(path, "class"),
      bytes,
    };
  if (!isZip(bytes)) return null;
  const outerZip = await ZipView.open(bytes);
  const outer = await readView(null, outerZip, budget, signal);
  const members = outerZip.members;
  const hasClasses = members.some(
    (member) => classLocation(member.path) !== null,
  );
  let kind: Exclude<JvmContainerKind, "class">;
  let basis: "layout" | "name-hint" = "layout";
  if (
    outerZip.has("AndroidManifest.xml") &&
    (outerZip.has("classes.jar") || suffixKind(path) === "aar")
  )
    kind = "aar";
  else if (
    outer.manifest !== null ||
    outerZip.has(MANIFEST_ENTRY) ||
    hasClasses
  )
    kind = "jar";
  else if (suffixKind(path) === "jar" || suffixKind(path) === "aar") {
    kind = suffixKind(path) as "jar" | "aar";
    basis = "name-hint";
  } else kind = "zip";
  const embedded: EmbeddedJar[] = [];
  for (const member of members.filter(isEmbeddedJar)) {
    try {
      const inner = await outerZip.read(member.path, budget, signal);
      const digest = sha256(inner);
      if (!isZip(inner)) {
        embedded.push({
          entry: member.path,
          bytes: member.bytes,
          sha256: digest,
          view: null,
          failure: new MemberReadFailure(
            "format",
            `${member.path} is not a ZIP archive.`,
          ),
        });
        continue;
      }
      const zip = await ZipView.open(inner);
      embedded.push({
        entry: member.path,
        bytes: member.bytes,
        sha256: digest,
        view: await readView(member.path, zip, budget, signal),
        failure: null,
      });
    } catch (cause) {
      if (cause instanceof MemberReadFailure && cause.reason === "cancelled")
        throw cause;
      embedded.push({
        entry: member.path,
        bytes: member.bytes,
        sha256: null,
        view: null,
        failure:
          cause instanceof MemberReadFailure
            ? cause
            : new MemberReadFailure(
                "format",
                `${member.path} is not a readable ZIP archive: ${cause instanceof Error ? cause.message : String(cause)}`,
              ),
      });
    }
  }
  return { kind, basis, nameConflict: conflict(path, kind), outer, embedded };
};

/** Every ArchiveView of a source, outer first. */
export const viewsOf = (
  source: Extract<JvmSource, { outer: ArchiveView }>,
): ArchiveView[] => [
  source.outer,
  ...source.embedded.flatMap((jar) => (jar.view === null ? [] : [jar.view])),
];

export const classMembers = (view: ArchiveView): ClassMember[] =>
  view.zip.members.flatMap((member) => {
    if (member.directory) return [];
    const location = classLocation(member.path);
    return location === null ? [] : [{ view, member, ...location }];
  });

export const closeSource = async (source: JvmSource | null): Promise<void> => {
  if (source === null || source.kind === "class") return;
  await Promise.all(
    viewsOf(source).map((view) => view.zip.close().catch(() => undefined)),
  );
};
