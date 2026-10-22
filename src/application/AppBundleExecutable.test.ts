import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { resolveAppBundleExecutable } from "./AppBundleExecutable.js";

it.each([
  ["macOS", ["Contents"], ["Contents", "MacOS"]],
  ["iOS", [], []],
] as const)(
  "resolves the %s bundle layout when Info.plist contains processing instructions",
  async (_kind, plistDirectory, programDirectory) => {
    const root = await createTestTempDirectory("rea-app-plist-pi-");
    const bundle = join(root, "Fixture.app");
    const plistPath = join(bundle, ...plistDirectory, "Info.plist");
    const executable = join(bundle, ...programDirectory, "Fixture");
    await mkdir(join(bundle, ...plistDirectory), { recursive: true });
    await mkdir(join(bundle, ...programDirectory), { recursive: true });
    await writeFile(
      plistPath,
      '<plist version="1.0"><?rea ignored?><dict><?rea ignored?><key>CFBundleExecutable</key><?rea ignored?><string>Fixture</string><?rea ignored?></dict><?rea ignored?></plist>',
    );
    await writeFile(executable, "inert fixture; never executed");

    const result = await resolveAppBundleExecutable(bundle);
    expect(result).toEqual({
      ok: true,
      value: { executable, infoPlist: plistPath },
    });
  },
);

describe("app bundle Info.plist magic", () => {
  it("does not decode a high-bit fold of bplist as a binary Info.plist", async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-bplist-fold-"));
    try {
      const bundle = join(root, "Fixture.app");
      const plistPath = join(bundle, "Contents", "Info.plist");
      await mkdir(join(bundle, "Contents"), { recursive: true });
      const plist = Buffer.from("bplist00");
      plist[0] = (plist[0] ?? 0) | 0x80;
      await writeFile(plistPath, plist);
      let decoded = false;
      const result = await resolveAppBundleExecutable(bundle, {
        readFile: async () => plist,
        realpath: async (path) => path,
        decodeBinaryPlist: async () => {
          decoded = true;
          return "Fixture";
        },
      });
      expect(decoded).toBe(false);
      expect(result.ok).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("app bundle program directory containment", () => {
  it("rejects an escaping programs directory before resolving its child", async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-app-programs-"));
    try {
      const bundle = join(root, "Fixture.app");
      const programs = join(bundle, "Contents", "MacOS");
      const executable = join(programs, "Missing");
      const canonicalBundle = join(root, "Canonical.app");
      const outsidePrograms = join(root, "outside");
      const plist =
        "<plist><dict><key>CFBundleExecutable</key><string>Missing</string></dict></plist>";
      await mkdir(join(bundle, "Contents"), { recursive: true });
      await writeFile(join(bundle, "Contents", "Info.plist"), plist);
      let childResolved = false;

      const result = await resolveAppBundleExecutable(bundle, {
        readFile: async () => Buffer.from(plist),
        realpath: async (path) => {
          if (path === bundle) return canonicalBundle;
          if (path === programs) return outsidePrograms;
          if (path === executable) {
            childResolved = true;
            throw Object.assign(new Error("missing executable"), {
              code: "ENOENT",
            });
          }
          return path;
        },
      });

      expect(result).toMatchObject({
        ok: false,
        error: {
          reason: "app program directory leaves Contents/MacOS",
        },
      });
      expect(childResolved).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
