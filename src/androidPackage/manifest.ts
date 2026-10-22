import {
  ANDROID_NAMESPACE,
  DISTRIBUTION_NAMESPACE,
  attributeText,
  isReference,
  type AndroidXmlAttribute,
  type AndroidXmlElement,
} from "./xml/androidXml.js";

/**
 * Declared facts of a decoded AndroidManifest.xml. Values are what the
 * manifest states: undeclared attributes stay null (no platform defaults,
 * no runtime grants), and references stay references unless the caller's
 * resolver knows their text.
 */

export interface AndroidIntentFilter {
  readonly actions: readonly string[];
  readonly categories: readonly string[];
  readonly data: readonly {
    readonly scheme: string | null;
    readonly host: string | null;
    readonly port: string | null;
    readonly path: string | null;
    readonly path_prefix: string | null;
    readonly path_pattern: string | null;
    readonly mime_type: string | null;
  }[];
  readonly priority: number | null;
  readonly auto_verify: boolean | null;
}

export interface AndroidComponent {
  readonly kind:
    | "activity"
    | "activity-alias"
    | "service"
    | "receiver"
    | "provider";
  /** As declared, e.g. ".MainActivity". */
  readonly name: string | null;
  /** Resolved against the package. */
  readonly class_name: string | null;
  /** null = not declared. */
  readonly exported: boolean | null;
  readonly enabled: boolean | null;
  readonly permission: string | null;
  readonly process: string | null;
  /** activity-alias only. */
  readonly target_activity: string | null;
  /** provider, split on ';'. */
  readonly authorities: readonly string[];
  readonly intent_filters: readonly AndroidIntentFilter[];
}

export interface AndroidManifestFacts {
  readonly package_name: string | null;
  /** versionCode only (low 32 bits). */
  readonly version_code: number | null;
  readonly version_code_major: number | null;
  readonly version_name: string | null;
  readonly split: string | null;
  readonly config_for_split: string | null;
  readonly is_feature_split: boolean | null;
  readonly is_split_required: boolean | null;
  /** SDK levels are strings: a level may be a codename. */
  readonly min_sdk: string | null;
  readonly target_sdk: string | null;
  readonly max_sdk: string | null;
  readonly compile_sdk: string | null;
  readonly compile_sdk_codename: string | null;
  readonly platform_build_version: string | null;
  readonly uses_permissions: readonly {
    readonly name: string;
    readonly max_sdk: number | null;
    readonly kind: "uses-permission" | "uses-permission-sdk-23";
  }[];
  readonly declared_permissions: readonly {
    readonly name: string;
    readonly protection_level: string | null;
  }[];
  readonly uses_features: readonly {
    readonly name: string | null;
    readonly required: boolean | null;
    readonly gl_es_version: string | null;
  }[];
  readonly uses_libraries: readonly {
    readonly name: string;
    readonly required: boolean | null;
    readonly native: boolean;
  }[];
  readonly uses_splits: readonly string[];
  readonly application: {
    readonly name: string | null;
    readonly label: string | null;
    readonly debuggable: boolean | null;
    readonly allow_backup: boolean | null;
    readonly uses_cleartext_traffic: boolean | null;
    readonly extract_native_libs: boolean | null;
    readonly has_code: boolean | null;
    readonly test_only: boolean | null;
    readonly network_security_config: string | null;
    readonly app_component_factory: string | null;
  } | null;
  readonly components: readonly AndroidComponent[];
  readonly meta_data: readonly {
    readonly name: string;
    readonly value: string | null;
    readonly resource: string | null;
  }[];
  readonly module: {
    readonly title: string | null;
    readonly delivery: readonly string[];
    readonly fusing_include: boolean | null;
    readonly instant: boolean | null;
    readonly type: string | null;
  } | null;
  readonly problems: readonly string[];
}

/** Framework attribute ids (android-36 public-final.xml), matched before names. */
const ATTR = {
  label: 0x01010001,
  name: 0x01010003,
  permission: 0x01010006,
  protectionLevel: 0x01010009,
  hasCode: 0x0101000c,
  enabled: 0x0101000e,
  debuggable: 0x0101000f,
  exported: 0x01010010,
  process: 0x01010011,
  authorities: 0x01010018,
  priority: 0x0101001c,
  value: 0x01010024,
  resource: 0x01010025,
  mimeType: 0x01010026,
  scheme: 0x01010027,
  host: 0x01010028,
  port: 0x01010029,
  path: 0x0101002a,
  pathPrefix: 0x0101002b,
  pathPattern: 0x0101002c,
  targetActivity: 0x01010202,
  minSdkVersion: 0x0101020c,
  versionCode: 0x0101021b,
  versionName: 0x0101021c,
  targetSdkVersion: 0x01010270,
  maxSdkVersion: 0x01010271,
  testOnly: 0x01010272,
  allowBackup: 0x01010280,
  glEsVersion: 0x01010281,
  required: 0x0101028e,
  extractNativeLibs: 0x010104ea,
  usesCleartextTraffic: 0x010104ec,
  autoVerify: 0x010104ee,
  networkSecurityConfig: 0x01010527,
  isFeatureSplit: 0x0101055b,
  compileSdkVersion: 0x01010572,
  compileSdkVersionCodename: 0x01010573,
  versionCodeMajor: 0x01010576,
  appComponentFactory: 0x0101057a,
  isSplitRequired: 0x01010591,
} as const;

type AttrName = keyof typeof ATTR;

/** The android attribute by framework id, else by name when it carries no id. */
const androidAttribute = (
  element: AndroidXmlElement,
  name: AttrName,
): AndroidXmlAttribute | null =>
  element.attributes.find(
    (attribute) => attribute.resource_id === ATTR[name],
  ) ??
  element.attributes.find(
    (attribute) =>
      attribute.resource_id === null &&
      attribute.namespace === ANDROID_NAMESPACE &&
      attribute.name === name,
  ) ??
  null;

const plainAttribute = (
  element: AndroidXmlElement,
  namespace: string | null,
  name: string,
): AndroidXmlAttribute | null =>
  element.attributes.find(
    (attribute) => attribute.namespace === namespace && attribute.name === name,
  ) ?? null;

/** Literal text, else the typed value's rendering (an int-dec SDK level reads "24"). */
const textOf = (attribute: AndroidXmlAttribute | null): string | null => {
  if (attribute === null) return null;
  return attributeText(attribute) ?? attribute.value?.text ?? null;
};

const boolOf = (attribute: AndroidXmlAttribute | null): boolean | null => {
  if (attribute === null) return null;
  if (attribute.value?.type === "boolean") return attribute.value.data !== 0;
  const text = attributeText(attribute);
  return text === "true" ? true : text === "false" ? false : null;
};

const intOf = (attribute: AndroidXmlAttribute | null): number | null => {
  if (attribute === null) return null;
  const value = attribute.value;
  if (
    (value?.type === "int-dec" || value?.type === "int-hex") &&
    value.data !== null
  )
    return value.data | 0;
  const text = attributeText(attribute)?.trim() ?? "";
  if (/^[-+]?\d+$/u.test(text)) return Number.parseInt(text, 10) | 0;
  if (/^0x[0-9a-f]+$/iu.test(text))
    return Number.parseInt(text.slice(2), 16) | 0;
  return null;
};

const lowBits = (value: number | null): number | null =>
  value === null ? null : value >>> 0;

type Resolve = ((id: number) => string | null) | undefined;

/** Text of a value that may reference a resource the resolver knows. */
const resolvedText = (
  attribute: AndroidXmlAttribute | null,
  resolve: Resolve,
): string | null => {
  if (attribute === null) return null;
  const value = attribute.value;
  if (isReference(value) && value !== null) {
    const known =
      value.data === null || value.data === 0
        ? null
        : (resolve?.(value.data) ?? null);
    return known ?? value.text;
  }
  return textOf(attribute);
};

/** Android's class-name rule: ".X" and dotless "X" are package-relative. */
export const resolveClassName = (
  packageName: string | null,
  name: string | null,
): string | null => {
  if (name === null || name === "") return null;
  if (packageName === null || packageName === "") return name;
  if (name.startsWith(".")) return `${packageName}${name}`;
  return name.includes(".") ? name : `${packageName}.${name}`;
};

const elements = (
  parent: AndroidXmlElement,
  name: string,
): AndroidXmlElement[] =>
  parent.children.filter(
    (child): child is AndroidXmlElement =>
      child.kind === "element" &&
      child.namespace === null &&
      child.name === name,
  );

const PROTECTION_BASE = [
  "normal",
  "dangerous",
  "signature",
  "signatureOrSystem",
  "internal",
];
const PROTECTION_FLAGS: readonly [number, string][] = [
  [0x10, "privileged"],
  [0x20, "development"],
  [0x40, "appop"],
  [0x80, "pre23"],
  [0x100, "installer"],
  [0x200, "verifier"],
  [0x400, "preinstalled"],
  [0x800, "setup"],
  [0x1000, "instant"],
  [0x2000, "runtime"],
  [0x4000, "oem"],
  [0x8000, "vendorPrivileged"],
  [0x10000, "textClassifier"],
  [0x80000, "configurator"],
  [0x100000, "incidentReportApprover"],
  [0x200000, "appPredictor"],
  [0x400000, "module"],
  [0x800000, "companion"],
  [0x1000000, "retailDemo"],
  [0x2000000, "recents"],
  [0x4000000, "role"],
  [0x8000000, "knownSigner"],
];

/** protectionLevel as declared, or its flag names (attrs_manifest.xml) when only the number survives. */
const protectionLevel = (
  attribute: AndroidXmlAttribute | null,
): string | null => {
  const literal = attribute === null ? null : attributeText(attribute);
  if (literal !== null || attribute === null) return literal;
  const level = intOf(attribute);
  if (level === null) return attribute.value?.text ?? null;
  const names = [
    PROTECTION_BASE[level & 0xf] ?? `0x${(level & 0xf).toString(16)}`,
  ];
  let rest = level & ~0xf;
  for (const [bit, name] of PROTECTION_FLAGS)
    if ((rest & bit) !== 0) {
      names.push(name);
      rest &= ~bit;
    }
  if (rest !== 0) names.push(`0x${(rest >>> 0).toString(16)}`);
  return names.join("|");
};

const glEsVersion = (attribute: AndroidXmlAttribute | null): string | null => {
  const version = intOf(attribute);
  if (version === null) return textOf(attribute);
  return `${String(version >>> 16)}.${String(version & 0xffff)}`;
};

const intentFilter = (filter: AndroidXmlElement): AndroidIntentFilter => {
  const names = (tag: string) =>
    elements(filter, tag).flatMap((child) => {
      const name = textOf(androidAttribute(child, "name"));
      return name === null ? [] : [name];
    });
  return {
    actions: names("action"),
    categories: names("category"),
    data: elements(filter, "data").map((data) => ({
      scheme: textOf(androidAttribute(data, "scheme")),
      host: textOf(androidAttribute(data, "host")),
      port: textOf(androidAttribute(data, "port")),
      path: textOf(androidAttribute(data, "path")),
      path_prefix: textOf(androidAttribute(data, "pathPrefix")),
      path_pattern: textOf(androidAttribute(data, "pathPattern")),
      mime_type: textOf(androidAttribute(data, "mimeType")),
    })),
    priority: intOf(androidAttribute(filter, "priority")),
    auto_verify: boolOf(androidAttribute(filter, "autoVerify")),
  };
};

const COMPONENT_KINDS = [
  "activity",
  "activity-alias",
  "service",
  "receiver",
  "provider",
] as const;

const component = (
  kind: AndroidComponent["kind"],
  element: AndroidXmlElement,
  packageName: string | null,
): AndroidComponent => {
  const name = textOf(androidAttribute(element, "name"));
  const authorities = textOf(androidAttribute(element, "authorities"));
  return {
    kind,
    name,
    class_name: resolveClassName(packageName, name),
    exported: boolOf(androidAttribute(element, "exported")),
    enabled: boolOf(androidAttribute(element, "enabled")),
    permission: textOf(androidAttribute(element, "permission")),
    process: textOf(androidAttribute(element, "process")),
    target_activity:
      kind === "activity-alias"
        ? resolveClassName(
            packageName,
            textOf(androidAttribute(element, "targetActivity")),
          )
        : null,
    authorities:
      kind === "provider" && authorities !== null
        ? authorities
            .split(";")
            .map((authority) => authority.trim())
            .filter((authority) => authority !== "")
        : [],
    intent_filters: elements(element, "intent-filter").map(intentFilter),
  };
};

/** Components in document order. */
const components = (
  application: AndroidXmlElement,
  packageName: string | null,
): AndroidComponent[] =>
  application.children.flatMap((child) => {
    if (child.kind !== "element" || child.namespace !== null) return [];
    const kind = COMPONENT_KINDS.find((candidate) => candidate === child.name);
    return kind === undefined ? [] : [component(kind, child, packageName)];
  });

const named = <T>(
  parent: AndroidXmlElement,
  tags: readonly string[],
  problems: string[],
  read: (element: AndroidXmlElement, name: string, tag: string) => T,
): T[] =>
  parent.children.flatMap((child) => {
    if (
      child.kind !== "element" ||
      child.namespace !== null ||
      !tags.includes(child.name)
    )
      return [];
    const name = textOf(androidAttribute(child, "name"));
    if (name === null) {
      problems.push(
        `<${child.name}> on line ${String(child.line ?? "?")} declares no android:name.`,
      );
      return [];
    }
    return [read(child, name, child.name)];
  });

const distribution = (
  parent: AndroidXmlElement,
  name: string,
): AndroidXmlElement[] =>
  parent.children.filter(
    (child): child is AndroidXmlElement =>
      child.kind === "element" &&
      child.namespace === DISTRIBUTION_NAMESPACE &&
      child.name === name,
  );

const distText = (element: AndroidXmlElement, name: string): string | null =>
  textOf(plainAttribute(element, DISTRIBUTION_NAMESPACE, name));

/** Readable install-time conditions (min-sdk, max-sdk, device-feature, user-countries). */
const conditions = (installTime: AndroidXmlElement): string[] =>
  distribution(installTime, "conditions").flatMap((block) =>
    block.children.flatMap((condition) => {
      if (condition.kind !== "element") return [];
      if (condition.name === "device-feature") {
        const version = distText(condition, "version");
        return [
          `device-feature ${distText(condition, "name") ?? "?"}${version === null ? "" : ` version ${version}`}`,
        ];
      }
      if (condition.name === "user-countries") {
        const codes = distribution(condition, "country").map(
          (country) => distText(country, "code") ?? "?",
        );
        const exclude =
          boolOf(
            plainAttribute(condition, DISTRIBUTION_NAMESPACE, "exclude"),
          ) === true;
        return [
          `user-countries ${exclude ? "excluding " : ""}${codes.join(",")}`,
        ];
      }
      const value = distText(condition, "value");
      return [value === null ? condition.name : `${condition.name} ${value}`];
    }),
  );

const delivery = (module: AndroidXmlElement): string[] => {
  const modes = distribution(module, "delivery").flatMap((block) =>
    block.children.flatMap((mode) => {
      if (mode.kind !== "element") return [];
      const found = conditions(mode);
      const removable = distribution(mode, "removable").map(
        (element) => `removable ${distText(element, "value") ?? "?"}`,
      );
      return [
        mode.name,
        ...(found.length > 0 ? [`conditions: ${found.join(", ")}`] : []),
        ...removable,
      ];
    }),
  );
  const legacy = boolOf(
    plainAttribute(module, DISTRIBUTION_NAMESPACE, "onDemand"),
  );
  if (legacy !== null)
    modes.push(
      legacy
        ? "on-demand (dist:onDemand)"
        : "install-time (dist:onDemand=false)",
    );
  return modes;
};

const moduleFacts = (
  manifest: AndroidXmlElement,
  resolve: Resolve,
): AndroidManifestFacts["module"] => {
  const module = distribution(manifest, "module")[0];
  if (module === undefined) return null;
  const fusing = distribution(module, "fusing")[0];
  return {
    title: resolvedText(
      plainAttribute(module, DISTRIBUTION_NAMESPACE, "title"),
      resolve,
    ),
    delivery: delivery(module),
    fusing_include:
      fusing === undefined
        ? null
        : boolOf(plainAttribute(fusing, DISTRIBUTION_NAMESPACE, "include")),
    instant: boolOf(plainAttribute(module, DISTRIBUTION_NAMESPACE, "instant")),
    type: distText(module, "type"),
  };
};

const applicationFacts = (
  application: AndroidXmlElement | undefined,
  resolve: Resolve,
): AndroidManifestFacts["application"] => {
  if (application === undefined) return null;
  const attribute = (name: AttrName) => androidAttribute(application, name);
  return {
    name: textOf(attribute("name")),
    label: resolvedText(attribute("label"), resolve),
    debuggable: boolOf(attribute("debuggable")),
    allow_backup: boolOf(attribute("allowBackup")),
    uses_cleartext_traffic: boolOf(attribute("usesCleartextTraffic")),
    extract_native_libs: boolOf(attribute("extractNativeLibs")),
    has_code: boolOf(attribute("hasCode")),
    test_only: boolOf(attribute("testOnly")),
    network_security_config: resolvedText(
      attribute("networkSecurityConfig"),
      resolve,
    ),
    app_component_factory: textOf(attribute("appComponentFactory")),
  };
};

const platformBuildVersion = (manifest: AndroidXmlElement): string | null => {
  const code = textOf(
    plainAttribute(manifest, null, "platformBuildVersionCode"),
  );
  const name = textOf(
    plainAttribute(manifest, null, "platformBuildVersionName"),
  );
  if (code === null) return name;
  return name === null ? code : `${code} (${name})`;
};

/**
 * Read declared facts from a manifest root element. `resolveText` maps a
 * resource id to its text (for labels and module titles); without it a
 * reference reads as aapt2 renders it ("@0x7f040000").
 */
export const readManifestFacts = (
  root: AndroidXmlElement,
  resolveText?: (id: number) => string | null,
): AndroidManifestFacts => {
  const problems: string[] = [];
  if (root.name !== "manifest" || root.namespace !== null)
    problems.push(`Root element is <${root.name}>, not <manifest>.`);
  const packageName = textOf(plainAttribute(root, null, "package"));
  if (packageName === null) problems.push("<manifest> declares no package.");
  const applications = elements(root, "application");
  if (applications.length > 1)
    problems.push(
      `${String(applications.length)} <application> elements; the first is read.`,
    );
  const application = applications[0];
  const usesSdk = elements(root, "uses-sdk")[0];
  const sdk = (name: AttrName) =>
    usesSdk === undefined ? null : textOf(androidAttribute(usesSdk, name));
  const attribute = (name: AttrName) => androidAttribute(root, name);
  return {
    package_name: packageName,
    // The low 32 bits of the long version code, as getLongVersionCode() combines them.
    version_code: lowBits(intOf(attribute("versionCode"))),
    version_code_major: intOf(attribute("versionCodeMajor")),
    version_name: textOf(attribute("versionName")),
    split: textOf(plainAttribute(root, null, "split")),
    config_for_split: textOf(plainAttribute(root, null, "configForSplit")),
    is_feature_split: boolOf(attribute("isFeatureSplit")),
    is_split_required: boolOf(attribute("isSplitRequired")),
    min_sdk: sdk("minSdkVersion"),
    target_sdk: sdk("targetSdkVersion"),
    max_sdk: sdk("maxSdkVersion"),
    compile_sdk: textOf(attribute("compileSdkVersion")),
    compile_sdk_codename: textOf(attribute("compileSdkVersionCodename")),
    platform_build_version: platformBuildVersion(root),
    uses_permissions: named(
      root,
      ["uses-permission", "uses-permission-sdk-23", "uses-permission-sdk-m"],
      problems,
      (element, name, tag) => ({
        name,
        max_sdk: intOf(androidAttribute(element, "maxSdkVersion")),
        kind:
          tag === "uses-permission"
            ? ("uses-permission" as const)
            : ("uses-permission-sdk-23" as const),
      }),
    ),
    declared_permissions: named(
      root,
      ["permission"],
      problems,
      (element, name) => ({
        name,
        protection_level: protectionLevel(
          androidAttribute(element, "protectionLevel"),
        ),
      }),
    ),
    uses_features: elements(root, "uses-feature").map((element) => ({
      name: textOf(androidAttribute(element, "name")),
      required: boolOf(androidAttribute(element, "required")),
      gl_es_version: glEsVersion(androidAttribute(element, "glEsVersion")),
    })),
    uses_libraries:
      application === undefined
        ? []
        : named(
            application,
            ["uses-library", "uses-native-library"],
            problems,
            (element, name, tag) => ({
              name,
              required: boolOf(androidAttribute(element, "required")),
              native: tag === "uses-native-library",
            }),
          ),
    uses_splits: named(
      root,
      ["uses-split"],
      problems,
      (_element, name) => name,
    ),
    application: applicationFacts(application, resolveText),
    components:
      application === undefined ? [] : components(application, packageName),
    meta_data:
      application === undefined
        ? []
        : named(application, ["meta-data"], problems, (element, name) => ({
            name,
            value: textOf(androidAttribute(element, "value")),
            resource: textOf(androidAttribute(element, "resource")),
          })),
    module: moduleFacts(root, resolveText),
    problems,
  };
};
