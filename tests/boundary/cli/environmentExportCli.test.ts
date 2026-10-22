import {
  mkdir,
  readdir,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, sep } from "node:path";

import { describe, expect } from "vitest";

import {
  analysisViewCaptureEvidence,
  analysisViewCaptureFixture,
} from "../../fixtures/analysisView.js";
import {
  environmentServeFixture,
  writeEnvironmentServeFiles,
} from "../../fixtures/environmentServe.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "returns a tagged JSON error when a read input descriptor cannot be closed",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-export-input-close-cli-");
    const files = await writeEnvironmentServeFiles(root);
    const preload = join(root, "fail-close.mjs");
    await writeFile(
      preload,
      `import fs from 'node:fs';\nimport { syncBuiltinESMExports } from 'node:module';\nconst original = fs.promises.open;\nfs.promises.open = async (...args) => {\n  const handle = await original(...args);\n  if (args[0] === ${JSON.stringify(files.manifestPath)}) handle.close = async () => { throw Object.assign(new Error('controlled persistent close failure'), { code: 'EIO' }); };\n  return handle;\n};\nsyncBuiltinESMExports();\n`,
    );
    const directory = join(root, "bundle");
    const result = await cli.run({
      arguments: [
        "environment-export",
        files.manifestPath,
        "--evidence",
        files.capturePath,
        directory,
        "--json",
      ],
      environment: {
        NODE_OPTIONS: `--import=${preload} --max-old-space-size=768`,
        NODE_DISABLE_COMPILE_CACHE: "1",
      },
      timeoutMs: 30_000,
    });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      details: { operation: "environment-export" },
    });
    expect(JSON.stringify(result.json)).toContain("cleanup");
    await expect(readFile(join(directory, "README.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

const BUNDLE_FILES = [
  "README.md",
  "artifacts/check_grafana-example/verify.py",
  "envs/grafana-example/Dockerfile",
  "envs/grafana-example/env.toml",
  "envs/grafana-example/evidence.json",
  "envs/grafana-example/manifest.json",
  "tasks/smoke.json",
];

describe("rea environment-export", () => {
  cliTest(
    "writes the bundle folder from the fixture pair and prints the written files with sizes",
    async ({ cli }) => {
      const root = await createTestTempDirectory("rea-environment-export-cli-");
      const files = await writeEnvironmentServeFiles(root);
      const directory = join(root, "bundle");
      const result = await cli.run({
        arguments: [
          "environment-export",
          files.manifestPath,
          "--evidence",
          files.capturePath,
          directory,
          "--json",
        ],
        timeoutMs: 30_000,
      });
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.json).toMatchObject({
        status: "exported",
        directory,
        name: "grafana-example",
        tool_count: 19,
        package_source: { kind: "registry" },
      });
      const document = result.json as {
        files: { path: string; bytes: number }[];
      };
      expect(document.files.map((file) => file.path).sort()).toEqual(
        BUNDLE_FILES,
      );
      const written = (
        await readdir(directory, { recursive: true, withFileTypes: true })
      )
        .filter((entry) => entry.isFile())
        .map((entry) =>
          join(entry.parentPath, entry.name)
            .slice(directory.length + 1)
            .split(sep)
            .join("/"),
        )
        .sort();
      expect(written).toEqual(BUNDLE_FILES);
      expect(
        await readFile(join(directory, "envs/grafana-example/manifest.json")),
      ).toEqual(await readFile(files.manifestPath));
      expect(
        await readFile(join(directory, "envs/grafana-example/evidence.json")),
      ).toEqual(await readFile(files.capturePath));
      const dockerfile = await readFile(
        join(directory, "envs/grafana-example/Dockerfile"),
        "utf8",
      );
      expect(dockerfile).toMatch(/^FROM node:24\.18\.0-bookworm-slim\n/u);
      expect(dockerfile).toContain('CMD ["rea","environment-serve"');
    },
  );

  cliTest(
    "refuses a non-empty directory with a typed invalid request and leaves it unchanged",
    async ({ cli }) => {
      const root = await createTestTempDirectory(
        "rea-environment-export-busy-",
      );
      const files = await writeEnvironmentServeFiles(root);
      const directory = join(root, "occupied");
      await mkdir(directory);
      await writeFile(join(directory, "notes.txt"), "keep");
      const result = await cli.run({
        arguments: [
          "environment-export",
          files.manifestPath,
          "--evidence",
          files.capturePath,
          directory,
          "--json",
        ],
        timeoutMs: 30_000,
      });
      expect(result.exitCode).toBe(1);
      expect(result.json).toMatchObject({
        error: "Application workflow failed",
        code: "invalid_request",
        category: "invalid_input",
        details: {
          operation: "environment-export",
          issues: [{ path: ["directory"], reason: "invalid_value" }],
        },
      });
      expect(result.stdout).toContain("not empty");
      expect(await readdir(directory)).toEqual(["notes.txt"]);
    },
  );

  cliTest(
    "refuses a manifest whose parent is not the supplied evidence before creating the directory",
    async ({ cli }) => {
      const root = await createTestTempDirectory(
        "rea-environment-export-mismatch-",
      );
      const files = await writeEnvironmentServeFiles(
        root,
        environmentServeFixture(),
      );
      const other = join(root, "other.json");
      await writeFile(
        other,
        JSON.stringify(
          analysisViewCaptureEvidence(analysisViewCaptureFixture()),
        ),
      );
      const directory = join(root, "bundle");
      const result = await cli.run({
        arguments: [
          "environment-export",
          files.manifestPath,
          "--evidence",
          other,
          directory,
          "--json",
        ],
        timeoutMs: 30_000,
      });
      expect(result.exitCode).toBe(1);
      expect(result.json).toMatchObject({
        error: "Application workflow failed",
        code: "invalid_request",
        details: {
          operation: "environment-export",
          issues: [{ path: ["evidence", "evidence_id"] }],
        },
      });
      expect(result.stdout).toContain("different capture");
      expect(await readdir(root)).not.toContain("bundle");
    },
  );
});

cliTest.skipIf(process.platform === "win32")(
  "produces readable private files independently of an owner-read-masking umask",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-export-umask-");
    const files = await writeEnvironmentServeFiles(root);
    const preload = join(root, "umask.mjs");
    await writeFile(preload, "process.umask(0o400);\n");
    const directory = join(root, "bundle");
    const result = await cli.run({
      arguments: [
        "environment-export",
        files.manifestPath,
        "--evidence",
        files.capturePath,
        directory,
        "--json",
      ],
      environment: {
        NODE_OPTIONS: `--import=${preload} --max-old-space-size=768`,
        NODE_DISABLE_COMPILE_CACHE: "1",
      },
      timeoutMs: 30_000,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    for (const relative of BUNDLE_FILES) {
      expect((await stat(join(directory, relative))).mode & 0o777).toBe(0o600);
      expect(
        (await readFile(join(directory, relative))).length,
      ).toBeGreaterThan(0);
    }
    expect(
      await readFile(join(directory, "envs/grafana-example/evidence.json")),
    ).toEqual(await readFile(files.capturePath));
  },
);

cliTest.skipIf(process.platform === "win32")(
  "preserves the filesystem meaning of symlink/.. for the destination and tarball",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-export-selected-path-");
    const physical = join(root, "physical");
    const nested = join(physical, "nested");
    await mkdir(nested, { recursive: true });
    await symlink(nested, join(root, "link"), "dir");
    const files = await writeEnvironmentServeFiles(root);
    const bytes = Buffer.from("selected packed package");
    await writeFile(join(physical, "package.tgz"), bytes);
    const directory = `${root}/link/../bundle`;
    const packagePath = `${root}/link/../package.tgz`;
    const result = await cli.run({
      arguments: [
        "environment-export",
        files.manifestPath,
        "--evidence",
        files.capturePath,
        directory,
        "--package-tarball",
        packagePath,
        "--json",
      ],
      timeoutMs: 30_000,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.json).toMatchObject({
      directory,
      package_source: { kind: "tarball", path: packagePath },
    });
    expect(
      await readFile(
        join(physical, "bundle/envs/grafana-example/rea-agents.tgz"),
      ),
    ).toEqual(bytes);
    await expect(
      readFile(join(root, "bundle/README.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  },
);
