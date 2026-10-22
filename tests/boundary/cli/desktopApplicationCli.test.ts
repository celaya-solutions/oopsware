import { readEvidenceBundle } from "../../../src/application/EvidenceBundleFiles.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { cliTest } from "../../support/cli/cliFixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { createDesktopApplicationService } from "../../../src/composition/desktop.js";
import { parseEvidence } from "../../../src/domain/evidence.js";

cliTest(
  "shares directory facts and exact retained-field semantics with the public CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-desktop-cli-");
    const installation = join(root, "installation");
    await mkdir(join(installation, "resources"), { recursive: true });
    await writeFile(
      join(installation, "resources/app.asar"),
      "path convention",
    );
    const refused = await cli.run({
      arguments: [
        "inspect-desktop-application",
        join(root, "must-not-be-read"),
        "--detail",
        "summary",
        "--json",
      ],
    });
    expect(refused.exitCode).not.toBe(0);
    expect(refused.json).toMatchObject({
      code: "invalid_request",
      category: "invalid_input",
      details: {
        operation: "inspect_desktop_application",
        issues: [{ path: ["evidence_output"] }],
      },
    });
    const response = await cli.run({
      arguments: ["inspect-desktop-application", installation, "--json"],
    });
    expect(response.exitCode).toBe(0);
    const evidence = parseEvidence(response.json);
    const service = createDesktopApplicationService();
    try {
      const source = await service.inspect({ path: installation });
      if (!source.ok) throw source.error;
      expect(evidence).toEqual(source.value);
    } finally {
      await service.close();
    }
    const query = join(root, "view.json");
    await writeFile(
      query,
      JSON.stringify({
        source: { kind: "inline", evidence },
        view: {
          kind: "desktop-application",
          collection: "candidates",
          families: ["electron"],
          fields: ["family"],
          limit: 1,
        },
      }),
    );
    const page = await cli.run({
      arguments: ["inspect-analysis-view", query, "--json"],
    });
    expect(page.exitCode).toBe(0);
    expect(parseEvidence(page.json).normalized_result).toMatchObject({
      items: [{ candidate_id: expect.any(String), family: "electron" }],
      coverage: { total: 1, exhausted: true },
    });
    const bundlePath = join(root, "complete-evidence.json");
    const compact = await cli.run({
      arguments: [
        "inspect-desktop-application",
        installation,
        "--detail",
        "summary",
        "--evidence_output",
        bundlePath,
        "--json",
      ],
    });
    expect(compact.exitCode).toBe(0);
    expect(compact.json).toMatchObject({
      evidence_bundle: { path: bundlePath, bytes: expect.any(Number) },
      summary: {
        normalized_result: {
          kind: "summary",
          parent_evidence_id: evidence.evidence_id,
        },
      },
    });
    const saved = await readEvidenceBundle(bundlePath);
    if (!saved.ok) throw saved.error;
    expect(saved.value.records).toEqual([evidence]);
    const overwrite = await cli.run({
      arguments: [
        "inspect-desktop-application",
        installation,
        "--detail",
        "summary",
        "--evidence_output",
        bundlePath,
        "--json",
      ],
    });
    expect(overwrite.exitCode).not.toBe(0);
  },
);
