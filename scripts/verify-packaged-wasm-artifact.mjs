#!/usr/bin/env node
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { PrivateRuntimeRoot } from "../dist/process/PrivateRuntimeRoot.js";
import { closeVerifierResources } from "./lib/verifier-cleanup.mjs";
import { exec, execNpm } from "./lib/verify-package-core.mjs";
import { WABT_WORKFLOW_TIMEOUT_MS } from "./lib/wabt-verifier-timeouts.mjs";
import { verifyPackagePack } from "./verify-package-pack.mjs";

const root = await PrivateRuntimeRoot.create({
  prefix: "rea-wabt-package-verifier-",
});
let primaryError;
try {
  const { tarball } = await verifyPackagePack({
    root: process.cwd(),
    workspace: root.path,
  });
  const prefix = join(root.path, "prefix");
  const home = join(root.path, "home");
  await mkdir(home);
  const environment = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
  };
  await execNpm(
    [
      "install",
      "--global",
      "--ignore-scripts",
      "--omit=dev",
      "--install-strategy=nested",
      "--prefix",
      prefix,
      tarball,
    ],
    { env: environment, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
  );
  const entrypoint = join(
    prefix,
    ...(process.platform === "win32"
      ? ["node_modules"]
      : ["lib", "node_modules"]),
    "rea-agents",
    "scripts",
    "rea.mjs",
  );
  const verified = await exec(
    process.execPath,
    ["scripts/verify-wasm-artifact.mjs", entrypoint, "--require-tools"],
    {
      env: environment,
      timeout: WABT_WORKFLOW_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  process.stdout.write(verified.stdout);
} catch (cause) {
  primaryError = cause;
  throw cause;
} finally {
  await closeVerifierResources([() => root.close()], primaryError);
}
