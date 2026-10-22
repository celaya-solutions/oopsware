import { accessSync, constants, statSync } from "node:fs";

import type { ConfigurationError } from "../domain/configurationErrors.js";
import { ok, type Result } from "../domain/result.js";
import { parseEnvironment } from "./environment.js";
import { homeDirectoryFromEnvironment } from "./homeDirectory.js";
import type { AppConfig } from "./types.js";
import {
  linuxHopperLauncherCandidates,
  REA_MANAGED_LINUX_HOPPER_LAUNCHER,
} from "../application/LinuxHopper.js";
import {
  MAC_HOPPER_SYSTEM_LAUNCHER,
  macHopperLauncherCandidates,
} from "../application/MacHopperPaths.js";
const executableAvailable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

export const defaultHopperLauncherPath = (
  platform: NodeJS.Platform,
  homeDirectory: string,
  executable: (path: string) => boolean = executableAvailable,
): string => {
  if (platform === "darwin") {
    for (const candidate of macHopperLauncherCandidates(homeDirectory))
      if (executable(candidate)) return candidate;
    return MAC_HOPPER_SYSTEM_LAUNCHER;
  }
  if (platform !== "linux") return MAC_HOPPER_SYSTEM_LAUNCHER;
  return (
    linuxHopperLauncherCandidates(homeDirectory).find(executable) ??
    REA_MANAGED_LINUX_HOPPER_LAUNCHER
  );
};

/** Parse provider configuration and runtime prerequisites at the composition root. */
export const parseConfig = (
  environment: Readonly<Record<string, string | undefined>>,
): Result<AppConfig, ConfigurationError> => {
  // JEB validates its own timeout during optional provider composition. It is
  // not an AppConfig setting and must not prevent unrelated CLI/MCP startup.
  // Registration validation still checks the complete environment directly.
  const { REA_JEB_MCP_TIMEOUT_MS: _jebTimeout, ...appEnvironment } =
    environment;
  const parsed = parseEnvironment(appEnvironment);
  if (!parsed.ok) return parsed;
  const env = parsed.value;
  return ok({
    ...(env.REA_MCP_MAX_RESPONSE_BYTES === undefined
      ? {}
      : { mcpMaxResponseBytes: env.REA_MCP_MAX_RESPONSE_BYTES }),
    ...(env.REA_MCP_INPUT_SCHEMA_PROFILE === undefined
      ? {}
      : { mcpInputSchemaProfile: env.REA_MCP_INPUT_SCHEMA_PROFILE }),
    analysisProvider: env.REA_ANALYSIS_PROVIDER,
    ...(env.REA_IDA_MCP_CONFIG === undefined
      ? {}
      : { idaMcpConfigPath: env.REA_IDA_MCP_CONFIG }),
    ghidraInstallDir: env.GHIDRA_INSTALL_DIR,
    ghidraJavaHome: env.JAVA_HOME,
    ghidraStartupTimeoutMs: env.REA_GHIDRA_STARTUP_TIMEOUT_MS,
    ...(env.REA_GHIDRA_LANGUAGE_ID === undefined
      ? {}
      : {
          ghidraLanguageOverride: {
            languageId: env.REA_GHIDRA_LANGUAGE_ID,
            ...(env.REA_GHIDRA_COMPILER_SPEC_ID === undefined
              ? {}
              : { compilerSpecId: env.REA_GHIDRA_COMPILER_SPEC_ID }),
          },
        }),
    ...(env.REA_GHIDRA_SEED_FILE === undefined
      ? {}
      : { ghidraSeedFile: env.REA_GHIDRA_SEED_FILE }),
    ...(env.REA_GHIDRA_DISABLED_ANALYZERS === undefined
      ? {}
      : { ghidraDisabledAnalyzers: env.REA_GHIDRA_DISABLED_ANALYZERS }),
    ...(env.REA_GHIDRA_NATIVEAOT_JAR === undefined
      ? {}
      : { ghidraNativeAotJar: env.REA_GHIDRA_NATIVEAOT_JAR }),
    ilspyCmdPath: env.REA_ILSPY_CMD_PATH,
    hopperLauncherPath:
      env.HOPPER_LAUNCHER_PATH ??
      defaultHopperLauncherPath(
        process.platform,
        homeDirectoryFromEnvironment(environment, process.platform),
      ),
    hopperStartupTimeoutMs: env.REA_HOPPER_STARTUP_TIMEOUT_MS,
    hopperTargetPath: env.HOPPER_TARGET_PATH,
    hopperTargetKind: env.HOPPER_TARGET_KIND,
    hopperLoaderArgs: env.loaderArgs,
    logLevel: env.REA_LOG_LEVEL,
    referenceSourcePolicy: {
      secretPatterns: env.referenceSecretPatterns,
    },
  });
};
