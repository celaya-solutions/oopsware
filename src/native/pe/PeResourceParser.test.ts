import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  inspectPeResourcesInputSchema,
  peResourcesSchema,
} from "../../domain/native/peResources.js";
import { parsePeResources } from "./PeResourceParser.js";
import { peResourceFixture } from "./PeResources.fixture.js";

const parse = (bytes: Buffer, maxEntries = 4096, signal?: AbortSignal) =>
  parsePeResources(
    bytes,
    {
      path: "/fixtures/example.exe",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    inspectPeResourcesInputSchema.parse({
      path: "/fixtures/example.exe",
      max_entries: maxEntries,
    }),
    signal,
  );

describe("portable PE resource parsing", () => {
  it.each([false, true])(
    "preserves original identities, ranges, hashes and icon candidates (PE32+ = %s)",
    async (plus) => {
      const { bytes } = peResourceFixture(plus);
      const result = peResourcesSchema.parse(await parse(bytes));
      expect(result.format).toBe(plus ? "pe32-plus" : "pe32");
      expect(result.coverage).toMatchObject({
        status: "complete",
        resources: 5,
      });
      expect(
        result.resources.map(({ type, name, language }) => [
          type,
          name,
          language,
        ]),
      ).toContainEqual([
        { kind: "id", id: 10 },
        { kind: "id", id: 7 },
        { kind: "id", id: 1041 },
      ]);
      const named = result.resources.find(({ name }) => name.kind === "name");
      expect(named?.name).toMatchObject({
        kind: "name",
        name: "7",
        utf16le_hex: "3700",
      });
      for (const resource of result.resources) {
        const { offset, bytes: size } = resource.payload.location;
        expect(resource.payload.rva - offset).toBe(0x1c00);
        expect(resource.payload.sha256).toBe(
          createHash("sha256")
            .update(bytes.subarray(offset, offset + size))
            .digest("hex"),
        );
      }
      expect(result.icon_groups[0]?.images).toMatchObject([
        {
          resource_id: 1,
          candidate_resource_indices: [0, 1],
          same_language_resource_index: 0,
          size_matches: true,
        },
        {
          resource_id: 99,
          candidate_resource_indices: [],
          same_language_resource_index: null,
          size_matches: null,
        },
      ]);
    },
  );

  it("distinguishes an absent resource directory from a present empty tree", async () => {
    const fixture = peResourceFixture(false, []);
    expect(await parse(fixture.bytes)).toMatchObject({
      directory: { rva: 0x2000 },
      resources: [],
      coverage: { resources: 0, examined_entries: 0 },
    });
    fixture.bytes.fill(0, fixture.directoryAt, fixture.directoryAt + 8);
    expect(await parse(fixture.bytes)).toMatchObject({
      directory: null,
      resources: [],
    });
  });

  it.each([
    [
      "truncated directory",
      (fixture: ReturnType<typeof peResourceFixture>) =>
        fixture.bytes.writeUInt32LE(17, fixture.directoryAt + 4),
    ],
    [
      "cycle",
      (fixture: ReturnType<typeof peResourceFixture>) =>
        fixture.bytes.writeUInt32LE(
          0x80000000,
          (fixture.entryOffsets[0] ?? 0) + 4,
        ),
    ],
    [
      "bad payload RVA",
      (fixture: ReturnType<typeof peResourceFixture>) =>
        fixture.bytes.writeUInt32LE(0xfffffff0, fixture.dataOffsets[0]),
    ],
    [
      "overlapping payloads",
      (fixture: ReturnType<typeof peResourceFixture>) =>
        fixture.bytes.writeUInt32LE(
          fixture.bytes.readUInt32LE(fixture.dataOffsets[0]) + 1,
          fixture.dataOffsets[1],
        ),
    ],
    [
      "bad named counts",
      (fixture: ReturnType<typeof peResourceFixture>) =>
        fixture.bytes.writeUInt16LE(1, 0x400 + 12),
    ],
    [
      "truncated data entry",
      (fixture: ReturnType<typeof peResourceFixture>) =>
        fixture.bytes.writeUInt32LE(
          0x7fffffff,
          (fixture.entryOffsets.at(-1) ?? 0) + 4,
        ),
    ],
  ])("rejects %s without partial success", async (_name, mutate) => {
    const fixture = peResourceFixture();
    mutate(fixture);
    await expect(parse(fixture.bytes)).rejects.toMatchObject({
      reason: "format",
    });
  });
});

describe("PE header admission and bounded traversal", () => {
  it.each([
    [
      "truncated DOS header",
      (fixture: ReturnType<typeof peResourceFixture>) =>
        fixture.bytes.subarray(0, 63),
    ],
    [
      "invalid optional magic",
      (fixture: ReturnType<typeof peResourceFixture>) => {
        fixture.bytes.writeUInt16LE(0, 0x98);
        return fixture.bytes;
      },
    ],
    [
      "unbacked virtual payload",
      (fixture: ReturnType<typeof peResourceFixture>) => {
        fixture.bytes.writeUInt32LE(0x10000, fixture.sectionAt + 8);
        fixture.bytes.writeUInt32LE(0x8000, fixture.dataOffsets[0]);
        return fixture.bytes;
      },
    ],
    [
      "duplicate sibling IDs",
      (fixture: ReturnType<typeof peResourceFixture>) => {
        fixture.bytes.writeUInt32LE(
          fixture.bytes.readUInt32LE(fixture.entryOffsets[0]),
          (fixture.entryOffsets[0] ?? 0) + 8,
        );
        return fixture.bytes;
      },
    ],
    [
      "section beginning inside a header-backed payload",
      (fixture: ReturnType<typeof peResourceFixture>) => {
        fixture.bytes.writeUInt32LE(0x100, fixture.dataOffsets[0]);
        fixture.bytes.writeUInt32LE(4, (fixture.dataOffsets[0] ?? 0) + 4);
        fixture.bytes.writeUInt16LE(2, 0x86);
        const section = fixture.sectionAt + 40;
        fixture.bytes.writeUInt32LE(4, section + 8);
        fixture.bytes.writeUInt32LE(0x102, section + 12);
        fixture.bytes.writeUInt32LE(4, section + 16);
        const rawOffset = fixture.bytes.length;
        fixture.bytes = Buffer.concat([fixture.bytes, Buffer.alloc(4)]);
        fixture.bytes.writeUInt32LE(rawOffset, section + 20);
        return fixture.bytes;
      },
    ],
    [
      "overlapping virtual sections",
      (fixture: ReturnType<typeof peResourceFixture>) => {
        fixture.bytes.writeUInt16LE(2, 0x86);
        fixture.bytes.copy(
          fixture.bytes,
          fixture.sectionAt + 40,
          fixture.sectionAt,
          fixture.sectionAt + 40,
        );
        fixture.bytes.writeUInt32LE(0, fixture.sectionAt + 40 + 16);
        return fixture.bytes;
      },
    ],
    [
      "malformed icon group",
      (fixture: ReturnType<typeof peResourceFixture>) => {
        const data = fixture.dataOffsets.at(-1) ?? 0;
        const offset = fixture.bytes.readUInt32LE(data) - 0x1c00;
        fixture.bytes.writeUInt16LE(3, offset + 4);
        return fixture.bytes;
      },
    ],
  ])("rejects %s", async (_name, mutate) => {
    await expect(parse(mutate(peResourceFixture()))).rejects.toMatchObject({
      reason: "format",
    });
  });

  it("keeps icon size mismatch and unresolved language distinct", async () => {
    const fixture = peResourceFixture();
    const data = fixture.dataOffsets.at(-1) ?? 0;
    const payload = fixture.bytes.readUInt32LE(data) - 0x1c00;
    fixture.bytes.writeUInt32LE(123, payload + 14);
    let report = await parse(fixture.bytes);
    expect(report.icon_groups[0]?.images[0]).toMatchObject({
      same_language_resource_index: 0,
      size_matches: false,
    });
    const languageEntry = report.resources[4]?.entry_locations[2]?.offset ?? 0;
    fixture.bytes.writeUInt32LE(2057, languageEntry);
    report = await parse(fixture.bytes);
    expect(report.icon_groups[0]?.images[0]).toMatchObject({
      candidate_resource_indices: [0, 1],
      same_language_resource_index: null,
      size_matches: null,
    });
  });

  it("preserves exact shared payload ranges and hashes", async () => {
    const fixture = peResourceFixture();
    fixture.bytes.writeUInt32LE(
      fixture.bytes.readUInt32LE(fixture.dataOffsets[0]),
      fixture.dataOffsets[1],
    );
    const result = await parse(fixture.bytes);
    expect(result.resources[0]?.payload).toEqual(result.resources[1]?.payload);
  });

  it("enforces entry budgets before traversing large tables", async () => {
    await expect(parse(peResourceFixture().bytes, 1)).rejects.toMatchObject({
      reason: "limit",
    });
  });

  it("allows cancellation while traversing resource entries", async () => {
    const controller = new AbortController();
    const parsing = parse(peResourceFixture().bytes, 4096, controller.signal);
    controller.abort();
    await expect(parsing).rejects.toThrow();
  });
});

describe("PE resource section virtual extent", () => {
  const sectionSizes = (fixture: ReturnType<typeof peResourceFixture>) => {
    const virtualSize = fixture.bytes.readUInt32LE(fixture.sectionAt + 8);
    const rawSize = fixture.bytes.readUInt32LE(fixture.sectionAt + 16);
    expect(rawSize - virtualSize).toBeGreaterThanOrEqual(8);
    return { virtualSize, rawSize };
  };

  it.each([
    [0, "Resource RVA has missing or overlapping section mappings."],
    [-2, "Resource range leaves its section's virtual size."],
  ])(
    "rejects a payload reaching raw alignment padding past VirtualSize (start %i)",
    async (start, message) => {
      const fixture = peResourceFixture();
      const { virtualSize } = sectionSizes(fixture);
      const rva = 0x2000 + virtualSize + start;
      fixture.bytes.writeUInt32LE(rva, fixture.dataOffsets[0]);
      fixture.bytes.writeUInt32LE(4, (fixture.dataOffsets[0] ?? 0) + 4);
      await expect(parse(fixture.bytes)).rejects.toMatchObject({
        reason: "format",
        message,
      });
    },
  );

  it("retains an empty payload that ends its section's virtual extent", async () => {
    const fixture = peResourceFixture();
    const { virtualSize } = sectionSizes(fixture);
    fixture.bytes.writeUInt32LE(0x2000 + virtualSize, fixture.dataOffsets[0]);
    fixture.bytes.writeUInt32LE(0, (fixture.dataOffsets[0] ?? 0) + 4);

    const result = peResourcesSchema.parse(await parse(fixture.bytes));
    expect(result.coverage).toMatchObject({ status: "complete", resources: 5 });
    expect(result.resources[0]).toMatchObject({
      type: { kind: "id", id: 3 },
      name: { kind: "id", id: 1 },
      language: { kind: "id", id: 1033 },
      payload: {
        rva: 0x2000 + virtualSize,
        location: { offset: 0x400 + virtualSize, bytes: 0 },
        sha256: createHash("sha256").digest("hex"),
      },
    });
  });

  it("rejects an empty payload past its section's virtual extent", async () => {
    const fixture = peResourceFixture();
    const { virtualSize } = sectionSizes(fixture);
    fixture.bytes.writeUInt32LE(
      0x2000 + virtualSize + 1,
      fixture.dataOffsets[0],
    );
    fixture.bytes.writeUInt32LE(0, (fixture.dataOffsets[0] ?? 0) + 4);
    await expect(parse(fixture.bytes)).rejects.toMatchObject({
      reason: "format",
      message: "Resource RVA has missing or overlapping section mappings.",
    });
  });

  it("rejects an empty virtual-end payload without a file-backed location", async () => {
    const fixture = peResourceFixture();
    const { rawSize } = sectionSizes(fixture);
    fixture.bytes.writeUInt32LE(rawSize + 1, fixture.sectionAt + 8);
    fixture.bytes.writeUInt32LE(0x2000 + rawSize + 1, fixture.dataOffsets[0]);
    fixture.bytes.writeUInt32LE(0, (fixture.dataOffsets[0] ?? 0) + 4);
    await expect(parse(fixture.bytes)).rejects.toMatchObject({
      reason: "format",
      message: "Resource range is not entirely file-backed in one section.",
    });
  });

  it("maps an empty payload at a section boundary into the section that starts there", async () => {
    const fixture = peResourceFixture();
    const { virtualSize } = sectionSizes(fixture);
    const laterRva = 0x2000 + virtualSize;
    const rawOffset = fixture.bytes.length;
    const payload = Buffer.from("LATE");
    const bytes = Buffer.concat([fixture.bytes, payload]);
    bytes.writeUInt16LE(2, 0x86);
    const later = fixture.sectionAt + 40;
    bytes.writeUInt32LE(payload.length, later + 8);
    bytes.writeUInt32LE(laterRva, later + 12);
    bytes.writeUInt32LE(payload.length, later + 16);
    bytes.writeUInt32LE(rawOffset, later + 20);
    bytes.writeUInt32LE(laterRva, fixture.dataOffsets[0]);
    bytes.writeUInt32LE(0, (fixture.dataOffsets[0] ?? 0) + 4);

    const result = peResourcesSchema.parse(await parse(bytes));
    expect(result.resources[0]?.payload.location).toEqual({
      offset: rawOffset,
      bytes: 0,
    });
  });

  it("maps raw bytes when VirtualSize is zero, as the image loader does", async () => {
    const fixture = peResourceFixture();
    fixture.bytes.writeUInt32LE(0, fixture.sectionAt + 8);
    expect(await parse(fixture.bytes)).toMatchObject({
      coverage: { status: "complete", resources: 5 },
    });
  });

  it("selects a later section that starts inside earlier raw padding", async () => {
    const fixture = peResourceFixture();
    const { virtualSize } = sectionSizes(fixture);
    const laterRva = 0x2000 + Math.ceil(virtualSize / 4) * 4;
    const rawOffset = fixture.bytes.length;
    const payload = Buffer.from("LATE");
    const bytes = Buffer.concat([fixture.bytes, payload]);
    bytes.writeUInt16LE(2, 0x86);
    const later = fixture.sectionAt + 40;
    bytes.writeUInt32LE(payload.length, later + 8);
    bytes.writeUInt32LE(laterRva, later + 12);
    bytes.writeUInt32LE(payload.length, later + 16);
    bytes.writeUInt32LE(rawOffset, later + 20);
    bytes.writeUInt32LE(laterRva, fixture.dataOffsets[0]);
    bytes.writeUInt32LE(payload.length, (fixture.dataOffsets[0] ?? 0) + 4);

    const result = peResourcesSchema.parse(await parse(bytes));
    expect(result.resources[0]?.payload).toMatchObject({
      rva: laterRva,
      location: { offset: rawOffset, bytes: payload.length },
      sha256: createHash("sha256").update(payload).digest("hex"),
    });
  });
});

describe("PE resource ownership boundaries", () => {
  const singleResource = () =>
    peResourceFixture(false, [
      { type: 10, name: 1, language: 1033, payload: Buffer.from("DATA") },
    ]);
  const secondSection = (
    fixture: ReturnType<typeof peResourceFixture>,
    virtualSize: number,
    rva: number,
    rawSize: number,
  ): Buffer => {
    fixture.bytes.writeUInt16LE(2, 0x86);
    const section = fixture.sectionAt + 40;
    fixture.bytes.writeUInt32LE(virtualSize, section + 8);
    fixture.bytes.writeUInt32LE(rva, section + 12);
    fixture.bytes.writeUInt32LE(rawSize, section + 16);
    if (rawSize === 0) return fixture.bytes;
    fixture.bytes.writeUInt32LE(fixture.bytes.length, section + 20);
    return Buffer.concat([fixture.bytes, Buffer.alloc(rawSize)]);
  };

  it("keeps locations and digests unchanged for a zero-extent section inside the resource interval", async () => {
    const baseline = peResourcesSchema.parse(
      await parse(singleResource().bytes),
    );
    const fixture = singleResource();
    const bytes = secondSection(fixture, 0, 0x2001, 0);

    const result = peResourcesSchema.parse(await parse(bytes));
    expect(result.coverage).toMatchObject({ status: "complete" });
    expect(result.resources[0]?.payload).toEqual(
      baseline.resources[0]?.payload,
    );
  });

  it("still rejects a positive-extent section inside the resource interval", async () => {
    const fixture = singleResource();
    const bytes = secondSection(fixture, 4, 0x2001, 0);
    await expect(parse(bytes)).rejects.toMatchObject({
      reason: "format",
      message: "Resource interval intersects overlapping virtual sections.",
    });
  });

  it("keeps a header-backed payload whose interval contains a zero-extent section", async () => {
    const fixture = singleResource();
    fixture.bytes.writeUInt32LE(0x100, fixture.dataOffsets[0]);
    fixture.bytes.writeUInt32LE(4, (fixture.dataOffsets[0] ?? 0) + 4);
    const bytes = secondSection(fixture, 0, 0x102, 0);

    const result = peResourcesSchema.parse(await parse(bytes));
    expect(result.resources[0]?.payload).toMatchObject({
      rva: 0x100,
      location: { offset: 0x100, bytes: 4 },
      sha256: createHash("sha256")
        .update(bytes.subarray(0x100, 0x104))
        .digest("hex"),
    });
  });

  it("rejects an empty header payload whose RVA starts a file-backed section", async () => {
    const fixture = singleResource();
    fixture.bytes.writeUInt32LE(0x100, fixture.dataOffsets[0]);
    fixture.bytes.writeUInt32LE(0, (fixture.dataOffsets[0] ?? 0) + 4);
    const bytes = secondSection(fixture, 4, 0x100, 4);
    await expect(parse(bytes)).rejects.toMatchObject({
      reason: "format",
      message: "Ambiguous resource header RVA mapping.",
    });
  });

  it("retains an empty header payload that no section owns", async () => {
    const fixture = singleResource();
    fixture.bytes.writeUInt32LE(0x100, fixture.dataOffsets[0]);
    fixture.bytes.writeUInt32LE(0, (fixture.dataOffsets[0] ?? 0) + 4);

    const result = peResourcesSchema.parse(await parse(fixture.bytes));
    expect(result.resources[0]?.payload).toMatchObject({
      rva: 0x100,
      location: { offset: 0x100, bytes: 0 },
      sha256: createHash("sha256").digest("hex"),
    });
  });
});
