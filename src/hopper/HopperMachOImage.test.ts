import { createHash } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import {
  prepareHopperMachOImage,
  resolveHopperMachOImage,
} from "./HopperMachOImage.js";

const CPU_TYPES = { x86_64: 0x01000007, arm64: 0x0100000c } as const;
const FAT32_ALIGNMENT = 12;
const FAT32_SLICE_SIZE = 64;
const ARM64E = 2;
const ARM64E_X1 = 12;
const ARM64E_WITH_CAPABILITIES = 0x80000002;
const ARM64E_X1_WITH_CAPABILITIES = 0x8000000c;

interface FatFixtureSlice {
  readonly cpuType: number;
  readonly cpuSubtype: number;
  /** Thin-slice byte order, independent of the container's table byte order. */
  readonly little?: boolean;
}

interface Fat32Fixture {
  readonly container: Buffer;
  readonly sliceOffsets: readonly number[];
}

/** Synthesize a FAT32 container whose slices are 4096-aligned thin headers. */
const buildFat32Container = (
  slices: readonly FatFixtureSlice[],
  options: { readonly littleEndianTable?: boolean } = {},
): Fat32Fixture => {
  const littleTable = options.littleEndianTable === true;
  const writeTableUInt32 = littleTable
    ? (buffer: Buffer, offset: number, value: number): number =>
        buffer.writeUInt32LE(value, offset)
    : (buffer: Buffer, offset: number, value: number): number =>
        buffer.writeUInt32BE(value, offset);
  const unit = 2 ** FAT32_ALIGNMENT;
  const sliceOffsets = slices.map((_slice, index) => unit * (index + 1));
  const lastOffset = sliceOffsets[sliceOffsets.length - 1] ?? unit;
  const container = Buffer.alloc(lastOffset + FAT32_SLICE_SIZE, 0);
  // The magic VALUE is 0xcafebabe in the table's byte order: little-endian
  // storage yields the FAT_CIGAM magic a big-endian reader observes.
  writeTableUInt32(container, 0, 0xcafebabe);
  writeTableUInt32(container, 4, slices.length);
  for (const [index, slice] of slices.entries()) {
    const entry = 8 + index * 20;
    const offset = sliceOffsets[index]!;
    writeTableUInt32(container, entry, slice.cpuType);
    writeTableUInt32(container, entry + 4, slice.cpuSubtype);
    writeTableUInt32(container, entry + 8, offset);
    writeTableUInt32(container, entry + 12, FAT32_SLICE_SIZE);
    writeTableUInt32(container, entry + 16, FAT32_ALIGNMENT);
    const writeThinUInt32 =
      slice.little === true
        ? (buffer: Buffer, fieldOffset: number, value: number): number =>
            buffer.writeUInt32LE(value, fieldOffset)
        : (buffer: Buffer, fieldOffset: number, value: number): number =>
            buffer.writeUInt32BE(value, fieldOffset);
    writeThinUInt32(container, offset, 0xfeedfacf);
    writeThinUInt32(container, offset + 4, slice.cpuType);
    writeThinUInt32(container, offset + 8, slice.cpuSubtype);
  }
  return { container, sliceOffsets };
};

const writeFixture = async (
  directory: string,
  name: string,
  fixture: Fat32Fixture,
): Promise<string> => {
  const path = join(directory, name);
  await writeFile(path, fixture.container);
  return path;
};

const fat32Target = (
  path: string,
  fixture: Fat32Fixture,
  architecture: "arm64" | "x86_64",
) => ({
  path,
  sha256: createHash("sha256").update(fixture.container).digest("hex"),
  kind: "executable" as const,
  format: "mach-o-universal" as const,
  architecture,
  availableArchitectures: ["x86_64", "arm64"] as const,
  universalSlice: { offset: fixture.sliceOffsets[0]!, size: FAT32_SLICE_SIZE },
});

const requireResolved = (
  result: Awaited<ReturnType<typeof resolveHopperMachOImage>>,
) => {
  if (!result.ok)
    throw new Error(
      `FAT fixture resolution failed: ${JSON.stringify(projectAnalysisError(result.error))}`,
    );
  return result.value;
};

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "reports a FAT64 source that became unreadable as a host read denial",
  async () => {
    const directory = await createTestTempDirectory("rea-hopper-fat64-");
    const path = join(directory, "universal");
    await writeFile(path, Buffer.alloc(64));
    await chmod(path, 0);
    try {
      const result = await resolveHopperMachOImage({
        path,
        sha256: "0".repeat(64),
        kind: "executable",
        format: "mach-o",
        architecture: "arm64",
        availableArchitectures: ["arm64"],
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatchObject({ systemCode: "EACCES" });
      expect(projectAnalysisError(result.error)).toMatchObject({
        code: "access_denied",
        details: { path, system_code: "EACCES" },
      });
    } finally {
      await chmod(path, 0o600);
    }
  },
);

it("rejects an ELF target before attempting FAT source preparation", async () => {
  const directory = await createTestTempDirectory("rea-hopper-mips-boundary-");
  // No file is created: format validation must precede any filesystem lookup.
  const path = join(directory, "mips.elf");
  const result = await resolveHopperMachOImage({
    path,
    sha256: "0".repeat(64),
    kind: "executable",
    format: "elf",
    architecture: "mips",
    availableArchitectures: ["mips"],
    mips: { elfClass: 32, byteOrder: "little", type: 2, flags: 0x70001001 },
  });
  if (result.ok)
    throw new Error("An ELF target entered Mach-O image preparation");
  expect(result.error).toMatchObject({
    _tag: "BinaryTargetError",
    path,
    reason: "Hopper FAT image preparation requires a Mach-O target",
  });
});

it("selects the plain-arm64-decodable arm64e slice from an Apple-style FAT32 container", async () => {
  const directory = await createTestTempDirectory("rea-hopper-fat32-arm64e-");
  // /bin/* system binaries: x86_64, arm64e (cpusubtype 2), arm64e.x1 (subtype 12).
  const fixture = buildFat32Container([
    { cpuType: CPU_TYPES.x86_64, cpuSubtype: 3 },
    { cpuType: CPU_TYPES.arm64, cpuSubtype: ARM64E },
    { cpuType: CPU_TYPES.arm64, cpuSubtype: ARM64E_X1 },
  ]);
  const path = await writeFixture(directory, "system.fat", fixture);
  const result = requireResolved(
    await resolveHopperMachOImage(fat32Target(path, fixture, "arm64")),
  );
  expect(result).toMatchObject({
    method: "fat32_thin_slice",
    architecture_count: 3,
    source_offset: fixture.sliceOffsets[1],
    byte_length: FAT32_SLICE_SIZE,
    cpu_type: CPU_TYPES.arm64,
    cpu_subtype: ARM64E,
  });
});

it("ranks capability-bearing arm64 subtypes by base and retains raw identity", async () => {
  const directory = await createTestTempDirectory(
    "rea-hopper-fat32-capabilities-",
  );
  const fixture = buildFat32Container([
    {
      cpuType: CPU_TYPES.arm64,
      cpuSubtype: ARM64E_X1_WITH_CAPABILITIES,
    },
    {
      cpuType: CPU_TYPES.arm64,
      cpuSubtype: ARM64E_WITH_CAPABILITIES,
    },
  ]);
  const path = await writeFixture(directory, "system.fat", fixture);
  const selected = requireResolved(
    await resolveHopperMachOImage(fat32Target(path, fixture, "arm64")),
  );
  expect(selected).toMatchObject({
    source_offset: fixture.sliceOffsets[1],
    cpu_subtype: ARM64E_WITH_CAPABILITIES,
  });
});

it("fails closed when capability variants share the preferred arm64e base", async () => {
  const directory = await createTestTempDirectory(
    "rea-hopper-fat32-capability-ambiguity-",
  );
  const fixture = buildFat32Container([
    { cpuType: CPU_TYPES.arm64, cpuSubtype: 0x80000002 },
    { cpuType: CPU_TYPES.arm64, cpuSubtype: 0x81000002 },
  ]);
  const path = await writeFixture(directory, "ambiguous.fat", fixture);
  const result = await resolveHopperMachOImage(
    fat32Target(path, fixture, "arm64"),
  );
  if (result.ok || result.error._tag !== "BinaryTargetError")
    throw new Error(
      "Expected ambiguous FAT selection to return a BinaryTargetError",
    );
  expect(result.error.reason).toContain("selection for arm64 is ambiguous");
});

it("prefers cpusubtype 2 over 12 regardless of FAT32 table order", async () => {
  const directory = await createTestTempDirectory("rea-hopper-fat32-order-");
  const fixture = buildFat32Container([
    { cpuType: CPU_TYPES.arm64, cpuSubtype: ARM64E_X1 },
    { cpuType: CPU_TYPES.arm64, cpuSubtype: ARM64E },
  ]);
  const path = await writeFixture(directory, "reordered.fat", fixture);
  const result = requireResolved(
    await resolveHopperMachOImage(fat32Target(path, fixture, "arm64")),
  );
  expect(result).toMatchObject({
    cpu_subtype: ARM64E,
    source_offset: fixture.sliceOffsets[1],
  });
});

it("prefers a plain arm64 slice over arm64e in a FAT32 container", async () => {
  const directory = await createTestTempDirectory("rea-hopper-fat32-plain-");
  const fixture = buildFat32Container([
    { cpuType: CPU_TYPES.arm64, cpuSubtype: 0 },
    { cpuType: CPU_TYPES.arm64, cpuSubtype: ARM64E },
  ]);
  const path = await writeFixture(directory, "plain.fat", fixture);
  const result = requireResolved(
    await resolveHopperMachOImage(fat32Target(path, fixture, "arm64")),
  );
  expect(result).toMatchObject({
    cpu_subtype: 0,
    source_offset: fixture.sliceOffsets[0],
  });
});

it("keeps a lone arm64e.x1 FAT32 slice selectable to preserve today's open behavior", async () => {
  const directory = await createTestTempDirectory("rea-hopper-fat32-lone-");
  const fixture = buildFat32Container([
    { cpuType: CPU_TYPES.arm64, cpuSubtype: ARM64E_X1 },
  ]);
  const path = await writeFixture(directory, "lone.fat", fixture);
  const result = requireResolved(
    await resolveHopperMachOImage(fat32Target(path, fixture, "arm64")),
  );
  expect(result).toMatchObject({ cpu_subtype: ARM64E_X1 });
});

it("still fails closed when two arm64e.x1 FAT32 slices compete", async () => {
  const directory = await createTestTempDirectory("rea-hopper-fat32-ambig-");
  const fixture = buildFat32Container([
    { cpuType: CPU_TYPES.arm64, cpuSubtype: ARM64E_X1 },
    { cpuType: CPU_TYPES.arm64, cpuSubtype: ARM64E_X1 },
  ]);
  const path = await writeFixture(directory, "ambiguous.fat", fixture);
  const result = await resolveHopperMachOImage(
    fat32Target(path, fixture, "arm64"),
  );
  if (result.ok) throw new Error("Ambiguous FAT32 selection succeeded");
  expect(
    projectAnalysisError(result.error).details?.reason ?? result.error,
  ).toMatch(/selection.*ambiguous/u);
});

it("selects the single x86_64 slice of a FAT32 container for an x86_64 target", async () => {
  const directory = await createTestTempDirectory("rea-hopper-fat32-intel-");
  const fixture = buildFat32Container([
    { cpuType: CPU_TYPES.arm64, cpuSubtype: ARM64E },
    { cpuType: CPU_TYPES.x86_64, cpuSubtype: 3 },
  ]);
  const path = await writeFixture(directory, "universal.fat", fixture);
  const result = requireResolved(
    await resolveHopperMachOImage(fat32Target(path, fixture, "x86_64")),
  );
  expect(result).toMatchObject({
    cpu_type: CPU_TYPES.x86_64,
    cpu_subtype: 3,
    source_offset: fixture.sliceOffsets[1],
  });
});

it("parses a little-endian FAT32 table without tying it to slice byte order", async () => {
  const directory = await createTestTempDirectory("rea-hopper-fat32-le-");
  const fixture = buildFat32Container(
    [
      { cpuType: CPU_TYPES.x86_64, cpuSubtype: 3 },
      { cpuType: CPU_TYPES.arm64, cpuSubtype: ARM64E },
      { cpuType: CPU_TYPES.arm64, cpuSubtype: ARM64E_X1 },
    ],
    { littleEndianTable: true },
  );
  const path = await writeFixture(directory, "little.fat", fixture);
  const result = requireResolved(
    await resolveHopperMachOImage(fat32Target(path, fixture, "arm64")),
  );
  expect(result).toMatchObject({
    method: "fat32_thin_slice",
    cpu_subtype: ARM64E,
    source_offset: fixture.sliceOffsets[1],
  });
});

it("rejects a FAT32 slice whose declared range extends beyond the file", async () => {
  const directory = await createTestTempDirectory("rea-hopper-fat32-range-");
  const fixture = buildFat32Container([
    { cpuType: CPU_TYPES.arm64, cpuSubtype: ARM64E },
  ]);
  fixture.container.writeUInt32BE(fixture.container.length + 16, 8 + 12);
  const path = await writeFixture(directory, "overrange.fat", fixture);
  const result = await resolveHopperMachOImage(
    fat32Target(path, fixture, "arm64"),
  );
  if (result.ok) throw new Error("An overranging FAT32 slice was accepted");
  expect(
    projectAnalysisError(result.error).details?.reason ?? result.error,
  ).toMatch(/extends beyond the file/u);
});

it("copies exactly the selected FAT32 slice bytes and verifies the source", async () => {
  const directory = await createTestTempDirectory("rea-hopper-fat32-copy-");
  const fixture = buildFat32Container([
    { cpuType: CPU_TYPES.x86_64, cpuSubtype: 3 },
    { cpuType: CPU_TYPES.arm64, cpuSubtype: ARM64E },
    { cpuType: CPU_TYPES.arm64, cpuSubtype: ARM64E_X1 },
  ]);
  const path = await writeFixture(directory, "system.fat", fixture);
  const target = fat32Target(path, fixture, "arm64");
  const resolved = requireResolved(await resolveHopperMachOImage(target));
  const destination = join(directory, "image.macho");
  const prepared = await prepareHopperMachOImage(
    path,
    target.sha256,
    resolved,
    destination,
  );
  if (!prepared.ok) throw new Error(prepared.error.userMessage);
  const arm64eOffset = fixture.sliceOffsets[1]!;
  const copied = fixture.container.subarray(
    arm64eOffset,
    arm64eOffset + FAT32_SLICE_SIZE,
  );
  expect(await readFile(destination)).toEqual(copied);
});

it("rejects FAT32 preparation when the source table changed after resolution", async () => {
  const directory = await createTestTempDirectory("rea-hopper-fat32-race-");
  const fixture = buildFat32Container([
    { cpuType: CPU_TYPES.arm64, cpuSubtype: ARM64E },
    { cpuType: CPU_TYPES.arm64, cpuSubtype: ARM64E_X1 },
  ]);
  const path = await writeFixture(directory, "system.fat", fixture);
  const target = fat32Target(path, fixture, "arm64");
  const resolved = requireResolved(await resolveHopperMachOImage(target));
  const mutated = Buffer.from(fixture.container);
  mutated.writeUInt32BE(0x01000007, 8);
  await writeFile(path, mutated);
  const destination = join(directory, "image.macho");
  const prepared = await prepareHopperMachOImage(
    path,
    target.sha256,
    resolved,
    destination,
  );
  if (prepared.ok)
    throw new Error("A mutated FAT32 source passed verification");
  expect(prepared.error.userMessage).toMatch(/no longer agrees/u);
});
