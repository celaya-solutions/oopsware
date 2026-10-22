import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect } from "vitest";

import { thinMach } from "../../../src/domain/binaryTarget.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

// An unknown standing provider stops native analysis before any engine runs.
const environment = {
  REA_LOG_LEVEL: "silent",
  REA_ANALYSIS_PROVIDER: "missing-provider",
} as const;

const fixtureApp = async () => {
  const directory = await createTestTempDirectory("rea-analyze-app-path-");
  const contents = join(directory, "Sample.app", "Contents");
  await mkdir(join(contents, "MacOS"), { recursive: true });
  await writeFile(
    join(contents, "MacOS/Sample"),
    thinMach(0xfeedfacf, 0x100000c),
  );
  await writeFile(
    join(contents, "Info.plist"),
    "<plist><dict><key>CFBundleExecutable</key><string>Sample</string></dict></plist>",
  );
  return directory;
};

describe("analyze app bundle path spellings", () => {
  cliTest.for(["Sample.app", "Sample.app/", "Sample.app/.", "Sample.app//"])(
    "routes %s to native provider selection",
    async (path, { cli }) => {
      const cwd = await fixtureApp();
      const result = await cli.run({
        arguments: ["analyze", path, "--json"],
        cwd,
        environment,
      });
      expect(result.exitCode).toBe(1);
      expect(result.json).toMatchObject({
        code: "capability_unavailable",
        details: {
          operation: "open_binary",
          selection_reason: "unknown_provider",
          requested_provider_id: "missing-provider",
        },
      });
    },
  );
});
