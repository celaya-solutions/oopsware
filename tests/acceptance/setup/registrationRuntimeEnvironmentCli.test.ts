import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { expect } from "vitest";
import { Scalar, stringify } from "yaml";

import {
  effectiveClientServer,
  parseClientConfiguration,
  clientRegistrationEntry,
} from "../../../src/application/ClientConfigurationDocument.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

// Registration configuration tests must not discover installed providers or
// plan provider-environment edits based on the machine running the suite.
const missingHopperAndGhidraEnvironment = (home: string) => ({
  HOPPER_LAUNCHER_PATH: join(home, "missing-hopper"),
  GHIDRA_INSTALL_DIR: join(home, "missing-ghidra"),
  JAVA_HOME: join(home, "missing-java"),
});

cliTest.skipIf(process.platform !== "win32")(
  "rejects lowercase Windows provider settings in doctor and setup without writing",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-registration-case-");
    const config = join(home, ".cursor/mcp.json");
    await mkdir(dirname(config), { recursive: true });
    const original = JSON.stringify({
      mcpServers: {
        rea: clientRegistrationEntry(
          "json",
          [process.execPath, resolve("scripts/rea.mjs"), "mcp"],
          { rea_analysis_provider: "invalid provider" },
        ),
      },
    });
    await writeFile(config, original);
    const environment = {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      ...missingHopperAndGhidraEnvironment(home),
    };
    const doctor = await cli.run({
      arguments: ["doctor", "--client", "cursor", "--skill=false", "--json"],
      cwd: home,
      environment,
    });
    expect(doctor.exitCode).toBe(1);
    expect(doctor.json).toMatchObject({
      scope_checks: expect.arrayContaining([
        expect.objectContaining({
          name: "registration:cursor",
          ok: false,
          classification: "config_drift",
          remediation: expect.stringContaining("REA_ANALYSIS_PROVIDER"),
        }),
      ]),
    });
    const setup = await cli.run({
      arguments: [
        "setup",
        "--client",
        "cursor",
        "--skill=false",
        "--yes",
        "--json",
      ],
      cwd: home,
      environment,
    });
    expect(setup.exitCode).toBe(1);
    expect(setup.json).toMatchObject({
      status: "needs_human",
      plannedActions: [],
      appliedActions: [],
      remediation: expect.stringContaining("REA_ANALYSIS_PROVIDER"),
    });
    expect(await readFile(config, "utf8")).toBe(original);
    await expect(access(`${config}.rea.backup`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

const scenarios = [
  {
    client: "cursor",
    format: "json",
    path: ".cursor/mcp.json",
    setting: "HOPPER_LOADER_ARGS_JSON",
    invalid: { HOPPER_LOADER_ARGS_JSON: "{" },
    repaired: { HOPPER_LOADER_ARGS_JSON: '["", "--loader", "Mach-O"]' },
  },
  {
    client: "dsh",
    format: "dsh",
    path: ".dsh/cordis.patch.yml",
    setting: "REA_GHIDRA_COMPILER_SPEC_ID",
    invalid: { REA_GHIDRA_COMPILER_SPEC_ID: "borlandcpp" },
    repaired: {
      REA_GHIDRA_COMPILER_SPEC_ID: "borlandcpp",
      REA_GHIDRA_LANGUAGE_ID: "x86:LE:32:default",
    },
  },
] as const;

cliTest.for([
  {
    client: "cursor",
    format: "json",
    path: ".cursor/mcp.json",
    position: "value",
  },
  {
    client: "cursor",
    format: "json",
    path: ".cursor/mcp.json",
    position: "name",
  },
  {
    client: "dsh",
    format: "dsh",
    path: ".dsh/cordis.patch.yml",
    position: "value",
  },
  {
    client: "dsh",
    format: "dsh",
    path: ".dsh/cordis.patch.yml",
    position: "name",
  },
  {
    client: "dsh",
    format: "dsh",
    path: ".dsh/cordis.patch.yml",
    position: "expression name",
  },
] as const)(
  "refuses a NUL environment $position in $client before setup writes",
  async (scenario, { cli }) => {
    const home = await createTestTempDirectory("rea-registration-nul-");
    const config = join(home, scenario.path);
    await mkdir(dirname(config), { recursive: true });
    const environment = {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      DSH_HOME: join(home, ".dsh"),
      ...missingHopperAndGhidraEnvironment(home),
    };
    const registration = (env: Readonly<Record<string, string>>) => {
      const entry = clientRegistrationEntry(
        scenario.format,
        [process.execPath, resolve("scripts/rea.mjs"), "mcp"],
        env,
      );
      if (scenario.position === "expression name")
        entry.env = Object.fromEntries(
          Object.entries(env).map(([key, value]) => {
            if (!key.includes("\0")) return [key, value];
            const expression = new Scalar("process.env.CALLER_SETTING");
            expression.tag = "tag:yaml.org,2002:js";
            return [key, expression];
          }),
        );
      return scenario.format === "dsh"
        ? stringify([
            {
              insert: [
                {
                  id: "rea-mcp",
                  name: "@deepseek-ai/dsh-mcp-client",
                  config: entry,
                },
              ],
            },
          ])
        : JSON.stringify({ mcpServers: { rea: entry } });
    };
    const valueMarker = "reaNulFixtureValue_6c04e2";
    const original = registration(
      scenario.position === "value"
        ? { CALLER_SETTING: `${valueMarker}\0value` }
        : { ["CALLER\0SETTING"]: `${valueMarker} value` },
    );
    await writeFile(config, original);
    const doctor = await cli.run({
      arguments: [
        "doctor",
        "--client",
        scenario.client,
        "--skill=false",
        "--json",
      ],
      cwd: home,
      environment,
    });
    expect(doctor.exitCode).toBe(1);
    expect(doctor.json).toMatchObject({
      scope_checks: expect.arrayContaining([
        expect.objectContaining({
          name: `registration:${scenario.client}`,
          ok: false,
          classification: "config_drift",
          remediation: expect.stringContaining("NUL"),
        }),
      ]),
    });
    const setup = await cli.run({
      arguments: [
        "setup",
        "--client",
        scenario.client,
        "--skill=false",
        "--yes",
        "--json",
      ],
      cwd: home,
      environment,
    });
    expect(setup.exitCode).toBe(1);
    expect(setup.json).toMatchObject({
      status: "needs_human",
      plannedActions: [],
      appliedActions: [],
      remediation: expect.stringContaining("NUL"),
    });
    expect(setup.stdout + doctor.stdout).not.toContain(valueMarker);
    expect(await readFile(config, "utf8")).toBe(original);
    await expect(access(`${config}.rea.backup`)).rejects.toMatchObject({
      code: "ENOENT",
    });

    const repaired = registration({
      CALLER_SETTING: "ordinary\nvalue=二\t",
      EMPTY_SETTING: "",
    });
    await writeFile(config, repaired);
    const healthy = await cli.run({
      arguments: [
        "doctor",
        "--client",
        scenario.client,
        "--skill=false",
        "--json",
      ],
      cwd: home,
      environment,
    });
    expect(healthy.exitCode, healthy.stdout).toBe(0);
    expect(healthy.json).toMatchObject({ healthy: true });
    expect(await readFile(config, "utf8")).toBe(repaired);
  },
);

for (const scenario of scenarios)
  cliTest(
    `setup and doctor reject ${scenario.client} overrides rejected by MCP startup`,
    async ({ cli }) => {
      const home = await createTestTempDirectory("rea-registration-runtime-");
      const config = join(home, scenario.path);
      await mkdir(dirname(config), { recursive: true });
      const environment = {
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        DSH_HOME: join(home, ".dsh"),
        ...missingHopperAndGhidraEnvironment(home),
      };
      const registration = (env: Readonly<Record<string, string>>) => {
        const server = {
          command: "stale-launcher",
          args: ["mcp"],
          env: { CALLER_SETTING: "keep exactly", ...env },
        };
        return scenario.client === "dsh"
          ? stringify([
              {
                insert: [
                  {
                    id: "rea-mcp",
                    name: "@deepseek-ai/dsh-mcp-client",
                    config: {
                      serverName: "rea",
                      transport: "stdio",
                      ...server,
                    },
                  },
                ],
              },
            ])
          : JSON.stringify({ mcpServers: { rea: server } });
      };
      const original = registration(scenario.invalid);
      await writeFile(config, original);
      const startup = await cli.run({
        arguments: ["mcp"],
        cwd: home,
        environment: { ...environment, ...scenario.invalid },
      });
      expect(startup.exitCode).toBe(1);
      expect(startup.stderr).toContain(scenario.setting);
      expect(startup.stdout).toBe("");
      const run = (args: readonly string[]) =>
        cli.run({ arguments: [...args, "--json"], cwd: home, environment });
      const setup = await run([
        "setup",
        "--client",
        scenario.client,
        "--skill=false",
        "--yes",
      ]);
      expect(setup.exitCode).toBe(1);
      expect(setup.json).toMatchObject({
        status: "needs_human",
        plannedActions: [],
        appliedActions: [],
        remediation: expect.stringContaining(scenario.setting),
      });
      const doctor = await run(["doctor", "--client", scenario.client]);
      expect(doctor.exitCode).toBe(1);
      expect(doctor.json).toMatchObject({
        identity: {
          registrations: expect.arrayContaining([
            expect.objectContaining({
              client: scenario.client,
              state: "invalid",
              remediation: expect.stringContaining(scenario.setting),
            }),
          ]),
        },
      });
      expect(await readFile(config, "utf8")).toBe(original);
      await expect(access(`${config}.rea.backup`)).rejects.toMatchObject({
        code: "ENOENT",
      });

      // Model the caller repairing the named setting before rerunning setup.
      const repaired = registration(scenario.repaired);
      await writeFile(config, repaired);
      const configured = await run([
        "setup",
        "--client",
        scenario.client,
        "--skill=false",
        "--yes",
      ]);
      expect(configured.exitCode, configured.stdout).toBe(0);
      const text = await readFile(config, "utf8");
      const parsed = parseClientConfiguration(text, scenario.format);
      expect(effectiveClientServer(parsed, "rea")).toMatchObject({
        env: { CALLER_SETTING: "keep exactly", ...scenario.repaired },
      });
      expect(await readFile(`${config}.rea.backup`, "utf8")).toBe(repaired);
      const repeated = await run([
        "setup",
        "--client",
        scenario.client,
        "--skill=false",
        "--yes",
      ]);
      expect(repeated.json).toMatchObject({
        status: "ready",
        appliedActions: [],
        plannedActions: [],
      });
      expect(await readFile(config, "utf8")).toBe(text);
    },
  );

cliTest(
  "OpenCode CLI validates dependent settings after merging JSON and JSONC",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-layered-runtime-cli-");
    const directory = join(home, ".config/opencode");
    await mkdir(directory, { recursive: true });
    const lower = join(directory, "opencode.json");
    const upper = join(directory, "opencode.jsonc");
    const content = (env: Record<string, string>) =>
      JSON.stringify({
        mcp: {
          rea: clientRegistrationEntry(
            "opencode",
            // Windows launches JavaScript through Node; otherwise setup repairs
            // the command before this test can exercise layered environment data.
            [
              ...(process.platform === "win32" ? [process.execPath] : []),
              resolve("scripts/rea.mjs"),
              "mcp",
            ],
            env,
          ),
        },
      });
    const lowerContent = content({
      REA_GHIDRA_LANGUAGE_ID: "x86:LE:32:default",
    });
    const upperContent = content({ REA_GHIDRA_COMPILER_SPEC_ID: "borlandcpp" });
    await writeFile(lower, lowerContent);
    await writeFile(upper, upperContent);
    const environment = {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      ...missingHopperAndGhidraEnvironment(home),
    };
    const run = (args: readonly string[]) =>
      cli.run({ arguments: [...args, "--json"], cwd: home, environment });
    const setup = await run([
      "setup",
      "--client",
      "opencode",
      "--skill=false",
      "--yes",
    ]);
    expect(setup.exitCode, setup.stdout).toBe(0);
    expect(setup.json).toMatchObject({
      status: "ready",
      plannedActions: [],
      appliedActions: [],
    });
    const doctor = await run(["doctor", "--client", "opencode"]);
    expect(doctor.exitCode, doctor.stdout).toBe(0);
    expect(doctor.json).toMatchObject({
      identity: {
        registrations: expect.arrayContaining([
          expect.objectContaining({ client: "opencode", state: "aligned" }),
        ]),
      },
    });
    expect(await readFile(lower, "utf8")).toBe(lowerContent);
    expect(await readFile(upper, "utf8")).toBe(upperContent);
    await writeFile(lower, content({ CALLER_SETTING: "retained" }));
    const missing = await run([
      "setup",
      "--client",
      "opencode",
      "--skill=false",
      "--yes",
    ]);
    expect(missing.exitCode).toBe(1);
    expect(missing.json).toMatchObject({
      status: "needs_human",
      plannedActions: [],
      appliedActions: [],
      remediation: expect.stringContaining("REA_GHIDRA_COMPILER_SPEC_ID"),
    });
    const invalidDoctor = await run(["doctor", "--client", "opencode"]);
    expect(invalidDoctor.exitCode).toBe(1);
    expect(invalidDoctor.json).toMatchObject({
      identity: {
        registrations: expect.arrayContaining([
          expect.objectContaining({ client: "opencode", state: "invalid" }),
        ]),
      },
    });
    expect(await readFile(upper, "utf8")).toBe(upperContent);
    for (const path of [lower, upper])
      await expect(access(`${path}.rea.backup`)).rejects.toMatchObject({
        code: "ENOENT",
      });
  },
);

cliTest(
  "public setup propagates selected provider deadlines and input profile to Codex and Kimi",
  async ({ cli }) => {
    const home = await createTestTempDirectory(
      "rea-selected-registration-env-",
    );
    const codexHome = join(home, "codex");
    const kimiHome = join(home, "kimi");
    await Promise.all(
      [codexHome, kimiHome].map((path) => mkdir(path, { recursive: true })),
    );
    const environment = {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      CODEX_HOME: codexHome,
      KIMI_CODE_HOME: kimiHome,
      ...missingHopperAndGhidraEnvironment(home),
      REA_ANALYSIS_PROVIDER: "auto",
      REA_GHIDRA_STARTUP_TIMEOUT_MS: "2700001",
      REA_HOPPER_STARTUP_TIMEOUT_MS: "2800002",
      REA_JEB_MCP_TIMEOUT_MS: "2900003",
      REA_MCP_INPUT_SCHEMA_PROFILE: "full",
      REA_UNRELATED_MARKER: "do-not-persist",
    };
    const run = (arguments_: readonly string[]) =>
      cli.run({
        arguments: [...arguments_, "--json"],
        cwd: home,
        environment,
      });

    for (const client of ["codex", "kimi"] as const) {
      const setup = await run([
        "setup",
        "--client",
        client,
        "--skill=false",
        "--yes",
      ]);
      expect(setup.exitCode, setup.stderr).toBe(0);
      expect(setup.json).toMatchObject({ status: "ready" });
    }

    const codexConfig = await readFile(join(codexHome, "config.toml"), "utf8");
    const codexRegistration = effectiveClientServer(
      parseClientConfiguration(codexConfig, "toml"),
      "rea",
    );
    expect(codexRegistration).toMatchObject({ tool_timeout_sec: 3021 });
    expect(codexConfig).toContain('REA_JEB_MCP_TIMEOUT_MS = "2900003"');
    expect(codexConfig).not.toContain("REA_UNRELATED_MARKER");

    const kimiPath = join(kimiHome, "mcp.json");
    const kimiRegistration = effectiveClientServer(
      parseClientConfiguration(await readFile(kimiPath, "utf8"), "kimi"),
      "rea",
    );
    expect(kimiRegistration).toMatchObject({
      toolTimeoutMs: 3_020_003,
      env: {
        REA_ANALYSIS_PROVIDER: "auto",
        REA_GHIDRA_STARTUP_TIMEOUT_MS: "2700001",
        REA_HOPPER_STARTUP_TIMEOUT_MS: "2800002",
        REA_JEB_MCP_TIMEOUT_MS: "2900003",
        REA_MCP_INPUT_SCHEMA_PROFILE: "full",
      },
    });
    expect(await readFile(kimiPath, "utf8")).not.toContain(
      "REA_UNRELATED_MARKER",
    );

    const doctor = await run(["doctor", "--client", "kimi"]);
    expect(doctor.exitCode, doctor.stderr).toBe(0);
    expect(doctor.json).toMatchObject({
      identity: {
        registrations: expect.arrayContaining([
          expect.objectContaining({ client: "kimi", state: "aligned" }),
        ]),
      },
    });
  },
  120_000,
);

for (const [client, provider] of [
  ["codex", "ida"],
  ["kimi", "ida"],
  ["kimi", "auto"],
] as const)
  cliTest(
    `public ${client} setup and doctor use the effective IDA registration request budget with ${provider} selection`,
    async ({ cli }) => {
      const home = await createTestTempDirectory(
        "rea-ida-registration-budget-",
      );
      const clientHome = join(home, client);
      await mkdir(clientHome, { recursive: true });
      const idaConfig = join(home, "ida.json");
      const writeRegistration = (timeoutMs: number) =>
        writeFile(
          idaConfig,
          JSON.stringify({
            url: "http://127.0.0.1:12345/mcp",
            headers: { Authorization: "Bearer fixture-credential" },
            timeoutMs,
          }),
        );
      await writeRegistration(1_800_001);
      const environment = {
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        CODEX_HOME: clientHome,
        KIMI_CODE_HOME: clientHome,
        ...missingHopperAndGhidraEnvironment(home),
      };
      const setupArguments = [
        "setup",
        "--client",
        client,
        "--skill=false",
        "--yes",
        "--json",
      ];
      const configured = await cli.run({
        arguments: setupArguments,
        cwd: home,
        environment: {
          ...environment,
          REA_ANALYSIS_PROVIDER: provider,
          REA_IDA_MCP_CONFIG: idaConfig,
        },
      });
      expect(configured.exitCode, configured.stdout).toBe(0);
      const config = join(
        clientHome,
        client === "codex" ? "config.toml" : "mcp.json",
      );
      const text = await readFile(config, "utf8");
      expect(
        effectiveClientServer(
          parseClientConfiguration(text, client === "codex" ? "toml" : "kimi"),
          "rea",
        ),
      ).toMatchObject({
        ...(client === "codex"
          ? { tool_timeout_sec: 1921 }
          : { toolTimeoutMs: 1_920_001 }),
        env: { REA_ANALYSIS_PROVIDER: provider, REA_IDA_MCP_CONFIG: idaConfig },
      });
      expect(text).not.toContain("fixture-credential");
      const run = (arguments_: readonly string[]) =>
        cli.run({ arguments: arguments_, cwd: home, environment });
      const healthy = await run(["doctor", "--client", client, "--json"]);
      expect(healthy.exitCode, healthy.stdout).toBe(0);
      expect(JSON.stringify(healthy.json)).not.toContain('"advisory"');

      // Only the stored client's provider path identifies this changed budget;
      // the doctor/setup process has no IDA configuration in its environment.
      await writeRegistration(2_400_001);
      const doctor = await run(["doctor", "--client", client, "--json"]);
      expect(doctor.exitCode, doctor.stdout).toBe(0);
      expect(doctor.json).toMatchObject({
        identity: {
          registrations: expect.arrayContaining([
            expect.objectContaining({
              client,
              state: "aligned",
              advisory: expect.stringContaining(
                client === "codex"
                  ? "tool_timeout_sec = 2521 seconds"
                  : "toolTimeoutMs = 2520001 ms",
              ),
            }),
          ]),
        },
      });
      const repeated = await run(setupArguments);
      expect(repeated.exitCode, repeated.stdout).toBe(0);
      expect(repeated.json).toMatchObject({
        status: "ready",
        plannedActions: [],
        appliedActions: [],
      });
      expect(await readFile(config, "utf8")).toBe(text);
      await expect(access(`${config}.rea.backup`)).rejects.toMatchObject({
        code: "ENOENT",
      });
      if (provider === "ida") {
        await writeRegistration(0);
        const invalidDoctor = await run([
          "doctor",
          "--client",
          client,
          "--json",
        ]);
        expect(invalidDoctor.exitCode).toBe(1);
        expect(invalidDoctor.json).toMatchObject({
          identity: {
            registrations: expect.arrayContaining([
              expect.objectContaining({
                client,
                state: "invalid",
                remediation: expect.stringContaining("REA_IDA_MCP_CONFIG"),
              }),
            ]),
          },
        });
        const invalidSetup = await run(setupArguments);
        expect(invalidSetup.exitCode).toBe(1);
        expect(invalidSetup.stdout).toContain("REA_IDA_MCP_CONFIG");
        expect(await readFile(config, "utf8")).toBe(text);
        await expect(access(`${config}.rea.backup`)).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
    },
    120_000,
  );

for (const invalidSetting of [
  { setting: "REA_MCP_INPUT_SCHEMA_PROFILE", value: "unknown" },
  { setting: "REA_GHIDRA_STARTUP_TIMEOUT_MS", value: "0" },
  { setting: "REA_JEB_MCP_TIMEOUT_MS", value: "1.5" },
] as const)
  cliTest(
    `setup rejects malformed selected ${invalidSetting.setting} before writing`,
    async ({ cli }) => {
      const home = await createTestTempDirectory(
        "rea-invalid-selected-registration-env-",
      );
      const kimiHome = join(home, "kimi");
      await mkdir(kimiHome, { recursive: true });
      const config = join(kimiHome, "mcp.json");
      const environment = {
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        KIMI_CODE_HOME: kimiHome,
        ...missingHopperAndGhidraEnvironment(home),
        [invalidSetting.setting]: invalidSetting.value,
      };
      const result = await cli.run({
        arguments: [
          "setup",
          "--client",
          "kimi",
          "--skill=false",
          "--yes",
          "--json",
        ],
        cwd: home,
        environment,
      });
      expect(result.exitCode).toBe(1);
      expect(result.json).toMatchObject({
        code: "configuration_invalid",
        category: "invalid_input",
        details: {
          settings: [
            expect.objectContaining({ setting: invalidSetting.setting }),
          ],
        },
      });
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        invalidSetting.setting,
      );
      await expect(access(config)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(`${config}.rea.backup`)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
    120_000,
  );
