import { createHash } from "node:crypto";
import { parse as parseToml } from "smol-toml";
import { AnalysisResourceConstraintError } from "../domain/analysisErrorCore.js";
import type {
  GenerateSbomInput,
  SbomComponent,
  SbomReport,
} from "../domain/supplyChain/sbom.js";
import { metadataOf } from "../python/wheel.js";
import { attribute, parseManifest } from "../jvm/jarMetadata.js";

export interface SbomSource {
  readonly path: string;
  readonly sha256: string;
}
type Ecosystem = SbomReport["coverage"]["ecosystems"][number];
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;
const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

interface ComponentIdentity {
  name: string | undefined;
  version?: string | undefined;
  group?: string | undefined;
  properties?: Record<string, string>;
  licenses?: readonly string[];
}

const npmPublicIdentity = (identity: ComponentIdentity): boolean => {
  const resolved = identity.properties?.["oopsware:npm:resolved"];
  return (
    identity.properties?.["oopsware:npm:private"] !== "true" &&
    (resolved === undefined ||
      resolved.startsWith("https://registry.npmjs.org/")) &&
    /^(?:@[^/\s]+\/)?[^/\s]+$/u.test(identity.name ?? "") &&
    /^\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/u.test(identity.version ?? "")
  );
};

const packageUrl = (
  ecosystem: Ecosystem,
  identity: ComponentIdentity,
): string | undefined => {
  const { name, version, group, properties } = identity;
  if (name === undefined || version === undefined) return undefined;
  const encode = encodeURIComponent;
  const suffix = `@${encode(version)}`;
  if (ecosystem === "npm" && npmPublicIdentity(identity))
    return `pkg:npm/${name.split("/").map(encode).join("/")}${suffix}`;
  if (ecosystem === "pypi" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name))
    return `pkg:pypi/${encode(name.toLowerCase().replace(/[-_.]+/gu, "-"))}${suffix}`;
  if (
    ecosystem === "maven" &&
    group !== undefined &&
    /^[\w.-]+$/u.test(group) &&
    /^[\w.-]+$/u.test(name) &&
    !version.includes("${")
  )
    return `pkg:maven/${encode(group)}/${encode(name)}${suffix}`;
  if (
    ecosystem === "cargo" &&
    /^[\w-]+$/u.test(name) &&
    [
      "crates.io",
      "registry+https://github.com/rust-lang/crates.io-index",
      "sparse+https://index.crates.io/",
    ].includes(properties?.["oopsware:cargo:source"] ?? "")
  )
    return `pkg:cargo/${encode(name)}${suffix}`;
  if (
    ecosystem === "golang" &&
    /^v\d+\.\d+\.\d+/u.test(version) &&
    !/^[./]|\s/u.test(name)
  )
    return `pkg:golang/${name.split("/").map(encode).join("/")}${suffix}`;
  return undefined;
};

/** Own the output budget before retaining components, edges, declarations or diagnostics. */
export class SbomBuilder {
  readonly components: SbomComponent[] = [];
  readonly dependencies: SbomReport["sbom"]["dependencies"] = [];
  readonly licenses: SbomReport["licenses"] = [];
  readonly limitations: string[] = [];
  readonly ecosystems = new Set<Ecosystem>();
  readonly #byRef = new Map<string, SbomComponent>();
  #outputBytes = 0;

  constructor(readonly input: GenerateSbomInput) {}

  retain(value: unknown): void {
    this.#outputBytes += Buffer.byteLength(JSON.stringify(value));
    if (this.#outputBytes > this.input.max_output_bytes)
      throw new AnalysisResourceConstraintError(
        "generate_sbom",
        "transport",
        "SBOM exceeds max_output_bytes; no truncated SBOM was returned.",
        { maximum_output_bytes: this.input.max_output_bytes },
      );
  }

  limitation(value: string): void {
    if (this.limitations.includes(value)) return;
    this.retain(value);
    this.limitations.push(value);
  }

  add(
    ecosystem: Ecosystem,
    source: SbomSource,
    identity: ComponentIdentity,
  ): string | null {
    this.ecosystems.add(ecosystem);
    if (identity.name === undefined || identity.name.trim() === "") {
      this.limitation(
        `${source.path}: ${ecosystem} metadata has no package name; no identity was invented.`,
      );
      return null;
    }
    if (this.components.length >= this.input.max_components)
      throw new AnalysisResourceConstraintError(
        "generate_sbom",
        "capacity",
        "SBOM exceeds max_components; no truncated SBOM was returned.",
        { maximum_components: this.input.max_components },
      );
    const ref = `component-${this.components.length + 1}`;
    const properties = {
      "oopsware:ecosystem": ecosystem,
      "oopsware:source:path": source.path,
      "oopsware:source:sha256": source.sha256,
      "oopsware:source:hash_scope":
        "metadata source bytes; not a package-content digest",
      "oopsware:version:status":
        identity.version === undefined ? "unknown" : "declared",
      "oopsware:dependencies:coverage": "unknown",
      ...identity.properties,
    };
    const component: SbomComponent = {
      type: "library",
      "bom-ref": ref,
      name: identity.name,
      ...(identity.version === undefined ? {} : { version: identity.version }),
      ...(identity.group === undefined ? {} : { group: identity.group }),
      properties: Object.entries(properties).map(([name, value]) => ({
        name,
        value,
      })),
      ...(identity.licenses?.length
        ? { licenses: identity.licenses.map((name) => ({ license: { name } })) }
        : {}),
    };
    const purl = packageUrl(ecosystem, identity);
    if (purl !== undefined) component.purl = purl;
    this.retain(component);
    this.components.push(component);
    this.#byRef.set(ref, component);
    for (const value of identity.licenses ?? []) {
      const finding = {
        source: source.path,
        sha256: source.sha256,
        component_ref: ref,
        evidence_kind: "declared" as const,
        value,
        matched_license: null,
      };
      this.retain(finding);
      this.licenses.push(finding);
    }
    return ref;
  }

  edges(ref: string, dependsOn: string[]): void {
    // No empty list: an unrecorded dependency list must not claim a leaf.
    if (dependsOn.length === 0) return;
    const edge = { ref, dependsOn: [...new Set(dependsOn)] };
    this.retain(edge);
    this.dependencies.push(edge);
    const coverage = this.#byRef
      .get(ref)
      ?.properties.find(
        (property) => property.name === "oopsware:dependencies:coverage",
      );
    if (coverage !== undefined) coverage.value = "partial";
  }
}

const npmLicenses = (pkg: Record<string, unknown>): string[] => {
  const license = text(pkg.license) ?? text(record(pkg.license).type);
  if (license !== undefined) return [license];
  return Array.isArray(pkg.licenses)
    ? pkg.licenses.flatMap((value) => text(record(value).type) ?? [])
    : [];
};

const npmRequirements = (
  pkg: Record<string, unknown>,
): Record<string, string> => {
  const output: Record<string, string> = {};
  if (pkg.private === true) output["oopsware:npm:private"] = "true";
  for (const kind of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ])
    if (pkg[kind] !== undefined)
      output[`oopsware:npm:${kind}`] = JSON.stringify(pkg[kind]);
  return output;
};

const npmEdges = (
  builder: SbomBuilder,
  packages: Record<string, unknown>,
  refs: Map<string, string>,
): void => {
  for (const [path, value] of Object.entries(packages)) {
    const from = refs.get(path);
    if (from === undefined) continue;
    const pkg = record(value);
    const deps = {
      ...record(pkg.dependencies),
      ...record(pkg.optionalDependencies),
    };
    const edges: string[] = [];
    for (const name of Object.keys(deps)) {
      if (!/^(?:@[^/]+\/)?[^/]+$/u.test(name)) continue;
      let current = path;
      for (;;) {
        const found = refs.get(
          `${current === "" ? "" : `${current}/`}node_modules/${name}`,
        );
        if (found !== undefined) {
          edges.push(found);
          break;
        }
        if (current === "") break;
        const slash = current.lastIndexOf("/node_modules/");
        current = slash < 0 ? "" : current.slice(0, slash);
      }
    }
    builder.edges(from, edges);
  }
};

/** npm lock v2/v3 install paths are occurrences, not proof that those packages are installed. */
export const npmMetadata = (
  builder: SbomBuilder,
  source: SbomSource,
  bytes: Buffer,
  lock: boolean,
): void => {
  const document = record(JSON.parse(bytes.toString("utf8")) as unknown);
  if (!lock) {
    builder.add("npm", source, {
      name: text(document.name),
      version: text(document.version),
      licenses: npmLicenses(document),
      properties: npmRequirements(document),
    });
    builder.limitation(
      "package.json dependency values are unresolved requirements, retained as properties; they do not establish installed versions or dependency edges.",
    );
    return;
  }
  if (document.lockfileVersion !== 2 && document.lockfileVersion !== 3) {
    builder.limitation(
      `${source.path}: only npm lockfileVersion 2 and 3 package tables are supported; dependency coverage is unknown.`,
    );
    return;
  }
  const packages = record(document.packages);
  const refs = new Map<string, string>();
  for (const [path, value] of Object.entries(packages)) {
    const pkg = record(value);
    if (pkg.link === true) {
      builder.limitation(
        `${source.path}: linked package ${path} was not followed.`,
      );
      continue;
    }
    const pathName = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/u.exec(
      path,
    )?.[1];
    const name =
      text(pkg.name) ?? (path === "" ? text(document.name) : pathName);
    const ref = builder.add("npm", source, {
      name,
      version: text(pkg.version),
      licenses: npmLicenses(pkg),
      properties: {
        ...npmRequirements(pkg),
        "oopsware:npm:install_path": path,
        "oopsware:identity:basis":
          text(pkg.name) === undefined && path !== ""
            ? "lockfile install path"
            : "declared name",
        ...(text(pkg.resolved) === undefined
          ? {}
          : { "oopsware:npm:resolved": String(pkg.resolved) }),
        ...(text(pkg.integrity) === undefined
          ? {}
          : { "oopsware:npm:declared_integrity": String(pkg.integrity) }),
      },
    });
    if (ref !== null) refs.set(path, ref);
  }
  npmEdges(builder, packages, refs);
  builder.limitation(
    "npm edges cover resolvable dependencies/optionalDependencies in the lockfile package table. Peer, development, workspace and missing dependency relationships remain unknown; integrity strings are declarations, not verified package hashes.",
  );
};

export const wheelMetadata = (
  builder: SbomBuilder,
  source: SbomSource,
  bytes: Uint8Array,
): void => {
  const metadata = metadataOf(bytes);
  builder.add("pypi", source, {
    name: metadata.name ?? undefined,
    version: metadata.version ?? undefined,
    licenses: [metadata.license_expression, metadata.license].filter(
      (value): value is string => value !== null && value.trim() !== "",
    ),
    properties: {
      "oopsware:pypi:requires_dist": JSON.stringify(metadata.requires_dist),
      "oopsware:pypi:license_files": JSON.stringify(metadata.license_files),
      "oopsware:pypi:classifiers": JSON.stringify(metadata.classifiers),
    },
  });
  builder.limitation(
    "Wheel Requires-Dist entries are declarations with markers/ranges; installed dependency versions and relationships are unknown.",
  );
};

export const cargoMetadata = (
  builder: SbomBuilder,
  source: SbomSource,
  bytes: Buffer,
): void => {
  const document = parseToml(bytes.toString("utf8"), {
    integersAsBigInt: true,
    unsafeKeyBehaviour: "keep",
  });
  if (!Array.isArray(document.package)) {
    builder.limitation(`${source.path}: Cargo.lock has no package table.`);
    return;
  }
  const packages = document.package.map(record);
  const refs = packages.map((pkg) =>
    builder.add("cargo", source, {
      name: text(pkg.name),
      version: text(pkg.version),
      properties: {
        "oopsware:cargo:source": text(pkg.source) ?? "unknown",
        "oopsware:cargo:declared_checksum": text(pkg.checksum) ?? "unknown",
        "oopsware:cargo:dependencies": JSON.stringify(pkg.dependencies ?? null),
      },
    }),
  );
  const byName = new Map<string, number[]>();
  packages.forEach((pkg, index) => {
    const name = text(pkg.name);
    if (name !== undefined)
      byName.set(name, [...(byName.get(name) ?? []), index]);
  });
  packages.forEach((pkg, index) => {
    const from = refs[index];
    if (from === null || from === undefined || !Array.isArray(pkg.dependencies))
      return;
    const edges: string[] = [];
    for (const value of pkg.dependencies) {
      if (typeof value !== "string") continue;
      const match = /^(\S+)(?: (\S+))?(?: \((.+)\))?$/u.exec(value);
      if (match === null) continue;
      const candidates = (byName.get(match[1] ?? "") ?? []).flatMap((at) => {
        const candidate = packages[at];
        return candidate !== undefined &&
          (match[2] === undefined || candidate.version === match[2]) &&
          (match[3] === undefined || candidate.source === match[3]) &&
          refs[at] != null
          ? [refs[at] as string]
          : [];
      });
      if (candidates.length === 1) edges.push(candidates[0] as string);
    }
    builder.edges(from, edges);
  });
  builder.limitation(
    "Cargo.lock records locked packages; target/feature selection, actual inclusion and licenses are unknown. Declared checksums were not verified against downloaded crates.",
  );
};

/** A Maven producer's pom.properties uses simple ISO-8859-1 Java properties; complex syntax is refused. */
export const mavenProperties = (
  builder: SbomBuilder,
  source: SbomSource,
  bytes: Buffer,
): void => {
  const lines = bytes
    .toString("latin1")
    .split(/\r\n|\r|\n/u)
    .filter((line) => !/^\s*[#!]/u.test(line) && line.trim() !== "");
  if (
    lines.some(
      (line) => line.includes("\\") || !/^\s*[^:=\s]+\s*[:=]/u.test(line),
    )
  ) {
    builder.limitation(
      `${source.path}: escaped, continued or nonstandard Maven properties are not interpreted; identity remains unknown.`,
    );
    return;
  }
  const fields = new Map(
    lines.map((line) => {
      const at = line.search(/[:=]/u);
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
    }),
  );
  builder.add("maven", source, {
    name: text(fields.get("artifactId")),
    group: text(fields.get("groupId")),
    version: text(fields.get("version")),
  });
  builder.limitation(
    "Maven pom.properties identifies embedded packages only; POM interpolation, parent inheritance, profiles and dependencies are not evaluated.",
  );
};

export const jarManifest = (
  builder: SbomBuilder,
  source: SbomSource,
  bytes: Uint8Array,
): void => {
  const manifest = parseManifest(bytes);
  for (const problem of manifest.problems)
    builder.limitation(`${source.path}: ${problem}`);
  const name =
    attribute(manifest.main, "Bundle-SymbolicName")?.split(";")[0]?.trim() ??
    attribute(manifest.main, "Implementation-Title");
  if (name === undefined || name === null || name === "") return;
  const version =
    attribute(manifest.main, "Bundle-Version") ??
    attribute(manifest.main, "Implementation-Version");
  const license = attribute(manifest.main, "Bundle-License");
  builder.add("maven", source, {
    name,
    version: version ?? undefined,
    licenses: license ? [license] : [],
    properties: {
      "oopsware:identity:basis":
        "JAR manifest title or bundle identity; Maven coordinates unknown",
    },
  });
};

export const sourceOf = (path: string, bytes: Uint8Array): SbomSource => ({
  path,
  sha256: createHash("sha256").update(bytes).digest("hex"),
});
