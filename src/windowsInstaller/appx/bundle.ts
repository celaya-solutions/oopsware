import type { Element } from "@xmldom/xmldom";

import { ok, type Result } from "../../domain/result.js";
import {
  type AppxDeviceFamily,
  type AppxIdentity,
  type AppxResource,
  type AppxXmlProblem,
  attribute,
  element,
  elements,
  parseAppxXml,
  readDeviceFamilies,
  readIdentity,
  readResources,
  unsigned,
} from "./xml.js";

/** Every bundle schema version (2013 through b5) keeps this default namespace. */
export const APPX_BUNDLE_NAMESPACE =
  "http://schemas.microsoft.com/appx/2013/bundle";

/** A bundle lists one Package per architecture and resource split; this bounds the DOM. */
export const MAX_APPX_BUNDLE_MANIFEST_BYTES = 4 * 1024 ** 2;
const MAX_BUNDLE_MARKUP = 200_000;

export interface AppxBundlePackage {
  readonly type: string | null;
  readonly version: string | null;
  readonly architecture: string | null;
  readonly resource_id: string | null;
  readonly file_name: string | null;
  /** Offset of the package's bytes inside the bundle ZIP (the member's data, after its local header). */
  readonly offset: number | null;
  readonly size: number | null;
  readonly resources: readonly AppxResource[];
  readonly target_device_families: readonly AppxDeviceFamily[];
}

/** An OptionalBundle entry: another bundle the main one names, with the packages it lists. */
export interface AppxOptionalBundle {
  readonly name: string | null;
  readonly publisher: string | null;
  readonly version: string | null;
  readonly file_name: string | null;
  readonly packages: readonly AppxBundlePackage[];
}

export interface AppxBundleManifest {
  readonly schema_version: string | null;
  readonly identity: AppxIdentity | null;
  readonly packages: readonly AppxBundlePackage[];
  readonly optional_bundles: readonly AppxOptionalBundle[];
  readonly problems: readonly string[];
}

const readPackage = (node: Element, problems: string[]): AppxBundlePackage => {
  const name = attribute(node, "FileName");
  const what = `Package "${name ?? "?"}"`;
  const type = attribute(node, "Type");
  if (type !== null && type !== "application" && type !== "resource")
    problems.push(
      `${what} has Type "${type}"; application or resource is defined.`,
    );
  return {
    type,
    version: attribute(node, "Version"),
    architecture: attribute(node, "Architecture"),
    resource_id: attribute(node, "ResourceId"),
    file_name: name,
    offset: unsigned(attribute(node, "Offset"), `${what} Offset`, problems),
    size: unsigned(attribute(node, "Size"), `${what} Size`, problems),
    resources: readResources(node),
    target_device_families: readDeviceFamilies(element(node, "Dependencies")),
  };
};

/**
 * Read AppxMetadata/AppxBundleManifest.xml: the bundle identity, every
 * Package with its type, architecture or resource ID, file name, declared
 * offset and size, resources and target device families, and any
 * OptionalBundle entries.
 */
export const parseAppxBundleManifest = (
  bytes: Uint8Array,
): Result<AppxBundleManifest, AppxXmlProblem> => {
  const parsed = parseAppxXml(
    bytes,
    "AppxBundleManifest.xml",
    {
      max_bytes: MAX_APPX_BUNDLE_MANIFEST_BYTES,
      max_markup: MAX_BUNDLE_MARKUP,
    },
    [{ namespace: APPX_BUNDLE_NAMESPACE, name: "Bundle" }],
  );
  if (!parsed.ok) return parsed;
  const { root, warnings } = parsed.value;
  const problems = [...warnings];
  const list = element(root, "Packages");
  if (list === null) problems.push("There is no Packages element.");
  const packages =
    list === null
      ? []
      : elements(list, "Package").map((node) => readPackage(node, problems));
  const optional_bundles =
    list === null
      ? []
      : elements(list, "OptionalBundle").map((node) => ({
          name: attribute(node, "Name"),
          publisher: attribute(node, "Publisher"),
          version: attribute(node, "Version"),
          file_name: attribute(node, "FileName"),
          packages: elements(node, "Package").map((child) =>
            readPackage(child, problems),
          ),
        }));
  return ok({
    schema_version: attribute(root, "SchemaVersion"),
    identity: readIdentity(root, problems),
    packages,
    optional_bundles,
    problems,
  });
};

/** Where a bundle member's bytes actually are: its ZIP local data offset and stored size. */
export interface BundleMemberLocation {
  readonly data_offset: number;
  readonly stored_size: number;
}

export interface BundlePackageCheck {
  readonly file_name: string | null;
  readonly found: boolean;
  readonly offset: {
    readonly declared: number | null;
    readonly actual: number | null;
  };
  readonly size: {
    readonly declared: number | null;
    readonly actual: number | null;
  };
  readonly matches: boolean;
}

/**
 * Compare each Package's declared Offset and Size with the member the
 * caller located in the bundle ZIP (`locate` takes the FileName as
 * written). A package stored compressed has no contiguous offset to match.
 */
export const checkBundleLayout = (
  bundle: AppxBundleManifest,
  locate: (fileName: string) => BundleMemberLocation | null,
): BundlePackageCheck[] =>
  bundle.packages.map((entry) => {
    const found = entry.file_name === null ? null : locate(entry.file_name);
    return {
      file_name: entry.file_name,
      found: found !== null,
      offset: { declared: entry.offset, actual: found?.data_offset ?? null },
      size: { declared: entry.size, actual: found?.stored_size ?? null },
      matches:
        found !== null &&
        entry.offset === found.data_offset &&
        entry.size === found.stored_size,
    };
  });
