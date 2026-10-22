import { desktopSummarySchema } from "../../src/domain/analysisView/desktopApplicationView.js";
import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  realpath,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readEvidenceBundle } from "../../src/application/EvidenceBundleFiles.js";
import { toolContract } from "../../src/contracts/toolContracts.js";
import {
  analysisViewResultSchema,
  il2cppMetadataSummaryViewResultSchema,
} from "../../src/domain/analysisView/analysisView.js";
import { createEvidence, parseEvidence } from "../../src/domain/evidence.js";
import { createEvidenceBundle } from "../../src/domain/evidenceBundle.js";
import { jsonObjectSchema } from "../../src/domain/jsonValue.js";
import { il2cppMetadataSchema } from "../../src/domain/il2cpp/il2cppMetadata.js";
import {
  createIl2cppMetadataFixture,
  FIXTURE_IMAGES,
  FIXTURE_METHODS,
  FIXTURE_TYPES,
} from "../fixtures/il2cpp/metadata.js";
import {
  createElfFixture,
  createIl2cppBinaryFixture,
  createUniversalFixture,
  FIXTURE_BINARY_BASE,
  FIXTURE_METHOD_ADDRESSES,
  FIXTURE_RETURN_TYPE_NAME,
} from "../fixtures/il2cpp/binary.js";
import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import { parseMcpToolError } from "../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

const parseCliMetadata = (value: unknown) =>
  il2cppMetadataSchema.parse(
    toolContract("inspect_il2cpp_metadata").outputSchema.parse(value)
      .normalized_result,
  );
const parseMetadataSummary = (value: unknown) =>
  il2cppMetadataSummaryViewResultSchema.parse(
    parseEvidence(value).normalized_result,
  );

cliTest(
  "returns identical complete inventories through CLI and MCP and pages a retained summary after removal",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-il2cpp-metadata-");
    const path = join(root, "global-metadata.dat");
    const { bytes } = createIl2cppMetadataFixture({
      typeIndexWidth: 2,
      propertiesAndEvents: true,
    });
    await writeFile(path, bytes);
    const result = await cli.run({
      arguments: ["inspect-il2cpp-metadata", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = toolContract("inspect_il2cpp_metadata").outputSchema.parse(
      result.json,
    );
    const report = il2cppMetadataSchema.parse(evidence.normalized_result);
    expect(report.magic).toBe(bytes.readUInt32LE(0));
    expect(report.artifact).toEqual({
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    });
    expect(report.images).toEqual(FIXTURE_IMAGES);
    expect(report.types).toEqual(FIXTURE_TYPES);
    expect(report.methods).toEqual(FIXTURE_METHODS);
    expect(evidence.parameters).toEqual({ path });

    const { client, call } = await connectLocalToolsMcp();
    const complete = await call("inspect_il2cpp_metadata", {
      path,
      detail: "complete",
    });
    expect(complete.isError, JSON.stringify(complete)).not.toBe(true);
    expect(parseEvidence(complete.structuredContent).normalized_result).toEqual(
      report,
    );

    // The default keeps complete Evidence while returning a compact receipt.
    const omitted = await call("inspect_il2cpp_metadata", { path });
    expect(omitted.isError, JSON.stringify(omitted)).not.toBe(true);
    expect(
      parseMetadataSummary(omitted.structuredContent).summary.counts.methods,
    ).toBe(FIXTURE_METHODS.length);
    const summarized = await call("inspect_il2cpp_metadata", {
      path,
      detail: "summary",
    });
    expect(summarized.isError, JSON.stringify(summarized)).not.toBe(true);
    const view = parseMetadataSummary(summarized.structuredContent);
    expect(view.summary.magic).toBe(report.magic);
    expect(view.summary.counts).toEqual({
      sections: 31,
      images: 2,
      types: 4,
      methods: 5,
      nested_types: 1,
      fields: 2,
      properties: 3,
      events: 2,
      parameters: 1,
      string_literals: 2,
      code_gen_modules: null,
      method_addresses: null,
      method_address_states: null,
      return_types: null,
      field_types: null,
      parameter_types: null,
    });
    expect(view.summary).not.toHaveProperty("sections");
    expect(view.summary.binary).toBeNull();
    expect(view.summary.index_widths).toEqual(report.index_widths);

    // Pages come from retained Evidence, not the file.
    await unlink(path);
    for (const collection of [
      "sections",
      "images",
      "types",
      "methods",
      "fields",
      "properties",
      "events",
      "parameters",
      "string_literals",
    ] as const) {
      const rows: unknown[] = [];
      let offset = 0;
      do {
        const page = await call("inspect_analysis_view", {
          source: {
            kind: "retained-evidence",
            evidence_id: view.parent_evidence_id,
          },
          view: { kind: "il2cpp-metadata", collection, offset, limit: 2 },
        });
        expect(page.isError, JSON.stringify(page)).not.toBe(true);
        const projected = analysisViewResultSchema.parse(
          parseEvidence(page.structuredContent).normalized_result,
        );
        if (projected.kind !== "il2cpp-metadata")
          throw new Error("Wrong IL2CPP page kind");
        expect(projected.counts).toEqual(view.summary.counts);
        rows.push(...projected.items);
        offset = projected.coverage.next_offset ?? report[collection].length;
      } while (offset < report[collection].length);
      expect(rows).toEqual(
        report[collection].map((row, index) => ({ index, ...row })),
      );
    }
    await client.ping();
  },
  30000,
);

cliTest(
  "distinguishes unsupported versions from corrupt metadata through CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-il2cpp-metadata-fail-");
    const { client, call } = await connectLocalToolsMcp();
    const fixture = createIl2cppMetadataFixture();
    const unsupported = Buffer.from(fixture.bytes);
    unsupported.writeInt32LE(26, 4);
    const corrupt = Buffer.from(fixture.bytes);
    corrupt.writeInt32LE(
      fixture.section("typeDefinitions").offset + 4,
      fixture.header("images", "offset"),
    );
    for (const [name, bytes, expected] of [
      [
        "v26.dat",
        unsupported,
        {
          code: "unsupported_target",
          details: { operation: "inspect_il2cpp_metadata" },
          message: expect.stringContaining("unsupported-version"),
        },
      ],
      [
        "overlap.dat",
        corrupt,
        {
          code: "invalid_request",
          details: {
            operation: "inspect_il2cpp_metadata",
            issues: [
              {
                path: ["path"],
                reason: "invalid_format",
                message: expect.stringContaining("section-overlap"),
              },
            ],
          },
        },
      ],
    ] as const) {
      const path = join(root, name);
      await writeFile(path, bytes);
      const result = await cli.run({
        arguments: ["inspect-il2cpp-metadata", path, "--json"],
      });
      expect(result.exitCode).toBe(1);
      expect(result.json).toMatchObject(expected);
      const response = await call("inspect_il2cpp_metadata", { path });
      expect(parseMcpToolError(response).error).toMatchObject(expected);
    }
    await client.ping();
  },
  30000,
);

const metadataPageReader =
  (
    call: Awaited<ReturnType<typeof connectLocalToolsMcp>>["call"],
    context: { parentId: string; sha256: string },
  ) =>
  async (view: Record<string, unknown>) => {
    const result = await call("inspect_analysis_view", {
      source: { kind: "retained-evidence", evidence_id: context.parentId },
      view: { kind: "il2cpp-metadata", ...view },
    });
    expect(result.isError).not.toBe(true);
    const evidence = parseEvidence(result.structuredContent);
    expect(evidence.evidence_links).toContain(context.parentId);
    const payload = analysisViewResultSchema.parse(evidence.normalized_result);
    if (payload.kind !== "il2cpp-metadata")
      throw new Error("Wrong collection response");
    expect(payload.artifact.sha256).toBe(context.sha256);
    return payload;
  };

const assertRetainedNativeSelections = async (
  selected: ReturnType<typeof metadataPageReader>,
  binaryPath: string,
  binaryBytes: Buffer,
) => {
  expect(
    await selected({
      collection: "code_gen_modules",
      image_indices: [0],
      fields: ["image"],
      limit: 1,
    }),
  ).toMatchObject({
    items: [{ index: 0, image: 0 }],
    coverage: { total: 1, exhausted: true },
  });
  const native = await selected({
    collection: "method_addresses",
    addresses: ["0x0000000100000200", "0x100000220"],
    states: ["code"],
    fields: ["rva"],
    offset: 1,
    limit: 1,
  });
  expect(native).toMatchObject({
    items: [{ index: 2, rva: "0x220" }],
    binary_source: {
      artifact: {
        path: binaryPath,
        sha256: createHash("sha256").update(binaryBytes).digest("hex"),
      },
    },
    coverage: { total: 2, exhausted: true },
  });
};

it("queries compact retained metadata through the real SDK with exact row identities and fields", async () => {
  const root = await createTestTempDirectory("rea-il2cpp-sdk-selection-");
  const path = join(root, "global-metadata.dat");
  const fixture = createIl2cppMetadataFixture({ version: 31 });
  await writeFile(path, fixture.bytes);
  const binaryPath = join(root, "GameAssembly.dylib");
  const binaryBytes = createIl2cppBinaryFixture();
  await writeFile(binaryPath, binaryBytes);
  const { client, call } = await connectLocalToolsMcp();
  const directory = await call("inspect_desktop_application", { path: root });
  const directoryView = analysisViewResultSchema.parse(
    parseEvidence(directory.structuredContent).normalized_result,
  );
  if (directoryView.kind !== "summary")
    throw new Error("Expected a directory summary");
  const probe = desktopSummarySchema
    .parse(directoryView.summary)
    .next_probe_groups.find(
      (group) => group.operation === "inspect_il2cpp_metadata",
    )?.example;
  if (probe === undefined)
    throw new Error("Missing IL2CPP metadata next operation");
  expect(probe.path).toBe(await realpath(path));
  const response = await call(probe.operation, {
    path: probe.path,
    binary_path: binaryPath,
  });
  expect(response.isError).not.toBe(true);
  const overview = parseMetadataSummary(response.structuredContent);
  expect(overview.summary.counts).toMatchObject({
    sections: 31,
    images: 2,
    types: 4,
    methods: 5,
    nested_types: 1,
  });
  expect(overview.summary).not.toHaveProperty("sections");
  expect(overview.summary).not.toHaveProperty("methods");
  await Promise.all([unlink(path), unlink(binaryPath)]);
  const source = {
    kind: "retained-evidence",
    evidence_id: overview.parent_evidence_id,
  };
  const selected = metadataPageReader(call, {
    parentId: overview.parent_evidence_id,
    sha256: createHash("sha256").update(fixture.bytes).digest("hex"),
  });
  expect(
    (
      await selected({
        collection: "sections",
        names: ["methods"],
        fields: ["count"],
      })
    ).items,
  ).toEqual([{ index: 5, count: null }]);
  expect(
    (
      await selected({
        collection: "types",
        indices: [3, 0, 3, 999],
        fields: ["namespace"],
      })
    ).items,
  ).toEqual([
    { index: 0, namespace: "Game" },
    { index: 3, namespace: "System" },
  ]);
  expect(
    (
      await selected({
        collection: "types",
        image_indices: [0],
        namespaces: ["Game"],
        names: ["Player"],
        fields: ["name"],
      })
    ).items,
  ).toEqual([{ index: 0, name: "Player" }]);
  const methods = {
    collection: "methods",
    declaring_types: [0, 1],
    names: [".ctor", "Add"],
    fields: ["name", "declaring_type"],
  };
  expect((await selected(methods)).items).toEqual([
    { index: 0, name: ".ctor", declaring_type: 0 },
    { index: 2, name: "Add", declaring_type: 1 },
  ]);
  expect(await selected({ ...methods, offset: 1, limit: 1 })).toMatchObject({
    items: [{ index: 2, name: "Add", declaring_type: 1 }],
    coverage: { total: 2, exhausted: true, next_offset: null },
  });
  expect(
    await selected({
      collection: "parameters",
      method_indices: [2, 2, 99],
      fields: ["name", "method"],
    }),
  ).toMatchObject({
    items: [{ index: 0, name: "amount", method: 2 }],
    coverage: { total: 1, exhausted: true },
  });
  expect(
    await selected({
      collection: "parameters",
      method_indices: [],
      fields: [],
    }),
  ).toMatchObject({ items: [], coverage: { total: 0, exhausted: true } });
  expect(
    (await selected({ collection: "methods", indices: [2, 0], fields: [] }))
      .items,
  ).toEqual([{ index: 0 }, { index: 2 }]);
  expect(await selected({ collection: "types", indices: [] })).toMatchObject({
    items: [],
    coverage: { total: 0, exhausted: true },
  });
  await assertRetainedNativeSelections(selected, binaryPath, binaryBytes);
  const invalid = await call("inspect_analysis_view", {
    source,
    view: {
      kind: "il2cpp-metadata",
      collection: "methods",
      fields: ["namespace"],
    },
  });
  expect(parseMcpToolError(invalid).error.code).toBe("invalid_request");
  await client.ping();
}, 30000);

it("imports historical metadata Evidence with unavailable member collections without inventing empty results", async () => {
  const root = await createTestTempDirectory("rea-il2cpp-history-"),
    path = join(root, "global-metadata.dat");
  await writeFile(path, createIl2cppMetadataFixture({ version: 29 }).bytes);
  const { call } = await connectLocalToolsMcp();
  const fresh = await call("inspect_il2cpp_metadata", {
    path,
    detail: "complete",
  });
  expect(fresh.isError, JSON.stringify(fresh)).not.toBe(true);
  const original = parseEvidence(fresh.structuredContent),
    legacy = jsonObjectSchema.parse(original.normalized_result);
  for (const key of [
    "fields",
    "properties",
    "events",
    "parameters",
    "string_literals",
  ])
    delete legacy[key];
  const historical = createEvidence(
    {
      path,
      sha256: original.subject!.digest.sha256,
      format: "file",
    },
    original.provider,
    {
      operation: "inspect_il2cpp_metadata",
      parameters: { path },
      result: legacy,
      limitations: original.limitations,
      locations: original.locations,
    },
  );
  const bundle = join(root, "historical.json");
  await writeFile(bundle, JSON.stringify(createEvidenceBundle([historical])));
  await unlink(path);
  const imported = await call("import_evidence_bundle", { path: bundle });
  expect(imported.isError, JSON.stringify(imported)).not.toBe(true);
  const source = {
    kind: "retained-evidence",
    evidence_id: historical.evidence_id,
  };
  const summary = await call("inspect_analysis_view", {
    source,
    view: { kind: "summary" },
  });
  expect(summary.isError, JSON.stringify(summary)).not.toBe(true);
  expect(
    parseEvidence(summary.structuredContent).normalized_result,
  ).toMatchObject({
    summary: { counts: { methods: 5, fields: null, parameters: null } },
    unknowns: expect.arrayContaining([
      expect.stringContaining("did not collect parameters"),
    ]),
  });
  const types = await call("inspect_analysis_view", {
    source,
    view: {
      kind: "il2cpp-metadata",
      collection: "types",
      indices: [0],
      fields: ["name"],
    },
  });
  expect(types.isError).not.toBe(true);
  expect(
    parseEvidence(types.structuredContent).normalized_result,
  ).toMatchObject({ items: [{ index: 0, name: "Player" }] });
  const unavailable = await call("inspect_analysis_view", {
    source,
    view: { kind: "il2cpp-metadata", collection: "parameters" },
  });
  expect(parseMcpToolError(unavailable).error.code).toBe("invalid_request");
}, 30000);

cliTest(
  "exports complete metadata Evidence for compact CLI delivery and portable selected reads",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-il2cpp-cli-export-");
    const path = join(root, "global-metadata.dat");
    const bundle = join(root, "evidence.json");
    const refused = await cli.run({
      arguments: [
        "inspect-il2cpp-metadata",
        join(root, "must-not-be-read"),
        "--detail",
        "summary",
        "--json",
      ],
    });
    expect(refused.exitCode).toBe(1);
    expect(refused.json).toMatchObject({
      code: "invalid_request",
      details: { issues: [{ path: ["evidence_output"] }] },
    });
    await writeFile(path, createIl2cppMetadataFixture().bytes);
    const args = [
      "inspect-il2cpp-metadata",
      path,
      "--detail",
      "summary",
      "--evidence_output",
      bundle,
      "--json",
    ];
    const result = await cli.run({ arguments: args });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.json).toMatchObject({
      evidence_bundle: { path: bundle, bytes: expect.any(Number) },
      summary: { normalized_result: { kind: "summary" } },
    });
    const before = await readFile(bundle);
    const overwrite = await cli.run({ arguments: args });
    expect(overwrite.exitCode).toBe(1);
    expect(await readFile(bundle)).toEqual(before);
    const saved = await readEvidenceBundle(bundle);
    if (!saved.ok) throw saved.error;
    const evidence = saved.value.records[0];
    if (evidence === undefined)
      throw new Error("Missing exported source Evidence");
    expect(JSON.stringify(overwrite.json)).toContain(evidence.evidence_id);
    expect(
      il2cppMetadataSchema.parse(evidence.normalized_result).methods,
    ).toEqual(FIXTURE_METHODS);
    await unlink(path);
    const query = join(root, "query.json");
    await writeFile(
      query,
      JSON.stringify({
        source: { kind: "inline", evidence },
        view: {
          kind: "il2cpp-metadata",
          collection: "methods",
          indices: [2, 0],
          fields: ["name"],
        },
      }),
    );
    const selected = await cli.run({
      arguments: ["inspect-analysis-view", query, "--json"],
    });
    expect(selected.exitCode, selected.stderr).toBe(0);
    expect(parseEvidence(selected.json).normalized_result).toMatchObject({
      items: [
        { index: 0, name: ".ctor" },
        { index: 2, name: "Add" },
      ],
      parent_evidence_id: evidence.evidence_id,
    });
  },
  30000,
);

cliTest.skipIf(process.platform === "win32")(
  "exports and reads Evidence at the filesystem-selected symlink-parent path",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-il2cpp-export-path-");
    const path = join(root, "global-metadata.dat");
    await writeFile(path, createIl2cppMetadataFixture().bytes);
    const actual = join(root, "actual");
    await mkdir(join(actual, "nested"), { recursive: true });
    await symlink(join(actual, "nested"), join(root, "link"));
    const decoy = join(root, "evidence.json");
    await writeFile(decoy, "unrelated caller data");
    const selected = `${root}/link/../evidence.json`;
    const result = await cli.run({
      arguments: [
        "inspect-il2cpp-metadata",
        path,
        "--detail",
        "summary",
        "--evidence_output",
        selected,
        "--json",
      ],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.json).toMatchObject({ evidence_bundle: { path: selected } });
    expect(await readFile(decoy, "utf8")).toBe("unrelated caller data");
    const saved = await readEvidenceBundle(selected);
    if (!saved.ok) throw saved.error;
    expect(
      JSON.parse(await readFile(join(actual, "evidence.json"), "utf8")),
    ).toEqual(saved.value);
    const read = await cli.run({
      arguments: [
        "inspect-evidence-bundle",
        JSON.stringify({ path: selected, detail: "summary" }),
        "--json",
      ],
    });
    expect(read.exitCode, read.stderr).toBe(0);
    expect(read.stdout).toContain(saved.value.records[0]?.evidence_id);
  },
  30000,
);

cliTest(
  "links method addresses from a selected binary slice through CLI and MCP pages",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-il2cpp-binary-");
    const path = join(root, "global-metadata.dat");
    const binaryPath = join(root, "GameAssembly.dylib");
    await writeFile(path, createIl2cppMetadataFixture().bytes);
    await writeFile(
      binaryPath,
      createUniversalFixture([
        { cpu: 0x0100000c, bytes: createIl2cppBinaryFixture() },
      ]),
    );
    const expected = FIXTURE_METHOD_ADDRESSES.map((address) =>
      typeof address !== "bigint"
        ? { state: address, address: null, rva: null }
        : {
            state: "code",
            address: `0x${address.toString(16)}`,
            rva: `0x${(address - FIXTURE_BINARY_BASE).toString(16)}`,
          },
    );
    const result = await cli.run({
      arguments: [
        "inspect-il2cpp-metadata",
        path,
        "--binary",
        binaryPath,
        "--architecture",
        "arm64",
        "--json",
      ],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const report = parseCliMetadata(result.json);
    expect(report.method_addresses).toEqual(expected);
    expect(report.return_types.map((row) => row.name)).toEqual(
      Array.from({ length: 5 }, () => FIXTURE_RETURN_TYPE_NAME),
    );
    expect(report.binary).toMatchObject({
      format: "macho",
      architecture: "arm64",
      image_base: "0x100000000",
    });

    const { client, call } = await connectLocalToolsMcp();
    const missing = await call("inspect_il2cpp_metadata", {
      path,
      binary_path: binaryPath,
    });
    expect(parseMcpToolError(missing).error).toMatchObject({
      code: "unsupported_target",
      message: expect.stringContaining("slice-selection-required"),
    });
    const summarized = await call("inspect_il2cpp_metadata", {
      path,
      binary_path: binaryPath,
      binary_architecture: "arm64",
      detail: "summary",
    });
    expect(summarized.isError, JSON.stringify(summarized)).not.toBe(true);
    const view = parseMetadataSummary(summarized.structuredContent);
    expect(view.summary.counts.method_addresses).toBe(5);
    expect(view.summary.counts.method_address_states).toEqual({
      code: 4,
      no_body: 1,
      unknown: 0,
    });
    const page = await call("inspect_analysis_view", {
      source: {
        kind: "retained-evidence",
        evidence_id: view.parent_evidence_id,
      },
      view: {
        kind: "il2cpp-metadata",
        collection: "method_addresses",
        offset: 2,
      },
    });
    const projected = analysisViewResultSchema.parse(
      parseEvidence(page.structuredContent).normalized_result,
    );
    if (projected.kind !== "il2cpp-metadata")
      throw new Error("Wrong IL2CPP page kind");
    expect(projected.items).toEqual(
      expected.slice(2).map((row, offset) => ({ index: offset + 2, ...row })),
    );
    await client.ping();
  },
  30000,
);

cliTest(
  "marks a module array found through an x86-64 instruction as derived",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-il2cpp-inlined-");
    const path = join(root, "global-metadata.dat");
    const binaryPath = join(root, "GameAssembly.so");
    await writeFile(path, createIl2cppMetadataFixture().bytes);
    await writeFile(
      binaryPath,
      createElfFixture(
        createIl2cppBinaryFixture({
          codeRegistration: false,
          codeReference: true,
        }),
        { machine: 62 },
      ),
    );
    const result = await cli.run({
      arguments: [
        "inspect-il2cpp-metadata",
        path,
        "--binary",
        binaryPath,
        "--json",
      ],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const report = parseCliMetadata(result.json);
    expect(report.binary?.code_gen_modules_field).toBeNull();
    expect(
      report.limitations.some((line) =>
        line.includes("static CodeRegistration pair was not resolved"),
      ),
    ).toBe(true);
  },
  30000,
);

cliTest(
  "writes Ghidra function seeds for a linked ELF and refuses to overwrite them",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-il2cpp-seeds-");
    const path = join(root, "global-metadata.dat");
    const binaryPath = join(root, "libil2cpp.so");
    const seeds = join(root, "seeds.tsv");
    const shifted = join(root, "shifted.tsv");
    await writeFile(path, createIl2cppMetadataFixture().bytes);
    await writeFile(binaryPath, createElfFixture(createIl2cppBinaryFixture()));
    const run = (output: string, extra: readonly string[] = []) =>
      cli.run({
        arguments: [
          "inspect-il2cpp-metadata",
          path,
          "--binary",
          binaryPath,
          "--ghidra-seeds",
          output,
          ...extra,
          "--json",
        ],
      });

    const linked = await run(seeds);
    expect(linked.exitCode, linked.stderr).toBe(0);
    const linkedFacts = il2cppMetadataSchema.parse(
      parseEvidence(linked.json).normalized_result,
    );
    // This ELF is linked at the fixture base, so Ghidra keeps that base.
    expect(await readFile(seeds, "utf8")).toBe(
      [
        "0x100000200\tfunction\tGame.Player$$.ctor",
        "0x100000210\tfunction\tGame.Player$$Update",
        "0x100000220\tfunction\tGame.Player.Slot$$Add",
        "0x100000230\tfunction\tSystem.Größe$$.ctor",
        `# metadata_sha256 ${linkedFacts.artifact.sha256}`,
        `# binary_sha256 ${linkedFacts.binary!.artifact.sha256}`,
        "# link_base 0x100000000",
        "# seed_base 0x100000000",
        "",
      ].join("\n"),
    );

    const moved = await run(shifted, ["--seed-base", "0x100000"]);
    expect(moved.exitCode, moved.stderr).toBe(0);
    expect((await readFile(shifted, "utf8")).split("\n")[0]).toBe(
      "0x100200\tfunction\tGame.Player$$.ctor",
    );

    await writeFile(seeds, "kept\n");
    const again = await run(seeds);
    expect(again.exitCode).not.toBe(0);
    expect(again.json).toMatchObject({
      code: "invalid_request",
      details: {
        issues: [
          {
            path: ["ghidra_seeds"],
            message: expect.stringContaining("already exists"),
          },
        ],
      },
    });
    expect(await readFile(seeds, "utf8")).toBe("kept\n");

    const unlinked = await cli.run({
      arguments: [
        "inspect-il2cpp-metadata",
        path,
        "--ghidra-seeds",
        join(root, "unlinked.tsv"),
        "--json",
      ],
    });
    expect(unlinked.exitCode).not.toBe(0);
    expect(unlinked.json).toMatchObject({
      code: "invalid_request",
      details: {
        issues: [
          {
            path: ["ghidra_seeds"],
            message: expect.stringContaining("needs --binary"),
          },
        ],
      },
    });
  },
);
