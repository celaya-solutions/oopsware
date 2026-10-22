import { expect, it, onTestFinished } from "vitest";
import { rm } from "node:fs/promises";
import {
  createIdaTarget,
  RecordingIdaMcp,
} from "../../tests/fixtures/idaMcp.js";
import {
  AnalysisTimeoutError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { AnalysisCleanupLease } from "../artifacts/AnalysisCleanupLease.js";
import { IdaSessionClient } from "./IdaSessionClient.js";

it.each(["timeout", "resource"] as const)(
  "attributes a cached startup %s to each caller without losing facts or live cleanup",
  async (kind) => {
    const { root, target } = await createIdaTarget();
    const sourceOptions = {
      diagnostics: { stage_fact: "original" },
      capturedOutput: {
        stdout: "original output",
        stderr: "original warning",
        truncated: true,
      },
      cleanup: { reason: "release denied", resources: ["owned transport"] },
      userMessage: "original explanation",
      remediationAction: "original recovery",
    };
    const primary =
      kind === "timeout"
        ? new AnalysisTimeoutError("ida_mcp_connect", 123, sourceOptions)
        : new AnalysisResourceConstraintError(
            "ida_mcp_catalog",
            "transport",
            "original byte limit",
            { max_response_bytes: 456 },
            { ...sourceOptions, retryable: false },
          );
    let permitRelease = false;
    const lease = new AnalysisCleanupLease(async () => {
      if (!permitRelease) throw new Error("release denied");
    }, ["owned transport"]);
    lease.bindCleanupError(primary);
    const producer = new RecordingIdaMcp(target, "headless");
    producer.connect = async () => {
      producer.connects++;
      throw primary;
    };
    const client = new IdaSessionClient(
      {
        url: "http://127.0.0.1:12345/mcp",
        headers: {},
        mode: "headless",
        timeoutMs: 1000,
        workspaceRoot: root,
      },
      target,
      producer,
    );
    onTestFinished(async () => {
      permitRelease = true;
      await lease.release();
      await client.close();
      await rm(root, { recursive: true, force: true });
    });
    const first = await client.execute("procedure_pseudo_code", {
      procedure: "main",
    });
    const second = await client.execute("list_procedures", {});
    if (first.ok || second.ok) throw new Error("Expected startup failure");
    expect(producer.connects).toBe(1);
    expect(producer.calls).toEqual([]);
    expect(primary.operation).toBe(
      kind === "timeout" ? "ida_mcp_connect" : "ida_mcp_catalog",
    );
    for (const [error, operation] of [
      [first.error, "procedure_pseudo_code"],
      [second.error, "list_procedures"],
    ] as const) {
      expect(error.cause).toBe(primary);
      expect(projectAnalysisError(error)).toMatchObject({
        code: "cleanup_incomplete",
        details: {
          operation,
          resources: ["owned transport"],
          diagnostics: {
            stage_fact: "original",
            startup_operation: primary.operation,
          },
        },
      });
    }
    await expect(lease.release()).rejects.toThrow("release denied");
    expect(projectAnalysisError(first.error).code).toBe("cleanup_incomplete");
    permitRelease = true;
    await lease.release();
    for (const [error, operation] of [
      [first.error, "procedure_pseudo_code"],
      [second.error, "list_procedures"],
    ] as const) {
      expect(projectAnalysisError(error)).toMatchObject({
        code: kind === "timeout" ? "provider_timeout" : "resource_constraint",
        message: projectAnalysisError(primary).message,
        remediation: { action: "original recovery" },
        details: { operation, captured_output: sourceOptions.capturedOutput },
      });
      expect(projectAnalysisError(error).details).not.toHaveProperty(
        "resources",
      );
    }
    expect(projectAnalysisError(first.error)).toMatchObject(
      kind === "timeout"
        ? { retryable: true, details: { timeout_ms: 123 } }
        : {
            retryable: false,
            details: {
              resource: "transport",
              reported_limits: { max_response_bytes: 456 },
            },
          },
    );
  },
);

it.each(["pending", "released"] as const)(
  "keeps cancellation linked to the exact startup cleanup owner when %s",
  async (state) => {
    const { root, target } = await createIdaTarget();
    const controller = new AbortController();
    const primary = new AnalysisTimeoutError("ida_mcp_connect", 123, {
      cleanup: { reason: "release denied", resources: ["owned transport"] },
      capturedOutput: {
        stdout: "",
        stderr: "original warning",
        truncated: false,
      },
    });
    let permitRelease = state === "released";
    const lease = new AnalysisCleanupLease(async () => {
      if (!permitRelease) throw new Error("release denied");
    }, ["owned transport"]);
    lease.bindCleanupError(primary);
    const producer = new RecordingIdaMcp(target, "headless");
    producer.connect = async () => {
      if (state === "released") await lease.release();
      controller.abort("caller reason");
      throw primary;
    };
    const client = new IdaSessionClient(
      {
        url: "http://127.0.0.1:12345/mcp",
        headers: {},
        mode: "headless",
        timeoutMs: 1000,
        workspaceRoot: root,
      },
      target,
      producer,
    );
    onTestFinished(async () => {
      permitRelease = true;
      await lease.release();
      await client.close();
      await rm(root, { recursive: true, force: true });
    });
    const result = await client.execute(
      "procedure_pseudo_code",
      { procedure: "main" },
      { signal: controller.signal },
    );
    if (result.ok) throw new Error("Expected cancellation");
    if (state === "pending") {
      expect(projectAnalysisError(result.error).code).toBe(
        "cleanup_incomplete",
      );
      await expect(lease.release()).rejects.toThrow("release denied");
      expect(projectAnalysisError(result.error).code).toBe(
        "cleanup_incomplete",
      );
      permitRelease = true;
      await lease.release();
    }
    expect(projectAnalysisError(result.error)).toMatchObject({
      code: "cancelled",
      details: {
        operation: "procedure_pseudo_code",
        captured_output: { stderr: "original warning" },
      },
    });
    expect(projectAnalysisError(result.error).details).not.toHaveProperty(
      "resources",
    );
  },
);
