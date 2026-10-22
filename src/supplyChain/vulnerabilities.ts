import { setImmediate } from "node:timers/promises";
import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { ArtifactOperationError } from "../domain/artifactOperationError.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  checkVulnerabilitiesInputSchema,
  vulnerabilityReportSchema,
  type CheckVulnerabilitiesInput,
  type VulnerabilityReport,
  type VulnerabilityComponent,
} from "../domain/supplyChain/vulnerabilities.js";
import {
  NonRegularFileReadError,
  RegularFileChangedError,
} from "../filesystem/RegularFile.js";
import { regularFileCancellation } from "../filesystem/OwnedRegularFile.js";
import { RegularFileCapacityError } from "../filesystem/readStableFileBytes.js";
import {
  matchVulnerability,
  osvPackageKey,
  readVulnerabilityComponents,
} from "./vulnerabilitiesMatch.js";
import {
  checkVulnerabilityCancellation,
  parseVulnerabilityJson,
  readVulnerabilityFile,
  readVulnerabilitySnapshot,
  VULNERABILITY_LIMITS,
  vulnerabilityFailure,
  type SnapshotRecord,
} from "./vulnerabilitiesSnapshot.js";

const assertReportSize = (value: unknown): void => {
  let bytes = 0;
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) {
      bytes += 2 + item.length;
      for (const child of item) visit(child);
    } else if (item !== null && typeof item === "object") {
      bytes += 2;
      for (const [key, child] of Object.entries(item)) {
        bytes += Buffer.byteLength(JSON.stringify(key)) + 2;
        visit(child);
      }
    } else bytes += Buffer.byteLength(JSON.stringify(item));
    if (bytes > VULNERABILITY_LIMITS.outputBytes)
      throw vulnerabilityFailure("limit", "Vulnerability report exceeds 8 MiB");
  };
  visit(value);
};

type Snapshot = Awaited<ReturnType<typeof readVulnerabilitySnapshot>>;
type Candidate = { item: SnapshotRecord; cost: number };
type WorkBudget = { used: number };
const chargeWork = (budget: WorkBudget, cost: number) => {
  budget.used += cost;
  if (budget.used > VULNERABILITY_LIMITS.comparisons)
    throw vulnerabilityFailure(
      "limit",
      "Vulnerability matching exceeds its work budget",
    );
};
const recordCost = (item: SnapshotRecord) => {
  let cost = 1;
  for (const affected of item.record.affected) {
    cost += 1 + (affected.versions?.length ?? 0);
    for (const range of affected.ranges ?? []) {
      cost += 1;
      if (
        typeof range === "object" &&
        range !== null &&
        "events" in range &&
        Array.isArray(range.events)
      )
        cost += range.events.length;
    }
  }
  return cost;
};
const indexSnapshot = async (
  snapshot: Snapshot,
  budget: WorkBudget,
  signal?: AbortSignal,
) => {
  const byPackage = new Map<string, Candidate[]>();
  let withdrawn = 0;
  for (const [index, item] of snapshot.records.entries()) {
    if (index % 128 === 0) {
      await setImmediate();
      checkVulnerabilityCancellation(signal);
    }
    if (item.record.withdrawn !== undefined) {
      withdrawn++;
      continue;
    }
    const cost = recordCost(item);
    chargeWork(budget, cost);
    const keys = new Set(
      item.record.affected.flatMap((affected) =>
        affected.package
          ? [osvPackageKey(affected.package.ecosystem, affected.package.name)]
          : [],
      ),
    );
    for (const key of keys) {
      const candidates = byPackage.get(key) ?? [];
      candidates.push({ item, cost });
      byPackage.set(key, candidates);
    }
  }
  return { byPackage, withdrawn };
};
const checkComponent = (
  component: VulnerabilityComponent,
  candidates: Candidate[],
  budget: WorkBudget,
) => {
  const findings: VulnerabilityReport["findings"] = [];
  const reasons = new Set<string>();
  const unknownIds = new Set<string>();
  for (const { item, cost } of candidates) {
    chargeWork(budget, cost);
    const match = matchVulnerability(item.record, component);
    for (const reason of match.reasons) {
      reasons.add(reason);
      unknownIds.add(item.record.id);
    }
    if (match.evidence.length)
      findings.push({
        component,
        id: item.record.id,
        aliases: item.record.aliases ?? [],
        summary: item.record.summary ?? null,
        modified: item.record.modified,
        published: item.record.published ?? null,
        severity: item.record.severity ?? [],
        references: item.record.references ?? [],
        source: item.source,
        evidence: match.evidence,
      });
    if (findings.length > VULNERABILITY_LIMITS.findings)
      throw vulnerabilityFailure(
        "limit",
        "Vulnerability findings exceed the output limit",
      );
  }
  return { findings, reasons: [...reasons], advisory_ids: [...unknownIds] };
};
const assessComponents = async (
  components: ReturnType<typeof readVulnerabilityComponents>,
  byPackage: Map<string, Candidate[]>,
  budget: WorkBudget,
  signal?: AbortSignal,
) => {
  const findings: VulnerabilityReport["findings"] = [];
  const unmatched: VulnerabilityReport["unmatched_components"] = [];
  const unassessed: VulnerabilityReport["unassessed_components"] = [];
  for (const { component, reason } of components) {
    await setImmediate();
    checkVulnerabilityCancellation(signal);
    if (
      reason ||
      !component.ecosystem ||
      !component.package_name ||
      !component.version
    ) {
      unassessed.push({
        component,
        advisory_ids: [],
        reasons: [reason ?? "Package identity or version is unknown"],
      });
      continue;
    }
    const candidates =
      byPackage.get(
        osvPackageKey(component.ecosystem, component.package_name),
      ) ?? [];
    const match = checkComponent(component, candidates, budget);
    findings.push(...match.findings);
    if (findings.length > VULNERABILITY_LIMITS.findings)
      throw vulnerabilityFailure(
        "limit",
        "Vulnerability findings exceed the output limit",
      );
    if (match.reasons.length)
      unassessed.push({
        component,
        advisory_ids: match.advisory_ids,
        reasons: match.reasons,
      });
    if (!match.findings.length && !match.reasons.length)
      unmatched.push({
        component,
        advisory_ids: candidates.map(({ item }) => item.record.id),
        reasons: [
          candidates.length
            ? "No affected version matched in the supplied snapshot; this is not a safety verdict"
            : "No active advisory for this package occurs in the supplied snapshot; coverage is unknown",
        ],
      });
  }
  return {
    findings,
    unmatched_components: unmatched,
    unassessed_components: unassessed,
  };
};
const databaseReport = (
  snapshot: Snapshot,
  withdrawn: number,
): VulnerabilityReport["database"] => {
  const ageDays =
    snapshot.generatedAt === null
      ? null
      : Math.floor(
          (Date.now() - Date.parse(snapshot.generatedAt)) / 86_400_000,
        );
  const staleAfterDays = 30;
  const freshness =
    ageDays === null
      ? "undated"
      : ageDays < 0
        ? "future-dated"
        : ageDays > staleAfterDays
          ? "stale"
          : "dated";
  return {
    path: snapshot.path,
    sha256: snapshot.sha256,
    bytes: snapshot.bytes,
    files: snapshot.files,
    digest_basis: snapshot.digest_basis,
    records: snapshot.records.length,
    withdrawn_records: withdrawn,
    generated_at: snapshot.generatedAt,
    age_days: ageDays,
    freshness,
    stale_after_days: staleAfterDays,
    coverage: "unknown",
    coverage_detail:
      "Only the supplied records were checked; their completeness and authenticity were not established",
  };
};
const limitations = (database: VulnerabilityReport["database"]) => [
  "Offline comparison only against the supplied OSV dataset; no network request, update, or claim that unmatched packages are safe",
  "Package URLs and versions are SBOM declarations; installed or running package identity was not verified",
  "Snapshot completeness and authenticity are unknown; a digest identifies bytes, not trust",
  "Snapshot directories include JSON files only; the digest commits the selected JSON files and any root manifest.json",
  "Snapshot age uses only a supplied generated_at timestamp, never advisory modification dates; stale means older than the local 30-day reporting threshold",
  "Exact OSV versions are compared for npm, PyPI, Maven, Go, and crates.io; ECOSYSTEM ranges are supported only for npm, Go, and crates.io; explicit SEMVER ranges require valid semantic versions",
  "GIT ranges require commit ancestry and remain unassessed; withdrawn records are excluded",
  ...(database.freshness === "undated"
    ? ["The snapshot is undated; its age is unknown"]
    : database.freshness === "stale"
      ? ["The supplied snapshot is stale under the stated reporting threshold"]
      : database.freshness === "future-dated"
        ? [
            "The supplied snapshot date is in the future and cannot establish freshness",
          ]
        : []),
  ...(database.records === 0
    ? ["The supplied snapshot contains no records"]
    : []),
];
const translateFailure = (
  cause: unknown,
  signal?: AbortSignal,
): AnalysisError => {
  if (cause instanceof AnalysisError) return cause;
  if (signal?.aborted || regularFileCancellation(cause))
    return vulnerabilityFailure("cancelled", "Vulnerability check cancelled");
  if (cause instanceof RegularFileCapacityError)
    return vulnerabilityFailure("limit", cause.message);
  if (cause instanceof RegularFileChangedError)
    return vulnerabilityFailure(
      "integrity",
      "File identity changed while reading",
    );
  if (cause instanceof NonRegularFileReadError)
    return vulnerabilityFailure("path", "Expected a regular local file");
  const code =
    cause instanceof Error && "code" in cause ? cause.code : undefined;
  return new ArtifactOperationError(
    "check_vulnerabilities",
    code === "ENOENT" || code === "ELOOP" ? "path" : "io",
    undefined,
    code === "ENOENT"
      ? "Selected SBOM or OSV snapshot does not exist"
      : "Unable to read the selected local SBOM or OSV snapshot",
    { cause },
  );
};
export const checkVulnerabilities = async (
  input: CheckVulnerabilitiesInput,
  options?: ExecutionOptions,
): Promise<Result<VulnerabilityReport, AnalysisError>> => {
  try {
    const parsed = checkVulnerabilitiesInputSchema.safeParse(input);
    if (!parsed.success)
      throw vulnerabilityFailure(
        "format",
        "Expected explicit local SBOM and OSV snapshot paths",
      );
    const signal = options?.signal;
    const artifact = await readVulnerabilityFile(
      parsed.data.path,
      VULNERABILITY_LIMITS.inputBytes,
      signal,
    );
    const components = readVulnerabilityComponents(
      parseVulnerabilityJson(artifact.bytes),
    );
    const snapshot = await readVulnerabilitySnapshot(
      parsed.data.database,
      signal,
    );
    const budget = { used: 0 };
    const index = await indexSnapshot(snapshot, budget, signal);
    const assessment = await assessComponents(
      components,
      index.byPackage,
      budget,
      signal,
    );
    const current = await readVulnerabilityFile(
      parsed.data.path,
      VULNERABILITY_LIMITS.inputBytes,
      signal,
    );
    if (current.path !== artifact.path || current.sha256 !== artifact.sha256)
      throw vulnerabilityFailure(
        "integrity",
        "SBOM changed during vulnerability checking",
      );
    await snapshot.verify();
    checkVulnerabilityCancellation(signal);
    const database = databaseReport(snapshot, index.withdrawn);
    const report: VulnerabilityReport = {
      artifact: {
        path: artifact.path,
        sha256: artifact.sha256,
        bytes: artifact.bytes.length,
      },
      database,
      ...assessment,
      summary: {
        components: components.length,
        findings: assessment.findings.length,
        affected_components: new Set(
          assessment.findings.map((finding) => finding.component.bom_ref),
        ).size,
        unmatched_components: assessment.unmatched_components.length,
        unassessed_components: assessment.unassessed_components.length,
      },
      limitations: limitations(database),
    };
    assertReportSize(report);
    return ok(vulnerabilityReportSchema.parse(report));
  } catch (cause) {
    return err(translateFailure(cause, options?.signal));
  }
};
