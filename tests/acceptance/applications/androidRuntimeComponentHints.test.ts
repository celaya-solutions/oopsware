import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { expect } from "vitest";

import { androidApplicationProjectionResultSchema } from "../../../src/domain/android/androidApplication.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "Android runtime hints follow classified bytecode through CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-android-runtime-hints-");
    const environment = { HOME: root, USERPROFILE: root };
    const { call } = await connectLocalToolsMcp(environment);
    for (const prefix of ["", "named"]) {
      const writer = new ZipWriter(new Uint8ArrayWriter());
      await writer.add("AndroidManifest.xml", new TextReader("fixture"));
      for (const extension of ["dex", "class"])
        await writer.add(
          `assets/${prefix}.${extension}`,
          new TextReader("ordinary text"),
        );
      const path = join(root, `${prefix || "dot-names"}.apk`);
      await writeFile(path, await writer.close());
      const inspected = await cli.run({
        arguments: ["inspect-artifact", path, "--json"],
        environment,
      });
      expect(inspected.exitCode, inspected.stderr).toBe(0);
      const source = parseEvidence(inspected.json);
      const input = { inventory_evidence: [source] };
      const projected = await cli.run({
        arguments: [
          "project-android-application-graph",
          JSON.stringify(input),
          "--json",
        ],
        environment,
      });
      expect(projected.exitCode, projected.stderr).toBe(0);
      const evidence = parseEvidence(projected.json);
      const graph = androidApplicationProjectionResultSchema.parse(
        evidence.normalized_result,
      );
      expect(graph.components.dex.map(({ path }) => path)).toEqual(
        prefix ? ["assets/named.dex"] : [],
      );
      expect(graph.components.jvm_classes.map(({ path }) => path)).toEqual(
        prefix ? ["assets/named.class"] : [],
      );
      expect(graph.runtime_families).toEqual(
        prefix ? ["dalvik-art", "java-kotlin"] : [],
      );
      const mcp = await call("project_android_application_graph", input);
      expect(mcp.isError).not.toBe(true);
      expect(parseEvidence(mcp.structuredContent)).toEqual(evidence);
    }
  },
);
