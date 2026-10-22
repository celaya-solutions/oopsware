import { mkdir, open, readFile, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createPackage } from "@electron/asar";
import { expect, it, vi } from "vitest";

import {
  admitAsarHeader,
  MAX_ASAR_HEADER_BYTES,
} from "../../../src/artifacts/AsarHeader.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const createFixture = async () => {
  const root = await createTestTempDirectory("rea-asar-header-admission-");
  const source = join(root, "source");
  const archive = join(root, "fixture.asar");
  await mkdir(source);
  await writeFile(join(source, "main.js"), "export const answer = 42;\n");
  await createPackage(source, archive);
  return { archive, original: await readFile(archive) };
};

const admit = async (path: string) => {
  const handle = await open(path, "r");
  const read = vi.spyOn(handle, "read");
  try {
    return await admitAsarHeader(handle);
  } finally {
    // Admission must inspect only the fixed prefix, even for forged extents.
    const calls = [...read.mock.calls];
    const results = await Promise.all(
      read.mock.results.map(
        ({ value }) => value as Promise<{ readonly bytesRead: number }>,
      ),
    );
    read.mockRestore();
    await handle.close();
    expect(handle.fd).toBe(-1);
    expect(calls.length).toBeGreaterThan(0);
    let filled = 0;
    for (const [index, call] of calls.entries()) {
      const [buffer, offset, length, position]: readonly unknown[] =
        call as unknown as readonly unknown[];
      expect(buffer).toBeInstanceOf(Buffer);
      expect(offset).toBe(filled);
      expect(position).toBe(filled);
      expect(length).toBe(16 - filled);
      filled += results[index]!.bytesRead;
    }
    expect(filled).toBeLessThanOrEqual(16);
  }
};

it("admits a header produced by the upstream ASAR serializer", async () => {
  const { archive, original } = await createFixture();
  await expect(admit(archive)).resolves.toEqual({
    archiveBytes: original.length,
    headerBytes: original.readUInt32LE(4),
    jsonBytes: original.readUInt32LE(12),
  });
  expect(await readFile(archive)).toEqual(original);
});

it("rejects every truncated prefix of a real serialized header", async () => {
  const { archive, original } = await createFixture();
  const headerEnd = 8 + original.readUInt32LE(4);
  for (let length = 0; length < headerEnd; length++) {
    await writeFile(archive, original.subarray(0, length));
    await expect(
      admit(archive),
      `truncated at byte ${length}`,
    ).rejects.toMatchObject({
      reason: "format",
    });
  }
  // Member data is outside header admission; an intact header still passes.
  await writeFile(archive, original.subarray(0, headerEnd));
  await expect(admit(archive)).resolves.toMatchObject({
    archiveBytes: headerEnd,
  });
});

it("rejects contradictory and unsigned-boundary extents before decoding", async () => {
  const { archive, original } = await createFixture();
  const mutations = [
    { offset: 0, values: [0, 1, 3, 5, 0xffffffff] },
    { offset: 4, values: [0, 4, 7, original.length, 0x80000000, 0xffffffff] },
    { offset: 8, values: [0, 1, original.readUInt32LE(8) + 4, 0xffffffff] },
    { offset: 12, values: [original.readUInt32LE(8), 0x80000000, 0xffffffff] },
  ];
  for (const { offset, values } of mutations) {
    for (const value of values) {
      const bytes = Buffer.from(original);
      bytes.writeUInt32LE(value, offset);
      await writeFile(archive, bytes);
      await expect(
        admit(archive),
        `uint32 at ${offset} = ${value}`,
      ).rejects.toMatchObject({
        reason: "format",
      });
    }
  }
});

it("separates the header decode budget from container validity at its exact boundary", async () => {
  const root = await createTestTempDirectory("rea-asar-header-budget-");
  const archive = join(root, "budget.asar");
  expect(MAX_ASAR_HEADER_BYTES).toBe(16 * 1024 * 1024);
  for (const headerBytes of [
    MAX_ASAR_HEADER_BYTES,
    MAX_ASAR_HEADER_BYTES + 4,
  ]) {
    const prefix = Buffer.alloc(16);
    prefix.writeUInt32LE(4, 0);
    prefix.writeUInt32LE(headerBytes, 4);
    prefix.writeUInt32LE(headerBytes - 4, 8);
    prefix.writeUInt32LE(2, 12);
    await writeFile(archive, prefix);
    // Supply the declared extent without allocating a header-sized JS buffer.
    // This tests extent admission only; the padding is not valid archive JSON.
    await truncate(archive, headerBytes + 8);
    if (headerBytes === MAX_ASAR_HEADER_BYTES)
      await expect(admit(archive)).resolves.toEqual({
        archiveBytes: headerBytes + 8,
        headerBytes,
        jsonBytes: 2,
      });
    else
      await expect(admit(archive)).rejects.toMatchObject({ reason: "limit" });
  }
});
