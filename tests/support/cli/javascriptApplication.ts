import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { expect } from "vitest";
import { z } from "zod";

import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import type { TestCli } from "./cliFixture.js";

const execute = promisify(execFile);

export const runNodeJsonControl = async (
  root: string,
  filename: string,
): Promise<unknown> => {
  const { stdout } = await execute(process.execPath, [filename], {
    cwd: root,
    timeout: 5_000,
  });
  return JSON.parse(stdout) as unknown;
};

/** Analyze a directory; a supplied MCP caller reuses its test-owned connection. */
export const analyzeJavaScriptDirectory = async (
  surface: "CLI" | "stdio MCP",
  cli: TestCli,
  root: string,
  {
    sourcePaths = [],
    mcpCall,
  }: {
    readonly sourcePaths?: readonly string[];
    readonly mcpCall?:
      | Awaited<ReturnType<typeof connectLocalToolsMcp>>["call"]
      | undefined;
  } = {},
) => {
  let document: unknown;
  if (surface === "CLI") {
    const response = await cli.run({
      arguments: [
        "analyze-javascript-application",
        root,
        ...sourcePaths.flatMap((path) => ["--source-path", path]),
        "--format",
        "json",
      ],
      environment: { REA_LOG_LEVEL: "silent" },
    });
    expect(response.exitCode, response.stderr).toBe(0);
    document = response.json;
  } else {
    const call = mcpCall ?? (await connectLocalToolsMcp()).call;
    const response = await call("analyze_javascript_application", {
      input_path: root,
      format: "directory",
      ...(sourcePaths.length === 0 ? {} : { source_paths: sourcePaths }),
    });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    document = response.structuredContent;
  }
  return z
    .object({ normalized_result: javascriptApplicationAnalysisResultSchema })
    .parse(document).normalized_result;
};
