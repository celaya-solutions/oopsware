import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { CATALOG_IDENTITY } from "../../dist/catalogIdentity.js";
import { TOOL_CONTRACTS } from "../../dist/contracts/toolContracts.js";
import {
  requireMcpLifecycleResult,
  sortVerifierNames,
} from "./mcp-verifier-results.mjs";

const execute = promisify(execFile);

/** Install the selected archive or registry specifier before any protocol deadline. */
export async function installCanaryPackage(specifier, workspace, environment) {
  const prefix = join(workspace, "installed");
  await execute(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-save",
      "--no-package-lock",
      "--no-audit",
      "--no-fund",
      "--prefix",
      prefix,
      specifier,
    ],
    { cwd: workspace, env: environment, maxBuffer: 16 * 1024 * 1024 },
  );
  return join(prefix, "node_modules", "@celaya-solutions", "oopsware");
}

/** Exercise the same installed CLI/MCP contract before and after publication. */
export async function verifyInstalledCanaryPackage(
  packageRoot,
  version,
  workspace,
  environment,
) {
  const installed = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  );
  if (
    installed.name !== "@celaya-solutions/oopsware" ||
    installed.version !== version
  )
    throw new Error(
      `Installed package identity is ${installed.name}@${installed.version}, expected @celaya-solutions/oopsware@${version}`,
    );
  const launcher = join(packageRoot, "scripts", "rea.mjs");
  for (const option of ["--help", "--llms"])
    await execute(process.execPath, [launcher, option], {
      cwd: workspace,
      env: environment,
      maxBuffer: 16 * 1024 * 1024,
    });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [launcher, "mcp"],
    cwd: workspace,
    env: environment,
    stderr: "pipe",
  });
  const client = new Client({ name: "release-package-canary", version: "1" });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    if (stderr.length < 16_384)
      stderr += chunk.toString("utf8").slice(0, 16_384 - stderr.length);
  });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const toolNames = tools.tools.map(({ name }) => name);
    const canonicalToolNames = new Set(TOOL_CONTRACTS.map(({ name }) => name));
    const publishedToolNames = new Set(toolNames);
    const unknown = toolNames.filter((name) => !canonicalToolNames.has(name));
    const missing = [...canonicalToolNames].filter(
      (name) => !publishedToolNames.has(name),
    );
    if (
      toolNames.length === 0 ||
      publishedToolNames.size !== toolNames.length ||
      unknown.length ||
      missing.length
    )
      throw new Error(
        `Installed MCP exposed an invalid canonical tool catalog (${toolNames.length} tools, unknown: ${unknown.join(", ") || "none"}, missing: ${missing.join(", ") || "none"})`,
      );
    const status = requireMcpLifecycleResult(
      await client.callTool({ name: "binary_session", arguments: {} }),
      "binary_session",
    );
    const availability = sortVerifierNames(
      status.tool_availability.map(({ name }) => name),
    );
    if (
      JSON.stringify(availability) !==
      JSON.stringify(sortVerifierNames(canonicalToolNames))
    )
      throw new Error(
        "Installed binary_session omitted canonical tool availability",
      );
    return {
      mcpTools: toolNames.length,
      canonicalMcpTools: CATALOG_IDENTITY.counts.mcp_tools,
    };
  } catch (cause) {
    throw new Error(`Installed package MCP verification failed: ${stderr}`, {
      cause,
    });
  } finally {
    try {
      await client.close();
    } finally {
      await transport.close();
    }
  }
}
