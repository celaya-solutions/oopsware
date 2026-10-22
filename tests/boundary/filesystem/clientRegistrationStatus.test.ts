import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { clearClientLocationEnvironment } from "../../fixtures/clientEnvironment.js";

import { readClientRegistrationStatuses } from "../../../src/application/ClientRegistrationStatus.js";
import { existingMaintenanceScope } from "../../../src/application/UpdateMaintenance.js";
import { PRODUCT_IDENTITY } from "../../../src/identity.js";

beforeEach(clearClientLocationEnvironment);
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("client registration status", () => {
  it("discovers Claude Code from its config file without a marker directory", async () => {
    const home = await createTestTempDirectory("rea-claude-config-only-");
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          rea: {
            command: "npx",
            args: ["-y", PRODUCT_IDENTITY.registrationPackageSpecifier, "mcp"],
          },
        },
      }),
    );

    const statuses = await readClientRegistrationStatuses(home, "/current/rea");

    expect(statuses).toEqual([
      expect.objectContaining({
        client: "claude_code",
        config_path: join(home, ".claude.json"),
        state: "aligned",
        remediation: null,
      }),
    ]);
  });

  it("distinguishes aligned, stale, missing, and invalid registrations", async () => {
    const home = await createTestTempDirectory("rea-registrations-");
    const currentEntry = join(home, "current-rea.mjs");
    const foreignEntry = join(home, "foreign-rea.mjs");
    await writeFile(currentEntry, "// current dispatcher\n");
    await writeFile(foreignEntry, "// different dispatcher\n");
    await Promise.all([
      mkdir(join(home, ".codex")),
      mkdir(join(home, ".cursor")),
      mkdir(join(home, ".gemini")),
      mkdir(join(home, ".claude")),
    ]);
    await writeFile(
      join(home, ".codex/config.toml"),
      `[mcp_servers.rea]\ncommand = "npx"\nargs = ["-y", "${PRODUCT_IDENTITY.registrationPackageSpecifier}", "mcp"]\nstartup_timeout_sec = 30\ntool_timeout_sec = 450\n`,
    );
    await writeFile(
      join(home, ".cursor/mcp.json"),
      JSON.stringify({
        mcpServers: {
          rea: { command: foreignEntry, args: ["mcp"], env: { SECRET: "x" } },
        },
      }),
    );
    await writeFile(join(home, ".gemini/settings.json"), "not-json");

    const statuses = await readClientRegistrationStatuses(home, currentEntry);
    expect(statuses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          client: "codex",
          state: "aligned",
          remediation: null,
        }),
        expect.objectContaining({
          client: "cursor",
          state: "stale",
          command: [foreignEntry, "mcp"],
          remediation: expect.any(String),
        }),
        expect.objectContaining({
          client: "gemini_cli",
          state: "invalid",
          command: [],
          remediation: expect.any(String),
        }),
        expect.objectContaining({
          client: "claude_code",
          state: "missing",
          command: [],
          remediation: expect.any(String),
        }),
      ]),
    );
    expect(JSON.stringify(statuses)).not.toContain("SECRET");
  });

  it.each([null, [], "invalid"])(
    "reports a malformed server table %j as invalid",
    async (servers) => {
      const home = await createTestTempDirectory("rea-registration-shape-");
      await mkdir(join(home, ".cursor"));
      await writeFile(
        join(home, ".cursor/mcp.json"),
        JSON.stringify({ mcpServers: servers }),
      );
      expect(await readClientRegistrationStatuses(home)).toEqual([
        expect.objectContaining({
          client: "cursor",
          state: "invalid",
          command: [],
        }),
      ]);
    },
  );
});

describe("client registration launcher identity", () => {
  it("reports an unversioned npx registration as stale", async () => {
    const home = await createTestTempDirectory("rea-registrations-");
    await mkdir(join(home, ".codex"));
    await writeFile(
      join(home, ".codex/config.toml"),
      '[mcp_servers.rea]\ncommand = "npx"\nargs = ["-y", "@celaya-solutions/oopsware", "mcp"]\n',
    );

    const statuses = await readClientRegistrationStatuses(home);

    expect(statuses).toEqual([
      expect.objectContaining({
        client: "codex",
        command: ["npx", "-y", "@celaya-solutions/oopsware", "mcp"],
        state: "stale",
      }),
    ]);
  });

  it("reports an unpinned bunx registration as stale rather than aligned", async () => {
    const home = await createTestTempDirectory("rea-bunx-unpinned-");
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          rea: { command: "bunx", args: ["rea-agents", "mcp"] },
        },
      }),
    );

    const [status] = await readClientRegistrationStatuses(home);

    expect(status).toMatchObject({
      client: "claude_code",
      command: ["bunx", "rea-agents", "mcp"],
      state: "stale",
    });
  });

  it("preserves direct command identity as unknown when the current entrypoint is absent", async () => {
    const home = await createTestTempDirectory("rea-registration-unknown-");
    await mkdir(join(home, ".cursor"));
    const command = ["/opt/rea/bin/rea", "mcp"];
    await writeFile(
      join(home, ".cursor/mcp.json"),
      JSON.stringify({
        mcpServers: { rea: { command: command[0], args: [command[1]] } },
      }),
    );

    const [status] = await readClientRegistrationStatuses(home, "");

    expect(status).toMatchObject({
      client: "cursor",
      command,
      state: "unknown",
      remediation: expect.stringContaining("registration was retained"),
    });
  });

  it("does not use the REA process cwd to resolve a client's relative launcher path", async () => {
    const home = await createTestTempDirectory("rea-registration-relative-");
    await mkdir(join(home, ".cursor"));
    const currentEntry = resolve("./rea.mjs");
    const configPath = join(home, ".cursor/mcp.json");
    const registration = (
      scriptPath: string,
      executable = process.execPath,
    ) => ({
      mcpServers: {
        rea: { command: executable, args: [scriptPath, "mcp"] },
      },
    });
    await writeFile(configPath, JSON.stringify(registration("./rea.mjs")));

    const [relativeStatus] = await readClientRegistrationStatuses(
      home,
      currentEntry,
    );
    expect(relativeStatus).toMatchObject({
      command: [process.execPath, "./rea.mjs", "mcp"],
      state: "unknown",
    });

    await writeFile(configPath, JSON.stringify(registration(currentEntry)));
    const [absoluteStatus] = await readClientRegistrationStatuses(
      home,
      currentEntry,
    );
    expect(absoluteStatus).toMatchObject({
      command: [process.execPath, currentEntry, "mcp"],
      state: "aligned",
    });

    const relativeInterpreter = relative(process.cwd(), process.execPath);
    await writeFile(
      configPath,
      JSON.stringify(registration(currentEntry, relativeInterpreter)),
    );
    const [relativeInterpreterStatus] = await readClientRegistrationStatuses(
      home,
      currentEntry,
    );
    expect(relativeInterpreterStatus).toMatchObject({
      command: [relativeInterpreter, currentEntry, "mcp"],
      state: "unknown",
    });
  });

  it("reports the exact requested package version when it differs from this CLI", async () => {
    const home = await createTestTempDirectory(
      "rea-registration-version-drift-",
    );
    await mkdir(join(home, ".codex"));
    const command = ["npx", "-y", "@celaya-solutions/oopsware@4.1.0", "mcp"];
    await writeFile(
      join(home, ".codex/config.toml"),
      `[mcp_servers.rea]\ncommand = "${command[0]}"\nargs = ["${command[1]}", "${command[2]}", "${command[3]}"]\n`,
    );

    const [status] = await readClientRegistrationStatuses(home);

    expect(status).toMatchObject({
      client: "codex",
      command,
      package_reference: "@celaya-solutions/oopsware@4.1.0",
      state: "stale",
      remediation: expect.stringContaining(
        `current Oopsware CLI package is ${PRODUCT_IDENTITY.packageVersion}`,
      ),
    });
    expect(status?.remediation).toContain("does not resolve package-runner");
    expect(status?.remediation).toContain("oopsware setup --client codex");
  });
});

describe("commandcode registration status", () => {
  const writeCommandcodeRegistration = async (
    home: string,
    registration: Record<string, unknown>,
  ): Promise<void> => {
    await mkdir(join(home, ".commandcode"));
    await writeFile(
      join(home, ".commandcode/mcp.json"),
      JSON.stringify({ mcpServers: { rea: registration } }),
    );
  };

  const ownedArgs = (): readonly string[] => [
    "-y",
    PRODUCT_IDENTITY.registrationPackageSpecifier,
    "mcp",
  ];

  it.each([undefined, "sse"])(
    "reports transport %j as invalid",
    async (transport) => {
      const home = await createTestTempDirectory("rea-commandcode-transport-");
      await writeCommandcodeRegistration(home, {
        ...(transport === undefined ? {} : { transport }),
        command: "npx",
        args: [...ownedArgs()],
      });

      expect(await readClientRegistrationStatuses(home)).toEqual([
        expect.objectContaining({
          client: "commandcode",
          state: "invalid",
          command: [],
        }),
      ]);
    },
  );

  it("reports a disabled registration as stale", async () => {
    const home = await createTestTempDirectory("rea-commandcode-disabled-");
    await writeCommandcodeRegistration(home, {
      transport: "stdio",
      enabled: false,
      command: "npx",
      args: [...ownedArgs()],
    });

    expect(await readClientRegistrationStatuses(home)).toEqual([
      expect.objectContaining({
        client: "commandcode",
        state: "stale",
      }),
    ]);
  });
});

describe("Node-wrapped registration policy", () => {
  it.each([1, 30])(
    "accepts Codex caller-selected startup timeout %d independently of launcher",
    async (timeout) => {
      const home = await createTestTempDirectory("rea-node-registration-");
      await mkdir(join(home, ".codex"));
      const entry = resolve("scripts/rea.mjs");
      await writeFile(
        join(home, ".codex/config.toml"),
        `[mcp_servers.rea]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(entry)}, "mcp"]\nstartup_timeout_sec = ${String(timeout)}\ntool_timeout_sec = 450\n`,
      );
      const statuses = await readClientRegistrationStatuses(home, entry, {
        environment: {},
      });
      expect(statuses).toEqual([
        expect.objectContaining({
          client: "codex",
          state: "aligned",
        }),
      ]);
    },
  );

  it("keeps a short positive Codex tool timeout aligned and reports an advisory", async () => {
    const home = await createTestTempDirectory("rea-codex-short-tool-timeout-");
    await mkdir(join(home, ".codex"));
    const entry = resolve("scripts/rea.mjs");
    await writeFile(
      join(home, ".codex/config.toml"),
      `[mcp_servers.rea]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(entry)}, "mcp"]\nstartup_timeout_sec = 5\ntool_timeout_sec = 10\n`,
    );
    const [status] = await readClientRegistrationStatuses(home, entry, {
      environment: {},
    });
    expect(status).toMatchObject({
      client: "codex",
      state: "aligned",
      advisory: expect.stringContaining("tool_timeout_sec = 450 seconds"),
    });
  });

  it.each([1, 30])(
    "checks Grok Build startup timeout %d independently of launcher",
    async (timeout) => {
      const home = await createTestTempDirectory("rea-grok-registration-");
      await mkdir(join(home, ".grok"));
      const entry = resolve("scripts/rea.mjs");
      await writeFile(
        join(home, ".grok/config.toml"),
        `[mcp_servers.rea]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(entry)}, "mcp"]\nstartup_timeout_sec = ${String(timeout)}\n`,
      );
      const statuses = await readClientRegistrationStatuses(home, entry, {
        environment: {},
      });
      expect(statuses).toEqual([
        expect.objectContaining({
          client: "grok_build",
          state: timeout === 30 ? "aligned" : "stale",
        }),
      ]);
    },
  );

  it("reports Grok Build stale when rea is listed in disabled_mcp_servers", async () => {
    const home = await createTestTempDirectory("rea-grok-disabled-status-");
    await mkdir(join(home, ".grok"));
    const entry = resolve("scripts/rea.mjs");
    await writeFile(
      join(home, ".grok/config.toml"),
      `disabled_mcp_servers = ["rea"]\n[mcp_servers.rea]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(entry)}, "mcp"]\nstartup_timeout_sec = 30\n`,
    );
    expect(
      await readClientRegistrationStatuses(home, entry, { environment: {} }),
    ).toEqual([
      expect.objectContaining({ client: "grok_build", state: "stale" }),
    ]);
  });

  it("checks a direct-launcher Codex startup timeout without Node wrapping", async () => {
    const home = await createTestTempDirectory("rea-direct-registration-");
    await mkdir(join(home, ".codex"));
    await writeFile(
      join(home, ".codex/config.toml"),
      '[mcp_servers.rea]\ncommand = "/current/rea"\nargs = ["mcp"]\nstartup_timeout_sec = 1\n',
    );
    const statuses = await readClientRegistrationStatuses(
      home,
      "/current/rea",
      {
        environment: {},
      },
    );
    expect(statuses).toEqual([
      expect.objectContaining({ client: "codex", state: "stale" }),
    ]);
  });

  it.each([{ tools: ["binary_session"] }, { tools: ["*"] }])(
    "checks Copilot tool selection $tools independently of launcher",
    async ({ tools }) => {
      const home = await createTestTempDirectory("rea-node-copilot-");
      await mkdir(join(home, ".copilot"));
      const entry = resolve("scripts/rea.mjs");
      await writeFile(
        join(home, ".copilot/mcp-config.json"),
        JSON.stringify({
          mcpServers: {
            rea: {
              type: "stdio",
              command: process.execPath,
              args: [entry, "mcp"],
              tools,
            },
          },
        }),
      );
      const statuses = await readClientRegistrationStatuses(home, entry, {
        environment: {},
      });
      expect(statuses).toEqual([
        expect.objectContaining({
          client: "copilot_cli",
          state: tools.includes("*") ? "aligned" : "stale",
        }),
      ]);
    },
  );
});

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "reports an inaccessible configuration target instead of omitting its registration",
  async () => {
    const home = await createTestTempDirectory(
      "rea-registration-denied-target-",
    );
    const locked = join(home, "owned-denied");
    await mkdir(locked);
    const target = join(locked, "client.json");
    await writeFile(
      target,
      JSON.stringify({
        mcpServers: { rea: { command: "rea", args: ["mcp"] } },
      }),
    );
    const path = join(home, ".claude.json");
    await symlink(target, path);
    await chmod(locked, 0);
    try {
      const statuses = await readClientRegistrationStatuses(
        home,
        "/current/rea",
      );
      expect(
        statuses.find((status) => status.client === "claude_code"),
      ).toMatchObject({
        config_path: path,
        state: "invalid",
        command: [],
        remediation: expect.any(String),
      });
      expect(
        (await existingMaintenanceScope(home, "/current/rea", process.env))
          .clients,
      ).not.toContain("claude_code");
    } finally {
      await chmod(locked, 0o700);
    }
  },
);

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "reports an unresolved configuration location when metadata lookup is denied",
  async () => {
    const home = await createTestTempDirectory(
      "rea-registration-denied-metadata-",
    );
    const locked = join(home, "owned-denied");
    const directory = join(locked, "claude");
    await mkdir(directory, { recursive: true });
    vi.stubEnv("CLAUDE_CONFIG_DIR", directory);
    await chmod(locked, 0);
    try {
      const statuses = await readClientRegistrationStatuses(
        home,
        "/current/rea",
      );
      expect(
        statuses.find((status) => status.client === "claude_code"),
      ).toMatchObject({
        state: "invalid",
        command: [],
        remediation: expect.stringContaining("EACCES"),
      });
    } finally {
      await chmod(locked, 0o700);
    }
  },
);

it("reports a dangling configuration entry as missing without losing the detected client", async () => {
  const home = await createTestTempDirectory(
    "rea-registration-dangling-config-",
  );
  const path = join(home, ".claude.json");
  await symlink(join(home, "absent.json"), path);
  expect(
    (await readClientRegistrationStatuses(home)).find(
      (status) => status.client === "claude_code",
    ),
  ).toMatchObject({ config_path: path, state: "missing", command: [] });
});
