import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { thinMach, elf } from "../../../src/domain/binaryTarget.fixture.js";

cliTest(
  "parses explicit native pairs from JSON and validates targets before starting providers",
  async ({ cli }) => {
    const directory = await createTestTempDirectory("rea-native-version-cli-");
    const left = join(directory, "left"),
      right = join(directory, "right");
    await writeFile(left, thinMach(0xcffaedfe, 0x0100000c));
    await writeFile(right, elf(2, 1, 62));
    const result = await cli.run({
      arguments: [
        "compare-native-versions",
        left,
        right,
        "--selected-pairs",
        '[{"left_address":"0x1000","right_address":"0x2000"}]',
        "--json",
      ],
    });
    expect(result.json).toMatchObject({ code: "unsupported_target" });
    expect(JSON.stringify(result.json)).toContain(
      "same format and architecture",
    );
    const malformed = await cli.run({
      arguments: [
        "compare-native-versions",
        left,
        right,
        "--selected-pairs",
        '[{"left_address":7,"right_address":"0x2000"}]',
        "--json",
      ],
    });
    expect(malformed.json).toMatchObject({ code: "invalid_request" });
  },
);
