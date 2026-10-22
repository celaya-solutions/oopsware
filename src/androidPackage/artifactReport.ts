import { elfHeader } from "../jvm/jarMetadata.js";
import { MemberReadFailure, sha256Hex } from "../artifacts/zipMemberView.js";
import type {
  AndroidArtifactReport,
  AndroidDiagnostic,
  InspectAndroidArtifactInput,
} from "../domain/android/androidArtifact.js";
import type { FacetCoverage } from "../domain/formatRegistry.js";
import { readBundleConfig } from "./bundle/bundleConfig.js";
import { readApksToc } from "./bundle/toc.js";
import { AndroidSelectionError } from "./classReport.js";
import {
  classPage,
  dexMembers,
  loadDex,
  type DexLocation,
  type LoadedDex,
} from "./dexInventory.js";
import {
  layeredTable,
  readManifest,
  readResourceTable,
  type ManifestView,
} from "./package/manifestView.js";
import { readSigning } from "./package/signing.js";
import { tocDeclarations, type ApkDeclaration } from "./package/apkSet.js";
import type { AndroidPackageView } from "./package/view.js";

type Report = AndroidArtifactReport;
type Apk = NonNullable<Report["apk"]>;
type Bundle = NonNullable<Report["bundle"]>;
type ApkSet = NonNullable<Report["apk_set"]>;
type NativeLibrary = Report["native_libraries"][number];

const ABI_MACHINES: Readonly<
  Record<string, { machine: string; class: "32" | "64" }>
> = {
  armeabi: { machine: "arm", class: "32" },
  "armeabi-v7a": { machine: "arm", class: "32" },
  "arm64-v8a": { machine: "aarch64", class: "64" },
  x86: { machine: "x86", class: "32" },
  x86_64: { machine: "x86_64", class: "64" },
  riscv64: { machine: "riscv", class: "64" },
};

const LIMITATIONS: Readonly<
  Record<Report["package"]["kind"], readonly string[]>
> = {
  dex: [],
  apk: [
    "Manifest entries are declarations; permissions are requested, not granted, and nothing about run-time behaviour follows from them.",
  ],
  aab: [
    "An App Bundle is a publishing format, not an installable APK; which APKs a device would receive is decided by bundletool and the store, not by this reader.",
    "Manifest entries are declarations; permissions are requested, not granted.",
  ],
  apks: [
    "Which APKs a device would install is decided by bundletool's device matching; the table of contents is reported as written, not evaluated for a device.",
  ],
  xapk: [
    "XAPK is a third-party format with no formal specification; the reader admits APKPure's manifest.json layout (xapk_version 2 with split_apks) and keeps other layouts as plain ZIP facts. No producer-made XAPK was available to check this layout.",
  ],
  zip: ["The ZIP has no Android package layout; only DEX members are read."],
};

const SHARED_LIMITATIONS = [
  "Nothing is installed, signed, verified, optimized or run, and no device is contacted.",
  "Signature files and APK Signing Block entries are recorded as present; no signature, digest or certificate is checked, and nothing is trusted.",
  "DEX checksums and SHA-1 signatures are recomputed and compared; classes are listed from class_defs, and inspect_dex_method decodes bytecode on request.",
];

const message = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** Member failures become diagnostics (a spent budget too, with a continuation); cancellation stops the call. */
const recoverable = (cause: unknown): cause is MemberReadFailure =>
  cause instanceof MemberReadFailure && cause.reason !== "cancelled";

const abiOf = (
  path: string,
  prefix: string,
): { abi: string; name: string } | null => {
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length).split("/");
  return rest.length === 2 && rest[0] !== "" && rest[1] !== ""
    ? { abi: rest[0] ?? "", name: rest[1] ?? "" }
    : null;
};

const distinct = (values: Iterable<string>): string[] =>
  [...new Set(values)].sort();

/** Native libraries under `prefix`lib/<abi>/ with digest and ELF machine. */
const nativeLibraries = async (
  view: AndroidPackageView,
  container: string | null,
  module: string | null,
  diagnostics: AndroidDiagnostic[],
): Promise<NativeLibrary[]> => {
  const prefix = module === null ? "lib/" : `${module}/lib/`;
  const libraries: NativeLibrary[] = [];
  for (const member of view.members(container)) {
    if (member.directory) continue;
    const placed = abiOf(member.path, prefix);
    if (placed === null) continue;
    let bytes: Uint8Array | null = null;
    try {
      bytes = await view.read(container, member.path);
    } catch (cause) {
      if (!recoverable(cause)) throw cause;
      diagnostics.push({
        container,
        entry: member.path,
        offset: null,
        message: cause.message,
      });
    }
    const header = bytes === null ? null : elfHeader(bytes);
    const expected = ABI_MACHINES[placed.abi];
    libraries.push({
      container,
      module,
      entry: member.path,
      abi: placed.abi,
      name: placed.name,
      bytes: member.bytes,
      sha256: bytes === null ? null : sha256Hex(bytes),
      elf:
        header === null
          ? null
          : {
              ...header,
              matches_abi:
                expected === undefined
                  ? null
                  : expected.machine === header.machine &&
                    expected.class === header.class,
            },
    });
  }
  return libraries;
};

const abis = (
  view: AndroidPackageView,
  container: string | null,
  prefix: string,
): string[] =>
  distinct(
    view.members(container).flatMap((member) => {
      const placed = member.directory ? null : abiOf(member.path, prefix);
      return placed === null ? [] : [placed.abi];
    }),
  );

const countUnder = (
  view: AndroidPackageView,
  container: string | null,
  prefix: string,
): number =>
  view
    .members(container)
    .filter((member) => !member.directory && member.path.startsWith(prefix))
    .length;

/** Read a member, turning a recoverable failure into a diagnostic and null. */
const readOptional = async (
  view: AndroidPackageView,
  container: string | null,
  entry: string,
  diagnostics: AndroidDiagnostic[],
): Promise<Uint8Array | null> => {
  if (!view.has(container, entry)) return null;
  try {
    return await view.read(container, entry);
  } catch (cause) {
    if (!recoverable(cause)) throw cause;
    diagnostics.push({
      container,
      entry,
      offset: null,
      message: cause.message,
    });
    return null;
  }
};

/** An APK (the file itself or one APK of a set): manifest, resources, DEX, ABIs and signatures. */
const readApk = async (
  view: AndroidPackageView,
  container: string | null,
  zipBytes: Uint8Array,
  diagnostics: AndroidDiagnostic[],
): Promise<Apk> => {
  const arsc = await readOptional(
    view,
    container,
    "resources.arsc",
    diagnostics,
  );
  const resources =
    arsc === null
      ? null
      : readResourceTable(container, "resources.arsc", "arsc", arsc);
  const manifestBytes = await readOptional(
    view,
    container,
    "AndroidManifest.xml",
    diagnostics,
  );
  const manifest =
    manifestBytes === null
      ? null
      : readManifest(
          container,
          "AndroidManifest.xml",
          "binary-xml",
          manifestBytes,
          resources?.table ?? null,
        );
  if (manifestBytes === null)
    diagnostics.push({
      container,
      entry: null,
      offset: null,
      message: "The APK has no AndroidManifest.xml.",
    });
  const members = view.members(container);
  return {
    container,
    manifest,
    resources: resources?.view ?? null,
    dex: dexMembers(view, container, () => null)
      .filter((location) => location.role === "code")
      .map((location) => location.entry ?? ""),
    native_abis: abis(view, container, "lib/"),
    assets: countUnder(view, container, "assets/"),
    resource_files: countUnder(view, container, "res/"),
    signing: readSigning(members, zipBytes),
  };
};

/** Top-level directories of a bundle that are modules (they hold manifest/AndroidManifest.xml, dex/, res/ ...). */
const bundleModules = (view: AndroidPackageView): string[] =>
  distinct(
    view.members(null).flatMap((member) => {
      const slash = member.path.indexOf("/");
      if (slash <= 0) return [];
      const top = member.path.slice(0, slash);
      return top === "META-INF" || top === "BUNDLE-METADATA" ? [] : [top];
    }),
  );

const moduleOf =
  (modules: readonly string[]) =>
  (path: string): string | null => {
    const top = path.slice(0, Math.max(0, path.indexOf("/")));
    return modules.includes(top) ? top : null;
  };

const readBundle = async (
  view: AndroidPackageView,
  zipBytes: Uint8Array,
  diagnostics: AndroidDiagnostic[],
): Promise<Bundle> => {
  const configBytes = await readOptional(
    view,
    null,
    "BundleConfig.pb",
    diagnostics,
  );
  let config: Bundle["config"] = null;
  let configError: string | null =
    configBytes === null ? "The bundle has no BundleConfig.pb." : null;
  if (configBytes !== null)
    try {
      config = JSON.parse(
        JSON.stringify(readBundleConfig(configBytes)),
      ) as Bundle["config"];
    } catch (cause) {
      configError = `BundleConfig.pb could not be decoded: ${message(cause)}`;
    }
  const modules: Bundle["modules"] = [];
  const names = bundleModules(view);
  const owner = moduleOf(names);
  const tables = new Map<string, ReturnType<typeof readResourceTable>>();
  for (const name of names) {
    const tableBytes = await readOptional(
      view,
      null,
      `${name}/resources.pb`,
      diagnostics,
    );
    if (tableBytes !== null)
      tables.set(
        name,
        readResourceTable(null, `${name}/resources.pb`, "proto", tableBytes),
      );
  }
  const baseTable = tables.get("base")?.table ?? null;
  for (const name of names) {
    const resources = tables.get(name) ?? null;
    const manifestEntry = `${name}/manifest/AndroidManifest.xml`;
    const manifestBytes = await readOptional(
      view,
      null,
      manifestEntry,
      diagnostics,
    );
    const manifest: ManifestView | null =
      manifestBytes === null
        ? null
        : readManifest(
            null,
            manifestEntry,
            "proto-xml",
            manifestBytes,
            layeredTable(resources?.table ?? null, baseTable),
          );
    if (manifestBytes === null)
      diagnostics.push({
        container: null,
        entry: null,
        offset: null,
        message: `Module ${name} has no manifest/AndroidManifest.xml.`,
      });
    modules.push({
      name,
      manifest,
      resources: resources?.view ?? null,
      dex: dexMembers(view, null, owner)
        .filter(
          (location) => location.role === "code" && location.module === name,
        )
        .map((location) => location.entry ?? ""),
      native_abis: abis(view, null, `${name}/lib/`),
      assets: countUnder(view, null, `${name}/assets/`),
      resource_files: countUnder(view, null, `${name}/res/`),
      metadata_files: view
        .members(null)
        .filter(
          (member) =>
            !member.directory &&
            member.path.startsWith(`${name}/`) &&
            member.path.slice(name.length + 1).endsWith(".pb") &&
            !member.path.slice(name.length + 1).includes("/") &&
            member.path !== `${name}/resources.pb`,
        )
        .map((member) => member.path)
        .sort(),
    });
  }
  return {
    config,
    config_error: configError,
    modules,
    metadata: view
      .members(null)
      .filter(
        (member) =>
          !member.directory && member.path.startsWith("BUNDLE-METADATA/"),
      )
      .map((member) => member.path)
      .sort(),
    signing: readSigning(view.members(null), zipBytes),
  };
};

const XAPK_MANIFEST_BYTES = 4 * 1024 ** 2;

interface XapkDeclarations {
  readonly manifest: Record<string, unknown> | null;
  readonly profile: ApkSet["xapk_profile"];
  readonly error: string | null;
  readonly declarations: ApkDeclaration[];
  readonly expansions: {
    readonly file: string;
    readonly path: string | null;
  }[];
}

/** Parse an XAPK manifest.json; only APKPure's version 2 layout drives APK roles. */
const xapkDeclarations = async (
  view: AndroidPackageView,
  diagnostics: AndroidDiagnostic[],
): Promise<XapkDeclarations> => {
  const none = {
    manifest: null,
    profile: "unknown" as const,
    declarations: [],
    expansions: [],
  };
  const member = view
    .members(null)
    .find((entry) => entry.path === "manifest.json");
  if (member === undefined)
    return { ...none, profile: null, error: "The set has no manifest.json." };
  if (member.bytes > XAPK_MANIFEST_BYTES)
    return {
      ...none,
      error: `manifest.json is ${String(member.bytes)} bytes, over the ${String(XAPK_MANIFEST_BYTES)}-byte limit.`,
    };
  const bytes = await readOptional(view, null, "manifest.json", diagnostics);
  if (bytes === null)
    return { ...none, error: "manifest.json could not be read." };
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch (cause) {
    return {
      ...none,
      error: `manifest.json is not valid UTF-8 JSON: ${message(cause)}`,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return { ...none, error: "manifest.json is not a JSON object." };
  const manifest = parsed as Record<string, unknown>;
  const splits = manifest.split_apks;
  const version = manifest.xapk_version;
  const expansions = Array.isArray(manifest.expansions)
    ? manifest.expansions.flatMap((entry: unknown) =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { file?: unknown }).file === "string"
          ? [
              {
                file: (entry as { file: string }).file,
                path:
                  typeof (entry as { install_path?: unknown }).install_path ===
                  "string"
                    ? (entry as { install_path: string }).install_path
                    : null,
              },
            ]
          : [],
      )
    : [];
  if (version !== 2 || !Array.isArray(splits))
    return {
      manifest,
      profile: "unknown",
      error: null,
      declarations: [],
      expansions,
    };
  const declarations = splits.flatMap((entry: unknown): ApkDeclaration[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const file = (entry as { file?: unknown }).file;
    const id = (entry as { id?: unknown }).id;
    if (typeof file !== "string") return [];
    const split = typeof id === "string" ? id : null;
    return [
      {
        path: file,
        kind:
          split === "base"
            ? "base"
            : split?.startsWith("config.") === true
              ? "config"
              : "split",
        module:
          split === "base" || split?.startsWith("config.") === true
            ? "base"
            : split,
        split_id: split === "base" ? null : split,
        is_master:
          split === "base"
            ? true
            : split?.startsWith("config.") === true
              ? false
              : null,
        targeting: [],
        variant: null,
      },
    ];
  });
  return {
    manifest,
    profile: "apkpure-v2",
    error: null,
    declarations,
    expansions,
  };
};

/** An APK set (.apks) or XAPK: declared APKs, each APK's manifest summary, gaps and conflicts. */
const readApkSet = async (
  view: AndroidPackageView,
  format: "apks" | "xapk",
  diagnostics: AndroidDiagnostic[],
): Promise<ApkSet> => {
  let toc: ApkSet["toc"] = null;
  let tocError: string | null = null;
  let declarations: ApkDeclaration[] = [];
  let xapk: XapkDeclarations | null = null;
  if (format === "apks") {
    const bytes = await readOptional(view, null, "toc.pb", diagnostics);
    if (bytes === null) tocError = "The set has no toc.pb.";
    else
      try {
        const decoded = readApksToc(bytes);
        toc = JSON.parse(JSON.stringify(decoded)) as ApkSet["toc"];
        declarations = tocDeclarations(decoded);
      } catch (cause) {
        tocError = `toc.pb could not be decoded: ${message(cause)}`;
      }
  } else {
    xapk = await xapkDeclarations(view, diagnostics);
    declarations = xapk.declarations;
  }
  const members = new Set(view.apkMembers());
  const byPath = new Map<string, ApkDeclaration[]>();
  for (const declaration of declarations)
    byPath.set(declaration.path, [
      ...(byPath.get(declaration.path) ?? []),
      declaration,
    ]);
  const apks: ApkSet["apks"] = [];
  for (const entry of [...members].sort()) {
    const declared = byPath.get(entry) ?? [];
    const first = declared[0];
    const record = {
      entry,
      kind: first?.kind ?? ("undeclared" as const),
      module: first?.module ?? null,
      split_id: first?.split_id ?? null,
      is_master: first?.is_master ?? null,
      targeting: distinct(
        declared.flatMap((declaration) => declaration.targeting),
      ),
      variants: distinct(
        declared.flatMap((declaration) =>
          declaration.variant === null ? [] : [String(declaration.variant)],
        ),
      ).map(Number),
    };
    try {
      const nested = await view.nested(entry);
      const manifestBytes = await readOptional(
        view,
        entry,
        "AndroidManifest.xml",
        diagnostics,
      );
      const manifest =
        manifestBytes === null
          ? null
          : readManifest(
              entry,
              "AndroidManifest.xml",
              "binary-xml",
              manifestBytes,
              null,
            );
      const facts = manifest?.facts ?? null;
      apks.push({
        ...record,
        bytes: nested.bytes.length,
        sha256: nested.sha256,
        manifest:
          facts === null
            ? null
            : {
                package_name: facts.package_name,
                version_code: facts.version_code,
                version_name: facts.version_name,
                split: facts.split,
                config_for_split: facts.config_for_split,
                is_feature_split: facts.is_feature_split,
                min_sdk: facts.min_sdk,
                target_sdk: facts.target_sdk,
              },
        dex: dexMembers(view, entry, () => null)
          .filter((location) => location.role === "code")
          .map((location) => location.entry ?? ""),
        native_abis: abis(view, entry, "lib/"),
        error:
          manifest?.error ??
          (manifestBytes === null
            ? "The APK has no AndroidManifest.xml."
            : null),
      });
    } catch (cause) {
      if (!recoverable(cause)) throw cause;
      const size =
        view.members(null).find((member) => member.path === entry)?.bytes ?? 0;
      apks.push({
        ...record,
        bytes: size,
        sha256: null,
        manifest: null,
        dex: [],
        native_abis: [],
        error: cause.message,
      });
    }
  }
  const missing = distinct(
    [
      ...declarations.map((declaration) => declaration.path),
      ...(xapk?.expansions.map((expansion) => expansion.file) ?? []),
    ].filter((path) => !view.has(null, path)),
  );
  const bases = apks.filter(
    (apk) =>
      apk.kind === "base" ||
      apk.kind === "standalone" ||
      apk.kind === "system" ||
      (apk.kind === "split" &&
        apk.module === "base" &&
        apk.is_master === true) ||
      (declarations.length === 0 &&
        apk.manifest !== null &&
        apk.manifest.split === null),
  );
  const conflicts: string[] = [];
  const packages = distinct(
    apks.flatMap((apk) =>
      apk.manifest?.package_name == null ? [] : [apk.manifest.package_name],
    ),
  );
  if (packages.length > 1)
    conflicts.push(`APKs declare different packages: ${packages.join(", ")}.`);
  const versions = distinct(
    apks.flatMap((apk) =>
      apk.manifest?.version_code == null
        ? []
        : [String(apk.manifest.version_code)],
    ),
  );
  if (versions.length > 1)
    conflicts.push(
      `APKs declare different version codes: ${versions.join(", ")}.`,
    );
  const declaredPackage = xapk?.manifest?.package_name;
  if (
    typeof declaredPackage === "string" &&
    packages.length > 0 &&
    !packages.includes(declaredPackage)
  )
    conflicts.push(
      `manifest.json names package ${declaredPackage}; the APKs declare ${packages.join(", ")}.`,
    );
  const declaredVersion = xapk?.manifest?.version_code;
  if (
    (typeof declaredVersion === "string" ||
      typeof declaredVersion === "number") &&
    versions.length > 0 &&
    !versions.includes(String(declaredVersion))
  )
    conflicts.push(
      `manifest.json names version code ${String(declaredVersion)}; the APKs declare ${versions.join(", ")}.`,
    );
  return {
    format,
    toc,
    toc_error: tocError,
    xapk_manifest: (xapk?.manifest ?? null) as ApkSet["xapk_manifest"],
    xapk_profile: xapk?.profile ?? null,
    xapk_error: xapk?.error ?? null,
    apks,
    missing,
    undeclared: apks
      .filter((apk) => apk.kind === "undeclared" && declarations.length > 0)
      .map((apk) => apk.entry),
    base: {
      state:
        bases.length === 0
          ? "none"
          : bases.length === 1
            ? "single"
            : "multiple",
      entries: bases.map((apk) => apk.entry),
    },
    conflicts,
    obb: view
      .members(null)
      .filter(
        (member) =>
          !member.directory && member.path.toLowerCase().endsWith(".obb"),
      )
      .map((member) => ({
        entry: member.path,
        bytes: member.bytes,
        declared_path:
          xapk?.expansions.find((expansion) => expansion.file === member.path)
            ?.path ?? null,
      })),
  };
};

/** Every DEX location in the artifact, code DEX first per container. */
const allDexLocations = async (
  view: AndroidPackageView,
  diagnostics: AndroidDiagnostic[],
): Promise<DexLocation[]> => {
  switch (view.kind) {
    case "dex":
      return [{ container: null, entry: null, module: null, role: "code" }];
    case "aab":
      return dexMembers(view, null, moduleOf(bundleModules(view)));
    case "apks":
    case "xapk": {
      const locations: DexLocation[] = [];
      for (const entry of view.apkMembers().sort()) {
        try {
          await view.nested(entry);
        } catch (cause) {
          if (!recoverable(cause)) throw cause;
          diagnostics.push({
            container: entry,
            entry: null,
            offset: null,
            message: cause.message,
          });
          continue;
        }
        locations.push(...dexMembers(view, entry, () => null));
      }
      return [...dexMembers(view, null, () => null), ...locations];
    }
    default:
      return dexMembers(view, null, () => null);
  }
};

/** Keep the DEX files a caller's `container`/`entry` names; refuse names that match nothing. */
const scope = (
  view: AndroidPackageView,
  locations: readonly DexLocation[],
  input: { container?: string | undefined; entry?: string | undefined },
): DexLocation[] => {
  if (input.container === undefined && input.entry === undefined)
    return [...locations];
  if (view.kind === "dex")
    throw new AndroidSelectionError(
      "entry",
      "A bare DEX file has no members; omit container and entry.",
    );
  if (
    input.container !== undefined &&
    view.kind !== "apks" &&
    view.kind !== "xapk"
  )
    throw new AndroidSelectionError(
      "container",
      `container names an APK inside an .apks or .xapk set; this file is ${view.kind === "aab" ? "an App Bundle (name a module's DEX with entry, e.g. base/dex/classes.dex)" : `a ${view.kind}`}.`,
    );
  const container = input.container ?? null;
  if (container !== null && !view.apkMembers().includes(container))
    throw new AndroidSelectionError(
      "container",
      `${container} is not an APK member of this set.`,
    );
  const kept = locations.filter(
    (location) =>
      location.container === container &&
      (input.entry === undefined || location.entry === input.entry),
  );
  if (kept.length === 0)
    throw new AndroidSelectionError(
      input.entry === undefined ? "container" : "entry",
      input.entry === undefined
        ? `${container ?? "The file"} holds no DEX file.`
        : `${input.entry} is not a DEX member${container === null ? "" : ` of ${container}`}; DEX members: ${
            locations
              .filter((location) => location.container === container)
              .map((location) => location.entry ?? "")
              .join(", ") || "none"
          }.`,
    );
  return kept;
};

/** Every parsed DEX file of the artifact, and the ones a class or method call may choose from. */
export const scopedDex = async (
  view: AndroidPackageView,
  input: { container?: string | undefined; entry?: string | undefined },
): Promise<{ all: LoadedDex[]; scoped: LoadedDex[] }> => {
  const locations = await allDexLocations(view, []);
  const located = scope(view, locations, input);
  const all: LoadedDex[] = [];
  for (const location of locations) {
    const entry = await loadDex(view, location);
    // A class cannot be looked up in a DEX the budget did not cover; say so instead of "not found".
    if (entry.failure?.reason === "budget") throw entry.failure;
    all.push(entry);
  }
  return {
    all,
    scoped: all.filter((entry) => located.includes(entry.location)),
  };
};

const coverageOf = (
  view: AndroidPackageView,
  loaded: readonly LoadedDex[],
  diagnostics: readonly AndroidDiagnostic[],
  unreadApks: number,
): FacetCoverage[] => {
  const failedDex = loaded.filter((entry) => entry.dex === null).length;
  const identify: FacetCoverage = {
    facet: "identify",
    state: "complete",
    examined:
      view.kind === "dex"
        ? "DEX magic, version and header"
        : "ZIP members and Android package layout",
    omitted: null,
    reason: null,
    continuation: null,
  };
  const inventory: FacetCoverage =
    unreadApks === 0
      ? {
          facet: "inventory",
          state: "complete",
          examined: "every member of the package and of each APK it contains",
          omitted: null,
          reason: null,
          continuation: null,
        }
      : {
          facet: "inventory",
          state: "partial",
          examined:
            "every member of the package and of the APKs that could be opened",
          omitted: `${String(unreadApks)} nested APKs`,
          reason: "They could not be opened as ZIP archives.",
          continuation: null,
        };
  const damaged = diagnostics.length > 0 || failedDex > 0;
  const budgetHit = view.budgetExceeded;
  const inspect: FacetCoverage = damaged
    ? {
        facet: "inspect",
        state: "partial",
        examined: `manifests, resource tables, package metadata and ${String(loaded.length - failedDex)} of ${String(loaded.length)} DEX files`,
        omitted: `${String(diagnostics.length)} problems are listed in diagnostics${failedDex > 0 ? `; ${String(failedDex)} DEX files could not be parsed` : ""}`,
        reason: budgetHit
          ? "The decompression budget ran out."
          : "Some members are damaged, missing or unreadable.",
        continuation: budgetHit ? "Raise max_decoded_bytes." : null,
      }
    : {
        facet: "inspect",
        state: "complete",
        examined: `manifests, resource tables, package metadata and the headers, maps and class lists of ${String(loaded.length)} DEX files`,
        omitted: null,
        reason: null,
        continuation: null,
      };
  return [
    identify,
    ...(view.kind === "dex" ? [] : [inventory]),
    inspect,
    {
      facet: "reconstruct",
      state: "not_requested",
      examined: null,
      omitted: null,
      reason:
        "Classes are reported from their DEX structures; inspect_dex_method decodes one method's bytecode, and decompile_dex_class reconstructs inferred Java source for one class.",
      continuation: null,
    },
  ];
};

/** Inventory one DEX file or Android package and return a page of its classes. */
export const readAndroidArtifact = async (
  view: AndroidPackageView,
  artifact: Report["artifact"],
  bytes: Uint8Array,
  input: InspectAndroidArtifactInput,
): Promise<Report> => {
  const diagnostics: AndroidDiagnostic[] = [];
  let apk: Report["apk"] = null;
  let bundle: Report["bundle"] = null;
  let apkSet: Report["apk_set"] = null;
  if (view.kind === "apk") apk = await readApk(view, null, bytes, diagnostics);
  if (view.kind === "aab") bundle = await readBundle(view, bytes, diagnostics);
  if (view.kind === "apks" || view.kind === "xapk")
    apkSet = await readApkSet(view, view.kind, diagnostics);
  const locations = await allDexLocations(view, diagnostics);
  const selected = scope(view, locations, input);
  if (input.container !== undefined) {
    const nested = await view.nested(input.container);
    apk = await readApk(view, input.container, nested.bytes, diagnostics);
  }
  const loaded: LoadedDex[] = [];
  for (const location of locations) loaded.push(await loadDex(view, location));
  for (const entry of loaded) {
    diagnostics.push(...entry.summary.problems);
    if (entry.failure !== null)
      diagnostics.push({
        container: entry.location.container,
        entry: entry.location.entry,
        offset: null,
        message: entry.failure.message,
      });
  }
  const inScope = loaded.filter((entry) => selected.includes(entry.location));
  const page = classPage(inScope, input.start, input.limit);
  const libraries: NativeLibrary[] = [];
  if (view.kind === "apk")
    libraries.push(...(await nativeLibraries(view, null, null, diagnostics)));
  if (view.kind === "aab")
    for (const module of bundle?.modules ?? [])
      libraries.push(
        ...(await nativeLibraries(view, null, module.name, diagnostics)),
      );
  if (view.kind === "apks" || view.kind === "xapk")
    for (const entry of apkSet?.apks ?? [])
      if (entry.sha256 !== null)
        libraries.push(
          ...(await nativeLibraries(view, entry.entry, null, diagnostics)),
        );
  for (const library of libraries)
    if (library.elf?.matches_abi === false)
      diagnostics.push({
        container: library.container,
        entry: library.entry,
        offset: null,
        message: `${library.entry} is ${library.elf.class}-bit ${library.elf.machine}, not what ABI directory ${library.abi} names.`,
      });
  const manifestProblems = [
    apk?.manifest,
    ...(bundle?.modules.map((module) => module.manifest) ?? []),
  ].flatMap((manifest) => manifest?.problems ?? []);
  const tableProblems = [
    apk?.resources,
    ...(bundle?.modules.map((module) => module.resources) ?? []),
  ].flatMap((table) => table?.problems ?? []);
  diagnostics.push(...manifestProblems, ...tableProblems);
  const unreadApks =
    apkSet?.apks.filter((entry) => entry.sha256 === null).length ?? 0;
  const next = input.start + page.classes.length;
  return {
    artifact,
    package: {
      kind: view.kind,
      basis: view.basis,
      name_conflict: view.nameConflict,
    },
    apk,
    bundle,
    apk_set: apkSet,
    dex_files: loaded.map((entry) => entry.summary),
    native_libraries: libraries,
    summary: {
      entries: view.members(null).length,
      dex_files: loaded.length,
      classes: loaded.reduce(
        (sum, entry) => sum + (entry.dex?.classCount ?? 0),
        0,
      ),
      native_libraries: libraries.length,
      decoded_bytes: view.budget.used,
    },
    class_count: page.total,
    page: {
      start: input.start,
      limit: input.limit,
      returned: page.classes.length,
      next: next < page.total ? next : null,
    },
    classes: page.classes,
    diagnostics,
    coverage: coverageOf(view, loaded, diagnostics, unreadApks),
    limitations: [...SHARED_LIMITATIONS, ...LIMITATIONS[view.kind]],
  };
};
