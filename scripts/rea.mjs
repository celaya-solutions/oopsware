#!/usr/bin/env node

import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Route production MCP before importing Incur. Incur owns registration helpers
// such as `mcp add`, while the MCP runtime serves the tool catalog over stdio
// or, with `--http`, over streamable HTTP.
const args = process.argv.slice(2);
const { default: packageJson } = await import("../package.json", {
  with: { type: "json" },
});
process.env.REA_PACKAGE_VERSION = packageJson.version;
const isMcpEntry = args[0] === "--mcp" || args[0] === "mcp";
const isMcpMode = isMcpEntry && args.length === 1;
const isMcpDoctorMode = args[0] === "mcp" && args[1] === "doctor";
// Only flags may follow the entry: `mcp add --http` stays Incur's `mcp add`,
// while `mcp -h --http` reaches the HTTP entry's own help.
const isMcpHttpMode =
  isMcpEntry &&
  (args[1]?.startsWith("-") ?? false) &&
  args.slice(1).includes("--http");
/** Exit status of a writer terminated by SIGPIPE (128 + 13). */
const SIGPIPE_EXIT_STATUS = 141;
// Set once the reader of CLI output has closed the pipe.
let stdoutClosed = false;
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Windows home lookup throws for an empty USERPROFILE. Dependencies resolve
// home during import, before REA's own resolver can apply its account fallback.
if (process.platform === "win32" && process.env.USERPROFILE === "") {
  delete process.env.USERPROFILE;
}

// Playwright's registry assumes one of its three desktop host platforms when
// it chooses the browser cache directory. Termux reports `android`, although
// its Node runtime and filesystem are POSIX-compatible. Keep the cache path
// explicit so REA can start on Termux. Browser launch still requires a
// caller-supplied Android-compatible Chromium executable.
if (
  process.platform === "android" &&
  process.env.PLAYWRIGHT_BROWSERS_PATH === undefined
) {
  const cacheRoot =
    process.env.XDG_CACHE_HOME ?? join(process.env.HOME ?? ".", ".cache");
  process.env.PLAYWRIGHT_BROWSERS_PATH = join(cacheRoot, "ms-playwright");
}

const runtimeFiles =
  isMcpMode || isMcpHttpMode
    ? ["dist/mcp/main.js"]
    : isMcpDoctorMode
      ? ["dist/mcp/main.js", "dist/cli-runtime/mcpDoctor.js"]
      : [
          "dist/cli-runtime/cli.js",
          "dist/cli-runtime/cliOutput.js",
          "dist/cli-runtime/cliResultOutput.js",
        ];

if (!(await compiledRuntimeExists(runtimeFiles))) {
  process.stderr.write(
    `Oopsware's compiled runtime is missing. Run \`npm ci && npm run build:cached\` in ${packageRoot} to install dependencies and build Oopsware, then restart it. If this is an installed package, reinstall @celaya-solutions/oopsware.\n`,
  );
  process.exitCode = 1;
} else if (isMcpMode) {
  const { runEntrypoint } = await import("../dist/mcp/main.js");
  await runEntrypoint();
} else if (isMcpHttpMode) {
  const { runMcpHttpEntrypoint } = await import("../dist/mcp/main.js");
  await runMcpHttpEntrypoint(args.slice(1));
} else if (isMcpDoctorMode) {
  guardClosedStdout();
  const { runProductionMcpDoctorCli } =
    await import("../dist/cli-runtime/mcpDoctor.js");
  const result = await runProductionMcpDoctorCli(args.slice(2), {
    dispatcherPath: fileURLToPath(import.meta.url),
    packageRoot,
  });
  writeStdout(result.output);
  process.exitCode = result.exitCode;
} else {
  const { cliConfigurationError, createCli } =
    await import("../dist/cli-runtime/cli.js");
  const { createCliResultOutput } =
    await import("../dist/cli-runtime/cliResultOutput.js");
  const {
    normalizeCliArguments,
    renderCliOutputArgumentError,
    renderEmptyFilteredCliOutput,
    validateCliOutputArguments,
  } = await import("../dist/cli-runtime/cliOutput.js");
  guardClosedStdout();
  const cliArgs = normalizeCliArguments(args);
  const outputArguments = validateCliOutputArguments(cliArgs);
  const configurationError = cliConfigurationError(process.env);
  if (configurationError !== undefined) {
    process.stderr.write(`${configurationError}\n`);
    process.exitCode = 1;
  } else if (!outputArguments.ok) {
    writeStdout(renderCliOutputArgumentError(outputArguments));
    process.exitCode = 1;
  } else {
    let wroteOutput = false;
    const resultOutput = createCliResultOutput(cliArgs, process.stdout);
    try {
      await createCli(process.env, resultOutput).serve(cliArgs, {
        stdout: (output) => {
          if (resultOutput?.handled) {
            if (resultOutput.failed && !stdoutClosed)
              process.stderr.write(output);
            return;
          }
          if (output.length > 0) wroteOutput = true;
          writeStdout(output);
        },
        // A command failure caused by the closed pipe keeps the pipe's status.
        exit: (code) => process.exit(stdoutClosed ? SIGPIPE_EXIT_STATUS : code),
      });
    } catch (cause) {
      if (wroteOutput) throw cause;
      const recovered = await resultOutput
        ?.recoverFormattingFailure(cause)
        .catch((writeFailure) => {
          // Recovery writes outside Incur's command boundary. A reader that
          // declined this document keeps the same quiet SIGPIPE outcome.
          if (!stdoutClosed) throw writeFailure;
          return true;
        });
      if (!recovered) throw cause;
      process.exitCode = stdoutClosed ? SIGPIPE_EXIT_STATUS : 1;
    }
    if (!wroteOutput && !resultOutput?.handled)
      writeStdout(renderEmptyFilteredCliOutput(cliArgs) ?? "");
  }
}

/**
 * A reader that closes the pipe early, as `rea ... | head` does, has declined
 * the rest of the output. Stop writing without reporting a failure, and exit
 * with the status a SIGPIPE-terminated writer reports. MCP stdio keeps its own
 * client lifecycle.
 */
function guardClosedStdout() {
  process.stdout.on("error", (cause) => {
    if (cause?.code === "EPIPE") {
      stdoutClosed = true;
      process.exitCode = SIGPIPE_EXIT_STATUS;
      return;
    }
    // Other failures stay unhandled unless a pending JSON write reports them.
    if (process.stdout.listenerCount("error") === 1) throw cause;
  });
}

function writeStdout(output) {
  if (!stdoutClosed) process.stdout.write(output);
}

async function compiledRuntimeExists(paths) {
  for (const path of paths) {
    try {
      await access(resolve(packageRoot, path));
    } catch (cause) {
      if (isMissing(cause)) return false;
      throw cause;
    }
  }
  return true;
}

function isMissing(cause) {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "ENOENT"
  );
}
