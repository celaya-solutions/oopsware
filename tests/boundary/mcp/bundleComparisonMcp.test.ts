import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { ok as resultOk } from "../../../src/domain/result.js";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { compareEvidenceBundlesCommand } from "../../../src/application/EvidenceBundleCommands.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import {
  bundleComparisonInputSchema,
  bundleComparisonResultSchema,
} from "../../../src/domain/bundleComparison.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import {
  createEvidenceBundle,
  serializeEvidenceBundle,
} from "../../../src/domain/evidenceBundle.js";
import { createServer } from "../../../src/server/createServer.js";
import { observed } from "../../fixtures/analysisExecution.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const sourceEvidence = (label: string) =>
  createEvidence(
    undefined,
    { id: "fixture", name: "Fixture", version: "1" },
    {
      operation: "observe",
      parameters: { label },
      result: { label },
      confidence: "observed",
      authority: "shipped-artifact",
    },
  );

describe("bundle comparison MCP semantic status", () => {
  it("keeps display-only metadata out of deltas and preserves semantic changes", async () => {
    const root = await createTestTempDirectory("rea-bundle-metadata-mcp-");
    roots.push(root);
    const leftPath = join(root, "left.json");
    const displayPath = join(root, "display.json");
    const changedPath = join(root, "changed.json");
    const target = {
      path: join(root, "left.elf"),
      sha256: "a".repeat(64),
      format: "elf" as const,
      architecture: "x86_64" as const,
    };
    const record = createEvidence(
      target,
      { id: "fixture", name: "Fixture", version: "1" },
      {
        operation: "observe",
        parameters: {},
        result: { observed: true },
        confidence: "observed",
        authority: "shipped-artifact",
      },
    );
    const left = createEvidenceBundle([record]);
    const displayRecord = {
      ...record,
      subject: {
        ...record.subject!,
        name: "renamed.elf",
        local_path: join(root, "renamed.elf"),
      },
    };
    const displayOnly = { ...left, records: [displayRecord] };
    const changedRecord = createEvidence(
      target,
      { id: "fixture", name: "Fixture", version: "1" },
      {
        operation: "observe",
        parameters: {},
        result: { observed: false },
        confidence: "observed",
        authority: "shipped-artifact",
      },
    );
    await Promise.all([
      writeFile(leftPath, serializeEvidenceBundle(left)),
      writeFile(displayPath, serializeEvidenceBundle(displayOnly)),
      writeFile(
        changedPath,
        serializeEvidenceBundle(createEvidenceBundle([changedRecord])),
      ),
    ]);
    const connected = await connect();
    try {
      const compare = async (
        right: string,
        recordPairs: readonly {
          left_evidence_id: string;
          right_evidence_id: string;
        }[] = [],
      ) => {
        const result = await connected.client.callTool({
          name: "compare_bundles",
          arguments: {
            left_bundle_path: leftPath,
            right_bundle_path: right,
            record_pairs: recordPairs,
          },
        });
        expect(result.isError).not.toBe(true);
        const evidence = toolContract("compare_bundles").outputSchema.parse(
          result.structuredContent,
        );
        return bundleComparisonResultSchema.parse(evidence.normalized_result);
      };
      const same = await compare(leftPath);
      expect(same).toMatchObject({
        status: "unchanged",
        changes: [],
      });
      const display = await compare(displayPath);
      expect(display).toMatchObject({
        status: "unchanged",
        changes: [],
      });
      expect(display.left_bundle_sha256).not.toBe(display.right_bundle_sha256);
      const changed = await compare(changedPath, [
        {
          left_evidence_id: record.evidence_id,
          right_evidence_id: changedRecord.evidence_id,
        },
      ]);
      expect(changed.status).toBe("changed");
      expect(changed.changes).toHaveLength(1);
    } finally {
      await connected.close();
    }
  });
});

it("requires absolute bundle paths without changing server-cwd semantics", async () => {
  const root = await createTestTempDirectory("rea-bundle-relative-mcp-");
  roots.push(root);
  const encoded = serializeEvidenceBundle(createEvidenceBundle([]));
  await Promise.all([
    writeFile(join(root, "left.json"), encoded),
    writeFile(join(root, "right.json"), encoded),
  ]);
  const connected = await connect();
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
  try {
    const compare = (leftPath: string, rightPath: string) =>
      connected.client.callTool({
        name: "compare_bundles",
        arguments: {
          left_bundle_path: leftPath,
          right_bundle_path: rightPath,
        },
      });
    const relativeCases = [
      ["left.json", "right.json", "left_bundle_path"],
      ["left.json", join(root, "right.json"), "left_bundle_path"],
      [join(root, "left.json"), "right.json", "right_bundle_path"],
    ] as const;
    for (const [leftPath, rightPath, rejectedField] of relativeCases) {
      const result = await compare(leftPath, rightPath);
      expect(result.isError).toBe(true);
      expect(result.content[0]).toMatchObject({
        text: expect.stringContaining(
          `${rejectedField}: must be an absolute local filesystem path`,
        ),
      });
    }
    expect(
      bundleComparisonInputSchema.parse({
        left_bundle_path: "left.json",
        right_bundle_path: "right.json",
      }),
    ).toMatchObject({
      left_bundle_path: "left.json",
      right_bundle_path: "right.json",
    });
    const cliCommand = await compareEvidenceBundlesCommand({
      leftPath: "left.json",
      rightPath: "right.json",
    });
    expect(cliCommand).toMatchObject({
      ok: true,
      value: { status: "unchanged" },
    });
    const listed = await connected.client.listTools();
    const comparisonTool = listed.tools.find(
      ({ name }) => name === "compare_bundles",
    );
    if (comparisonTool === undefined)
      throw new Error("Expected the compare_bundles MCP contract");
    const validate = new Ajv2020({
      strict: false,
      validateFormats: false,
    }).compile(comparisonTool.inputSchema);
    const absolutePaths = {
      left_bundle_path: join(root, "left.json"),
      right_bundle_path: join(root, "right.json"),
    };
    expect(validate(absolutePaths)).toBe(true);
    expect(validate({ ...absolutePaths, left_bundle_path: "left.json" })).toBe(
      false,
    );
    expect(validate({ ...absolutePaths, left_bundle_path: "" })).toBe(false);
    expect(
      validate({
        ...absolutePaths,
        left_bundle_path: `${absolutePaths.left_bundle_path}\0suffix`,
      }),
    ).toBe(false);
    const relativeImport = await connected.client.callTool({
      name: "import_evidence_bundle",
      arguments: { path: "left.json" },
    });
    expect(relativeImport.isError).toBe(true);
    expect(relativeImport.content[0]).toMatchObject({
      text: expect.stringContaining("absolute local filesystem path"),
    });
    const importTool = listed.tools.find(
      ({ name }) => name === "import_evidence_bundle",
    );
    if (importTool === undefined)
      throw new Error("Expected the import_evidence_bundle MCP contract");
    const validateImport = new Ajv2020({
      strict: false,
      validateFormats: false,
    }).compile(importTool.inputSchema);
    expect(validateImport({ path: absolutePaths.left_bundle_path })).toBe(true);
    expect(validateImport({ path: "left.json" })).toBe(false);
    expect(
      validateImport({ path: `${absolutePaths.left_bundle_path}\0` }),
    ).toBe(false);
    const absolute = await compare(
      join(root, "left.json"),
      join(root, "right.json"),
    );
    expect(absolute.isError).not.toBe(true);
    expect(absolute.structuredContent).toMatchObject({
      normalized_result: { status: "unchanged" },
    });
  } finally {
    await connected.close();
    cwd.mockRestore();
  }
});

describe("bundle comparison MCP integration", () => {
  it("reads caller-selected bundle files and returns complete Evidence", async () => {
    const root = await createTestTempDirectory("rea-bundle-mcp-");
    roots.push(root);
    const leftPath = join(root, "left.json");
    const rightPath = join(root, "right.json");
    const leftRecord = sourceEvidence("left");
    const rightRecord = sourceEvidence("right");
    await Promise.all([
      writeFile(
        leftPath,
        serializeEvidenceBundle(createEvidenceBundle([leftRecord])),
      ),
      writeFile(
        rightPath,
        serializeEvidenceBundle(createEvidenceBundle([rightRecord])),
      ),
    ]);
    const connected = await connect();
    try {
      const result = await connected.client.callTool({
        name: "compare_bundles",
        arguments: {
          left_bundle_path: leftPath,
          right_bundle_path: rightPath,
          record_pairs: [
            {
              left_evidence_id: leftRecord.evidence_id,
              right_evidence_id: rightRecord.evidence_id,
            },
          ],
        },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        normalized_result: { status: "changed" },
        evidence_id: expect.stringMatching(/^ev_[a-f0-9]{64}$/u),
      });
    } finally {
      await connected.close();
    }
  });

  it("reads a bundle path outside any configured roots", async () => {
    const root = await createTestTempDirectory("rea-bundle-root-");
    const outside = await createTestTempDirectory("rea-bundle-outside-");
    roots.push(root, outside);
    const leftPath = join(root, "left.json");
    const rightPath = join(outside, "right.json");
    const encoded = serializeEvidenceBundle(createEvidenceBundle([]));
    await Promise.all([
      writeFile(leftPath, encoded),
      writeFile(rightPath, encoded),
    ]);
    const connected = await connect();
    try {
      const result = await connected.client.callTool({
        name: "compare_bundles",
        arguments: {
          left_bundle_path: leftPath,
          right_bundle_path: rightPath,
        },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        normalized_result: { status: "unchanged" },
      });
    } finally {
      await connected.close();
    }
  });

  it("explains that a single Evidence record is not a bundle", async () => {
    const root = await createTestTempDirectory("rea-bundle-record-");
    roots.push(root);
    const record = sourceEvidence("single");
    const recordPath = join(root, "record.json");
    const bundlePath = join(root, "bundle.json");
    await Promise.all([
      writeFile(recordPath, JSON.stringify(record)),
      writeFile(
        bundlePath,
        serializeEvidenceBundle(createEvidenceBundle([record])),
      ),
    ]);
    const connected = await connect();
    try {
      const result = await connected.client.callTool({
        name: "compare_bundles",
        arguments: {
          left_bundle_path: recordPath,
          right_bundle_path: bundlePath,
        },
      });
      expect(result.isError).toBe(true);
      expect(parseMcpToolError(result)).toMatchObject({
        error: {
          code: "invalid_request",
          category: "invalid_input",
          details: { path: recordPath },
          message: expect.stringContaining(
            `this JSON is one Evidence record (${record.evidence_id})`,
          ),
        },
      });
    } finally {
      await connected.close();
    }
  });
});

const connect = async () => {
  const session = createTestBinarySession(() => ({
    health: () => Promise.resolve(),
    execute: () => Promise.resolve(observed(null)),
    close: () => Promise.resolve(resultOk(null)),
  }));
  const server = createServer({ kind: "session", session });
  const client = new Client({ name: "bundle-comparison-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await Promise.allSettled([
        client.close(),
        server.close(),
        session.close(),
      ]);
    },
  };
};
