import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import {
  compareInventory,
  runProductionMcpDoctor,
  runProductionMcpDoctorCli,
} from "../../../src/mcpDoctor.js";
import {
  CATALOG_IDENTITY,
  createCatalogIdentity,
} from "../../../src/catalogIdentity.js";
import { compactPresentationForMcpInputSchemaProfile } from "../../../src/config/mcpInputSchemaProfile.js";
import { MCP_STARTUP_POLICY } from "../../../src/mcpStartupPolicy.js";

afterEach(() => vi.useRealTimers());

describe("production MCP doctor", () => {
  it("reuses immutable compiled profile digests and preserves custom-budget identity", async () => {
    // Exercise the generated module with Node, outside Vitest's source loader.
    await promisify(execFile)(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
        import assert from "node:assert/strict";
        import { createCatalogIdentity, createCatalogDigests } from "./dist/catalogIdentity.js";
        import { RECORDED_CATALOG_DIGEST_PROFILES as profiles } from "./dist/recordedCatalogDigests.js";
        import { COMPACT_INPUT_SCHEMA_BUDGET_BYTES as budgetBytes } from "./dist/config/mcpInputSchemaProfile.js";
        assert.ok(Object.isFrozen(profiles));
        for (const input of ["full", "compact"]) {
          assert.ok(Object.isFrozen(profiles[input]));
          for (const output of ["full", "off"]) {
            const identity = createCatalogIdentity(input === "compact" ? { budgetBytes } : undefined, output);
            assert.equal(identity.digests, profiles[input][output]);
            assert.ok(Object.isFrozen(identity.digests));
          }
        }
        const selection = { budgetBytes: 1 };
        const custom = createCatalogIdentity(selection, "off");
        selection.budgetBytes = budgetBytes;
        const expected = createCatalogDigests(undefined, undefined, { budgetBytes: 1 }, "off");
        assert.deepEqual(custom.digests, expected);
        assert.notEqual(custom.digests.tools_sha256, profiles.compact.off.tools_sha256);
        assert.equal(custom.digests, custom.digests);
      `,
      ],
      { timeout: 30_000 },
    );
  }, 35_000);

  it("preserves the full-output envelope for startup failures", async () => {
    const result = await runProductionMcpDoctorCli(
      ["--json", "--full-output"],
      {
        dispatcherPath: resolve("tests/fixtures/mcpDoctorExit.mjs"),
        packageRoot: process.cwd(),
      },
    );
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.output)).toMatchObject({
      ok: false,
      error: {
        healthy: false,
        checks: [{ name: "transport", ok: false }],
      },
      meta: {
        command: "oopsware mcp doctor",
        duration: expect.stringMatching(/^\d+ms$/u),
      },
    });
  });

  it.each([
    {
      name: "full",
      environment: {
        REA_MCP_INPUT_SCHEMA_PROFILE: "full",
        REA_MCP_OUTPUT_SCHEMA_PROFILE: "full",
      },
      identity: CATALOG_IDENTITY,
    },
    {
      name: "compact",
      environment: {
        REA_MCP_INPUT_SCHEMA_PROFILE: "compact",
        REA_MCP_OUTPUT_SCHEMA_PROFILE: "full",
      },
      identity: createCatalogIdentity(
        compactPresentationForMcpInputSchemaProfile("compact"),
      ),
    },
    {
      name: "output schemas off",
      environment: {
        REA_MCP_INPUT_SCHEMA_PROFILE: "full",
        REA_MCP_OUTPUT_SCHEMA_PROFILE: "off",
      },
      identity: createCatalogIdentity(undefined, "off"),
    },
    {
      name: "compact input and output schemas off",
      environment: {
        REA_MCP_INPUT_SCHEMA_PROFILE: "compact",
        REA_MCP_OUTPUT_SCHEMA_PROFILE: "off",
      },
      identity: createCatalogIdentity(
        compactPresentationForMcpInputSchemaProfile("compact"),
        "off",
      ),
    },
  ])(
    "connects to the production stdio child and verifies the $name catalog",
    async ({ environment, identity }) => {
      const result = await runProductionMcpDoctor({
        command: process.execPath,
        args: [resolve("scripts/rea.mjs"), "mcp"],
        cwd: process.cwd(),
        environment: { ...process.env, ...environment },
      });

      expect(result).toMatchObject({
        healthy: true,
        adapter: "production-stdio",
        inventory: {
          tools: {
            expected: expect.any(Number),
            observed: expect.any(Number),
            missing: [],
            unexpected: [],
          },
        },
        request_flow: { tool: "binary_session", ok: true },
      });
      expect(result.inventory?.tools.expected).toBe(
        result.inventory?.tools.observed,
      );
      expect(result.inventory?.tools.expected).toBe(
        CATALOG_IDENTITY.counts.mcp_tools,
      );
      expect(result.identity?.expected_catalog_digest).toBe(
        identity.digests.combined_sha256,
      );
      expect(result.identity?.observed_catalog_digest).toBe(
        identity.digests.combined_sha256,
      );
    },
    30_000,
  );
});

describe("production MCP doctor probe validation", () => {
  it("rejects a schema-invalid probe while retaining the discovered inventory", async () => {
    const root = await createTestTempDirectory("rea-mcp-doctor-reply-");
    const snapshotPath = join(root, "reply.json");
    const environment = { PATH: process.env.PATH ?? "" };
    const client = new Client({ name: "doctor-reply-capture", version: "1" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("scripts/rea.mjs"), "mcp"],
      cwd: process.cwd(),
      env: environment,
      stderr: "pipe",
    });
    transport.stderr?.on("data", () => undefined);
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      const prompts = await client.listPrompts();
      const toolDefinition = tools.tools.find(
        ({ name }) => name === "binary_session",
      );
      if (toolDefinition === undefined)
        throw new Error("Production binary_session contract is missing");
      const reply = await client.callTool(
        { name: "binary_session", arguments: {} },
        { toolDefinition },
      );
      await writeFile(
        snapshotPath,
        JSON.stringify({
          serverInfo: client.getServerVersion(),
          protocolVersion: client.getNegotiatedProtocolVersion(),
          tools,
          prompts,
          reply,
        }),
      );
    } finally {
      await client.close();
      await transport.close();
    }
    // Replay real production metadata through a synthetic stdio producer.
    for (const mode of ["valid", "invalid"]) {
      const result = await runProductionMcpDoctor({
        command: process.execPath,
        args: [
          resolve("tests/fixtures/mcpDoctorReply.mjs"),
          snapshotPath,
          mode,
        ],
        cwd: process.cwd(),
        environment,
      });
      expect(result.healthy).toBe(mode === "valid");
      expect(result.inventory?.tools.observed).toBe(
        CATALOG_IDENTITY.counts.mcp_tools,
      );
      expect(result.inventory?.prompts.observed).toBe(
        CATALOG_IDENTITY.counts.mcp_prompts,
      );
      expect(result.checks).toContainEqual({
        name: "initialize",
        ok: true,
        detail: expect.any(String),
      });
      if (mode === "invalid")
        expect(result.checks).toContainEqual({
          name: "request-flow",
          ok: false,
          detail: expect.stringMatching(/output schema/iu),
        });
    }
  }, 30_000);

  it("reports exact missing, unexpected, and duplicate inventory names", () => {
    expect(compareInventory(["a", "b"], ["b", "c", "c"])).toEqual({
      expected: 2,
      observed: 3,
      missing: ["a"],
      unexpected: ["c"],
      duplicates: ["c"],
    });
  });
});

describe("production MCP doctor child lifecycle", () => {
  it("captures startup exit diagnostics", async () => {
    const result = await runProductionMcpDoctor({
      command: process.execPath,
      args: [resolve("tests/fixtures/mcpDoctorExit.mjs")],
      cwd: process.cwd(),
      environment: process.env,
      deadlineMs: 2_000,
    });
    expect(result).toMatchObject({
      healthy: false,
      checks: [{ name: "transport", ok: false }],
      diagnostics: { stderr: expect.stringContaining("startup exit") },
    });
  });

  it("retains only the stderr prefix while draining and counting the full child stream", async () => {
    const result = await runNoisyDoctorChild(`
      for (let index = 0; index < 64; index += 1) {
        await new Promise((resolve, reject) => {
          process.stderr.write(Buffer.alloc(65_536, 0x78), (error) =>
            error ? reject(error) : resolve(),
          );
        });
      }
      process.exitCode = 1;
    `);

    expect(result.healthy).toBe(false);
    expect(result.diagnostics).toEqual({
      stderr: "x".repeat(MCP_STARTUP_POLICY.doctorStderrBytes),
      stderr_bytes: 4 * 1024 * 1024,
      stderr_truncated: true,
    });
  }, 10_000);

  it("does not manufacture a replacement character when the retained prefix ends inside UTF-8", async () => {
    const prefixBytes = MCP_STARTUP_POLICY.doctorStderrBytes - 1;
    const result = await runNoisyDoctorChild(`
      for (const chunk of [
        Buffer.alloc(${prefixBytes}, 0x78),
        Buffer.from([0xe2, 0x82, 0xac]),
      ]) {
        await new Promise((resolve, reject) => {
          process.stderr.write(chunk, (error) =>
            error ? reject(error) : resolve(),
          );
        });
      }
      process.exitCode = 1;
    `);

    expect(result.diagnostics).toEqual({
      stderr: "x".repeat(prefixBytes),
      stderr_bytes: prefixBytes + 3,
      stderr_truncated: true,
    });
  });

  it("preserves replacement decoding for malformed UTF-8 within an untruncated stream", async () => {
    const result = await runNoisyDoctorChild(`
      await new Promise((resolve, reject) => {
        process.stderr.write(Buffer.from([0xff]), (error) =>
          error ? reject(error) : resolve(),
        );
      });
      process.exitCode = 1;
    `);

    expect(result.diagnostics).toEqual({
      stderr: "�",
      stderr_bytes: 1,
      stderr_truncated: false,
    });
  });

  it("kills a child that misses the absolute startup deadline", async () => {
    const root = await createTestTempDirectory("rea-mcp-doctor-");
    const pidPath = join(root, "pid");
    // Keep filesystem/process I/O real. Advance only the deadline timers,
    // after the fixture proves it started and published its PID.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = runProductionMcpDoctor({
      command: process.execPath,
      args: [resolve("tests/fixtures/mcpDoctorHang.mjs")],
      cwd: process.cwd(),
      environment: { ...process.env, REA_MCP_DOCTOR_PID_PATH: pidPath },
      deadlineMs: 60_000,
    });
    const pid = await vi.waitFor(
      async () => {
        const value = Number.parseInt(await readFile(pidPath, "utf8"), 10);
        expect(Number.isSafeInteger(value) && value > 0).toBe(true);
        return value;
      },
      { timeout: 10_000 },
    );
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await vi.waitFor(() => pending, { timeout: 10_000 });
    vi.useRealTimers();
    expect(result.healthy).toBe(false);
    expect(result.checks[0]?.detail).toMatch(/deadline|abort|timed/iu);
    await expect(waitForExit(pid)).resolves.toBeUndefined();
  }, 10_000);
});

const runNoisyDoctorChild = async (body: string) => {
  const root = await createTestTempDirectory("rea-mcp-doctor-stderr-");
  const scriptPath = join(root, "noisy.mjs");
  await writeFile(scriptPath, body);
  return runProductionMcpDoctor({
    command: process.execPath,
    args: [scriptPath],
    cwd: root,
    environment: process.env,
    deadlineMs: 5_000,
  });
};

const waitForExit = async (pid: number): Promise<void> => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (cause: unknown) {
      if (cause instanceof Error && "code" in cause && cause.code === "ESRCH")
        return;
      throw cause;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`MCP doctor fixture process ${String(pid)} remained alive`);
};
