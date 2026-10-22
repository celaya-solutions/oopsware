import { describe, expect, it } from "vitest";

import { environmentServeSource } from "../../../tests/fixtures/environmentServe.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { PACKAGE_METADATA } from "../../generatedPackageMetadata.js";
import {
  BUNDLE_BASE_IMAGE,
  bundleDockerfile,
  planEnvironmentBundle,
  registryPackageSource,
} from "./environmentBundle.js";

const plan = (options: { name?: string; tarball?: string } = {}) => {
  const planned = planEnvironmentBundle(environmentServeSource(), {
    name: options.name,
    packageSource:
      options.tarball === undefined
        ? registryPackageSource()
        : { kind: "tarball", path: options.tarball },
  });
  if (!planned.ok) throw planned.error;
  return planned.value;
};

const file = (planned: ReturnType<typeof plan>, path: string): string => {
  const found = planned.files.find((entry) => entry.path === path);
  if (found === undefined) throw new Error(`Planned file missing: ${path}`);
  return found.content;
};

const PACKAGE_SPEC = `${PACKAGE_METADATA.name}@${PACKAGE_METADATA.version}`;

describe("planEnvironmentBundle", () => {
  it("plans the echo-shaped file set under the manifest name with byte-exact copies beside the Dockerfile", () => {
    const planned = plan();
    expect(planned.name).toBe("grafana-example");
    expect(planned.toolCount).toBe(19);
    expect(planned.files.map((entry) => entry.path)).toEqual([
      "README.md",
      "envs/grafana-example/env.toml",
      "envs/grafana-example/Dockerfile",
      "artifacts/check_grafana-example/verify.py",
      "tasks/smoke.json",
    ]);
    expect(planned.copies).toEqual({
      manifest: "envs/grafana-example/manifest.json",
      evidence: "envs/grafana-example/evidence.json",
      tarball: null,
    });
    expect(file(planned, "envs/grafana-example/env.toml")).toBe(
      'environment_name = "grafana-example"\n',
    );
  });

  it("pins the registry package to this build's exact version in the Dockerfile", () => {
    const dockerfile = file(plan(), "envs/grafana-example/Dockerfile");
    const lines = dockerfile.trimEnd().split("\n");
    expect(lines[0]).toBe(`FROM ${BUNDLE_BASE_IMAGE}`);
    expect(lines).toContain("ENV MCP_HOST=0.0.0.0");
    expect(lines).toContain("ENV MCP_PORT=18765");
    expect(lines).toContain(
      "RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*",
    );
    expect(lines).toContain(
      `RUN npm install -g --ignore-scripts --no-fund --no-audit ${PACKAGE_METADATA.name}@${PACKAGE_METADATA.version}`,
    );
    expect(lines).toContain(
      "COPY --chown=node:node manifest.json evidence.json /env/",
    );
    expect(lines).toContain("USER node");
    expect(lines.at(-1)).toBe(
      'CMD ["rea","environment-serve","/env/manifest.json","--evidence","/env/evidence.json"]',
    );
    expect(dockerfile).not.toContain("rea-agents.tgz");
    expect(dockerfile.indexOf("RUN npm install")).toBeLessThan(
      dockerfile.indexOf("USER node"),
    );
  });

  it("copies and installs the tarball instead of the registry package when one is given", () => {
    const planned = plan({ tarball: "/packed/rea-agents-1.2.3.tgz" });
    expect(planned.copies.tarball).toBe("envs/grafana-example/rea-agents.tgz");
    const dockerfile = file(planned, "envs/grafana-example/Dockerfile");
    expect(dockerfile).toContain("COPY rea-agents.tgz /tmp/\n");
    expect(dockerfile).toContain(
      "RUN npm install -g --ignore-scripts --no-fund --no-audit /tmp/rea-agents.tgz && rm /tmp/rea-agents.tgz\n",
    );
    expect(dockerfile).not.toContain(PACKAGE_SPEC);
    expect(bundleDockerfile(registryPackageSource())).not.toBe(dockerfile);
  });

  it("writes a verifier that checks the tool count and the first parameterless GET tool's recorded status", () => {
    const planned = plan();
    // Manifest tools are name-ordered, so the first parameterless GET is the annotations list.
    expect(planned.check).toEqual({
      tool: "get_annotations",
      recordOrdinal: 25,
      status: 200,
    });
    const verifier = file(planned, "artifacts/check_grafana-example/verify.py");
    expect(verifier).toContain("from mcp import ClientSession");
    expect(verifier).toContain(
      "from mcp.client.streamable_http import streamable_http_client",
    );
    expect(verifier).toContain("async def verify(mcp_url):");
    expect(verifier).toContain("TOOL_COUNT = 19");
    expect(verifier).toContain('TOOL = "get_annotations"');
    expect(verifier).toContain("RECORDED_STATUS = 200");
    expect(verifier).toContain(
      "passed = passed and not result.isError and status == RECORDED_STATUS",
    );
    expect(verifier).toContain("await session.list_tools()");
    expect(verifier).toContain("await session.call_tool(TOOL, {})");
    expect(verifier).toContain(
      'return [{"id": "replay", "result": passed, "description": description}]',
    );
  });

  it("writes the smoke task deploying the env locally before the replay verifier", () => {
    expect(JSON.parse(file(plan(), "tasks/smoke.json"))).toEqual([
      {
        id: "env",
        type: "deploy_env",
        env_id: "grafana-example",
        sandbox_type: "local",
      },
      {
        id: "replay",
        type: "env_outcome_verifier",
        env_id: "grafana-example",
        file_artifact_id: "check_grafana-example",
        verifier_id: "replay",
      },
    ]);
  });

  it("records provenance, replay limits, the run command and the rights note in the README", () => {
    const source = environmentServeSource();
    const readme = file(plan(), "README.md");
    expect(readme).toContain(
      `- Capture Evidence (the manifest's parent): \`${source.evidenceId}\``,
    );
    expect(readme).toContain(
      `- Manifest Evidence: \`${source.manifestEvidenceId}\``,
    );
    expect(readme).toContain(
      `- Manifest view digest: \`${source.manifest.view_digest}\``,
    );
    expect(readme).toContain(
      `- Capture artifact SHA-256: \`${source.captureSha256 ?? ""}\``,
    );
    expect(readme).toContain("- Tools: 19");
    expect(readme).toContain(PACKAGE_SPEC);
    expect(readme).toContain("```sh\nagent-env run .\n```");
    expect(readme).not.toContain("agent-env run grafana-example");
    expect(readme).toContain("Replay is not emulation");
    expect(readme).toContain("belongs to the captured application");
    expect(readme).toContain("Do not publish this bundle without the rights");
    expect(readme).toContain("calls `get_annotations`");
  });

  it("accepts a kebab-case name override and refuses any other name as invalid input", () => {
    const renamed = plan({ name: "replay-2" });
    expect(renamed.files.map((entry) => entry.path)).toContain(
      "envs/replay-2/Dockerfile",
    );
    expect(file(renamed, "envs/replay-2/env.toml")).toBe(
      'environment_name = "replay-2"\n',
    );
    expect(JSON.parse(file(renamed, "tasks/smoke.json"))[1]).toMatchObject({
      env_id: "replay-2",
      file_artifact_id: "check_replay-2",
    });
    for (const name of ["Grafana", "a_b", "-a", "a--b", "", "a".repeat(65)]) {
      const refused = planEnvironmentBundle(environmentServeSource(), {
        name,
        packageSource: registryPackageSource(),
      });
      if (refused.ok) throw new Error(`Expected ${name} to be refused`);
      expect(projectAnalysisError(refused.error)).toMatchObject({
        code: "invalid_request",
        details: {
          operation: "environment-export",
          issues: [{ path: ["name"], reason: "invalid_format" }],
        },
      });
    }
  });
});

describe("planEnvironmentBundle portable names", () => {
  it("refuses device names Windows reserves for files and folders, before planning any file", () => {
    for (const name of [
      "con",
      "prn",
      "aux",
      "nul",
      "com1",
      "com9",
      "lpt1",
      "lpt9",
    ]) {
      const refused = planEnvironmentBundle(environmentServeSource(), {
        name,
        packageSource: registryPackageSource(),
      });
      if (refused.ok) throw new Error(`Expected ${name} to be refused`);
      expect(projectAnalysisError(refused.error)).toMatchObject({
        code: "invalid_request",
        details: {
          operation: "environment-export",
          issues: [{ path: ["name"], reason: "invalid_value" }],
        },
      });
    }
    for (const name of ["console", "com10", "nul-check"])
      expect(
        planEnvironmentBundle(environmentServeSource(), {
          name,
          packageSource: registryPackageSource(),
        }).ok,
      ).toBe(true);
  });
});

describe("planEnvironmentBundle replay check", () => {
  it("keeps the first record's unknown status instead of borrowing another record's", () => {
    const source = environmentServeSource();
    const first = source.exchanges.get(25);
    if (first === undefined) throw new Error("Fixture lacks record 25");
    const exchanges = new Map(source.exchanges);
    exchanges.set(25, { ...first, status: null });
    const planned = planEnvironmentBundle(
      { ...source, exchanges },
      { packageSource: registryPackageSource() },
    );
    if (!planned.ok) throw planned.error;
    expect(planned.value.check).toMatchObject({
      recordOrdinal: 25,
      status: null,
    });
    expect(
      file(planned.value, "artifacts/check_grafana-example/verify.py"),
    ).toContain("RECORDED_STATUS = None");
  });
});

it("refuses a bundle that the replay server cannot admit, using export operation context", () => {
  const source = environmentServeSource();
  const tool = source.manifest.tools[0]!;
  const manifest = {
    ...source.manifest,
    tools: [
      {
        ...tool,
        query_parameter_names: Array.from(
          { length: 10000 },
          (_, index) => `q_${index}`,
        ),
      },
    ],
  };
  const result = planEnvironmentBundle(
    { ...source, manifest },
    { packageSource: registryPackageSource() },
  );
  expect(result).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisResourceConstraintError",
      operation: "environment-export",
      resource: "capacity",
      retryable: false,
    },
  });
});
