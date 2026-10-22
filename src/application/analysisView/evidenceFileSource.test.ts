import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { analysisViewCaptureEvidence } from "../../../tests/fixtures/analysisView.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import {
  estimateJsonValueBytes,
  readEvidenceFileSource,
  requireAuthenticationHeadroom,
} from "./evidenceFileSource.js";

describe("evidence-file source", () => {
  it("estimates parsed JSON at no less than its UTF-16 text", () => {
    const text = "x".repeat(1000);
    expect(estimateJsonValueBytes(text)).toBeGreaterThanOrEqual(2000);
    expect(
      estimateJsonValueBytes({ outer: [text, { inner: text }] }),
    ).toBeGreaterThan(2 * estimateJsonValueBytes(text));
  });

  it("refuses authentication when live heap headroom cannot hold its copies", () => {
    const value = { normalized_result: "y".repeat(10_000) };
    expect(
      requireAuthenticationHeadroom(value, "/tmp/capture.json", 1024),
    ).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisResourceConstraintError",
        resource: "memory",
        reportedLimits: {
          input_path: "/tmp/capture.json",
          available_heap_bytes: 1024,
        },
      },
    });
    expect(
      requireAuthenticationHeadroom(value, "/tmp/capture.json", 1 << 30),
    ).toEqual({ ok: true, value: undefined });
  });

  it("refuses a cancelled request before reading and reads within the caller's resource scope", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(
      await readEvidenceFileSource("/nonexistent/capture.json", {
        signal: controller.signal,
      }),
    ).toMatchObject({ ok: false, error: { _tag: "AnalysisCancelledError" } });
    const path = join(
      await createTestTempDirectory("rea-evidence-file-source-"),
      "capture.json",
    );
    const parent = analysisViewCaptureEvidence();
    await writeFile(path, JSON.stringify(parent));
    const resources = new ArtifactResourceScope();
    const read = await readEvidenceFileSource(path, { resources });
    await resources.close();
    if (!read.ok) throw read.error;
    expect(read.value).toEqual(JSON.parse(JSON.stringify(parent)));
  });
});
