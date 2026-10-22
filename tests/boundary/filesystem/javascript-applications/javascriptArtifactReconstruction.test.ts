import {
  primitiveCandidateExpansionSource,
  primitiveByteExpansionSource,
} from "../../../fixtures/javascriptPrimitiveExpansion.js";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createPackageWithOptions } from "@electron/asar";
import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

import {
  reconstructJavaScriptArtifact,
  readJavaScriptArtifactFiles,
} from "../../../support/javascriptApplicationScope.js";
import {
  analyzeJavaScriptArtifactFiles,
  analyzeAndProjectJavaScriptArtifactFiles,
} from "../../../../src/application/javascript/JavaScriptArtifactAnalysis.js";
import { buildJavaScriptArtifactGraph } from "../../../../src/application/javascript/JavaScriptArtifactGraphBuilder.js";
import {
  buildJavaScriptSemanticGraph,
  createJavaScriptSemanticGraphProjection,
  projectJavaScriptSemanticFileSteps,
} from "../../../../src/application/javascript/JavaScriptSemanticGraphBuilder.js";
import {
  projectJavaScriptModuleSemantics,
  type JavaScriptModuleSemanticIr,
} from "../../../../src/domain/javascript/javascriptModuleSemanticIr.js";
import type { JavaScriptStaticAnalysis } from "../../../../src/domain/javascript/javascriptStaticAnalysisTypes.js";
import type { JavaScriptArtifactFile } from "../../../../src/domain/javascript/javascriptArtifactFiles.js";
import { completeJavaScriptAnalysisSteps } from "../../../../src/application/javascript/JavaScriptAnalysisControl.js";
import {
  writeJavaScriptAnalysisTransfer,
  readJavaScriptAnalysisTransfer,
} from "../../../../src/javascript/analysis/JavaScriptAnalysisTransfer.js";
import { javaScriptWorkerStaticAnalysisSchema } from "../../../../src/javascript/analysis/JavaScriptAnalysisWorkerSchemas.js";
import { createJavaScriptArtifactReader } from "../../../../src/artifacts/javascript/JavaScriptArtifactReader.js";
import {
  scanCanonicalArtifactInventory,
  scanArtifactInventory,
} from "../../../fixtures/artifactInventory.js";
import { parseJavaScriptApplicationGraph } from "../../../../src/domain/javascript/javascriptApplicationGraph.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import {
  createJavaScriptSemanticGraph,
  isValidatedImmutableJavaScriptSemanticGraph,
} from "../../../../src/domain/javascript/javascriptSemanticGraph.js";
import { parseJavaScriptSemanticGraph } from "../../../../src/domain/javascript/javascriptSemanticGraphSerialization.js";
import { writeJavaScriptArtifactFixture } from "../../../fixtures/javascriptArtifactApplication.js";
import { writeFixtureFiles } from "../../../support/javascriptApplicationFixture.js";

it("does not let a known-absent optional import erase another application's page", async () => {
  const root = await createTestTempDirectory("rea-absent-optional-owner-");
  await writeFixtureFiles(root, {
    "a/package.json": JSON.stringify({ main: "main.cjs" }),
    "b/package.json": JSON.stringify({ main: "main.cjs" }),
    "a/main.cjs":
      'const {BrowserWindow} = require("electron"); const w = new BrowserWindow(); w.loadFile("index.html");',
    "b/main.cjs": 'try { require("./optional.cjs"); } catch {}',
    "a/index.html": "valid page",
    "index.html": "root decoy",
  });
  const result = await reconstructJavaScriptArtifact({
    input_path: root,
    format: "directory",
  });
  const role = result.graph.nodes.find(
    ({ kind }) => kind === "electron-renderer",
  );
  expect(role?.observations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        properties: expect.objectContaining({
          resolved_path: "a/index.html",
          resolution_status: "resolved",
        }),
      }),
    ]),
  );
  expect(
    result.graph.edges.filter(
      ({ source_node_id, relation }) =>
        source_node_id === role?.node_id && relation === "maps_to",
    ),
  ).toHaveLength(1);
});

it.each([
  "unselected",
  "unavailable",
  "dynamic",
  "unavailable-json",
  "unavailable-package-json",
  "unavailable-uppercase-json",
  "unavailable-main",
  "unavailable-default-main",
  "unavailable-json-main",
  "resolved-html",
  "resolved-uppercase-json",
  "resolved-json",
  "resolved-package-json",
  "resolved-html-main",
  "unavailable-package-metadata",
  "unavailable-directory-main",
] as const)(
  "distinguishes hidden imports from inert data through %s",
  async (omission) => {
    const root = await createTestTempDirectory("rea-competing-gap-");
    const targetPaths: Partial<Record<typeof omission, string>> = {
      "unavailable-default-main": "b/index.js",
      "unavailable-json-main": "b/config.json",
      "unavailable-main": "b/main.cjs",
      "unavailable-json": "b/config.json",
      "unavailable-package-json": "b/node_modules/pkg/package.json",
      "unavailable-uppercase-json": "shared/bridge.JSON",
      "resolved-html": "shared/bridge.html",
      "resolved-uppercase-json": "shared/bridge.JSON",
      "resolved-json": "b/config.json",
      "resolved-package-json": "b/node_modules/pkg/package.json",
      "resolved-html-main": "b/main.html",
      "unavailable-package-metadata": "b/node_modules/pkg/package.json",
      "unavailable-directory-main": "b/node_modules/pkg/package.json",
    };
    const targetPath = targetPaths[omission] ?? "shared/bridge.cjs";
    const inertJson = [
      "unavailable-json",
      "unavailable-package-json",
      "unavailable-json-main",
      "resolved-json",
      "resolved-package-json",
    ].includes(omission);
    await writeFixtureFiles(root, {
      "a/package.json": JSON.stringify({ main: "main.cjs" }),
      "b/package.json": JSON.stringify(
        omission === "unavailable-default-main"
          ? {}
          : {
              main:
                omission === "unavailable-directory-main"
                  ? "node_modules/pkg"
                  : omission === "resolved-html-main"
                    ? "main.html"
                    : omission === "unavailable-json-main"
                      ? "config.json"
                      : "main.cjs",
            },
      ),
      "b/index.js": 'require("../shared/window.cjs");',
      "b/main.html": 'require("../shared/window.cjs");',
      "a/main.cjs": 'require("../shared/window.cjs");',
      "b/main.cjs":
        omission === "unavailable-package-metadata"
          ? 'require("pkg");'
          : omission === "unavailable-main"
            ? 'require("../shared/window.cjs");'
            : omission === "dynamic"
              ? "require(process.env.CHILD);"
              : `require(${JSON.stringify(targetPath.startsWith("b/") ? `./${targetPath.slice(2)}` : `../${targetPath}`)});`,
      "b/config.json": "{}",
      "b/node_modules/pkg/package.json": "{}",
      "b/node_modules/pkg/index.js": 'require("../../../shared/window.cjs");',
      "shared/bridge.JSON": 'require("./window.cjs");',
      "shared/bridge.html": 'require("./window.cjs");',
      "shared/bridge.cjs": 'require("./window.cjs");',
      "shared/window.cjs":
        'const {BrowserWindow} = require("electron"); const w = new BrowserWindow(); w.loadFile("index.html");',
      "a/index.html": "wrong unique owner",
      "b/index.html": "competing owner",
      "index.html": "root decoy",
    });
    const snapshot = await scanCanonicalArtifactInventory(root, {});
    const reader = createJavaScriptArtifactReader(root, "directory");
    try {
      const files = await readJavaScriptArtifactFiles(
        reader,
        snapshot,
        undefined,
        omission === "unselected"
          ? [
              "a/package.json",
              "b/package.json",
              "a/main.cjs",
              "b/main.cjs",
              "shared/window.cjs",
            ]
          : undefined,
      );
      const bridge = files.files.find(({ path }) => path === targetPath);
      if (bridge === undefined) throw new Error("Missing bridge");
      const partial = !omission.startsWith("unavailable")
        ? files
        : {
            ...files,
            files: files.files.filter(({ path }) => path !== bridge.path),
            unavailable_relevant_files: [
              ...files.unavailable_relevant_files,
              {
                path: bridge.path,
                container_sha256: bridge.container_sha256,
                sha256: null,
                bytes: null,
                inventory_artifact_id: bridge.inventory_artifact_id,
                kind: bridge.kind,
                hash_status: "unavailable" as const,
              },
            ],
          };
      const graph = buildJavaScriptArtifactGraph(
        snapshot,
        partial,
        analyzeJavaScriptArtifactFiles(partial),
      );
      const roles = graph.nodes.filter(
        ({ kind }) => kind === "electron-renderer",
      );
      expect(roles).toHaveLength(1);
      expect(roles[0]?.observations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            properties: expect.objectContaining({
              resolved_path: inertJson ? "a/index.html" : null,
              resolution_status: inertJson ? "resolved" : "unavailable",
            }),
          }),
        ]),
      );
      expect(
        graph.edges.filter(
          ({ source_node_id, relation }) =>
            source_node_id === roles[0]?.node_id && relation === "maps_to",
        ),
      ).toHaveLength(inertJson ? 1 : 0);
    } finally {
      await reader.close();
    }
  },
);

it.each(["unselected", "unavailable"] as const)(
  "keeps imported loadFile ownership unknown across an %s module",
  async (omission) => {
    const root = await createTestTempDirectory("rea-missing-module-owner-");
    await writeFixtureFiles(root, {
      "app/package.json": JSON.stringify({ main: "../shared/main.cjs" }),
      "shared/main.cjs": 'require("./window.cjs");',
      "shared/window.cjs":
        'const { BrowserWindow } = require("electron"); const win = new BrowserWindow(); win.loadFile("index.html");',
      "index.html": "artifact-root decoy",
      "app/index.html": "unproven application page",
    });
    const snapshot = await scanCanonicalArtifactInventory(root, {});
    const reader = createJavaScriptArtifactReader(root, "directory");
    try {
      const files = await readJavaScriptArtifactFiles(
        reader,
        snapshot,
        undefined,
        omission === "unselected"
          ? ["app/package.json", "shared/window.cjs"]
          : undefined,
      );
      const entry = files.files.find(({ path }) => path === "shared/main.cjs");
      if (entry === undefined) throw new Error("Missing inventoried entry");
      // The unavailable variant injects the reader boundary, not an actual I/O failure.
      const partial =
        omission === "unselected"
          ? files
          : {
              ...files,
              files: files.files.filter(({ path }) => path !== entry.path),
              unavailable_relevant_files: [
                ...files.unavailable_relevant_files,
                {
                  path: entry.path,
                  container_sha256: entry.container_sha256,
                  sha256: null,
                  bytes: null,
                  inventory_artifact_id: entry.inventory_artifact_id,
                  kind: entry.kind,
                  hash_status: "unavailable" as const,
                },
              ],
            };
      const graph = buildJavaScriptArtifactGraph(
        snapshot,
        partial,
        analyzeJavaScriptArtifactFiles(partial),
      );
      const roles = graph.nodes.filter(
        ({ kind }) => kind === "electron-renderer",
      );
      expect(roles).toHaveLength(1);
      const role = roles[0];
      if (role === undefined) throw new Error("Missing renderer");
      expect(role.observations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            properties: expect.objectContaining({
              resolved_path: null,
              resolution_status: "unavailable",
            }),
          }),
        ]),
      );
      expect(
        graph.edges.filter(
          ({ source_node_id, relation }) =>
            source_node_id === role.node_id && relation === "maps_to",
        ),
      ).toEqual([]);
    } finally {
      await reader.close();
    }
  },
);

it("keeps imported loadFile ownership unknown across an application projection omission", async () => {
  const root = await createTestTempDirectory("rea-omitted-app-owner-");
  await writeFixtureFiles(root, {
    "app/package.json": JSON.stringify({ main: "../shared/main.cjs" }),
    "shared/main.cjs": 'require("./window.cjs");',
    "shared/window.cjs":
      'const { BrowserWindow } = require("electron"); const win = new BrowserWindow(); win.loadFile("index.html");',
    "index.html": "artifact-root decoy",
    "app/index.html": "unproven application page",
  });
  const snapshot = await scanCanonicalArtifactInventory(root, {});
  const reader = createJavaScriptArtifactReader(root, "directory");
  try {
    const files = await readJavaScriptArtifactFiles(reader, snapshot);
    const analysis = analyzeJavaScriptArtifactFiles(files);
    const entry = analysis.files.find(
      ({ file }) => file.path === "shared/main.cjs",
    );
    expect(
      entry?.javascript?.references.some(
        ({ specifier }) => specifier === "./window.cjs",
      ),
    ).toBe(true);
    // Exercise the production omission boundary without bypassing its memory guard.
    const graph = buildJavaScriptArtifactGraph(snapshot, files, {
      ...analysis,
      files: analysis.files.map((file) =>
        file.file.path === "shared/main.cjs"
          ? {
              ...file,
              application_projection_failure: {
                reason: "fixture projection omitted",
                error: null,
                limits: null,
              },
            }
          : file,
      ),
    });
    const roles = graph.nodes.filter(
      ({ kind }) => kind === "electron-renderer",
    );
    expect(roles).toHaveLength(1);
    const role = roles[0];
    if (role === undefined) throw new Error("Missing renderer");
    expect(role.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          properties: expect.objectContaining({
            resolved_path: null,
            resolution_status: "unavailable",
          }),
        }),
      ]),
    );
    expect(
      graph.edges.filter(
        ({ source_node_id, relation }) =>
          source_node_id === role.node_id && relation === "maps_to",
      ),
    ).toEqual([]);
  } finally {
    await reader.close();
  }
});

it("keeps a loadFile owner unknown when a sibling manifest is unavailable in the inventory projection", async () => {
  const root = await createTestTempDirectory("rea-unavailable-app-owner-");
  await writeFixtureFiles(root, {
    "app/package.json": JSON.stringify({ main: "../shared/main.cjs" }),
    "shared/main.cjs":
      'const { BrowserWindow } = require("electron"); const win = new BrowserWindow(); win.loadFile("index.html");',
    "index.html": "artifact-root decoy",
    "app/index.html": "unproven app page",
  });
  const snapshot = await scanCanonicalArtifactInventory(root, {});
  const reader = createJavaScriptArtifactReader(root, "directory");
  try {
    const files = await readJavaScriptArtifactFiles(reader, snapshot);
    const manifest = files.files.find(
      ({ path }) => path === "app/package.json",
    );
    if (manifest === undefined) throw new Error("Missing inventoried manifest");
    // Inject the reader boundary's unavailable projection, not a fabricated graph.
    const partial = {
      ...files,
      files: files.files.filter(({ path }) => path !== manifest.path),
      unavailable_relevant_files: [
        ...files.unavailable_relevant_files,
        {
          path: manifest.path,
          container_sha256: manifest.container_sha256,
          sha256: null,
          bytes: null,
          inventory_artifact_id: manifest.inventory_artifact_id,
          kind: manifest.kind,
          hash_status: "unavailable" as const,
        },
      ],
    };
    const graph = buildJavaScriptArtifactGraph(
      snapshot,
      partial,
      analyzeJavaScriptArtifactFiles(partial),
    );
    const roles = graph.nodes.filter(
      ({ kind }) => kind === "electron-renderer",
    );
    expect(roles).toHaveLength(1);
    const role = roles[0];
    if (role === undefined) throw new Error("Missing renderer");
    expect(role.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          properties: expect.objectContaining({
            resolved_path: null,
            resolution_status: "unavailable",
          }),
        }),
      ]),
    );
    expect(
      graph.edges.filter(
        ({ source_node_id, relation }) =>
          source_node_id === role.node_id && relation === "maps_to",
      ),
    ).toEqual([]);
  } finally {
    await reader.close();
  }
});

it("keeps excluded non-JavaScript files out of both semantic construction paths", async () => {
  const root = await createTestTempDirectory("rea-js-semantic-applicability-");
  await Promise.all(
    (
      [
        ["a.js", "export const observed = 7;"],
        ["b.js", "export const excluded = true;"],
        ["native.node", Buffer.from([0, 1, 2, 3])],
        ["data.json", '{"observed":7}'],
        ["index.html", '<script src="./a.js"></script>'],
        ["package.json", '{"name":"applicability","main":"a.js"}'],
        [
          "a.js.map",
          JSON.stringify({ version: 3, sources: [], names: [], mappings: "" }),
        ],
      ] as const
    ).map(([path, content]) => writeFile(join(root, path), content)),
  );
  const snapshot = await scanCanonicalArtifactInventory(root, {});
  const reader = createJavaScriptArtifactReader(root, "directory");
  try {
    const files = await readJavaScriptArtifactFiles(
      reader,
      snapshot,
      undefined,
      ["a.js"],
    );
    expect(
      files.files.filter(({ text }) => !text.included).map(({ path }) => path),
    ).toEqual([
      "a.js.map",
      "b.js",
      "data.json",
      "index.html",
      "native.node",
      "package.json",
    ]);
    const analysis = analyzeJavaScriptArtifactFiles(files);
    const applicationGraph = buildJavaScriptArtifactGraph(
      snapshot,
      files,
      analysis,
    );
    const full = buildJavaScriptSemanticGraph({
      rootArtifactSha256: snapshot.manifest.root_sha256,
      applicationGraph,
      analysis,
    });
    const incremental = await reconstructJavaScriptArtifact({
      input_path: root,
      source_paths: ["a.js"],
    });
    for (const graph of [full, incremental.semantic_graph]) {
      expect(
        graph.nodes
          .filter(({ kind }) => kind === "module")
          .map(({ identity }) => identity.module_path)
          .sort(),
      ).toEqual(["a.js", "b.js"]);
      expect(graph.coverage.status).toBe("partial");
      expect(graph.unknowns.length).toBeGreaterThan(0);
      expect(
        new Set(graph.nodes.map(({ identity }) => identity.module_path)),
      ).toEqual(new Set(["a.js", "b.js"]));
    }
  } finally {
    await reader.close();
  }
});

it("reports file progress and honors cancellation before the next source", async () => {
  const root = await fixtureDirectory();
  const controller = new AbortController();
  const progress: string[] = [];
  await expect(
    reconstructJavaScriptArtifact({ input_path: root }, controller.signal, {
      report: async (event) => {
        if (event.phase === "parse_javascript_source") {
          progress.push(event.message);
          if (progress.length === 2) controller.abort();
        }
      },
    }),
  ).rejects.toMatchObject({
    _tag: "AnalysisCancelledError",
    partialObservation: { operation: "analyze_javascript_application" },
  });
  expect(progress).toHaveLength(2);
  expect(progress[0]).not.toBe(progress[1]);
});

it("preserves graph commitments and export shapes when consuming file-local IR", async () => {
  const root = await fixtureDirectory();
  await writeFile(
    join(root, "exports.mjs"),
    `
    import { readFile } from "node:fs";
    export { readFile as read };
    export function create(value) { return { value, nested: { enabled: true } }; }
    export function configured(condition) { return { values: [1, null, undefined], choice: condition ? 1 : 2, ...external }; }
    function unexported() { return "private"; }
  `,
  );
  const snapshot = await scanCanonicalArtifactInventory(root, {});
  const reader = createJavaScriptArtifactReader(root, "directory");
  try {
    const files = await readJavaScriptArtifactFiles(reader, snapshot);
    const full = analyzeJavaScriptArtifactFiles(files);
    const projection = createJavaScriptSemanticGraphProjection();
    const compact = await analyzeAndProjectJavaScriptArtifactFiles(
      files,
      projection.projectFile,
    );
    const graph = buildJavaScriptArtifactGraph(snapshot, files, full);
    expect(buildJavaScriptArtifactGraph(snapshot, files, compact)).toEqual(
      graph,
    );
    const semantic = projection.finish(snapshot.manifest.root_sha256, graph);
    expect(semantic).toEqual(
      buildJavaScriptSemanticGraph({
        rootArtifactSha256: snapshot.manifest.root_sha256,
        applicationGraph: graph,
        analysis: full,
      }),
    );
    expect(
      semantic.nodes.some(
        ({ application_node_ids }) => application_node_ids.length > 0,
      ),
    ).toBe(true);
    const exported = compact.files.find(
      ({ file }) => file.path === "exports.mjs",
    );
    expect(exported?.semantic?.ir.callables.map(({ name }) => name)).toEqual([
      "create",
      "configured",
    ]);
    expect(
      full.files
        .find(({ file }) => file.path === "exports.mjs")
        ?.semantic?.ir.callables.map(({ name }) => name),
    ).toContain("unexported");
    expect(parseJavaScriptSemanticGraph(semantic)).toEqual(semantic);
    const transferred = createJavaScriptSemanticGraphProjection();
    const wireRoot = await createTestTempDirectory("rea-javascript-transfer-");
    const decodedModules = new Map<string, JavaScriptModuleSemanticIr>();
    const decodedStatic = new Map<string, JavaScriptStaticAnalysis>();
    let rejectedInvalidTransfer = false;
    for (const [index, analyzed] of full.files.entries()) {
      if (analyzed.javascript !== null) {
        const raw: unknown = JSON.parse(JSON.stringify(analyzed.javascript));
        const decodedFacts = javaScriptWorkerStaticAnalysisSchema.parse(raw);
        expect(decodedFacts).toEqual(analyzed.javascript);
        decodedStatic.set(analyzed.file.path, decodedFacts);
      }
      if (analyzed.semantic === null) continue;
      const fragment = await completeJavaScriptAnalysisSteps(
        projectJavaScriptSemanticFileSteps(
          analyzed.file,
          analyzed.semantic.ir,
          transferred.remainingFileCapacity(),
        ),
      );
      const module = projectJavaScriptModuleSemantics(analyzed.semantic.ir);
      const wirePath = join(wireRoot, `${String(index)}.jsonl`);
      const descriptor = await writeJavaScriptAnalysisTransfer(
        wirePath,
        module,
        fragment,
      );
      const decoded = await readJavaScriptAnalysisTransfer(
        wirePath,
        descriptor,
        analyzed.file,
      );
      expect(decoded.module).toEqual(module);
      decodedModules.set(analyzed.file.path, decoded.module);
      transferred.adoptFileProjection(decoded.projection);
      if (!rejectedInvalidTransfer) {
        await rejectInvalidTransfer(
          wirePath,
          descriptor,
          analyzed.file,
          wireRoot,
        );
        rejectedInvalidTransfer = true;
      }
    }
    const decodedGraph = buildJavaScriptArtifactGraph(snapshot, files, {
      ...compact,
      files: compact.files.map((analyzed) => {
        const module = decodedModules.get(analyzed.file.path);
        return {
          ...analyzed,
          javascript:
            decodedStatic.get(analyzed.file.path) ?? analyzed.javascript,
          semantic: module === undefined ? analyzed.semantic : { ir: module },
        };
      }),
    });
    expect(decodedGraph).toEqual(graph);
    const resealed = await completeJavaScriptAnalysisSteps(
      transferred.finishImmutableSteps(
        snapshot.manifest.root_sha256,
        decodedGraph,
      ),
    );
    expect(resealed).toEqual(semantic);
    expect(isValidatedImmutableJavaScriptSemanticGraph(resealed)).toBe(true);
  } finally {
    await reader.close();
  }
});

const rejectInvalidTransfer = async (
  wirePath: string,
  descriptor: Awaited<ReturnType<typeof writeJavaScriptAnalysisTransfer>>,
  file: JavaScriptArtifactFile,
  wireRoot: string,
): Promise<void> => {
  await expect(
    readJavaScriptAnalysisTransfer(wirePath, descriptor, {
      ...file,
      sha256: "0".repeat(64),
    }),
  ).rejects.toThrow("different artifact source");
  await expect(
    readJavaScriptAnalysisTransfer(
      wirePath,
      { ...descriptor, sha256: "0".repeat(64) },
      file,
    ),
  ).rejects.toThrow("digest does not match");
  const wire = await readFile(wirePath, "utf8");
  const duplicate = wire
    .split("\n")
    .find((line) => line.startsWith('{"kind":"node"'));
  if (duplicate === undefined)
    throw new Error("Fixture emitted no semantic node record");
  const invalid = `${wire}${duplicate}\n`;
  const invalidPath = join(wireRoot, "duplicate.jsonl");
  await writeFile(invalidPath, invalid);
  await expect(
    readJavaScriptAnalysisTransfer(
      invalidPath,
      {
        ...descriptor,
        bytes: Buffer.byteLength(invalid),
        records: descriptor.records + 1,
        graph_bytes: descriptor.graph_bytes + Buffer.byteLength(duplicate) + 1,
        graph_records: descriptor.graph_records + 1,
        sha256: createHash("sha256").update(invalid).digest("hex"),
      },
      file,
    ),
  ).rejects.toThrow("Duplicate JavaScript transfer node identity");
};

it("reports semantic value resource limits in application graph coverage", async () => {
  const root = await createTestTempDirectory("rea-javascript-semantic-limit-");
  await writeFile(join(root, "app.js"), primitiveCandidateExpansionSource());
  await writeFile(join(root, "growth.js"), primitiveByteExpansionSource());
  const snapshot = await scanCanonicalArtifactInventory(root, {});
  const reader = createJavaScriptArtifactReader(root, "directory");
  try {
    const files = await readJavaScriptArtifactFiles(reader, snapshot);
    const analysis = analyzeJavaScriptArtifactFiles(files);
    const graph = buildJavaScriptArtifactGraph(snapshot, files, analysis);

    expect(graph.coverage).toMatchObject({
      status: "partial",
      omitted_count: null,
      limits: expect.arrayContaining([
        expect.objectContaining({
          name: "javascript_semantic_primitive_candidates",
          unit: "items",
        }),
        expect.objectContaining({
          name: "javascript_semantic_primitive_bytes",
          unit: "bytes",
        }),
      ]),
    });
    const sourceModuleLimits = graph.nodes
      .filter(({ kind }) => kind === "javascript-module")
      .flatMap(({ observations }) => observations)
      .filter(
        ({ evidence }) =>
          evidence.extractor.operation === "recover-source-module",
      )
      .flatMap(({ evidence }) => evidence.coverage.limits);
    expect(sourceModuleLimits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "javascript_semantic_primitive_candidates",
          unit: "items",
        }),
        expect.objectContaining({
          name: "javascript_semantic_primitive_bytes",
          unit: "bytes",
        }),
      ]),
    );
    expect(graph.limitations).toContain(
      "Primitive candidate budget exceeded (maximum 256 alternatives).",
    );
    expect(graph.limitations).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/primitive string-byte budget exceeded/i),
      ]),
    );
  } finally {
    await reader.close();
  }
});

it("reconstructs package, Electron roles, Webpack/Rspack modules, and cross-layer facts without execution", async () => {
  const root = await fixtureDirectory();
  Reflect.deleteProperty(globalThis, "__rea_bundle_executed");

  const result = await reconstructJavaScriptArtifact({
    input_path: root,
  });
  const graph = parseJavaScriptApplicationGraph(result.graph);
  const semanticGraph = parseJavaScriptSemanticGraph(result.semantic_graph);

  expect(Reflect.get(globalThis, "__rea_bundle_executed")).toBeUndefined();
  expect(result.input_path).toBe(root);
  expect(result.statistics).toMatchObject({
    modules: 4,
    parse_failures: 0,
    relevant_files: expect.any(Number),
    text_bytes_read: expect.any(Number),
  });
  expect(graph.nodes.map(({ kind }) => kind)).toEqual(
    expect.arrayContaining([
      "package",
      "artifact",
      "electron-main",
      "electron-preload",
      "electron-renderer",
      "javascript-asset",
      "javascript-chunk",
      "javascript-module",
      "worker",
      "service-worker",
      "endpoint",
      "storage",
      "source-map",
      "source-module",
      "native-addon",
    ]),
  );
  expect(graph.nodes.filter(({ kind }) => kind === "javascript-chunk")).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        observations: expect.arrayContaining([
          expect.objectContaining({
            properties: expect.objectContaining({ bundler: "webpack" }),
          }),
        ]),
      }),
      expect.objectContaining({
        observations: expect.arrayContaining([
          expect.objectContaining({
            properties: expect.objectContaining({ bundler: "rspack" }),
          }),
        ]),
      }),
    ]),
  );
  expect(
    graph.nodes.filter(({ kind }) => kind === "javascript-module"),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        observations: expect.arrayContaining([
          expect.objectContaining({
            properties: expect.objectContaining({
              module_key: "1",
              structural_fingerprint_algorithm: "babel-ast-v3",
            }),
          }),
        ]),
      }),
    ]),
  );
  expect(graph.edges.map(({ relation }) => relation)).toEqual(
    expect.arrayContaining([
      "contains",
      "loads",
      "imports",
      "maps_to",
      "exposes",
      "calls",
      "persists_to",
    ]),
  );
  assertSemanticLinks(result, graph, semanticGraph);
});

it("produces deterministic ASAR graphs with unpacked native linkage and complete paths/digests", async () => {
  const root = await createTestTempDirectory("rea-javascript-asar-");
  const source = join(root, "source");
  await mkdir(source);
  await writeJavaScriptArtifactFixture(source);
  const archive = join(root, "app.asar");
  await createPackageWithOptions(source, archive, { unpack: "*.node" });

  const first = await reconstructJavaScriptArtifact({
    input_path: archive,
    format: "asar",
  });
  const second = await reconstructJavaScriptArtifact({
    input_path: archive,
    format: "asar",
  });

  expect(first.graph).toEqual(second.graph);
  expect(first.inventory_graph_sha256).toBe(second.inventory_graph_sha256);
  expect(first.graph.nodes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "asar-entry",
        observations: expect.arrayContaining([
          expect.objectContaining({
            properties: expect.objectContaining({
              entry_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
              inventory_artifact_id:
                expect.stringMatching(/^art_[a-f0-9]{64}$/u),
            }),
          }),
        ]),
      }),
      expect.objectContaining({
        kind: "native-addon",
        observations: expect.arrayContaining([
          expect.objectContaining({
            properties: expect.objectContaining({
              path: "native/addon.node",
              unpacked: true,
            }),
          }),
        ]),
      }),
    ]),
  );
  expect(first.graph.edges).toContainEqual(
    expect.objectContaining({
      relation: "loads",
      properties: expect.objectContaining({
        resolved_path: "native/addon.node",
      }),
    }),
  );
});

it("keeps suffix-named ASAR directories in the graph and analyzes their files", async () => {
  const root = await createTestTempDirectory(
    "rea-javascript-asar-suffix-directory-",
  );
  const source = join(root, "source");
  const zipDirectory = join(source, "node_modules", "@zip.js");
  await mkdir(zipDirectory, { recursive: true });
  await writeJavaScriptArtifactFixture(source);
  await writeFile(
    join(zipDirectory, "entry.js"),
    "export const packed = true;\n",
  );
  const archive = join(root, "app.asar");
  await createPackageWithOptions(source, archive, {});

  const snapshot = await scanArtifactInventory(archive);
  const zipDirectoryOccurrence = snapshot.occurrences.find(
    ({ logical_path }) => logical_path === "node_modules/@zip.js",
  );
  expect(zipDirectoryOccurrence).toMatchObject({
    entry_kind: "directory",
    artifact_id: expect.stringMatching(/^art_[a-f0-9]{64}$/u),
  });
  expect(
    snapshot.nodes.some(
      ({ artifact_id }) => artifact_id === zipDirectoryOccurrence?.artifact_id,
    ),
  ).toBe(true);

  await reconstructAsarArchive(archive, [
    expect.objectContaining({
      kind: "javascript-asset",
      observations: expect.arrayContaining([
        expect.objectContaining({
          properties: expect.objectContaining({
            path: "node_modules/@zip.js/entry.js",
          }),
        }),
      ]),
    }),
  ]);
});

it("keeps ASAR analysis usable when unpacked native companion bytes are absent", async () => {
  const root = await createTestTempDirectory("rea-javascript-asar-missing-");
  const source = join(root, "source");
  await mkdir(source);
  await writeJavaScriptArtifactFixture(source);
  const archive = join(root, "app.asar");
  await createPackageWithOptions(source, archive, { unpack: "*.node" });
  await rm(join(`${archive}.unpacked`, "native", "addon.node"));

  const snapshot = await scanArtifactInventory(archive);
  const missingNative = snapshot.occurrences.find(
    ({ logical_path }) => logical_path === "native/addon.node",
  );

  expect(missingNative).toMatchObject({
    artifact_id: null,
    hash_status: "unavailable",
    limitations: expect.arrayContaining([
      "ASAR unpacked companion bytes were unavailable; no content hash or child artifact was produced.",
    ]),
  });
  if (missingNative === undefined)
    throw new Error("Inventory omitted the unavailable native companion");

  const result = await reconstructAsarArchive(archive, [
    expect.objectContaining({ kind: "javascript-asset" }),
  ]);
  const missingEntry = result.graph.nodes.find(
    ({ kind, observations }) =>
      kind === "asar-entry" &&
      observations.some(({ label }) => label === missingNative.logical_path),
  );
  expect(missingEntry).toMatchObject({
    identity: {
      strategy: "canonical-path",
      stability: "artifact-version",
      artifact_sha256: snapshot.manifest.root_sha256,
      path: missingNative.logical_path,
    },
    observations: [
      expect.objectContaining({
        label: missingNative.logical_path,
        properties: expect.objectContaining({
          entry_sha256: null,
          bytes: missingNative.declared_size,
          inventory_artifact_id: null,
          inventory_occurrence_id: missingNative.occurrence_id,
          hash_status: "unavailable",
          artifact_kind: "native-addon",
          kind: "native-addon",
          content_available: false,
        }),
        evidence: expect.objectContaining({
          limitations: expect.arrayContaining([
            "ASAR unpacked companion bytes were unavailable; no content hash or child artifact was produced.",
            "The inventoried native-addon entry has unavailable bytes; no content artifact identity can be established.",
          ]),
        }),
      }),
    ],
  });
  const unavailableAddon = result.graph.nodes.find(
    ({ kind, observations }) =>
      kind === "native-addon" &&
      observations.some(({ label }) => label === missingNative.logical_path),
  );
  expect(unavailableAddon).toMatchObject({
    identity: {
      strategy: "canonical-path",
      stability: "artifact-version",
      artifact_sha256: snapshot.manifest.root_sha256,
      path: missingNative.logical_path,
    },
    observations: [
      expect.objectContaining({
        label: missingNative.logical_path,
        properties: expect.objectContaining({
          availability: "unavailable",
          hash_status: "unavailable",
          artifact_kind: "native-addon",
          bytes: missingNative.declared_size,
          inventory_artifact_id: null,
          inventory_occurrence_id: missingNative.occurrence_id,
        }),
      }),
    ],
  });
});

it("recurses into filesystem-backed ASAR containers without losing container-relative paths", async () => {
  const root = await createTestTempDirectory("rea-javascript-nested-asar-");
  const source = await fixtureDirectory();
  const outer = join(root, "outer");
  const resources = join(outer, "resources");
  await mkdir(resources, { recursive: true });
  await createPackageWithOptions(source, join(resources, "app.asar"), {
    unpack: "*.node",
  });

  const result = await reconstructJavaScriptArtifact({
    input_path: outer,
  });

  expect(result.statistics.nested_asar_containers).toBe(1);
  expect(result.statistics.modules).toBe(4);
  expect(result.graph.nodes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "artifact",
        observations: expect.arrayContaining([
          expect.objectContaining({
            label: "resources/app.asar",
            properties: expect.objectContaining({ format: "asar" }),
          }),
        ]),
      }),
      expect.objectContaining({
        kind: "javascript-asset",
        observations: expect.arrayContaining([
          expect.objectContaining({
            properties: expect.objectContaining({
              path: "resources/app.asar/main.js",
            }),
          }),
        ]),
      }),
    ]),
  );
});

const assertSemanticLinks = (
  result: Awaited<ReturnType<typeof reconstructJavaScriptArtifact>>,
  graph: ReturnType<typeof parseJavaScriptApplicationGraph>,
  semanticGraph: ReturnType<typeof parseJavaScriptSemanticGraph>,
) => {
  expect(semanticGraph.application_graph_id).toBe(graph.graph_id);
  const { graph_id: _semanticGraphId, ...semanticGraphInput } = semanticGraph;
  const mismatchedSemanticGraph = createJavaScriptSemanticGraph({
    ...semanticGraphInput,
    application_graph_id: `jag_${"f".repeat(64)}`,
  });
  const { electron_summary: summary, ...analysisResult } = result;
  expect(() =>
    javascriptApplicationAnalysisResultSchema.parse({
      ...analysisResult,
      summary,
      semantic_graph: mismatchedSemanticGraph,
    }),
  ).toThrow(/must commit the containing application graph/u);
  expect(
    semanticGraph.nodes.some(
      ({ application_node_ids: identifiers }) => identifiers.length > 0,
    ),
  ).toBe(true);
  expect(semanticGraph.relations.length).toBeGreaterThan(0);
  const roles = ["electron-main", "electron-preload"].map((kind) =>
    graph.nodes.find((node) => node.kind === kind),
  );
  expect(roles[0]?.observations[0]?.properties).toMatchObject({
    declared_path: "main.js",
    resolution_context: "package-entrypoint",
    resolved_path: "main.js",
    resolution_status: "resolved",
    limitations: [],
  });
  expect(roles[1]?.observations[0]?.properties).toMatchObject({
    declared_path: "preload.js",
    resolution_context: "filesystem-expression",
    resolved_path: "preload.js",
    resolution_status: "resolved",
    limitations: [],
  });
  const mainAsset = graph.nodes.find(
    (node) =>
      node.kind === "javascript-asset" &&
      node.observations.some(
        ({ evidence }) =>
          evidence.location.available &&
          evidence.location.value.kind === "artifact-path" &&
          evidence.location.value.path === "main.js",
      ),
  );
  if (mainAsset === undefined)
    throw new Error("Expected main JavaScript asset");
  const mainSemanticNodes = semanticGraph.nodes.filter(
    ({ identity }) => identity.module_path === "main.js",
  );
  const linkedMainSemanticNodes = mainSemanticNodes.filter(
    ({ application_node_ids: identifiers }) =>
      identifiers.includes(mainAsset.node_id),
  );
  expect(linkedMainSemanticNodes.length).toBeGreaterThan(0);
  expect(linkedMainSemanticNodes.length).toBeLessThan(mainSemanticNodes.length);
  for (const role of roles) {
    expect(role).toBeDefined();
    expect(
      graph.edges.some(
        (edge) =>
          edge.source_node_id === role?.node_id && edge.relation === "maps_to",
      ),
    ).toBe(true);
  }
  const endpointJson = JSON.stringify(
    graph.nodes.filter(({ kind }) => kind === "endpoint"),
  );
  expect(endpointJson).toContain("token=fixture-secret");
};

const reconstructAsarArchive = async (
  archive: string,
  expectedNodes: readonly unknown[],
): Promise<Awaited<ReturnType<typeof reconstructJavaScriptArtifact>>> => {
  const result = await reconstructJavaScriptArtifact({
    input_path: archive,
    format: "asar",
  });
  expect(result.statistics.parsed_javascript_files).toBeGreaterThan(0);
  expect(result.graph.nodes).toEqual(
    expect.arrayContaining([...expectedNodes]),
  );
  return result;
};

const fixtureDirectory = async (): Promise<string> => {
  const root = await createTestTempDirectory("rea-javascript-artifact-");
  await writeJavaScriptArtifactFixture(root);
  return root;
};

for (const extension of ["ts", "tsx", "mts", "cts", "js", "mjs", "cjs"]) {
  it.each(["directory", "asar"] as const)(
    `retains ${extension} source facts from a real %s artifact`,
    async (format) => {
      const root = await createTestTempDirectory("rea-nodenext-artifacts-");
      const directory = join(root, "source");
      await mkdir(directory);
      const path = `selected.${extension}`;
      const parameter = ["ts", "tsx", "mts", "cts"].includes(extension)
        ? "value: string"
        : "value";
      const source = `
        globalThis.__rea_nodenext_executed = true;
        throw new Error("fixture must remain inert");
        export function selected_feature(${parameter}) { return { value }; }
      `;
      await writeFile(join(directory, path), source);
      let inputPath = directory;
      if (format === "asar") {
        inputPath = join(root, "application.asar");
        await createPackageWithOptions(directory, inputPath, {});
      }
      Reflect.deleteProperty(globalThis, "__rea_nodenext_executed");
      const result = await reconstructJavaScriptArtifact({
        input_path: inputPath,
        format,
      });
      expect(
        Reflect.get(globalThis, "__rea_nodenext_executed"),
      ).toBeUndefined();
      expect(result.statistics).toMatchObject({
        relevant_files: 1,
        parsed_javascript_files: 1,
        text_bytes_read: Buffer.byteLength(source),
        parse_failures: 0,
      });
      const asset = result.graph.nodes.find(
        ({ kind, observations }) =>
          kind === "javascript-asset" &&
          observations.some(({ properties }) => properties.path === path),
      );
      expect(asset?.identity).toMatchObject({
        sha256: createHash("sha256").update(source).digest("hex"),
      });
      expect(asset?.observations[0]?.properties).toMatchObject({
        path,
        bytes: Buffer.byteLength(source),
        file_kind: "javascript",
        parse_status: "complete",
      });
      expect(
        result.semantic_graph.nodes.some(
          ({ identity }) => identity.module_path === path,
        ),
      ).toBe(true);
      expect(result.graph.coverage).toMatchObject({
        status: "complete",
        truncated: false,
      });
    },
  );
}
