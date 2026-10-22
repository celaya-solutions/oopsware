import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { userInfo } from "node:os";
import { parse } from "yaml";
import { expect, onTestFinished } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { removeTestWorkspace } from "../../support/workspace/workspaceFixture.js";

for (const [version, keyStyle] of [
  ["1.1", "quoted"],
  ["1.2", "quoted"],
  ["1.2", "plain"],
] as const) {
  cliTest(
    `Hermes setup preserves string environment values under YAML ${version} with ${keyStyle} keys`,
    async ({ cli }) => {
      const home = await createTestTempDirectory("rea-hermes-yaml-strings-");
      const profile = join(home, "hermes");
      const config = join(profile, "config.yaml");
      const environment = {
        REA_MCP_OUTPUT_SCHEMA_PROFILE: "off",
        ON: "on",
        YES: "yes",
        NO: "no",
        SHORT_TRUE: "y",
        SHORT_FALSE: "n",
        DATE: "2026-10-14",
        TIME: "12:34:56",
        FLOAT: "1.0e-7",
        OCTAL: "0600",
        NULL_WORD: "NULL",
        NULL_MARKER: "~",
      };
      const directive = version === "1.2" ? "%YAML 1.2\n---\n" : "";
      const settings =
        directive +
        "# User settings\nnotifications: on\ndate: 2026-10-14\n" +
        "timestamp: 2026-10-14T00:00:00.123456+08:00\n";
      const original =
        settings +
        "mcp_servers:\n  rea:\n    command: rea-old\n    args: [mcp]\n    env:\n" +
        Object.entries(environment)
          .map(
            ([key, value]) =>
              `      ${keyStyle === "plain" ? key : JSON.stringify(key)}: ${JSON.stringify(value)}\n`,
          )
          .join("");
      await mkdir(profile);
      await writeFile(config, original);
      const run = (arguments_: readonly string[]) =>
        cli.run({
          arguments: arguments_,
          cwd: home,
          environment: { USERPROFILE: home, HERMES_HOME: profile },
          timeoutMs: 20_000,
        });
      const setup = [
        "setup",
        "--client",
        "hermes",
        "--skill=false",
        "--yes",
        "--json",
      ];
      expect((await run(setup)).json).toMatchObject({ status: "ready" });
      const configured = await readFile(config, "utf8");
      expect(parse(configured, { version })).toMatchObject({
        mcp_servers: { rea: { env: environment, enabled: true } },
      });
      // Hermes's C loader applies YAML 1.1 even with the explicit directive.
      // Independently model that schema; real Hermes loader verification is
      // recorded in the PR rather than requiring Python dependencies in CI.
      if (keyStyle === "plain") {
        // The real C loader rejects these YAML 1.2 string keys as duplicate
        // boolean keys. Preserve that fallback rather than changing how
        // Hermes interprets unrelated user settings.
        for (const text of [original, configured])
          expect(() =>
            parse(text.slice(directive.length), { version: "1.1" }),
          ).toThrow("Map keys must be unique");
      } else {
        expect(
          parse(configured.slice(directive.length), { version: "1.1" }),
        ).toMatchObject({
          mcp_servers: { rea: { env: environment, enabled: true } },
        });
      }
      expect(configured.startsWith(settings)).toBe(true);
      expect(await readFile(`${config}.rea.backup`, "utf8")).toBe(original);
      expect(
        (await run(["doctor", "--client", "hermes", "--json"])).json,
      ).toMatchObject({
        healthy: true,
        identity: { registrations: [{ client: "hermes", state: "aligned" }] },
      });
      expect((await run(setup)).json).toMatchObject({
        status: "ready",
        appliedActions: [],
      });
      expect(await readFile(config, "utf8")).toBe(configured);
    },
  );
}

cliTest(
  "Hermes setup, doctor and uninstall use the expanded profile and its personal skill",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-hermes-cli-");
    const profile = join(home, "profile");
    const config = join(profile, "config.yaml");
    const skill = join(profile, "skills/reverse-engineer-anything/SKILL.md");
    const original =
      "# user settings\nmodel: custom\nmcp_servers:\n  other:\n    command: other-server\n";
    await mkdir(profile);
    await writeFile(config, original);
    const run = (arguments_: readonly string[]) =>
      cli.run({
        arguments: arguments_,
        cwd: home,
        environment: {
          USERPROFILE: home,
          REA_CLIENT_PROFILE_HOME: home,
          HERMES_HOME: " ${REA_CLIENT_PROFILE_HOME}/profile ",
        },
        timeoutMs: 20_000,
      });
    const planned = await run([
      "setup",
      "--client",
      "hermes",
      "--dry-run",
      "--json",
    ]);
    expect(planned.exitCode).toBe(0);
    expect(planned.json).toMatchObject({
      status: "planned",
      plannedActions: expect.arrayContaining([
        expect.objectContaining({ target: config }),
        expect.objectContaining({
          target: join(profile, "skills/reverse-engineer-anything"),
        }),
      ]),
    });
    expect(await readFile(config, "utf8")).toBe(original);
    await expect(access(skill)).rejects.toMatchObject({ code: "ENOENT" });
    const applied = await run([
      "setup",
      "--client",
      "hermes",
      "--yes",
      "--json",
    ]);
    expect(applied.exitCode).toBe(0);
    expect(applied.json).toMatchObject({ status: "ready" });
    expect(parse(await readFile(config, "utf8"))).toMatchObject({
      model: "custom",
      mcp_servers: {
        other: { command: "other-server" },
        rea: { enabled: true },
      },
    });
    expect(await readFile(config + ".rea.backup", "utf8")).toBe(original);
    expect(await readFile(skill, "utf8")).toContain(
      "reverse-engineer-anything",
    );
    await expect(
      access(join(home, ".agents/skills/reverse-engineer-anything/SKILL.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const doctor = await run([
      "doctor",
      "--client",
      "hermes",
      "--skill",
      "--json",
    ]);
    expect(doctor.exitCode).toBe(0);
    expect(doctor.json).toMatchObject({
      healthy: true,
      identity: { skill: { state: "aligned" } },
    });
    const repeat = await run([
      "setup",
      "--client",
      "hermes",
      "--yes",
      "--json",
    ]);
    expect(repeat.json).toMatchObject({ status: "ready", appliedActions: [] });
    const uninstall = await run(["uninstall", "--json"]);
    expect(uninstall.exitCode).toBe(0);
    expect(parse(await readFile(config, "utf8"))).toEqual(parse(original));
    await expect(access(skill)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

for (const selection of ["default", "custom", "suffix", "explicit"] as const) {
  cliTest(
    `Hermes ${selection} sticky-profile selection preserves the root configuration`,
    async ({ cli }) => {
      const home = await createTestTempDirectory("rea-hermes-sticky-");
      const suffix = selection === "suffix" ? "-dev" : "";
      const native =
        process.platform === "win32"
          ? join(home, "AppData", "Local", `hermes${suffix}`)
          : join(home, `.hermes${suffix}`);
      const root = selection === "custom" ? join(home, "custom root") : native;
      const profile = join(
        root,
        "profiles",
        selection === "explicit" ? "other" : "coder",
      );
      await mkdir(profile, { recursive: true });
      const original =
        "# profile settings\nmodel: custom\nmcp_servers:\n  other:\n    command: other-server\n";
      const config = join(profile, "config.yaml");
      const rootConfig = join(root, "config.yaml");
      await writeFile(config, original);
      await writeFile(rootConfig, "model: root-model\n");
      await writeFile(join(root, "active_profile"), "\uFEFFCoDeR\r\n");
      const run = (args: readonly string[]) =>
        cli.run({
          arguments: args,
          cwd: home,
          environment: {
            USERPROFILE: home,
            LOCALAPPDATA: join(home, "AppData", "Local"),
            HERMES_DATA_DIR_SUFFIX: suffix,
            HERMES_HOME:
              selection === "explicit"
                ? profile
                : selection === "custom"
                  ? root
                  : undefined,
          },
          timeoutMs: 20_000,
        });
      const plan = await run([
        "setup",
        "--client",
        "hermes",
        "--dry-run",
        "--json",
      ]);
      expect(plan.exitCode).toBe(0);
      expect(plan.json).toMatchObject({
        status: "planned",
        plannedActions: expect.arrayContaining([
          expect.objectContaining({ target: config }),
          expect.objectContaining({
            target: join(profile, "skills", "reverse-engineer-anything"),
          }),
        ]),
      });
      expect(
        (await run(["setup", "--client", "hermes", "--yes", "--json"]))
          .exitCode,
      ).toBe(0);
      expect(parse(await readFile(config, "utf8"))).toMatchObject({
        mcp_servers: {
          rea: { enabled: true },
          other: { command: "other-server" },
        },
      });
      expect(await readFile(`${config}.rea.backup`, "utf8")).toBe(original);
      const skill = join(
        profile,
        "skills",
        "reverse-engineer-anything",
        "SKILL.md",
      );
      expect(await readFile(skill, "utf8")).toContain(
        "name: reverse-engineer-anything",
      );
      if (selection === "custom") {
        const doctor = await run([
          "doctor",
          "--client",
          "hermes",
          "--skill",
          "--json",
        ]);
        expect(doctor.exitCode).toBe(0);
        expect(doctor.json).toMatchObject({
          healthy: true,
          identity: {
            skill: { state: "aligned" },
            registrations: expect.arrayContaining([
              expect.objectContaining({
                client: "hermes",
                config_path: config,
                state: "aligned",
              }),
            ]),
          },
        });
        expect(
          (await run(["setup", "--client", "hermes", "--yes", "--json"])).json,
        ).toMatchObject({ appliedActions: [] });
        expect((await run(["uninstall", "--json"])).exitCode).toBe(0);
        expect(parse(await readFile(config, "utf8"))).toEqual(parse(original));
        await expect(access(skill)).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect(await readFile(rootConfig, "utf8")).toBe("model: root-model\n");
      await expect(access(`${rootConfig}.rea.backup`)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        access(join(root, "skills", "reverse-engineer-anything")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
}
for (const name of ["missing", "deleted", "ghost", "../escape", "root"]) {
  cliTest(
    `Hermes rejects unusable sticky profile ${name} without writing a fallback home`,
    async ({ cli }) => {
      const home = await createTestTempDirectory("rea-hermes-invalid-profile-");
      const root = join(home, "hermes root");
      await mkdir(root);
      await writeFile(join(root, "active_profile"), name);
      if (name === "deleted" || name === "ghost") {
        await mkdir(join(root, "profiles", name), { recursive: true });
        if (name === "deleted") {
          await writeFile(
            join(root, "profiles", name, "config.yaml"),
            "model: custom\n",
          );
          await mkdir(join(root, "profiles", ".deleted"));
          await writeFile(
            join(root, "profiles", ".deleted", name),
            "deleted\n",
          );
        }
      }
      const run = (args: readonly string[]) =>
        cli.run({
          arguments: args,
          cwd: home,
          environment: { USERPROFILE: home, HERMES_HOME: root },
          timeoutMs: 20_000,
        });
      const rejected = await run([
        "setup",
        "--client",
        "hermes",
        "--yes",
        "--json",
      ]);
      expect(rejected.exitCode).not.toBe(0);
      expect(rejected.json).toMatchObject({
        status: "needs_human",
        plannedActions: [],
        appliedActions: [],
        remediation: expect.stringContaining("Hermes profile"),
      });
      await expect(access(join(root, "config.yaml"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(access(join(root, "skills"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      if (name !== "missing") return;
      const doctor = await run(["doctor", "--client", "hermes", "--json"]);
      expect(doctor.exitCode).not.toBe(0);
      expect(doctor.json).toMatchObject({
        identity: {
          registrations: expect.arrayContaining([
            expect.objectContaining({
              client: "hermes",
              state: "invalid",
              remediation: expect.stringContaining("Hermes profile"),
            }),
          ]),
        },
      });
      const unrelated = await run([
        "setup",
        "--client",
        "codex",
        "--yes",
        "--json",
      ]);
      expect(unrelated.exitCode).toBe(0);
    },
  );
}

cliTest.skipIf(process.platform === "win32")(
  "Hermes named-user home aligns setup, doctor, skill and uninstall despite an isolated HOME",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-hermes-named-caller-");
    const account = userInfo();
    const profile = await mkdtemp(join(account.homedir, ".rea-hermes-named-"));
    onTestFinished(() => removeTestWorkspace(profile));
    const override = `~${account.username}//${relative(account.homedir, profile)}`;
    const config = join(profile, "config.yaml");
    const skill = join(profile, "skills/reverse-engineer-anything/SKILL.md");
    const original =
      "# owned fixture\nmodel: custom\nmcp_servers:\n  other:\n    command: other-server\n";
    await writeFile(config, original);
    const run = (arguments_: readonly string[]) =>
      cli.run({
        arguments: arguments_,
        cwd: home,
        environment: {
          USERPROFILE: home,
          HERMES_HOME: "$REA_HERMES_PROFILE",
          REA_HERMES_PROFILE: override,
        },
        timeoutMs: 20_000,
      });
    const planned = await run([
      "setup",
      "--client",
      "hermes",
      "--dry-run",
      "--json",
    ]);
    expect(planned.exitCode).toBe(0);
    expect(planned.json).toMatchObject({
      status: "planned",
      plannedActions: expect.arrayContaining([
        expect.objectContaining({ target: config }),
        expect.objectContaining({
          target: join(profile, "skills/reverse-engineer-anything"),
        }),
      ]),
    });
    expect(await readFile(config, "utf8")).toBe(original);
    await expect(access(skill)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (await run(["setup", "--client", "hermes", "--yes", "--json"])).json,
    ).toMatchObject({ status: "ready" });
    expect(parse(await readFile(config, "utf8"))).toMatchObject({
      model: "custom",
      mcp_servers: {
        other: { command: "other-server" },
        rea: { enabled: true },
      },
    });
    expect(await readFile(`${config}.rea.backup`, "utf8")).toBe(original);
    expect(await readFile(skill, "utf8")).toContain(
      "name: reverse-engineer-anything",
    );
    expect(
      (await run(["doctor", "--client", "hermes", "--skill", "--json"])).json,
    ).toMatchObject({
      healthy: true,
      identity: { skill: { state: "aligned" } },
    });
    expect(
      (await run(["setup", "--client", "hermes", "--yes", "--json"])).json,
    ).toMatchObject({ status: "ready", appliedActions: [] });
    expect((await run(["uninstall", "--json"])).exitCode).toBe(0);
    expect(parse(await readFile(config, "utf8"))).toEqual(parse(original));
    await expect(access(skill)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(home, override))).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

cliTest(
  "Hermes unresolved named home refuses setup before writes and remains diagnostic in doctor",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-hermes-named-refusal-");
    const override = `~${userInfo().username}-other/profile`;
    const run = (arguments_: readonly string[]) =>
      cli.run({
        arguments: arguments_,
        cwd: home,
        environment: { USERPROFILE: home, HERMES_HOME: override },
        timeoutMs: 20_000,
      });
    const setup = await run(["setup", "--client", "hermes", "--yes", "--json"]);
    expect(setup.exitCode).not.toBe(0);
    expect(setup.json).toMatchObject({
      status: "needs_human",
      plannedActions: [],
      appliedActions: [],
      remediation: expect.stringContaining("absolute HERMES_HOME"),
    });
    const doctor = await run([
      "doctor",
      "--client",
      "hermes",
      "--skill",
      "--json",
    ]);
    expect(doctor.exitCode).not.toBe(0);
    expect(doctor.json).toMatchObject({
      identity: {
        registrations: expect.arrayContaining([
          expect.objectContaining({
            client: "hermes",
            state: "invalid",
            remediation: expect.stringContaining("absolute HERMES_HOME"),
          }),
        ]),
      },
    });
    await expect(access(join(home, override))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      access(join(home, ".agents/skills/reverse-engineer-anything")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  },
);
