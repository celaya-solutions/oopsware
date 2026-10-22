import { expect, it } from "vitest";
import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import { err, ok } from "../../domain/result.js";
import { sbomReportSchema } from "../../domain/supplyChain/sbom.js";
import { SUPPLY_CHAIN_PROVIDER } from "../InvestigationProviders.js";
import type { SupplyChainPort } from "./SupplyChainPort.js";
import { SupplyChainService } from "./SupplyChainService.js";

const report = sbomReportSchema.parse({
  artifact: {
    path: "/artifacts/package.json",
    sha256: "a".repeat(64),
    bytes: 2,
  },
  sbom: {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    components: [],
    dependencies: [],
  },
  licenses: [],
  coverage: {
    state: "unknown",
    files_examined: 1,
    files_read: 1,
    bytes_read: 2,
    decoded_bytes: 0,
    ecosystems: [],
    dependency_relationships: "unknown",
    license_detection: "partial",
  },
  limitations: ["No package coordinates were present."],
});
const unused = async () =>
  err(new AnalysisOutputError("test", "Unexpected provider call"));
const port = (
  generateSbom: SupplyChainPort["generateSbom"],
): SupplyChainPort => ({
  identity: SUPPLY_CHAIN_PROVIDER,
  generateSbom,
  checkVulnerabilities: unused,
  verifySignature: unused,
});

it("rejects relative paths, NUL paths and unknown options before invoking a provider", async () => {
  let calls = 0;
  const service = new SupplyChainService(
    port(async () => {
      calls++;
      return ok(report);
    }),
  );
  for (const input of [
    { path: "relative" },
    { path: "/bad\u0000path" },
    { path: report.artifact.path, extra: true },
  ])
    expect((await service.generateSbom(input)).ok).toBe(false);
  expect(
    (
      await service.checkVulnerabilities({
        path: "/sbom.json",
        database: "relative",
      })
    ).ok,
  ).toBe(false);
  expect(
    (
      await service.verifySignature({
        path: "/a.whl",
        kind: "wheel",
        public_key: "relative",
      })
    ).ok,
  ).toBe(false);
  expect(calls).toBe(0);
});

it("refuses a provider that substitutes the selected artifact", async () => {
  const service = new SupplyChainService(
    port(async () =>
      ok({ ...report, artifact: { ...report.artifact, path: "/other" } }),
    ),
  );
  const result = await service.generateSbom({ path: report.artifact.path });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisOutputError);
});

it("retains completed evidence and the caller's reason on late cancellation", async () => {
  const controller = new AbortController();
  const reason = new Error("Caller stopped after readback");
  const service = new SupplyChainService(
    port(async () => {
      controller.abort(reason);
      return ok(report);
    }),
  );
  const result = await service.generateSbom(
    { path: report.artifact.path },
    { signal: controller.signal },
  );
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.cause).toBe(reason);
    expect(result.error.partialObservation).toMatchObject({
      normalized_result: report,
      confidence: "derived",
    });
  }
});

it("does not invent a subject digest for a directory inventory", async () => {
  const directory = {
    ...report,
    artifact: { path: "/artifacts/app", sha256: null, bytes: null },
  };
  const service = new SupplyChainService(port(async () => ok(directory)));
  const result = await service.generateSbom({ path: directory.artifact.path });
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value.subject).toBeNull();
    expect(result.value.locations).toContainEqual({
      kind: "artifact-path",
      path: directory.artifact.path,
    });
  }
});
