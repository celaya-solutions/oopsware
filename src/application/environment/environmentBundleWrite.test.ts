import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import {
  environmentServeSource,
  writeEnvironmentServeFiles,
} from "../../../tests/fixtures/environmentServe.js";
import { SafeOutputTree } from "../../artifacts/SafeOutputTree.js";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import {
  exportEnvironmentBundle,
  readEnvironmentExportInputs,
} from "./environmentExport.js";

it("retains the admitted tarball descriptor and refuses a pathname replacement during output", async () => {
  const root = await createTestTempDirectory("rea-tarball-instance-");
  const files = await writeEnvironmentServeFiles(root);
  const inputs = await readEnvironmentExportInputs(
    files.manifestPath,
    files.capturePath,
  );
  if (!inputs.ok) throw inputs.error;
  const tarball = join(root, "package.tgz");
  const originalBytes = Buffer.from("original admitted package");
  await writeFile(tarball, originalBytes);
  const directory = join(root, "bundle");
  const original = SafeOutputTree.prototype.write;
  let replaced = false;
  const writer = vi
    .spyOn(SafeOutputTree.prototype, "write")
    .mockImplementation(async function (
      this: SafeOutputTree,
      ...args: Parameters<SafeOutputTree["write"]>
    ) {
      const result = await original.apply(this, args);
      if (!replaced) {
        replaced = true;
        await rename(tarball, join(root, "admitted.tgz"));
        await writeFile(tarball, "replacement package");
      }
      return result;
    });
  try {
    const result = await exportEnvironmentBundle({
      ...inputs.value,
      source: environmentServeSource(),
      directory,
      packageTarball: tarball,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisArtifactChangedError", path: tarball },
    });
    expect(
      await readFile(join(directory, "envs/grafana-example/rea-agents.tgz")),
    ).toEqual(originalBytes);
  } finally {
    writer.mockRestore();
  }
});

it("uses confirmed publication after the output owner's descriptor cleanup completes", async () => {
  const root = await createTestTempDirectory("rea-bundle-published-");
  const files = await writeEnvironmentServeFiles(root);
  const inputs = await readEnvironmentExportInputs(
    files.manifestPath,
    files.capturePath,
  );
  if (!inputs.ok) throw inputs.error;
  const directory = join(root, "bundle");
  const original = SafeOutputTree.prototype.commit;
  const commit = vi
    .spyOn(SafeOutputTree.prototype, "commit")
    .mockImplementation(async function (this: SafeOutputTree, ...args) {
      await original.apply(this, args);
      throw new ArtifactReaderFailure(
        "unavailable",
        "controlled post-publication close failure",
        {
          cleanup: {
            reason: "controlled directory close failure",
            resources: [directory],
          },
        },
      );
    });
  try {
    const result = await exportEnvironmentBundle({
      ...inputs.value,
      source: environmentServeSource(),
      directory,
    });
    expect(result).toMatchObject({ ok: true, value: { status: "exported" } });
    expect(
      await readFile(join(directory, "envs/grafana-example/evidence.json")),
    ).toEqual(inputs.value.evidence.bytes);
  } finally {
    commit.mockRestore();
  }
});

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "returns a tagged permission refusal for an existing read-only empty directory",
  async () => {
    const root = await createTestTempDirectory("rea-bundle-readonly-");
    const files = await writeEnvironmentServeFiles(root);
    const inputs = await readEnvironmentExportInputs(
      files.manifestPath,
      files.capturePath,
    );
    if (!inputs.ok) throw inputs.error;
    const directory = join(root, "bundle");
    await mkdir(directory, { mode: 0o500 });
    try {
      const result = await exportEnvironmentBundle({
        ...inputs.value,
        source: environmentServeSource(),
        directory,
      });
      expect(result).toMatchObject({
        ok: false,
        error: {
          _tag: "AnalysisAccessDeniedError",
          operation: "environment-export",
        },
      });
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await chmod(directory, 0o700);
    }
  },
);

it
  .skipIf(process.platform === "win32")
  .each(["replace-root", "foreign-entry", "symlink-parent"] as const)(
  "refuses publication after an actual output transition: %s",
  async (transition) => {
    const root = await createTestTempDirectory("rea-bundle-output-transition-");
    const files = await writeEnvironmentServeFiles(root);
    const inputs = await readEnvironmentExportInputs(
      files.manifestPath,
      files.capturePath,
    );
    if (!inputs.ok) throw inputs.error;
    const directory = join(root, "bundle");
    const foreign = join(root, "foreign");
    await mkdir(foreign);
    const original = SafeOutputTree.prototype.write;
    let changed = false;
    const writer = vi
      .spyOn(SafeOutputTree.prototype, "write")
      .mockImplementation(async function (
        this: SafeOutputTree,
        ...args: Parameters<SafeOutputTree["write"]>
      ) {
        const result = await original.apply(this, args);
        if (!changed) {
          changed = true;
          if (transition === "replace-root") {
            await rename(directory, join(root, "moved"));
            await mkdir(directory);
            await writeFile(join(directory, "foreign.txt"), "keep");
          } else if (transition === "foreign-entry") {
            await writeFile(join(directory, "foreign.txt"), "keep");
          } else {
            await symlink(foreign, join(directory, "envs"), "dir");
          }
        }
        return result;
      });
    try {
      const result = await exportEnvironmentBundle({
        ...inputs.value,
        source: environmentServeSource(),
        directory,
      });
      expect(changed).toBe(true);
      expect(result).toMatchObject({
        ok: false,
        error: { operation: "environment-export" },
      });
      expect(await readdir(foreign)).toEqual([]);
      if (transition !== "symlink-parent")
        expect(await readFile(join(directory, "foreign.txt"), "utf8")).toBe(
          "keep",
        );
    } finally {
      writer.mockRestore();
    }
  },
);
