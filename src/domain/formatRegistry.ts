import { z } from "zod";

import type { ArtifactOccurrence } from "./artifactGraph.js";
import {
  capabilityStateSchema,
  formatFacetSchema,
  formatIdSchema,
  type CapabilityState,
  type FormatEntry,
  type FormatFacet,
  type FormatId,
  type FormatSurface,
} from "./formatIdentifiers.js";
import { FORMAT_REGISTRY } from "./formatRegistryEntries.js";
import { err, ok, type Result } from "./result.js";

/**
 * Coverage of one facet in one result. Anything short of complete names why,
 * so an omission is never mistaken for an empty observation.
 */
export const facetCoverageSchema = z
  .object({
    facet: formatFacetSchema,
    state: capabilityStateSchema,
    examined: z.string().min(1).nullable(),
    omitted: z.string().min(1).nullable(),
    reason: z.string().min(1).nullable(),
    continuation: z.string().min(1).nullable(),
  })
  .strict()
  .superRefine((coverage, context) => {
    const issue = (message: string) =>
      context.addIssue({ code: "custom", message });
    switch (coverage.state) {
      case "complete":
        if (coverage.examined === null)
          issue("Complete coverage must state what was examined");
        if (coverage.omitted !== null || coverage.reason !== null)
          issue("Complete coverage cannot omit scope");
        break;
      case "partial":
        if (
          coverage.examined === null ||
          coverage.omitted === null ||
          coverage.reason === null
        )
          issue("Partial coverage must state examined scope, omission, reason");
        break;
      case "unsupported":
      case "unavailable":
        if (coverage.reason === null)
          issue(`${coverage.state} coverage must state its reason`);
        if (coverage.examined !== null)
          issue(`${coverage.state} coverage cannot claim examined scope`);
        break;
      case "not_requested":
        if (coverage.examined !== null || coverage.continuation !== null)
          issue("An unrequested facet cannot examine or continue scope");
        break;
    }
  });
export type FacetCoverage = z.infer<typeof facetCoverageSchema>;

const ENTRIES_BY_ID: ReadonlyMap<FormatId, FormatEntry> = new Map(
  FORMAT_REGISTRY.map((format) => [format.id, format]),
);

/** Registry entry for a known identifier. */
export const formatEntry = (id: FormatId): FormatEntry => {
  const found = ENTRIES_BY_ID.get(id);
  if (found === undefined)
    throw new TypeError(`Format registry has no entry for ${id}`);
  return found;
};

/** A boundary value that does not name a registered format. */
export class UnknownFormatIdError extends Error {
  readonly _tag = "UnknownFormatIdError";

  constructor(readonly value: unknown) {
    super("Value is not a registered format identifier");
  }
}

/** Parse an untrusted format identifier, such as a filter or a stored report. */
export const parseFormatId = (
  value: unknown,
): Result<FormatId, UnknownFormatIdError> => {
  const parsed = formatIdSchema.safeParse(value);
  return parsed.success
    ? ok(parsed.data)
    : err(new UnknownFormatIdError(value));
};

/** Host context a capability is resolved for. */
export interface CapabilityContext {
  readonly surface: FormatSurface;
  readonly platform: NodeJS.Platform;
}

/** The hosted service runs on the Linux worker image. */
export const HOSTED_CAPABILITY_CONTEXT: CapabilityContext = {
  surface: "hosted",
  platform: "linux",
};

/**
 * Resolve one declared facet for a surface and host. An absent declaration
 * is `unsupported`: the registry claims nothing it has not declared.
 */
export const formatCapability = (
  id: FormatId,
  facet: FormatFacet,
  context: CapabilityContext,
): { readonly state: CapabilityState; readonly reason: string | null } => {
  const declared = formatEntry(id).capabilities[context.surface][facet];
  if (declared === undefined)
    return {
      state: "unsupported",
      reason: `No ${facet} capability is declared for ${id}.`,
    };
  if (
    declared.hostPlatform !== null &&
    declared.hostPlatform !== context.platform &&
    (declared.state === "complete" || declared.state === "partial")
  )
    return {
      state: "unavailable",
      reason:
        declared.reason ??
        `${facet} for ${id} requires a ${declared.hostPlatform} host.`,
    };
  return { state: declared.state, reason: declared.reason };
};

/** Every facet of one format resolved for a surface, for reports and filters. */
export const formatCapabilities = (
  id: FormatId,
  context: CapabilityContext,
): {
  readonly format: FormatId;
  readonly facets: Readonly<
    Record<FormatFacet, ReturnType<typeof formatCapability>>
  >;
} => ({
  format: id,
  facets: {
    identify: formatCapability(id, "identify", context),
    inventory: formatCapability(id, "inventory", context),
    extract: formatCapability(id, "extract", context),
    inspect: formatCapability(id, "inspect", context),
    reconstruct: formatCapability(id, "reconstruct", context),
  },
});

/**
 * Formats with at least one working facet on a surface. Documentation and
 * browsing filters project from this, so planned formats stay unadvertised.
 */
export const advertisedFormats = (
  context: CapabilityContext,
): readonly FormatEntry[] =>
  FORMAT_REGISTRY.filter((format) =>
    formatFacetSchema.options.some((facet) => {
      const { state } = formatCapability(format.id, facet, context);
      return state === "complete" || state === "partial";
    }),
  );

/**
 * Registry formats whose name suffix matches. The longest matching suffix
 * wins, so `x.tar.gz` hints gzip-wrapped tar rather than any `.gz`.
 */
export const formatsHintedByName = (
  name: string,
): { readonly extension: string | null; readonly formats: FormatId[] } => {
  const lower = name.toLowerCase();
  let extension: string | null = null;
  for (const format of FORMAT_REGISTRY)
    for (const suffix of format.extensions)
      if (
        lower.endsWith(suffix) &&
        lower.length > suffix.length &&
        (extension === null || suffix.length > extension.length)
      )
        extension = suffix;
  if (extension === null) return { extension, formats: [] };
  const matched = extension;
  return {
    extension,
    formats: FORMAT_REGISTRY.filter((format) =>
      format.extensions.includes(matched),
    ).map((format) => format.id),
  };
};

/**
 * Registry identity of each format the artifact graph already records.
 * `file` and `unknown` are the explicit unrecognized states, not formats.
 */
export const ARTIFACT_GRAPH_FORMAT_IDS: Readonly<
  Record<ArtifactOccurrence["artifact_format"], FormatId | null>
> = {
  dmg: "udif",
  zip: "zip",
  pkg: "apple-installer-package",
  asar: "asar",
  "javascript-bundle": "javascript",
  "source-map": "source-map",
  "mach-o-universal": "mach-o-universal",
  "mach-o": "mach-o",
  elf: "elf",
  pe: "pe",
  "dos-mz": "dos-mz",
  "dos-com": "dos-com",
  hopper: "hopper-database",
  "analysis-database": "analysis-database",
  ipa: "ipa",
  hap: "hap",
  hsp: "hsp",
  "app-pack": "app-pack",
  "godot-pck": "godot-pck",
  "raw-binary": "raw-binary",
  apk: "apk",
  msix: "msix",
  appx: "appx",
  msixbundle: "msixbundle",
  appxbundle: "appxbundle",
  plist: "property-list",
  entitlements: "entitlements",
  directory: "directory",
  tar: "tar",
  gzip: "gzip",
  xz: "xz",
  "7z": "7z",
  rar: "rar",
  deb: "deb",
  rpm: "rpm",
  squashfs: "squashfs",
  appimage: "appimage",
  msi: "msi",
  "oci-image-layout": "oci-image-layout",
  "oci-image-archive": "oci-image-archive",
  "docker-save-archive": "docker-save-archive",
  file: null,
  unknown: null,
};
