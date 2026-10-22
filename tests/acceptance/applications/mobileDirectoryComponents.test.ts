import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  TextReader,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipWriter,
} from "@zip.js/zip.js";
import { expect } from "vitest";

import { appleApplicationProjectionResultSchema } from "../../../src/domain/apple/appleApplication.js";
import { thinMach } from "../../../src/domain/binaryTarget.fixture.js";
import { androidApplicationProjectionResultSchema } from "../../../src/domain/android/androidApplication.js";
import { artifactInspectionResultSchema } from "../../../src/domain/artifactInspection.js";
import { artifactInventoryResultSchema } from "../../../src/domain/artifactGraph.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { harmonyApplicationProjectionResultSchema } from "../../../src/domain/harmony/harmonyApplication.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const harmony = {
  family: "HarmonyOS",
  extension: "hap",
  command: "project-harmony-application-graph",
  operation: "project_harmony_application_graph",
  paths: [
    "module.json",
    "ets/modules.abc",
    "libs/arm64-v8a/libflutter.so",
    "assets/main.js",
    "resources.index",
    "resources/base",
    "META-INF/TEST.p7b",
  ],
  nestedCode: "ets/modules.abc/actual.abc",
  runtimeFamilies: ["ark", "flutter", "javascript", "native"],
  nestedRuntime: "ark",
  bridgeCount: 1,
};

const fixtures = [
  {
    family: "Android",
    extension: "apk",
    command: "project-android-application-graph",
    operation: "project_android_application_graph",
    paths: [
      "AndroidManifest.xml",
      "resources.arsc",
      "classes.dex",
      "Main.class",
      "lib/arm64-v8a/libflutter.so",
      "META-INF/TEST.RSA",
    ],
    nestedCode: "classes.dex/actual.dex",
    runtimeFamilies: ["dalvik-art", "flutter", "java-kotlin", "native"],
    nestedRuntime: "dalvik-art",
    bridgeCount: 2,
  },
  {
    family: "Apple",
    extension: "ipa",
    command: "project-apple-application-graph",
    operation: "project_apple_application_graph",
    paths: [
      "Payload/Fixture.app/Info.plist",
      "Payload/Fixture.app/main.js",
      "Payload/Fixture.app/libentry.dylib",
    ],
    nestedCode: "Payload/Fixture.app/main.js/actual.js",
    runtimeFamilies: ["javascript", "native"],
    nestedRuntime: "javascript",
    bridgeCount: 1,
  },
  harmony,
  {
    ...harmony,
    family: "HarmonyOS App Pack",
    extension: "app",
    paths: [...harmony.paths, "entry.hap", "feature.hsp"],
  },
];

cliTest.for(fixtures)(
  "preserves entry kinds in $family projections through CLI and stdio MCP",
  { timeout: 60_000 },
  async (fixture, { cli }) => {
    const root = await createTestTempDirectory("rea-mobile-directory-");
    const environment = { HOME: root, USERPROFILE: root };
    const { call } = await connectLocalToolsMcp(environment);
    for (const mode of ["directories", "files", "nested"] as const) {
      const writer = new ZipWriter(new Uint8ArrayWriter());
      for (const path of fixture.paths) {
        if (mode !== "files")
          await writer.add(`${path}/`, undefined, { directory: true });
        else
          await writer.add(
            path,
            path.endsWith(".dylib")
              ? new Uint8ArrayReader(thinMach(0xfeedfacf, 0x0100000c))
              : path.endsWith(".so")
                ? new Uint8ArrayReader(
                    Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]),
                  )
                : new TextReader("opaque fixture content"),
          );
      }
      if (mode === "nested")
        await writer.add(fixture.nestedCode, new TextReader("opaque bytecode"));
      const bytes = await writer.close();
      const path = join(root, `${mode}.${fixture.extension}`);
      await writeFile(path, bytes);

      const inspected = await cli.run({
        arguments: ["inspect-artifact", path, "--json"],
        environment,
      });
      expect(inspected.exitCode, inspected.stderr).toBe(0);
      const inventoryEvidence = parseEvidence(inspected.json);
      const inspection = artifactInspectionResultSchema.parse(
        inventoryEvidence.normalized_result,
      );
      const occurrences = inspection.substeps.flatMap(
        ({ evidence }) =>
          artifactInventoryResultSchema.parse(
            parseEvidence(evidence).normalized_result,
          ).occurrences,
      );
      for (const member of fixture.paths)
        expect(occurrences, `${mode}: ${member}`).toContainEqual(
          expect.objectContaining({
            logical_path: member,
            entry_kind: mode === "files" ? "file" : "directory",
            ...(mode === "files" ? {} : { artifact_format: "directory" }),
          }),
        );

      const input = { inventory_evidence: [inventoryEvidence] };
      const originalInput = JSON.stringify(input);
      const projected = await cli.run({
        arguments: [fixture.command, originalInput, "--json"],
        environment,
      });
      expect(projected.exitCode, projected.stderr).toBe(0);
      const evidence = parseEvidence(projected.json);
      const mcp = await call(fixture.operation, input);
      expect(mcp.isError, JSON.stringify(mcp)).not.toBe(true);
      expect(parseEvidence(mcp.structuredContent)).toEqual(evidence);
      expect(JSON.stringify(input)).toBe(originalInput);

      const projection =
        fixture.extension === "apk"
          ? androidApplicationProjectionResultSchema.parse(
              evidence.normalized_result,
            )
          : fixture.extension === "ipa"
            ? appleApplicationProjectionResultSchema.parse(
                evidence.normalized_result,
              )
            : harmonyApplicationProjectionResultSchema.parse(
                evidence.normalized_result,
              );
      const childPackages = fixture.paths.filter((member) =>
        /\.(?:hap|hsp)$/u.test(member),
      );
      const categories = Object.values(projection.components);
      for (const category of categories)
        expect(new Set(category.map(({ path }) => path)).size).toBe(
          category.length,
        );
      const componentPaths = [
        ...new Set(categories.flat().map((component) => component.path)),
      ].sort();
      expect(componentPaths, mode).toEqual(
        mode === "files"
          ? fixture.paths
              .filter((member) => !childPackages.includes(member))
              .sort()
          : mode === "nested"
            ? [fixture.nestedCode]
            : [],
      );
      expect(projection.runtime_families, mode).toEqual(
        mode === "files"
          ? fixture.runtimeFamilies
          : mode === "nested"
            ? [fixture.nestedRuntime]
            : [],
      );
      expect(projection.bridge_candidates, mode).toHaveLength(
        mode === "files" ? fixture.bridgeCount : 0,
      );
      expect(projection.source_evidence_ids).toEqual([
        inventoryEvidence.evidence_id,
      ]);
      expect(projection.coverage).toEqual({
        status: "complete-within-inventory",
        inventory_complete: true,
      });
      if ("packaging_model" in projection) {
        expect(projection.packaging_model, mode).toBe(
          mode === "files" ? "stage" : "unknown",
        );
        expect(projection.app_pack_children.map((child) => child.path)).toEqual(
          mode === "files" ? childPackages : [],
        );
      }
      expect(await readFile(path)).toEqual(Buffer.from(bytes));
    }
  },
);
