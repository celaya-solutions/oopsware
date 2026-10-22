import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest.skipIf(process.platform === "win32").for([
  ["rea", "rea-agents"],
  ["rea-agents", "rea"],
] as const)(
  "recognizes setup through %s when doctor and uninstall use %s",
  async ([registered, alternate], { processes }) => {
    const root = await createTestTempDirectory("rea-launcher-registration-");
    const home = join(root, "home");
    const config = join(home, ".cursor/mcp.json");
    await mkdir(join(home, ".cursor"), { recursive: true });
    const unrelated = { command: "other-server", args: [] };
    await writeFile(config, JSON.stringify({ mcpServers: { unrelated } }));
    for (const name of [registered, alternate])
      await symlink(resolve("scripts/rea.mjs"), join(root, name));
    const run = (alias: string, arguments_: readonly string[]) =>
      processes.run(process.execPath, [join(root, alias), ...arguments_], {
        cwd: home,
        env: {
          HOME: home,
          USERPROFILE: home,
          XDG_CONFIG_HOME: join(home, ".config"),
          PATH: process.env.PATH ?? "",
        },
        timeoutMs: 30_000,
      });

    const setup = await run(registered, [
      "setup",
      "--client",
      "cursor",
      "--skill=false",
      "--yes",
      "--json",
    ]);
    expect(setup.exitCode, setup.stderr).toBe(0);
    for (const alias of [registered, alternate]) {
      const doctor = await run(alias, [
        "doctor",
        "--client",
        "cursor",
        "--skill=false",
        "--json",
      ]);
      expect(doctor.exitCode, doctor.stdout).toBe(0);
      expect(JSON.parse(doctor.stdout)).toMatchObject({
        scope_checks: expect.arrayContaining([
          expect.objectContaining({ name: "registration:cursor", ok: true }),
        ]),
      });
    }
    const uninstall = await run(alternate, ["uninstall", "--json"]);
    expect(uninstall.exitCode, uninstall.stderr).toBe(0);
    expect(JSON.parse(await readFile(config, "utf8"))).toEqual({
      mcpServers: { unrelated },
    });
  },
);

cliTest.skipIf(process.platform === "win32").for([
  ["dangling", "direct"],
  ["dangling", "node"],
  ["cycle", "direct"],
  ["cycle", "node"],
] as const)(
  "retains %s launcher identity as unknown for a %s registration",
  async ([failure, form], { cli }) => {
    const home = await createTestTempDirectory("rea-unresolved-registration-");
    const directory = join(home, ".cursor");
    const config = join(directory, "mcp.json");
    await mkdir(directory);
    const launcher = join(home, "rea");
    if (failure === "dangling")
      await symlink(join(home, "removed-release.mjs"), launcher);
    else {
      await symlink(join(home, "other-alias"), launcher);
      await symlink(launcher, join(home, "other-alias"));
    }
    const command =
      form === "direct"
        ? [launcher, "mcp"]
        : [process.execPath, launcher, "mcp"];
    const original = JSON.stringify({
      mcpServers: {
        rea: { command: command[0], args: command.slice(1) },
        unrelated: { command: "other-server" },
      },
    });
    await writeFile(config, original);
    const environment = {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, ".config"),
    };
    const doctor = await cli.run({
      arguments: ["doctor", "--client", "cursor", "--skill=false", "--json"],
      cwd: home,
      environment,
    });
    expect(doctor.exitCode, doctor.stderr).toBe(1);
    expect(doctor.json).toMatchObject({
      identity: {
        registrations: expect.arrayContaining([
          expect.objectContaining({
            client: "cursor",
            state: "unknown",
            command,
            remediation: expect.stringContaining("symlink targets"),
          }),
        ]),
      },
    });
    expect(await readFile(config, "utf8")).toBe(original);
    const uninstall = await cli.run({
      arguments: ["uninstall", "--json"],
      cwd: home,
      environment,
    });
    expect(uninstall.exitCode, uninstall.stderr).toBe(0);
    expect(await readFile(config, "utf8")).toBe(original);
  },
);

cliTest.skipIf(process.platform === "win32")(
  "uninstall preserves a different executable reached through symlink parent traversal",
  async ({ processes }) => {
    const root = await createTestTempDirectory(
      "rea-launcher-native-traversal-",
    );
    const home = join(root, "home");
    const config = join(home, ".cursor/mcp.json");
    await mkdir(join(home, ".cursor"), { recursive: true });
    const current = join(root, "rea");
    await symlink(resolve("scripts/rea.mjs"), current);
    const other = join(root, "other");
    await mkdir(join(other, "child"), { recursive: true });
    await writeFile(join(other, "rea"), "#!/bin/sh\nprintf foreign\n", {
      mode: 0o700,
    });
    await symlink(join(other, "child"), join(root, "link"));
    const candidate = `${root}/link/../rea`;
    expect(await readFile(candidate, "utf8")).toContain("printf foreign");
    const original = JSON.stringify({
      mcpServers: {
        rea: { command: candidate, args: ["mcp"] },
        unrelated: { command: "other-server" },
      },
    });
    await writeFile(config, original);
    const run = (arguments_: readonly string[]) =>
      processes.run(process.execPath, [current, ...arguments_], {
        cwd: home,
        env: {
          HOME: home,
          USERPROFILE: home,
          XDG_CONFIG_HOME: join(home, ".config"),
          PATH: process.env.PATH ?? "",
        },
        timeoutMs: 30_000,
      });
    const uninstall = await run(["uninstall", "--json"]);
    expect(uninstall.exitCode, uninstall.stderr).toBe(0);
    expect(await readFile(config, "utf8")).toBe(original);
    const doctor = await run([
      "doctor",
      "--client",
      "cursor",
      "--skill=false",
      "--json",
    ]);
    expect(doctor.exitCode, doctor.stderr).toBe(1);
    expect(JSON.parse(doctor.stdout)).toMatchObject({
      identity: {
        registrations: expect.arrayContaining([
          expect.objectContaining({
            client: "cursor",
            command: [candidate, "mcp"],
            state: "unknown",
          }),
        ]),
      },
    });
  },
);
