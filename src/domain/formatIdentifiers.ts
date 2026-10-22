import { z } from "zod";

/**
 * One typed registry of artifact formats shared by detection, capability
 * reporting, browsing filters, and documentation projections.
 *
 * A format belongs to exactly one dimension. One artifact may carry several
 * formats at once: a `.whl` is `zip` storage with the `wheel` package role,
 * and an AppImage is `elf` storage with the `appimage` role. Name hints are
 * kept beside byte observations so a contradiction stays visible.
 */

/** Storage encodings and containers established from bytes. */
export const STORAGE_FORMAT_IDS = [
  "zip",
  "xar",
  "udif",
  "asar",
  "godot-pck",
  "raw-binary",
  "mach-o",
  "mach-o-universal",
  "elf",
  "pe",
  "dos-mz",
  "dos-com",
  "binary-plist",
  "directory",
  "tar",
  "gzip",
  "bzip2",
  "xz",
  "zstd",
  "7z",
  "rar",
  "ar",
  "rpm",
  "squashfs",
  "ole-compound",
  "sqlite",
  "wasm-binary",
  "pdf",
] as const;

/** Logical package roles layered on a storage container. */
export const PACKAGE_ROLE_IDS = [
  "ipa",
  "apk",
  "msix",
  "appx",
  "hap",
  "hsp",
  "app-pack",
  "apple-installer-package",
  "jar",
  "aar",
  "wheel",
  "pyz",
  "android-app-bundle",
  "apks",
  "xapk",
  "msixbundle",
  "appxbundle",
  "msi",
  "deb",
  "appimage",
  "oci-image-layout",
  "oci-image-archive",
  "docker-save-archive",
  "ooxml-document",
  "ooxml-macro-document",
  "ole-office-document",
] as const;

/** Language and semantic profiles describing what the content means. */
export const SEMANTIC_PROFILE_IDS = [
  "javascript",
  "source-map",
  "property-list",
  "entitlements",
  "analysis-database",
  "hopper-database",
  "wasm-module",
  "wasm-component",
  "wasm-text",
  "jvm-classfile",
  "cpython-bytecode",
  "python-source",
  "dalvik-dex",
  "dwarf",
  "pdb-msf",
  "markdown",
  "json",
  "jsonl",
  "yaml",
  "toml",
  "xml",
  "csv",
  "tsv",
  "plain-text",
] as const;

export type StorageFormatId = (typeof STORAGE_FORMAT_IDS)[number];

/** Every stable format identifier, unique across dimensions. */
export const formatIdSchema = z.enum([
  ...STORAGE_FORMAT_IDS,
  ...PACKAGE_ROLE_IDS,
  ...SEMANTIC_PROFILE_IDS,
]);
export type FormatId = z.infer<typeof formatIdSchema>;

export const formatDimensionSchema = z.enum([
  "storage",
  "package-role",
  "semantic-profile",
]);
export type FormatDimension = z.infer<typeof formatDimensionSchema>;

/** Spec scope a format belongs to; `existing` predates the expansion. */
export const formatFamilySchema = z.enum([
  "existing",
  "F01",
  "F02",
  "F03",
  "F04",
  "F05",
  "F06",
  "F07",
  "F08",
  "F09",
  "F10",
  "F11",
  "F12",
]);
export type FormatFamily = z.infer<typeof formatFamilySchema>;

/** Facets are independent: no facet implies another one succeeded. */
export const formatFacetSchema = z.enum([
  "identify",
  "inventory",
  "extract",
  "inspect",
  "reconstruct",
]);
export type FormatFacet = z.infer<typeof formatFacetSchema>;

/**
 * - `complete`: the whole requested scope was examined.
 * - `partial`: some scope was examined; the omission is named.
 * - `unsupported`: REA has no implementation for this format or profile.
 * - `unavailable`: implemented, but its provider or host is absent here.
 * - `not_requested`: the caller did not ask for this facet.
 */
export const capabilityStateSchema = z.enum([
  "complete",
  "partial",
  "unsupported",
  "unavailable",
  "not_requested",
]);
export type CapabilityState = z.infer<typeof capabilityStateSchema>;

/** Surfaces report their own verified facets. */
export const formatSurfaceSchema = z.enum(["local", "hosted"]);
export type FormatSurface = z.infer<typeof formatSurfaceSchema>;

/** A static capability claim for one facet on one surface. */
export interface CapabilityDeclaration {
  readonly state: Exclude<CapabilityState, "not_requested">;
  readonly reason: string | null;
  /** The facet works only on this host platform; elsewhere it is unavailable. */
  readonly hostPlatform: NodeJS.Platform | null;
}

export type SurfaceCapabilities = Readonly<
  Partial<Record<FormatFacet, CapabilityDeclaration>>
>;

/** One registry record. Absent facets make no claim for this format. */
export interface FormatEntry {
  readonly id: FormatId;
  readonly dimension: FormatDimension;
  readonly family: FormatFamily;
  readonly label: string;
  /** Lower-case name suffixes, including the dot, used only as hints. */
  readonly extensions: readonly string[];
  /** Storage formats this role or profile is carried in. */
  readonly storage: readonly StorageFormatId[];
  /** Whether bytes can establish or refute this format during detection. */
  readonly byteSignature: boolean;
  readonly capabilities: Readonly<Record<FormatSurface, SurfaceCapabilities>>;
}

/** The dimension an identifier belongs to, from its identifier list. */
export const dimensionOf = (id: FormatId): FormatDimension =>
  (STORAGE_FORMAT_IDS as readonly string[]).includes(id)
    ? "storage"
    : (PACKAGE_ROLE_IDS as readonly string[]).includes(id)
      ? "package-role"
      : "semantic-profile";
