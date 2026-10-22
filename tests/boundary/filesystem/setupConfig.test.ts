import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import { resolveClientConfigTransactionPath } from "../../../src/application/ClientConfigPath.js";
import { readConfigurationFile } from "../../../src/application/ClientConfigurationFiles.js";
import {
  configureClientConfiguration,
  inspectClientConfiguration,
} from "../../../src/application/SetupClientConfiguration.js";
import { resolveWindowsClaudeDesktopLocation } from "../../../src/application/ClaudeDesktopConfigLocation.js";
import { supportedClients } from "../../../src/application/SupportedClients.js";
import { readClientRegistrationStatuses } from "../../../src/application/ClientRegistrationStatus.js";
import { failedConfigurationMessage } from "../../../src/application/SetupClients.js";
import { PRODUCT_IDENTITY } from "../../../src/identity.js";

const pinnedPackage = PRODUCT_IDENTITY.registrationPackageSpecifier;

describe("JSON client configuration transaction: writing configuration through safe paths", () => {
  it.skipIf(typeof process.getuid !== "function")(
    "rejects a symlink target not owned by the current user",
    async () => {
      const currentUid = process.getuid?.();
      if (currentUid === undefined)
        throw new Error("UID support is required by this test");
      let statCalls = 0;
      expect(
        await resolveClientConfigTransactionPath("/config", {
          lstat: () => {
            statCalls += 1;
            return Promise.resolve({
              uid: statCalls === 1 ? currentUid : currentUid + 1,
              isFile: () => statCalls > 1,
              isSymbolicLink: () => statCalls === 1,
            });
          },
          realpath: () => Promise.resolve("/target"),
        }),
      ).toBeUndefined();
    },
  );

  it("preserves existing keys, creates a backup, and reads back the MCP entry", async () => {
    const directory = await createTestTempDirectory("rea-setup-");
    const configPath = join(directory, "mcp.json");
    const original =
      '{"theme":"dark","mcpServers":{"other":{"command":"other"}}}\n';
    await writeFile(configPath, original);
    const result = await configureClientConfiguration({
      name: "cursor",
      configPath,
      format: "json",
    });
    expect(result.status).toBe("configured");
    expect(await readFile(`${configPath}.rea.backup`, "utf8")).toBe(original);
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      theme: "dark",
      mcpServers: {
        other: { command: "other" },
        rea: {
          command: "npx",
          args: ["-y", pinnedPackage, "mcp"],
        },
      },
    });
  });

  it("updates a symlink target without replacing the JSON config symlink", async () => {
    const directory = await createTestTempDirectory("rea-setup-");
    const targetPath = join(directory, "managed.json");
    const configPath = join(directory, "mcp.json");
    const original = '{"theme":"dark"}\n';
    await writeFile(targetPath, original);
    await symlink(targetPath, configPath);

    expect(
      await configureClientConfiguration({
        name: "cursor",
        configPath,
        format: "json",
      }),
    ).toMatchObject({ status: "configured" });
    expect((await lstat(configPath)).isSymbolicLink()).toBe(true);
    expect(await readFile(`${configPath}.rea.backup`, "utf8")).toBe(original);
    expect(JSON.parse(await readFile(targetPath, "utf8"))).toMatchObject({
      theme: "dark",
      mcpServers: {
        rea: {
          command: "npx",
          args: ["-y", pinnedPackage, "mcp"],
        },
      },
    });
    expect(
      await configureClientConfiguration({
        name: "cursor",
        configPath,
        format: "json",
      }),
    ).toEqual({
      status: "unchanged",
    });
  });

  it("fails before mutation when a JSON config symlink is dangling", async () => {
    const directory = await createTestTempDirectory("rea-setup-");
    const configPath = join(directory, "mcp.json");
    await symlink(join(directory, "missing.json"), configPath);

    expect(
      await configureClientConfiguration({
        name: "cursor",
        configPath,
        format: "json",
      }),
    ).toEqual({
      status: "failed",
      reason: "path",
    });
    expect((await lstat(configPath)).isSymbolicLink()).toBe(true);
    await expect(
      readFile(`${configPath}.rea.backup`, "utf8"),
    ).rejects.toThrow();
  });
});

describe("JSON client configuration transaction: keeping matching configuration unchanged", () => {
  it("performs no write or second backup when configuration already matches", async () => {
    const directory = await createTestTempDirectory("rea-setup-");
    const configPath = join(directory, "mcp.json");
    await writeFile(
      configPath,
      `${JSON.stringify({ mcpServers: { rea: { command: "npx", args: ["-y", pinnedPackage, "mcp"] } } })}\n`,
    );
    expect(
      await configureClientConfiguration({
        name: "cursor",
        configPath,
        format: "json",
      }),
    ).toEqual({
      status: "unchanged",
    });
    await expect(
      readFile(`${configPath}.rea.backup`, "utf8"),
    ).rejects.toThrow();
  });

  it("does not rewrite an equivalent configuration with reordered environment keys", async () => {
    const directory = await createTestTempDirectory("rea-setup-");
    const configPath = join(directory, "mcp.json");
    await writeFile(
      configPath,
      `${JSON.stringify({
        mcpServers: {
          rea: {
            env: {
              JAVA_HOME: "/usr/lib/jvm/jdk-21",
              GHIDRA_INSTALL_DIR: "/opt/ghidra",
            },
            args: ["-y", pinnedPackage, "mcp"],
            command: "npx",
          },
        },
      })}\n`,
    );

    expect(
      await configureClientConfiguration(
        { name: "cursor", configPath, format: "json" },
        {
          GHIDRA_INSTALL_DIR: "/opt/ghidra",
          JAVA_HOME: "/usr/lib/jvm/jdk-21",
        },
      ),
    ).toEqual({ status: "unchanged" });
    await expect(
      readFile(`${configPath}.rea.backup`, "utf8"),
    ).rejects.toThrow();
  });
});

describe("JSON client configuration migration and provider paths", () => {
  it("migrates an unversioned npx registration and preserves sibling configuration", async () => {
    const directory = await createTestTempDirectory("rea-setup-");
    const configPath = join(directory, "mcp.json");
    const original =
      '{"theme":"dark","mcpServers":{"rea":{"command":"npx","args":["-y","@celaya-solutions/oopsware","mcp"]},"other":{"command":"other"}}}\n';
    await writeFile(configPath, original);

    expect(
      await configureClientConfiguration({
        name: "cursor",
        configPath,
        format: "json",
      }),
    ).toEqual(expect.objectContaining({ status: "configured" }));

    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      theme: "dark",
      mcpServers: {
        rea: {
          command: "npx",
          args: ["-y", pinnedPackage, "mcp"],
        },
        other: { command: "other" },
      },
    });
    expect(await readFile(`${configPath}.rea.backup`, "utf8")).toBe(original);
  });

  it("persists a custom Hopper launcher and remains idempotent", async () => {
    const directory = await createTestTempDirectory("rea-setup-");
    const configPath = join(directory, "mcp.json");
    const hopperPath = "/Applications/Hopper v6.app/Contents/MacOS/hopper";
    const client = { name: "cursor", configPath, format: "json" } as const;
    const original = "{}\n";
    await writeFile(configPath, original);
    expect(
      await configureClientConfiguration(client, {
        HOPPER_LAUNCHER_PATH: hopperPath,
      }),
    ).toMatchObject({
      status: "configured",
    });
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      mcpServers: {
        rea: {
          command: "npx",
          args: ["-y", pinnedPackage, "mcp"],
          env: { HOPPER_LAUNCHER_PATH: hopperPath },
        },
      },
    });
    expect(
      await configureClientConfiguration(client, {
        HOPPER_LAUNCHER_PATH: hopperPath,
      }),
    ).toEqual({
      status: "unchanged",
    });
    expect(
      await configureClientConfiguration(client, {
        HOPPER_LAUNCHER_PATH: "/opt/hopper/bin/Hopper",
      }),
    ).toMatchObject({ status: "configured" });
    expect(await readFile(`${configPath}.rea.backup`, "utf8")).toBe(original);
  });

  it("adds exact BYO Ghidra and Java paths without installing dependencies", async () => {
    const directory = await createTestTempDirectory("rea-setup-");
    const configPath = join(directory, "mcp.json");
    const client = { name: "cursor", configPath, format: "json" } as const;
    const environment = {
      GHIDRA_INSTALL_DIR: "/opt/ghidra_12.1.4_PUBLIC",
      JAVA_HOME: "/usr/lib/jvm/jdk-21",
    };

    expect(
      await configureClientConfiguration(client, environment),
    ).toMatchObject({
      status: "configured",
    });
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      mcpServers: {
        rea: {
          env: {
            GHIDRA_INSTALL_DIR: environment.GHIDRA_INSTALL_DIR,
            JAVA_HOME: environment.JAVA_HOME,
          },
        },
      },
    });
    expect(await configureClientConfiguration(client, environment)).toEqual({
      status: "unchanged",
    });
  });

  it("refuses malformed existing JSON without overwriting it", async () => {
    const directory = await createTestTempDirectory("rea-setup-");
    const configPath = join(directory, "mcp.json");
    await writeFile(configPath, "not-json");
    expect(
      await configureClientConfiguration({
        name: "cursor",
        configPath,
        format: "json",
      }),
    ).toEqual({
      status: "failed",
      reason: "readback",
    });
    expect(await readFile(configPath, "utf8")).toBe("not-json");
  });

  it("refuses a non-object JSON root without overwriting it", async () => {
    const original = "null";
    const directory = await createTestTempDirectory("rea-setup-");
    const configPath = join(directory, "mcp.json");
    await writeFile(configPath, original);
    expect(
      await configureClientConfiguration({
        name: "cursor",
        configPath,
        format: "json",
      }),
    ).toEqual({
      status: "failed",
      reason: "readback",
    });
    expect(await readFile(configPath, "utf8")).toBe(original);
    await expect(
      readFile(`${configPath}.rea.backup`, "utf8"),
    ).rejects.toThrow();
  });

  it("preserves a non-object mcpServers value", async () => {
    const servers = "[]";
    const directory = await createTestTempDirectory("rea-setup-");
    const configPath = join(directory, "mcp.json");
    const original = `{"mcpServers":${servers}}`;
    await writeFile(configPath, original);
    expect(
      await configureClientConfiguration({
        name: "cursor",
        configPath,
        format: "json",
      }),
    ).toEqual({
      status: "failed",
      reason: "readback",
    });
    expect(await readFile(configPath, "utf8")).toBe(original);
    await expect(
      readFile(`${configPath}.rea.backup`, "utf8"),
    ).rejects.toThrow();
  });
});

describe("JSON client configuration shape diagnostics", () => {
  it.each([
    {
      format: "json" as const,
      original:
        '{"__proto__":{"mcpServers":{"rea":{"command":"rea","args":["mcp"]}}}}',
      serversKey: "mcpServers",
    },
    {
      format: "opencode" as const,
      original:
        '{"mcp":{"__proto__":{"servers":{"rea":{"type":"local","command":["rea","mcp"]}}}}}',
      serversKey: "mcp",
    },
  ])(
    "registers an own server instead of trusting inherited $format settings",
    async ({ format, original, serversKey }) => {
      const directory = await createTestTempDirectory("rea-setup-prototype-");
      const configPath = join(directory, "mcp.json");
      const client = {
        name: format === "json" ? "cursor" : "opencode",
        configPath,
        format,
      };
      await writeFile(configPath, original);
      expect(
        await inspectClientConfiguration(client, {}, ["rea", "mcp"]),
      ).toMatchObject({ status: "update" });
      expect(
        await configureClientConfiguration(client, {}, ["rea", "mcp"]),
      ).toMatchObject({ status: "configured" });
      const document = JSON.parse(await readFile(configPath, "utf8"));
      expect(Object.hasOwn(document, serversKey)).toBe(true);
      expect(Object.hasOwn(document[serversKey], "rea")).toBe(true);
      expect(document[serversKey].rea.command).toEqual(
        format === "json" ? "rea" : ["rea", "mcp"],
      );
      const originalDocument = JSON.parse(original);
      expect(
        format === "json" ? document.__proto__ : document[serversKey].__proto__,
      ).toEqual(
        format === "json"
          ? originalDocument.__proto__
          : originalDocument[serversKey].__proto__,
      );
      expect(await readFile(`${configPath}.rea.backup`, "utf8")).toBe(original);
      expect(
        await inspectClientConfiguration(client, {}, ["rea", "mcp"]),
      ).toMatchObject({ status: "already_current" });
    },
  );

  it.each([
    ['{"mcpServers":null,"keep":1}', '"mcpServers" must be an object'],
    ["[]", "The configuration root must be an object"],
    ['{"mcpServers":"x"}', '"mcpServers" must be an object'],
  ] as const)(
    "names structural shape problems in setup remediation: %s",
    async (original, problem) => {
      const directory = await createTestTempDirectory("rea-setup-shape-");
      const configPath = join(directory, "mcp.json");
      const client = {
        name: "cursor",
        configPath,
        format: "json" as const,
      };
      await writeFile(configPath, original);
      const read = await readConfigurationFile(configPath, "json");
      expect(read.ok).toBe(false);
      if (read.ok) throw new Error("expected malformed configuration");
      expect(read.error.detail).toBe(
        `Configuration ${configPath} is malformed: ${problem}`,
      );
      expect(
        await inspectClientConfiguration(client, {}, ["rea", "mcp"]),
      ).toEqual({
        status: "invalid",
        remediation: `Configuration ${configPath} is malformed: ${problem}`,
      });
      expect(await readFile(configPath, "utf8")).toBe(original);
    },
  );
});

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "preserves the private-path access diagnostic during the final MSIX target recheck",
  async () => {
    const home = await createTestTempDirectory("rea-msix-recheck-denied-");
    const configPath = join(home, "client.json");
    const locked = join(home, "private");
    const privateConfigPath = join(locked, "client.json");
    const original = '{"keep":true}\n';
    await writeFile(configPath, original);
    await mkdir(locked);
    await chmod(locked, 0);
    try {
      const result = await configureClientConfiguration({
        name: "claude_desktop",
        format: "json",
        configPath,
        msixPackage: {
          packageFamilyName: "Claude_pzs8sxrjxfjjc",
          appDataConfigPath: configPath,
          privateConfigPath,
          virtualizedRoots: [],
          processView: "direct",
        },
      });
      expect(result).toMatchObject({
        status: "failed",
        reason: "target_unavailable",
        failure: {
          kind: "inspect",
          path: privateConfigPath,
          detail: expect.stringContaining("EACCES"),
        },
      });
      if (result.status !== "failed")
        throw new Error("Expected inspection failure");
      expect(failedConfigurationMessage(result)).toContain(privateConfigPath);
      expect(failedConfigurationMessage(result)).not.toContain(
        "began reading a different",
      );
      expect(await readFile(configPath, "utf8")).toBe(original);
      expect(await readdir(home)).toEqual(["client.json", "private"]);
    } finally {
      await chmod(locked, 0o700);
    }
  },
);

it.skipIf(process.platform === "win32")(
  "selects literal AppData directories with trailing spaces through native filesystem discovery",
  async () => {
    const home = await createTestTempDirectory("rea-appdata-literal-root-");
    const environment = {
      APPDATA: join(home, "Roaming "),
      LOCALAPPDATA: join(home, "Local "),
    };
    const appDataConfig = join(
      environment.APPDATA,
      "Claude",
      "claude_desktop_config.json",
    );
    await mkdir(join(environment.APPDATA, "Claude"), { recursive: true });
    await writeFile(appDataConfig, "{}");
    // The trimmed alternate root contains a different package identity and must not be selected.
    await mkdir(
      join(home, "Local", "Packages", "AnthropicPBC.Claude_fnn82j28hfe8t"),
      { recursive: true },
    );
    expect(resolveWindowsClaudeDesktopLocation(home, environment)).toEqual({
      ok: true,
      value: {
        configPath: appDataConfig,
        markerPath: join(environment.APPDATA, "Claude"),
      },
    });
    expect(await readFile(appDataConfig, "utf8")).toBe("{}");
  },
);

it("keeps setup and registration diagnostics blocked for an unrecognized Claude package deployment", async () => {
  const home = await createTestTempDirectory("rea-claude-deployment-unknown-");
  const environment = {
    APPDATA: join(home, "Roaming"),
    LOCALAPPDATA: join(home, "Local"),
  };
  await mkdir(
    join(
      environment.LOCALAPPDATA,
      "Packages",
      "AnthropicPBC.Claude_fnn82j28hfe8t",
    ),
    { recursive: true },
  );
  const config = join(
    environment.APPDATA,
    "Claude",
    "claude_desktop_config.json",
  );
  await mkdir(join(environment.APPDATA, "Claude"), { recursive: true });
  const original = '{"mcpServers":{"rea":{"command":"rea","args":["mcp"]}}}\n';
  await writeFile(config, original);
  const client = supportedClients(home, "win32", environment).find(
    (client) => client.name === "claude_desktop",
  );
  if (client === undefined) throw new Error("Claude client definition missing");
  expect(client.configPathError).toContain("unrecognized Claude Desktop");
  expect(await configureClientConfiguration(client)).toMatchObject({
    status: "failed",
    reason: "path",
  });
  expect(
    (
      await readClientRegistrationStatuses(home, "/current/rea", {
        platform: "win32",
        environment,
      })
    ).find((status) => status.client === "claude_desktop"),
  ).toMatchObject({
    state: "invalid",
    command: [],
    remediation: expect.stringContaining("does not fall back"),
  });
  expect(await readFile(config, "utf8")).toBe(original);
  expect(await readdir(join(environment.APPDATA, "Claude"))).toEqual([
    "claude_desktop_config.json",
  ]);
});
