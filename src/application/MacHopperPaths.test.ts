import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  macHopperCanonicalLauncherCandidates,
  macHopperLauncherCandidates,
  macHopperRenamedLauncherCandidates,
} from "./MacHopperPaths.js";

describe("macOS Hopper launcher paths", () => {
  const home = "/fixture/home";

  it("keeps canonical system and user candidates ahead of renamed bundles", () => {
    expect(macHopperCanonicalLauncherCandidates(home)).toEqual([
      "/Applications/Hopper Disassembler.app/Contents/MacOS/hopper",
      "/fixture/home/Applications/Hopper Disassembler.app/Contents/MacOS/hopper",
    ]);
    expect(
      macHopperRenamedLauncherCandidates(
        home,
        new Map([
          [
            "/Applications",
            ["Hopper z.app", "Hopper a.app", "Hopper Disassembler.app"],
          ],
          ["/fixture/home/Applications", ["Hopper User.app"]],
        ]),
      ),
    ).toEqual([
      "/Applications/Hopper a.app/Contents/MacOS/hopper",
      "/Applications/Hopper z.app/Contents/MacOS/hopper",
      "/fixture/home/Applications/Hopper User.app/Contents/MacOS/hopper",
    ]);
  });

  it("always includes the installer's canonical user destination", () => {
    expect(macHopperLauncherCandidates(home)).toContain(
      "/fixture/home/Applications/Hopper Disassembler.app/Contents/MacOS/hopper",
    );
  });

  it("finds renamed user bundles through the runtime filesystem scan", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "rea-hopper-paths-"));
    const appDirectory = join(temporary, "Applications", "Hopper Preview.app");
    try {
      await mkdir(appDirectory, { recursive: true });
      expect([...macHopperLauncherCandidates(temporary)]).toContain(
        join(appDirectory, "Contents/MacOS/hopper"),
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
