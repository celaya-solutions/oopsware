import { describe, expect, it } from "vitest";

import { parseMcpHttpEndpoint } from "../../../src/config/mcpHttpEndpoint.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { runMcpHttpEntrypoint } from "../../../src/main.js";
import {
  parseMcpHttpArguments,
  renderMcpHttpHelp,
} from "../../../src/main/mcpHttpArguments.js";

describe("rea mcp --http arguments", () => {
  it("accepts --http with optional host and port in either flag spelling", () => {
    expect(parseMcpHttpArguments(["--http"])).toEqual({ ok: true });
    expect(
      parseMcpHttpArguments(["--http", "--host", "::1", "--port=8080"]),
    ).toEqual({ ok: true, host: "::1", port: 8080 });
    expect(parseMcpHttpArguments(["--port", "0", "--http"])).toEqual({
      ok: true,
      port: 0,
    });
  });

  it("answers help only in flag position and names the rejected argument", () => {
    expect(parseMcpHttpArguments(["--http", "-h"])).toEqual({
      ok: false,
      help: true,
    });
    expect(parseMcpHttpArguments(["--http", "--host", "--help"])).toEqual({
      ok: false,
      help: false,
      message: "Missing value for --host",
    });
    expect(parseMcpHttpArguments(["--http", "add"])).toMatchObject({
      ok: false,
      message: "Unknown mcp --http argument: add",
    });
    expect(parseMcpHttpArguments(["--port", "1"])).toMatchObject({
      ok: false,
      message: "--host and --port require --http",
    });
    for (const port of ["70000", "08", "-1", "http"])
      expect(parseMcpHttpArguments(["--http", `--port=${port}`])).toMatchObject(
        { ok: false, message: expect.stringContaining("Invalid --port") },
      );
    expect(parseMcpHttpArguments(["--http", "--host", " "])).toMatchObject({
      ok: false,
      message: expect.stringContaining("--host must be"),
    });
  });

  it("renders help from the option schema without Incur global options", () => {
    const help = renderMcpHttpHelp();
    expect(help).toContain("rea mcp --http");
    expect(help).toContain("--host");
    expect(help).toContain("--port");
    expect(help).toContain("MCP_PORT");
    expect(help).not.toContain("--filter-output");
  });

  it("writes help as one newline-terminated stdout block and rejections to stderr", async () => {
    const io = () => {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const exitCodes: number[] = [];
      return {
        stdout,
        stderr,
        exitCodes,
        writeStdout: (text: string) => void stdout.push(text),
        writeStderr: (text: string) => void stderr.push(text),
        setExitCode: (code: number) => void exitCodes.push(code),
      };
    };
    const help = io();
    await runMcpHttpEntrypoint(["--http", "--help"], help);
    expect(help.stdout).toEqual([`${renderMcpHttpHelp()}\n`]);
    expect(help.stderr).toEqual([]);
    expect(help.exitCodes).toEqual([0]);
    const rejected = io();
    await runMcpHttpEntrypoint(["--http", "add"], rejected);
    expect(rejected.stdout).toEqual([]);
    expect(rejected.stderr).toEqual(["Unknown mcp --http argument: add\n"]);
    expect(rejected.exitCodes).toEqual([1]);
  });
});

describe("MCP_HOST and MCP_PORT", () => {
  it("defaults to loopback and an ephemeral port", () => {
    expect(parseMcpHttpEndpoint({})).toEqual({
      ok: true,
      value: { host: "127.0.0.1", port: 0 },
    });
  });

  it("reads the environment snapshot and lets explicit values win", () => {
    expect(
      parseMcpHttpEndpoint({ MCP_HOST: "192.0.2.10", MCP_PORT: "8080" }),
    ).toEqual({ ok: true, value: { host: "192.0.2.10", port: 8080 } });
    expect(
      parseMcpHttpEndpoint(
        { MCP_HOST: " ", MCP_PORT: "nope" },
        { host: "::1", port: 1 },
      ),
    ).toEqual({ ok: true, value: { host: "::1", port: 1 } });
  });

  it("rejects malformed values by setting name without echoing them", () => {
    const result = parseMcpHttpEndpoint({ MCP_HOST: " ", MCP_PORT: "65536" });
    if (result.ok) throw new Error("Expected a configuration error");
    expect(result.error.settings.map(({ setting }) => setting)).toEqual([
      "MCP_HOST",
      "MCP_PORT",
    ]);
    const projected = JSON.stringify(projectAnalysisError(result.error));
    expect(projected).toContain("MCP_PORT must be a decimal integer");
    expect(projected).not.toContain("65536");
  });
});
