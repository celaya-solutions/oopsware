import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { expect } from "vitest";

import { LINUX_TOOLS } from "../../../tests/fixtures/linuxProducers.js";
import {
  type SquashfsEntry,
  SquashfsImage,
  type SquashfsRead,
} from "./squashfs.js";

/**
 * Shared oracle checks for the SquashFS and AppImage tests: the real
 * mksquashfs builds images and the real unsquashfs (`-pf -`, `-lln`, `-cat`,
 * `-s`) states what each one holds.
 */

const run = promisify(execFile);

const tool = (name: "mksquashfs" | "unsquashfs"): string => {
  if (LINUX_TOOLS === null)
    throw new Error("mksquashfs and unsquashfs are not installed.");
  return LINUX_TOOLS[name];
};

const ENVIRONMENT = { PATH: "/opt/homebrew/bin:/usr/bin:/bin", LC_ALL: "C" };

/** Run unsquashfs and return its raw stdout. */
export const unsquashfs = async (args: readonly string[]): Promise<Buffer> =>
  (
    await run(tool("unsquashfs"), [...args], {
      encoding: "buffer",
      env: ENVIRONMENT,
      maxBuffer: 512 * 1024 ** 2,
    })
  ).stdout;

/** Build `image` from `source` with mksquashfs and the given options. */
export const mksquashfs = async (
  source: string,
  image: string,
  options: readonly string[],
): Promise<string> => {
  await run(
    tool("mksquashfs"),
    [source, image, "-noappend", "-no-progress", "-quiet", ...options],
    { env: ENVIRONMENT, maxBuffer: 64 * 1024 ** 2 },
  );
  return image;
};

/** Positional reads over bytes in memory, shifted by `offset` (where an AppImage's payload starts). */
export const memoryImage = (
  bytes: Uint8Array,
  offset = 0,
): { readonly read: SquashfsRead; readonly size: number } => ({
  read: (at, length) =>
    Promise.resolve(bytes.subarray(offset + at, offset + at + length)),
  size: bytes.length - offset,
});

export const openImage = async (
  path: string,
  offset = 0,
): Promise<SquashfsImage> => {
  const { read, size } = memoryImage(await readFile(path), offset);
  return SquashfsImage.open(read, size);
};

export const listEntries = async (
  image: SquashfsImage,
): Promise<SquashfsEntry[]> => {
  const entries: SquashfsEntry[] = [];
  for await (const entry of image.entries()) entries.push(entry);
  return entries;
};

export const sha256 = async (
  chunks: AsyncIterable<Uint8Array>,
): Promise<string> => {
  const hash = createHash("sha256");
  for await (const chunk of chunks) hash.update(chunk);
  return hash.digest("hex");
};

/** One line of `unsquashfs -pf -`, with the xattr lines of its path counted. */
interface PseudoDefinition {
  readonly type: string;
  readonly fields: readonly string[];
  /** Symlink target or hard-link target path. */
  readonly target: string | null;
  xattrs: number;
}

/** Split off the escaped first token (a path) and unescape it. */
const pathToken = (line: string): { path: string; rest: string } => {
  let path = "";
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index] ?? "";
    if (character === "\\") {
      path += line[index + 1] ?? "";
      index += 1;
    } else if (character === " ") return { path, rest: line.slice(index + 1) };
    else path += character;
  }
  return { path, rest: "" };
};

/** `unsquashfs -pf -`: definitions by path in listing order (root excluded). */
export const pseudoDefinitions = async (
  image: string,
  offset = 0,
): Promise<Map<string, PseudoDefinition>> => {
  const output = (
    await unsquashfs(["-o", String(offset), "-pf", "-", image])
  ).toString("utf8");
  const definitions = new Map<string, PseudoDefinition>();
  for (const line of output.split("\n")) {
    if (line.startsWith("#")) break;
    if (line === "") continue;
    const { path, rest } = pathToken(line);
    const [type = "", ...fields] = rest.split(" ");
    if (type === "x") {
      const owner = definitions.get(path);
      if (owner !== undefined) owner.xattrs += 1;
      continue;
    }
    if (path === "/") continue;
    // Symlink targets are written unescaped to the end of the line; hard-link targets as escaped paths.
    const target =
      type === "S"
        ? fields.slice(4).join(" ")
        : type === "L"
          ? pathToken(`${fields.join(" ")} `).path
          : null;
    definitions.set(path, { type, fields, target, xattrs: 0 });
  }
  return definitions;
};

const TYPE_LETTERS: Readonly<Record<SquashfsEntry["type"], string>> = {
  file: "-",
  directory: "d",
  symlink: "l",
  "block-device": "b",
  "char-device": "c",
  fifo: "p",
  socket: "s",
};

/** The mode column `ls -l` (and `unsquashfs -lln`) prints. */
export const modeText = (entry: SquashfsEntry): string => {
  const { mode } = entry;
  const triple = (
    shift: number,
    special: number,
    set: string,
    unset: string,
  ): string => {
    const bits = (mode >> shift) & 7;
    const execute = (bits & 1) !== 0;
    const marker =
      (mode & special) === 0 ? (execute ? "x" : "-") : execute ? set : unset;
    return `${(bits & 4) !== 0 ? "r" : "-"}${(bits & 2) !== 0 ? "w" : "-"}${marker}`;
  };
  return `${TYPE_LETTERS[entry.type]}${triple(6, 0o4000, "s", "S")}${triple(3, 0o2000, "s", "S")}${triple(0, 0o1000, "t", "T")}`;
};

const utcText = (seconds: number): string =>
  new Date(seconds * 1000).toISOString().replace("T", " ").slice(0, 19);

/** `unsquashfs -lln -UTC -full-precision`: one line per path (root excluded). */
const longListing = async (
  image: string,
  offset: number,
): Promise<Map<string, string>> => {
  const output = (
    await unsquashfs([
      "-o",
      String(offset),
      "-lln",
      "-UTC",
      "-full-precision",
      "-n",
      image,
    ])
  ).toString("utf8");
  const lines = new Map<string, string>();
  for (const line of output.split("\n")) {
    const match =
      /^(\S+ \d+\/\d+ +\S+(?: *\d+)? \d{4}-\d\d-\d\d \d\d:\d\d:\d\d) squashfs-root\/(.*)$/u.exec(
        line,
      );
    if (match !== null)
      lines.set(
        (match[2] ?? "").replace(/ -> .*$/u, ""),
        (match[1] ?? "").replace(/, +/gu, ",").replace(/ +/gu, " "),
      );
  }
  return lines;
};

/** Our entry as `unsquashfs -lln` prints it (directory sizes are the stored listing size). */
const longText = (entry: SquashfsEntry, oracle: string): string => {
  const device = printedDevice(entry.device);
  const size =
    device === null
      ? entry.type === "directory"
        ? (oracle.split(" ")[2] ?? "")
        : String(entry.size)
      : `${String(device.major)},${String(device.minor)}`;
  return `${modeText(entry)} ${String(entry.uid)}/${String(entry.gid)} ${size} ${utcText(entry.mtime)}`.replace(
    / +/gu,
    " ",
  );
};

const PSEUDO_TYPES: Readonly<Record<string, SquashfsEntry["type"]>> = {
  D: "directory",
  R: "file",
  S: "symlink",
  B: "block-device",
  C: "char-device",
};

/** What a `-pf` definition states about the entry it describes. */
const pseudoView = (definition: PseudoDefinition): Record<string, unknown> => {
  const [time = "", mode = "", uid = "", gid = "", ...rest] = definition.fields;
  const type =
    definition.type === "I"
      ? rest[0] === "f"
        ? "fifo"
        : "socket"
      : PSEUDO_TYPES[definition.type];
  return {
    type,
    mtime: Number(time),
    mode: Number.parseInt(mode, 8),
    uid: Number(uid),
    gid: Number(gid),
    ...(type === "file" ? { size: Number(rest[0]) } : {}),
    link_target: definition.target,
    device:
      type === "block-device" || type === "char-device"
        ? { major: Number(rest[0]), minor: Number(rest[1]) }
        : null,
    xattrs: definition.xattrs,
  };
};

/**
 * Device numbers as unsquashfs prints them. Built on macOS it passes the
 * stored Linux rdev through Darwin's major()/minor(), printing (rdev >> 8,
 * rdev & 0xff); elsewhere it prints the kernel's decoding.
 */
const printedDevice = (
  device: SquashfsEntry["device"],
): SquashfsEntry["device"] => {
  if (device === null || process.platform !== "darwin") return device;
  const rdev =
    (device.major << 8) |
    (device.minor & 0xff) |
    ((device.minor & ~0xff) << 12);
  return { major: rdev >> 8, minor: rdev & 0xff };
};

const entryView = (entry: SquashfsEntry): Record<string, unknown> => ({
  type: entry.type,
  mtime: entry.mtime,
  mode: entry.mode,
  uid: entry.uid,
  gid: entry.gid,
  ...(entry.type === "file" ? { size: entry.size } : {}),
  link_target: entry.link_target,
  device: printedDevice(entry.device),
  xattrs: entry.xattrs,
});

/** Run `work` over `items` with at most `limit` in flight. */
const pooled = async <Item>(
  items: readonly Item[],
  limit: number,
  work: (item: Item) => Promise<void>,
): Promise<void> => {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (let index = next++; index < items.length; index = next++)
        await work(items[index] as Item);
    }),
  );
};

/**
 * Every entry against `-pf -` and `-lln` (path order, type, mode with
 * setuid/setgid/sticky, ids, size, mtime, link and device numbers, xattr
 * count, hard links sharing an inode) and every regular file's SHA-256
 * against `-cat`. Returns the entries and how many files were compared.
 */
export const expectMatchesUnsquashfs = async (
  path: string,
  image: SquashfsImage,
  offset = 0,
): Promise<{
  readonly entries: readonly SquashfsEntry[];
  readonly files: number;
}> => {
  const entries = await listEntries(image);
  expect(image.problems).toEqual([]);
  const definitions = await pseudoDefinitions(path, offset);
  const listing = await longListing(path, offset);
  expect(entries.map((entry) => entry.path)).toEqual([...definitions.keys()]);
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  for (const entry of entries) {
    const definition = definitions.get(entry.path);
    if (definition === undefined)
      throw new Error(`unsquashfs does not list ${entry.path}`);
    if (definition.type === "L") {
      const first = byPath.get(definition.target ?? "");
      expect(first, entry.path).toBeDefined();
      expect(entry, entry.path).toEqual({ ...first, path: entry.path });
      expect(entry.hard_links, entry.path).toBeGreaterThan(1);
    } else expect(entryView(entry), entry.path).toEqual(pseudoView(definition));
    const oracle = listing.get(entry.path) ?? "";
    expect(longText(entry, oracle), entry.path).toBe(oracle);
    if (entry.type !== "file")
      expect(entry.size, entry.path).toBe(
        entry.link_target === null ? 0 : Buffer.byteLength(entry.link_target),
      );
  }
  const files = entries.filter((entry) => entry.type === "file");
  await pooled(files, 8, async (entry) => {
    const expected = createHash("sha256")
      .update(
        await unsquashfs([
          "-o",
          String(offset),
          "-no-wildcards",
          "-cat",
          path,
          entry.path,
        ]),
      )
      .digest("hex");
    expect(await sha256(image.read(entry)), entry.path).toBe(expected);
  });
  return { entries, files: files.length };
};

/** The `unsquashfs -s` lines a superblock's flags imply. */
const flagLines = (flags: readonly string[]): string[] => {
  const has = (flag: string): boolean => flags.includes(flag);
  return [
    `Filesystem is ${has("exportable") ? "" : "not "}exportable via NFS`,
    `Inodes are ${has("uncompressed-inodes") ? "un" : ""}compressed`,
    `Data is ${has("uncompressed-data") ? "un" : ""}compressed`,
    // Ids are also stored uncompressed under -noI; unsquashfs reports either bit.
    `Uids/Gids (Id table) are ${has("uncompressed-ids") || has("uncompressed-inodes") ? "un" : ""}compressed`,
    has("no-fragments")
      ? "Fragments are not stored"
      : `Fragments are ${has("uncompressed-fragments") ? "un" : ""}compressed`,
    ...(has("no-fragments")
      ? []
      : [
          `Tailends are ${has("always-fragments") ? "" : "not "}packed into fragments`,
        ]),
    has("no-xattrs")
      ? "Xattrs are not stored"
      : `Xattrs are ${has("uncompressed-xattrs") ? "un" : ""}compressed`,
    `Duplicates are ${has("duplicates") ? "" : "not "}removed`,
  ];
};

/** The superblock against `unsquashfs -s` and `-mkfs-time`. */
export const expectSuperblockMatches = async (
  path: string,
  image: SquashfsImage,
  offset = 0,
): Promise<void> => {
  const { superblock } = image;
  const stat = (await unsquashfs(["-o", String(offset), "-s", path])).toString(
    "utf8",
  );
  const lines = stat.split("\n").map((line) => line.trim());
  const expected = [
    `Compression ${superblock.compression}`,
    `Block size ${String(superblock.block_size)}`,
    `Filesystem size ${String(superblock.bytes_used)} bytes`,
    `Number of fragments ${String(superblock.fragment_count)}`,
    `Number of inodes ${String(superblock.inode_count)}`,
    `Number of ids ${String(superblock.id_count)}`,
    ...flagLines(superblock.flags),
  ];
  for (const line of expected)
    expect(
      lines.some((actual) => actual.startsWith(line)),
      `${line}\n${stat}`,
    ).toBe(true);
  expect(
    stat.includes(
      `Found a valid SQUASHFS ${superblock.version.replace(".", ":")} superblock`,
    ),
  ).toBe(true);
  expect(
    (await unsquashfs(["-o", String(offset), "-mkfs-time", path]))
      .toString("utf8")
      .trim(),
  ).toBe(String(superblock.mkfs_time));
};
