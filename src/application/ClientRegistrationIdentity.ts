import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { normalizeEntrypointPath } from "../process/CurrentEntrypointPath.js";
import { valid } from "semver";

import { PRODUCT_IDENTITY } from "../identity.js";

/** Package runners whose pinned launcher setup can register. */
export type PackageRunner = "npx" | "bunx";

/** Read one variable; Windows variable names are case-insensitive. */
const environmentValue = (
  environment: Readonly<NodeJS.ProcessEnv>,
  name: string,
  platform: NodeJS.Platform,
): string | undefined => {
  if (platform !== "win32") return environment[name];
  const target = name.toLowerCase();
  const key = Object.keys(environment).findLast(
    (candidate) => candidate.toLowerCase() === target,
  );
  return key === undefined ? undefined : environment[key];
};

/** Identify the package runner that launched this process, if any. */
export const invokingPackageRunner = (
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform = process.platform,
): PackageRunner | undefined => {
  if (environmentValue(environment, "npm_command", platform) !== "exec")
    return undefined;
  // `bunx` and `bun x` also report npm_command=exec, with a bun user agent.
  return environmentValue(
    environment,
    "npm_config_user_agent",
    platform,
  )?.startsWith("bun/") === true
    ? "bunx"
    : "npx";
};

/** Copy an environment without the variable that marks a package-runner launch. */
export const withoutPackageRunnerIdentity = (
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(environment).filter(([key]) =>
      platform === "win32"
        ? key.toLowerCase() !== "npm_command"
        : key !== "npm_command",
    ),
  );

/** Resolve a pinned package-runner launcher that stdio clients can spawn on the host. */
export const packageRunnerRegistrationCommand = (
  runner: PackageRunner,
  platform: NodeJS.Platform = process.platform,
): readonly string[] => {
  const command =
    runner === "npx"
      ? ["npx", "-y", PRODUCT_IDENTITY.registrationPackageSpecifier, "mcp"]
      : ["bunx", PRODUCT_IDENTITY.registrationPackageSpecifier, "mcp"];
  // Both runners may be .cmd shims on Windows, which clients cannot spawn directly.
  return platform === "win32" ? ["cmd.exe", "/d", "/c", ...command] : command;
};

/** Resolve a pinned npx launcher that stdio clients can spawn on the host. */
export const npxRegistrationCommand = (
  platform: NodeJS.Platform = process.platform,
): readonly string[] => packageRunnerRegistrationCommand("npx", platform);

const unwrapCmdCommand = (command: readonly string[]): readonly string[] => {
  const executable = command[0]?.toLowerCase();
  if (executable !== "cmd" && executable !== "cmd.exe") return command;
  if (command[1]?.toLowerCase() === "/c") return command.slice(2);
  if (command[1]?.toLowerCase() === "/d" && command[2]?.toLowerCase() === "/c")
    return command.slice(3);
  return [];
};

/** Preserve the package argument from a supported package-runner command. */
export const clientRegistrationPackageReference = (
  command: readonly string[],
): string | undefined => {
  const arguments_ = unwrapCmdCommand(command);
  if (
    arguments_.length === 4 &&
    arguments_[0] === "npx" &&
    arguments_[1] === "-y" &&
    arguments_[3] === "mcp"
  )
    return arguments_[2];
  if (
    arguments_.length === 3 &&
    arguments_[0] === "bunx" &&
    arguments_[2] === "mcp"
  )
    return arguments_[1];
  return undefined;
};

const isOwnedPackageReference = (packageReference: string): boolean => {
  if (
    packageReference === PRODUCT_IDENTITY.packageName ||
    packageReference === PRODUCT_IDENTITY.packageSpecifier ||
    packageReference === PRODUCT_IDENTITY.registrationPackageSpecifier
  )
    return true;
  const versionPrefix = `${PRODUCT_IDENTITY.packageName}@`;
  return (
    packageReference.startsWith(versionPrefix) &&
    valid(packageReference.slice(versionPrefix.length)) !== null
  );
};

/** Check that one parsed command points to Oopsware's MCP entry point. */
export type ClientRegistrationCommandIdentity = "owned" | "foreign" | "unknown";

/** Compare entrypoint paths without turning failed resolution into a foreign identity. */
const entrypointIdentity = (
  candidate: string,
  current: string,
): ClientRegistrationCommandIdentity => {
  if (!isAbsolute(candidate) || !isAbsolute(current)) return "unknown";
  if (candidate === current) return "owned";
  try {
    return realpathSync.native(candidate) === realpathSync.native(current)
      ? "owned"
      : "foreign";
  } catch {
    return "unknown";
  }
};

/** Oopsware ships two launchers (`oopsware.mjs` imports `rea.mjs`); either one is this install. */
const OWNED_LAUNCHER_SCRIPTS = ["oopsware.mjs", "rea.mjs"];

/** Compare a candidate with the current entrypoint and its sibling launcher. */
const launcherIdentity = (
  candidate: string,
  current: string,
  compare: (
    candidate: string,
    current: string,
  ) => ClientRegistrationCommandIdentity,
): ClientRegistrationCommandIdentity => {
  let resolvedCurrent = current;
  try {
    resolvedCurrent = realpathSync.native(current);
  } catch {
    // Keep the lexical path; comparison reports the uncertainty.
  }
  const currents = OWNED_LAUNCHER_SCRIPTS.includes(basename(resolvedCurrent))
    ? OWNED_LAUNCHER_SCRIPTS.map((name) => join(dirname(resolvedCurrent), name))
    : [current];
  const identities = currents.map((path) => compare(candidate, path));
  if (identities.includes("owned")) return "owned";
  return identities.includes("unknown") ? "unknown" : "foreign";
};

/** A direct launcher may be a native executable or a Node shebang script. */
const directEntrypointIdentity = (
  candidate: string,
  current: string,
): ClientRegistrationCommandIdentity => {
  const nativeIdentity = entrypointIdentity(candidate, current);
  const scriptPath = normalizeEntrypointPath(candidate);
  if (scriptPath === candidate) return nativeIdentity;
  // A shebang can pass the original spelling to Node, which selects its script
  // lexically. Without executing the launcher, divergent interpretations are unknown.
  return scriptPath !== undefined &&
    entrypointIdentity(scriptPath, current) === nativeIdentity
    ? nativeIdentity
    : "unknown";
};

/** Classify the command once; uncertainty never grants positive ownership. */
export const classifyClientRegistrationCommand = (
  command: readonly string[],
  currentCommandPath: string | undefined,
): ClientRegistrationCommandIdentity => {
  const packageReference = clientRegistrationPackageReference(command);
  if (packageReference !== undefined)
    return isOwnedPackageReference(packageReference) ? "owned" : "foreign";
  const currentPathAvailable =
    currentCommandPath !== undefined && currentCommandPath.length > 0;
  if (command.length === 3 && command[2] === "mcp") {
    const interpreter = command[0] ?? "";
    const entrypoint = command[1] ?? "";
    if (
      !isAbsolute(interpreter) ||
      !isAbsolute(entrypoint) ||
      !currentPathAvailable
    )
      return "unknown";
    const interpreterIdentity = entrypointIdentity(
      interpreter,
      process.execPath,
    );
    if (interpreterIdentity !== "owned") return interpreterIdentity;
    // Node selects its script from normalized argv; executable paths use native
    // traversal semantics, where symlink/.. can denote a different file.
    const selectedEntrypoint = normalizeEntrypointPath(entrypoint);
    return selectedEntrypoint === undefined
      ? "unknown"
      : launcherIdentity(
          selectedEntrypoint,
          currentCommandPath,
          entrypointIdentity,
        );
  }
  if (command.length === 2 && command[1] === "mcp") {
    const executable = command[0] ?? "";
    // `rea` stays a compatibility launcher name beside the Oopsware CLI binary.
    if (executable === PRODUCT_IDENTITY.cliBinary || executable === "rea")
      return "owned";
    if (isAbsolute(executable))
      return currentPathAvailable
        ? launcherIdentity(
            executable,
            currentCommandPath,
            directEntrypointIdentity,
          )
        : "unknown";
    if (/[./\\]/u.test(executable)) return "unknown";
  }
  return "foreign";
};
