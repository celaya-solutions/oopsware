import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeTestWorkspace } from "../../tests/support/workspace/workspaceFixture.js";
import {
  checkVulnerabilitiesInputSchema,
  vulnerabilityReportSchema,
} from "../domain/supplyChain/vulnerabilities.js";
import { checkVulnerabilities } from "./vulnerabilities.js";
import { generateSbom } from "./sbom.js";
import { generateSbomInputSchema } from "../domain/supplyChain/sbom.js";
import { readVulnerabilityComponents } from "./vulnerabilitiesMatch.js";
import {
  readVulnerabilitySnapshot,
  VULNERABILITY_LIMITS,
} from "./vulnerabilitiesSnapshot.js";

const modified = "2025-01-01T00:00:00Z";
const advisory = (affected: unknown, extra: Record<string, unknown> = {}) => ({
  schema_version: "1.7.3",
  id: "OSV-TEST-1",
  modified,
  summary: "Schema-shaped offline test advisory",
  affected: [affected],
  references: [{ type: "WEB", url: "https://example.invalid/advisory" }],
  ...extra,
});
const packageRecord = (
  ranges: unknown[],
  ecosystem = "npm",
  name = "example",
) => ({ package: { ecosystem, name }, ranges });
const component = (version?: string, purl = "pkg:npm/example") => ({
  type: "library",
  "bom-ref": "example-ref",
  name: "Example",
  ...(version ? { version } : {}),
  purl: `${purl}${version ? `@${version}` : ""}`,
});
const sbom = (components: unknown[]) => ({
  bomFormat: "CycloneDX",
  specVersion: "1.6",
  version: 1,
  components,
});
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

let root: string;
let path: string;
let database: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "oopsware-osv-test-")));
  path = join(root, "sbom.json");
  database = join(root, "osv.json");
});
afterEach(async () => {
  await removeTestWorkspace(root);
});
const run = async (
  version: string,
  events: Record<string, string>[],
  type = "SEMVER",
) => {
  await writeFile(path, JSON.stringify(sbom([component(version)])));
  await writeFile(
    database,
    JSON.stringify(advisory(packageRecord([{ type, events }]))),
  );
  const result = await checkVulnerabilities({ path, database });
  if (!result.ok) throw result.error;
  return result.value;
};

it.each([
  ["0.9.9", "fixed", 0],
  ["1.0.0", "fixed", 1],
  ["1.9.9", "fixed", 1],
  ["2.0.0", "fixed", 0],
  ["2.0.0", "last_affected", 1],
  ["2.0.1", "last_affected", 0],
  ["1.9.9", "limit", 1],
  ["2.0.0", "limit", 0],
])(
  "checks introduced/terminal bounds: %s %s",
  async (version, terminal, findings) => {
    const report = await run(version, [
      { introduced: "1.0.0" },
      { [terminal]: "2.0.0" },
    ]);
    expect(report.findings).toHaveLength(findings);
    expect(report.unassessed_components).toHaveLength(0);
    expect(vulnerabilityReportSchema.safeParse(report).success).toBe(true);
    expect(report.database.freshness).toBe("undated");
    expect(report.database.coverage).toBe("unknown");
  },
);

it("includes prereleases by ordering, multiple intervals, and introduced zero", async () => {
  expect(
    (await run("1.0.0-beta.2", [{ introduced: "0" }, { fixed: "1.0.0" }]))
      .findings,
  ).toHaveLength(1);
  expect(
    (
      await run("2.0.0", [
        { introduced: "0" },
        { fixed: "1.0.0" },
        { introduced: "2.0.0" },
      ])
    ).findings,
  ).toHaveLength(1);
  expect(
    (
      await run("1.5.0", [
        { introduced: "0" },
        { fixed: "1.0.0" },
        { introduced: "2.0.0" },
      ])
    ).findings,
  ).toHaveLength(0);
});

it.each([
  [{ fixed: "2.0.0" }],
  [{ introduced: "2.0.0" }, { fixed: "1.0.0" }],
  [{ introduced: "1.0.0" }, { introduced: "2.0.0" }],
  [{ introduced: "not-a-version" }],
  [{ introduced: "0" }, { fixed: "2.0.0", limit: "2.0.0" }],
])("keeps malformed ranges unassessed", async (...events) => {
  const report = await run("1.0.0", events);
  expect(report.unassessed_components).toHaveLength(1);
  expect(report.unmatched_components).toHaveLength(0);
  expect(report.findings).toHaveLength(0);
});

it("records exact-version matches and unsupported ranges independently", async () => {
  await writeFile(
    path,
    JSON.stringify(sbom([component("1.0rc1", "pkg:pypi/Some_Package")])),
  );
  await writeFile(
    database,
    JSON.stringify(
      advisory({
        package: { ecosystem: "PyPI", name: "some-package" },
        versions: ["1.0rc1"],
        ranges: [
          {
            type: "ECOSYSTEM",
            events: [{ introduced: "0" }, { fixed: "2.0" }],
          },
          {
            type: "GIT",
            repo: "https://example.invalid/repo",
            events: [{ introduced: "0" }],
          },
        ],
      }),
    ),
  );
  const result = await checkVulnerabilities({ path, database });
  if (!result.ok) throw result.error;
  expect(result.value.findings[0]?.evidence[0]?.basis).toBe("explicit-version");
  expect(result.value.unassessed_components[0]?.reasons).toHaveLength(2);
  expect(result.value.findings[0]?.source.sha256).toBe(
    digest(await readFile(database)),
  );
});

it("uses exact package coordinates for npm scopes, Maven, Go and crates.io", async () => {
  const declarations = [
    ["pkg:npm/%40scope/library", "npm", "@scope/library", "1.2.3"],
    ["pkg:maven/org.example/library", "Maven", "org.example:library", "1.2"],
    [
      "pkg:golang/example.org/team/module/v2",
      "Go",
      "example.org/team/module/v2",
      "v2.0.0",
    ],
    ["pkg:cargo/library", "crates.io", "library", "1.2.3"],
  ];
  await writeFile(
    path,
    JSON.stringify(
      sbom(
        declarations.map(([purl, , , version], index) => ({
          ...component(version, purl),
          "bom-ref": `ref-${index}`,
        })),
      ),
    ),
  );
  await writeFile(
    database,
    JSON.stringify(
      declarations.map(([, ecosystem, name, version], index) =>
        advisory(
          { package: { ecosystem, name }, versions: [version] },
          { id: `OSV-TEST-${index}` },
        ),
      ),
    ),
  );
  const result = await checkVulnerabilities({ path, database });
  if (!result.ok) throw result.error;
  expect(result.value.findings).toHaveLength(4);
  expect(result.value.findings.map((item) => item.component.bom_ref)).toEqual([
    "ref-0",
    "ref-1",
    "ref-2",
    "ref-3",
  ]);
});

it("uses Go semantic versions without treating arbitrary ecosystem versions as semver", async () => {
  await writeFile(
    path,
    JSON.stringify(
      sbom([component("v1.2.0", "pkg:golang/example.org/module")]),
    ),
  );
  await writeFile(
    database,
    JSON.stringify(
      advisory(
        packageRecord(
          [
            {
              type: "SEMVER",
              events: [{ introduced: "0" }, { fixed: "v1.3.0" }],
            },
          ],
          "Go",
          "example.org/module",
        ),
      ),
    ),
  );
  const result = await checkVulnerabilities({ path, database });
  if (!result.ok) throw result.error;
  expect(result.value.findings).toHaveLength(1);
  await writeFile(
    path,
    JSON.stringify(sbom([component("1.2.0", "pkg:maven/org.example/module")])),
  );
  await writeFile(
    database,
    JSON.stringify(
      advisory(
        packageRecord(
          [
            {
              type: "ECOSYSTEM",
              events: [{ introduced: "0" }, { fixed: "2.0.0" }],
            },
          ],
          "Maven",
          "org.example:module",
        ),
      ),
    ),
  );
  const maven = await checkVulnerabilities({ path, database });
  if (!maven.ok) throw maven.error;
  expect(maven.value.unassessed_components).toHaveLength(1);
});

it("excludes withdrawn records and keeps missing versions unknown", async () => {
  await writeFile(
    path,
    JSON.stringify(
      sbom([
        component("1.0.0"),
        { ...component(), "bom-ref": "unknown-version" },
      ]),
    ),
  );
  await writeFile(
    database,
    JSON.stringify(
      advisory(
        {
          package: { ecosystem: "npm", name: "example" },
          versions: ["1.0.0"],
        },
        { withdrawn: modified },
      ),
    ),
  );
  const result = await checkVulnerabilities({ path, database });
  if (!result.ok) throw result.error;
  expect(result.value.database.withdrawn_records).toBe(1);
  expect(result.value.findings).toHaveLength(0);
  expect(result.value.unmatched_components).toHaveLength(1);
  expect(result.value.unassessed_components).toHaveLength(1);
});

it("reads direct generate_sbom Evidence and dates only the snapshot declaration", async () => {
  await writeFile(
    path,
    JSON.stringify({
      operation: "generate_sbom",
      evidence_id: "external",
      normalized_result: { sbom: sbom([component("1.0.0")]) },
    }),
  );
  await writeFile(
    database,
    JSON.stringify({
      schema: "oopsware-osv-snapshot-v1",
      generated_at: "2020-01-01T00:00:00Z",
      records: [],
    }),
  );
  const result = await checkVulnerabilities({ path, database });
  if (!result.ok) throw result.error;
  expect(result.value.database.freshness).toBe("stale");
  expect(result.value.database.coverage).toBe("unknown");
  expect(result.value.unmatched_components[0]?.reasons[0]).toContain(
    "coverage is unknown",
  );
  expect(result.value.artifact.sha256).toBe(digest(await readFile(path)));
  expect(result.value.database.stale_after_days).toBe(30);
});

it("hashes directory membership and manifest bytes and detects later changes", async () => {
  const directory = join(root, "snapshot");
  await mkdir(join(directory, "npm"), { recursive: true });
  const recordPath = join(directory, "npm", "record.json");
  await writeFile(
    recordPath,
    JSON.stringify(
      advisory({
        package: { ecosystem: "npm", name: "example" },
        versions: ["1.0.0"],
      }),
    ),
  );
  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify({
      schema: "oopsware-osv-snapshot-v1",
      generated_at: modified,
    }),
  );
  const snapshot = await readVulnerabilitySnapshot(directory);
  expect(snapshot.files).toBe(2);
  expect(snapshot.generatedAt).toBe(modified);
  expect(snapshot.records[0]?.source.file).toBe("npm/record.json");
  await snapshot.verify();
  await writeFile(recordPath, "[]");
  await expect(snapshot.verify()).rejects.toMatchObject({
    reason: "integrity",
  });
  const changed = await readVulnerabilitySnapshot(directory);
  expect(changed.sha256).not.toBe(snapshot.sha256);
  await writeFile(join(directory, "added.json"), "[]");
  await expect(changed.verify()).rejects.toMatchObject({
    reason: "integrity",
  });
});

it("rejects missing snapshots, symlinks, invalid JSON, excessive bytes and cancellation", async () => {
  await writeFile(path, JSON.stringify(sbom([component("1.0.0")])));
  expect(await checkVulnerabilities({ path, database })).toMatchObject({
    ok: false,
    error: { reason: "path" },
  });
  await symlink(path, database);
  expect(await checkVulnerabilities({ path, database })).toMatchObject({
    ok: false,
    error: { reason: "path" },
  });
  const directory = join(root, "linked-snapshot");
  await mkdir(directory);
  await symlink(root, join(directory, "escape"));
  expect(
    await checkVulnerabilities({ path, database: directory }),
  ).toMatchObject({ ok: false, error: { reason: "path" } });
  const bad = join(root, "bad.json");
  await writeFile(bad, "not json");
  expect(await checkVulnerabilities({ path, database: bad })).toMatchObject({
    ok: false,
    error: { reason: "format" },
  });
  await truncate(bad, VULNERABILITY_LIMITS.databaseBytes + 1);
  expect(await checkVulnerabilities({ path, database: bad })).toMatchObject({
    ok: false,
    error: { reason: "limit" },
  });
  expect(
    await checkVulnerabilities(
      { path, database },
      { signal: AbortSignal.abort() },
    ),
  ).toMatchObject({ ok: false, error: { reason: "cancelled" } });
});

it("handles cancellation during snapshot parsing", async () => {
  await writeFile(path, JSON.stringify(sbom([component("1.0.0")])));
  await writeFile(
    database,
    JSON.stringify(
      Array.from({ length: 5_000 }, (_, index) =>
        advisory(
          {
            package: { ecosystem: "npm", name: "example" },
            versions: ["1.0.0"],
          },
          { id: `OSV-${index}` },
        ),
      ),
    ),
  );
  const controller = new AbortController();
  const pending = checkVulnerabilities(
    { path, database },
    { signal: controller.signal },
  );
  const timer = setTimeout(() => controller.abort(), 5);
  try {
    expect(await pending).toMatchObject({
      ok: false,
      error: { reason: "cancelled" },
    });
  } finally {
    clearTimeout(timer);
  }
});

it("refuses excessive report output and component counts", async () => {
  await writeFile(path, JSON.stringify(sbom([component("1.0.0")])));
  await writeFile(
    database,
    JSON.stringify(
      Array.from({ length: 600 }, (_, index) =>
        advisory(
          {
            package: { ecosystem: "npm", name: "example" },
            versions: ["1.0.0"],
          },
          { id: `OSV-${index}`, summary: "x".repeat(16_384) },
        ),
      ),
    ),
  );
  expect(await checkVulnerabilities({ path, database })).toMatchObject({
    ok: false,
    error: { reason: "limit" },
  });
  await writeFile(
    path,
    JSON.stringify(
      sbom(
        Array.from({ length: 10_001 }, (_, index) => ({
          name: `component-${index}`,
        })),
      ),
    ),
  );
  expect(await checkVulnerabilities({ path, database })).toMatchObject({
    ok: false,
    error: { reason: "limit" },
  });
});

it("keeps unsupported version spellings unassessed even with only an explicit version list", async () => {
  await writeFile(
    path,
    JSON.stringify(sbom([component("development-snapshot")])),
  );
  await writeFile(
    database,
    JSON.stringify(
      advisory({
        package: { ecosystem: "npm", name: "example" },
        versions: ["1.0.0"],
      }),
    ),
  );
  const result = await checkVulnerabilities({ path, database });
  if (!result.ok) throw result.error;
  expect(result.value.unassessed_components).toHaveLength(1);
  expect(result.value.unmatched_components).toHaveLength(0);
});

describe("CycloneDX identity boundary", () => {
  it("rejects duplicate refs and unknown formats; retains unavailable or conflicting identity", () => {
    expect(() =>
      readVulnerabilityComponents(
        sbom([component("1.0.0"), component("1.0.0")]),
      ),
    ).toThrow();
    expect(() =>
      readVulnerabilityComponents({ bomFormat: "SPDX", components: [] }),
    ).toThrow();
    const values = readVulnerabilityComponents(
      sbom([
        { name: "a", "bom-ref": "1", version: "1.0.0" },
        {
          name: "a",
          "bom-ref": "2",
          version: "1.0.0",
          purl: "pkg:npm/a@2.0.0",
        },
        {
          name: "a",
          "bom-ref": "3",
          version: "1.0.0",
          purl: "pkg:constructor/a@1.0.0",
        },
      ]),
    );
    expect(values.every((value) => value.reason)).toBe(true);
    expect(
      checkVulnerabilitiesInputSchema.safeParse({
        path: "a\0b",
        database: "db",
      }).success,
    ).toBe(false);
  });
});

it("checks the SBOM producer's exact dependency identities without rewriting its output", async () => {
  const lock = join(root, "package-lock.json");
  await writeFile(
    lock,
    JSON.stringify({
      name: "fixture",
      lockfileVersion: 3,
      packages: {
        "": { name: "fixture", version: "1.0.0" },
        "node_modules/@scope/library": {
          version: "1.2.3",
          resolved:
            "https://registry.npmjs.org/@scope/library/-/library-1.2.3.tgz",
        },
      },
    }),
  );
  const generated = await generateSbom(
    generateSbomInputSchema.parse({ path: lock }),
  );
  if (!generated.ok) throw generated.error;
  await writeFile(
    path,
    JSON.stringify({
      operation: "generate_sbom",
      normalized_result: generated.value,
    }),
  );
  await writeFile(
    database,
    JSON.stringify(
      advisory({
        package: { ecosystem: "npm", name: "@scope/library" },
        versions: ["1.2.3"],
      }),
    ),
  );
  const checked = await checkVulnerabilities({ path, database });
  if (!checked.ok) throw checked.error;
  expect(checked.value.findings).toHaveLength(1);
  expect(checked.value.findings[0]?.component.package_name).toBe(
    "@scope/library",
  );
  expect(checked.value.findings[0]?.component.bom_ref).toBe(
    generated.value.sbom.components.find(
      (item) => item.name === "@scope/library",
    )?.["bom-ref"],
  );
});
