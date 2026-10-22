import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { CdpCaptureCompleteness } from "./CdpCaptureCompleteness.js";
import { captureFrames } from "./CdpElectronInspection.js";
import type { CdpConnection } from "./CdpConnection.js";
import {
  ingestElectronScriptEvent,
  type ElectronScriptDraft,
} from "./CdpElectronScriptEvents.js";
import { captureElectronScripts } from "./CdpElectronScripts.js";
import { inspectElectronPageInputSchema } from "../domain/javascript/electronObservation.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Electron frame capture", () => {
  it.each([7, undefined])(
    "classifies a malformed child frame ID as unavailable: %s",
    async (childId) => {
      const root = await mkdtemp(join(tmpdir(), "rea-electron-frame-"));
      temporary.push(root);
      const main = join(root, "index.html");
      const child = join(root, "child.html");
      await Promise.all([writeFile(main, "main"), writeFile(child, "child")]);
      const mainUrl = pathToFileURL(main).href;
      const childUrl = pathToFileURL(child).href;
      const completeness = new CdpCaptureCompleteness();

      const frames = await captureFrames(
        {
          frameTree: {
            frame: { id: "frame-main", url: mainUrl },
            childFrames: [
              {
                frame: {
                  ...(childId === undefined ? {} : { id: childId }),
                  url: childUrl,
                },
              },
            ],
          },
        },
        completeness,
      );

      expect(frames.map((frame) => frame.frame_id)).toEqual(["frame-main"]);
      expect(completeness.snapshot()).toMatchObject({
        unavailable_sections: ["frames"],
        excluded: [
          { section: "frames", reason: "invalid_protocol_value", count: 1 },
        ],
      });
      expect(completeness.snapshot().policy_filtered_sections).not.toContain(
        "frames",
      );
      expect(completeness.snapshot().conditions).toContain("attach_limited");
    },
  );

  it("preserves script records across context teardown and ID reuse", async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-electron-script-frame-"));
    temporary.push(root);
    const scriptPath = join(root, "app.js");
    await writeFile(scriptPath, "export const app = true;");
    const scripts: ElectronScriptDraft[] = [];
    const executionContextFrames = new Map<string, string>();
    const completeness = new CdpCaptureCompleteness();
    const ingest = (method: string, params: unknown): void =>
      ingestElectronScriptEvent({
        event: { method, params },
        scripts,
        executionContextFrames,
        completeness,
      });
    const context = (frameId: string) => ({
      context: { id: 7, auxData: { frameId } },
    });
    const parsed = (
      scriptId: string,
      hash: string,
      url = pathToFileURL(scriptPath).href,
    ) => ({
      scriptId,
      url,
      hash,
      executionContextId: 7,
    });

    ingest("Runtime.executionContextCreated", context("frame-old"));
    ingest("Debugger.scriptParsed", parsed("script-old", "shared"));
    ingest("Runtime.executionContextDestroyed", { executionContextId: 7 });
    ingest("Runtime.executionContextCreated", context("frame-new"));
    ingest("Debugger.scriptParsed", parsed("script-new", "shared"));
    ingest("Runtime.executionContextsCleared", {});
    ingest("Debugger.scriptParsed", parsed("script-unknown", "unknown"));
    ingest("Runtime.executionContextCreated", context("frame-outside"));
    ingest("Debugger.scriptParsed", parsed("script-outside", "outside"));
    ingest(
      "Debugger.scriptParsed",
      parsed(
        "script-out-of-scope",
        "out-of-scope",
        "https://example.test/app.js",
      ),
    );

    const capture = await captureElectronScripts({
      connection: {
        send: async () => {
          throw new Error("Source capture must remain disabled in this test");
        },
      } as unknown as CdpConnection,
      sessionId: undefined,
      request: inspectElectronPageInputSchema.parse({
        cdp_endpoint: "http://127.0.0.1:9222",
        target_id: "page-1",
        observation_ms: 0,
        include_script_sources: false,
      }),
      scripts,
      frameIds: new Set(["frame-old", "frame-new"]),
      completeness,
    });

    expect(capture.total).toBe(4);
    const sharedScripts = capture.items.filter(
      (item) => item.cdp_hash === "shared",
    );
    expect(new Set(sharedScripts.map((item) => item.frame_id))).toEqual(
      new Set(["frame-old", "frame-new"]),
    );
    expect(new Set(sharedScripts.map((item) => item.script_key)).size).toBe(2);
    expect(
      Object.fromEntries(
        capture.items
          .filter((item) => item.cdp_hash !== "shared")
          .map((item) => [item.cdp_hash, item.frame_id]),
      ),
    ).toEqual({
      unknown: null,
      outside: null,
    });
    expect(completeness.snapshot().excluded).toContainEqual({
      section: "scripts",
      reason: "out_of_target_scope",
      count: 1,
    });
  });
});

it("admits a prefix and fitting suffix around an oversized Electron source", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-electron-source-budget-"));
  temporary.push(root);
  const paths = await Promise.all(
    ["prefix.js", "oversized.js", "suffix.js"].map(async (name) => {
      const path = join(root, name);
      await writeFile(path, "metadata");
      return path;
    }),
  );
  const sourceById = {
    prefix: "p".repeat(16 * 1024 * 1024),
    oversized: "o".repeat(17 * 1024 * 1024),
    suffix: "s".repeat(1024 * 1024),
  };
  const scripts: ElectronScriptDraft[] = paths.map((path, index) => {
    const scriptId = ["prefix", "oversized", "suffix"][index];
    if (scriptId === undefined) throw new Error("Missing script identity");
    return {
      scriptId,
      rawUrl: pathToFileURL(path).href,
      hash: scriptId,
      length: null,
      isModule: false,
      language: "JavaScript",
      frameId: null,
    };
  });
  const completeness = new CdpCaptureCompleteness();
  const capture = await captureElectronScripts({
    connection: {
      send: async (
        _method: string,
        params: Readonly<Record<string, unknown>>,
      ) => ({
        scriptSource:
          sourceById[
            (params as { scriptId: keyof typeof sourceById }).scriptId
          ],
      }),
    } as unknown as CdpConnection,
    sessionId: undefined,
    request: inspectElectronPageInputSchema.parse({
      cdp_endpoint: "http://127.0.0.1:9222",
      target_id: "page-1",
      observation_ms: 0,
      include_script_sources: true,
    }),
    scripts,
    frameIds: new Set(),
    completeness,
  });
  const byHash = new Map(
    capture.items.map((item) => [item.cdp_hash, item.source]),
  );

  expect(capture.total).toBe(3);
  expect([...byHash.keys()].sort()).toEqual(["oversized", "prefix", "suffix"]);
  expect(byHash.get("prefix")?.included).toBe(true);
  expect(byHash.get("oversized")).toEqual({
    included: false,
    reason:
      "script source was omitted because the aggregate 32 MiB source budget was exhausted",
  });
  expect(byHash.get("suffix")?.included).toBe(true);
  expect(completeness.snapshot().excluded).toContainEqual({
    section: "script_sources",
    reason: "resource_budget_exhausted",
    count: 1,
  });
});
