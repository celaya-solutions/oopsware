import type { FacetCoverage } from "../domain/formatRegistry.js";
import {
  MAX_JVM_LISTED,
  type JvmArtifactReport,
  type JvmClassSummary,
} from "../domain/jvm/jvm.js";
import {
  DecodeBudget,
  MemberReadFailure,
  sha256Hex,
} from "../artifacts/zipMemberView.js";
import { parseClass } from "./classfile/parseClass.js";
import {
  classSummary,
  javaRelease,
  moduleView,
  unreadableSummary,
} from "./classView.js";
import {
  attribute,
  declaredDigests,
  digestMatches,
  elfHeader,
  parseManifest,
  parseServiceFile,
  readAndroidManifest,
} from "./jarMetadata.js";
import {
  classMembers,
  MANIFEST_ENTRY,
  viewsOf,
  type ArchiveView,
  type JvmSource,
} from "./source.js";

type Report = JvmArtifactReport;
type Diagnostic = Report["diagnostics"][number];

interface Input {
  readonly artifact: Report["artifact"];
  readonly source: JvmSource;
  readonly budget: DecodeBudget;
  readonly start: number;
  readonly limit: number;
  readonly signal?: AbortSignal | undefined;
}

const SIGNATURE_FILE = /^META-INF\/([^/]+)\.SF$/iu;
const SERVICE_FILE = /^META-INF\/services\/([^/]+)$/u;
const NATIVE_LIBRARY = /^jni\/([^/]+)\/([^/]+)$/u;
const AAR_PARTS = new Set([
  "R.txt",
  "proguard.txt",
  "public.txt",
  "lint.jar",
  "annotations.zip",
  "api.jar",
]);

const emptyKinds = () => ({
  class: 0,
  interface: 0,
  enum: 0,
  annotation: 0,
  record: 0,
  module: 0,
});

/** Rethrow cancellation; every other member failure becomes a diagnostic. */
const failure = (cause: unknown): MemberReadFailure => {
  if (!(cause instanceof MemberReadFailure)) throw cause;
  if (cause.reason === "cancelled") throw cause;
  return cause;
};

interface Collected {
  classes: JvmClassSummary[];
  modules: Report["modules"];
  services: Report["services"];
  signatures: Report["signatures"];
  diagnostics: Diagnostic[];
  unread: number;
  budgetHit: boolean;
}

const readClasses = async (
  view: ArchiveView,
  budget: DecodeBudget,
  collected: Collected,
  signal?: AbortSignal,
) => {
  for (const { member, release } of classMembers(view)) {
    const place = {
      container: view.container,
      entry: member.path,
      release,
      bytes: member.bytes,
    };
    let bytes: Uint8Array;
    try {
      bytes = await view.zip.read(member.path, budget, signal);
    } catch (cause) {
      const problem = failure(cause);
      collected.unread += 1;
      if (problem.reason === "budget") collected.budgetHit = true;
      collected.classes.push(
        unreadableSummary({ ...place, sha256: null }, problem.message),
      );
      continue;
    }
    const identity = {
      ...place,
      sha256: sha256Hex(bytes),
      bytes: bytes.length,
    };
    const parsed = parseClass(bytes);
    if (parsed === null) {
      collected.classes.push(
        unreadableSummary(
          identity,
          "The member has a .class name but no class file magic and version.",
        ),
      );
      collected.diagnostics.push({
        container: view.container,
        entry: member.path,
        offset: 0,
        message: "A .class member is not a class file.",
      });
      continue;
    }
    const summary = classSummary(parsed, identity);
    collected.classes.push(summary);
    if (parsed.module !== null)
      collected.modules.push(moduleView(parsed.module, parsed, identity));
    for (const problem of parsed.problems.slice(0, 20))
      collected.diagnostics.push({
        container: view.container,
        entry: member.path,
        offset: problem.offset,
        message: problem.message,
      });
    if (parsed.stopped !== null)
      collected.diagnostics.push({
        container: view.container,
        entry: member.path,
        offset: parsed.stopped.offset,
        message: parsed.stopped.message,
      });
  }
};

const readServices = async (
  view: ArchiveView,
  budget: DecodeBudget,
  collected: Collected,
  signal?: AbortSignal,
) => {
  for (const member of view.zip.members) {
    const service = SERVICE_FILE.exec(member.path)?.[1];
    if (service === undefined || member.directory) continue;
    try {
      const parsed = parseServiceFile(
        await view.zip.read(member.path, budget, signal),
      );
      collected.services.push({
        container: view.container,
        entry: member.path,
        service,
        providers: parsed.providers,
        invalid_lines: parsed.invalid,
      });
    } catch (cause) {
      collected.diagnostics.push({
        container: view.container,
        entry: member.path,
        offset: null,
        message: failure(cause).message,
      });
    }
  }
};

const readSignatures = async (
  view: ArchiveView,
  budget: DecodeBudget,
  collected: Collected,
  signal?: AbortSignal,
) => {
  for (const member of view.zip.members) {
    const signer = SIGNATURE_FILE.exec(member.path)?.[1];
    if (signer === undefined || member.directory) continue;
    // The signature block shares the .SF base name; JAR tooling matches it case-insensitively.
    const block = (["RSA", "DSA", "EC"] as const)
      .map((type) => {
        const wanted = `META-INF/${signer}.${type}`.toUpperCase();
        const found = view.zip.members.find(
          (other) => other.path.toUpperCase() === wanted,
        );
        return found === undefined ? null : { type, path: found.path };
      })
      .find((candidate) => candidate !== null);
    try {
      const signature = parseManifest(
        await view.zip.read(member.path, budget, signal),
      );
      collected.signatures.push({
        container: view.container,
        signer,
        signature_file: member.path,
        block_file: block?.path ?? null,
        block_type: block?.type ?? null,
        digest_attributes: signature.main
          .filter((entry) =>
            /-Digest(-Manifest(-Main-Attributes)?)?$/iu.test(entry.name),
          )
          .map((entry) => entry.name),
        entries: signature.sections.length,
      });
    } catch (cause) {
      collected.diagnostics.push({
        container: view.container,
        entry: member.path,
        offset: null,
        message: failure(cause).message,
      });
    }
  }
};

/** Recompute each digest the outer manifest declares; this checks content, not a signature. */
const entryDigests = async (
  view: ArchiveView,
  budget: DecodeBudget,
  signal?: AbortSignal,
): Promise<Report["entry_digests"]> => {
  const sections = view.manifest?.sections ?? [];
  const declared = sections.filter(
    (section) => declaredDigests(section.attributes).length > 0,
  );
  if (declared.length === 0) return null;
  const algorithms = new Set<string>();
  const result = {
    declared: declared.length,
    matched: 0,
    mismatched: [] as string[],
    missing: [] as string[],
    unchecked: 0,
  };
  for (const section of declared) {
    const digests = declaredDigests(section.attributes);
    digests.forEach((digest) => algorithms.add(digest.algorithm));
    const usable = digests.find((digest) => digest.hash !== null);
    if (!view.zip.has(section.name)) {
      if (result.missing.length < MAX_JVM_LISTED)
        result.missing.push(section.name);
      continue;
    }
    if (usable?.hash == null) {
      result.unchecked += 1;
      continue;
    }
    try {
      const bytes = await view.zip.read(section.name, budget, signal);
      if (digestMatches(bytes, usable.hash, usable.value)) result.matched += 1;
      else if (result.mismatched.length < MAX_JVM_LISTED)
        result.mismatched.push(section.name);
    } catch (cause) {
      failure(cause);
      result.unchecked += 1;
    }
  }
  return { algorithms: [...algorithms].sort(), ...result };
};

const androidFacts = async (
  view: ArchiveView,
  budget: DecodeBudget,
  diagnostics: Diagnostic[],
  signal?: AbortSignal,
): Promise<NonNullable<Report["android"]>> => {
  let manifest: NonNullable<Report["android"]>["manifest"] = null;
  if (view.zip.has("AndroidManifest.xml"))
    try {
      manifest = {
        entry: "AndroidManifest.xml",
        ...readAndroidManifest(
          await view.zip.read("AndroidManifest.xml", budget, signal),
        ),
      };
    } catch (cause) {
      manifest = {
        entry: "AndroidManifest.xml",
        package: null,
        min_sdk: null,
        target_sdk: null,
        error: failure(cause).message,
      };
    }
  const nativeLibraries: NonNullable<Report["android"]>["native_libraries"] =
    [];
  let resources = 0;
  let assets = 0;
  const other: string[] = [];
  for (const member of view.zip.members) {
    if (member.directory) continue;
    const native = NATIVE_LIBRARY.exec(member.path);
    if (native !== null) {
      let digest: string | null = null;
      let elf: ReturnType<typeof elfHeader> = null;
      try {
        const bytes = await view.zip.read(member.path, budget, signal);
        digest = sha256Hex(bytes);
        elf = elfHeader(bytes);
      } catch (cause) {
        diagnostics.push({
          container: null,
          entry: member.path,
          offset: null,
          message: failure(cause).message,
        });
      }
      nativeLibraries.push({
        entry: member.path,
        abi: native[1] ?? "",
        name: native[2] ?? "",
        bytes: member.bytes,
        sha256: digest,
        elf,
      });
    } else if (member.path.startsWith("res/")) resources += 1;
    else if (member.path.startsWith("assets/")) assets += 1;
    else if (AAR_PARTS.has(member.path) || member.path.startsWith("prefab/"))
      other.push(member.path);
  }
  return {
    manifest,
    native_libraries: nativeLibraries,
    resources,
    assets,
    other,
  };
};

const coverageOf = (
  source: JvmSource,
  collected: Collected,
  failedJars: number,
  classCount: number,
): FacetCoverage[] => {
  const identify: FacetCoverage = {
    facet: "identify",
    state: "complete",
    examined:
      source.kind === "class"
        ? "class file magic and version"
        : "ZIP members and JAR/AAR layout",
    omitted: null,
    reason: null,
    continuation: null,
  };
  const damaged =
    collected.classes.filter((entry) => entry.decode !== "complete").length -
    collected.unread;
  const omittedParts = [
    ...(collected.unread > 0
      ? [`${String(collected.unread)} class members that could not be read`]
      : []),
    ...(failedJars > 0
      ? [`${String(failedJars)} embedded JARs that could not be opened`]
      : []),
    ...(damaged > 0
      ? [`facts after the damage in ${String(damaged)} classes`]
      : []),
  ];
  const inspect: FacetCoverage =
    omittedParts.length === 0
      ? {
          facet: "inspect",
          state: "complete",
          examined: `the header, members and class-level attributes of ${String(classCount)} classes`,
          omitted: null,
          reason: null,
          continuation: null,
        }
      : {
          facet: "inspect",
          state: "partial",
          examined: `${String(classCount - collected.unread)} of ${String(classCount)} classes`,
          omitted: omittedParts.join("; "),
          reason: collected.budgetHit
            ? "The decompression budget ran out."
            : "Some members are damaged, encrypted or too large.",
          continuation: collected.budgetHit ? "Raise max_decoded_bytes." : null,
        };
  return [
    identify,
    ...(source.kind === "class"
      ? []
      : [
          {
            facet: "inventory" as const,
            state:
              failedJars > 0 ? ("partial" as const) : ("complete" as const),
            examined:
              "every member of the archive and of each JAR it directly contains",
            omitted:
              failedJars > 0 ? `${String(failedJars)} embedded JARs` : null,
            reason:
              failedJars > 0
                ? "They could not be opened as ZIP archives."
                : null,
            continuation: null,
          },
        ]),
    inspect,
    {
      facet: "reconstruct",
      state: "not_requested",
      examined: null,
      omitted: null,
      reason:
        "Classes are reported from their bytecode; decompile_jvm_class reconstructs inferred source for one class.",
      continuation: null,
    },
  ];
};

/** Inventory one class file or JAR/AAR: manifest, services, modules, signatures, variants and a page of classes. */
export const readArtifactReport = async (input: Input): Promise<Report> => {
  const { source, budget, signal } = input;
  const collected: Collected = {
    classes: [],
    modules: [],
    services: [],
    signatures: [],
    diagnostics: [],
    unread: 0,
    budgetHit: false,
  };
  let manifest: Report["manifest"] = null;
  let digests: Report["entry_digests"] = null;
  let android: Report["android"] = null;
  let entries = 1;
  let resources = 0;
  const embeddedJars: Report["embedded_jars"] = [];
  let multiRelease: Report["multi_release"] = {
    declared: false,
    releases: [],
    versioned_classes: 0,
    ignored: false,
  };
  if (source.kind === "class") {
    const parsed = parseClass(source.bytes);
    const place = {
      container: null,
      entry: null,
      release: null,
      sha256: input.artifact.sha256,
      bytes: source.bytes.length,
    };
    if (parsed !== null) {
      collected.classes.push(classSummary(parsed, place));
      if (parsed.module !== null)
        collected.modules.push(moduleView(parsed.module, parsed, place));
      for (const problem of parsed.problems)
        collected.diagnostics.push({
          container: null,
          entry: null,
          offset: problem.offset,
          message: problem.message,
        });
      if (parsed.stopped !== null)
        collected.diagnostics.push({
          container: null,
          entry: null,
          offset: parsed.stopped.offset,
          message: parsed.stopped.message,
        });
    }
  } else {
    const outer = source.outer;
    entries = outer.zip.members.length;
    if (outer.manifest !== null) {
      const main = outer.manifest.main;
      manifest = {
        container: null,
        entry: MANIFEST_ENTRY,
        main: main.map((entry) => ({ ...entry })),
        sections: outer.manifest.sections.length,
        main_class: attribute(main, "Main-Class"),
        automatic_module_name: attribute(main, "Automatic-Module-Name"),
        multi_release: outer.multiRelease,
        created_by: attribute(main, "Created-By"),
      };
      for (const problem of outer.manifest.problems)
        collected.diagnostics.push({
          container: null,
          entry: MANIFEST_ENTRY,
          offset: null,
          message: problem,
        });
    }
    if (outer.manifestError !== null)
      collected.diagnostics.push({
        container: null,
        entry: MANIFEST_ENTRY,
        offset: null,
        message: outer.manifestError,
      });
    for (const duplicate of outer.zip.duplicates)
      collected.diagnostics.push({
        container: null,
        entry: duplicate,
        offset: null,
        message:
          "The archive repeats this member name; only the first occurrence is read.",
      });
    for (const view of viewsOf(source)) {
      await readClasses(view, budget, collected, signal);
      await readServices(view, budget, collected, signal);
      await readSignatures(view, budget, collected, signal);
    }
    digests = await entryDigests(outer, budget, signal);
    const outerClasses = classMembers(outer);
    const releases = [
      ...new Set(
        outerClasses.flatMap((entry) =>
          entry.release === null ? [] : [entry.release],
        ),
      ),
    ].sort((a, b) => a - b);
    const versioned = outerClasses.filter(
      (entry) => entry.release !== null,
    ).length;
    multiRelease = {
      declared: outer.multiRelease,
      releases,
      versioned_classes: versioned,
      ignored: versioned > 0 && !outer.multiRelease,
    };
    for (const jar of source.embedded)
      embeddedJars.push({
        entry: jar.entry,
        bytes: jar.bytes,
        sha256: jar.sha256,
        classes: jar.view === null ? 0 : classMembers(jar.view).length,
        read: jar.view === null ? "failed" : "complete",
        reason: jar.failure?.message ?? null,
      });
    if (source.kind === "aar")
      android = await androidFacts(
        outer,
        budget,
        collected.diagnostics,
        signal,
      );
    resources = outer.zip.members.filter(
      (member) => !member.directory && !member.path.endsWith(".class"),
    ).length;
  }
  const kinds = emptyKinds();
  const versions = new Map<number, { minor: number; classes: number }>();
  for (const summary of collected.classes) {
    if (summary.decode === "failed") continue;
    kinds[summary.kind] += 1;
    const seen = versions.get(summary.version.major);
    versions.set(summary.version.major, {
      minor: summary.version.minor,
      classes: (seen?.classes ?? 0) + 1,
    });
  }
  const classCount = collected.classes.length;
  const page = collected.classes.slice(input.start, input.start + input.limit);
  const next =
    input.start + page.length < classCount ? input.start + page.length : null;
  const failedJars = embeddedJars.filter((jar) => jar.read === "failed").length;
  const limitations = [
    "Nothing was loaded into a JVM: no class was linked, verified or initialized and no dependency was resolved.",
    ...(collected.signatures.length > 0
      ? [
          "Signature files are listed with their declared digests; certificates and signatures were not verified.",
        ]
      : []),
    ...(multiRelease.ignored
      ? [
          "META-INF/versions members exist but the manifest does not declare Multi-Release: true, so a JVM ignores them.",
        ]
      : []),
    ...(source.kind === "class"
      ? []
      : ["JARs inside embedded JARs are not opened."]),
  ];
  return {
    artifact: input.artifact,
    container: {
      kind: source.kind,
      basis: source.basis,
      name_conflict: source.nameConflict,
    },
    manifest,
    services: collected.services,
    modules: collected.modules,
    signatures: collected.signatures,
    entry_digests: digests,
    multi_release: multiRelease,
    embedded_jars: embeddedJars,
    android,
    summary: {
      entries,
      classes: classCount,
      base_classes: collected.classes.filter((entry) => entry.release === null)
        .length,
      versioned_classes: collected.classes.filter(
        (entry) => entry.release !== null,
      ).length,
      resources,
      kinds,
      versions: [...versions.entries()]
        .sort(([a], [b]) => a - b)
        .map(([major, seen]) => ({
          major,
          java: javaRelease(major, seen.minor),
          classes: seen.classes,
        })),
      decoded_bytes: budget.used,
    },
    class_count: classCount,
    page: {
      start: input.start,
      limit: input.limit,
      returned: page.length,
      next,
    },
    classes: page,
    diagnostics: collected.diagnostics.slice(0, MAX_JVM_LISTED),
    coverage: coverageOf(source, collected, failedJars, classCount),
    limitations,
  };
};
