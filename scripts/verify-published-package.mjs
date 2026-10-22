import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import { lt, prerelease, rcompare, valid } from "semver";
import { readNpmRelease, stableUpdateVersion } from "./ci/npm-release.mjs";

import {
  installCanaryPackage,
  verifyInstalledCanaryPackage,
} from "./lib/release-package-canary.mjs";
import { completeVerifierRun, createVerifierRun } from "./lib/verifier-run.mjs";

const verifierRun = createVerifierRun();
const execFileAsync = promisify(execFile);
const version = process.argv[2];
if (
  typeof version !== "string" ||
  valid(version) !== version ||
  process.argv.length !== 3
)
  throw new Error("Usage: node scripts/verify-published-package.mjs <version>");

const canaryRoot = await mkdtemp(join(tmpdir(), "rea-published-canary-"));
const serverEnvironment = {
  ...process.env,
  npm_config_cache: join(canaryRoot, "npm-cache"),
};
delete serverEnvironment.HOPPER_TARGET_PATH;
let surface;
let update;
try {
  const publishedRoot = await installCanaryPackage(
    `@celaya-solutions/oopsware@${version}`,
    canaryRoot,
    serverEnvironment,
  );
  surface = await verifyInstalledCanaryPackage(
    publishedRoot,
    version,
    canaryRoot,
    serverEnvironment,
  );
  update = await verifyPublishedUpdate({
    version,
    canaryRoot,
    updaterRoot: publishedRoot,
  });
} finally {
  await rm(canaryRoot, { recursive: true, force: true });
}
process.stdout.write(
  `${JSON.stringify({ verifier_run: await completeVerifierRun(verifierRun), package: "@celaya-solutions/oopsware", version, ...surface, update })}\n`,
);

async function verifyPublishedUpdate({
  version: targetVersion,
  canaryRoot,
  updaterRoot,
}) {
  const updateVersion = stableUpdateVersion(
    targetVersion,
    await readNpmRelease(targetVersion),
  );
  const prefix = join(canaryRoot, "update-prefix");
  const home = join(canaryRoot, "update-home");
  const environment = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    CLAUDE_CONFIG_DIR: home,
    CODEX_HOME: join(home, ".codex"),
    COPILOT_HOME: join(home, ".copilot"),
    GROK_HOME: join(home, ".grok"),
    SAND_DATA_ROOT: join(home, ".grokbot"),
    OMP_PROFILE: undefined,
    PI_CODING_AGENT_DIR: undefined,
    PI_CONFIG_DIR: undefined,
    PI_PROFILE: undefined,
    XDG_CONFIG_HOME: join(home, ".config"),
    OPENCODE_CONFIG: join(home, ".config", "opencode", "opencode.json"),
    npm_config_cache: join(canaryRoot, "npm-cache"),
    npm_config_prefix: prefix,
    PATH: `${join(prefix, "bin")}${delimiter}${process.env.PATH ?? ""}`,
  };
  const previousVersion = await findPreviousPublishedVersion(
    updateVersion,
    canaryRoot,
    environment,
  );

  await execFileAsync(
    "npm",
    [
      "install",
      "--global",
      "--ignore-scripts",
      "--prefix",
      prefix,
      `@celaya-solutions/oopsware@${previousVersion}`,
    ],
    { cwd: canaryRoot, env: environment, maxBuffer: 16 * 1024 * 1024 },
  );

  const npmRoot = (
    await execFileAsync("npm", ["root", "--global"], {
      cwd: canaryRoot,
      env: environment,
    })
  ).stdout.trim();
  // Older releases may predate the update command. Exercise the new published
  // updater's production workflow against that real previous installation.
  const harness = join(canaryRoot, "update.mjs");
  await writeFile(
    harness,
    `
import { runUpdate } from ${JSON.stringify(pathToFileURL(join(updaterRoot, "dist/application/Update.js")).href)};
import { systemUpdateHost } from ${JSON.stringify(pathToFileURL(join(updaterRoot, "dist/application/UpdateRuntime.js")).href)};
const result = await runUpdate(${JSON.stringify(previousVersion)}, systemUpdateHost(${JSON.stringify(join(npmRoot, "@celaya-solutions/oopsware"))}, ${JSON.stringify(home)}), "structured");
process.stdout.write(JSON.stringify(result));
if (result.status === "failed") process.exitCode = 1;
`,
  );
  const { stdout } = await execFileAsync(process.execPath, [harness], {
    cwd: canaryRoot,
    env: environment,
    maxBuffer: 16 * 1024 * 1024,
  });
  const result = JSON.parse(stdout);
  if (
    result.status !== "updated" ||
    result.previousVersion !== previousVersion ||
    result.latestVersion !== updateVersion ||
    result.installedVersion !== updateVersion ||
    result.command.at(-1) !== `@celaya-solutions/oopsware@${updateVersion}`
  )
    throw new Error(
      `Published Oopsware updater did not update ${previousVersion} to stable ${updateVersion}: ${stdout}`,
    );

  const installed = JSON.parse(
    await readFile(
      join(npmRoot, "@celaya-solutions/oopsware", "package.json"),
      "utf8",
    ),
  );
  if (installed.version !== updateVersion)
    throw new Error(
      `Oopsware update installed ${installed.version}, expected stable ${updateVersion}`,
    );

  const help = (
    await execFileAsync(join(prefix, "bin", "oopsware"), ["--help"], {
      cwd: canaryRoot,
      env: environment,
    })
  ).stdout;
  if (!/^\s{2}update\s/mu.test(help) || /^\s{2}upgrade\s/mu.test(help))
    throw new Error(
      "the updated executable did not expose only the update command",
    );

  return {
    status: result.status,
    previousVersion,
    latestVersion: result.latestVersion,
    installedVersion: installed.version,
  };
}

async function findPreviousPublishedVersion(targetVersion, cwd, environment) {
  const { stdout } = await execFileAsync(
    "npm",
    ["view", "@celaya-solutions/oopsware", "versions", "--json"],
    { cwd, env: environment, maxBuffer: 16 * 1024 * 1024 },
  );
  const versions = JSON.parse(stdout);
  const previous = versions
    .filter(
      (candidate) =>
        typeof candidate === "string" &&
        valid(candidate) === candidate &&
        prerelease(candidate) === null &&
        lt(candidate, targetVersion),
    )
    .sort(rcompare)[0];
  if (previous === undefined)
    throw new Error(
      `No published @celaya-solutions/oopsware version precedes ${targetVersion}`,
    );
  return previous;
}
