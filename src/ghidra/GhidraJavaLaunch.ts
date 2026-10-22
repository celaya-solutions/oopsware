import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import { dirname, join } from "node:path";
import {
  execFileOutput,
  ExecFileOutputCancelledError,
  execFileOutputFailure,
  type ExecFileOutputFailure,
} from "../process/ExecFileOutput.js";

export const GHIDRA_LAUNCH_SUPPORT_CAPTURE_BYTES = 64 * 1024;
type LaunchSupportPhase = "-envvars" | "-vmargs";
type LaunchSupportOutcome = Omit<
  ExecFileOutputFailure,
  "killed" | "outputTruncated"
> & {
  readonly killed: boolean | null;
  readonly outputTruncated: boolean | null;
};

export class GhidraLaunchSupportError extends Error {
  readonly outcome: LaunchSupportOutcome | undefined;
  readonly cancellation: { readonly reason: unknown } | undefined;

  constructor(phase: LaunchSupportPhase, cause: unknown) {
    super(`Ghidra LaunchSupport ${phase} failed`, { cause });
    this.name = "GhidraLaunchSupportError";
    this.cancellation =
      cause instanceof ExecFileOutputCancelledError
        ? { reason: cause.cause }
        : undefined;
    const outcome = execFileOutputFailure(cause);
    this.outcome =
      outcome === undefined
        ? undefined
        : {
            ...outcome,
            killed: this.cancellation === undefined ? outcome.killed : null,
            outputTruncated:
              this.cancellation === undefined ? outcome.outputTruncated : null,
          };
  }
}

/** JVM option environments remove quotes, including quotes inside an option. */
const jvmEnvironmentArguments = (value: string): readonly string[] => {
  const arguments_: string[] = [];
  let argument = "";
  let quote: "'" | '"' | undefined;
  for (const character of value) {
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else argument += character;
    } else if (character === "'" || character === '"') quote = character;
    else if (/\s/u.test(character)) {
      if (argument !== "") arguments_.push(argument);
      argument = "";
    } else argument += character;
  }
  if (quote !== undefined)
    throw new Error(
      "Invalid quoted Ghidra LaunchSupport JVM environment option",
    );
  if (argument !== "") arguments_.push(argument);
  return arguments_;
};

const rejectJvmPlatformOverrides = (arguments_: readonly string[]): void => {
  if (
    arguments_.some((argument) => /^-Dos\.(?:arch|name)(?:=|$)/u.test(argument))
  )
    throw new Error(
      "Ghidra LaunchSupport may not override os.arch or os.name; the native decompiler was validated for the inspected JVM platform.",
    );
};

/** Launch coordinates obtained from Ghidra's own release configuration helper. */
export const ghidraJavaLaunch = async (options: {
  readonly platform: NodeJS.Platform;
  readonly analyzeHeadlessPath: string;
  readonly javaHome?: string;
  readonly javaVmName?: string;
  readonly homeRoot: string;
  readonly tempRoot: string;
  readonly arguments: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly onStderr: (mode: "-envvars" | "-vmargs", stderr: string) => void;
}): Promise<{
  readonly command: string;
  readonly arguments: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  /** REA-configured -Xmx value, not effective or observed JVM memory. */
  readonly configuredMaxHeap?: string;
}> => {
  const supportRoot = dirname(options.analyzeHeadlessPath);
  const installRoot = dirname(supportRoot);
  const selectedJavaHome = options.javaHome ?? options.environment.JAVA_HOME;
  const command =
    selectedJavaHome === undefined
      ? options.platform === "win32"
        ? "java.exe"
        : "java"
      : join(
          selectedJavaHome,
          "bin",
          options.platform === "win32" ? "java.exe" : "java",
        );
  const isolatedProperties = [
    `-Duser.home=${options.homeRoot}`,
    `-Djava.io.tmpdir=${options.tempRoot}`,
  ];
  const supportArguments = [
    ...isolatedProperties,
    // Only identified HotSpot VMs have these unified-logging semantics. OpenJ9
    // uses different -Xlog behavior; missing VM identity must stay unknown.
    ...(/^(?:OpenJDK|Java HotSpot\(TM\)) (?:64-Bit )?(?:Server|Client|Zero) VM$/u.test(
      options.javaVmName ?? "",
    )
      ? ["-Xlog:disable", "-Xlog:all=warning:stderr"]
      : []),
    "-cp",
    join(supportRoot, "LaunchSupport.jar"),
    "LaunchSupport",
    installRoot,
  ];
  const environment = {
    ...snapshotEnvironment(options.environment, options.platform),
  };
  const supportOutput = async (phase: LaunchSupportPhase) => {
    try {
      return await execFileOutput(command, [...supportArguments, phase], {
        env: environment,
        maxBuffer: GHIDRA_LAUNCH_SUPPORT_CAPTURE_BYTES,
        // Wait for the helper's exit on abort so no probe outlives its owner.
        stopSignal: "SIGTERM",
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (cause: unknown) {
      throw new GhidraLaunchSupportError(phase, cause);
    }
  };
  const configuredEnvironment = await supportOutput("-envvars");
  options.onStderr("-envvars", configuredEnvironment.stderr);
  for (const line of configuredEnvironment.stdout.split(/\r?\n/u)) {
    if (line === "") continue;
    const separator = line.indexOf("=");
    const sourceKey = line.slice(0, separator);
    const key =
      options.platform === "win32" ? sourceKey.toUpperCase() : sourceKey;
    if (separator < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key))
      throw new Error(
        `Invalid Ghidra LaunchSupport environment entry: ${line}`,
      );
    if ((environment[key] ?? "") === "")
      environment[key] = line.slice(separator + 1);
  }
  const configuredMaxHeap =
    environment.GHIDRA_HEADLESS_MAXMEM || environment.GHIDRA_MAXMEM || "2G";
  // The merged environment becomes the analysis JVM's environment, and the
  // JVM applies these options variables automatically. An injected
  // -Dos.arch/-Dos.name there selects an unvalidated native directory without
  // appearing in vmArguments, so reject the effective values as well.
  for (const key of [
    "JAVA_TOOL_OPTIONS",
    "_JAVA_OPTIONS",
    "JDK_JAVA_OPTIONS",
  ] as const) {
    rejectJvmPlatformOverrides(jvmEnvironmentArguments(environment[key] ?? ""));
  }
  const configuredArguments = await supportOutput("-vmargs");
  options.onStderr("-vmargs", configuredArguments.stderr);
  const vmArguments = configuredArguments.stdout
    .split(/\r?\n/u)
    .filter((line) => line !== "");
  if (
    vmArguments.some(
      (argument) => !argument.startsWith("-") || argument.includes("\0"),
    )
  )
    throw new Error("Invalid Ghidra LaunchSupport JVM argument");
  rejectJvmPlatformOverrides(vmArguments);
  return {
    command,
    environment,
    configuredMaxHeap,
    arguments: [
      ...vmArguments,
      ...(options.platform === "darwin" ? ["-Xdock:name=Ghidra-Headless"] : []),
      `-Xmx${configuredMaxHeap}`,
      "-XX:ParallelGCThreads=2",
      "-XX:CICompilerCount=2",
      "-Djava.awt.headless=true",
      ...isolatedProperties,
      "-showversion",
      "-cp",
      join(installRoot, "Ghidra", "Framework", "Utility", "lib", "Utility.jar"),
      "ghidra.Ghidra",
      "ghidra.app.util.headless.AnalyzeHeadless",
      ...options.arguments,
    ],
  };
};
