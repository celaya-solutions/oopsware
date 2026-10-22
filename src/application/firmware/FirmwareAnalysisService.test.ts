import { expect, it } from "vitest";

import { FirmwareAnalysisService } from "./FirmwareAnalysisService.js";
import { createAnalysisExecution } from "../AnalysisProvider.js";
import { firmwareResultSchemas } from "../../domain/firmware/firmwareAnalysis.js";
import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import { err, ok } from "../../domain/result.js";

it.each(["inspect_firmware_regions", "extract_firmware"] as const)(
  "retains %s Evidence after late cancellation and preserves provider failure precedence",
  async (operation) => {
    const path = "/owned-fixture/input.bin";
    const input = {
      path,
      ...(operation === "extract_firmware"
        ? { output_directory: "/owned-fixture/output" }
        : {}),
    };
    const engine = {
      name: "fixture",
      version: "1",
      executable_path: "/fixture/engine",
      executable_sha256: "b".repeat(64),
      source_revision: null,
      worker_count: 1,
    };
    const normalized = firmwareResultSchemas[operation].parse(
      operation === "inspect_firmware_regions"
        ? { engine, input_size: 1, regions: [], coverage: "signature_scan" }
        : {
            engine,
            selection: { offset: 0, length: 1, sha256: "a".repeat(64) },
            output_directory: "/owned-fixture/output",
            coverage: "complete",
            files: [],
            unpublished_entries: [],
            chunks: [],
            derivations: [],
            depth_limited_paths: [],
            diagnostics: [],
            extraction_gaps: [],
            extraction_continuations: [],
            published_bytes: 0,
          },
    );
    const execution = createAnalysisExecution(
      normalized,
      { id: "fixture", name: "Fixture firmware", version: "1" },
      {
        subject: {
          path,
          format: "file",
          sha256: "a".repeat(64),
        },
        rawResult: { source: "controlled producer" },
      },
    );
    const control = await new FirmwareAnalysisService({
      execute: async () => ok(execution),
    }).execute(operation, input);
    if (!control.ok) throw control.error;
    const controller = new AbortController();
    const result = await new FirmwareAnalysisService({
      execute: async () => {
        controller.abort();
        return ok(execution);
      },
    }).execute(operation, input, { signal: controller.signal });
    expect(result).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisCancelledError",
        operation,
        partialObservation: control.value,
      },
    });
    const failedController = new AbortController();
    const failure = new AnalysisOutputError(
      operation,
      "controlled producer failure",
    );
    expect(
      await new FirmwareAnalysisService({
        execute: async () => {
          failedController.abort();
          return err(failure);
        },
      }).execute(operation, input, { signal: failedController.signal }),
    ).toEqual(err(failure));
  },
);
