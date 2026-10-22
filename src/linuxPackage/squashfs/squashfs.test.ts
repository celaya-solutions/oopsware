import { randomBytes } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { decodeLz4Block, Lz4BlockError } from "./lz4.js";
import {
  SquashfsFormatError,
  SquashfsImage,
  SquashfsUnsupportedError,
} from "./squashfs.js";
import {
  expectMatchesUnsquashfs,
  expectSuperblockMatches,
  listEntries,
  memoryImage,
  mksquashfs,
  openImage,
  sha256,
  unsquashfs,
} from "./unsquashfs.fixture.js";
import {
  buildLinuxFixtures,
  LINUX_TOOLS,
  type LinuxFixtures,
} from "../../../tests/fixtures/linuxProducers.js";
import { removeTestWorkspace } from "../../../tests/support/workspace/workspaceFixture.js";

/**
 * The SquashFS reader checked against squashfs-tools 4.7.5: the F05 fixture
 * images, coverage images built here with mksquashfs for every inode kind and
 * layout option, and malformed images derived from real bytes. unsquashfs
 * (`-pf -`, `-lln`, `-cat`, `-s`) is the oracle throughout.
 */

let root: string | undefined;
let building: Promise<Built> | undefined;

interface Built {
  readonly fixtures: LinuxFixtures;
  readonly coverage: Readonly<Record<string, string>>;
  /** Small fully uncompressed image whose tables can be edited byte by byte. */
  readonly editable: string;
  readonly unsupported: Readonly<Record<"xz" | "lzma" | "lzo", string>>;
  readonly deep: { readonly accepted: string; readonly refused: string };
}

const EPOCH = "1767225600";

/** A tree with every regular-file layout: tiny, empty, hard-linked, sparse, compressible, incompressible. */
const writeCoverageTree = async (tree: string): Promise<void> => {
  await mkdir(join(tree, "sub"), { recursive: true });
  await writeFile(join(tree, "a.txt"), "hello\n");
  await link(join(tree, "a.txt"), join(tree, "sub/hard.txt"));
  await link(join(tree, "a.txt"), join(tree, "sub/hard-2.txt"));
  await writeFile(join(tree, "empty"), "");
  await writeFile(join(tree, "zeros"), new Uint8Array(300_000));
  const holes = await open(join(tree, "holes"), "w");
  await holes.write("head", 0);
  await holes.write("tail", 400_000);
  await holes.close();
  const lines = Array.from(
    { length: 12_000 },
    (_, line) => `line ${String(line)} of the compressible file\n`,
  );
  await writeFile(join(tree, "text.bin"), lines.join(""));
  await writeFile(join(tree, "random.bin"), randomBytes(200_000));
  await writeFile(join(tree, "ünïcode name.txt"), "name test\n");
  await symlink("a.txt", join(tree, "link"));
  await symlink("sub", join(tree, "dir-link"));
  await mkdir(join(tree, "shared"));
  await chmod(join(tree, "shared"), 0o3775);
  await writeFile(join(tree, "setgid"), "#!/bin/sh\n");
  await chmod(join(tree, "setgid"), 0o2755);
};

const SPECIAL_FILES = [
  "-p",
  "null c 666 0 0 1 3",
  "-p",
  `sda1 B ${EPOCH} 640 0 6 8 1`,
  // The largest minor (20 bits) the rdev encoding keeps; mksquashfs on macOS keeps 8-bit majors (Darwin's dev_t).
  "-p",
  "wide c 600 0 0 255 1048575",
  "-p",
  "pipe i 600 0 0 f",
  "-p",
  `socket I ${EPOCH} 600 0 0 s`,
];

const buildAll = async (
  base: string,
  fixtures: LinuxFixtures,
): Promise<Built> => {
  const tree = join(base, "coverage-tree");
  await writeCoverageTree(tree);
  const image = (name: string): string => join(base, name);
  const coverage = {
    "gzip with devices, fifo, socket, hard links, sparse files and xattrs":
      await mksquashfs(tree, image("special.sqfs"), [
        "-comp",
        "gzip",
        ...SPECIAL_FILES,
        "-xattrs-add",
        "security.oops=1",
        "-p",
        "a.txt x user.extra=2",
      ]),
    "zstd without fragments, with 4 KiB blocks and no padding":
      await mksquashfs(tree, image("no-fragments.sqfs"), [
        "-comp",
        "zstd",
        "-no-fragments",
        "-b",
        "4096",
        "-nopad",
        "-no-xattrs",
      ]),
    "lz4 HC with every tail in a fragment, duplicates kept, not exportable, ids uncompressed":
      await mksquashfs(tree, image("always-fragments.sqfs"), [
        "-comp",
        "lz4",
        "-Xhc",
        "-always-use-fragments",
        "-no-duplicates",
        "-no-exports",
        "-noId",
      ]),
    "gzip with inodes, data, fragments, ids and xattrs stored uncompressed":
      await mksquashfs(tree, image("uncompressed.sqfs"), [
        "-noI",
        "-noD",
        "-noF",
        "-noX",
        "-noId",
        ...SPECIAL_FILES,
        "-xattrs-add",
        "user.oops=1",
      ]),
  };
  const wide = join(base, "wide-tree");
  await mkdir(wide);
  // 300 entries of 40+ bytes: several directory headers and a listing past 8 KiB (an indexed directory).
  for (let index = 0; index < 300; index += 1)
    await writeFile(
      join(wide, `entry-${String(index).padStart(3, "0")}-${"n".repeat(30)}`),
      `${String(index)}\n`,
    );
  await writeFile(join(wide, "x".repeat(255)), "longest name\n");
  const empty = join(base, "empty-tree");
  await mkdir(empty);
  const editableTree = join(base, "editable-tree");
  await mkdir(join(editableTree, "dd"), { recursive: true });
  await writeFile(join(editableTree, "a.b"), "dotted\n");
  await writeFile(join(editableTree, "dd/inner.txt"), "inner\n");
  await writeFile(join(editableTree, "zz.txt"), "last\n");
  const nested = (depth: number): string =>
    Array.from({ length: depth }, () => "d").join("/");
  return {
    fixtures,
    coverage: {
      ...coverage,
      "gzip with a 300-entry directory and a 255-byte name": await mksquashfs(
        wide,
        image("wide.sqfs"),
        ["-comp", "gzip"],
      ),
      "zstd with an empty root": await mksquashfs(empty, image("empty.sqfs"), [
        "-comp",
        "zstd",
      ]),
    },
    editable: await mksquashfs(editableTree, image("editable.sqfs"), [
      "-noI",
      "-noD",
      "-noF",
      "-noX",
      "-noId",
      "-no-xattrs",
      "-mkfs-time",
      EPOCH,
      "-all-time",
      EPOCH,
    ]),
    unsupported: {
      xz: fixtures.squashfs.xz,
      lzma: await mksquashfs(empty, image("lzma.sqfs"), ["-comp", "lzma"]),
      lzo: await mksquashfs(empty, image("lzo.sqfs"), ["-comp", "lzo"]),
    },
    deep: {
      accepted: await mksquashfs(empty, image("deep-256.sqfs"), [
        "-pd",
        "d 755 0 0",
        "-p",
        `${nested(256)} d 755 0 0`,
      ]),
      refused: await mksquashfs(empty, image("deep-257.sqfs"), [
        "-pd",
        "d 755 0 0",
        "-p",
        `${nested(257)} d 755 0 0`,
      ]),
    },
  };
};

const built = (): Promise<Built> => {
  building ??= (async () => {
    root = await realpath(
      await mkdtemp(join(await realpath(tmpdir()), "rea-squashfs-")),
    );
    return buildAll(root, await buildLinuxFixtures(join(root, "fixtures")));
  })();
  return building;
};

const useImages = () => {
  beforeAll(async () => {
    await built();
  }, 300_000);
};

afterAll(async () => {
  if (root !== undefined) await removeTestWorkspace(root);
});

describe.skipIf(LINUX_TOOLS === null)(
  "SquashFS fixture images against unsquashfs",
  () => {
    useImages();

    it.each(["gzip", "zstd", "lz4"] as const)(
      "lists and reads the %s AppDir image exactly as unsquashfs",
      async (compression) => {
        const { fixtures } = await built();
        const path = fixtures.squashfs[compression];
        const image = await openImage(path);
        expect(image.superblock.compression).toBe(compression);
        await expectSuperblockMatches(path, image);
        const { entries, files } = await expectMatchesUnsquashfs(path, image);
        expect(files).toBeGreaterThan(0);
        // The fixture's README and README.hardlink share one inode.
        const linked = entries.filter((entry) =>
          entry.path.startsWith("usr/share/doc/oops/README"),
        );
        expect(linked.map((entry) => entry.hard_links)).toEqual([2, 2]);
        expect(new Set(linked.map((entry) => entry.inode_number)).size).toBe(1);
        expect(
          entries.find((entry) => entry.path === "usr/lib/oops/helper"),
        ).toMatchObject({
          type: "file",
          mode: 0o4755,
          uid: 0,
          gid: 0,
          size: 944_632,
        });
        expect(
          entries.find((entry) => entry.path === ".DirIcon"),
        ).toMatchObject({ type: "symlink", link_target: "oops.png" });
        expect(entries.map((entry) => entry.path)).toContain(
          "usr/share/doc/oops/names/ünïcode file.txt",
        );
      },
    );

    it("returns the helper's bytes as the producer's ELF", async () => {
      const { fixtures } = await built();
      const image = await openImage(fixtures.squashfs.zstd);
      const helper = await image.find("usr/lib/oops/helper");
      if (helper === null) throw new Error("usr/lib/oops/helper is not listed");
      const chunks: Uint8Array[] = [];
      for await (const chunk of image.read(helper)) chunks.push(chunk);
      expect(Buffer.concat(chunks).equals(await readFile(fixtures.elf))).toBe(
        true,
      );
      expect(await image.find("usr/lib/missing")).toBeNull();
      expect(await image.find("AppRun/below-a-file")).toBeNull();
    });

    it("reads an entry that was not produced by this listing through its path", async () => {
      const { fixtures } = await built();
      const listed = (
        await listEntries(await openImage(fixtures.squashfs.gzip))
      ).find((entry) => entry.path === "oops.desktop");
      if (listed === undefined) throw new Error("oops.desktop is not listed");
      const other = await openImage(fixtures.squashfs.gzip);
      const expected = (
        await unsquashfs(["-cat", fixtures.squashfs.gzip, "oops.desktop"])
      ).toString("utf8");
      const chunks: Uint8Array[] = [];
      for await (const chunk of other.read({ ...listed })) chunks.push(chunk);
      expect(Buffer.concat(chunks).toString("utf8")).toBe(expected);
      await expect(
        other.read({ ...listed, type: "directory" }).next(),
      ).rejects.toThrow(TypeError);
    });
  },
);

describe.skipIf(LINUX_TOOLS === null)(
  "SquashFS coverage images against unsquashfs",
  () => {
    useImages();

    it("lists and reads every coverage image exactly as unsquashfs", async () => {
      const { coverage } = await built();
      for (const [name, path] of Object.entries(coverage)) {
        const image = await openImage(path);
        await expectSuperblockMatches(path, image);
        const { entries } = await expectMatchesUnsquashfs(path, image);
        expect(entries.length, name).toBeGreaterThanOrEqual(
          name.includes("empty") ? 0 : 10,
        );
      }
    }, 120_000);

    it("covers every inode kind, hard links, xattrs, devices and the stored layouts", async () => {
      const { coverage } = await built();
      const special = await listEntries(
        await openImage(
          coverage[
            "gzip with devices, fifo, socket, hard links, sparse files and xattrs"
          ] ?? "",
        ),
      );
      const byPath = new Map(special.map((entry) => [entry.path, entry]));
      expect(new Set(special.map((entry) => entry.type))).toEqual(
        new Set([
          "file",
          "directory",
          "symlink",
          "block-device",
          "char-device",
          "fifo",
          "socket",
        ]),
      );
      expect(byPath.get("wide")?.device).toEqual({
        major: 255,
        minor: 1_048_575,
      });
      expect(byPath.get("sda1")).toMatchObject({
        device: { major: 8, minor: 1 },
        gid: 6,
        mtime: Number(EPOCH),
      });
      const links = ["a.txt", "sub/hard.txt", "sub/hard-2.txt"].map((path) =>
        byPath.get(path),
      );
      expect(new Set(links.map((entry) => entry?.inode_number)).size).toBe(1);
      expect(links.map((entry) => [entry?.hard_links, entry?.xattrs])).toEqual([
        [3, 2],
        [3, 2],
        [3, 2],
      ]);
      expect(byPath.get("link")?.xattrs).toBe(1);
      expect(byPath.get("shared")?.mode).toBe(0o3775);
      expect(byPath.get("setgid")?.mode).toBe(0o2755);
      const wide = await openImage(
        coverage["gzip with a 300-entry directory and a 255-byte name"] ?? "",
      );
      const wideEntries = await listEntries(wide);
      expect(wideEntries).toHaveLength(301);
      expect(wideEntries.at(-1)?.path).toBe("x".repeat(255));
      const flags = Object.fromEntries(
        await Promise.all(
          Object.entries(coverage).map(async ([name, path]) => [
            name,
            (await openImage(path)).superblock.flags,
          ]),
        ),
      );
      expect(flags).toMatchObject({
        "zstd without fragments, with 4 KiB blocks and no padding":
          expect.arrayContaining(["no-fragments", "no-xattrs"]),
        "lz4 HC with every tail in a fragment, duplicates kept, not exportable, ids uncompressed":
          expect.arrayContaining([
            "always-fragments",
            "compressor-options",
            "uncompressed-ids",
          ]),
        "gzip with inodes, data, fragments, ids and xattrs stored uncompressed":
          expect.arrayContaining([
            "uncompressed-inodes",
            "uncompressed-data",
            "uncompressed-fragments",
            "uncompressed-xattrs",
          ]),
      });
    });

    it("accepts directories nested 256 deep and refuses 257", async () => {
      const { deep } = await built();
      const accepted = await listEntries(await openImage(deep.accepted));
      expect(accepted).toHaveLength(256);
      expect(
        (await unsquashfs(["-lln", "-n", deep.accepted]))
          .toString("utf8")
          .trim()
          .split("\n"),
      ).toHaveLength(257);
      const refused = await openImage(deep.refused);
      await expect(listEntries(refused)).rejects.toThrow(
        /nested deeper than 256/u,
      );
    });
  },
);

describe.skipIf(LINUX_TOOLS === null)(
  "SquashFS compressors decoded elsewhere",
  () => {
    useImages();

    it.each(["xz", "lzma", "lzo"] as const)(
      "refuses a %s image at open, naming the compressor",
      async (compression) => {
        const { unsupported } = await built();
        const opening = openImage(unsupported[compression]);
        await expect(opening).rejects.toBeInstanceOf(SquashfsUnsupportedError);
        await expect(opening).rejects.toMatchObject({
          feature: `compression ${compression}`,
        });
      },
    );
  },
);

/** An image's bytes with `edit` applied, opened from memory. */
const editedImage = async (
  path: string,
  edit: (bytes: Buffer) => void,
): Promise<{
  readonly bytes: Buffer;
  readonly opening: Promise<SquashfsImage>;
}> => {
  const bytes = Buffer.from(await readFile(path));
  edit(bytes);
  const { read, size } = memoryImage(bytes);
  const opening = SquashfsImage.open(read, size);
  opening.catch(() => undefined);
  return { bytes, opening };
};

const table = (bytes: Buffer, at: number): number =>
  Number(bytes.readBigUInt64LE(at));

/** The 8-byte header of the stored directory entry whose name is `name` (size field = length - 1). */
const entryHeader = (bytes: Buffer, name: string): number => {
  const pattern = Buffer.concat([
    Buffer.from([name.length - 1, 0]),
    Buffer.from(name),
  ]);
  const at = bytes.indexOf(pattern, table(bytes, 72));
  if (at === -1) throw new Error(`no directory entry named ${name}`);
  return at - 6;
};

describe.skipIf(LINUX_TOOLS === null)(
  "malformed SquashFS superblocks and tables",
  () => {
    useImages();

    it("refuses a bad magic, version 3.0, a short image and a table past the end", async () => {
      const { editable } = await built();
      // Byte 0 "h" becomes NUL: no "hsqs" magic.
      await expect(
        (
          await editedImage(editable, (bytes) => {
            bytes[0] = 0;
          })
        ).opening,
      ).rejects.toMatchObject({
        name: "SquashfsFormatError",
        offset: 0,
      });
      // s_major (offset 28) 4 -> 3: a 3.0 superblock.
      await expect(
        (await editedImage(editable, (bytes) => bytes.writeUInt16LE(3, 28)))
          .opening,
      ).rejects.toMatchObject({
        name: "SquashfsUnsupportedError",
        feature: "version 3.0",
      });
      const whole = await readFile(editable);
      const bytesUsed = table(whole, 40);
      // The image cut one byte short of bytes_used.
      const { read } = memoryImage(whole);
      await expect(
        SquashfsImage.open(read, bytesUsed - 1),
      ).rejects.toMatchObject({ name: "SquashfsFormatError", offset: 40 });
      // id_table_start (offset 48) moved 4 KiB past bytes_used.
      const past = await editedImage(editable, (bytes) =>
        bytes.writeBigUInt64LE(BigInt(bytesUsed + 4096), 48),
      );
      await expect(past.opening).rejects.toMatchObject({
        name: "SquashfsFormatError",
        offset: 48,
      });
      await expect(past.opening).rejects.toThrow(/id table offset/u);
    });

    it("refuses a truncated metadata block and one that claims more than 8 KiB", async () => {
      const { editable } = await built();
      const whole = await readFile(editable);
      const idBlock = table(whole, table(whole, 48));
      // The id table's only metadata block header (stored uncompressed: bit 15) claims 8000 bytes, past its table's end.
      const truncated = await editedImage(editable, (bytes) =>
        bytes.writeUInt16LE(0x8000 | 8000, idBlock),
      );
      await expect(truncated.opening).rejects.toMatchObject({
        name: "SquashfsFormatError",
        offset: idBlock,
      });
      await expect(truncated.opening).rejects.toThrow(
        /needs 8000 bytes but its table ends/u,
      );
      // The first inode table block header claims 8193 stored bytes; open reads no inode, the listing does.
      const inodeTable = table(whole, 64);
      const oversized = await editedImage(editable, (bytes) =>
        bytes.writeUInt16LE(0x8000 | 8193, inodeTable),
      );
      const image = await oversized.opening;
      await expect(listEntries(image)).rejects.toMatchObject({
        name: "SquashfsFormatError",
        offset: inodeTable,
      });
      await expect(listEntries(image)).rejects.toThrow(
        /claims 8193 stored bytes/u,
      );
    });
  },
);

describe.skipIf(LINUX_TOOLS === null)(
  "malformed SquashFS directories and data",
  () => {
    useImages();

    it("omits entries whose names are not path steps, with their subtrees, and records each", async () => {
      const { editable } = await built();
      const { opening } = await editedImage(editable, (bytes) => {
        // "a.b" -> "a/b" and the directory "dd" -> "..", in the uncompressed directory table.
        bytes[entryHeader(bytes, "a.b") + 9] = 0x2f;
        bytes.write("..", entryHeader(bytes, "dd") + 8, "latin1");
      });
      const image = await opening;
      expect((await listEntries(image)).map((entry) => entry.path)).toEqual([
        "zz.txt",
      ]);
      expect(image.problems.map((problem) => problem.message)).toEqual([
        expect.stringMatching(
          /name 0x612f62, which contains "\/"; it and anything below it are omitted/u,
        ),
        expect.stringMatching(/name 0x2e2e, which is "\.\."/u),
      ]);
    });

    it("refuses a directory that lists its own ancestor", async () => {
      const { editable } = await built();
      const whole = await readFile(editable);
      // Every inode of this small uncompressed image sits in the inode table's first metadata block.
      expect(table(whole, 72) - table(whole, 64)).toBeLessThan(8192);
      const { opening } = await editedImage(editable, (bytes) => {
        // dd/inner.txt's entry takes dd's inode offset and directory type 1.
        const directory = entryHeader(bytes, "dd");
        const inner = entryHeader(bytes, "inner.txt");
        bytes.writeUInt16LE(bytes.readUInt16LE(directory), inner);
        bytes.writeUInt16LE(1, inner + 4);
      });
      await expect(listEntries(await opening)).rejects.toThrow(
        /"dd\/inner\.txt" is its own ancestor; the listing loops/u,
      );
    });

    it("reports a corrupted compressed data block as a format error and keeps reading the rest", async () => {
      const { fixtures } = await built();
      // The gzip image's data area starts at 96 with the helper's first zlib block; 16 of its bytes are inverted.
      const { opening } = await editedImage(fixtures.squashfs.gzip, (bytes) => {
        for (let at = 96 + 200; at < 96 + 216; at += 1)
          bytes[at] = (bytes[at] ?? 0) ^ 0xff;
      });
      const image = await opening;
      const entries = await listEntries(image);
      const helper = entries.find(
        (entry) => entry.path === "usr/lib/oops/helper",
      );
      const desktop = entries.find((entry) => entry.path === "oops.desktop");
      if (helper === undefined || desktop === undefined)
        throw new Error("fixture entries are missing");
      await expect(sha256(image.read(helper))).rejects.toBeInstanceOf(
        SquashfsFormatError,
      );
      await expect(sha256(image.read(helper))).rejects.toMatchObject({
        offset: 96,
      });
      await expect(sha256(image.read(helper))).rejects.toThrow(
        /does not decompress/u,
      );
      expect(await sha256(image.read(desktop))).toBe(
        await sha256(
          (async function* () {
            yield await unsquashfs([
              "-cat",
              fixtures.squashfs.gzip,
              "oops.desktop",
            ]);
          })(),
        ),
      );
    });

    it("stops listing and reading when the signal aborts", async () => {
      const { fixtures } = await built();
      const image = await openImage(fixtures.squashfs.zstd);
      const controller = new AbortController();
      controller.abort();
      await expect(image.entries(controller.signal).next()).rejects.toThrow(
        /aborted/iu,
      );
      const helper = await image.find("usr/lib/oops/helper");
      if (helper === null) throw new Error("usr/lib/oops/helper is not listed");
      await expect(
        image.read(helper, controller.signal).next(),
      ).rejects.toThrow(/aborted/iu);
    });
  },
);

describe("LZ4 blocks that do not decode", () => {
  // Hand-built raw blocks: token (literals << 4 | match - 4), literals, u16 offset.
  it("refuses offsets outside the output, overruns and output past the limit", () => {
    expect(
      Buffer.from(
        decodeLz4Block(Uint8Array.of(0x14, 0x61, 0x01, 0x00, 0x10, 0x62), 64),
      ).toString(),
    ).toBe("aaaaaaaaab");
    expect(() =>
      decodeLz4Block(Uint8Array.of(0x14, 0x61, 0x00, 0x00, 0x10, 0x62), 64),
    ).toThrow(Lz4BlockError);
    expect(() =>
      decodeLz4Block(Uint8Array.of(0x14, 0x61, 0x02, 0x00, 0x10, 0x62), 64),
    ).toThrow(/before the start/u);
    expect(() => decodeLz4Block(Uint8Array.of(0x30, 0x61), 64)).toThrow(
      /past the end of the block/u,
    );
    expect(() =>
      decodeLz4Block(Uint8Array.of(0x14, 0x61, 0x01, 0x00, 0x10, 0x62), 9),
    ).toThrow(/more than 9 bytes/u);
    expect(() => decodeLz4Block(Uint8Array.of(0xf0, 0xff), 64)).toThrow(
      /inside a run length/u,
    );
    expect(() => decodeLz4Block(new Uint8Array(0), 64)).toThrow(
      /before its last literals/u,
    );
  });
});
