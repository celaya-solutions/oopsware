import type { Element } from "@xmldom/xmldom";

import { ok, type Result } from "../../domain/result.js";
import {
  type AppxDeviceFamily,
  type AppxIdentity,
  type AppxResource,
  type AppxXmlProblem,
  attribute,
  childText,
  element,
  elements,
  parseAppxXml,
  readDeviceFamilies,
  readIdentity,
  readResources,
  xsBoolean,
} from "./xml.js";

export type {
  AppxDeviceFamily,
  AppxIdentity,
  AppxResource,
  AppxXmlProblem,
} from "./xml.js";

/** Windows 10+ foundation namespace and the Windows 8 one it replaced. */
export const APPX_FOUNDATION_NAMESPACE =
  "http://schemas.microsoft.com/appx/manifest/foundation/windows10";
export const APPX_WINDOWS8_NAMESPACE =
  "http://schemas.microsoft.com/appx/2010/manifest";
const RESCAP_NAMESPACE =
  "http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities";
const UAP_NAMESPACE =
  /^http:\/\/schemas\.microsoft\.com\/appx\/manifest\/uap\/windows10(?:\/\d+)?$/u;

/** AppxManifest.xml has no documented size cap; this bounds the DOM built for it. */
export const MAX_APPX_MANIFEST_BYTES = 4 * 1024 ** 2;
const MAX_MANIFEST_MARKUP = 200_000;

export interface AppxProperties {
  readonly display_name: string | null;
  readonly publisher_display_name: string | null;
  readonly logo: string | null;
  readonly description: string | null;
  readonly resource_package: boolean | null;
  readonly framework: boolean | null;
}

export interface AppxPackageDependency {
  /** "package" for PackageDependency, "main" for an optional package's MainPackageDependency. */
  readonly kind: "package" | "main";
  readonly name: string | null;
  readonly publisher: string | null;
  readonly min_version: string | null;
  readonly max_major_version_tested: string | null;
}

/** One declared Extension; `names` are the protocol, alias, task, class or service names it declares. */
export interface AppxExtension {
  readonly category: string | null;
  readonly namespace: string | null;
  readonly executable: string | null;
  readonly entry_point: string | null;
  readonly names: readonly string[];
}

export interface AppxApplication {
  readonly id: string | null;
  readonly executable: string | null;
  readonly entry_point: string | null;
  /** uap10:TrustLevel and uap10:RuntimeBehavior, as declared. */
  readonly trust_level: string | null;
  readonly runtime_behavior: string | null;
  readonly extensions: readonly AppxExtension[];
}

export type AppxCapabilityKind =
  | "general"
  | "uap"
  | "restricted"
  | "device"
  | "custom"
  | "other";

export interface AppxCapability {
  readonly name: string | null;
  readonly kind: AppxCapabilityKind;
  readonly namespace: string | null;
}

/** Declarations from AppxManifest.xml; a declared capability or extension is never a grant. */
export interface AppxManifest {
  readonly namespace: string;
  readonly schema: "windows10" | "windows8";
  readonly identity: AppxIdentity | null;
  readonly properties: AppxProperties;
  readonly target_device_families: readonly AppxDeviceFamily[];
  /** Windows 8 Prerequisites: OSMinVersion and OSMaxVersionTested. */
  readonly os_min_version: string | null;
  readonly os_max_version_tested: string | null;
  readonly package_dependencies: readonly AppxPackageDependency[];
  readonly resources: readonly AppxResource[];
  readonly applications: readonly AppxApplication[];
  /** Package-level Extensions (activatable classes, proxy stubs). */
  readonly package_extensions: readonly AppxExtension[];
  readonly capabilities: readonly AppxCapability[];
  readonly problems: readonly string[];
}

/** Elements inside an Extension whose attribute names what the extension declares. */
const NAMED: Readonly<Record<string, string>> = {
  Protocol: "Name",
  FileTypeAssociation: "Name",
  StartupTask: "TaskId",
  ExecutionAlias: "Alias",
  Class: "Id",
  AppService: "Name",
  Service: "Name",
  AppExtension: "Name",
};

const declaredNames = (extension: Element): string[] => {
  const names: string[] = [];
  const pending = elements(extension);
  for (let node = pending.shift(); node !== undefined; node = pending.shift()) {
    const key = NAMED[node.localName ?? ""];
    const value = key === undefined ? null : attribute(node, key);
    if (value !== null && !names.includes(value)) names.push(value);
    pending.push(...elements(node));
  }
  return names;
};

const readExtensions = (parent: Element): AppxExtension[] => {
  const container = element(parent, "Extensions");
  return container === null
    ? []
    : elements(container, "Extension").map((extension) => ({
        category: attribute(extension, "Category"),
        namespace: extension.namespaceURI,
        executable: attribute(extension, "Executable"),
        entry_point: attribute(extension, "EntryPoint"),
        names: declaredNames(extension),
      }));
};

const readApplications = (root: Element): AppxApplication[] => {
  const applications = element(root, "Applications");
  return applications === null
    ? []
    : elements(applications, "Application").map((application) => ({
        id: attribute(application, "Id"),
        executable: attribute(application, "Executable"),
        entry_point: attribute(application, "EntryPoint"),
        trust_level: attribute(application, "TrustLevel"),
        runtime_behavior: attribute(application, "RuntimeBehavior"),
        extensions: readExtensions(application),
      }));
};

const capabilityKind = (node: Element, root: string): AppxCapabilityKind => {
  const namespace = node.namespaceURI ?? "";
  if (node.localName === "DeviceCapability") return "device";
  if (node.localName === "CustomCapability") return "custom";
  if (node.localName !== "Capability") return "other";
  if (namespace === root) return "general";
  if (namespace === RESCAP_NAMESPACE) return "restricted";
  return UAP_NAMESPACE.test(namespace) ? "uap" : "other";
};

const readCapabilities = (
  root: Element,
  namespace: string,
): AppxCapability[] => {
  const capabilities = element(root, "Capabilities");
  return capabilities === null
    ? []
    : elements(capabilities).map((capability) => ({
        name: attribute(capability, "Name"),
        kind: capabilityKind(capability, namespace),
        namespace: capability.namespaceURI,
      }));
};

const readDependencies = (dependencies: Element | null) =>
  dependencies === null
    ? []
    : elements(dependencies)
        .filter(
          (node) =>
            node.localName === "PackageDependency" ||
            node.localName === "MainPackageDependency",
        )
        .map((node): AppxPackageDependency => ({
          kind: node.localName === "MainPackageDependency" ? "main" : "package",
          name: attribute(node, "Name"),
          publisher: attribute(node, "Publisher"),
          min_version: attribute(node, "MinVersion"),
          max_major_version_tested: attribute(node, "MaxMajorVersionTested"),
        }));

const readProperties = (root: Element, problems: string[]): AppxProperties => {
  const properties = element(root, "Properties");
  if (properties === null) problems.push("There is no Properties element.");
  const text = (name: string) =>
    properties === null ? null : childText(properties, name);
  return {
    display_name: text("DisplayName"),
    publisher_display_name: text("PublisherDisplayName"),
    logo: text("Logo"),
    description: text("Description"),
    resource_package: xsBoolean(
      text("ResourcePackage"),
      "ResourcePackage",
      problems,
    ),
    framework: xsBoolean(text("Framework"), "Framework", problems),
  };
};

/**
 * Read AppxManifest.xml (Windows 10+ foundation schema, or the Windows 8
 * 2010 schema): identity, properties, dependencies, resources,
 * applications with every Extension's category, and capabilities by
 * namespace kind. Unknown elements are ignored, as the schemas' Ignorable
 * namespaces allow.
 */
export const parseAppxManifest = (
  bytes: Uint8Array,
): Result<AppxManifest, AppxXmlProblem> => {
  const parsed = parseAppxXml(
    bytes,
    "AppxManifest.xml",
    { max_bytes: MAX_APPX_MANIFEST_BYTES, max_markup: MAX_MANIFEST_MARKUP },
    [
      { namespace: APPX_FOUNDATION_NAMESPACE, name: "Package" },
      { namespace: APPX_WINDOWS8_NAMESPACE, name: "Package" },
    ],
  );
  if (!parsed.ok) return parsed;
  const { root, warnings } = parsed.value;
  const problems = [...warnings];
  const namespace = root.namespaceURI ?? "";
  const dependencies = element(root, "Dependencies");
  const prerequisites = element(root, "Prerequisites");
  return ok({
    namespace,
    schema: namespace === APPX_FOUNDATION_NAMESPACE ? "windows10" : "windows8",
    identity: readIdentity(root, problems),
    properties: readProperties(root, problems),
    target_device_families: readDeviceFamilies(dependencies),
    os_min_version:
      prerequisites === null ? null : childText(prerequisites, "OSMinVersion"),
    os_max_version_tested:
      prerequisites === null
        ? null
        : childText(prerequisites, "OSMaxVersionTested"),
    package_dependencies: readDependencies(dependencies),
    resources: readResources(root),
    applications: readApplications(root),
    package_extensions: readExtensions(root),
    capabilities: readCapabilities(root, namespace),
    problems,
  });
};
