import { afterEach, expect, it } from "vitest";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "../../../src/web/Workspace.js";
import {
  targetArguments,
  targetSupport,
} from "../../../web/src/targetSupport.js";
import { createWebToolCatalog } from "../../../src/web/WebToolCatalog.js";
import { z } from "zod";

const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true });
});

it("uses observed native headers for extensionless and misleadingly named files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rea-support-"));
  directories.push(directory);
  const workspace = new Workspace({});
  for (const name of ["program", "renamed.apk"]) {
    const path = join(directory, name);
    await copyFile(process.execPath, path);
    const target = await workspace.view(path);
    const support = targetSupport(target);
    expect(support.basis).toBe("Executable header observed");
    expect(support.actions.map((action) => action.tool)).toContain(
      "open_binary",
    );
    expect(support.actions.map((action) => action.tool)).not.toContain(
      "inspect_android_package",
    );
  }
});

it("keeps unsupported Android entry points useful without offering APK decompilation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rea-support-"));
  directories.push(directory);
  const workspace = new Workspace({});
  for (const name of [
    "example.aab",
    "example.apks",
    "example.xapk",
    "example.dex",
  ]) {
    const path = join(directory, name);
    await writeFile(
      path,
      name.endsWith(".dex")
        ? "dex\n039\0fixture"
        : "PK\x05\x06" + "\0".repeat(18),
    );
    const target = await workspace.view(path);
    const support = targetSupport(target);
    expect(target.preview?.bytes).toBeGreaterThan(0);
    expect(support.actions.map((action) => action.tool)).toEqual([
      "inspect_artifact",
    ]);
    expect(support.note).toContain("standalone APK");
  }
});

it("prefills canonical single-target inputs while leaving paired inputs and explicit choices alone", async () => {
  const target = await new Workspace({}).view(process.execPath);
  const catalog = z
    .array(
      z.object({
        name: z.string(),
        inputSchema: z.record(z.string(), z.json()),
      }),
    )
    .parse(await createWebToolCatalog());
  const android = catalog.find(
    (tool) => tool.name === "inspect_android_package",
  );
  const comparison = catalog.find(
    (tool) => tool.name === "compare_native_versions",
  );
  if (!android || !comparison)
    throw new Error("Expected canonical tools are missing");
  expect(targetArguments(android, target)).toEqual({ path: target.path });
  expect(
    targetArguments(android, target, { path: "/chosen/Other.apk" }),
  ).toEqual({ path: "/chosen/Other.apk" });
  expect(targetArguments(comparison, target)).toEqual({});
  const outputTool = catalog.find(
    (tool) => tool.name === "export_evidence_bundle",
  );
  if (!outputTool) throw new Error("Expected export tool is missing");
  expect(targetArguments(outputTool, target)).toEqual({});
});
