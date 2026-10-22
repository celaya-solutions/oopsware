import { copyFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect } from "vitest";

import { workspaceCliTest } from "../../support/cli/workspaceCliFixture.js";

describe("executable dispatcher", () => {
  workspaceCliTest(
    "does not append recovery output after delegated stdout has begun",
    async ({ processes, workspace }) => {
      await workspace.mkdir("scripts");
      await workspace.mkdir("dist/cli-runtime");
      await Promise.all([
        copyFile("scripts/rea.mjs", workspace.path("scripts/rea.mjs")),
        workspace.write(
          "package.json",
          JSON.stringify({ type: "module", version: "1.0.0" }),
        ),
        workspace.write(
          "dist/cli-runtime/cli.js",
          'export const cliConfigurationError = () => undefined; export const createCli = () => ({ serve: (_args, options) => { options.stdout("first document\\n"); throw new RangeError("Invalid string length"); } });\n',
        ),
        workspace.write(
          "dist/cli-runtime/cliOutput.js",
          "export const normalizeCliArguments = (args) => args; export const validateCliOutputArguments = () => ({ ok: true }); export const renderCliOutputArgumentError = () => ''; export const renderEmptyFilteredCliOutput = () => undefined;\n",
        ),
        workspace.write(
          "dist/cli-runtime/cliResultOutput.js",
          'export const createCliResultOutput = () => ({ handled: false, failed: false, recoverFormattingFailure: () => { process.stdout.write("unexpected second document"); return true; } });\n',
        ),
      ]);
      const result = await processes.run(
        process.execPath,
        [workspace.path("scripts/rea.mjs"), "fixture"],
        { cwd: workspace.root },
      );
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("first document\n");
      expect(result.stderr).toContain("RangeError: Invalid string length");
    },
  );

  workspaceCliTest(
    "reserves production MCP routing for bare mode arguments",
    async ({ processes, workspace }) => {
      const scripts = await workspace.mkdir("scripts");
      await workspace.mkdir("dist");
      await workspace.mkdir("dist/cli-runtime");
      await workspace.mkdir("dist/mcp");
      await Promise.all([
        copyFile("scripts/rea.mjs", join(scripts, "rea.mjs")),
        workspace.write(
          "package.json",
          JSON.stringify({ type: "module", version: "1.0.0" }),
        ),
        workspace.write(
          "dist/mcp/main.js",
          'export const runEntrypoint = () => process.stdout.write(JSON.stringify({ adapter: "mcp" })); export const runMcpHttpEntrypoint = (args) => process.stdout.write(JSON.stringify({ adapter: "mcp-http", args }));\n',
        ),
        workspace.write(
          "dist/cli-runtime/cli.js",
          'export const cliConfigurationError = () => undefined; export const createCli = () => ({ serve: (args) => process.stdout.write(JSON.stringify({ adapter: "cli", args })) });\n',
        ),
        workspace.write(
          "dist/cli-runtime/cliOutput.js",
          "export const normalizeCliArguments = (args) => args; export const validateCliOutputArguments = () => ({ ok: true }); export const renderCliOutputArgumentError = () => ''; export const renderEmptyFilteredCliOutput = () => undefined;\n",
        ),
        workspace.write(
          "dist/cli-runtime/cliResultOutput.js",
          "export const createCliResultOutput = () => undefined;\n",
        ),
        workspace.write(
          "dist/cli-runtime/mcpDoctor.js",
          'export const runProductionMcpDoctorCli = (args) => Promise.resolve({ output: JSON.stringify({ adapter: "mcp-doctor", args }), exitCode: 0 });\n',
        ),
      ]);

      const invoke = async (args: readonly string[]): Promise<unknown> => {
        const { exitCode, stdout } = await processes.run(
          process.execPath,
          [join(scripts, "rea.mjs"), ...args],
          { cwd: workspace.root },
        );
        expect(exitCode).toBe(0);
        return JSON.parse(stdout) as unknown;
      };

      await expect(invoke(["mcp"])).resolves.toEqual({ adapter: "mcp" });
      await expect(invoke(["--mcp"])).resolves.toEqual({ adapter: "mcp" });
      await expect(invoke(["mcp", "doctor", "--json"])).resolves.toEqual({
        adapter: "mcp-doctor",
        args: ["--json"],
      });
      await expect(invoke(["mcp", "add"])).resolves.toEqual({
        adapter: "cli",
        args: ["mcp", "add"],
      });
      await expect(invoke(["--mcp", "extra"])).resolves.toEqual({
        adapter: "cli",
        args: ["--mcp", "extra"],
      });
      for (const args of [
        ["mcp", "--http", "--port", "0"],
        ["--mcp", "--http"],
        ["mcp", "-h", "--http"],
        ["mcp", "--host", "127.0.0.1", "--http"],
      ])
        await expect(invoke(args)).resolves.toEqual({
          adapter: "mcp-http",
          args: args.slice(1),
        });
      await expect(invoke(["mcp", "doctor", "--http"])).resolves.toEqual({
        adapter: "mcp-doctor",
        args: ["--http"],
      });
      await expect(invoke(["mcp", "add", "--http"])).resolves.toEqual({
        adapter: "cli",
        args: ["mcp", "add", "--http"],
      });
    },
  );

  workspaceCliTest(
    "explains how to restore a missing compiled runtime",
    async ({ processes, workspace }) => {
      const scripts = await workspace.mkdir("scripts");
      await Promise.all([
        copyFile("scripts/rea.mjs", join(scripts, "rea.mjs")),
        workspace.write(
          "package.json",
          JSON.stringify({ type: "module", version: "1.0.0" }),
        ),
      ]);

      for (const args of [["mcp"], ["mcp", "doctor"], ["--help"]]) {
        const result = await processes.run(
          process.execPath,
          [join(scripts, "rea.mjs"), ...args],
          { cwd: workspace.root },
        );
        expect(result).toMatchObject({
          exitCode: 1,
          stderr: expect.stringContaining(
            "Oopsware's compiled runtime is missing. Run `npm ci && npm run build:cached` in",
          ),
        });
        expect(result.stderr).toContain(
          "If this is an installed package, reinstall @celaya-solutions/oopsware.",
        );
        expect(result).toMatchObject({
          stderr: expect.not.stringContaining("ERR_MODULE_NOT_FOUND"),
        });
      }
    },
  );
});
