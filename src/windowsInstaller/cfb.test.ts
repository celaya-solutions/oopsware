import { randomBytes } from "node:crypto";
import {
  copyFile,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CfbFormatError, CompoundFile, type CfbEntry } from "./cfb.js";
import { MsiDatabase } from "./msi/database.js";
import {
  buildCoverageFixtures,
  COVERAGE_READY,
  exec,
  MSIBUILD,
  type CoverageFixtures,
} from "./msi/msi.fixture.js";
import { decodeMsiStreamName, encodeMsiStreamName } from "./msi/streamNames.js";
import {
  buildWindowsFixtures,
  WINDOWS_TOOLS,
  windowsOracle,
  type WindowsFixtures,
} from "../../tests/fixtures/windowsProducers.js";
import { removeTestWorkspace } from "../../tests/support/workspace/workspaceFixture.js";

/**
 * The compound file reader against 7-Zip's Compound handler: every stream's
 * name, size, mini/regular placement (Packed Size), order and bytes, for
 * MSIs written by wixl, rewritten by msibuild and repacked by libgsf with
 * 4096-byte sectors. Malformed files are real fixture bytes with one
 * documented edit each, placed from the header, FAT and directory as read
 * here straight from the bytes.
 */

interface Built {
  readonly windows: WindowsFixtures;
  readonly coverage: CoverageFixtures;
}

let root: string | undefined;
let building: Promise<Built> | undefined;

const built = (): Promise<Built> => {
  building ??= (async () => {
    root = await realpath(
      await mkdtemp(join(await realpath(tmpdir()), "rea-cfb-")),
    );
    const windows = await buildWindowsFixtures(join(root, "windows"));
    return {
      windows,
      coverage: await buildCoverageFixtures(
        join(root, "coverage"),
        windows.msi,
      ),
    };
  })();
  return building;
};

afterAll(async () => {
  if (root !== undefined) await removeTestWorkspace(root);
});

const reader = (bytes: Uint8Array) => (offset: number, length: number) =>
  Promise.resolve(bytes.subarray(offset, offset + length));

const open = (bytes: Uint8Array): Promise<CompoundFile> =>
  CompoundFile.open(reader(bytes), bytes.length);

const all = async (file: CompoundFile, entry: CfbEntry): Promise<Buffer> => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of file.stream(entry)) chunks.push(chunk);
  return Buffer.concat(chunks);
};

/** 7-Zip's display name: MSI-encoded code units decoded ("!" for the table marker), control characters as [n]. */
const sevenZipName = (name: string): string =>
  [...name]
    .map((character) => {
      const unit = character.charCodeAt(0);
      if (unit === 0x4840) return "!";
      if (unit >= 0x3800 && unit < 0x4840)
        return decodeMsiStreamName(character).name;
      return unit < 0x20 ? `[${String(unit)}]` : character;
    })
    .join("");

interface Listing {
  readonly cluster: number;
  readonly items: readonly {
    readonly path: string;
    readonly size: number;
    readonly packed: number;
  }[];
}

const sevenZipListing = async (path: string): Promise<Listing> => {
  const text = (
    await windowsOracle("7zz", ["l", "-slt", "-tCompound", path])
  ).toString("utf8");
  const [head = "", body = ""] = text.split("\n----------\n");
  const items = body
    .split("\n\n")
    .filter((block) => block.includes("Path = "))
    .map((block) => {
      const fields = new Map(
        block
          .split("\n")
          .map((line) => [
            line.slice(0, line.indexOf(" = ")),
            line.slice(line.indexOf(" = ") + 3),
          ]),
      );
      return {
        path: fields.get("Path") ?? "",
        size: Number(fields.get("Size")),
        packed: Number(fields.get("Packed Size")),
      };
    });
  return { cluster: Number(/Cluster Size = (\d+)/u.exec(head)?.[1]), items };
};

const packed = (size: number, sectorSize: number): number =>
  size < 4096
    ? Math.ceil(size / 64) * 64
    : Math.ceil(size / sectorSize) * sectorSize;

const MSI_CLSID = "{000C1084-0000-0000-C000-000000000046}";

describe.skipIf(!COVERAGE_READY)("compound files against 7-Zip", () => {
  beforeAll(async () => {
    await built();
  }, 120_000);

  it("lists every stream with 7-Zip's names, sizes, placement and order", async () => {
    const { windows, coverage } = await built();
    const paths = [
      windows.msi,
      windows.msiExternal,
      coverage.utf8,
      coverage.latin,
      coverage.sql,
      coverage.long,
      coverage.v4,
    ];
    let compared = 0;
    for (const path of paths) {
      const file = await open(await readFile(path));
      const listing = await sevenZipListing(path);
      const streams = file.entries.filter((entry) => entry.type !== "root");
      expect(listing.cluster, path).toBe(file.sectorSize);
      expect(
        streams.map((entry) => ({
          path: entry.path.map(sevenZipName).join("/"),
          size: entry.size,
          packed: packed(entry.size, file.sectorSize),
        })),
        path,
      ).toEqual(listing.items);
      expect(file.entries[0]).toMatchObject({
        type: "root",
        path: [],
        clsid: MSI_CLSID,
        id: 0,
      });
      expect(file.problems, path).toEqual([]);
      compared += streams.length;
    }
    expect(compared).toBeGreaterThan(200);
  });

  it("reads every stream byte for byte as 7-Zip extracts it", async () => {
    const { windows, coverage } = await built();
    let bytes = 0;
    for (const path of [windows.msi, coverage.sql, coverage.v4]) {
      const file = await open(await readFile(path));
      for (const entry of file.entries.filter(
        (candidate) => candidate.type === "stream",
      )) {
        const expected = await windowsOracle("7zz", [
          "e",
          "-so",
          "-tCompound",
          path,
          sevenZipName(entry.name),
        ]);
        const read = await file.read(entry, Number.MAX_SAFE_INTEGER);
        expect(
          Buffer.from(read).equals(expected),
          `${path} ${sevenZipName(entry.name)}`,
        ).toBe(true);
        expect((await all(file, entry)).equals(expected)).toBe(true);
        expect(
          Buffer.from(await file.read(entry, 10)).equals(
            expected.subarray(0, 10),
          ),
        ).toBe(true);
        bytes += expected.length;
      }
    }
    expect(bytes).toBeGreaterThan(3 * 484_000);
  });

  it("reads a version 4 file (4096-byte sectors) written by libgsf like the version 3 original", async () => {
    const { windows, coverage } = await built();
    const original = await open(await readFile(windows.msi));
    const repacked = await open(await readFile(coverage.v4));
    expect([
      original.version,
      original.sectorSize,
      repacked.version,
      repacked.sectorSize,
    ]).toEqual([3, 512, 4, 4096]);
    const names = (file: CompoundFile) =>
      file.entries
        .filter((entry) => entry.type === "stream")
        .map((entry) => entry.name)
        .sort();
    expect(names(repacked)).toEqual(names(original));
    for (const entry of original.entries.filter(
      (candidate) => candidate.type === "stream",
    )) {
      const twin = repacked.entries.find(
        (candidate) => candidate.name === entry.name,
      );
      expect(twin?.size).toBe(entry.size);
      if (twin !== undefined)
        expect(
          Buffer.from(await repacked.read(twin, entry.size)).equals(
            await all(original, entry),
          ),
        ).toBe(true);
    }
  });

  it("encodes every stored stream name back to its stored form (names starting with 0x05 are stored raw or encoded after it)", async () => {
    const { windows, coverage } = await built();
    for (const path of [windows.msi, coverage.sql, coverage.long]) {
      const file = await open(await readFile(path));
      for (const entry of file.entries.filter(
        (candidate) => candidate.type === "stream",
      )) {
        const decoded = decodeMsiStreamName(entry.name);
        const raw = decoded.name.startsWith("\u0005")
          ? `\u0005${encodeMsiStreamName(decoded.name.slice(1), false)}`
          : null;
        expect([
          encodeMsiStreamName(decoded.name, decoded.table),
          decoded.name,
          raw,
        ]).toContain(entry.name);
      }
    }
    expect(decodeMsiStreamName("\u0005SummaryInformation")).toEqual({
      name: "\u0005SummaryInformation",
      table: false,
    });
    expect(encodeMsiStreamName("_Columns", true)).toBe(
      (await open(await readFile(windows.msi))).entries.find(
        (entry) => sevenZipName(entry.name) === "!_Columns",
      )?.name,
    );
  });
});

describe.skipIf(!COVERAGE_READY)(
  "compound files with a DIFAT sector chain",
  () => {
    beforeAll(async () => {
      await built();
    }, 120_000);

    it("follows a DIFAT sector chain (a 9 MB stream msibuild adds needs 147 FAT sectors)", async () => {
      const { windows } = await built();
      if (MSIBUILD === null || root === undefined)
        throw new Error("msibuild is not installed");
      const path = join(root, "difat.msi");
      await copyFile(windows.msi, path);
      const payload = randomBytes(9_000_000);
      await writeFile(join(root, "difat-payload.bin"), payload);
      await exec(MSIBUILD, [
        path,
        "-a",
        "big.bin",
        join(root, "difat-payload.bin"),
      ]);
      const bytes = await readFile(path);
      expect([bytes.readUInt32LE(44), bytes.readUInt32LE(72)]).toEqual([
        147, 1,
      ]);
      const file = await open(bytes);
      const listing = await sevenZipListing(path);
      expect(
        file.entries
          .filter((entry) => entry.type === "stream")
          .map((entry) => [sevenZipName(entry.name), entry.size]),
      ).toEqual(listing.items.map((item) => [item.path, item.size]));
      const big = (await MsiDatabase.open(file)).stream("big.bin");
      if (big === null) throw new Error("big.bin is missing");
      expect(Buffer.from(await file.read(big, big.size)).equals(payload)).toBe(
        true,
      );
      expect(file.problems).toEqual([]);
    });
  },
);

/** Header, FAT and directory read straight from the bytes, to place edits without the reader under test. */
const layout = (bytes: Buffer) => {
  const sectorSize = 1 << bytes.readUInt16LE(30);
  const at = (sector: number): number => (sector + 1) * sectorSize;
  const perFat = sectorSize / 4;
  const fatSectors = Array.from(
    { length: bytes.readUInt32LE(44) },
    (_, index) => bytes.readUInt32LE(76 + index * 4),
  );
  const fatOffset = (sector: number): number =>
    at(fatSectors[Math.floor(sector / perFat)] ?? 0) + (sector % perFat) * 4;
  const chain = (start: number): number[] => {
    const sectors: number[] = [];
    for (
      let sector = start;
      sector !== 0xfffffffe && sectors.length < 100_000;
      sector = bytes.readUInt32LE(fatOffset(sector))
    )
      sectors.push(sector);
    return sectors;
  };
  const directorySectors = chain(bytes.readUInt32LE(48));
  const slots = directorySectors.flatMap((sector) =>
    Array.from(
      { length: sectorSize / 128 },
      (_, index) => at(sector) + index * 128,
    ),
  );
  const entry = (name: string): number => {
    const found = slots.find((slot) => {
      const length = bytes.readUInt16LE(slot + 64);
      return (
        length >= 2 &&
        bytes.toString("utf16le", slot, slot + length - 2) === name
      );
    });
    if (found === undefined) throw new Error(`no directory entry ${name}`);
    return found;
  };
  return { sectorSize, fatOffset, chain, directorySectors, slots, entry };
};

const CAB = encodeMsiStreamName("oops.cab", false);
const STRING_POOL = encodeMsiStreamName("_StringPool", true);

const edited = async (
  edit: (bytes: Buffer, map: ReturnType<typeof layout>) => void,
): Promise<Buffer> => {
  const bytes = Buffer.from(await readFile((await built()).windows.msi));
  edit(bytes, layout(bytes));
  return bytes;
};

describe.skipIf(WINDOWS_TOOLS === null)(
  "malformed compound files from real bytes",
  () => {
    beforeAll(async () => {
      await built();
    }, 120_000);

    it("rejects a file whose signature byte 0 is cleared, and a header cut short", async () => {
      const bytes = await edited((target) => {
        target[0] = 0;
      });
      await expect(open(bytes)).rejects.toMatchObject({
        name: "CfbFormatError",
        offset: 0,
      });
      await expect(open(bytes.subarray(0, 100))).rejects.toBeInstanceOf(
        CfbFormatError,
      );
    });

    it("stops at a FAT cycle in the directory chain (last directory sector's FAT entry set to the first)", async () => {
      const bytes = await edited((target, map) => {
        target.writeUInt32LE(
          map.directorySectors[0] ?? 0,
          map.fatOffset(map.directorySectors.at(-1) ?? 0),
        );
      });
      await expect(open(bytes)).rejects.toThrow(/cycle/u);
    });

    it("marks only the stream whose chain loops (FAT entry of oops.cab's 6th sector set to its 3rd)", async () => {
      const bytes = await edited((target, map) => {
        const chain = map.chain(target.readUInt32LE(map.entry(CAB) + 116));
        target.writeUInt32LE(chain[2] ?? 0, map.fatOffset(chain[5] ?? 0));
      });
      const file = await open(bytes);
      const cab = file.entries.find((entry) => entry.name === CAB);
      expect(file.problems.join("\n")).toMatch(
        /returns to sector \d+ \(a cycle\)/u,
      );
      if (cab === undefined) throw new Error("oops.cab is missing");
      await expect(file.read(cab, 100)).rejects.toBeInstanceOf(CfbFormatError);
      const database = await MsiDatabase.open(file);
      expect(database.table("File")?.rows).toHaveLength(2);
      expect(database.problems.join("\n")).toMatch(
        /^Compound file: Stream \d+ "oops\.cab" chain returns to sector \d+ \(a cycle\)\.$/mu,
      );
    });

    it("names sectors past the end of the file (oops.cab's start sector, then FAT sector 0)", async () => {
      const stream = await open(
        await edited((target, map) => {
          target.writeUInt32LE(0x00ffffff, map.entry(CAB) + 116);
        }),
      );
      expect(stream.problems.join("\n")).toMatch(
        /reaches sector 16777215 after 0 sectors/u,
      );
      const cab = stream.entries.find((entry) => entry.name === CAB);
      if (cab === undefined) throw new Error("oops.cab is missing");
      await expect(stream.read(cab, 1)).rejects.toThrow(/16777215/u);
      const fat = await edited((target) => {
        target.writeUInt32LE(0x00ffffff, 76);
      });
      await expect(open(fat)).rejects.toMatchObject({ offset: 76 });
    });

    it("keeps the rest of the tree when a sibling link points past the directory", async () => {
      const original = await open(await readFile((await built()).windows.msi));
      const bytes = await edited((target, map) => {
        const slot = map.slots.find(
          (candidate) =>
            target[candidate + 66] === 2 &&
            target.readUInt32LE(candidate + 68) === 0xffffffff,
        );
        if (slot !== undefined) target.writeUInt32LE(0x7000, slot + 68);
      });
      const file = await open(bytes);
      expect(file.problems.join("\n")).toMatch(
        /points to entry 28672, past the \d+ entries/u,
      );
      expect(file.entries.map((entry) => entry.name)).toEqual(
        original.entries.map((entry) => entry.name),
      );
    });

    it("breaks mini streams that lie past a shrunken mini stream (root entry size set to 64)", async () => {
      const bytes = await edited((target, map) => {
        target.writeUInt32LE(64, (map.slots[0] ?? 0) + 120);
      });
      const file = await open(bytes);
      expect(file.entries[0]?.size).toBe(64);
      expect(file.problems.join("\n")).toMatch(/the mini stream has 1/u);
      const pool = file.entries.find((entry) => entry.name === STRING_POOL);
      if (pool === undefined) throw new Error("_StringPool is missing");
      await expect(file.read(pool, 10)).rejects.toBeInstanceOf(CfbFormatError);
      await expect(MsiDatabase.open(file)).rejects.toBeInstanceOf(
        CfbFormatError,
      );
    });

    it("refuses a stream size larger than the file (oops.cab's size set to 2^31)", async () => {
      const file = await open(
        await edited((target, map) => {
          target.writeUInt32LE(0x80000000, map.entry(CAB) + 120);
        }),
      );
      expect(file.problems.join("\n")).toMatch(
        /needs 4194304 sectors; the file has \d+/u,
      );
      const cab = file.entries.find((entry) => entry.name === CAB);
      if (cab === undefined) throw new Error("oops.cab is missing");
      await expect(file.read(cab, 1)).rejects.toBeInstanceOf(CfbFormatError);
    });
  },
);
