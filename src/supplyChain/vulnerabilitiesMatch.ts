import { compare, valid } from "semver";
import { z } from "zod";
import type {
  VulnerabilityComponent,
  VulnerabilityReport,
} from "../domain/supplyChain/vulnerabilities.js";
import type { OsvRecord } from "./vulnerabilitiesSnapshot.js";
import {
  VULNERABILITY_LIMITS,
  vulnerabilityFailure,
} from "./vulnerabilitiesSnapshot.js";

const componentSchema = z.object({
  "bom-ref": z.string().max(16_384).optional(),
  name: z.string().max(16_384),
  version: z.string().max(16_384).optional(),
  purl: z.string().max(16_384).optional(),
  components: z.array(z.unknown()).optional(),
});
const sbomSchema = z.object({
  bomFormat: z.literal("CycloneDX"),
  specVersion: z.literal("1.6"),
  components: z.array(z.unknown()).default([]),
  metadata: z.object({ component: z.unknown().optional() }).optional(),
});
const ecosystems = {
  npm: "npm",
  pypi: "PyPI",
  maven: "Maven",
  golang: "Go",
  cargo: "crates.io",
} as const;
export const osvPackageKey = (ecosystem: string, name: string) =>
  JSON.stringify([
    ecosystem,
    ecosystem === "PyPI" ? name.toLowerCase().replace(/[-_.]+/gu, "-") : name,
  ]);

const validNamespace = (type: keyof typeof ecosystems, parts: string[]) => {
  if (type === "npm")
    return (
      parts.length === 1 || (parts.length === 2 && /^@[^@]+$/u.test(parts[0]!))
    );
  if (type === "maven") return parts.length === 2;
  if (type === "pypi" || type === "cargo") return parts.length === 1;
  return true;
};

const identity = (
  purl: string | undefined,
  version: string | undefined,
): {
  reason?: string;
  ecosystem?: VulnerabilityComponent["ecosystem"];
  package_name?: string;
  version?: string | null;
} => {
  if (!purl)
    return {
      reason:
        "Missing package URL; component names alone do not establish package identity",
    };
  if (purl.includes("?") || purl.includes("#"))
    return {
      reason:
        "Package URL qualifiers or subpaths require identity rules this checker does not establish",
    };
  const match = /^pkg:([a-z]+)\/([^?#]+)(?:\?[^#]*)?(?:#.*)?$/u.exec(purl);
  if (!match || !Object.hasOwn(ecosystems, match[1]!))
    return { reason: "Unsupported or invalid package URL" };
  const type = match[1]! as keyof typeof ecosystems;
  let encoded = match[2]!;
  const separator = encoded.lastIndexOf("@");
  let purlVersion: string | undefined;
  try {
    if (separator > encoded.lastIndexOf("/")) {
      purlVersion = decodeURIComponent(encoded.slice(separator + 1));
      encoded = encoded.slice(0, separator);
    }
    const parts = encoded.split("/").map((part) => decodeURIComponent(part));
    if (
      parts.some(
        (part) =>
          !part ||
          part.includes("/") ||
          [...part].some((char) => char.charCodeAt(0) < 32),
      )
    )
      return { reason: "Invalid package URL name" };
    if (!validNamespace(type, parts))
      return { reason: "Invalid package URL namespace" };
    if (
      purlVersion !== undefined &&
      version !== undefined &&
      purlVersion !== version
    )
      return {
        reason: "Component version conflicts with its package URL version",
      };
    const selectedVersion = purlVersion ?? version;
    const packageName = parts.join(type === "maven" ? ":" : "/");
    return {
      ecosystem: ecosystems[type],
      package_name: packageName,
      version: selectedVersion ?? null,
      ...(selectedVersion
        ? {}
        : { reason: "No exact package version is recorded" }),
    };
  } catch {
    return { reason: "Invalid percent encoding in package URL" };
  }
};

const unwrapSbom = (value: unknown) => {
  let candidate = value;
  if (
    typeof candidate === "object" &&
    candidate !== null &&
    "normalized_result" in candidate
  ) {
    const envelope = z
      .object({
        operation: z.literal("generate_sbom"),
        normalized_result: z.object({ sbom: z.unknown() }),
      })
      .safeParse(candidate);
    if (!envelope.success)
      throw vulnerabilityFailure(
        "format",
        "Expected generate_sbom Evidence with normalized_result.sbom",
      );
    candidate = envelope.data.normalized_result.sbom;
  }
  return candidate;
};

export const readVulnerabilityComponents = (value: unknown) => {
  const candidate = unwrapSbom(value);
  const parsed = sbomSchema.safeParse(candidate);
  if (!parsed.success)
    throw vulnerabilityFailure("format", "Expected a CycloneDX 1.6 JSON SBOM");
  const pending = [...parsed.data.components];
  if (parsed.data.metadata?.component !== undefined)
    pending.unshift(parsed.data.metadata.component);
  const components: { component: VulnerabilityComponent; reason?: string }[] =
    [];
  const refs = new Set<string>();
  for (let index = 0; index < pending.length; index++) {
    if (pending.length > VULNERABILITY_LIMITS.components)
      throw vulnerabilityFailure("limit", "SBOM exceeds the component limit");
    const result = componentSchema.safeParse(pending[index]);
    if (!result.success)
      throw vulnerabilityFailure("format", "Invalid CycloneDX component");
    const item = result.data;
    if (
      pending.length + (item.components?.length ?? 0) >
      VULNERABILITY_LIMITS.components
    )
      throw vulnerabilityFailure("limit", "SBOM exceeds the component limit");
    pending.push(...(item.components ?? []));
    const ref = item["bom-ref"] ?? `component-index:${index}`;
    if (refs.has(ref))
      throw vulnerabilityFailure(
        "format",
        "Duplicate CycloneDX component reference",
      );
    refs.add(ref);
    const identified = identity(item.purl, item.version);
    components.push({
      component: {
        bom_ref: ref,
        name: item.name,
        version: identified.version ?? item.version ?? null,
        purl: item.purl ?? null,
        ecosystem: identified.ecosystem ?? null,
        package_name: identified.package_name ?? null,
      },
      ...(identified.reason ? { reason: identified.reason } : {}),
    });
  }
  return components;
};

const rangeSchema = z.object({
  type: z.string(),
  events: z.array(z.record(z.string(), z.string())).min(1).max(10_000),
});
type Evidence = VulnerabilityReport["findings"][number]["evidence"][number];
const semverValue = (value: string) => {
  if (
    !/^(?:v)?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(
      value,
    )
  )
    return null;
  return valid(value);
};

const matchRange = (
  raw: unknown,
  version: string,
  ecosystem: string,
): {
  matched?: boolean;
  reason?: string;
  range?: z.infer<typeof rangeSchema>;
} => {
  const parsed = rangeSchema.safeParse(raw);
  if (!parsed.success) return { reason: "Malformed OSV range" };
  const range = parsed.data;
  if (range.type === "GIT")
    return {
      reason:
        "GIT ranges require commit ancestry, which this offline checker does not establish",
    };
  if (range.type !== "SEMVER" && range.type !== "ECOSYSTEM")
    return { reason: `Unsupported OSV range type: ${range.type}` };
  if (
    range.type === "ECOSYSTEM" &&
    !["npm", "crates.io", "Go"].includes(ecosystem)
  )
    return {
      reason: `${ecosystem} ECOSYSTEM version ordering is not supported; exact OSV versions are checked`,
    };
  const current = semverValue(version);
  if (!current)
    return {
      reason: "Package version cannot be compared with this semantic range",
    };
  const result = matchEvents(range.events, current);
  return { ...result, range };
};

const decodeEvent = (event: Record<string, string>, index: number) => {
  const entries = Object.entries(event);
  const [kind, rawVersion] = entries[0] ?? [];
  if (
    entries.length !== 1 ||
    !kind ||
    !rawVersion ||
    !["introduced", "fixed", "last_affected", "limit"].includes(kind)
  )
    return { reason: "Malformed OSV range event" };
  const zero = kind === "introduced" && rawVersion === "0";
  const boundary = zero ? null : semverValue(rawVersion);
  if ((!zero && boundary === null) || (zero && index !== 0))
    return { reason: "Invalid version in OSV range event" };
  return { kind, boundary };
};
const inInterval = (
  current: string,
  introduced: string | null,
  boundary: string,
  kind: string,
) =>
  (introduced === null || compare(current, introduced) >= 0) &&
  (compare(current, boundary) < 0 ||
    (kind === "last_affected" && compare(current, boundary) === 0));
const matchEvents = (
  events: Record<string, string>[],
  current: string,
): { matched?: boolean; reason?: string } => {
  let open = false;
  let introduced: string | null = null;
  let previous: string | null = null;
  let matched = false;
  for (const [index, event] of events.entries()) {
    const decoded = decodeEvent(event, index);
    if (decoded.reason !== undefined) return { reason: decoded.reason };
    const { kind, boundary } = decoded;
    if (
      previous !== null &&
      boundary !== null &&
      compare(boundary, previous) < 0
    )
      return { reason: "OSV range events are out of order" };
    if (kind === "introduced") {
      if (open)
        return { reason: "OSV range has consecutive introduced events" };
      introduced = boundary;
      open = true;
    } else {
      if (!open)
        return { reason: "OSV range closes without an introduced event" };
      if (
        introduced !== null &&
        compare(boundary!, introduced) === 0 &&
        kind !== "last_affected"
      )
        return { reason: "OSV range is empty or inverted" };
      matched ||= inInterval(current, introduced, boundary!, kind);
      open = false;
    }
    previous = boundary;
  }
  matched ||=
    open && (introduced === null || compare(current, introduced) >= 0);
  return { matched };
};
const listedVersion = (
  versions: string[] | undefined,
  component: VulnerabilityComponent,
) => {
  const matched = versions?.some(
    (version) =>
      version === component.version ||
      (component.ecosystem === "Go" &&
        semverValue(version) !== null &&
        semverValue(version) === semverValue(component.version!)),
  );
  if (matched || !versions?.length) return { matched };
  if (["PyPI", "Maven"].includes(component.ecosystem!))
    return {
      matched,
      reason: `${component.ecosystem} version normalization is not supported; no exact listed version matched`,
    };
  if (
    semverValue(component.version!) === null ||
    versions.some((version) => semverValue(version) === null)
  )
    return {
      matched,
      reason:
        "Unsupported version spelling prevents excluding a listed version",
    };
  return { matched };
};

export const matchVulnerability = (
  record: OsvRecord,
  component: VulnerabilityComponent,
) => {
  const evidence: Evidence[] = [];
  const reasons = new Set<string>();
  for (const [affectedIndex, affected] of record.affected.entries()) {
    if (
      !affected.package ||
      !component.ecosystem ||
      !component.package_name ||
      !component.version ||
      osvPackageKey(affected.package.ecosystem, affected.package.name) !==
        osvPackageKey(component.ecosystem, component.package_name)
    )
      continue;
    const listed = listedVersion(affected.versions, component);
    if (listed.matched)
      evidence.push({
        affected_index: affectedIndex,
        basis: "explicit-version",
        version: component.version,
        range_index: null,
        range_type: null,
        events: [],
      });
    if (listed.reason) reasons.add(listed.reason);
    if (!affected.versions?.length && !affected.ranges?.length)
      reasons.add("Matching OSV package has no affected versions or ranges");
    for (const [rangeIndex, range] of (affected.ranges ?? []).entries()) {
      const match = matchRange(range, component.version, component.ecosystem);
      if (match.reason) reasons.add(match.reason);
      if (match.matched && match.range)
        evidence.push({
          affected_index: affectedIndex,
          basis: "range",
          version: component.version,
          range_index: rangeIndex,
          range_type: match.range.type,
          events: match.range.events,
        });
    }
  }
  return { evidence, reasons: [...reasons] };
};
