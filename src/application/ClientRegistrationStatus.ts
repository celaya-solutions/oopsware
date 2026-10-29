import { readClientPolicyBlock } from "./ClientPolicyBlock.js";
import { readEffectiveClientRegistrationConfiguration } from "./ClientConfigurationFiles.js";
import {
  clientServerForcedEnabled,
  clientServerListedDisabled,
  effectiveClientServer,
  type ClientConfigurationDocument,
} from "./ClientConfigurationDocument.js";
import { lstat } from "node:fs/promises";
import { err, ok, type Result } from "../domain/result.js";
import { isAbsolute } from "node:path";

import { z } from "zod";
import { valid } from "semver";

import { RegularFileCleanupFailure } from "./RegularFileRead.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import { CURRENT_ENTRYPOINT_PATH } from "../process/CurrentEntrypointPath.js";
import {
  MCP_STARTUP_POLICY,
  mcpProviderDeadlineAllowanceMs,
  recommendedMcpToolTimeoutMs,
  recommendedMcpToolTimeoutSeconds,
  type McpToolTimeoutInputs,
} from "../mcpStartupPolicy.js";
import {
  clientRegistrationPackageReference,
  classifyClientRegistrationCommand,
  packageRunnerRegistrationCommand,
} from "./ClientRegistrationIdentity.js";
import {
  clientEvidencePaths,
  manualRegistrationRemediation,
  supportedClients,
} from "./SupportedClients.js";
import type { SetupClient } from "./SupportedClients.js";
import { compareUnicodeCodePoints } from "../domain/unicodeCodePointOrder.js";
import { dshDocument } from "./DshCordisPatch.js";
import { clientRegistrationEnvironmentDetailsWithBudget } from "./ClientRegistrationEnvironment.js";
import type { ProviderRequestBudgetResolver } from "./ClientRegistrationEnvironment.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";

interface ClientRegistrationStatusBase {
  readonly client: string;
  readonly config_path: string;
  /** Exact package reference requested by npx/bunx, when registration uses one. */
  readonly package_reference?: string;
  /** Non-blocking timeout guidance; caller-selected values remain aligned. */
  readonly advisory?: string;
}

type RegistrationCommand = readonly [string, ...string[]];

export type ClientRegistrationStatus = ClientRegistrationStatusBase &
  (
    | {
        readonly command: RegistrationCommand;
        readonly state: "aligned";
        readonly remediation: null;
      }
    | {
        readonly command: RegistrationCommand;
        readonly state: "stale";
        readonly remediation: string;
      }
    | {
        readonly command: RegistrationCommand;
        readonly state: "unknown";
        readonly remediation: string;
      }
    | {
        readonly command: readonly [];
        readonly state: "missing" | "invalid" | "manual";
        readonly remediation: string;
      }
  );

export type UnhealthyClientRegistrationStatus = Exclude<
  ClientRegistrationStatus,
  { readonly state: "aligned" }
>;

const tomlTimeoutSchema = z.union([
  z.number().positive(),
  z.bigint().positive(),
]);

const registrationSchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    // TOML keeps integers beyond the safe Number range exact as bigint.
    startup_timeout_sec: tomlTimeoutSchema.optional(),
    tool_timeout_sec: tomlTimeoutSchema.optional(),
    startupTimeoutMs: z.number().positive().optional(),
    toolTimeoutMs: z.number().positive().optional(),
    type: z.string().optional(),
    transport: z.string().optional(),
    serverName: z.string().optional(),
    tools: z.array(z.string()).optional(),
    disabled: z.boolean().optional(),
    enabled: z.boolean().optional(),
  })
  .passthrough();

interface ClientRegistrationReadOptions {
  readonly platform?: NodeJS.Platform;
  readonly environment?: NodeJS.ProcessEnv;
  readonly resources?: ArtifactResourceScope;
  readonly resolveProviderRequestBudget?: ProviderRequestBudgetResolver;
}

/** Registration facts shared by diagnostics and update maintenance. */
export interface ClientRegistrationInspection {
  readonly status: ClientRegistrationStatus;
  readonly activation: "enabled" | "disabled" | "unknown";
}

/** Project diagnostics from the same inspection used to select maintenance. */
export const readClientRegistrationStatuses = async (
  home: string,
  currentCommandPath: string | undefined = CURRENT_ENTRYPOINT_PATH,
  options: ClientRegistrationReadOptions = {},
): Promise<readonly ClientRegistrationStatus[]> =>
  (
    await readClientRegistrationInspections(home, currentCommandPath, options)
  ).map(({ status }) => status);

/** Parse effective registrations and their client-specific activation once.
 * A supplied scope retains failed cleanup; otherwise transfer its exact failure.
 */
export const readClientRegistrationInspections = async (
  home: string,
  currentCommandPath: string | undefined = CURRENT_ENTRYPOINT_PATH,
  options: ClientRegistrationReadOptions = {},
): Promise<readonly ClientRegistrationInspection[]> => {
  const inspections: ClientRegistrationInspection[] = [];
  const record = (
    status: ClientRegistrationStatus,
    activation: ClientRegistrationInspection["activation"] = "unknown",
  ): void => {
    inspections.push({ status, activation });
  };
  for (const client of supportedClients(
    home,
    options.platform,
    options.environment,
  )) {
    if (client.configPathError !== undefined) {
      record({
        client: client.name,
        config_path: client.configPath,
        command: [],
        state: "invalid",
        remediation: client.configPathError,
      });
      continue;
    }
    const presence = await clientEvidencePresent(client);
    if (!presence.ok) {
      record({
        client: client.name,
        config_path: presence.error.path,
        command: [],
        state: "invalid",
        remediation: presence.error.detail,
      });
      continue;
    }
    if (!presence.value) continue;
    const manualRemediation = manualRegistrationRemediation(client.name);
    if (client.format === "unsupported") {
      if (manualRemediation !== undefined)
        record({
          client: client.name,
          config_path: client.markerPath ?? client.configPath,
          command: [],
          state: "manual",
          remediation: manualRemediation,
        });
      continue;
    }
    let selectedConfigPath = client.configPath;
    try {
      const configuration = await readEffectiveClientRegistrationConfiguration(
        client,
        options.resources,
        options.platform,
      );
      if (!configuration.ok) {
        if (
          options.resources === undefined &&
          configuration.error.cleanupFailure !== undefined
        )
          throw configuration.error.cleanupFailure;
        record({
          client: client.name,
          config_path: configuration.error.path,
          command: [],
          state: "invalid",
          remediation: configuration.error.detail,
        });
        continue;
      }
      const { document: parsed, configPath } = configuration.value;
      selectedConfigPath = configPath;
      if (parsed === undefined) {
        record(unavailableStatus(client, "missing", configPath));
        continue;
      }
      const policy = await readClientPolicyBlock(
        client,
        parsed,
        undefined,
        options.resources,
      );
      if (!policy.ok) {
        if (
          options.resources === undefined &&
          policy.error.cleanupFailure !== undefined
        )
          throw policy.error.cleanupFailure;
        record({
          client: client.name,
          config_path: configPath,
          command: [],
          state: "invalid",
          remediation: policy.error.detail,
        });
        continue;
      }
      const policyBlock = policy.value;
      const raw = effectiveClientServer(parsed, PRODUCT_IDENTITY.mcpServerKey);
      if (raw === undefined) {
        const editabilityError =
          parsed.dialect === "dsh"
            ? dshDocument(parsed.document).editabilityError
            : undefined;
        if (editabilityError !== undefined) {
          record({
            client: client.name,
            config_path: configPath,
            command: [],
            state: "invalid",
            remediation: editabilityError.message,
          });
          continue;
        }
        record(unavailableStatus(client, "missing", configPath));
        continue;
      }
      const effectiveClient: SetupClient =
        parsed.dialect === "zcode_fallback"
          ? {
              ...client,
              configPath,
              configPaths: [configPath],
              format: "zcode_fallback",
            }
          : client;
      const registration = parseRegistration(raw, effectiveClient);
      const registrationEnvironment =
        client.name === "kimi" ||
        client.name === "codex" ||
        client.defaultInputSchemaProfile !== undefined
          ? await clientRegistrationEnvironmentDetailsWithBudget(
              parsed,
              {},
              "effective",
              client.name === "kimi" || client.name === "codex"
                ? options.resolveProviderRequestBudget
                : undefined,
              options.platform,
            )
          : undefined;
      if (
        registrationEnvironment !== undefined &&
        !registrationEnvironment.ok
      ) {
        record({
          client: client.name,
          config_path: configPath,
          command: [],
          state: "invalid",
          remediation: registrationEnvironment.error.message,
        });
        continue;
      }
      const command: RegistrationCommand = [
        registration.command,
        ...registration.args,
      ];
      const packageReference = clientRegistrationPackageReference(command);
      const activation = registrationActivation(registration, client, parsed);
      const packageVersion = exactRegisteredPackageVersion(packageReference);
      const packageVersionDrift =
        packageVersion !== undefined &&
        packageVersion !== PRODUCT_IDENTITY.packageVersion;
      const alignment = registrationAligned({
        registration,
        client: effectiveClient,
        currentCommandPath,
        platform: options.platform ?? process.platform,
        inputSchemaProfileSelected:
          registrationEnvironment?.ok === true &&
          snapshotEnvironment(
            registrationEnvironment.value.values,
            options.platform,
          ).REA_MCP_INPUT_SCHEMA_PROFILE !== undefined,
      });
      record(
        configuredStatus(
          effectiveClient,
          command,
          alignment === "unknown"
            ? "unknown"
            : activation === "enabled" &&
                !packageVersionDrift &&
                alignment === "aligned" &&
                (parsed.dialect !== "dsh" ||
                  dshDocument(parsed.document).ready) &&
                policyBlock === undefined
              ? "aligned"
              : "stale",
          policyBlock ??
            (packageVersionDrift
              ? packageVersionRemediation(packageReference ?? "", client)
              : alignment === "unknown"
                ? unknownEntryPointRemediation()
                : undefined),
          packageReference,
          registrationEnvironment?.ok === true
            ? timeoutAdvisory(
                client,
                registration,
                registrationEnvironment.value.timeoutInputs,
              )
            : undefined,
        ),
        activation,
      );
    } catch (cause: unknown) {
      if (
        options.resources === undefined &&
        cause instanceof RegularFileCleanupFailure
      )
        throw cause;
      record(
        unavailableStatus(
          client,
          isMissing(cause) ? "missing" : "invalid",
          selectedConfigPath,
        ),
      );
    }
  }
  return inspections.sort((left, right) =>
    compareUnicodeCodePoints(left.status.client, right.status.client),
  );
};

const registrationActivation = (
  registration: z.output<typeof registrationSchema>,
  client: SetupClient,
  parsed: ClientConfigurationDocument,
): "enabled" | "disabled" =>
  (client.format !== "grok" && registration.disabled === true) ||
  (registration.enabled === false &&
    !clientServerForcedEnabled(parsed, PRODUCT_IDENTITY.mcpServerKey)) ||
  ((parsed.dialect === "zcode" || parsed.dialect === "zcode_fallback") &&
    registration.enable === false) ||
  clientServerListedDisabled(parsed, PRODUCT_IDENTITY.mcpServerKey)
    ? "disabled"
    : "enabled";

const registrationAligned = ({
  registration,
  client,
  currentCommandPath,
  platform,
  inputSchemaProfileSelected,
}: {
  readonly registration: z.output<typeof registrationSchema>;
  readonly client: SetupClient;
  readonly currentCommandPath: string | undefined;
  readonly platform: NodeJS.Platform;
  readonly inputSchemaProfileSelected: boolean;
}): "aligned" | "stale" | "unknown" => {
  const command = [registration.command, ...registration.args];
  const identity = classifyClientRegistrationCommand(
    command,
    currentCommandPath,
  );
  if (identity === "unknown") return "unknown";
  if (identity === "foreign") return "stale";
  if (
    client.name === "grok_build" &&
    registration.startup_timeout_sec !==
      MCP_STARTUP_POLICY.codexStartupTimeoutSeconds
  )
    return "stale";
  if (
    client.name === "codex" &&
    (registration.startup_timeout_sec === undefined ||
      registration.tool_timeout_sec === undefined)
  )
    return "stale";
  if (
    client.name === "kimi" &&
    (registration.startupTimeoutMs === undefined ||
      registration.toolTimeoutMs === undefined)
  )
    return "stale";
  if (
    client.defaultInputSchemaProfile !== undefined &&
    !inputSchemaProfileSelected
  )
    return "stale";
  if (
    (client.format === "kimi" ||
      client.format === "omp" ||
      client.format === "pi" ||
      client.format === "freebuff") &&
    registration.type !== undefined &&
    registration.type !== "stdio"
  )
    return "stale";
  if (client.format === "vscode" && registration.type !== "stdio")
    return "stale";
  // A Harness registration only connects as the rea stdio server; another
  // server name or transport leaves the session without REA tools.
  if (
    client.format === "dsh" &&
    (registration.serverName !== "rea" || registration.transport !== "stdio")
  )
    return "stale";
  if (
    client.format === "copilot_cli" &&
    (registration.type !== "stdio" ||
      JSON.stringify(registration.tools) !== JSON.stringify(["*"]))
  )
    return "stale";
  if (client.format === "commandcode" && registration.transport !== "stdio")
    return "stale";
  if (
    (["npx", "bunx"] as const).some((runner) => {
      const expected = packageRunnerRegistrationCommand(runner, platform);
      return (
        command.length === expected.length &&
        command.every((argument, index) => argument === expected[index])
      );
    })
  )
    return "aligned";
  // Other owned package references remain stale until pinned to this version.
  if (clientRegistrationPackageReference(command) !== undefined) return "stale";
  // The identity owner already established an exact direct launcher match.
  // A bare command still depends on the client's PATH, so cannot prove alignment.
  return isAbsolute(command[0] ?? "") ? "aligned" : "stale";
};

const parseRegistration = (
  value: unknown,
  client: SetupClient,
): z.output<typeof registrationSchema> => {
  if (client.format === "dsh")
    return registrationSchema
      .pick({ command: true, args: true, serverName: true, transport: true })
      .strip()
      .parse(value);
  if (client.format === "opencode") {
    const entry = z
      .object({
        type: z.literal("local"),
        command: z.array(z.string()).min(1),
        environment: z.record(z.string(), z.string()).optional(),
      })
      .passthrough()
      .parse(value);
    const [command = "", ...args] = entry.command;
    return registrationSchema.parse({
      ...entry,
      command,
      args,
    });
  }
  const registration = registrationSchema.parse(value);
  if (
    client.format === "kimi" &&
    registration.transport !== undefined &&
    registration.transport !== "stdio"
  )
    throw new TypeError("Expected an stdio registration");
  if (
    (client.format === "vscode" || client.format === "copilot_cli") &&
    registration.type !== "stdio"
  )
    throw new TypeError("Expected an stdio registration");
  if (client.format === "commandcode" && registration.transport !== "stdio")
    throw new TypeError("Expected an stdio registration");
  if (
    (client.format === "kimi" ||
      client.format === "omp" ||
      client.format === "pi" ||
      client.format === "freebuff") &&
    registration.type !== undefined &&
    registration.type !== "stdio"
  )
    throw new TypeError("Expected an stdio registration");
  return registration;
};

/** A client that rewrites its file from memory must be quit before setup. */
const remediation = (client: SetupClient): string => {
  if (client.quitBeforeSetup !== true)
    return "Run oopsware setup to refresh this registration, then restart the client.";
  const name = client.displayName ?? client.name;
  return `Quit ${name} fully, run oopsware setup to refresh this registration, then start ${name} again. A running ${name} can rewrite its configuration from memory and drop the registration.`;
};

const unknownEntryPointRemediation = (): string =>
  "The existing registration was retained because its executable identity cannot be verified. Check the registered launcher path, symlink targets and access permissions. Run the installed Oopsware CLI or a supported package runner, then rerun oopsware doctor; no registration was changed.";

const configuredStatus = (
  client: SetupClient,
  command: RegistrationCommand,
  state: "aligned" | "stale" | "unknown",
  policyRemediation?: string,
  packageReference?: string,
  advisory?: string,
): ClientRegistrationStatus =>
  state === "aligned"
    ? {
        client: client.name,
        config_path: client.configPath,
        command,
        ...(packageReference === undefined
          ? {}
          : { package_reference: packageReference }),
        state,
        remediation: null,
        ...(advisory === undefined ? {} : { advisory }),
      }
    : {
        client: client.name,
        config_path: client.configPath,
        command,
        ...(packageReference === undefined
          ? {}
          : { package_reference: packageReference }),
        state,
        remediation: policyRemediation ?? remediation(client),
      };

const timeoutAdvisory = (
  client: SetupClient,
  registration: z.output<typeof registrationSchema>,
  timeoutInputs: McpToolTimeoutInputs,
): string | undefined => {
  const toolTimeout =
    client.name === "kimi"
      ? registration.toolTimeoutMs
      : client.name === "codex"
        ? registration.tool_timeout_sec
        : undefined;
  if (toolTimeout === undefined) return undefined;
  const providerAllowance = mcpProviderDeadlineAllowanceMs(timeoutInputs);
  const isKimi = client.name === "kimi";
  // A bigint is beyond the safe Number range, so rounding cannot cross the allowance.
  const toolTimeoutMs = Number(toolTimeout) * (isKimi ? 1 : 1000);
  if (toolTimeoutMs >= providerAllowance) return undefined;
  const setting = isKimi ? "toolTimeoutMs" : "tool_timeout_sec";
  const currentValue = isKimi
    ? `${String(toolTimeout)} ms`
    : `${String(toolTimeout)} seconds`;
  const recommendedValue = isKimi
    ? `${String(recommendedMcpToolTimeoutMs(timeoutInputs))} ms`
    : `${String(recommendedMcpToolTimeoutSeconds(timeoutInputs))} seconds`;
  const headroom = isKimi
    ? `${String(MCP_STARTUP_POLICY.toolOperationHeadroomMs)} ms`
    : `${String(MCP_STARTUP_POLICY.toolOperationHeadroomMs / 1000)} seconds`;
  return `The configured ${setting} (${currentValue}) is shorter than Oopsware's known provider allowance (${String(providerAllowance)} ms), so provider startup or an upstream request may exceed this client deadline. Oopsware recommends ${setting} = ${recommendedValue} to cover that allowance plus ${headroom} of operation headroom; this additional headroom is a recommendation, not a guarantee for every analysis.`;
};

const exactRegisteredPackageVersion = (
  packageReference: string | undefined,
): string | undefined => {
  if (packageReference === undefined) return undefined;
  const prefix = `${PRODUCT_IDENTITY.packageName}@`;
  if (!packageReference.startsWith(prefix)) return undefined;
  const version = packageReference.slice(prefix.length);
  return valid(version) === version ? version : undefined;
};

const packageVersionRemediation = (
  packageReference: string,
  client: SetupClient,
): string =>
  `This registration requests ${packageReference}, while the current Oopsware CLI package is ${PRODUCT_IDENTITY.packageVersion}. Oopsware does not resolve package-runner requests during doctor; update the registration with oopsware setup --client ${client.name}, then restart the client.`;

const unavailableStatus = (
  client: SetupClient,
  state: "missing" | "invalid",
  configPath: string = client.configPath,
): ClientRegistrationStatus => ({
  client: client.name,
  config_path: configPath,
  command: [],
  state,
  remediation: remediation(client),
});

/** Entry presence is independent of whether its target can currently be read. */
const clientEvidencePresent = async (
  client: SetupClient,
): Promise<
  Result<boolean, { readonly path: string; readonly detail: string }>
> => {
  let unavailable:
    | { readonly path: string; readonly detail: string }
    | undefined;
  for (const path of clientEvidencePaths(client)) {
    try {
      await lstat(path);
      return ok(true);
    } catch (cause: unknown) {
      if (!isMissing(cause))
        unavailable ??= {
          path,
          detail: `Client configuration evidence at ${path} could not be inspected: ${cause instanceof Error ? cause.message : String(cause)}. Check file permissions and rerun oopsware doctor.`,
        };
    }
  }
  return unavailable === undefined ? ok(false) : err(unavailable);
};

const isMissing = (cause: unknown): boolean =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";
