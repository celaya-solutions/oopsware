import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readClientRegistrationStatuses } from "../../../src/application/ClientRegistrationStatus.js";
import { npxRegistrationCommand } from "../../../src/application/ClientRegistrationIdentity.js";
import {
  configureClientConfiguration,
  inspectClientConfiguration,
} from "../../../src/application/SetupClientConfiguration.js";
import { skillDestinations } from "../../../src/application/SetupSkill.js";
import { supportedClients } from "../../../src/application/SupportedClients.js";
import { systemUninstallHost } from "../../../src/application/Uninstall.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { clearClientLocationEnvironment } from "../../fixtures/clientEnvironment.js";

/** Setup writes the host's registration command; Windows wraps it in cmd.exe. */
const command = npxRegistrationCommand(process.platform);

beforeEach(clearClientLocationEnvironment);
afterEach(() => vi.unstubAllEnvs());

const freebuffClientAt = (
  home: string,
  env: Parameters<typeof supportedClients>[2] = {},
) =>
  supportedClients(home, process.platform, env).find(
    ({ name }) => name === "freebuff",
  );

/**
 * Codebuff's mcp.json entry contract, which Freebuff shares: strict stdio or
 * remote members only, or the whole file is skipped.
 */
const STDIO_MEMBERS = new Set(["type", "command", "args", "env"]);

const freebuffClient = async () => {
  const home = await createTestTempDirectory("rea-freebuff-");
  const client = freebuffClientAt(home);
  if (client?.markerPath === undefined)
    throw new Error("missing Freebuff client");
  await mkdir(client.markerPath, { recursive: true });
  await mkdir(join(home, ".agents"), { recursive: true });
  return { home, client };
};

const freebuffStatus = async (home: string) =>
  (
    await readClientRegistrationStatuses(home, undefined, {
      platform: process.platform,
      environment: {},
    })
  ).find(({ client }) => client === "freebuff");

describe("Freebuff configuration paths", () => {
  it("registers in the home .agents mcp.json that Freebuff and Codebuff read", () => {
    const client = freebuffClientAt("/home/a");
    expect(client?.configPath).toBe(join("/home/a", ".agents", "mcp.json"));
    expect(client?.markerPath).toBe(join("/home/a", ".config", "manicode"));
    expect(client?.format).toBe("freebuff");
  });

  it("detects an absolute FREEBUFF_CONFIG_DIR and ignores a relative one Freebuff refuses", () => {
    const absolute = join("/srv", "freebuff-config");
    expect(
      freebuffClientAt("/home/a", { FREEBUFF_CONFIG_DIR: absolute })
        ?.markerPath,
    ).toBe(absolute);
    expect(
      freebuffClientAt("/home/a", { FREEBUFF_CONFIG_DIR: "relative/config" })
        ?.markerPath,
    ).toBe(join("/home/a", ".config", "manicode"));
    // The override moves settings only; MCP servers stay under ~/.agents.
    expect(
      freebuffClientAt("/home/a", { FREEBUFF_CONFIG_DIR: absolute })
        ?.configPath,
    ).toBe(join("/home/a", ".agents", "mcp.json"));
  });

  it("installs the skill in the shared ~/.agents/skills root Freebuff loads", () => {
    expect(
      skillDestinations("/home/a", ["freebuff"]).map(({ path }) => path),
    ).toEqual([
      join("/home/a", ".agents", "skills", "reverse-engineer-anything"),
    ]);
  });
});

describe("Freebuff mcp.json registration", () => {
  it("writes only members Freebuff accepts, selects compact, and preserves neighbours", async () => {
    const { home, client } = await freebuffClient();
    const neighbour = {
      type: "stdio",
      command: "other-server",
      args: [],
      env: { TOKEN: "$OTHER_TOKEN" },
    };
    const remote = { type: "http", url: "https://example.test/mcp" };
    await writeFile(
      client.configPath,
      JSON.stringify({ mcpServers: { other: neighbour, remote } }, null, 2),
    );

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const parsed = JSON.parse(await readFile(client.configPath, "utf8"));
    expect(parsed.mcpServers.other).toEqual(neighbour);
    expect(parsed.mcpServers.remote).toEqual(remote);
    expect(parsed.mcpServers.rea).toEqual({
      type: "stdio",
      command: command[0],
      args: command.slice(1),
      env: { REA_MCP_INPUT_SCHEMA_PROFILE: "compact" },
    });
    expect(
      Object.keys(parsed.mcpServers.rea).every((key) => STDIO_MEMBERS.has(key)),
    ).toBe(true);

    expect(await configureClientConfiguration(client, {}, command)).toEqual({
      status: "unchanged",
    });
    expect(await freebuffStatus(home)).toMatchObject({
      state: "aligned",
      command,
    });
  });

  it("creates the file and replaces an empty one, which holds no servers", async () => {
    for (const original of [undefined, "", "  \n"]) {
      const { client } = await freebuffClient();
      if (original !== undefined) await writeFile(client.configPath, original);
      expect(
        (await configureClientConfiguration(client, {}, command)).status,
      ).toBe("configured");
      const parsed = JSON.parse(await readFile(client.configPath, "utf8"));
      expect(Object.keys(parsed.mcpServers)).toEqual(["rea"]);
    }
  });

  it("keeps an explicit full profile and reports a registration without one as stale", async () => {
    const { home, client } = await freebuffClient();
    const full = {
      type: "stdio",
      command: command[0],
      args: command.slice(1),
      env: { REA_MCP_INPUT_SCHEMA_PROFILE: "full" },
    };
    await writeFile(
      client.configPath,
      JSON.stringify({ mcpServers: { rea: full } }),
    );
    expect(await configureClientConfiguration(client, {}, command)).toEqual({
      status: "unchanged",
    });
    expect(await freebuffStatus(home)).toMatchObject({ state: "aligned" });

    const { env: _env, ...unselected } = full;
    void _env;
    await writeFile(
      client.configPath,
      JSON.stringify({ mcpServers: { rea: unselected } }),
    );
    expect(await freebuffStatus(home)).toMatchObject({ state: "stale" });
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    expect(await freebuffStatus(home)).toMatchObject({ state: "aligned" });
  });
});

describe("Freebuff mcp.json loading rules", () => {
  it("rewrites an Oopsware entry that has members Freebuff rejects", async () => {
    const { home, client } = await freebuffClient();
    await writeFile(
      client.configPath,
      JSON.stringify({
        mcpServers: {
          rea: {
            type: "stdio",
            command: command[0],
            args: command.slice(1),
            env: { REA_MCP_INPUT_SCHEMA_PROFILE: "compact" },
            timeout: 600,
          },
        },
      }),
    );
    expect(await freebuffStatus(home)).toMatchObject({
      state: "stale",
      remediation: expect.stringContaining("mcpServers.rea"),
    });
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const parsed = JSON.parse(await readFile(client.configPath, "utf8"));
    expect(parsed.mcpServers.rea).not.toHaveProperty("timeout");
    expect(await freebuffStatus(home)).toMatchObject({ state: "aligned" });
  });

  it("refuses to register beside an entry that makes Freebuff skip the file", async () => {
    const { home, client } = await freebuffClient();
    const original = JSON.stringify({
      mcpServers: { broken: { command: "other-server", enabled: true } },
    });
    await writeFile(client.configPath, original);

    expect(await inspectClientConfiguration(client, {}, command)).toMatchObject(
      {
        status: "invalid",
        remediation: expect.stringContaining("mcpServers.broken"),
      },
    );
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("failed");
    expect(await readFile(client.configPath, "utf8")).toBe(original);
    await expect(
      readFile(`${client.configPath}.rea.backup`),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await writeFile(
      client.configPath,
      JSON.stringify({
        mcpServers: {
          broken: { command: "other-server", enabled: true },
          rea: {
            type: "stdio",
            command: command[0],
            args: command.slice(1),
            env: { REA_MCP_INPUT_SCHEMA_PROFILE: "compact" },
          },
        },
      }),
    );
    expect(await freebuffStatus(home)).toMatchObject({
      state: "stale",
      remediation: expect.stringContaining("mcpServers.broken"),
    });
  });

  it("refuses an Oopsware environment value Freebuff would resolve as a reference", async () => {
    const { client } = await freebuffClient();
    const original = JSON.stringify({
      mcpServers: {
        rea: {
          type: "stdio",
          command: command[0],
          args: command.slice(1),
          env: {
            REA_MCP_INPUT_SCHEMA_PROFILE: "compact",
            HOPPER_LAUNCHER_PATH: "$HOME/Hopper",
          },
        },
      },
    });
    await writeFile(client.configPath, original);
    expect(await inspectClientConfiguration(client, {}, command)).toMatchObject(
      {
        status: "invalid",
        remediation: expect.stringContaining(
          "mcpServers.rea.env.HOPPER_LAUNCHER_PATH",
        ),
      },
    );
    expect(await readFile(client.configPath, "utf8")).toBe(original);
  });

  it.each([
    ["a byte-order mark", '﻿{"mcpServers":{}}'],
    ["a comment", '{\n  // servers\n  "mcpServers": {}\n}'],
    ["a trailing comma", '{"mcpServers":{"other":{"command":"x"},}}'],
  ])(
    "does not rewrite a file with %s that Freebuff cannot parse",
    async (_case, original) => {
      const { home, client } = await freebuffClient();
      await writeFile(client.configPath, original);
      expect(
        await inspectClientConfiguration(client, {}, command),
      ).toMatchObject({ status: "invalid" });
      expect(
        (await configureClientConfiguration(client, {}, command)).status,
      ).toBe("failed");
      expect(await readFile(client.configPath, "utf8")).toBe(original);
      expect(await freebuffStatus(home)).toMatchObject({ state: "invalid" });
    },
  );
});

describe("Freebuff uninstall", () => {
  it("uninstalls only the Oopsware entry, including through the shared ZCode fallback", async () => {
    const { home, client } = await freebuffClient();
    const other = { command: "other-server" };
    await writeFile(
      client.configPath,
      JSON.stringify({ mcpServers: { other } }),
    );
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");

    const host = systemUninstallHost(home, undefined, {}, process.platform);
    const sharing = (await host.clients()).filter(
      ({ configPath }) => configPath === client.configPath,
    );
    expect(sharing.map(({ name, format }) => [name, format])).toEqual([
      ["zcode", "zcode_fallback"],
      ["freebuff", "freebuff"],
    ]);
    const results = [];
    for (const entry of sharing) results.push(await host.removeClient(entry));
    expect(results.map(({ status }) => status)).toEqual(["removed", "skipped"]);
    expect(JSON.parse(await readFile(client.configPath, "utf8"))).toEqual({
      mcpServers: { other },
    });
  });
});
