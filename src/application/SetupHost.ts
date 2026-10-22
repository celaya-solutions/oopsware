import {
  isClientConfigurationCleanupFailure,
  retryClientConfigurationCleanup,
} from "./ClientConfigurationCleanup.js";
import { access } from "node:fs/promises";
import { resolve } from "node:path";

import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import {
  invokingPackageRunner,
  packageRunnerRegistrationCommand,
  type PackageRunner,
} from "./ClientRegistrationIdentity.js";
import {
  SUPPORTED_NODE_VERSION_PROSE,
  supportsNodeVersion,
} from "../domain/runtimeVersion.js";
import { runDoctor, systemDoctorHost, type DoctorHost } from "./Doctor.js";
import {
  installLinuxHopper,
  LinuxHopperTemporaryCleanupOwner,
  readLinuxDistribution,
  systemLinuxHopperInstallHost,
  type LinuxHopperInstallHost,
} from "./LinuxHopper.js";
import { installMacHopper, systemMacHopperInstallHost } from "./MacHopper.js";
import { linuxHopperReleaseCacheDirectory } from "./LinuxHopperPublisher.js";
import {
  clientEvidencePaths,
  supportedClients,
  type SetupClient,
} from "./SupportedClients.js";
import {
  skillDestinations,
  canonicalSkillNeedsInstall,
  installCanonicalSkill,
  validateCanonicalSkillDirectories,
} from "./SetupSkill.js";
import {
  clientConfigurationAligned,
  ClientConfigurationCleanupRollbackFailure,
  configureClientConfiguration,
  inspectClientConfiguration,
} from "./SetupClientConfiguration.js";
import { failedConfigurationMessage } from "./SetupClients.js";
import { setupInstallFailure } from "./SetupInstallFailure.js";
import { RegularFileCleanupFailure } from "./RegularFileRead.js";
import {
  explicitSetupRegistrationEnvironment,
  providerRegistrationEnvironment,
} from "./SetupRegistrationEnvironment.js";
import {
  msixPackagesDirectory,
  packagePrivateLauncherBlocker,
} from "./MsixPackageStorage.js";
import type {
  SetupHost,
  SetupInitialState,
  SetupProviderEnvironment,
} from "./SetupTypes.js";
import type { DoctorScope } from "./Doctor.js";
import { CURRENT_ENTRYPOINT_PATH } from "../process/CurrentEntrypointPath.js";
import { analysisProviderSelectorSchema } from "../contracts/providerSelection.js";

/** Resolve the executable and arguments used in a managed MCP registration. */
export const setupRegistrationCommand = (
  platform: NodeJS.Platform,
  packageRunner: PackageRunner | undefined,
  entrypointPath: string | undefined,
): readonly string[] => {
  if (packageRunner !== undefined)
    return packageRunnerRegistrationCommand(packageRunner, platform);
  if (entrypointPath === undefined || entrypointPath.length === 0) return [];
  return platform === "win32"
    ? [process.execPath, entrypointPath, "mcp"]
    : [entrypointPath, "mcp"];
};

/**
 * The launcher setup registers, and why it must not be registered when it
 * exists only inside one MSIX package's private storage.
 */
const setupRegistration = (
  platform: NodeJS.Platform,
  homeDirectory: string,
  environment: Readonly<NodeJS.ProcessEnv>,
): Pick<SetupHost, "registrationCommand" | "registrationCommandBlocker"> => {
  const registrationCommand = setupRegistrationCommand(
    platform,
    invokingPackageRunner(environment, platform),
    CURRENT_ENTRYPOINT_PATH,
  );
  const registrationCommandBlocker =
    registrationCommand.length === 0
      ? "REA could not determine the current executable entrypoint. Run setup through the installed REA CLI or a supported package runner before configuring clients."
      : platform === "win32"
        ? packagePrivateLauncherBlocker(
            registrationCommand,
            msixPackagesDirectory(homeDirectory, environment),
          )
        : undefined;
  return registrationCommandBlocker === undefined
    ? { registrationCommand }
    : { registrationCommand, registrationCommandBlocker };
};

export const filterClientsNeedingConfigure = async (
  host: SetupHost,
  detectedClients: readonly SetupClient[],
  providerEnvironment: SetupProviderEnvironment,
  command: readonly string[],
): Promise<readonly SetupClient[]> => {
  const needs = await Promise.all(
    detectedClients.map((client) =>
      host.clientNeedsConfigure(client, providerEnvironment, command),
    ),
  );
  return detectedClients.filter((_, index) => needs[index]);
};

export const hostRemediation = async (
  host: SetupHost,
  installHopper: boolean,
): Promise<string | undefined> => {
  if (!supportsNodeVersion(host.nodeVersion))
    return `Install ${SUPPORTED_NODE_VERSION_PROSE} and rerun setup.`;
  if (!installHopper) return undefined;
  if (host.platform !== "darwin" && host.platform !== "linux")
    return "Oopsware supports Hopper on macOS and selected 64-bit Linux distributions.";
  if (host.platform === "darwin") {
    const version = await host.macosVersion();
    return version === undefined || major(version) < 12
      ? "Upgrade to macOS 12 or newer."
      : undefined;
  }
  if ((await host.linuxDistribution())?.hopperSetupSupported === true)
    return undefined;
  return "Automated Hopper setup supports Ubuntu 24.04+, Fedora 41+, Nobara 44+, 64-bit Arch Linux, CachyOS, and Omarchy; configure an existing supported provider instead.";
};

/** Production setup effects for Hopper, agent configuration, and the canonical skill directory. */
export const systemSetupHost = (
  selectedDoctorHost: DoctorHost | undefined = undefined,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): SetupHost => {
  const doctorHost = selectedDoctorHost ?? systemDoctorHost({ environment });
  const platform = doctorHost.platform;
  const { homeDirectory } = doctorHost;
  const macHopperHost =
    platform === "darwin"
      ? systemMacHopperInstallHost(homeDirectory, environment)
      : undefined;
  const resources = new ArtifactResourceScope();
  const linuxHopperHost = systemLinuxHopperInstallHost(environment);
  const pendingLinuxHopperCleanup = new LinuxHopperTemporaryCleanupOwner();
  return {
    platform,
    homeDirectory,
    ...(platform === "linux"
      ? {
          linuxHopperReleaseCache:
            linuxHopperReleaseCacheDirectory(environment),
        }
      : {}),
    skillDestinations: (clientIds) =>
      skillDestinations(homeDirectory, clientIds, environment, platform),
    ...setupRegistration(platform, homeDirectory, environment),
    nodeVersion: process.versions.node,
    macosVersion: () => doctorHost.macosVersion(),
    linuxDistribution: readLinuxDistribution,
    close: () =>
      closeSetupResources(resources, macHopperHost, doctorHost, () =>
        closeLinuxHopperInstallHost(linuxHopperHost, pendingLinuxHopperCleanup),
      ),
    initialSetupState: async (
      scope?: DoctorScope,
    ): Promise<SetupInitialState> => {
      const diagnosis = await runDoctor(undefined, doctorHost, scope);
      const providerEnvironment: SetupProviderEnvironment = {
        ...providerRegistrationEnvironment(diagnosis.providerInspections ?? []),
        ...doctorHost.providerRegistrationEnvironment?.(),
        ...explicitSetupRegistrationEnvironment(environment),
        ...(diagnosis.hopperPath === undefined
          ? {}
          : { HOPPER_LAUNCHER_PATH: diagnosis.hopperPath }),
      };
      const requestedProvider = analysisProviderSelectorSchema.safeParse(
        environment.REA_ANALYSIS_PROVIDER,
      );
      return {
        ...(diagnosis.hopperPath === undefined
          ? {}
          : { hopperPath: diagnosis.hopperPath }),
        ...(typeof environment.HOPPER_LAUNCHER_PATH === "string" &&
        environment.HOPPER_LAUNCHER_PATH.trim() !== "" &&
        diagnosis.hopperPath === environment.HOPPER_LAUNCHER_PATH
          ? { hopperLauncherConfigured: true }
          : {}),
        providerConfigured:
          diagnosis.hopperPath !== undefined ||
          diagnosis.providerInspections?.some(
            ({ configured }) => configured,
          ) === true ||
          providerEnvironment.REA_JEB_MCP_URL !== undefined ||
          (requestedProvider.success && requestedProvider.data !== "auto"),
        providerEnvironment,
        doctor: diagnosis,
      };
    },
    installHopper: async (replaceExisting) => {
      if (platform === "linux") {
        const result = await installLinuxHopper(linuxHopperHost);
        if (result.cleanupFailure !== undefined)
          pendingLinuxHopperCleanup.retain(result.cleanupFailure);
        if (result.status === "installed")
          return { status: "installed", launcherPath: result.launcherPath };
        const failure = setupInstallFailure(
          result.reason,
          result.packageFailure,
          "linux",
        );
        const detail =
          result.verificationFailure?.message ??
          result.pythonRuntimeFailure?.message;
        return detail !== undefined
          ? {
              ...failure,
              remediation: `${detail} ${failure.remediation}`,
            }
          : failure;
      }
      if (macHopperHost === undefined)
        return setupInstallFailure("unsupported_host");
      const result = await installMacHopper({ replaceExisting }, macHopperHost);
      if (result.status === "installed")
        return {
          status: "installed",
          launcherPath: result.launcherPath,
          ...(result.openFailure === undefined
            ? {}
            : {
                warning: `Hopper was installed, but macOS could not open it: ${result.openFailure}. Open ${result.launcherPath} manually to complete first-run setup.`,
              }),
          ...(result.cleanupFailure === undefined
            ? {}
            : { cleanupFailure: result.cleanupFailure }),
        };
      const failure = setupInstallFailure(result.reason);
      const diagnostic = setupInstallerDiagnostic(result.diagnostic);
      return {
        ...failure,
        remediation: [
          failure.remediation,
          ...(diagnostic === undefined
            ? []
            : [`Installer detail: ${diagnostic}`]),
          ...(result.cleanupFailure === undefined
            ? []
            : [result.cleanupFailure]),
        ].join(" "),
      };
    },
    detectedClients: () => detectClients(homeDirectory, platform, environment),
    supportedClients: () =>
      Promise.resolve(supportedClients(homeDirectory, platform, environment)),
    ...clientConfigurationOperations(
      resources,
      doctorHost.resolveProviderRequestBudget,
    ),
    skillNeedsInstall: (clientIds) =>
      canonicalSkillNeedsInstall(
        homeDirectory,
        clientIds,
        environment,
        platform,
        resources,
      ),
    validateSkillDirectories: (clientIds) =>
      validateCanonicalSkillDirectories(
        homeDirectory,
        clientIds,
        environment,
        platform,
      ),
    installSkill: (clientIds) =>
      installCanonicalSkill(
        homeDirectory,
        clientIds,
        environment,
        platform,
        undefined,
        resources,
      ),
    doctor: (scope) => runDoctor(undefined, doctorHost, scope),
  };
};

const setupInstallerDiagnostic = (
  value: string | undefined,
): string | undefined => {
  if (value === undefined) return undefined;
  const normalized = value
    .replace(/\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\([0-9A-Za-z]|[@-Z\\^_])/gu, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (normalized === "") return undefined;
  return normalized.length <= 400
    ? normalized
    : `${normalized.slice(0, 397).trimEnd()}...`;
};

const clientConfigurationOperations = (
  resources: ArtifactResourceScope,
  resolveProviderRequestBudget: DoctorHost["resolveProviderRequestBudget"],
) => ({
  configureClient: (
    client: SetupClient,
    providerEnvironment: SetupProviderEnvironment,
    command: readonly string[],
  ) =>
    runClientConfigurationOperation(resources, async () =>
      client.format === "unsupported"
        ? { status: "skipped" as const }
        : configureClientConfiguration(
            client,
            providerEnvironment,
            command,
            resolveProviderRequestBudget,
          ),
    ),
  clientNeedsConfigure: (
    client: SetupClient,
    providerEnvironment: SetupProviderEnvironment,
    command: readonly string[],
  ) =>
    runClientConfigurationOperation(resources, async () =>
      client.format === "unsupported"
        ? false
        : !(await clientConfigurationAligned(
            client,
            providerEnvironment,
            command,
            resolveProviderRequestBudget,
          )),
    ),
  inspectClientConfiguration: (
    client: SetupClient,
    providerEnvironment: SetupProviderEnvironment,
    command: readonly string[],
  ) =>
    runClientConfigurationOperation(resources, () =>
      inspectClientConfiguration(
        client,
        providerEnvironment,
        command,
        resolveProviderRequestBudget,
      ),
    ),
});

const closeSetupResources = async (
  resources: ArtifactResourceScope,
  macHopperHost: ReturnType<typeof systemMacHopperInstallHost> | undefined,
  doctorHost: DoctorHost,
  retryLinuxHopperCleanup: () => Promise<string | undefined>,
): Promise<string | undefined> => {
  const [resourceCleanup, hopperCleanup, doctorCleanup, linuxCleanup] =
    await Promise.allSettled([
      resources.close(),
      Promise.resolve().then(() => macHopperHost?.close()),
      Promise.resolve().then(() => doctorHost.close?.()),
      retryLinuxHopperCleanup(),
    ]);
  const failures: string[] = [];
  if (hopperCleanup.status === "rejected")
    failures.push(
      `Hopper host cleanup failed: ${errorMessage(hopperCleanup.reason)}`,
    );
  else if (hopperCleanup.value !== undefined)
    failures.push(hopperCleanup.value);
  if (doctorCleanup.status === "rejected")
    failures.push(
      `Doctor host cleanup failed: ${errorMessage(doctorCleanup.reason)}`,
    );
  else if (doctorCleanup.value !== undefined)
    failures.push(doctorCleanup.value);
  if (linuxCleanup.status === "rejected")
    failures.push(
      `Linux Hopper cleanup retry failed: ${errorMessage(linuxCleanup.reason)}`,
    );
  else if (linuxCleanup.value !== undefined) failures.push(linuxCleanup.value);
  if (resourceCleanup.status === "rejected")
    failures.push(errorMessage(resourceCleanup.reason));
  return failures.length === 0 ? undefined : failures.join("; ");
};

const runClientConfigurationOperation = async <Value>(
  resources: ArtifactResourceScope,
  operation: () => Promise<Value>,
): Promise<Value> => {
  try {
    return await resources.run(async () => {
      try {
        return await operation();
      } catch (cause: unknown) {
        if (!isClientConfigurationCleanupFailure(cause)) throw cause;
        const cleanup = await retryClientConfigurationCleanup(cause, resources);
        const rollback = cleanup.failures.find(
          (failure) =>
            failure instanceof ClientConfigurationCleanupRollbackFailure,
        );
        const rollbackMessage =
          rollback instanceof ClientConfigurationCleanupRollbackFailure
            ? ` ${failedConfigurationMessage(rollback.configurationFailure)}`
            : "";
        throw configurationCleanupError(
          `Could not safely access client configuration at ${cause.path}: ${errorMessage(cleanup.primary)}.${rollbackMessage}`,
          cause,
          cleanup.cleanup,
        );
      }
    });
  } catch (cause: unknown) {
    if (cause instanceof ArtifactReaderFailure)
      throw configurationCleanupError(cause.message, cause, cause.cleanup);
    throw cause;
  }
};

const configurationCleanupError = (
  message: string,
  cause: unknown,
  cleanup:
    | { readonly reason: string; readonly resources: readonly string[] }
    | undefined,
): ConfigurationError =>
  new ConfigurationError(message, {
    cause,
    settings: [{ setting: "client configuration", constraint: message }],
    ...(cleanup === undefined ? {} : { cleanup }),
  });

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const closeLinuxHopperInstallHost = async (
  host: LinuxHopperInstallHost,
  temporaryOwner: LinuxHopperTemporaryCleanupOwner,
): Promise<string | undefined> => {
  const reasons: string[] = [];
  const temporary = await temporaryOwner.retry(host.cleanup);
  if (temporary !== undefined) reasons.push(temporary);
  try {
    await host.close?.();
  } catch (cause: unknown) {
    reasons.push(
      `Linux Hopper publisher cleanup failed: ${errorMessage(cause)}`,
    );
  }
  return reasons.length === 0 ? undefined : reasons.join("; ");
};

/** Detect supported agents from their config files or stable installation markers. */
export const detectClients = async (
  home: string,
  platform: NodeJS.Platform = process.platform,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): Promise<readonly SetupClient[]> => {
  const detected: SetupClient[] = [];
  for (const candidate of supportedClients(home, platform, environment)) {
    if (candidate.configPathError !== undefined) continue;
    if (await clientEvidencePresent(candidate)) detected.push(candidate);
  }
  return detected;
};

const major = (version: string): number =>
  Number.parseInt(version.split(".")[0] ?? "0", 10);
const clientEvidencePresent = async (client: SetupClient): Promise<boolean> => {
  for (const path of clientEvidencePaths(client))
    if (await exists(path)) return true;
  return false;
};

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch (cause: unknown) {
    // best-effort cleanup: optional host probing; absence means unavailable.
    void cause;
    return false;
  }
};
