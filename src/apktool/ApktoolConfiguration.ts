import { capturedApktoolFailureOutput } from "./ApktoolCommandOutput.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import { ok, err, type Result } from "../domain/result.js";
import { ApktoolCommandCleanup } from "./ApktoolCommandCleanup.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { DarwinProcessOwnershipInspectionError } from "../process/DarwinProcessRunTokenReader.js";
import {
  AnalysisCancelledError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import { isAbsolute, win32 } from "node:path";
import { stat } from "node:fs/promises";
import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import { ABORTED, waitForAbortable } from "../process/AbortablePromise.js";
import { ProviderStartupDeadline } from "../process/ProviderDeadline.js";

import { randomUUID } from "node:crypto";
import {
  OwnedCommandFailure,
  runOwnedCommand,
  prepareOwnedCommand,
} from "../process/OwnedCommand.js";
import type { ProviderAvailability } from "../application/AnalysisProvider.js";
import type { ProviderRejectionCode } from "../contracts/providerSelection.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { parse } from "semver";
import {
  isWindowsBatchFile,
  windowsBatchCommand,
  WindowsBatchCommandError,
} from "../process/WindowsBatchCommand.js";

/** Environment key selecting the caller's apktool launcher. */
export const APKTOOL_COMMAND_ENV = "REA_APKTOOL_COMMAND";

const VERSION_TIMEOUT_MS = 20_000;
const VERSION_MAX_OUTPUT_BYTES = 64 * 1024;

/** How the apktool launcher was selected for this provider instance. */
export interface ApktoolCommandSelection {
  readonly command: string;
  readonly commandSource: "environment" | "path";
}

/**
 * Preserve an explicit launcher, or resolve the default Windows command before
 * choosing native versus batch process creation. POSIX keeps execFile's PATH
 * lookup. The resolved selection is reused for the version and decode runs.
 */
export const resolveApktoolCommand = async (
  environment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
  signal?: AbortSignal,
): Promise<ApktoolCommandSelection> => {
  if (signal?.aborted === true)
    throw new AnalysisCancelledError("inspect_apktool_client", {
      cause: signal.reason,
    });
  const selectedEnvironment = snapshotEnvironment(environment, platform);
  const configured = selectedEnvironment[APKTOOL_COMMAND_ENV];
  if (configured !== undefined && configured.trim() !== "") {
    if (
      !(platform === "win32"
        ? win32.isAbsolute(configured)
        : isAbsolute(configured))
    )
      throw new ApktoolConfigurationFailure(
        "not_absolute",
        `${APKTOOL_COMMAND_ENV} must be an absolute path to the apktool launcher`,
        { configured_command: configured },
      );
    return { command: configured, commandSource: "environment" };
  }
  if (platform !== "win32")
    return { command: "apktool", commandSource: "path" };
  const extensions = (selectedEnvironment.PATHEXT ?? ".EXE;.COM;.BAT;.CMD")
    .split(";")
    .filter((extension) => extension !== "");
  for (const extension of extensions)
    if (!extension.startsWith(".") || /[\\/:\0]/u.test(extension))
      throw new ApktoolConfigurationFailure(
        "command_unresolved",
        "Windows PATHEXT must contain filename extensions, not paths",
        {
          selected_command: "apktool",
          command_source: "path",
          invalid_extension: extension,
        },
      );
  const directories = (selectedEnvironment.PATH ?? "")
    .split(";")
    .filter((directory) => directory !== "");
  if (selectedEnvironment.NODEFAULTCURRENTDIRECTORYINEXEPATH === undefined)
    directories.unshift(process.cwd());
  // A single deadline owns the whole PATH search, including filesystem waits.
  const deadline = new ProviderStartupDeadline(VERSION_TIMEOUT_MS, signal);
  const lookupInterruption = () =>
    deadline.interruption === "cancelled"
      ? new AnalysisCancelledError("inspect_apktool_client", {
          cause: signal?.reason,
        })
      : new AnalysisTimeoutError("inspect_apktool_client", VERSION_TIMEOUT_MS, {
          diagnostics: { phase: "windows_path_lookup" },
        });
  try {
    for (const entry of directories) {
      const directory =
        entry.startsWith('"') && entry.endsWith('"')
          ? entry.slice(1, -1)
          : entry;
      for (const extension of extensions) {
        if (deadline.interruption !== undefined) throw lookupInterruption();
        const candidate = win32.resolve(directory, `apktool${extension}`);
        try {
          const metadata = await waitForAbortable(
            stat(candidate),
            deadline.signal,
          );
          if (metadata === ABORTED || deadline.interruption !== undefined)
            throw lookupInterruption();
          if (metadata.isFile())
            return { command: candidate, commandSource: "path" };
        } catch (cause: unknown) {
          if (deadline.interruption !== undefined) throw lookupInterruption();
          const code =
            typeof cause === "object" && cause !== null
              ? Reflect.get(cause, "code")
              : undefined;
          if (code === "ENOENT" || code === "ENOTDIR") continue;
          throw new ApktoolConfigurationFailure(
            "command_unresolved",
            `The PATH-selected apktool launcher could not be inspected: ${candidate}`,
            {
              selected_command: "apktool",
              command_source: "path",
              candidate_path: candidate,
              ...(typeof code === "string" ? { filesystem_error: code } : {}),
            },
            { cause },
          );
        }
      }
    }
  } finally {
    deadline.dispose();
  }

  throw new ApktoolConfigurationFailure(
    "command_missing",
    "The apktool launcher was not found on the selected Windows PATH/PATHEXT",
    {
      selected_command: "apktool",
      command_source: "path",
      remediation: `Set ${APKTOOL_COMMAND_ENV} to an absolute apktool launcher, or add its directory and extension to PATH and PATHEXT`,
    },
  );
};

export type ApktoolConfigurationFailureCode =
  | "not_absolute"
  | "command_missing"
  | "command_unresolved"
  | "launcher_unsupported"
  | "version_unresolved"
  | "unsupported_version";

export class ApktoolConfigurationFailure extends Error {
  constructor(
    readonly code: ApktoolConfigurationFailureCode,
    message: string,
    readonly diagnostics: Readonly<Record<string, JsonValue>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface ApktoolClientIdentity {
  readonly version: string;
  readonly supportsDocumentedVersion: boolean;
  readonly limitations: readonly string[];
}

/** Process creation for one apktool run on the selected host. */
export interface ApktoolInvocation {
  readonly command: string;
  readonly arguments: readonly string[];
  readonly windowsVerbatimArguments: boolean;
}

/**
 * Run the selected launcher directly, or through cmd.exe when Windows can
 * only execute it there (the Chocolatey `apktool.bat` and `java -jar`
 * wrapper scripts). Throws WindowsBatchCommandError when a token cannot be
 * passed to cmd.exe safely.
 */
export const apktoolInvocation = (
  selection: ApktoolCommandSelection,
  arguments_: readonly string[],
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform = process.platform,
): ApktoolInvocation =>
  platform === "win32" && isWindowsBatchFile(selection.command)
    ? {
        ...windowsBatchCommand({
          environment,
          batchPath: selection.command,
          arguments: arguments_,
        }),
        windowsVerbatimArguments: true,
      }
    : {
        command: selection.command,
        arguments: arguments_,
        windowsVerbatimArguments: false,
      };

/** Read the version from Apktool's single-line `--version` response. */
export const parseApktoolVersionOutput = (
  stdout: string,
  platform: NodeJS.Platform = process.platform,
):
  | ApktoolClientIdentity
  | { readonly version: null; readonly reportedVersion: string | null } => {
  const line = stdout
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .find((entry) => entry !== "");
  const parsed = line === undefined ? null : parse(line);
  if (line === undefined || parsed === null)
    return { version: null, reportedVersion: line ?? null };
  // Debian's exact -dirty marker denotes a downstream release build. Preserve
  // the reported spelling; other prereleases remain earlier than their release.
  const downstreamRelease =
    parsed.prerelease.length === 1 &&
    parsed.prerelease[0] === "dirty" &&
    parsed.build.length === 0;
  const atLeast = (release: string): boolean =>
    (downstreamRelease
      ? parsed.compareMain(release)
      : parsed.compare(release)) >= 0;
  const limitations: string[] = [];
  const discloseAdvisory = (
    fix: string,
    advisory: string,
    slug: string,
  ): string =>
    `Reported apktool version ${JSON.stringify(line)} predates the upstream ${fix} fix for ${advisory} (decoded resource paths could escape the output directory). Verify the selected decoder's patches before decoding untrusted APKs; launcher version alone does not establish engine contents or downstream backports. https://github.com/iBotPeaches/Apktool/security/advisories/${slug}`;
  if (!atLeast("2.9.2"))
    limitations.push(
      discloseAdvisory("2.9.2", "CVE-2024-21633", "GHSA-2hqv-2xv4-5h5w"),
    );
  if (platform === "win32" && !atLeast("2.9.3"))
    limitations.push(
      discloseAdvisory(
        "2.9.3",
        "GHSA-vgwr-4w3p-xmjv on Windows",
        "GHSA-vgwr-4w3p-xmjv",
      ),
    );
  // Upstream 65dd848 validates ResTypeSpec names in 3.0.2. The tagged 3.0.0
  // producer also lacks that check, although the advisory names only 3.0.1.
  if (parsed.major === 3 && parsed.minor === 0 && !atLeast("3.0.2"))
    limitations.push(
      discloseAdvisory("3.0.2", "CVE-2026-39973", "GHSA-m8mh-x359-vm8m") +
        (parsed.patch === 0
          ? " Inclusion of the 3.0.0 release line is source-derived; the advisory lists 3.0.1."
          : ""),
    );
  return {
    version: line,
    supportsDocumentedVersion: atLeast("2.7.0"),
    limitations,
  };
};

/** Probe within the caller-admitted command scope; decodes nothing. */
export const inspectApktoolClient = async (
  selection: ApktoolCommandSelection,
  cleanup: ApktoolCommandCleanup,
  options: {
    readonly signal?: AbortSignal;
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly platform?: NodeJS.Platform;
  } = {},
): Promise<ApktoolClientIdentity> => {
  const {
    signal,
    environment = process.env,
    platform = process.platform,
  } = options;
  const hostEnvironment = snapshotEnvironment(environment, platform);
  let invocation: ApktoolInvocation;
  try {
    invocation = apktoolInvocation(
      selection,
      ["--version"],
      hostEnvironment,
      platform,
    );
  } catch (cause) {
    if (!(cause instanceof WindowsBatchCommandError)) throw cause;
    throw new ApktoolConfigurationFailure(
      "launcher_unsupported",
      `The selected apktool launcher cannot be run through cmd.exe: ${cause.message}`,
      {
        selected_command: selection.command,
        command_source: selection.commandSource,
        remediation: `Set ${APKTOOL_COMMAND_ENV} to a launcher path without cmd.exe metacharacters (" % ^ ! & | < >), or to a native apktool executable`,
      },
      { cause },
    );
  }
  let interpreted:
    | Result<ApktoolClientIdentity, ApktoolConfigurationFailure>
    | undefined;
  try {
    // The owned process group stops a shell launcher's children with it; a
    // child holding inherited output pipes cannot outlive the deadline.
    await prepareOwnedCommand(signal);
    await runOwnedCommand(
      {
        command: invocation.command,
        arguments: invocation.arguments,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        // Apktool launchers are commonly interpreter scripts, so ownership is
        // proved by the run token rather than the launcher's argv prefix.
        expectedCommand: null,
        runId: randomUUID(),
        hostEnvironment,
      },
      {
        timeoutMs: VERSION_TIMEOUT_MS,
        diagnosticBytes: VERSION_MAX_OUTPUT_BYTES,
        observeCompleted: (snapshot) => {
          try {
            interpreted = ok(
              interpretApktoolVersion(
                snapshot.stdout.text,
                snapshot.stderr.text,
                selection,
                platform,
              ),
            );
          } catch (cause) {
            if (!(cause instanceof ApktoolConfigurationFailure)) throw cause;
            interpreted = err(cause);
          }
        },
      },
      signal === undefined ? {} : { signal },
    );
  } catch (cause) {
    const recordedFailure =
      interpreted?.ok === false ? interpreted.error : undefined;
    const cancellation =
      cause instanceof OwnedCommandFailure ? cause.cancellation : undefined;
    const failure =
      recordedFailure === undefined
        ? versionProbeFailure(
            cause,
            selection,
            interpreted?.ok === true ? interpreted.value : undefined,
          )
        : new ApktoolConfigurationFailure(
            recordedFailure.code,
            recordedFailure.message,
            {
              ...recordedFailure.diagnostics,
              ...(cancellation === undefined
                ? {}
                : { cancellation_observed: true }),
            },
            { cause },
          );
    const primary =
      failure instanceof AnalysisError
        ? failure
        : new ProviderAdapterError("apktool", "inspect_apktool_client", {
            cause: failure,
            userMessage: failure.message,
            diagnostics: failure.diagnostics,
          });
    const retained = cleanup.retainFailure(
      cause,
      primary,
      "inspect_apktool_client",
    );
    throw retained === primary ? failure : retained;
  }
  if (interpreted === undefined)
    throw new ApktoolConfigurationFailure(
      "version_unresolved",
      "The owned version command completed without an output observation",
      { selected_command: selection.command },
    );
  if (!interpreted.ok) throw interpreted.error;
  return interpreted.value;
};

const interpretApktoolVersion = (
  stdout: string,
  stderr: string,
  selection: ApktoolCommandSelection,
  platform: NodeJS.Platform,
): ApktoolClientIdentity => {
  const identity = parseApktoolVersionOutput(stdout, platform);
  if (identity.version === null)
    throw new ApktoolConfigurationFailure(
      "version_unresolved",
      "The selected apktool launcher exited successfully but did not report a recognizable version",
      {
        selected_command: selection.command,
        command_source: selection.commandSource,
        version_probe: "unrecognized_output",
        reported_version: identity.reportedVersion,
        stdout,
        stderr,
      },
    );
  if (!identity.supportsDocumentedVersion)
    throw new ApktoolConfigurationFailure(
      "unsupported_version",
      `The selected Apktool version ${identity.version} is older than the supported minimum 2.7.0`,
      {
        selected_command: selection.command,
        command_source: selection.commandSource,
        reported_version: identity.version,
        minimum_version: "2.7.0",
        remediation: `Use Apktool 2.7.0 or newer; see docs/apktool-resource-analysis.md.`,
      },
    );
  return identity;
};

/** Availability in the shape shared by every provider. */
const rejectionCodeOf = (
  code: ApktoolConfigurationFailureCode,
): ProviderRejectionCode =>
  code === "command_missing"
    ? "executable_missing"
    : code === "not_absolute" ||
        code === "launcher_unsupported" ||
        code === "command_unresolved"
      ? "not_configured"
      : code === "unsupported_version"
        ? "unsupported_version"
        : "version_unresolved";

export const apktoolConfigurationAvailability = (
  cause: ApktoolConfigurationFailure,
): ProviderAvailability =>
  ({
    status: "unavailable",
    code: rejectionCodeOf(cause.code),
    reason: cause.message,
    diagnostics: { ...cause.diagnostics },
  }) as ProviderAvailability;

/** Interpret the command owner's outcome, without inferring a new failure from a late signal. */
const versionProbeFailure = (
  cause: unknown,
  selection: ApktoolCommandSelection,
  observed: ApktoolClientIdentity | undefined,
): AnalysisError | ApktoolConfigurationFailure => {
  if (cause instanceof AnalysisError) return cause;
  const preparation =
    cause instanceof OwnedCommandFailure
      ? cause.preparationFailure
      : cause instanceof DarwinProcessOwnershipInspectionError
        ? cause
        : undefined;
  const output = capturedApktoolFailureOutput(cause);
  if (cause instanceof OwnedCommandFailure && cause.reason === "cancelled")
    return new AnalysisCancelledError("inspect_apktool_client", {
      cause: cause.cancellation?.reason,
      ...(output === undefined ? {} : { capturedOutput: output }),
      ...(observed === undefined
        ? {}
        : { diagnostics: { client: { version: observed.version } } }),
    });
  if (preparation !== undefined)
    return new ProviderAdapterError("apktool", "inspect_apktool_client", {
      cause,
      diagnostics: {
        stage: "ownership_preparation",
        ...(preparation.compilerOutcome === undefined
          ? {}
          : {
              compiler_outcome: jsonValueSchema.parse(
                preparation.compilerOutcome,
              ),
            }),
      },
      ...(preparation.capturedOutput === undefined
        ? {}
        : { capturedOutput: preparation.capturedOutput }),
    });
  if (cause instanceof OwnedCommandFailure && cause.reason === "timeout")
    return new AnalysisTimeoutError(
      "inspect_apktool_client",
      VERSION_TIMEOUT_MS,
      { cause, ...(output === undefined ? {} : { capturedOutput: output }) },
    );
  if (
    cause instanceof Error &&
    "code" in cause &&
    (cause.code === "ENOENT" || cause.code === "EACCES")
  )
    return new ApktoolConfigurationFailure(
      "command_missing",
      `The selected apktool launcher was not found: ${selection.command}`,
      {
        selected_command: selection.command,
        command_source: selection.commandSource,
        remediation: `Set ${APKTOOL_COMMAND_ENV} to an absolute apktool launcher (the upstream wrapper or a java -jar script)`,
      },
      { cause },
    );
  const snapshot = cause instanceof OwnedCommandFailure ? cause.snapshot : null;
  return new ApktoolConfigurationFailure(
    "version_unresolved",
    "The selected apktool launcher did not report a usable version",
    {
      selected_command: selection.command,
      ...(observed === undefined
        ? {}
        : { client: { version: observed.version } }),
      ...(snapshot === null
        ? {}
        : {
            exit_code: snapshot.exitCode ?? null,
            stderr_excerpt: snapshot.stderr.text.slice(0, 512),
          }),
      ...(cause instanceof OwnedCommandFailure &&
      cause.reason === "output-limit"
        ? { max_output_bytes: VERSION_MAX_OUTPUT_BYTES }
        : {}),
    },
    { cause },
  );
};
