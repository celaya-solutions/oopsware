import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, expect } from "vitest";

import { createEvidence, parseEvidence } from "../../../src/domain/evidence.js";
import { managedNativeVerificationResultSchema } from "../../../src/domain/managed/managedNativeVerificationSchemas.js";
import { buildManagedPeFixture } from "../../../src/dotnet/ManagedPe.fixture.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const client = new Client({ name: "managed-native-adapters", version: "1" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve("scripts/rea.mjs"), "mcp"],
  cwd: process.cwd(),
  env: { PATH: process.env.PATH ?? "" },
  stderr: "pipe",
});
beforeAll(async () => {
  await client.connect(transport);
  transport.stderr?.on("data", () => undefined);
});
afterAll(async () => {
  await Promise.all([client.close(), transport.close()]);
});

/** Authentic native Evidence whose operation the workflow cannot read symbols from. */
const signatureEvidence = () =>
  createEvidence(
    {
      path: "/usr/bin/true",
      sha256: "a".repeat(64),
      format: "mach-o",
      architecture: "arm64",
    },
    { id: "native", name: "Native", version: "simulated" },
    {
      operation: "inspect_signature",
      parameters: {},
      result: { signed: true },
      limitations: ["No native provider executed."],
    },
  );

cliTest(
  "counts authentic unsupported native Evidence identically through MCP and CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-managed-native-adapters-");
    const path = join(root, "fixture.dll");
    await writeFile(path, buildManagedPeFixture({ pinvoke: {} }));
    const inspected = await client.callTool({
      name: "inspect_managed_native_boundaries",
      arguments: { path },
    });
    expect(inspected.isError).not.toBe(true);
    const managed = parseEvidence(inspected.structuredContent);
    const native = signatureEvidence();
    const input = {
      managed_boundaries: managed,
      native_observations: [native],
    };

    const mcp = await client.callTool({
      name: "verify_managed_native_boundaries",
      arguments: input,
    });
    expect(mcp.isError, JSON.stringify(mcp.content)).not.toBe(true);
    const mcpResult = managedNativeVerificationResultSchema.parse(
      parseEvidence(mcp.structuredContent).normalized_result,
    );

    const request = join(root, "verify.json");
    await writeFile(request, JSON.stringify(input));
    const cliRun = await cli.run({
      arguments: ["verify-managed-native-boundaries", request, "--json"],
    });
    expect(cliRun.exitCode, cliRun.stderr).toBe(0);
    const cliResult = managedNativeVerificationResultSchema.parse(
      parseEvidence(cliRun.json).normalized_result,
    );

    expect(mcpResult).toEqual(cliResult);
    expect(mcpResult).toMatchObject({
      native_observations: {
        total: 1,
        accepted: 0,
        unsupported: 1,
        symbols: 0,
      },
      summary: { unresolved: 1 },
      pinvoke_imports: [
        expect.objectContaining({ basis: "unsupported-native-evidence" }),
      ],
      coverage: { status: "partial" },
      evidence_links: [managed.evidence_id, native.evidence_id],
    });
    expect(mcpResult.limitations).toContain(
      "Some native Evidence operations were unsupported by this workflow.",
    );

    const tampered = await client.callTool({
      name: "verify_managed_native_boundaries",
      arguments: {
        ...input,
        native_observations: [{ ...native, operation: "inspect_macho" }],
      },
    });
    expect(parseMcpToolError(tampered)).toMatchObject({
      error: { code: "evidence_integrity_mismatch" },
    });
  },
  60_000,
);
