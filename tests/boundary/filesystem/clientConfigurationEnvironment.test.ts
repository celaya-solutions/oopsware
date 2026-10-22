import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { expect, it } from "vitest";

import {
  clientRegistrationEntry,
  effectiveClientServer,
  parseClientConfiguration,
  serializeClientConfiguration,
} from "../../../src/application/ClientConfigurationDocument.js";
import {
  clientConfigurationAligned,
  configureClientConfiguration,
  inspectClientConfiguration,
} from "../../../src/application/SetupClientConfiguration.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { readClientRegistrationStatuses } from "../../../src/application/ClientRegistrationStatus.js";
import {
  clientRegistrationEnvironmentDetails,
  clientRegistrationEnvironmentDetailsWithBudget,
} from "../../../src/application/ClientRegistrationEnvironment.js";
import { snapshotEnvironment } from "../../../src/process/snapshotEnvironment.js";
import { npxRegistrationCommand } from "../../../src/application/ClientRegistrationIdentity.js";
import { ok } from "../../../src/domain/result.js";

it("awaits the owner-parsed provider request budget without changing caller strings", async () => {
  const parsed = parseClientConfiguration(
    JSON.stringify({
      mcpServers: {
        rea: {
          command: "rea",
          args: ["mcp"],
          env: {
            REA_ANALYSIS_PROVIDER: "ida",
            REA_IDA_MCP_CONFIG: "/tmp/rea-registration.json/",
          },
        },
      },
    }),
    "json",
  );
  const details = await clientRegistrationEnvironmentDetailsWithBudget(
    parsed,
    {},
    "effective",
    async (provider) => {
      expect(provider).toBe("ida");
      return ok(17);
    },
  );
  expect(details).toMatchObject({
    ok: true,
    value: {
      values: { REA_IDA_MCP_CONFIG: "/tmp/rea-registration.json/" },
      timeoutInputs: { providerRequestTimeoutMs: 17 },
    },
  });
});

it.each(["win32", "linux"] as const)(
  "uses the selected %s identity when inspecting lowercase registration settings",
  async (platform) => {
    const home = await createTestTempDirectory("rea-selected-platform-env-");
    const path = join(home, ".cursor/mcp.json");
    await mkdir(join(home, ".cursor"));
    await writeFile(
      path,
      JSON.stringify({
        mcpServers: {
          rea: clientRegistrationEntry(
            "json",
            npxRegistrationCommand(platform),
            { rea_analysis_provider: "invalid provider" },
          ),
        },
      }),
    );
    const statuses = await readClientRegistrationStatuses(home, "rea", {
      platform,
      environment: {},
    });
    expect(statuses.find(({ client }) => client === "cursor")).toMatchObject({
      state: platform === "win32" ? "invalid" : "aligned",
    });
  },
);

it.skipIf(process.platform !== "win32").each([
  {
    key: "rea_analysis_provider",
    override: "REA_ANALYSIS_PROVIDER",
    value: "ghidra",
    duplicate: false,
  },
  { key: "true", override: "TRUE", value: "chosen", duplicate: false },
  { key: '"true"', override: "true", value: "chosen", duplicate: true },
  {
    key: "rea_analysis_provider",
    override: "REA_ANALYSIS_PROVIDER",
    value: "ghidra",
    duplicate: true,
  },
])(
  "preserves DSH scalar-key identity and comments when replacing $key",
  async ({ key, override, value, duplicate }) => {
    const root = await createTestTempDirectory("rea-dsh-alias-comments-");
    const configPath = join(root, "cordis.patch.yml");
    const source = `- insert:\n    - id: rea-mcp\n      name: "@deepseek-ai/dsh-mcp-client"\n      config:\n        serverName: rea\n        transport: stdio\n        command: old-rea\n        args: [mcp]\n        env:\n          # retain preceding rationale\n          ${key}: "hopper" # retain inline rationale\n${duplicate ? `          ${override}: "ghidra" # retain winning rationale\n` : ""}          CUSTOM: !!js caller.custom\n`;
    await writeFile(configPath, source);
    const client = { name: "dsh", format: "dsh", configPath } as const;
    const result = await configureClientConfiguration(
      client,
      { [override]: value },
      ["rea", "mcp"],
    );
    expect(result, JSON.stringify(result)).toMatchObject({
      status: "configured",
    });
    const text = await readFile(configPath, "utf8");
    expect(text).toContain("# retain preceding rationale");
    expect(text).toContain("# retain inline rationale");
    if (duplicate) expect(text).toContain("# retain winning rationale");
    expect(text).toContain("!!js caller.custom");
    const env = clientRegistrationEnvironmentDetails(
      parseClientConfiguration(text, "dsh"),
    );
    expect(env.ok).toBe(true);
    if (!env.ok) throw env.error;
    expect(env.value.values).toHaveProperty(override, value);
    expect(
      Object.keys(env.value.values).filter(
        (name) => name.toUpperCase() === override.toUpperCase(),
      ),
    ).toEqual([override]);
    expect(await readFile(`${configPath}.rea.backup`, "utf8")).toBe(source);
    expect(
      await configureClientConfiguration(client, { [override]: value }, [
        "rea",
        "mcp",
      ]),
    ).toEqual({ status: "unchanged" });
  },
);

it.skipIf(process.platform !== "win32")(
  "preserves a lowercase explicit Kimi schema profile instead of inserting a conflicting default",
  async () => {
    const home = await createTestTempDirectory("rea-kimi-case-");
    await mkdir(join(home, ".kimi-code"));
    const configPath = join(home, ".kimi-code/mcp.json");
    await writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          rea: {
            command: "old-rea",
            args: ["mcp"],
            env: { rea_mcp_input_schema_profile: "full" },
          },
        },
      }),
    );
    const client = { name: "kimi", format: "kimi", configPath } as const;
    expect(
      await configureClientConfiguration(
        client,
        {},
        npxRegistrationCommand(process.platform),
      ),
    ).toMatchObject({ status: "configured" });
    const parsed = parseClientConfiguration(
      await readFile(configPath, "utf8"),
      "kimi",
    );
    expect(effectiveClientServer(parsed, "rea")).toHaveProperty("env", {
      rea_mcp_input_schema_profile: "full",
    });
    const statuses = await readClientRegistrationStatuses(home, "rea", {
      environment: {},
    });
    expect(statuses.find(({ client }) => client === "kimi")).toMatchObject({
      state: "aligned",
    });
  },
);

it
  .skipIf(process.platform !== "win32")
  .each(["hopper", "!!js caller.provider"])(
  "replaces a Windows DSH environment alias without evaluating %s",
  async (stored) => {
    const root = await createTestTempDirectory("rea-dsh-case-");
    const configPath = join(root, "cordis.patch.yml");
    const source = `- insert:\n    - id: rea-mcp\n      name: "@deepseek-ai/dsh-mcp-client"\n      config:\n        serverName: rea\n        transport: stdio\n        command: old-rea\n        args: [mcp]\n        env:\n          rea_analysis_provider: ${stored}\n          CUSTOM: !!js caller.custom\n`;
    await writeFile(configPath, source);
    const client = { name: "dsh", format: "dsh", configPath } as const;
    const overrides = { REA_ANALYSIS_PROVIDER: "ghidra" };
    const configured = await configureClientConfiguration(client, overrides, [
      "rea",
      "mcp",
    ]);
    expect(configured, JSON.stringify(configured)).toMatchObject({
      status: "configured",
    });
    const text = await readFile(configPath, "utf8");
    expect(text).not.toContain("rea_analysis_provider:");
    expect(text).toContain("REA_ANALYSIS_PROVIDER: ghidra");
    expect(text).toContain("!!js caller.custom");
    const details = clientRegistrationEnvironmentDetails(
      parseClientConfiguration(text, "dsh"),
    );
    expect(details.ok).toBe(true);
    if (!details.ok) throw details.error;
    expect(details.value.timeoutInputs.analysisProvider).toBe("ghidra");
    expect(
      await configureClientConfiguration(client, overrides, ["rea", "mcp"]),
    ).toEqual({ status: "unchanged" });
  },
);

it.skipIf(process.platform !== "win32").each([
  {
    existing: { rea_analysis_provider: "hopper" },
    overrides: { REA_ANALYSIS_PROVIDER: "ghidra" },
    expected: "ghidra",
  },
  {
    existing: { REA_ANALYSIS_PROVIDER: "ghidra" },
    overrides: { rea_analysis_provider: "hopper" },
    expected: "hopper",
  },
])(
  "keeps Windows override precedence consistent with the launched environment: $expected",
  ({ existing, overrides, expected }) => {
    const parsed = parseClientConfiguration(
      JSON.stringify({
        mcpServers: { rea: { command: "rea", args: ["mcp"], env: existing } },
      }),
      "json",
    );
    const result = clientRegistrationEnvironmentDetails(parsed, overrides);
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.value.timeoutInputs.analysisProvider).toBe(expected);
    expect(snapshotEnvironment(result.value.values).REA_ANALYSIS_PROVIDER).toBe(
      expected,
    );
    expect(Object.keys(result.value.values)).toHaveLength(1);
    const child = spawnSync(
      process.execPath,
      ["-e", "process.stdout.write(process.env.REA_ANALYSIS_PROVIDER ?? '')"],
      {
        env: result.value.values,
        encoding: "utf8",
        timeout: 5_000,
      },
    );
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toBe(expected);
  },
);

it.skipIf(process.platform !== "win32")(
  "rejects invalid lowercase known settings before writing a Windows registration",
  async () => {
    const root = await createTestTempDirectory(
      "rea-invalid-lowercase-environment-",
    );
    const configPath = join(root, "config.json");
    const original = JSON.stringify({
      mcpServers: {
        rea: {
          command: "rea",
          args: ["mcp"],
          env: { rea_analysis_provider: "invalid provider" },
        },
      },
    });
    await writeFile(configPath, original);
    const result = await configureClientConfiguration(
      { name: "cursor", format: "json", configPath },
      {},
      ["rea", "mcp"],
    );
    expect(result).toMatchObject({ status: "failed" });
    expect(await readFile(configPath, "utf8")).toBe(original);
    await expect(access(`${configPath}.rea.backup`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

it.each([
  ["cursor", "json", "mcpServers", "env"],
  ["codex", "toml", "mcp_servers", "env"],
  ["opencode", "opencode", "mcp", "environment"],
  ["hermes", "hermes", "mcp_servers", "env"],
] as const)(
  "preserves %s server environment through command and provider updates",
  async (name, format, serversKey, environmentKey) => {
    const root = await createTestTempDirectory("rea-setup-environment-");
    const configPath = join(root, "config");
    const client = { name, format, configPath };
    const custom = {
      REA_MCP_INPUT_SCHEMA_PROFILE: "compact",
      REA_MCP_OUTPUT_SCHEMA_PROFILE: "off",
      REA_MCP_MAX_RESPONSE_BYTES: "33554432",
      REA_BROWSER_EXECUTABLE: join(root, "custom-browser"),
      GHIDRA_INSTALL_DIR: join(root, "old-ghidra"),
      HOPPER_LOADER_ARGS_JSON: '["", "--loader", "Mach-O"]',
      REA_REFERENCE_SECRET_PATTERNS_JSON: '["*.private", "local/**"]',
      REA_GHIDRA_LANGUAGE_ID: "x86:LE:32:default",
      REA_GHIDRA_COMPILER_SPEC_ID: "borlandcpp",
      CALLER_SETTING: "preserve exactly",
    };
    const serialized = serializeClientConfiguration(
      {
        [serversKey]: {
          rea: clientRegistrationEntry(format, ["rea-old", "mcp"], custom),
          other: clientRegistrationEntry(format, ["other"], { OTHER: "keep" }),
        },
      },
      format,
    );
    if (!serialized.ok) throw new Error("fixture serialization failed");
    const original = serialized.value;
    await writeFile(configPath, original);
    const providers = { GHIDRA_INSTALL_DIR: join(root, "new-ghidra") };
    const command = ["rea", "mcp"];
    expect(
      await inspectClientConfiguration(client, providers, command),
    ).toMatchObject({ status: "update" });
    expect(
      await configureClientConfiguration(client, providers, command),
    ).toMatchObject({ status: "configured" });
    const configured = await readFile(configPath, "utf8");
    const parsed = parseClientConfiguration(configured, format);
    expect(effectiveClientServer(parsed, "rea")).toHaveProperty(
      environmentKey,
      { ...custom, ...providers },
    );
    expect(effectiveClientServer(parsed, "other")).toEqual(
      effectiveClientServer(
        parseClientConfiguration(original, format),
        "other",
      ),
    );
    expect(await readFile(`${configPath}.rea.backup`, "utf8")).toBe(original);
    expect(await clientConfigurationAligned(client, providers, command)).toBe(
      true,
    );
    expect(
      await inspectClientConfiguration(client, providers, command),
    ).toEqual({ status: "already_current" });
    expect(
      await configureClientConfiguration(client, providers, command),
    ).toEqual({ status: "unchanged" });
    expect(await readFile(configPath, "utf8")).toBe(configured);
  },
);

it("retains legacy OpenCode environment when migrating into a native server table", async () => {
  const root = await createTestTempDirectory("rea-opencode-environment-");
  const configPath = join(root, "opencode.json");
  const client = { name: "opencode", format: "opencode", configPath } as const;
  const custom = { REA_MCP_INPUT_SCHEMA_PROFILE: "compact" };
  await writeFile(
    configPath,
    JSON.stringify({
      mcp: {
        rea: clientRegistrationEntry("opencode", ["old", "mcp"], custom),
        servers: {
          other: clientRegistrationEntry("opencode_v2", ["other"], {}),
        },
      },
    }),
  );
  expect(
    await configureClientConfiguration(client, {}, ["rea", "mcp"]),
  ).toMatchObject({ status: "configured" });
  const parsed = parseClientConfiguration(
    await readFile(configPath, "utf8"),
    "opencode",
  );
  expect(parsed.legacyServers).toEqual({});
  expect(parsed.servers.rea).toEqual(
    clientRegistrationEntry("opencode_v2", ["rea", "mcp"], custom),
  );
  expect(
    await configureClientConfiguration(client, {}, ["rea", "mcp"]),
  ).toEqual({ status: "unchanged" });
});

it.each([
  [
    "non-string member",
    { REA_MCP_INPUT_SCHEMA_PROFILE: "compact", PORT: 8080 },
    "env.PORT",
  ],
  [
    "boolean member",
    { REA_MCP_INPUT_SCHEMA_PROFILE: "compact", FLAG: true },
    "env.FLAG",
  ],
  [
    "null member",
    { REA_MCP_INPUT_SCHEMA_PROFILE: "compact", VALUE: null },
    "env.VALUE",
  ],
  ["array", [], "env"],
  ["string", "not-a-map", "env"],
  ["null map", null, "env"],
  [
    "empty profile",
    { REA_MCP_INPUT_SCHEMA_PROFILE: "" },
    "REA_MCP_INPUT_SCHEMA_PROFILE",
  ],
  [
    "invalid profile",
    { REA_MCP_INPUT_SCHEMA_PROFILE: "bogus" },
    "REA_MCP_INPUT_SCHEMA_PROFILE",
  ],
  [
    "empty output profile",
    { REA_MCP_OUTPUT_SCHEMA_PROFILE: "" },
    "REA_MCP_OUTPUT_SCHEMA_PROFILE",
  ],
  [
    "invalid output profile",
    { REA_MCP_OUTPUT_SCHEMA_PROFILE: "bogus" },
    "REA_MCP_OUTPUT_SCHEMA_PROFILE",
  ],
  [
    "invalid response budget",
    { REA_MCP_MAX_RESPONSE_BYTES: "1" },
    "REA_MCP_MAX_RESPONSE_BYTES",
  ],
  [
    "malformed loader JSON",
    { HOPPER_LOADER_ARGS_JSON: "{" },
    "HOPPER_LOADER_ARGS_JSON",
  ],
  [
    "non-array loader JSON",
    { HOPPER_LOADER_ARGS_JSON: "{}" },
    "HOPPER_LOADER_ARGS_JSON",
  ],
  [
    "NUL loader argument",
    { HOPPER_LOADER_ARGS_JSON: JSON.stringify(["a\0b"]) },
    "HOPPER_LOADER_ARGS_JSON",
  ],
  [
    "malformed exclusion JSON",
    { REA_REFERENCE_SECRET_PATTERNS_JSON: "{" },
    "REA_REFERENCE_SECRET_PATTERNS_JSON",
  ],
  [
    "empty exclusion pattern",
    { REA_REFERENCE_SECRET_PATTERNS_JSON: '[""]' },
    "REA_REFERENCE_SECRET_PATTERNS_JSON",
  ],
  [
    "unpaired compiler specification",
    { REA_GHIDRA_COMPILER_SPEC_ID: "borlandcpp" },
    "REA_GHIDRA_COMPILER_SPEC_ID",
  ],
] as const)(
  "refuses %s before changing the configuration",
  async (_name, env, setting) => {
    const home = await createTestTempDirectory("rea-invalid-environment-");
    const directory = join(home, ".cursor");
    const configPath = join(directory, "mcp.json");
    await mkdir(directory);
    const original = JSON.stringify({
      mcpServers: { rea: { command: "rea", args: ["mcp"], env } },
    });
    await writeFile(configPath, original);
    const client = { name: "cursor", format: "json", configPath } as const;
    expect(
      await inspectClientConfiguration(client, {}, ["rea", "mcp"]),
    ).toMatchObject({
      status: "invalid",
      remediation: expect.stringContaining(setting),
    });
    expect(
      await configureClientConfiguration(client, {}, ["rea", "mcp"]),
    ).toEqual({ status: "failed", reason: "readback" });
    expect(await clientConfigurationAligned(client, {}, ["rea", "mcp"])).toBe(
      false,
    );
    const statuses = await readClientRegistrationStatuses(home, "rea", {
      environment: {},
    });
    expect(statuses.find(({ client }) => client === "cursor")).toMatchObject({
      state: "invalid",
      remediation: expect.stringContaining(setting),
    });
    expect(await readFile(configPath, "utf8")).toBe(original);
    await expect(access(`${configPath}.rea.backup`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);
