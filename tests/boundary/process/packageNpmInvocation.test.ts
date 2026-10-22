import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);

it("runs the caller-selected npm entry through Node without rewriting its inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-npm-invocation-"));
  try {
    const npmEntry = join(root, "selected npm entry.mjs");
    await writeFile(
      npmEntry,
      `process.stdout.write(JSON.stringify({ arguments: process.argv.slice(2), cwd: process.cwd(), marker: process.env.REA_NPM_TEST_MARKER }));\n`,
    );
    const helper = pathToFileURL(
      resolve("scripts/lib/verify-package-core.mjs"),
    ).href;
    const program = `
      const { execNpm } = await import(${JSON.stringify(helper)});
      const result = await execNpm(["pack", "value with spaces"], {
        cwd: ${JSON.stringify(root)},
        env: { ...process.env, npm_execpath: ${JSON.stringify(npmEntry)}, REA_NPM_TEST_MARKER: "caller-selected" },
      });
      process.stdout.write(result.stdout);
    `;
    const result = await execute(
      process.execPath,
      ["--input-type=module", "--eval", program],
      { windowsHide: true },
    );
    expect(JSON.parse(result.stdout)).toEqual({
      arguments: ["pack", "value with spaces"],
      cwd: root,
      marker: "caller-selected",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const windowsIt = process.platform === "win32" ? it : it.skip;

windowsIt(
  "uses the npm entry adjacent to Node when none is selected",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-adjacent-npm-"));
    try {
      const node = join(root, "node.exe");
      const npmEntry = join(root, "node_modules/npm/bin/npm-cli.js");
      await mkdir(dirname(npmEntry), { recursive: true });
      await Promise.all([
        copyFile(process.execPath, node),
        writeFile(
          npmEntry,
          `process.stdout.write(JSON.stringify({ arguments: process.argv.slice(2), cwd: process.cwd() }));\n`,
        ),
      ]);
      const helper = pathToFileURL(
        resolve("scripts/lib/verify-package-core.mjs"),
      ).href;
      const program = `
      const { execNpm } = await import(${JSON.stringify(helper)});
      const environment = { ...process.env };
      delete environment.npm_execpath;
      const result = await execNpm(["pack", "value with spaces"], {
        cwd: ${JSON.stringify(root)},
        env: environment,
      });
      process.stdout.write(result.stdout);
    `;
      const environment = { ...process.env };
      delete environment.npm_execpath;
      const result = await execute(
        node,
        ["--input-type=module", "--eval", program],
        { env: environment, windowsHide: true },
      );
      expect(JSON.parse(result.stdout)).toEqual({
        arguments: ["pack", "value with spaces"],
        cwd: root,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
