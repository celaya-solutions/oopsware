import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { toolContract } from "../../src/contracts/toolContracts.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import { readAnalysisSnapshot } from "../../src/application/binary/AnalysisSnapshotFiles.js";
import { APPLE_DISPATCH_METADATA_ANALYSIS_PROFILE } from "../../src/native/NativeMacOSProviderMetadata.js";
import {
  CPU,
  machoImage,
} from "../../src/artifacts/apple/MachoImage.fixture.js";
import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest.skipIf(process.platform !== "darwin")(
  "retains and reopens profileless native dispatch workflow snapshots through CLI and stdio MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-native-dispatch-snapshot-");
    const target = join(root, "minimal.macho");
    const cliSnapshot = join(root, "cli-snapshot.json");
    const mcpSnapshot = join(root, "mcp-snapshot.json");
    const bytes = machoImage({ cpu: CPU.arm64, commands: [] });
    await writeFile(target, bytes);
    const isolatedProviderEnvironment = {
      PATH: process.env.PATH ?? "",
      REA_ANALYSIS_PROVIDER: "auto",
      HOPPER_LAUNCHER_PATH: "/rea-unconfigured-deep-provider/hopper",
      GHIDRA_INSTALL_DIR: "/rea-unconfigured-deep-provider/ghidra",
      JAVA_HOME: "/rea-unconfigured-deep-provider/java",
      REA_IDA_MCP_CONFIG: "/rea-unconfigured-deep-provider/ida-mcp.json",
      REA_KUNA_COMMAND: "/rea-unconfigured-deep-provider/kuna",
      REA_KUNA_CACHE_DIR: "/rea-unconfigured-deep-provider/kuna-cache",
    };

    const cliArguments = [
      "inspect-native-dispatch-metadata",
      target,
      "--snapshot",
      cliSnapshot,
      "--json",
    ];
    const firstCli = await cli.run({
      arguments: cliArguments,
      environment: isolatedProviderEnvironment,
    });
    expect(firstCli.exitCode, firstCli.stderr).toBe(0);
    const cliEvidence = toolContract(
      "inspect_native_dispatch_metadata",
    ).outputSchema.parse(firstCli.json);
    const cliSaved = await readAnalysisSnapshot(cliSnapshot);
    if (!cliSaved.ok) throw cliSaved.error;
    expect(cliSaved.value.binding.analysis_profile).toEqual(
      APPLE_DISPATCH_METADATA_ANALYSIS_PROFILE,
    );
    expect(cliSaved.value.entries).toEqual([]);
    expect(cliSaved.value.workflow_entries).toHaveLength(1);
    const replayCli = await cli.run({
      arguments: cliArguments,
      environment: isolatedProviderEnvironment,
    });
    expect(replayCli.exitCode, replayCli.stderr).toBe(0);
    expect(
      toolContract("inspect_native_dispatch_metadata").outputSchema.parse(
        replayCli.json,
      ),
    ).toEqual(cliEvidence);
    const changedLimitCli = await cli.run({
      arguments: [...cliArguments, "--max-records", "1"],
      environment: isolatedProviderEnvironment,
    });
    expect(changedLimitCli.exitCode, changedLimitCli.stderr).toBe(0);
    const changedLimitEvidence = parseEvidence(changedLimitCli.json);
    expect(changedLimitEvidence.parameters.max_records).toBe(1);
    expect(changedLimitEvidence.evidence_id).not.toBe(cliEvidence.evidence_id);
    const changedLimitSnapshot = await readAnalysisSnapshot(cliSnapshot);
    if (!changedLimitSnapshot.ok) throw changedLimitSnapshot.error;
    expect(changedLimitSnapshot.value.workflow_entries).toHaveLength(2);

    const { client, call } = await connectLocalToolsMcp(
      isolatedProviderEnvironment,
    );
    const opened = await call("open_binary", { path: target });
    expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
    const firstMcp = await call("inspect_native_dispatch_metadata", {
      max_records: 100,
    });
    expect(firstMcp.isError, JSON.stringify(firstMcp)).not.toBe(true);
    const mcpEvidence = parseEvidence(firstMcp.structuredContent);
    const closed = await call("close_binary", {
      snapshot_path: mcpSnapshot,
      overwrite: true,
    });
    expect(closed.isError, JSON.stringify(closed)).not.toBe(true);
    const mcpSaved = await readAnalysisSnapshot(mcpSnapshot);
    if (!mcpSaved.ok) throw mcpSaved.error;
    expect(mcpSaved.value.binding.analysis_profile).toEqual(
      APPLE_DISPATCH_METADATA_ANALYSIS_PROFILE,
    );
    expect(mcpSaved.value.entries).toEqual([]);
    expect(mcpSaved.value.workflow_entries).toHaveLength(1);

    const reopened = await call("open_binary", {
      path: target,
      snapshot_path: mcpSnapshot,
    });
    expect(reopened.isError, JSON.stringify(reopened)).not.toBe(true);
    const reobserved = await call("inspect_native_dispatch_metadata", {
      max_records: 100,
    });
    expect(reobserved.isError, JSON.stringify(reobserved)).not.toBe(true);
    expect(parseEvidence(reobserved.structuredContent)).toEqual(mcpEvidence);
    expect(await readFile(target)).toEqual(Buffer.from(bytes));
    await client.ping();
  },
  30000,
);
