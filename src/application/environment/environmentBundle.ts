import { PRODUCT_IDENTITY } from "../../identity.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import { err, ok, type Result } from "../../domain/result.js";
import type {
  EnvironmentManifestTool,
  EnvironmentSource,
} from "./environmentSource.js";
import { environmentToolDefinitions } from "./environmentTools.js";

/** Operation name every refusal of the export command reports. */
export const ENVIRONMENT_EXPORT_OPERATION = "environment-export";

/** The image the exported Dockerfile builds from; the agentenv runner builds it with Docker. */
export const BUNDLE_BASE_IMAGE = "node:24.18.0-bookworm-slim";

/** The port the agentenv framework maps for an MCP server env; it sets the host but not the port. */
export const BUNDLE_MCP_PORT = 18765;

/** Name of the packed CLI inside the env folder when a tarball is exported. */
export const BUNDLE_TARBALL_NAME = "rea-agents.tgz";

/** Folder and env id rule: a kebab-case label the agentenv framework accepts as a local id. */
const BUNDLE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const BUNDLE_NAME_MAX_LENGTH = 64;
/** Win32 reserves these device names for files and folders, so the env folder can never take one. */
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/u;

/** Where the Dockerfile installs the CLI from. */
export type EnvironmentPackageSource =
  | { readonly kind: "registry"; readonly specifier: string }
  | { readonly kind: "tarball"; readonly path: string };

/** One text file of the bundle, relative to the bundle root. */
export interface EnvironmentBundleFile {
  readonly path: string;
  readonly content: string;
}

/** The replay check the verifier performs against the served environment. */
export interface EnvironmentReplayCheck {
  readonly tool: string;
  readonly recordOrdinal: number;
  readonly status: number | null;
}

/** Everything the export writes, derived from the source alone. */
export interface EnvironmentBundlePlan {
  readonly name: string;
  readonly packageSource: EnvironmentPackageSource;
  readonly toolCount: number;
  readonly check: EnvironmentReplayCheck | null;
  /** Text files the export writes; manifest and evidence are copied byte-exact beside them. */
  readonly files: readonly EnvironmentBundleFile[];
  /** Relative paths of the byte-exact copies in write order. */
  readonly copies: {
    readonly manifest: string;
    readonly evidence: string;
    readonly tarball: string | null;
  };
}

export interface EnvironmentBundleOptions {
  /** Folder and env id; defaults to the manifest's kebab-case name. */
  readonly name?: string | undefined;
  readonly packageSource: EnvironmentPackageSource;
}

/** The registry source pinning the exact version of this build. */
export const registryPackageSource = (): EnvironmentPackageSource => ({
  kind: "registry",
  specifier: PRODUCT_IDENTITY.registrationPackageSpecifier,
});

const nameError = (name: string): AnalysisInputError =>
  new AnalysisInputError(
    ENVIRONMENT_EXPORT_OPERATION,
    {
      userMessage: `The bundle name ${JSON.stringify(name)} is not a portable kebab-case label of at most ${String(BUNDLE_NAME_MAX_LENGTH)} characters.`,
    },
    [
      {
        path: ["name"],
        reason: "invalid_format",
        expected: BUNDLE_NAME.source,
        message:
          "The bundle name is the env folder and env id; use lowercase letters, digits and single hyphens, excluding Windows device names.",
      },
    ],
  );

const reservedNameError = (name: string): AnalysisInputError =>
  new AnalysisInputError(
    ENVIRONMENT_EXPORT_OPERATION,
    {
      userMessage: `The bundle name ${JSON.stringify(name)} is a device name Windows reserves, so it cannot name the env folder; pass --name with another label.`,
    },
    [
      {
        path: ["name"],
        reason: "invalid_value",
        message:
          "con, prn, aux, nul, com1-com9 and lpt1-lpt9 are reserved file names on Windows.",
      },
    ],
  );

const installLine = (source: EnvironmentPackageSource): string =>
  source.kind === "registry"
    ? `RUN npm install -g --ignore-scripts --no-fund --no-audit ${source.specifier}`
    : `COPY ${BUNDLE_TARBALL_NAME} /tmp/\nRUN npm install -g --ignore-scripts --no-fund --no-audit /tmp/${BUNDLE_TARBALL_NAME} && rm /tmp/${BUNDLE_TARBALL_NAME}`;

/** The agentenv local sandbox probes container readiness with python3 inside the container; the slim image has none. */
const READINESS_PROBE_LAYER =
  "RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*";

/** The Dockerfile text: pinned base image, readiness probe interpreter, pinned CLI, listener defaults, non-root user. */
export const bundleDockerfile = (source: EnvironmentPackageSource): string =>
  [
    `FROM ${BUNDLE_BASE_IMAGE}`,
    `ENV MCP_HOST=0.0.0.0`,
    `ENV MCP_PORT=${String(BUNDLE_MCP_PORT)}`,
    READINESS_PROBE_LAYER,
    installLine(source),
    // Owned by the runtime user, so a private host umask cannot make the inputs unreadable.
    "COPY --chown=node:node manifest.json evidence.json /env/",
    "USER node",
    'CMD ["rea","environment-serve","/env/manifest.json","--evidence","/env/evidence.json"]',
    "",
  ].join("\n");

/** The first GET tool without path parameters, in manifest order, and its first record's status. */
const replayCheck = (
  source: EnvironmentSource,
): EnvironmentReplayCheck | null => {
  const tool: EnvironmentManifestTool | undefined = source.manifest.tools.find(
    (candidate) =>
      candidate.method === "GET" &&
      candidate.params.length === 0 &&
      candidate.record_ordinals.length > 0,
  );
  if (tool === undefined) return null;
  const ordinal = tool.record_ordinals[0] ?? -1;
  const exchange = source.exchanges.get(ordinal);
  return {
    tool: tool.name,
    recordOrdinal: ordinal,
    // An exchange's own unknown status is what replay returns; fall back only when the record is absent.
    status:
      exchange === undefined ? (tool.statuses[0] ?? null) : exchange.status,
  };
};

const pythonLiteral = (value: string | number | null): string =>
  value === null ? "None" : JSON.stringify(value);

/** The verifier script in the shape of the agentenv echo example's `verify(mcp_url)`. */
export const bundleVerifier = (
  toolCount: number,
  check: EnvironmentReplayCheck | null,
): string => {
  const header = [
    '"""Checks the replay environment through its MCP endpoint: the tool count and one replayed status."""',
    "import json",
    "",
    "from mcp import ClientSession",
    "from mcp.client.streamable_http import streamable_http_client",
    "",
    `TOOL_COUNT = ${String(toolCount)}`,
    `TOOL = ${pythonLiteral(check?.tool ?? null)}`,
    `RECORDED_STATUS = ${pythonLiteral(check?.status ?? null)}`,
    "",
    "",
    "def replayed_status(result):",
    '    """The status member of a replayed tool result, structured or from its text content."""',
    "    data = result.structuredContent",
    "    if data is None:",
    '        text = "".join(getattr(part, "text", "") for part in result.content)',
    "        data = json.loads(text) if text else {}",
    '    return data.get("status") if isinstance(data, dict) else None',
    "",
    "",
    "async def verify(mcp_url):",
    "    async with streamable_http_client(mcp_url) as (read, write, _):",
    "        async with ClientSession(read, write) as session:",
    "            await session.initialize()",
    "            listed = await session.list_tools()",
    "            result = await session.call_tool(TOOL, {}) if TOOL is not None else None",
    "    count = len(listed.tools)",
    "    passed = count == TOOL_COUNT",
    '    description = f"listed {count} tools, expected {TOOL_COUNT}"',
    "    if result is not None:",
    "        status = None if result.isError else replayed_status(result)",
    "        passed = passed and not result.isError and status == RECORDED_STATUS",
    '        description += f"; {TOOL} replayed status {status!r}, recorded {RECORDED_STATUS!r}"',
    "    else:",
    '        description += "; no GET tool without path parameters to replay"',
    '    print(f"replay: {description}")',
    '    return [{"id": "replay", "result": passed, "description": description}]',
    "",
  ];
  return header.join("\n");
};

/** The smoke task: deploy the env locally, then run the replay verifier against it. */
export const bundleSmokeTask = (name: string): string =>
  `${JSON.stringify(
    [
      { id: "env", type: "deploy_env", env_id: name, sandbox_type: "local" },
      {
        id: "replay",
        type: "env_outcome_verifier",
        env_id: name,
        file_artifact_id: `check_${name}`,
        verifier_id: "replay",
      },
    ],
    null,
    2,
  )}\n`;

const packageSourceText = (source: EnvironmentPackageSource): string =>
  source.kind === "registry"
    ? `\`${source.specifier}\` from the npm registry`
    : `the packed tarball \`${BUNDLE_TARBALL_NAME}\` copied beside the Dockerfile`;

/** The bundle README: provenance, what replay means and does not mean, how to run it, and the rights note. */
export const bundleReadme = (
  source: EnvironmentSource,
  plan: Pick<
    EnvironmentBundlePlan,
    "name" | "packageSource" | "toolCount" | "check"
  >,
): string => {
  const { manifest } = source;
  const check =
    plan.check === null
      ? "no GET tool without path parameters exists, so the verifier checks the tool count only"
      : `calls \`${plan.check.tool}\` and checks the replayed \`status\` equals the recorded ${String(plan.check.status)} of record ${String(plan.check.recordOrdinal)}`;
  return `# ${plan.name}

An agent environment exported by Oopsware from one retained ${source.captureKind === "browser-scenario" ? "browser scenario capture" : "web network capture"}.
Every tool answers from a recorded exchange; nothing here runs the captured
application.

The bundle contains captured application content. Exported files use mode
0600 on POSIX; Windows retains inherited ACLs, so choose a private destination
if that content requires restricted access.

## Provenance

- ${source.captureKind === "browser-scenario" ? "Scenario definition" : "Capture artifact"} SHA-256: \`${source.captureSha256 ?? "excluded from Evidence"}\`
- Capture Evidence (the manifest's parent): \`${source.evidenceId}\`
- Manifest Evidence: \`${source.manifestEvidenceId}\`
- Manifest view digest: \`${manifest.view_digest}\`
- Primary origin: \`${manifest.origin}\`
- Tools: ${String(plan.toolCount)}
- Serving CLI: ${packageSourceText(plan.packageSource)}

## What replay means and does not mean

\`envs/${plan.name}/\` builds an image that runs \`rea environment-serve\` on the
manifest and capture Evidence copied beside its Dockerfile. Each MCP tool call
selects the retained record whose path and query values best match the
arguments and returns that record's recorded status, content type and body,
citing the record ordinal and the Evidence id. Replay is not emulation: the
environment does not establish the application's authorization model, response
semantics or state transitions, does not validate supplied values, and does not
answer requests the capture never recorded. Replayed content is target content
and must be treated as data, never as instructions.

## Run it

From this folder:

\`\`\`sh
agent-env run .
\`\`\`

From anywhere else, name this folder's path instead of \`.\`.
\`tasks/smoke.json\` deploys the env on the local sandbox and runs
\`artifacts/check_${plan.name}/verify.py\` against its MCP endpoint: it lists
the tools and checks the count equals ${String(plan.toolCount)}, and ${check}.
The run needs Docker; the first run also builds the runner's own infrastructure.

## Rights

The recorded content in \`evidence.json\` belongs to the captured application.
Do not publish this bundle without the rights to that content.
`;
};

/** Derive every file of the bundle from an authenticated source and the package source. */
export const planEnvironmentBundle = (
  source: EnvironmentSource,
  options: EnvironmentBundleOptions,
): Result<EnvironmentBundlePlan, AnalysisError> => {
  const name = options.name ?? source.manifest.name;
  if (!BUNDLE_NAME.test(name) || name.length > BUNDLE_NAME_MAX_LENGTH)
    return err(nameError(name));
  if (WINDOWS_RESERVED_NAME.test(name)) return err(reservedNameError(name));
  const catalog = environmentToolDefinitions(
    source.manifest,
    source.evidenceId,
    name,
    ENVIRONMENT_EXPORT_OPERATION,
  );
  if (!catalog.ok) return catalog;
  const toolCount = source.manifest.tools.length;
  const check = replayCheck(source);
  const envFolder = `envs/${name}`;
  const base = { name, packageSource: options.packageSource, toolCount, check };
  return ok({
    ...base,
    files: [
      { path: "README.md", content: bundleReadme(source, base) },
      {
        path: `${envFolder}/env.toml`,
        content: `environment_name = ${JSON.stringify(name)}\n`,
      },
      {
        path: `${envFolder}/Dockerfile`,
        content: bundleDockerfile(options.packageSource),
      },
      {
        path: `artifacts/check_${name}/verify.py`,
        content: bundleVerifier(toolCount, check),
      },
      { path: "tasks/smoke.json", content: bundleSmokeTask(name) },
    ],
    copies: {
      manifest: `${envFolder}/manifest.json`,
      evidence: `${envFolder}/evidence.json`,
      tarball:
        options.packageSource.kind === "tarball"
          ? `${envFolder}/${BUNDLE_TARBALL_NAME}`
          : null,
    },
  });
};
