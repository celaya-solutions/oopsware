import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";
import { z } from "zod";

import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { applicationFeatureTraceResultSchema } from "../../../src/domain/javascript/javascriptFeatureTraceSchemas.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest.for(["CLI", "stdio MCP"] as const)(
  "counts exposed IPC listener callsites once and retains bridge paths through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-electron-ipc-listener-");
    await Promise.all([
      writeFile(
        join(root, "package.json"),
        JSON.stringify({
          name: "ipc-listener-fixture",
          version: "1.0.0",
          main: "main.js",
        }),
      ),
      writeFile(
        join(root, "main.js"),
        `const {app,BrowserWindow,ipcMain}=require("electron");
         ipcMain.handle("ping",()=>"pong");
         app.whenReady().then(()=>new BrowserWindow({webPreferences:{preload:"./preload.js"}}));`,
      ),
      writeFile(
        join(root, "preload.js"),
        `const {contextBridge,ipcRenderer}=require("electron");
         const subscribe = callback => ipcRenderer.on("pong",callback);
         contextBridge.exposeInMainWorld("api",{
           ping:()=>ipcRenderer.invoke("ping"),
           onPong:subscribe,
           onPongAgain:subscribe,
           onPongSeparate:callback=>ipcRenderer.on("pong",callback),
         });`,
      ),
      writeFile(join(root, "index.html"), "<!doctype html><html></html>\n"),
    ]);

    const mcp =
      surface === "stdio MCP" ? await connectLocalToolsMcp() : undefined;
    let applicationEvidence: unknown;
    if (surface === "CLI") {
      const response = await cli.run({
        arguments: ["analyze-javascript-application", root, "--json"],
      });
      expect(response.exitCode, response.stderr).toBe(0);
      applicationEvidence = response.json;
    } else {
      const response = await mcp!.call("analyze_javascript_application", {
        input_path: root,
      });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      applicationEvidence = response.structuredContent;
    }

    const { normalized_result: application } = z
      .object({ normalized_result: javascriptApplicationAnalysisResultSchema })
      .parse(applicationEvidence);
    expect(application.summary.ipc).toMatchObject({
      operations: 4,
      renderer_listeners: 2,
    });
    const pongChannels = application.graph.nodes.filter(
      (node) =>
        node.kind === "ipc-channel" &&
        node.observations.some(
          ({ properties }) => properties.channel === "pong",
        ),
    );
    expect(pongChannels).toHaveLength(1);
    expect(pongChannels[0]?.observations).toHaveLength(2);

    const bridgePaths = application.graph.nodes.filter(
      (node) =>
        node.kind === "javascript-expression" &&
        node.observations.some(
          ({ properties }) =>
            properties.entry === "api.onPong" ||
            properties.entry === "api.onPongAgain" ||
            properties.entry === "api.onPongSeparate",
        ),
    );
    expect(
      new Set(
        bridgePaths.flatMap((node) =>
          node.observations.flatMap(({ properties }) =>
            typeof properties.entry === "string" ? [properties.entry] : [],
          ),
        ),
      ),
    ).toEqual(new Set(["api.onPong", "api.onPongAgain", "api.onPongSeparate"]));

    const traceArguments = {
      application: applicationEvidence,
      seed: { kind: "channel", value: "pong", match: "exact" },
      direction: "incoming",
    };
    let traceEvidence: unknown;
    if (surface === "CLI") {
      const response = await cli.run({
        arguments: [
          "trace-application-feature",
          JSON.stringify(traceArguments),
          "--json",
        ],
      });
      expect(response.exitCode, response.stderr).toBe(0);
      traceEvidence = response.json;
    } else {
      const response = await mcp!.call(
        "trace_application_feature",
        traceArguments,
      );
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      traceEvidence = response.structuredContent;
    }
    const { normalized_result: trace } = z
      .object({ normalized_result: applicationFeatureTraceResultSchema })
      .parse(traceEvidence);
    expect(trace.summary.matched_seeds).toBe(1);
  },
);
