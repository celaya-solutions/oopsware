import { setImmediate } from "node:timers/promises";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  AnalysisCancelledError,
  AnalysisResourceConstraintError,
} from "../../../src/domain/analysisErrorCore.js";
import { Il2cppMetadataProvider } from "../../../src/il2cpp/Il2cppMetadataProvider.js";
import {
  createElfFixture,
  createIl2cppBinaryFixture,
} from "../../fixtures/il2cpp/binary.js";
import { createIl2cppMetadataFixture } from "../../fixtures/il2cpp/metadata.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** One-shot inspections keep the real reader's cleanup at one test boundary. */
const inspectMetadata = async (path: string, limit?: number) => {
  const provider = new Il2cppMetadataProvider(limit);
  try {
    return await provider.inspect({ path });
  } finally {
    await provider.close();
  }
};

/** Version 29 file whose methods all share one long name. */
const sharedNameMetadata = (
  nameBytes: number | Buffer,
  methods: number,
  fill = 0x41,
) => {
  const encoded = Buffer.isBuffer(nameBytes)
    ? nameBytes
    : Buffer.alloc(nameBytes, fill);
  const name = Buffer.concat([encoded, Buffer.from([0])]);
  const records = Buffer.alloc(methods * 32);
  for (let index = 0; index < methods; index += 1)
    records.writeInt32LE(-1, index * 32 + 4);
  const header = Buffer.alloc(256);
  header.writeUInt32LE(0xfab11baf, 0);
  header.writeInt32LE(29, 4);
  let cursor = 256;
  for (let section = 0; section < 31; section += 1) {
    // strings is section 2 and methods is section 5.
    const content = section === 2 ? name : section === 5 ? records : undefined;
    header.writeInt32LE(cursor, 8 + section * 8);
    header.writeInt32LE(content?.length ?? 0, 12 + section * 8);
    cursor += content?.length ?? 0;
  }
  return Buffer.concat([header, name, records]);
};

/** Fixed-width metadata whose literals share one span; no target code is involved. */
const sharedLiteralMetadata = (literalBytes: Buffer, count: number) => {
  const header = Buffer.alloc(256),
    records = Buffer.alloc(count * 8);
  header.writeUInt32LE(0xfab11baf, 0);
  header.writeInt32LE(29, 4);
  for (let i = 0; i < count; i++)
    records.writeUInt32LE(literalBytes.length, i * 8);
  let cursor = 256;
  for (let section = 0; section < 31; section++) {
    const size =
      section === 0 ? records.length : section === 1 ? literalBytes.length : 0;
    header.writeInt32LE(cursor, 8 + section * 8);
    header.writeInt32LE(size, 12 + section * 8);
    cursor += size;
  }
  return Buffer.concat([header, records, literalBytes]);
};

it("bounds repeated literal output during decoding and reuses one span instead of allocating every repetition", async () => {
  const root = await createTestTempDirectory("rea-il2cpp-literals-");
  const path = join(root, "global-metadata.dat");
  await writeFile(path, sharedLiteralMetadata(Buffer.alloc(4096, 65), 20));
  const decode = vi.spyOn(TextDecoder.prototype, "decode");
  const result = await inspectMetadata(path, 12_000);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expanded literals accepted");
  expect(result.error).toBeInstanceOf(AnalysisResourceConstraintError);
  expect(result.error.partialObservation).toMatchObject({
    normalized_result: {
      validated_section_row_counts: { string_literals: 20 },
    },
  });
  expect(
    decode.mock.calls.filter(([bytes]) => bytes?.byteLength === 4096),
  ).toHaveLength(1);
});

it("refuses raw literal expansion before decoding and admits invalid UTF-8 only when base64 fits", async () => {
  const root = await createTestTempDirectory("rea-il2cpp-literal-forms-");
  const path = join(root, "global-metadata.dat");
  const decode = vi.spyOn(TextDecoder.prototype, "decode");
  for (const [bytes, limit, expectedDecodes] of [
    [Buffer.alloc(4096, 65), 1024, 0],
    [Buffer.alloc(2048, 255), 2400, 1],
  ] as const) {
    decode.mockClear();
    await writeFile(path, sharedLiteralMetadata(bytes, 1));
    const result = await inspectMetadata(path, limit);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toBeInstanceOf(AnalysisResourceConstraintError);
    expect(
      decode.mock.calls.filter(([value]) => value?.byteLength === bytes.length),
    ).toHaveLength(expectedDecodes);
  }
});

it("counts an unclaimed parameter table before allocating any member rows", async () => {
  const root = await createTestTempDirectory("rea-il2cpp-member-counts-");
  const path = join(root, "global-metadata.dat");
  const fixture = createIl2cppMetadataFixture({
    wide: { fillerTypes: 0, genericContainers: 0, parameters: 2000 },
  });
  const bytes = Buffer.from(fixture.bytes);
  bytes.writeInt32LE(0x7fffffff, fixture.section("parameters").offset);
  await writeFile(path, bytes);
  const result = await inspectMetadata(path, 4096);
  expect(result.ok).toBe(false);
  if (!result.ok)
    expect(result.error).toBeInstanceOf(AnalysisResourceConstraintError);
});

it.each([
  {
    name: "shared-name row lower bound",
    bytes: () => sharedNameMetadata(65_536, 1_100),
    limit: undefined,
  },
  {
    name: "JSON escaping",
    bytes: () => sharedNameMetadata(4096, 1, 0x01),
    limit: 8192,
  },
  {
    name: "UTF-8 expansion",
    bytes: () => sharedNameMetadata(Buffer.from("雪".repeat(4096)), 1),
    limit: 8192,
  },
])(
  "refuses $name before allocating serialized text",
  async ({ bytes, limit }) => {
    const root = await createTestTempDirectory("rea-il2cpp-text-budget-");
    const path = join(root, "global-metadata.dat");
    await writeFile(path, bytes());
    const stringify = vi.spyOn(JSON, "stringify");
    const result = await inspectMetadata(path, limit);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toBeInstanceOf(AnalysisResourceConstraintError);
    expect(
      stringify.mock.calls.some(
        ([value]) =>
          (typeof value === "string" && value.length >= 4096) ||
          (typeof value === "object" && value !== null && "methods" in value),
      ),
    ).toBe(false);
  },
);

it("admits a report whose escaped names fit the budget exactly", async () => {
  const root = await createTestTempDirectory("rea-il2cpp-provider-fit-");
  const path = join(root, "global-metadata.dat");
  await writeFile(path, sharedNameMetadata(4096, 1, 0x01));
  const unbounded = new Il2cppMetadataProvider();
  let bytes: number;
  try {
    const result = await unbounded.inspect({ path });
    if (!result.ok) throw result.error;
    expect(result.value.methods[0]?.name).toBe("".repeat(4096));
    bytes = Buffer.byteLength(JSON.stringify(result.value));
  } finally {
    await unbounded.close();
  }
  const exact = new Il2cppMetadataProvider(bytes);
  try {
    expect((await exact.inspect({ path })).ok).toBe(true);
  } finally {
    await exact.close();
  }
});

it("refuses from row counts before decoding any row", async () => {
  const root = await createTestTempDirectory("rea-il2cpp-provider-counts-");
  const path = join(root, "global-metadata.dat");
  // A broken method name would fail as invalid-string if rows were decoded.
  const fixture = createIl2cppMetadataFixture();
  const bytes = Buffer.from(fixture.bytes);
  bytes.writeInt32LE(0x7fff, fixture.record("methods", 0));
  await writeFile(path, bytes);
  const result = await inspectMetadata(path, 256);
  expect(result.ok).toBe(false);
  if (!result.ok)
    expect(result.error).toBeInstanceOf(AnalysisResourceConstraintError);
});

it.each([
  { requested: "cancel during metadata decoding" },
  new AnalysisResourceConstraintError(
    "caller-selected-reason",
    "memory",
    "Caller cancellation reason",
    {},
  ),
])(
  "accepts cancellation during decoded batches with exact reason %j",
  async (reason) => {
    const root = await createTestTempDirectory("rea-il2cpp-provider-cancel-");
    const path = join(root, "global-metadata.dat");
    const bytes = sharedNameMetadata(1, 100_000);
    await writeFile(path, bytes);
    const controller = new AbortController();
    let batches = 0;
    const provider = new Il2cppMetadataProvider(undefined, async () => {
      await setImmediate();
      if (++batches === 3) controller.abort(reason);
    });
    try {
      const result = await provider.inspect(
        { path },
        { signal: controller.signal },
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected cancellation");
      expect(result.error).toBeInstanceOf(AnalysisCancelledError);
      expect(result.error.cause).toBe(reason);
      expect(batches).toBe(3);
      expect(result.error.partialObservation).toMatchObject({
        operation: "observe_il2cpp_metadata_source",
        normalized_result: {
          artifact: {
            path,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            bytes: bytes.length,
          },
          inventory_status: "not-returned-as-complete",
          validated_section_row_counts: {
            images: 0,
            types: 0,
            methods: 100_000,
          },
        },
      });
      const replacement = createIl2cppMetadataFixture();
      await writeFile(path, replacement.bytes);
      const next = await provider.inspect({ path });
      if (!next.ok) throw next.error;
      expect(next.value.artifact.sha256).toBe(
        createHash("sha256").update(replacement.bytes).digest("hex"),
      );
      expect(next.value.methods).toHaveLength(5);
    } finally {
      await provider.close();
    }
  },
);

it("bounds concurrent snapshots and retains active decoding until close completes", async () => {
  const root = await createTestTempDirectory("rea-il2cpp-provider-close-");
  const path = join(root, "global-metadata.dat");
  await writeFile(path, createIl2cppMetadataFixture().bytes);
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  let resume!: () => void;
  const release = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const provider = new Il2cppMetadataProvider(undefined, () => {
    markEntered();
    return release;
  });
  const active = provider.inspect({ path });
  await entered;
  let closed = false;
  const closing = provider.close().then(() => {
    closed = true;
  });
  try {
    const refused = await provider.inspect({ path });
    expect(refused.ok).toBe(false);
    if (!refused.ok)
      expect(refused.error).toBeInstanceOf(AnalysisResourceConstraintError);
    await setImmediate();
    expect(closed).toBe(false);
  } finally {
    resume();
    await closing;
  }
  expect((await active).ok).toBe(true);
  expect(closed).toBe(true);
  expect((await provider.inspect({ path })).ok).toBe(false);
});

it.each([false, true])(
  "keeps an independent failure with shared cancellation reason: %s",
  async (sharedReason) => {
    const root = await createTestTempDirectory("rea-il2cpp-failure-cancel-");
    const path = join(root, "global-metadata.dat");
    await writeFile(path, createIl2cppMetadataFixture().bytes);
    const controller = new AbortController();
    const failure = Object.assign(
      new Error("independent scheduler I/O failure"),
      { code: "EIO" },
    );
    const provider = new Il2cppMetadataProvider(undefined, () => {
      controller.abort(sharedReason ? failure : "separate caller cancellation");
      return Promise.reject(failure);
    });
    try {
      const result = await provider.inspect(
        { path },
        { signal: controller.signal },
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected the independent failure");
      expect(result.error).not.toBeInstanceOf(AnalysisCancelledError);
      expect(result.error.cause).toBe(failure);
    } finally {
      await provider.close();
    }
  },
);

it("retains the exact empty source observation without claiming a decoded inventory", async () => {
  const root = await createTestTempDirectory("rea-il2cpp-empty-");
  const path = join(root, "empty.dat");
  await writeFile(path, Buffer.alloc(0));
  const result = await inspectMetadata(path);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected unsupported empty metadata");
  expect(result.error.message).toContain("unrecognized-magic");
  expect(result.error.partialObservation).toMatchObject({
    operation: "observe_il2cpp_metadata_source",
    normalized_result: {
      artifact: {
        path,
        bytes: 0,
        sha256: createHash("sha256").digest("hex"),
      },
      inventory_status: "not-returned-as-complete",
    },
  });
});

it("keeps the metadata source observation when the selected binary does not link", async () => {
  const root = await createTestTempDirectory("rea-il2cpp-binary-failure-");
  const path = join(root, "global-metadata.dat");
  const binaryPath = join(root, "GameAssembly.dll");
  const fixture = createIl2cppMetadataFixture();
  await writeFile(path, fixture.bytes);
  await writeFile(binaryPath, Buffer.from("not a native image"));
  const provider = new Il2cppMetadataProvider();
  try {
    const result = await provider.inspect({ path, binary_path: binaryPath });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected the binary to be refused");
    expect(result.error.partialObservation).toMatchObject({
      operation: "observe_il2cpp_metadata_source",
      normalized_result: {
        artifact: {
          path,
          sha256: createHash("sha256").update(fixture.bytes).digest("hex"),
          bytes: fixture.bytes.length,
        },
        inventory_status: "not-returned-as-complete",
      },
    });
  } finally {
    await provider.close();
  }
});

it("accepts cancellation between binary linking batches and keeps the metadata source", async () => {
  const root = await createTestTempDirectory("rea-il2cpp-link-cancel-");
  const path = join(root, "global-metadata.dat");
  const binaryPath = join(root, "libil2cpp.so");
  const fixture = createIl2cppMetadataFixture();
  await writeFile(path, fixture.bytes);
  await writeFile(binaryPath, createElfFixture(createIl2cppBinaryFixture()));
  // Yields taken by the metadata decode alone; later ones belong to linking.
  let decodeYields = 0;
  const counting = new Il2cppMetadataProvider(undefined, async () => {
    decodeYields++;
  });
  try {
    expect((await counting.inspect({ path })).ok).toBe(true);
  } finally {
    await counting.close();
  }
  const controller = new AbortController();
  const reason = new Error("stop linking");
  let yields = 0;
  const provider = new Il2cppMetadataProvider(undefined, async () => {
    if (++yields === decodeYields + 2) controller.abort(reason);
  });
  try {
    const result = await provider.inspect(
      { path, binary_path: binaryPath },
      { signal: controller.signal },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected cancellation");
    expect(result.error).toBeInstanceOf(AnalysisCancelledError);
    expect(yields).toBe(decodeYields + 2);
    expect(result.error.partialObservation).toMatchObject({
      operation: "observe_il2cpp_metadata_source",
      normalized_result: { artifact: { path } },
    });
  } finally {
    await provider.close();
  }
});

it("retains both observed file identities and the selected architecture when native linking fails", async () => {
  const root = await createTestTempDirectory("rea-il2cpp-failed-pair-");
  const path = join(root, "global-metadata.dat"),
    binary_path = join(root, "GameAssembly.dylib");
  const bytes = createIl2cppBinaryFixture({ codeRegistration: false });
  await writeFile(path, createIl2cppMetadataFixture().bytes);
  await writeFile(binary_path, bytes);
  const provider = new Il2cppMetadataProvider();
  try {
    const result = await provider.inspect({ path, binary_path });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Unresolved registration accepted");
    expect(result.error.partialObservation).toMatchObject({
      normalized_result: {
        artifact: { path },
        selected_binary: {
          path: binary_path,
          identity_status: "observed",
          sha256: createHash("sha256").update(bytes).digest("hex"),
          bytes: bytes.length,
        },
      },
    });
  } finally {
    await provider.close();
  }
});
