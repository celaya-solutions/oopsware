import { accessSync, constants, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { expect, it } from "vitest";

import { defaultHopperLauncherPath } from "../../../src/config/parseConfig.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

// A real system installation legitimately precedes this isolated user fixture.
const installedSystemHopper = (home: string): boolean => {
  try {
    const launcher = defaultHopperLauncherPath("darwin", home);
    accessSync(launcher, constants.X_OK);
    return statSync(launcher).isFile();
  } catch {
    return false;
  }
};

it.for(["Hopper Disassembler.app", "Hopper A.app"])(
  "skips a directory launcher in %s and selects a real file",
  async (name, context) => {
    const home = await createTestTempDirectory("rea-hopper-selection-");
    if (installedSystemHopper(home)) context.skip();
    const invalid = join(home, "Applications", name, "Contents/MacOS/hopper");
    const valid = join(home, "Applications/Hopper Z.app/Contents/MacOS/hopper");
    await mkdir(invalid, { recursive: true });
    await mkdir(dirname(valid), { recursive: true });
    await writeFile(valid, "#!/bin/sh\nexit 0\n", { mode: 0o700 });

    expect(defaultHopperLauncherPath("darwin", home)).toBe(valid);
  },
);
