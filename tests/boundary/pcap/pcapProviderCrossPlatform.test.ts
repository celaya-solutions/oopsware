/**
 * Cross-platform pcap provider tests.
 *
 * POSIX hosts run the #!/bin/sh fixtures;
 * Windows runs the .cmd stubs from tests/fixtures/pcap/. Both validate
 * the same provider contract surface: tool probing, capture inspection,
 * refusal paths, and cancellation before spawn.
 */
import { createHash } from "node:crypto";
import { open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import { PcapProvider } from "../../../src/pcap/PcapProvider.js";
import { PcapSnapshot } from "../../../src/pcap/PcapSnapshot.js";
import * as regularFile from "../../../src/filesystem/RegularFile.js";
import { OwnedFileHandle } from "../../../src/filesystem/OwnedFileHandle.js";
import type { PcapCommandLauncher } from "../../../src/pcap/PcapCommand.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import type { PcapRequest } from "../../../src/domain/pcap/pcapAnalysis.js";
import { cleanupOwnedProcessGroup } from "../../../src/process/ProcessOwnership.js";
import { spawnOwnedProviderProcess } from "../../../src/process/ProviderProcess.js";

const isWindows = process.platform === "win32";
const hasNativeBound = process.platform === "linux" || isWindows;
const stubDir = join(import.meta.dirname, "../../fixtures/pcap");
const tsharkStub = isWindows
  ? join(stubDir, "tshark-stub.cmd")
  : join(stubDir, "tshark-stub.sh");
const capinfosStub = isWindows
  ? join(stubDir, "capinfos-stub.cmd")
  : join(stubDir, "capinfos-stub.sh");

const providerOver = (): PcapProvider => {
  const provider = new PcapProvider({
    environment: {
      REA_TSHARK_COMMAND: tsharkStub,
      REA_CAPINFOS_COMMAND: capinfosStub,
    },
  });
  onTestFinished(() => provider.close());
  return provider;
};

const evidenceResult = async (
  provider: PcapProvider,
  request: PcapRequest,
): Promise<Record<string, unknown>> => {
  const result = await provider.execute(request);
  if (!result.ok) throw new Error(result.error.message);
  return result.value.result as Record<string, unknown>;
};

it("inspects both tools through cross-platform stubs", async () => {
  const result = await evidenceResult(providerOver(), {
    operation: "inspect_pcap_client",
    input: {},
  });
  expect(result.client).toMatchObject({
    tshark_source: "environment",
    tshark_version: expect.stringContaining("4.6.6") as unknown,
    capinfos_source: "environment",
    capinfos_version: expect.stringContaining("4.6.6") as unknown,
  });
});

it("resolves a retained tool-probe error after its process owner closes", async () => {
  let mayClean = false;
  let launches = 0;
  const launcher: PcapCommandLauncher = async (spawn) => {
    const launched = await spawnOwnedProviderProcess(spawn);
    launches++;
    if (launches !== 1) return launched;
    const cleanup =
      launched.cleanup ?? (() => cleanupOwnedProcessGroup(launched.ownership));
    return {
      ...launched,
      cleanup: async () => {
        const result = await cleanup();
        if (!mayClean) throw new Error("injected tool-probe cleanup failure");
        return result;
      },
    };
  };
  const provider = new PcapProvider({
    environment: {
      REA_TSHARK_COMMAND: tsharkStub,
      REA_CAPINFOS_COMMAND: capinfosStub,
    },
    launcher,
  });
  onTestFinished(async () => {
    mayClean = true;
    await provider.close();
  });

  const result = await provider.execute({
    operation: "inspect_pcap_client",
    input: {},
  });
  if (result.ok) throw new Error("Expected retained tool-probe cleanup");
  expect(result.error.cleanupIncomplete).toBe(true);
  expect(result.error.diagnostics).toMatchObject({
    reason: "injected tool-probe cleanup failure",
  });

  mayClean = true;
  await provider.close();
  expect(result.error.cleanupIncomplete).toBe(false);
  expect(launches).toBe(1);
});

it.runIf(hasNativeBound)(
  "inspects a capture with metadata, endpoints, DNS, and protocol facts",
  async () => {
    const root = await createTestTempDirectory("rea-pcap-x-");
    const capturePath = join(root, "capture.pcap");
    const captureBytes = "cross-platform-pcap-fixture";
    await writeFile(capturePath, captureBytes);

    const result = await evidenceResult(providerOver(), {
      operation: "inspect_pcap_capture",
      input: { path: capturePath },
    });

    expect(result.target).toMatchObject({
      path: capturePath,
      bytes: captureBytes.length,
      sha256: createHash("sha256").update(captureBytes).digest("hex"),
    });
    expect(result.file_type).toContain("pcap");
    expect(result.packet_count).toBe(3);
    expect(result.capture_start).toBe("2026-10-11T14:13:40.608505Z");
    expect(result.capture_end).toBe("2026-10-11T14:13:40.981978Z");
    expect((result.endpoints as unknown[]).length).toBeGreaterThan(0);
    expect((result.protocol_distribution as unknown[]).length).toBeGreaterThan(
      0,
    );
    expect(result.coverage).toBe("complete");
  },
);

// Hosts without a native bound refuse before touching the path; that order
// is pinned by the unsupported-boundary test below.
it.runIf(hasNativeBound)(
  "rejects a path that is not a readable file",
  async () => {
    const result = await providerOver().execute({
      operation: "inspect_pcap_capture",
      input: { path: "/nonexistent/definitely-missing.pcap" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(projectAnalysisError(result.error)).toMatchObject({
      code: "invalid_request",
    });
  },
);

it("reports a missing binary as a capability gap", async () => {
  const provider = new PcapProvider({
    environment: { REA_TSHARK_COMMAND: "/nonexistent/tshark" },
  });
  expect(await provider.inspectAvailability()).toMatchObject({
    status: "unavailable",
    code: "executable_missing",
  });
});

it("cancels before spawning anything", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await providerOver().execute(
    { operation: "inspect_pcap_capture", input: { path: "/any/capture.pcap" } },
    { signal: controller.signal },
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(projectAnalysisError(result.error)).toMatchObject({
    code: "cancelled",
  });
});

it.runIf(!hasNativeBound)(
  "reports an unsupported native memory boundary before reading the capture",
  async () => {
    const provider = providerOver();
    expect(await provider.inspectAvailability()).toMatchObject({
      status: "unavailable",
      code: "unsupported_host",
    });
    const result = await provider.execute({
      operation: "inspect_pcap_capture",
      input: { path: "/not-opened/capture.pcap" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const projected = projectAnalysisError(result.error);
    expect(projected.code).toBe("capability_unavailable");
    // The refusal concerns this host, so it must not suggest another target.
    expect(projected.message).toContain(
      "Linux with util-linux prlimit, or Windows with owned Job Objects",
    );
    expect(projected.remediation.action).toBe(projected.message);
  },
);

it("retains a verification admission owner before translating cancellation", async () => {
  const root = await createTestTempDirectory("rea-pcap-verify-admission-");
  const path = join(root, "held.bin");
  await writeFile(path, "held capture bytes");
  const handle = await open(path, "r");
  const owner = new OwnedFileHandle(handle);
  const controller = new AbortController();
  const reason = null;
  const snapshot = await PcapSnapshot.create();
  const admission = vi
    .spyOn(regularFile, "openRegularFile")
    .mockImplementationOnce(async () => {
      controller.abort(reason);
      throw new regularFile.RegularFileAdmissionFailure(
        snapshot.path,
        new regularFile.RegularFileOperationCancelled(reason),
        new Error("admission close unavailable"),
        owner,
      );
    });
  try {
    await expect(
      snapshot.verify({ bytes: 0, sha256: "unused" }, path, controller.signal),
    ).rejects.toMatchObject({ _tag: "AnalysisCancelledError", cause: reason });
    expect(handle.fd).toBeGreaterThanOrEqual(0);
    await snapshot.close();
    expect(handle.fd).toBe(-1);
  } finally {
    admission.mockRestore();
    await snapshot.close();
    await owner.close();
  }
});
