import { writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SigrokRecordingProvider } from "../../../src/signals/SigrokRecordingProvider.js";
import { TsharkCaptureProvider } from "../../../src/captures/TsharkCaptureProvider.js";
import { SignalRecordingService } from "../../../src/application/signals/SignalRecordingService.js";
import { PacketCaptureService } from "../../../src/application/captures/PacketCaptureService.js";
import { ArtifactReaderFailure } from "../../../src/artifacts/ArtifactReader.js";
import { withArtifactRegularFile } from "../../../src/artifacts/ArtifactFileOperation.js";
import { readStableArtifact } from "../../../src/artifacts/readStableArtifact.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { PrivateRuntimeRoot } from "../../../src/process/PrivateRuntimeRoot.js";
import { spawnOwnedProviderProcess } from "../../../src/process/ProviderProcess.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

// Real descriptors/owned Node commands; simulated Linux limits, no native tools.
it.each(
  (["signal", "capture"] as const).flatMap((kind) =>
    [
      {
        stage: "configuration",
        failure: "denied",
        tag: "AnalysisCapabilityUnavailableError",
      },
      {
        stage: "artifact",
        failure: "denied",
        tag: "AnalysisAccessDeniedError",
      },
      { stage: "artifact", failure: "format", tag: "AnalysisInputError" },
      {
        stage: "artifact",
        failure: "integrity",
        tag: "AnalysisArtifactChangedError",
      },
      {
        stage: "artifact",
        failure: "limit",
        tag: "AnalysisResourceConstraintError",
      },
      {
        stage: "integrity",
        failure: "integrity",
        tag: "AnalysisArtifactChangedError",
      },
    ].map((control) => ({ kind, ...control })),
  ),
)(
  "retains the physical file outcome and exact descriptor through retry: %j",
  async ({ kind, stage, failure, tag }) => {
    const root = await createTestTempDirectory("rea-file-primary-");
    const inputPath = join(root, "input");
    const command = join(root, "producer.mjs");
    await writeFile(inputPath, "authored recording");
    await writeFile(
      command,
      kind === "signal"
        ? "if(process.argv.includes('--version')) console.log('sigrok-cli 0.7.2\\nlibsigrokdecode 0.5.3'); else console.log('annotation');"
        : "if(process.argv.includes('--version')) console.log('TShark (Wireshark) 4.6.9 (fixture)'); else console.log('[]');",
      { mode: 0o700 },
    );
    const physical =
      failure === "denied"
        ? Object.assign(new Error("controlled read denial"), { code: "EACCES" })
        : new ArtifactReaderFailure(
            failure === "format"
              ? "format"
              : failure === "limit"
                ? "limit"
                : "integrity",
            "controlled physical file failure",
          );
    const selectedPath = stage === "artifact" ? inputPath : command;
    let allowed = false;
    let commandReads = 0;
    let launches = 0;
    let handle: FileHandle | undefined;
    const caller = new AbortController();
    const Provider =
      kind === "signal" ? SigrokRecordingProvider : TsharkCaptureProvider;
    const provider = new Provider(
      {
        ...process.env,
        REA_SIGROK_COMMAND: command,
        REA_SIGROK_PRLIMIT_COMMAND: command,
        REA_TSHARK_COMMAND: command,
        REA_TSHARK_PRLIMIT_COMMAND: command,
      },
      async (options) => {
        launches++;
        return spawnOwnedProviderProcess({
          ...options,
          command: process.execPath,
          arguments: [command, ...options.arguments],
          expectedCommand: process.execPath,
        });
      },
      () => PrivateRuntimeRoot.create({ parent: root }),
      "linux",
      async (...args) => {
        if (args[0] === command) commandReads++;
        const selected =
          args[0] === selectedPath &&
          (stage !== "integrity" || commandReads === 3);
        if (!selected) return readStableArtifact(...args);
        const scope = args[4];
        if (scope === undefined)
          throw new Error("Expected retained artifact scope");
        return withArtifactRegularFile(
          args[0],
          scope,
          args[2],
          async (file) => {
            handle = file;
            const close = file.close.bind(file);
            file.close = async () => {
              // A later abort must not replace the already observed physical failure.
              caller.abort({
                request: "late cancellation during failed close",
              });
              if (!allowed)
                throw new Error("controlled descriptor close failure");
              await close();
            };
            throw physical;
          },
        );
      },
      async (limits) => ({ ...limits, file_bytes: 1048576 }),
    );
    try {
      const result =
        provider instanceof SigrokRecordingProvider
          ? await new SignalRecordingService(provider).decode(
              { path: inputPath, decoders: "uart" },
              { signal: caller.signal },
            )
          : await new PacketCaptureService(provider).inspect(
              { path: inputPath, fields: ["frame.number"] },
              { signal: caller.signal },
            );
      if (result.ok)
        throw new Error("Expected physical failure and retained descriptor");
      let primary = result.error.cleanupPrimary;
      while (primary?.cleanupPrimary !== undefined)
        primary = primary.cleanupPrimary;
      expect(primary).toMatchObject({ _tag: tag, cause: physical });
      expect(result.error.cleanupIncomplete).toBe(true);
      expect(handle?.fd).toBeGreaterThanOrEqual(0);
      const failed: unknown = await provider
        .close()
        .catch((cause: unknown) => cause);
      expect(failed).toMatchObject({ cleanupIncomplete: true });
      const launchCount = launches;
      allowed = true;
      await provider.close();
      expect(handle?.fd).toBe(-1);
      expect(result.error.cleanupIncomplete).toBe(false);
      let restored = result.error.cleanupPrimary;
      while (restored?.cleanupPrimary !== undefined)
        restored = restored.cleanupPrimary;
      expect(restored).toBe(primary);
      expect(primary?.cause).toBe(physical);
      expect(projectAnalysisError(result.error)).toMatchObject(
        projectAnalysisError(primary!),
      );
      expect(projectAnalysisError(result.error).details).toHaveProperty(
        "cleanup_history",
      );
      expect(failed).toMatchObject({ cleanupIncomplete: false });
      expect(launches).toBe(launchCount);
    } finally {
      allowed = true;
      await provider.close();
      await handle?.close();
    }
  },
);
