import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import {
  ANDROID_APPLICATION_GRAPH_EXAMPLE,
  APPLE_APPLICATION_GRAPH_EXAMPLE,
  HARMONY_APPLICATION_GRAPH_EXAMPLE,
  MACOS_APPLICATION_GRAPH_EXAMPLE,
} from "../../../src/contracts/mobileApplicationGraphExamples.js";
import { createEvidence, parseEvidence } from "../../../src/domain/evidence.js";
import { artifactInventoryResultSchema } from "../../../src/domain/artifactGraph.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest.for([
  {
    name: "Android",
    command: "project-android-application-graph",
    operation: "project_android_application_graph",
    example: ANDROID_APPLICATION_GRAPH_EXAMPLE,
  },
  {
    name: "IPA",
    command: "project-apple-application-graph",
    operation: "project_apple_application_graph",
    example: APPLE_APPLICATION_GRAPH_EXAMPLE,
  },
  {
    name: "macOS",
    command: "project-apple-application-graph",
    operation: "project_apple_application_graph",
    example: MACOS_APPLICATION_GRAPH_EXAMPLE,
  },
  {
    name: "Harmony",
    command: "project-harmony-application-graph",
    operation: "project_harmony_application_graph",
    example: HARMONY_APPLICATION_GRAPH_EXAMPLE,
  },
] as const)(
  "CLI executes the canonical $name graph example without target files",
  async ({ command, operation, example }, { cli }) => {
    const root = await createTestTempDirectory("rea-mobile-graph-example-");
    const input = JSON.stringify(example);
    const path = join(root, "example.json");
    await writeFile(path, input);
    for (const argument of [input, path]) {
      const result = await cli.run({
        arguments: [command, argument, "--json"],
        cwd: root,
      });
      expect(result.exitCode, result.stdout).toBe(0);
      const evidence = parseEvidence(result.json);
      expect(evidence.operation).toBe(operation);
      expect(evidence.normalized_result).toMatchObject({
        coverage: { status: "partial", inventory_complete: true },
      });
    }
  },
);

cliTest(
  "CLI still rejects an unsupported inventory coverage status",
  async ({ cli }) => {
    const original = ANDROID_APPLICATION_GRAPH_EXAMPLE.inventory_evidence[0]!;
    const inventory = artifactInventoryResultSchema.parse(
      original.normalized_result,
    );
    const evidence = createEvidence(
      { path: "Fixture.apk", sha256: "a".repeat(64), format: "apk" },
      original.provider,
      {
        operation: "inventory_artifact",
        parameters: {},
        result: {
          ...inventory,
          coverage: { scope: "root", status: "invalid" },
        },
        confidence: "observed",
        authority: "shipped-artifact",
      },
    );
    const result = await cli.run({
      arguments: [
        "project-android-application-graph",
        JSON.stringify({ inventory_evidence: [evidence] }),
        "--json",
      ],
    });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      code: "invalid_request",
      details: {
        operation: "project_android_application_graph",
        issues: expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringContaining("coverage.status"),
          }),
        ]),
      },
    });
  },
);
