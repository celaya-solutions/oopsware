import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createEvidence, parseEvidence } from "../../../src/domain/evidence.js";
import { jsonValueSchema } from "../../../src/domain/jsonValue.js";
import { artifactInventoryResultSchema } from "../../../src/domain/artifactGraph.js";
import { ok as resultOk } from "../../../src/domain/result.js";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createPackageWithOptions } from "@electron/asar";
import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { expect, it } from "vitest";
import { z } from "zod";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  createArchiveSourceTree,
  produceGzip,
  produceTar,
} from "../../fixtures/archiveProducers.js";
import {
  createSingleEntryZip,
  rewriteSingleEntryZipName,
} from "../../fixtures/zipNames.js";

import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { ArtifactProvider } from "../../../src/artifacts/ArtifactProvider.js";
import { ARTIFACT_COMPARISON_EXAMPLE } from "../../../src/contracts/artifactComparisonExample.js";
import { createServer } from "../../../src/server/createServer.js";
import { observed } from "../../fixtures/analysisExecution.js";

const integrityMessage = (unpacked: boolean): string =>
  `${
    unpacked
      ? "Declared ASAR integrity for unpacked entry main.js contradicts its companion file; packaging tools commonly sign or strip unpacked native binaries after writing the archive."
      : "Artifact bytes contradict declared integrity."
  } If expected, rerun inspect_artifact with integrity_policy=record-and-continue (CLI: --integrity-policy record-and-continue) to retain observed bytes as untrusted; otherwise get a fresh copy.`;

it.each([
  { unpacked: false, label: "embedded" },
  { unpacked: true, label: "unpacked" },
])(
  "returns actionable local details for an $label ASAR integrity error",
  async ({ unpacked }) => {
    const root = await createTestTempDirectory("rea-asar-integrity-mcp-");
    const source = join(root, "source");
    const original = "console.log('ok');\n";
    const changed = "console.log('no');\n";
    await mkdir(source);
    await writeFile(join(source, "main.js"), original);
    const archive = join(root, "fixture.asar");
    await createPackageWithOptions(
      source,
      archive,
      unpacked ? { unpack: "*.js" } : {},
    );
    if (unpacked) {
      await writeFile(join(`${archive}.unpacked`, "main.js"), changed);
    } else {
      const bytes = await readFile(archive);
      const contentOffset = bytes.indexOf(original);
      expect(contentOffset).toBeGreaterThanOrEqual(0);
      bytes.write(changed, contentOffset, "utf8");
      await writeFile(archive, bytes);
    }

    const session = createTestBinarySession(new ArtifactProvider(process.env));
    const server = createServer({ kind: "session", session });
    const client = new Client({ name: "asar-integrity-test", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const opened = await client.callTool({
        name: "open_binary",
        arguments: { path: archive },
      });
      expect(opened.isError).not.toBe(true);

      const result = await client.callTool({
        name: "inspect_artifact",
        arguments: {},
      });
      expect(result.isError).toBe(true);
      expect(parseMcpToolError(result)).toEqual({
        error: {
          code: "artifact_integrity_mismatch",
          category: "integrity_mismatch",
          message: integrityMessage(unpacked),
          details: {
            logical_path: "main.js",
            declared_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
            calculated_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
            unpacked,
          },
          retryable: false,
          remediation: { action: integrityMessage(unpacked) },
        },
      });
    } finally {
      await Promise.allSettled([
        client.close(),
        server.close(),
        session.close(),
      ]);
    }
  },
  20_000,
);

it("extracts an active archive through MCP when requested", async () => {
  const root = await createTestTempDirectory("rea-artifact-extract-mcp-");
  const archive = join(root, "fixture.zip");
  const zip = new ZipWriter(new Uint8ArrayWriter());
  await zip.add("main.js", new TextReader("console.log('extract');\n"));
  await writeFile(archive, await zip.close());

  const session = createTestBinarySession(new ArtifactProvider(process.env));
  const server = createServer({ kind: "session", session });
  const client = new Client({ name: "artifact-extract-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  let outputRoot: string | undefined;
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const opened = await client.callTool({
      name: "open_binary",
      arguments: { path: archive },
    });
    expect(opened.isError).not.toBe(true);

    const result = await client.callTool({
      name: "extract_artifact",
      arguments: {},
    });
    expect(result.isError).not.toBe(true);
    const normalized = z
      .object({ output_root: z.string(), artifacts: z.array(z.unknown()) })
      .parse(toolEvidence(result.structuredContent).normalized_result);
    outputRoot = normalized.output_root;
    expect(await readFile(join(outputRoot, "main.js"), "utf8")).toBe(
      "console.log('extract');\n",
    );
    expect(normalized.artifacts).toHaveLength(1);
  } finally {
    await Promise.allSettled([client.close(), server.close(), session.close()]);
    if (outputRoot !== undefined)
      await rm(outputRoot, { recursive: true, force: true });
  }
});

it("inventories and extracts a real tar.gz through MCP", async () => {
  const root = await createTestTempDirectory("rea-artifact-tgz-mcp-");
  const source = join(root, "source");
  await mkdir(source);
  const { files } = await createArchiveSourceTree(source);
  const tar = join(root, "bundle.tar");
  await produceTar(source, tar, ["a.txt", "dir", "tool.sh"], "ustar");
  const archive = await produceGzip(tar);

  const session = createTestBinarySession(new ArtifactProvider(process.env));
  const server = createServer({ kind: "session", session });
  const client = new Client({ name: "artifact-tgz-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  let outputRoot: string | undefined;
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const opened = await client.callTool({
      name: "open_binary",
      arguments: { path: archive },
    });
    expect(opened.isError).not.toBe(true);

    const inspected = await client.callTool({
      name: "inspect_artifact",
      arguments: {},
    });
    expect(inspected.isError).not.toBe(true);
    const substep = z
      .object({ substeps: z.array(z.object({ evidence: z.unknown() })) })
      .parse(toolEvidence(inspected.structuredContent).normalized_result)
      .substeps[0]?.evidence;
    const inventory = z
      .object({
        normalized_result: z.object({
          manifest: z.object({ root_format: z.string() }),
          occurrences: z.array(z.object({ logical_path: z.string() })),
          limitations: z.array(z.string()),
        }),
      })
      .parse(substep).normalized_result;
    expect(inventory.manifest.root_format).toBe("gzip");
    expect(
      inventory.occurrences.map(({ logical_path }) => logical_path).sort(),
    ).toEqual([".", "a.txt", "dir", "dir/b.txt", "tool.sh"]);
    expect(inventory.limitations.join(" ")).toMatch(/Gzip input was decoded/u);

    const result = await client.callTool({
      name: "extract_artifact",
      arguments: {},
    });
    expect(result.isError).not.toBe(true);
    const normalized = z
      .object({ output_root: z.string(), artifacts: z.array(z.unknown()) })
      .parse(toolEvidence(result.structuredContent).normalized_result);
    outputRoot = normalized.output_root;
    expect(normalized.artifacts).toHaveLength(3);
    for (const name of ["a.txt", "dir/b.txt", "tool.sh"])
      expect(await readFile(join(outputRoot, name), "utf8")).toBe(files[name]);
  } finally {
    await Promise.allSettled([client.close(), server.close(), session.close()]);
    if (outputRoot !== undefined)
      await rm(outputRoot, { recursive: true, force: true });
  }
});

it("preserves raw legacy ZIP name bytes and CP437 path interpretation through MCP", async () => {
  const root = await createTestTempDirectory("rea-legacy-zip-name-mcp-");
  const archive = join(root, "legacy-name.zip");
  const rawName = Buffer.from([0xc7, 0xd1, 0xb1, 0xdb, 0x2e, 0x74, 0x78, 0x74]);
  await writeFile(
    archive,
    rewriteSingleEntryZipName(
      await createSingleEntryZip("name.txt"),
      "name.txt",
      rawName,
      false,
    ),
  );

  const session = createTestBinarySession(new ArtifactProvider(process.env));
  const server = createServer({ kind: "session", session });
  const client = new Client({ name: "legacy-zip-name-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const opened = await client.callTool({
      name: "open_binary",
      arguments: { path: archive },
    });
    expect(opened.isError).not.toBe(true);
    const inspected = await client.callTool({
      name: "inspect_artifact",
      arguments: {},
    });
    expect(inspected.isError).not.toBe(true);
    const result = toolEvidence(inspected.structuredContent);
    const inspection = z
      .object({ substeps: z.array(z.object({ evidence: z.unknown() })) })
      .parse(result.normalized_result);
    const inventory = z
      .object({ normalized_result: artifactInventoryResultSchema })
      .parse(inspection.substeps[0]?.evidence).normalized_result;
    expect(inventory.occurrences).toContainEqual(
      expect.objectContaining({
        logical_path: "╟╤▒█.txt",
        limitations: [
          "ZIP name uses CP437 fallback; source encoding unverified; raw hex: c7d1b1db2e747874.",
        ],
      }),
    );
  } finally {
    await Promise.all([client.close(), server.close(), session.close()]);
  }
});

it("extracts a macOS app bundle through MCP", async () => {
  const root = await createTestTempDirectory("rea-artifact-extract-app-mcp-");
  const contents = join(root, "Fixture.app", "Contents");
  await mkdir(join(contents, "MacOS"), { recursive: true });
  const plist =
    '<?xml version="1.0"?><plist><dict><key>CFBundleExecutable</key><string>Fixture</string></dict></plist>';
  await writeFile(join(contents, "Info.plist"), plist);
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(0x01000007, 4);
  header.writeUInt32LE(3, 8);
  header.writeUInt32LE(2, 12);
  await writeFile(join(contents, "MacOS", "Fixture"), header);

  const session = createTestBinarySession(new ArtifactProvider(process.env));
  const server = createServer({ kind: "session", session });
  const client = new Client({
    name: "artifact-extract-app-test",
    version: "1",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  let outputRoot: string | undefined;
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const opened = await client.callTool({
      name: "open_binary",
      arguments: { path: join(root, "Fixture.app") },
    });
    expect(opened.isError).not.toBe(true);

    const result = await client.callTool({
      name: "extract_artifact",
      arguments: {},
    });
    expect(result.isError).not.toBe(true);
    const normalized = z
      .object({ output_root: z.string() })
      .parse(toolEvidence(result.structuredContent).normalized_result);
    outputRoot = normalized.output_root;
    expect(
      await readFile(join(outputRoot, "Contents", "Info.plist"), "utf8"),
    ).toBe(plist);
  } finally {
    await Promise.allSettled([client.close(), server.close(), session.close()]);
    if (outputRoot !== undefined)
      await rm(outputRoot, { recursive: true, force: true });
  }
});

it("records an explicitly continued mismatch, preserves verified siblings, and never reports equivalence", async () => {
  const root = await createTestTempDirectory("rea-asar-continue-mcp-");
  const source = join(root, "source");
  await mkdir(source);
  const original = "console.log('ok');\n",
    changed = "console.log('no');\n",
    secondOriginal = "console.log('up');\n",
    secondChanged = "console.log('dn');\n";
  await writeFile(join(source, "main.js"), original);
  await writeFile(join(source, "second.js"), secondOriginal);
  await writeFile(join(source, "sibling.js"), "console.log('sibling');\n");
  const archive = join(root, "fixture.asar");
  await createPackageWithOptions(source, archive, {});
  const bytes = await readFile(archive);
  const contentOffset = bytes.indexOf(original);
  const secondOffset = bytes.indexOf(secondOriginal);
  expect(contentOffset).toBeGreaterThanOrEqual(0);
  expect(secondOffset).toBeGreaterThanOrEqual(0);
  bytes.write(changed, contentOffset, "utf8");
  bytes.write(secondChanged, secondOffset, "utf8");
  await writeFile(archive, bytes);

  const session = createTestBinarySession(new ArtifactProvider(process.env));
  const server = createServer({ kind: "session", session });
  const client = new Client({ name: "asar-continue-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await client.callTool({
      name: "open_binary",
      arguments: { path: archive },
    });
    const result = await client.callTool({
      name: "inspect_artifact",
      arguments: {
        integrity_policy: "record-and-continue",
      },
    });
    expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(
      true,
    );
    const compact = toolEvidence(result.structuredContent);
    const evidence = session.evidenceById(compact.evidence_id);
    if (evidence === undefined) throw new Error("missing inventory Evidence");
    const inspection = z
      .object({
        contradictions: z.array(z.unknown()),
        substeps: z.array(
          z.object({
            evidence: z.object({ normalized_result: z.unknown() }),
          }),
        ),
      })
      .parse(compact.normalized_result);
    const inventory = artifactInventoryResultSchema.parse(
      inspection.substeps[0]?.evidence.normalized_result,
    );
    expect(inspection.contradictions).toHaveLength(2);
    expect(inventory.integrity_contradictions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          logical_path: "main.js",
          trust: "observed-untrusted",
          declared_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          observed_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        }),
        expect.objectContaining({ logical_path: "second.js" }),
      ]),
    );
    expect(inventory.integrity_contradictions).toHaveLength(2);
    expect(inventory.occurrences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          logical_path: "main.js",
          hash_status: "mismatched",
        }),
        expect.objectContaining({
          logical_path: "sibling.js",
          hash_status: "verified",
        }),
        expect.objectContaining({
          logical_path: "second.js",
          hash_status: "mismatched",
        }),
      ]),
    );
    const compared = await client.callTool({
      name: "compare_artifacts",
      arguments: {
        left: evidence,
        right: evidence,
      },
    });
    expect(compared.isError).not.toBe(true);
    expect(
      toolEvidence(compared.structuredContent).normalized_result,
    ).toMatchObject({
      status: "contradiction",
      summary: { contradiction: 2 },
      changes: expect.arrayContaining([
        expect.objectContaining({
          logical_path: "main.js",
          classification: "contradiction",
          dimensions: ["integrity"],
        }),
        expect.objectContaining({
          logical_path: "second.js",
          classification: "contradiction",
        }),
      ]),
    });
    const { coverage: _coverage, ...inventoryWithoutCoverage } = inventory;
    const missingCoverage = createEvidence(
      { path: archive, sha256: inventory.manifest.root_sha256, format: "asar" },
      compact.provider,
      {
        operation: "inventory_artifact",
        parameters: {},
        result: jsonValueSchema.parse(inventoryWithoutCoverage),
      },
    );
    const retainedComparison = await client.callTool({
      name: "compare_artifacts",
      arguments: { left: evidence, right: missingCoverage },
    });
    expect(retainedComparison.isError, JSON.stringify(retainedComparison)).toBe(
      true,
    );
  } finally {
    await Promise.allSettled([client.close(), server.close(), session.close()]);
  }
});

it("rejects inline artifact Evidence whose content does not match its ID", async () => {
  const session = createTestBinarySession(() => ({
    health: () => Promise.resolve(),
    execute: () => Promise.resolve(observed(null)),
    close: () => Promise.resolve(resultOk(null)),
  }));
  const server = createServer({ kind: "session", session });
  const client = new Client({
    name: "artifact-authority-test",
    version: "1",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: "compare_artifacts",
      arguments: {
        ...ARTIFACT_COMPARISON_EXAMPLE,
        left: {
          ...ARTIFACT_COMPARISON_EXAMPLE.left,
          limitations: ["caller altered this record"],
        },
      },
    });
    expect(result.isError).toBe(true);
    expect(
      session.evidenceById(ARTIFACT_COMPARISON_EXAMPLE.left.evidence_id),
    ).toBeUndefined();
    expect(
      session.evidenceById(ARTIFACT_COMPARISON_EXAMPLE.right.evidence_id),
    ).toBeUndefined();
  } finally {
    await Promise.allSettled([client.close(), server.close(), session.close()]);
  }
});

it("compares inline inventory Evidence without prior session calls", async () => {
  const session = createTestBinarySession(() => ({
    health: () => Promise.resolve(),
    execute: () => Promise.resolve(observed(null)),
    close: () => Promise.resolve(resultOk(null)),
  }));
  const server = createServer({ kind: "session", session });
  const client = new Client({
    name: "artifact-ownership-test",
    version: "1",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: "compare_artifacts",
      arguments: ARTIFACT_COMPARISON_EXAMPLE,
    });
    expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(
      true,
    );
    expect(
      toolEvidence(result.structuredContent).normalized_result,
    ).toMatchObject({
      status: "changed",
    });
    expect(
      session.evidenceById(ARTIFACT_COMPARISON_EXAMPLE.left.evidence_id),
    ).toBeDefined();
    expect(
      session.evidenceById(ARTIFACT_COMPARISON_EXAMPLE.right.evidence_id),
    ).toBeDefined();
  } finally {
    await Promise.allSettled([client.close(), server.close(), session.close()]);
  }
});

it("returns full artifact graphs inline and compares changed inventories", async () => {
  const directory = await createTestTempDirectory("rea-artifact-mcp-");
  const archive = join(directory, "fixture.ipa");
  const changedArchive = join(directory, "changed.ipa");
  const writer = new ZipWriter(new Uint8ArrayWriter());
  await writer.add("Payload/Fixture.app/main.js", new TextReader("main();"));
  await writeFile(archive, await writer.close());
  const changedWriter = new ZipWriter(new Uint8ArrayWriter());
  await changedWriter.add(
    "Payload/Fixture.app/main.js",
    new TextReader("changed();"),
  );
  await writeFile(changedArchive, await changedWriter.close());
  const session = createTestBinarySession(new ArtifactProvider(process.env));
  const server = createServer({ kind: "session", session });
  const client = new Client({ name: "artifact-mcp-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const opened = await client.callTool({
      name: "open_binary",
      arguments: { path: archive },
    });
    expect(opened.isError).not.toBe(true);
    const inspected = await client.callTool({
      name: "inspect_artifact",
      arguments: {},
    });
    expect(inspected.isError).not.toBe(true);
    const inspectionResult = toolEvidence(inspected.structuredContent);
    const inspectionEvidence = session.evidenceById(
      inspectionResult.evidence_id,
    );
    if (inspectionEvidence === undefined)
      throw new Error("missing inspection Evidence");
    const inspection = z
      .object({
        substeps: z.array(
          z.object({
            evidence_id: z.string(),
            status: z.literal("completed"),
          }),
        ),
        coverage: z.object({
          status: z.literal("complete-within-substeps"),
          substeps_completed: z.literal(1),
        }),
      })
      .parse(inspectionResult.normalized_result);
    expect(inspection.substeps).toHaveLength(1);
    expect(
      session.evidenceById(inspection.substeps[0]?.evidence_id ?? ""),
    ).toMatchObject({ operation: "inventory_artifact" });
    expect(inspectionEvidence.evidence_links).toEqual([
      inspection.substeps[0]?.evidence_id,
    ]);
    const inventory = await client.callTool({
      name: "inspect_artifact",
      arguments: {},
    });
    expect(inventory.isError).not.toBe(true);
    const inventoryResult = toolEvidence(inventory.structuredContent);
    const evidence = session.evidenceById(inventoryResult.evidence_id);
    if (evidence === undefined) throw new Error("missing inventory Evidence");
    expect(evidence).toMatchObject({
      provider: { id: "rea-artifact-graph" },
      subject: { format: "ipa" },
    });
    const inventoryInspection = z
      .object({
        substeps: z.array(z.object({ evidence: z.unknown() })),
      })
      .parse(inventoryResult.normalized_result);
    const inventoryEvidence = z
      .object({
        normalized_result: z.object({
          manifest: z.object({ root_format: z.literal("ipa") }),
          occurrences: z.array(z.object({ logical_path: z.string() })),
        }),
      })
      .parse(inventoryInspection.substeps[0]?.evidence);
    expect(inventoryEvidence.normalized_result.occurrences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          logical_path: "Payload/Fixture.app/main.js",
        }),
      ]),
    );
    const openedChanged = await client.callTool({
      name: "open_binary",
      arguments: { path: changedArchive },
    });
    expect(openedChanged.isError).not.toBe(true);
    const changedInventory = await client.callTool({
      name: "inspect_artifact",
      arguments: {},
    });
    const changedResult = toolEvidence(changedInventory.structuredContent);
    const changedInspection = z
      .object({
        substeps: z.array(z.object({ evidence: z.unknown() })),
      })
      .parse(changedResult.normalized_result);
    const compared = await client.callTool({
      name: "compare_artifacts",
      arguments: {
        left: inventoryInspection.substeps[0]?.evidence,
        right: changedInspection.substeps[0]?.evidence,
      },
    });
    expect(compared.isError).not.toBe(true);
    expect(toolEvidence(compared.structuredContent)).toMatchObject({
      normalized_result: { status: "changed" },
      evidence_id: expect.stringMatching(/^ev_/u),
    });
    const unknowns = await client.callTool({
      name: "list_unknowns",
      arguments: { domain: "artifact-comparison" },
    });
    expect(unknowns.structuredContent).toMatchObject({
      result: {
        items: [
          expect.objectContaining({
            domain: "artifact-comparison",
          }),
        ],
      },
    });
  } finally {
    await Promise.allSettled([client.close(), server.close(), session.close()]);
  }
});

it("compares summary Evidence through retained complete inspection parents", async () => {
  const directory = await createTestTempDirectory("rea-artifact-summary-mcp-");
  const archive = join(directory, "one.zip");
  const changedArchive = join(directory, "two.zip");
  const writer = new ZipWriter(new Uint8ArrayWriter());
  await writer.add("a.txt", new TextReader("same"));
  await writeFile(archive, await writer.close());
  const changedWriter = new ZipWriter(new Uint8ArrayWriter());
  await changedWriter.add("a.txt", new TextReader("same"));
  await changedWriter.add("b.txt", new TextReader("new"));
  await writeFile(changedArchive, await changedWriter.close());

  const session = createTestBinarySession(new ArtifactProvider(process.env));
  const server = createServer({ kind: "session", session });
  const client = new Client({
    name: "artifact-summary-mcp-test",
    version: "1",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const summaries = [];
    for (const path of [archive, changedArchive]) {
      const opened = await client.callTool({
        name: "open_binary",
        arguments: { path },
      });
      expect(opened.isError).not.toBe(true);
      const inspected = await client.callTool({
        name: "inspect_artifact",
        arguments: { detail: "summary" },
      });
      expect(inspected.isError).not.toBe(true);
      summaries.push(toolEvidence(inspected.structuredContent));
    }
    const [left, right] = summaries;
    if (left === undefined || right === undefined)
      throw new Error("missing artifact summary Evidence");
    expect(left.operation).toBe("inspect_analysis_view");
    expect(right.operation).toBe("inspect_analysis_view");
    const compared = await client.callTool({
      name: "compare_artifacts",
      arguments: { left, right },
    });
    expect(compared.isError).not.toBe(true);
    const result = toolEvidence(compared.structuredContent);
    expect(result.normalized_result).toMatchObject({ status: "changed" });
    const leftParentId = z
      .object({ parent_evidence_id: z.string() })
      .parse(left.normalized_result).parent_evidence_id;
    const rightParentId = z
      .object({ parent_evidence_id: z.string() })
      .parse(right.normalized_result).parent_evidence_id;
    expect(result.evidence_links).toEqual([leftParentId, rightParentId]);
  } finally {
    await Promise.allSettled([client.close(), server.close(), session.close()]);
  }
});

const toolEvidence = (value: unknown) => parseEvidence(value);
