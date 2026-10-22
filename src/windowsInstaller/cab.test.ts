import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { deflateRawSync, inflateRawSync } from "node:zlib";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CabFormatError,
  CabLimitError,
  CabUnsupportedError,
  Cabinet,
  cabChecksum,
  type CabFile,
} from "./cab.js";
import {
  buildWindowsFixtures,
  README_TEXT,
  windowsOracle,
  WINDOWS_TOOLS,
  type WindowsFixtures,
} from "../../tests/fixtures/windowsProducers.js";
import { removeTestWorkspace } from "../../tests/support/workspace/workspaceFixture.js";

/**
 * The cabinet reader checked against gcab 1.6 and 7-Zip: the F08 fixture
 * cabinets (gcab MSZIP and stored, and the MSZIP cabinet wixl embeds in the
 * MSI), coverage cabinets built here with gcab, and edits of their real
 * bytes for what no producer on this Mac writes (Quantum, LZX, spans,
 * reserve areas, malformed records). gcab writes UTC into the DOS date
 * fields and prints them in the local zone, so it is run with TZ=UTC; 7-Zip
 * prints the stored fields as they are.
 */

const run = promisify(execFile);

let root: string | undefined;
let building: Promise<Built> | undefined;

interface Built {
  readonly fixtures: WindowsFixtures;
  /** The MSI's embedded "oops.cab" stream, extracted by msiinfo. */
  readonly embedded: string;
  /** msiextract's output directory for the MSI. */
  readonly msiFiles: string;
  readonly coverage: { readonly mszip: string; readonly stored: string };
  /** One 100,000-byte member in a stored cabinet: four CFDATA blocks to rearrange. */
  readonly single: string;
  readonly singleBytes: Buffer;
}

/** Deterministic incompressible bytes. */
const noise = (length: number, seed: string): Buffer => {
  const parts: Buffer[] = [];
  for (let index = 0; parts.length * 32 < length; index += 1)
    parts.push(
      createHash("sha256")
        .update(`${seed}:${String(index)}`)
        .digest(),
    );
  return Buffer.concat(parts).subarray(0, length);
};

const COVERAGE_MEMBERS: Readonly<Record<string, Uint8Array | string>> = {
  ...Object.fromEntries(
    Array.from({ length: 40 }, (_, index) => [
      `small-${String(index).padStart(2, "0")}.txt`,
      `small file ${String(index)}\n`,
    ]),
  ),
  empty: "",
  "noise.bin": noise(100_000, "noise"),
  "text.txt": "a line that repeats across MSZIP blocks\n".repeat(2_000),
  "ünï cödé.txt": "unicode name\n",
};

const gcabCreate = async (
  directory: string,
  name: string,
  members: Readonly<Record<string, Uint8Array | string>>,
  compress: boolean,
): Promise<string> => {
  const staging = join(directory, `${name}-members`);
  await mkdir(staging, { recursive: true });
  for (const [member, content] of Object.entries(members))
    await writeFile(join(staging, member), content);
  const output = join(directory, name);
  await windowsOracle(
    "gcab",
    [
      "-c",
      ...(compress ? ["-z"] : []),
      "--nopath",
      output,
      ...Object.keys(members).map((member) => join(staging, member)),
    ],
    staging,
  );
  return output;
};

const built = (): Promise<Built> => {
  building ??= (async () => {
    root = await realpath(
      await mkdtemp(join(await realpath(tmpdir()), "rea-cab-")),
    );
    const fixtures = await buildWindowsFixtures(join(root, "fixtures"));
    const embedded = join(root, "embedded.cab");
    await writeFile(
      embedded,
      await windowsOracle("msiinfo", ["extract", fixtures.msi, "oops.cab"]),
    );
    const msiFiles = join(root, "msiextract");
    await mkdir(msiFiles);
    await windowsOracle("msiextract", ["-C", msiFiles, fixtures.msi]);
    const coverage = join(root, "coverage");
    const singleBytes = noise(100_000, "single");
    return {
      fixtures,
      embedded,
      msiFiles,
      coverage: {
        mszip: await gcabCreate(coverage, "mszip.cab", COVERAGE_MEMBERS, true),
        stored: await gcabCreate(
          coverage,
          "stored.cab",
          COVERAGE_MEMBERS,
          false,
        ),
      },
      single: await gcabCreate(
        coverage,
        "single.cab",
        { "a.bin": singleBytes },
        false,
      ),
      singleBytes,
    };
  })();
  return building;
};

afterAll(async () => {
  if (root !== undefined) await removeTestWorkspace(root);
});

const memory = (bytes: Uint8Array) => async (offset: number, length: number) =>
  bytes.subarray(offset, offset + length);

const openBytes = (bytes: Uint8Array): Promise<Cabinet> =>
  Cabinet.open(memory(bytes), bytes.length);

const openPath = async (path: string): Promise<Cabinet> =>
  openBytes(await readFile(path));

const collect = async (
  cabinet: Cabinet,
  file: CabFile,
  limit = 2 ** 31,
  signal?: AbortSignal,
): Promise<Buffer> => {
  const parts: Uint8Array[] = [];
  for await (const part of cabinet.read(file, limit, signal)) parts.push(part);
  return Buffer.concat(parts);
};

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const byName = (cabinet: Cabinet, name: string): CabFile => {
  const file = cabinet.files.find((entry) => entry.name === name);
  if (file === undefined) throw new Error(`No "${name}" in the cabinet.`);
  return file;
};

/** `gcab -l -v` under TZ=UTC: name, size, stored date-time and attribute word per file. */
const gcabListing = async (path: string) => {
  const { stdout } = await run(
    WINDOWS_TOOLS?.gcab ?? "gcab",
    ["-l", "-v", path],
    {
      env: { PATH: "/opt/homebrew/bin:/usr/bin:/bin", TZ: "UTC", LC_ALL: "C" },
    },
  );
  return stdout
    .trimEnd()
    .split("\n")
    .map((line) => {
      const match =
        /^(.*) (\d+) (\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) 0x([0-9A-F]+)$/iu.exec(
          line,
        );
      if (match === null) throw new Error(`Unexpected gcab line: ${line}`);
      return {
        name: match[1],
        size: Number(match[2]),
        date: `${match[3] ?? ""}T${match[4] ?? ""}`,
        attribute_bits: Number.parseInt(match[5] ?? "", 16),
      };
    });
};

/** `7zz l -slt` records after the archive's own block. */
const sevenZipListing = async (path: string) => {
  const text = (await windowsOracle("7zz", ["l", "-slt", path])).toString(
    "utf8",
  );
  const records = (text.split("----------\n")[1] ?? "")
    .split("\n\n")
    .map((block) =>
      Object.fromEntries(
        block
          .split("\n")
          .filter((line) => line.includes(" = "))
          .map((line) => [
            line.slice(0, line.indexOf(" = ")),
            line.slice(line.indexOf(" = ") + 3),
          ]),
      ),
    )
    .filter((record) => record.Path !== undefined);
  return records as {
    Path: string;
    Size: string;
    Modified: string;
    Attributes: string;
    Method: string;
  }[];
};

/** 7-Zip's Method column for a folder. */
const sevenZipMethod = (cabinet: Cabinet, file: CabFile): string => {
  const folder = cabinet.folders[file.folder];
  if (folder === undefined) throw new Error("no folder");
  if (folder.compression === "none") return "None";
  if (folder.compression === "mszip") return "MSZip";
  const bits = Math.log2(folder.window ?? 1);
  return folder.compression === "lzx"
    ? `LZX:${String(bits)}`
    : folder.compression === "quantum"
      ? `Quantum:${String(bits)}`
      : String(folder.type_compress);
};

const expectListingMatchesOracles = async (path: string): Promise<Cabinet> => {
  const cabinet = await openPath(path);
  expect(cabinet.problems).toEqual([]);
  expect(cabinet.version).toBe("1.3");
  expect(
    cabinet.files.map(({ name, size, date, attribute_bits }) => ({
      name,
      size,
      date,
      attribute_bits,
    })),
  ).toEqual(await gcabListing(path));
  expect(
    (await sevenZipListing(path)).map((record) => ({
      Path: record.Path,
      Size: record.Size,
      Modified: record.Modified,
      Method: record.Method,
    })),
  ).toEqual(
    cabinet.files.map((file) => ({
      Path: file.name,
      Size: String(file.size),
      Modified: (file.date ?? "").replace("T", " "),
      Method: sevenZipMethod(cabinet, file),
    })),
  );
  return cabinet;
};

const useFixtures = () => {
  beforeAll(async () => {
    await built();
  }, 120_000);
};

describe.skipIf(WINDOWS_TOOLS === null)(
  "cabinets listed as gcab and 7-Zip list them",
  () => {
    useFixtures();

    it.each([
      ["the fixture MSZIP cabinet", (b: Built) => b.fixtures.cabinet, "mszip"],
      [
        "the fixture stored cabinet",
        (b: Built) => b.fixtures.cabinetStored,
        "none",
      ],
      ["the cabinet wixl embeds in the MSI", (b: Built) => b.embedded, "mszip"],
      [
        "the gcab coverage cabinet, MSZIP",
        (b: Built) => b.coverage.mszip,
        "mszip",
      ],
      [
        "the gcab coverage cabinet, stored",
        (b: Built) => b.coverage.stored,
        "none",
      ],
    ] as const)("%s", async (_, pick, compression) => {
      const cabinet = await expectListingMatchesOracles(pick(await built()));
      expect(cabinet.folders.map((folder) => folder.compression)).toEqual([
        compression,
      ]);
      expect(cabinet.folders[0]?.window).toBe(
        compression === "mszip" ? 32_768 : null,
      );
      expect(cabinet.previous).toBeNull();
      expect(cabinet.next).toBeNull();
      expect(cabinet.reserve).toBeNull();
      expect(cabinet.files.every((file) => file.continued === "none")).toBe(
        true,
      );
    });

    it("records gcab's attribute bits: archive always, name-is-utf8 for a non-ASCII name", async () => {
      const cabinet = await openPath((await built()).coverage.mszip);
      expect(byName(cabinet, "noise.bin").attributes).toEqual(["archive"]);
      expect(byName(cabinet, "ünï cödé.txt").attributes).toEqual([
        "archive",
        "name-is-utf8",
      ]);
      expect(byName(cabinet, "ünï cödé.txt").attribute_bits).toBe(0xa0);
    });

    it("names every attribute bit gcab prints (0x67 written into a real record)", async () => {
      const bytes = Buffer.from(
        await readFile((await built()).fixtures.cabinet),
      );
      const first = (await openBytes(bytes)).files[0];
      if (first === undefined) throw new Error("no file");
      bytes.writeUInt16LE(0x67, first.record_offset + 14);
      const path = join(root ?? "", "attributes.cab");
      await writeFile(path, bytes);
      const cabinet = await openPath(path);
      expect(cabinet.files[0]?.attributes).toEqual([
        "readonly",
        "hidden",
        "system",
        "archive",
        "exec",
      ]);
      expect(cabinet.files[0]?.attribute_bits).toBe(
        (await gcabListing(path))[0]?.attribute_bits,
      );
    });
  },
);

describe.skipIf(WINDOWS_TOOLS === null)(
  "cabinet bytes match gcab -x and msiextract",
  () => {
    useFixtures();

    it.each([
      ["fixture MSZIP", (b: Built) => b.fixtures.cabinet],
      ["fixture stored", (b: Built) => b.fixtures.cabinetStored],
      ["coverage MSZIP", (b: Built) => b.coverage.mszip],
      ["coverage stored", (b: Built) => b.coverage.stored],
    ] as const)(
      "every %s member, CFDATA checksums verified on the way",
      async (label, pick) => {
        const path = pick(await built());
        const output = join(root ?? "", `gcab-x-${label.replace(" ", "-")}`);
        await mkdir(output, { recursive: true });
        await windowsOracle("gcab", ["-x", "-C", output, path]);
        const cabinet = await openPath(path);
        const bytes = await readFile(path);
        // gcab writes a checksum into every block, so each read above checked one.
        const firstBlock = cabinet.folders[0]?.data_offset ?? 0;
        expect(bytes.readUInt32LE(firstBlock)).not.toBe(0);
        for (const file of cabinet.files)
          expect(sha256(await collect(cabinet, file)), file.name).toBe(
            sha256(await readFile(join(output, file.name))),
          );
      },
    );

    it("decodes the MSI's embedded cabinet to msiextract's installed files", async () => {
      const { embedded, msiFiles } = await built();
      const cabinet = await openPath(embedded);
      // The member names are the MSI File keys from the fixture's WiX source.
      expect(cabinet.files.map((file) => file.name)).toEqual([
        "ToolExe",
        "ReadmeTxt",
      ]);
      expect(sha256(await collect(cabinet, byName(cabinet, "ToolExe")))).toBe(
        sha256(await readFile(join(msiFiles, "Oops/tool.exe"))),
      );
      expect(
        (await collect(cabinet, byName(cabinet, "ReadmeTxt"))).toString(),
      ).toBe(README_TEXT);
      expect(await readFile(join(msiFiles, "Oops/readme.txt"), "utf8")).toBe(
        README_TEXT,
      );
    });

    it("reads the same bytes in order, out of order and from MSZIP or stored folders", async () => {
      const { coverage } = await built();
      const mszip = await openPath(coverage.mszip);
      const stored = await openPath(coverage.stored);
      const forward = [];
      for (const file of mszip.files)
        forward.push(sha256(await collect(mszip, file)));
      const backward = [];
      for (const file of [...mszip.files].reverse())
        backward.push(sha256(await collect(mszip, file)));
      expect(backward.reverse()).toEqual(forward);
      const fromStored = [];
      for (const file of stored.files)
        fromStored.push(sha256(await collect(stored, file)));
      expect(fromStored).toEqual(forward);
      expect(byName(mszip, "empty").size).toBe(0);
      expect(await collect(mszip, byName(mszip, "empty"))).toHaveLength(0);
      // 100,000 bytes span four 32 KiB blocks.
      expect(sha256(await collect(mszip, byName(mszip, "noise.bin")))).toBe(
        sha256(COVERAGE_MEMBERS["noise.bin"] as Uint8Array),
      );
    });

    it("bounds the bytes a read decodes, and stops when aborted", async () => {
      const { fixtures } = await built();
      const mszip = await openPath(fixtures.cabinet);
      const readme = byName(mszip, "ReadmeTxt");
      // MSZIP decodes the folder from its start: ToolExe's 944,632 bytes come first.
      expect(mszip.decodedBytes(readme)).toBe(944_632 + 10);
      await expect(collect(mszip, readme, 944_641)).rejects.toBeInstanceOf(
        CabLimitError,
      );
      expect((await collect(mszip, readme, 944_642)).toString()).toBe(
        README_TEXT,
      );
      const stored = await openPath(fixtures.cabinetStored);
      expect(stored.decodedBytes(byName(stored, "ReadmeTxt"))).toBe(10);
      expect(
        (await collect(stored, byName(stored, "ReadmeTxt"), 10)).toString(),
      ).toBe(README_TEXT);
      const controller = new AbortController();
      controller.abort();
      await expect(
        collect(mszip, byName(mszip, "ToolExe"), 2 ** 31, controller.signal),
      ).rejects.toMatchObject({ name: "AbortError" });
    });
  },
);

/** Raw CFDATA records (header and data, no reserve) of folder 0 of a cabinet without reserves. */
const rawBlocks = (bytes: Buffer): Buffer[] => {
  let at = bytes.readUInt32LE(36);
  const blocks: Buffer[] = [];
  for (let index = 0; index < bytes.readUInt16LE(40); index += 1) {
    const length = 8 + bytes.readUInt16LE(at + 4);
    blocks.push(Buffer.from(bytes.subarray(at, at + length)));
    at += length;
  }
  return blocks;
};

interface LayoutFile {
  readonly name: string;
  readonly size: number;
  readonly offset: number;
  /** iFolder as stored, including 0xFFFD-0xFFFF. */
  readonly folder: number;
}

/** A cabinet laid out by hand from [MS-CAB] 2.1-2.4 around real CFDATA records; reserve bytes are filler. */
const layoutCabinet = (layout: {
  readonly previous?: readonly [string, string];
  readonly next?: readonly [string, string];
  readonly reserve?: {
    readonly header: number;
    readonly folder: number;
    readonly data: number;
  };
  readonly type: number;
  readonly blocks: readonly Buffer[];
  readonly files: readonly LayoutFile[];
}): Buffer => {
  const { previous, next, reserve } = layout;
  const flags = (previous ? 1 : 0) | (next ? 2 : 0) | (reserve ? 4 : 0);
  const reserveArea = reserve
    ? Buffer.concat([
        Buffer.from([
          reserve.header & 0xff,
          reserve.header >> 8,
          reserve.folder,
          reserve.data,
        ]),
        Buffer.alloc(reserve.header, 0xcc),
      ])
    : Buffer.alloc(0);
  const names = Buffer.from(
    [...(previous ?? []), ...(next ?? [])].map((name) => `${name}\0`).join(""),
    "latin1",
  );
  const folderAt = 36 + reserveArea.length + names.length;
  const filesAt = folderAt + 8 + (reserve?.folder ?? 0);
  const fileTable = Buffer.concat(
    layout.files.map((file) => {
      const record = Buffer.alloc(16);
      record.writeUInt32LE(file.size, 0);
      record.writeUInt32LE(file.offset, 4);
      record.writeUInt16LE(file.folder, 8);
      record.writeUInt16LE(0x5d54, 10);
      record.writeUInt16LE(0x9392, 12);
      record.writeUInt16LE(0x20, 14);
      return Buffer.concat([record, Buffer.from(`${file.name}\0`, "latin1")]);
    }),
  );
  const dataAt = filesAt + fileTable.length;
  const data = Buffer.concat(
    layout.blocks.map((block) =>
      Buffer.concat([
        block.subarray(0, 8),
        Buffer.alloc(reserve?.data ?? 0, 0xee),
        block.subarray(8),
      ]),
    ),
  );
  const folder = Buffer.alloc(8 + (reserve?.folder ?? 0), 0xdd);
  folder.writeUInt32LE(dataAt, 0);
  folder.writeUInt16LE(layout.blocks.length, 4);
  folder.writeUInt16LE(layout.type, 6);
  const header = Buffer.alloc(36);
  header.write("MSCF", 0, "latin1");
  header.writeUInt32LE(dataAt + data.length, 8);
  header.writeUInt32LE(filesAt, 16);
  header.writeUInt8(3, 24);
  header.writeUInt8(1, 25);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(layout.files.length, 28);
  header.writeUInt16LE(flags, 30);
  header.writeUInt16LE(0x1234, 32);
  header.writeUInt16LE(1, 34);
  return Buffer.concat([header, reserveArea, names, folder, fileTable, data]);
};

describe.skipIf(WINDOWS_TOOLS === null)(
  "cabinet sets and reserve areas (hand-laid around gcab's blocks)",
  () => {
    useFixtures();

    it("lists files continued across cabinets and reads only the one held here", async () => {
      const { single, singleBytes } = await built();
      const bytes = layoutCabinet({
        previous: ["oops1.cab", "Disk 1"],
        next: ["oops3.cab", "Disk 3"],
        reserve: { header: 20, folder: 4, data: 8 },
        type: 0,
        blocks: rawBlocks(await readFile(single)),
        files: [
          { name: "from-previous.bin", size: 1_000, offset: 0, folder: 0xfffd },
          { name: "whole.bin", size: 50_000, offset: 1_000, folder: 0 },
          { name: "to-next.bin", size: 60_000, offset: 51_000, folder: 0xfffe },
        ],
      });
      const cabinet = await openBytes(bytes);
      expect(cabinet.problems).toEqual([]);
      expect(cabinet.previous).toEqual({
        cabinet: "oops1.cab",
        disk: "Disk 1",
      });
      expect(cabinet.next).toEqual({ cabinet: "oops3.cab", disk: "Disk 3" });
      expect(cabinet.reserve).toEqual({ header: 20, folder: 4, data: 8 });
      expect([cabinet.set_id, cabinet.set_index]).toEqual([0x1234, 1]);
      expect(
        cabinet.files.map((file) => [file.name, file.folder, file.continued]),
      ).toEqual([
        ["from-previous.bin", 0, "from-previous"],
        ["whole.bin", 0, "none"],
        ["to-next.bin", 0, "to-next"],
      ]);
      // gcab's checksums cover data plus cbData/cbUncomp, not the inserted data reserve.
      expect(await collect(cabinet, byName(cabinet, "whole.bin"))).toEqual(
        singleBytes.subarray(1_000, 51_000),
      );
      await expect(
        collect(cabinet, byName(cabinet, "to-next.bin")),
      ).rejects.toBeInstanceOf(CabUnsupportedError);
      await expect(
        collect(cabinet, byName(cabinet, "from-previous.bin")),
      ).rejects.toMatchObject({
        feature: "cabinet span",
        message: expect.stringContaining('"oops1.cab"') as unknown,
      });
    });

    it("refuses a folder's last block split into the next cabinet", async () => {
      const { single } = await built();
      const blocks = rawBlocks(await readFile(single));
      const last = blocks.at(-1);
      if (last === undefined) throw new Error("no blocks");
      // A split block's first part has cbUncomp 0; csum 0 means "not supplied".
      last.writeUInt16LE(0, 6);
      last.writeUInt32LE(0, 0);
      const cabinet = await openBytes(
        layoutCabinet({
          next: ["oops2.cab", "Disk 2"],
          type: 0,
          blocks,
          files: [{ name: "tail.bin", size: 2_000, offset: 98_000, folder: 0 }],
        }),
      );
      await expect(
        collect(cabinet, byName(cabinet, "tail.bin")),
      ).rejects.toMatchObject({
        name: "CabUnsupportedError",
        feature: "cabinet span",
      });
    });

    it.each([
      { type: 0x1503, compression: "lzx", level: null, method: "LZX:21" },
      { type: 0x1542, compression: "quantum", level: 4, method: "Quantum:21" },
    ] as const)(
      "lists a typeCompress $type folder ($compression) as 7-Zip does and refuses to decode it",
      async ({ type, compression, level, method }) => {
        const bytes = Buffer.from(
          await readFile((await built()).fixtures.cabinet),
        );
        // CFFOLDER 0 starts at 36 when the header has no reserve or links; typeCompress is its last u16.
        bytes.writeUInt16LE(type, 42);
        const path = join(root ?? "", `${compression}.cab`);
        await writeFile(path, bytes);
        const cabinet = await expectListingMatchesOracles(path);
        expect(cabinet.folders[0]).toMatchObject({
          compression,
          window: 2 ** 21,
          level,
          type_compress: type,
        });
        expect((await sevenZipListing(path))[0]?.Method).toBe(method);
        await expect(
          collect(cabinet, byName(cabinet, "ReadmeTxt")),
        ).rejects.toMatchObject({
          name: "CabUnsupportedError",
          feature: `compression ${compression}`,
        });
      },
    );

    it("names an undefined compression type and refuses it", async () => {
      const bytes = Buffer.from(
        await readFile((await built()).fixtures.cabinet),
      );
      bytes.writeUInt16LE(9, 42);
      const cabinet = await openBytes(bytes);
      expect(cabinet.folders[0]?.compression).toBe("unknown-9");
      await expect(
        collect(cabinet, byName(cabinet, "ReadmeTxt")),
      ).rejects.toBeInstanceOf(CabUnsupportedError);
    });
  },
);

/**
 * MSZIP CFDATA records made with node:zlib, each block deflated with the
 * previous 32 KiB of output as its preset dictionary, as cabinet.dll's
 * compressor does and gcab's does not; checksums from `cabChecksum`.
 */
const mszipBlocks = (data: Buffer): Buffer[] => {
  const blocks: Buffer[] = [];
  let history = Buffer.alloc(0);
  for (let at = 0; at < data.length; at += 32_768) {
    const block = data.subarray(at, at + 32_768);
    const body = Buffer.concat([
      Buffer.from("CK", "latin1"),
      deflateRawSync(block, history.length > 0 ? { dictionary: history } : {}),
    ]);
    const header = Buffer.alloc(8);
    header.writeUInt16LE(body.length, 4);
    header.writeUInt16LE(block.length, 6);
    header.writeUInt32LE(
      cabChecksum(header.subarray(4), cabChecksum(body, 0)),
      0,
    );
    blocks.push(Buffer.concat([header, body]));
    history = Buffer.concat([history, block]).subarray(-32_768);
  }
  return blocks;
};

describe.skipIf(WINDOWS_TOOLS === null)("MSZIP history across blocks", () => {
  useFixtures();

  it("decodes blocks that reach into the previous block, as 7-Zip and gcab do", async () => {
    // A 20,480-byte run repeated: every later block copies from the one before it.
    const data = Buffer.concat(
      Array.from({ length: 5 }, () => noise(20_480, "history")),
    ).subarray(0, 100_000);
    const blocks = mszipBlocks(data);
    expect(() =>
      inflateRawSync(blocks[1]?.subarray(10) ?? Buffer.alloc(0)),
    ).toThrow(/too far back/u);
    const path = join(root ?? "", "history.cab");
    await writeFile(
      path,
      layoutCabinet({
        type: 1,
        blocks,
        files: [
          { name: "history.bin", size: data.length, offset: 0, folder: 0 },
        ],
      }),
    );
    // Both oracles check CFDATA checksums: 7-Zip reports "Data Error", gcab "incorrect checksum".
    expect((await windowsOracle("7zz", ["t", path])).toString()).toContain(
      "Everything is Ok",
    );
    expect(sha256(await windowsOracle("7zz", ["x", "-so", path]))).toBe(
      sha256(data),
    );
    const output = join(root ?? "", "history-x");
    await mkdir(output);
    await windowsOracle("gcab", ["-x", "-C", output, path]);
    expect(sha256(await readFile(join(output, "history.bin")))).toBe(
      sha256(data),
    );
    const cabinet = await openPath(path);
    expect(cabinet.problems).toEqual([]);
    expect(sha256(await collect(cabinet, byName(cabinet, "history.bin")))).toBe(
      sha256(data),
    );
  });
});

/** A copy of a fixture cabinet's bytes with `edit` applied. */
const edited = async (
  pick: (built: Built) => string,
  edit: (bytes: Buffer, cabinet: Cabinet) => Buffer | void,
): Promise<Buffer> => {
  const bytes = Buffer.from(await readFile(pick(await built())));
  return edit(bytes, await openBytes(bytes)) ?? bytes;
};

const mszipFixture = (b: Built) => b.fixtures.cabinet;
const storedFixture = (b: Built) => b.fixtures.cabinetStored;

describe.skipIf(WINDOWS_TOOLS === null)(
  "malformed cabinets derived from gcab's bytes",
  () => {
    useFixtures();

    it("refuses a wrong signature, a short file and a header that declares too few bytes", async () => {
      const bad = await edited(
        mszipFixture,
        (bytes) => void bytes.write("MSCX", 0, "latin1"),
      );
      await expect(openBytes(bad)).rejects.toMatchObject({
        name: "CabFormatError",
        offset: 0,
      });
      const short = await edited(mszipFixture, (bytes) =>
        bytes.subarray(0, 30),
      );
      await expect(openBytes(short)).rejects.toBeInstanceOf(CabFormatError);
      const tiny = await edited(
        mszipFixture,
        (bytes) => void bytes.writeUInt32LE(20, 8),
      );
      await expect(openBytes(tiny)).rejects.toMatchObject({ offset: 8 });
    });

    it("lists a truncated cabinet, then fails the read that needs the missing bytes", async () => {
      const whole = await readFile((await built()).fixtures.cabinet);
      const cabinet = await openBytes(whole.subarray(0, 200_000));
      expect(cabinet.files.map((file) => file.name)).toEqual([
        "ToolExe",
        "ReadmeTxt",
      ]);
      expect(cabinet.problems).toEqual([
        `The cabinet declares ${String(whole.length)} bytes; only 200000 are present.`,
      ]);
      await expect(
        collect(cabinet, byName(cabinet, "ToolExe")),
      ).rejects.toThrow(/the cabinet ends at 200000/u);
      // Cut inside the second CFFILE record: the first record is kept.
      const cut = await openBytes(whole.subarray(0, 0x50));
      expect(cut.files.map((file) => file.name)).toEqual(["ToolExe"]);
      expect(cut.problems.at(-1)).toMatch(/after 1 of 2 records/u);
    });

    it("reports a folder whose data offset lies past the end and fails its reads", async () => {
      const bytes = await edited(
        mszipFixture,
        (data) => void data.writeUInt32LE(data.length + 100, 36),
      );
      const cabinet = await openBytes(bytes);
      expect(cabinet.problems).toEqual([
        `Folder 0's data at ${String(bytes.length + 100)} lies past the cabinet end at ${String(bytes.length)}.`,
      ]);
      await expect(
        collect(cabinet, byName(cabinet, "ReadmeTxt")),
      ).rejects.toMatchObject({
        name: "CabFormatError",
        offset: bytes.length + 100,
      });
    });
  },
);

describe.skipIf(WINDOWS_TOOLS === null)(
  "malformed CFDATA blocks and file records derived from gcab's bytes",
  () => {
    useFixtures();

    it.each([
      ["MSZIP", mszipFixture],
      ["stored", storedFixture],
    ] as const)(
      "fails a %s block whose data no longer matches its checksum",
      async (_, pick) => {
        let at = 0;
        const bytes = await edited(pick, (data, cabinet) => {
          at = cabinet.folders[0]?.data_offset ?? 0;
          data[at + 8 + 100] = (data[at + 8 + 100] ?? 0) ^ 0x01;
        });
        const cabinet = await openBytes(bytes);
        await expect(
          collect(cabinet, byName(cabinet, "ToolExe")),
        ).rejects.toMatchObject({
          name: "CabFormatError",
          offset: at,
          message: expect.stringMatching(
            /CFDATA block 0 of folder 0 has checksum 0x[0-9a-f]{8}; its bytes give/u,
          ) as unknown,
        });
      },
    );

    it("reads changed stored data when the block's checksum is absent (0)", async () => {
      const bytes = await edited(storedFixture, (data, cabinet) => {
        const at = cabinet.folders[0]?.data_offset ?? 0;
        data.writeUInt32LE(0, at);
        data[at + 8] = 0x00;
      });
      const cabinet = await openBytes(bytes);
      expect((await collect(cabinet, byName(cabinet, "ToolExe")))[0]).toBe(
        0x00,
      );
    });

    it("fails blocks that claim more than 32 KiB, lack the MSZIP signature or disagree with stored sizes", async () => {
      const offsetOf = (cabinet: Cabinet) =>
        cabinet.folders[0]?.data_offset ?? 0;
      const large = await edited(
        mszipFixture,
        (data, cabinet) =>
          void data.writeUInt16LE(0x8001, offsetOf(cabinet) + 6),
      );
      const cabinet = await openBytes(large);
      await expect(
        collect(cabinet, byName(cabinet, "ToolExe")),
      ).rejects.toMatchObject({
        offset: offsetOf(cabinet) + 6,
        message: expect.stringContaining(
          "declares 32769 uncompressed bytes",
        ) as unknown,
      });
      const unsigned = await edited(mszipFixture, (data, cabinet) => {
        data.write("XX", offsetOf(cabinet) + 8, "latin1");
        data.writeUInt32LE(0, offsetOf(cabinet));
      });
      const noSignature = await openBytes(unsigned);
      await expect(
        collect(noSignature, byName(noSignature, "ToolExe")),
      ).rejects.toThrow(/"CK"/u);
      const uneven = await edited(
        storedFixture,
        (data, cabinet) =>
          void data.writeUInt16LE(0x7000, offsetOf(cabinet) + 6),
      );
      const storedCabinet = await openBytes(uneven);
      await expect(
        collect(storedCabinet, byName(storedCabinet, "ToolExe")),
      ).rejects.toThrow(
        /is stored but holds 32768 bytes for 28672 uncompressed/u,
      );
    });

    it("reports a file that runs past its folder's blocks and fails the read past the folder's end", async () => {
      const readmeSize = (cabinet: Cabinet) =>
        byName(cabinet, "ReadmeTxt").record_offset;
      const beyond = await edited(
        mszipFixture,
        (data, cabinet) => void data.writeUInt32LE(6_000, readmeSize(cabinet)),
      );
      const listed = await openBytes(beyond);
      expect(listed.problems).toEqual([
        'File 1 ("ReadmeTxt") ends at byte 950632 of folder 0, past the 950272 bytes its 29 blocks can hold.',
      ]);
      const short = await edited(
        mszipFixture,
        (data, cabinet) => void data.writeUInt32LE(100, readmeSize(cabinet)),
      );
      const cabinet = await openBytes(short);
      expect(cabinet.problems).toEqual([]);
      await expect(
        collect(cabinet, byName(cabinet, "ReadmeTxt")),
      ).rejects.toThrow(
        'Folder 0 ends after 944642 bytes; "ReadmeTxt" needs bytes 944632..944732.',
      );
    });

    it("reports a file that names a folder the cabinet does not have", async () => {
      const bytes = await edited(
        mszipFixture,
        (data, cabinet) =>
          void data.writeUInt16LE(
            3,
            byName(cabinet, "ReadmeTxt").record_offset + 8,
          ),
      );
      const cabinet = await openBytes(bytes);
      expect(cabinet.problems).toEqual([
        'File 1 ("ReadmeTxt") names folder 3; the cabinet has 1.',
      ]);
      await expect(
        collect(cabinet, byName(cabinet, "ReadmeTxt")),
      ).rejects.toBeInstanceOf(CabFormatError);
    });
  },
);
