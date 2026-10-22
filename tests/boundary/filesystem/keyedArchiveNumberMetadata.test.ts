import { expect, it } from "vitest";

import { inspectBundleKeyedArchive } from "../../../src/artifacts/apple/KeyedArchiveReader.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { keyedArchiveWideIntegerFixture } from "../../fixtures/keyedArchiveWideIntegers.js";
import {
  archiveNumberMetadataCases,
  expectKeyedArchiveNumberMetadata,
  keyedArchiveNumberMetadataFixture,
} from "../../fixtures/keyedArchiveNumberMetadata.js";
import { cliTest } from "../../support/cli/cliFixture.js";

it("preserves 16-byte binary integers and adjacent 64-bit integer metadata", async () => {
  const fixture = await keyedArchiveWideIntegerFixture();
  const result = await inspectBundleKeyedArchive({
    bundlePath: fixture.root,
    targetSha256: fixture.digest,
    parameters: { path: "archive.bin" },
  });
  expect(result.archive_sha256).toBe(fixture.digest);
  expect(result.objects).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 1,
        kind: "scalar",
        status: "observed",
        value: {
          $plist_type: "integer",
          decimal: "18446744073709551615",
        },
      }),
      expect.objectContaining({
        id: 2,
        kind: "scalar",
        status: "observed",
        value: {
          $plist_type: "integer",
          decimal: "9223372036854775807",
        },
      }),
    ]),
  );
  expect(result.limitations).not.toContainEqual(
    expect.stringMatching(/metadata could not be completely observed/u),
  );
});

cliTest(
  "compiled CLI preserves 16-byte binary archive integers",
  async ({ cli }) => {
    const fixture = await keyedArchiveWideIntegerFixture();
    const output = await cli.run({
      arguments: ["inspect-keyed-archive", fixture.path, "--json"],
      environment: { REA_LOG_LEVEL: "silent", REA_ANALYSIS_PROVIDER: "auto" },
    });
    expect(output.exitCode, output.stderr).toBe(0);
    expect(parseEvidence(output.json).normalized_result).toMatchObject({
      objects: expect.arrayContaining([
        expect.objectContaining({
          id: 1,
          value: {
            $plist_type: "integer",
            decimal: "18446744073709551615",
          },
        }),
        expect.objectContaining({
          id: 2,
          value: {
            $plist_type: "integer",
            decimal: "9223372036854775807",
          },
        }),
      ]),
    });
  },
);

it.each(archiveNumberMetadataCases)(
  "filesystem preserves numeric meaning for $name",
  async (item) => {
    const fixture = await keyedArchiveNumberMetadataFixture(item);
    const result = await inspectBundleKeyedArchive({
      bundlePath: fixture.root,
      targetSha256: fixture.digest,
      parameters: { path: "archive.plist" },
    });
    expectKeyedArchiveNumberMetadata(result, item, fixture.digest);
  },
);

cliTest.for(archiveNumberMetadataCases)(
  "built CLI preserves numeric meaning for $name",
  async (item, { cli }) => {
    const fixture = await keyedArchiveNumberMetadataFixture(item);
    const output = await cli.run({
      arguments: ["inspect-keyed-archive", fixture.path, "--json"],
      environment: { REA_LOG_LEVEL: "silent", REA_ANALYSIS_PROVIDER: "auto" },
    });
    expectKeyedArchiveNumberMetadata(
      parseEvidence(output.json).normalized_result,
      item,
      fixture.digest,
    );
  },
);
