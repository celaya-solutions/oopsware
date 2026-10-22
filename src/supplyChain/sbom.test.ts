import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Uint8ArrayWriter, TextReader, ZipWriter } from "@zip.js/zip.js";
import { afterAll, expect, it } from "vitest";
import { createGoBinaryFixture } from "../../tests/fixtures/go/image.js";
import { createRustImage } from "../../tests/fixtures/rust/image.js";
import {
  buildWheel,
  wheelProducer,
} from "../../tests/fixtures/pythonProducers.js";
import { JDK_HOME } from "../../tests/fixtures/jvmProducers.js";
import { removeTestWorkspace } from "../../tests/support/workspace/workspaceFixture.js";
import {
  generateSbomInputSchema,
  type SbomReport,
} from "../domain/supplyChain/sbom.js";
import { generateSbom } from "./sbom.js";

const root = await mkdtemp(join(tmpdir(), "oopsware-sbom-test-"));
afterAll(() => removeTestWorkspace(root));
const fixture = async (name: string, content: string | Buffer) => {
  const path = join(root, name);
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, content);
  return path;
};
const report = async (path: string): Promise<SbomReport> => {
  const result = await generateSbom(generateSbomInputSchema.parse({ path }));
  if (!result.ok) throw result.error;
  return result.value;
};
const property = (
  component: SbomReport["sbom"]["components"][number],
  key: string,
) => component.properties.find((entry) => entry.name === key)?.value;
const archive = async (entries: Record<string, string>) => {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  for (const [name, content] of Object.entries(entries))
    await writer.add(name, new TextReader(content));
  return Buffer.from(await writer.close());
};

it("reads the repository's real npm lockfile with source hashes and valid dependency refs", async () => {
  const result = await report(resolve("package-lock.json"));
  expect(result.sbom.specVersion).toBe("1.6");
  expect(
    result.sbom.components.some((component) =>
      component.purl?.startsWith("pkg:npm/zod@"),
    ),
  ).toBe(true);
  const refs = new Set(
    result.sbom.components.map((component) => component["bom-ref"]),
  );
  expect(refs.size).toBe(result.sbom.components.length);
  for (const edge of result.sbom.dependencies) {
    expect(refs.has(edge.ref)).toBe(true);
    expect(edge.dependsOn.every((ref) => refs.has(ref))).toBe(true);
  }
  for (const component of result.sbom.components)
    expect(property(component, "oopsware:source:sha256")).toMatch(
      /^[a-f0-9]{64}$/u,
    );
  expect(result.coverage.state).toBe("partial");
});

it("keeps unknown versions and custom declarations, resolves lockfile occurrences without links", async () => {
  const path = await fixture(
    "npm/package-lock.json",
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": {
          name: "demo",
          version: "1.0.0",
          dependencies: { "@scope/pkg": "^2", missing: "*" },
        },
        "node_modules/@scope/pkg": {
          version: "2.1.0",
          license: "LicenseRef-Internal",
        },
        "node_modules/unknown": {},
        "node_modules/linked": { link: true, resolved: "../outside" },
      },
    }),
  );
  const result = await report(path);
  expect(result.sbom.components.map((component) => component.name)).toEqual([
    "demo",
    "@scope/pkg",
    "unknown",
  ]);
  expect(result.sbom.components[1]?.purl).toBe("pkg:npm/%40scope/pkg@2.1.0");
  expect(result.sbom.components[2]?.version).toBeUndefined();
  expect(result.sbom.components[2]?.purl).toBeUndefined();
  expect(result.sbom.dependencies).toEqual([
    { ref: "component-1", dependsOn: ["component-2"] },
  ]);
  expect(result.licenses[0]).toMatchObject({
    evidence_kind: "declared",
    value: "LicenseRef-Internal",
    matched_license: null,
  });
});

it("reads Cargo.lock with ambiguous version references left unknown", async () => {
  const path = await fixture(
    "cargo/Cargo.lock",
    `version = 4
[[package]]
name = "app"
version = "0.1.0"
dependencies = ["itoa 1.0.18", "ambiguous"]
[[package]]
name = "itoa"
version = "1.0.18"
source = "registry+https://github.com/rust-lang/crates.io-index"
[[package]]
name = "ambiguous"
version = "1.0.0"
[[package]]
name = "ambiguous"
version = "2.0.0"
`,
  );
  const result = await report(path);
  expect(result.sbom.components[1]?.purl).toBe("pkg:cargo/itoa@1.0.18");
  expect(result.sbom.components[0]?.purl).toBeUndefined();
  expect(result.sbom.dependencies).toEqual([
    { ref: "component-1", dependsOn: ["component-2"] },
  ]);
});

it("omits public-registry identities for declared private or alternate-registry npm packages", async () => {
  const path = await fixture(
    "private/package-lock.json",
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { name: "private-project", version: "1.0.0", private: true },
        "node_modules/custom": {
          version: "1.0.0",
          resolved: "https://packages.example.org/custom-1.0.0.tgz",
        },
      },
    }),
  );
  const result = await report(path);
  expect(result.sbom.components).toHaveLength(2);
  expect(
    result.sbom.components.every((component) => component.purl === undefined),
  ).toBe(true);
});

it("reuses the binary metadata readers and reports effective Go replacements", async () => {
  const go = await report(
    await fixture(
      "native/app-go",
      createGoBinaryFixture({
        moduleText:
          "path\texample.org/app\nmod\texample.org/app\t(devel)\t\ndep\texample.org/dependency\tv1.0.0\th1:abc\n=>\texample.org/replacement\tv2.0.0\th1:def\n",
      }).bytes,
    ),
  );
  expect(go.sbom.components.map((component) => component.name)).toEqual([
    "example.org/app",
    "example.org/replacement",
  ]);
  expect(go.sbom.components[0]?.version).toBeUndefined();
  expect(go.sbom.components[1]?.purl).toBe(
    "pkg:golang/example.org/replacement@v2.0.0",
  );
  expect(go.sbom.dependencies).toEqual([]);
  const rust = await report(
    await fixture("native/app-rust", createRustImage({ format: "elf" })),
  );
  expect(rust.sbom.components[0]?.purl).toBe("pkg:cargo/itoa@1.0.18");
  expect(rust.sbom.dependencies).toEqual([
    { ref: "component-2", dependsOn: ["component-1"] },
  ]);
});

it("does not follow directory symlinks and keeps unknown license text", async () => {
  const outside = await fixture(
    "outside/package.json",
    '{"name":"outside","version":"1.0.0"}',
  );
  const selected = join(root, "selected");
  await mkdir(selected);
  await symlink(resolve(outside, ".."), join(selected, "linked"));
  await writeFile(
    join(selected, "LICENSE"),
    "All rights reserved. Custom terms apply.",
  );
  const result = await report(selected);
  expect(result.sbom.components).toEqual([]);
  expect(result.artifact.sha256).toBeNull();
  expect(result.licenses).toEqual([
    expect.objectContaining({
      evidence_kind: "unknown",
      matched_license: null,
    }),
  ]);
  expect(result.limitations.join(" ")).toContain(
    "symbolic link was not followed",
  );
  const linked = await generateSbom(
    generateSbomInputSchema.parse({ path: join(selected, "linked") }),
  );
  expect(linked.ok).toBe(false);
});

it("distinguishes license text inference from package declarations", async () => {
  const path = await fixture(
    "licenses/LICENSE",
    await readFile(resolve("LICENSES/REA-MIT.txt")),
  );
  const result = await report(path);
  expect(result.licenses).toEqual([
    expect.objectContaining({
      evidence_kind: "inferred",
      matched_license: "MIT",
      component_ref: null,
    }),
  ]);
  expect(result.sbom.components).toEqual([]);
});

it("reports malformed and missing package identities without inventing them", async () => {
  const malformed = await report(
    await fixture("malformed/package.json", "{bad"),
  );
  expect(malformed.coverage.state).toBe("unknown");
  expect(malformed.limitations.join(" ")).toContain("malformed metadata");
  const missing = await report(
    await fixture("missing/package.json", '{"version":"1.0.0"}'),
  );
  expect(missing.sbom.components).toEqual([]);
  const result = await report(
    await fixture(
      "invalid.jar",
      await archive({
        "META-INF/maven/x/y/pom.properties":
          "groupId=x\nartifactId=y\nversion=${project.version}\n",
        "META-INF/MANIFEST.MF":
          "Manifest-Version: 1.0\nImplementation-Title: Display Name\n\n",
      }),
    ),
  );
  expect(
    result.sbom.components.every((component) => component.purl === undefined),
  ).toBe(true);
});

it.each([
  "max_input_bytes",
  "max_components",
  "max_output_bytes",
  "max_files",
] as const)("fails closed at %s", async (limit) => {
  const path = await fixture(
    `limits-${limit}/package-lock.json`,
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { name: "one" },
        "node_modules/two": { version: "1.0.0" },
      },
    }),
  );
  const inputPath =
    limit === "max_files"
      ? await fixture(
          "limited.zip",
          await archive({
            "a/package.json": '{"name":"a"}',
            "b/package.json": '{"name":"b"}',
          }),
        )
      : path;
  const result = await generateSbom(
    generateSbomInputSchema.parse({ path: inputPath, [limit]: 1 }),
  );
  expect(result.ok).toBe(false);
  if (!result.ok)
    expect(result.error._tag).toBe("AnalysisResourceConstraintError");
});

it("tags missing inputs, rejects invalid boundaries and honors cancellation", async () => {
  const missing = await generateSbom(
    generateSbomInputSchema.parse({ path: join(root, "absent") }),
  );
  expect(missing.ok).toBe(false);
  const invalid = await generateSbom({ path: "", max_files: -1 } as never);
  expect(invalid.ok).toBe(false);
  if (!invalid.ok) expect(invalid.error._tag).toBe("AnalysisInputError");
  const cancelled = await generateSbom(
    generateSbomInputSchema.parse({ path: root }),
    { signal: AbortSignal.abort("cancelled") },
  );
  expect(cancelled.ok).toBe(false);
  if (!cancelled.ok)
    expect(cancelled.error._tag).toBe("AnalysisCancelledError");
});

it("keeps unsafe ZIP names from becoming metadata sources", async () => {
  const result = await report(
    await fixture(
      "unsafe.zip",
      await archive({
        "../package.json": '{"name":"escape","version":"1.0.0"}',
        "okay/package.json": '{"name":"okay","version":"1.0.0"}',
      }),
    ),
  );
  expect(result.sbom.components.map((component) => component.name)).toEqual([
    "okay",
  ]);
});

const python = await wheelProducer();
it.skipIf(python === null)(
  "reads a real offline setuptools wheel",
  async () => {
    if (python === null) return;
    const result = await report(
      await buildWheel(python, join(root, "wheel-producer"), "project"),
    );
    expect(
      result.sbom.components.find(
        (component) => component.purl === "pkg:pypi/oopsdemo@1.2.3",
      ),
    ).toBeDefined();
    expect(
      result.licenses.some(
        (finding) =>
          finding.evidence_kind === "declared" && finding.value === "MIT",
      ),
    ).toBe(true);
  },
  60_000,
);

it.skipIf(JDK_HOME === null)(
  "reads Maven producer metadata inside a real JDK jar",
  async () => {
    if (JDK_HOME === null) return;
    const content = join(root, "jar-producer", "content");
    const path = await fixture(
      "jar-producer/content/META-INF/maven/org.example/demo/pom.properties",
      "# Maven producer metadata\ngroupId=org.example\nartifactId=demo\nversion=1.2.3\n",
    );
    expect(path).toContain("pom.properties");
    const jar = join(root, "jar-producer", "demo.jar");
    await promisify(execFile)(join(JDK_HOME, "bin/jar"), [
      "--create",
      "--file",
      jar,
      "-C",
      content,
      ".",
    ]);
    const result = await report(jar);
    expect(
      result.sbom.components.find(
        (component) => component.purl === "pkg:maven/org.example/demo@1.2.3",
      ),
    ).toBeDefined();
  },
  60_000,
);
