import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  constants,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, zstdDecompressSync } from "node:zlib";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ArFormatError,
  debLayout,
  readArMembers,
  type ArMember,
  type PositionalRead,
} from "./ar.js";
import {
  parseConffiles,
  parseControl,
  parseMd5sums,
  parseRelations,
  parseTriggers,
  RELATION_FIELDS,
  type DebianRelation,
} from "./control.js";
import {
  buildLinuxFixtures,
  LINUX_TOOLS,
  type LinuxFixtures,
} from "../../../tests/fixtures/linuxProducers.js";
import { removeTestWorkspace } from "../../../tests/support/workspace/workspaceFixture.js";

/**
 * The ar walker, the Debian member layout check and the control-data
 * parsers checked against the real tools: `ar tv` / `llvm-ar tv` for
 * members, `dpkg-deb -f`, `-I`, `--ctrl-tarfile` and `--fsys-tarfile` for
 * fields and member bytes, and the files `tar -x` extracts for conffiles,
 * md5sums and triggers. Malformed inputs are real packages with the byte
 * edits each test names; dpkg-deb --build is the oracle for which control
 * text dpkg rejects.
 */

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const firstTool = async (paths: readonly string[]): Promise<string | null> => {
  for (const path of paths) if (await exists(path)) return path;
  return null;
};

const AR = await firstTool(["/usr/bin/ar"]);
const LLVM_AR = await firstTool([
  "/opt/homebrew/opt/llvm/bin/llvm-ar",
  "/usr/local/opt/llvm/bin/llvm-ar",
]);
const XZ = await firstTool([
  "/opt/homebrew/bin/xz",
  "/usr/local/bin/xz",
  "/usr/bin/xz",
]);
const BSDTAR = await firstTool(["/usr/bin/bsdtar", "/opt/homebrew/bin/bsdtar"]);
const READY = LINUX_TOOLS !== null && XZ !== null && BSDTAR !== null;

/** Run a tool with an optional stdin and return stdout; non-zero exit rejects with stderr. */
const pipe = (
  command: string,
  args: readonly string[],
  input?: Uint8Array,
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      env: {
        PATH: "/opt/homebrew/bin:/usr/bin:/bin",
        HOME: process.env.HOME ?? "/tmp",
        LC_ALL: "C",
        ...(process.env.TZ === undefined ? {} : { TZ: process.env.TZ }),
      },
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(Buffer.concat(out))
        : reject(
            new Error(
              `${command} ${args.join(" ")} exited ${String(code)}: ${Buffer.concat(err).toString()}`,
            ),
          ),
    );
    child.stdin.end(input ?? Buffer.alloc(0));
  });

const text = async (
  command: string,
  args: readonly string[],
): Promise<string> => (await pipe(command, args)).toString("utf8");

const positional =
  (bytes: Uint8Array): PositionalRead =>
  async (offset, length) =>
    bytes.subarray(offset, offset + length);

const dpkgDeb = (): string => LINUX_TOOLS?.dpkgDeb ?? "dpkg-deb";

const decompress = async (
  compression: string,
  bytes: Uint8Array,
): Promise<Buffer> => {
  if (compression === "none") return Buffer.from(bytes);
  if (compression === "gzip") return gunzipSync(bytes);
  if (compression === "zstd") return zstdDecompressSync(bytes);
  if (compression === "xz") return pipe(XZ ?? "xz", ["-dc"], bytes);
  throw new Error(`no decompressor for ${compression}`);
};

const memberBytes = (bytes: Uint8Array, member: ArMember): Uint8Array =>
  bytes.subarray(member.data_offset, member.data_offset + member.size);

const COMPRESSIONS = ["xz", "gzip", "zstd", "none"] as const;
const EXTENSIONS = { xz: ".xz", gzip: ".gz", zstd: ".zst", none: "" } as const;

let root = "";
let fixtures: LinuxFixtures;

beforeAll(async () => {
  if (!READY) return;
  root = await realpath(await mkdtemp(join(tmpdir(), "oops-deb-")));
  fixtures = await buildLinuxFixtures(root);
}, 120_000);

afterAll(async () => {
  if (root !== "") await removeTestWorkspace(root);
});

const load = async (compression: (typeof COMPRESSIONS)[number]) => {
  const path = fixtures.deb[compression];
  const bytes = await readFile(path);
  const { members, trailing_bytes } = await readArMembers(
    positional(bytes),
    bytes.length,
  );
  const binary =
    members[0] === undefined ? null : memberBytes(bytes, members[0]);
  return {
    path,
    bytes,
    members,
    trailing_bytes,
    layout: debLayout(members, binary),
  };
};

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** `ar tv`'s strftime("%b %e %H:%M %Y") in local time. */
const arDate = (seconds: number): string => {
  const date = new Date(seconds * 1000);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${MONTHS[date.getMonth()] ?? ""} ${String(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())} ${String(date.getFullYear())}`;
};

const permissions = (mode: number): string =>
  [0o400, 0o200, 0o100, 0o40, 0o20, 0o10, 0o4, 0o2, 0o1]
    .map((bit, index) => (mode & bit ? "rwx"[index % 3] : "-"))
    .join("");

/** `ar tv` lines as [perms, uid/gid, size, date, name], whitespace collapsed. */
const arListing = (listing: string): string[][] =>
  listing
    .trimEnd()
    .split("\n")
    .map((line) => {
      const match =
        /^(\S{9})\s+(\d+\/\d+)\s+(\d+)\s+(\w{3}\s+\d+\s+\d\d:\d\d\s+\d{4})\s(.+)$/u.exec(
          line,
        );
      if (match === null) throw new Error(`unexpected ar listing line ${line}`);
      const [, perms = "", owner = "", size = "", date = "", name = ""] = match;
      return [perms, owner, size, date.replace(/\s+/gu, " "), name];
    });

const ours = (members: readonly ArMember[], withDate: boolean): string[][] =>
  members
    .filter(
      (member) =>
        !["/", "//", "/SYM64/"].includes(member.name) &&
        !member.name.startsWith("__.SYMDEF"),
    )
    .map((member) => [
      permissions(member.mode),
      `${String(member.uid)}/${String(member.gid)}`,
      String(member.size),
      withDate ? arDate(member.mtime) : "",
      member.name,
    ]);

describe.skipIf(!READY || AR === null)(
  "ar members of real Debian packages against ar tv",
  () => {
    it.each(COMPRESSIONS)(
      "lists the %s package exactly as ar tv does",
      async (compression) => {
        const { path, members, trailing_bytes } = await load(compression);
        expect(trailing_bytes).toBe(0);
        expect(ours(members, true)).toEqual(
          arListing(await text(AR ?? "ar", ["tv", path])),
        );
        // Every member's data is padded to an even offset with "\n" and the next header follows it.
        for (const [index, member] of members.entries()) {
          const next = members[index + 1];
          if (next !== undefined)
            expect(next.header_offset).toBe(
              member.data_offset +
                member.size +
                ((member.data_offset + member.size) % 2),
            );
        }
      },
    );
  },
);

describe.skipIf(!READY)("Debian member layout against dpkg-deb", () => {
  it.each(COMPRESSIONS)(
    "finds the %s control and data members dpkg-deb extracts",
    async (compression) => {
      const { path, bytes, layout } = await load(compression);
      expect(layout.problems).toEqual([]);
      expect(layout.signatures).toEqual([]);
      expect(layout.other).toEqual([]);
      expect(layout.control?.member.name).toBe(
        `control.tar${EXTENSIONS[compression]}`,
      );
      expect(layout.data?.member.name).toBe(
        `data.tar${EXTENSIONS[compression]}`,
      );
      expect(layout.control?.compression).toBe(compression);
      expect(layout.data?.compression).toBe(compression);
      const control = layout.control?.member;
      const data = layout.data?.member;
      if (control === undefined || data === undefined)
        throw new Error("layout");
      expect(
        await decompress(compression, memberBytes(bytes, control)),
      ).toEqual(await pipe(dpkgDeb(), ["--ctrl-tarfile", path]));
      expect(await decompress(compression, memberBytes(bytes, data))).toEqual(
        await pipe(dpkgDeb(), ["--fsys-tarfile", path]),
      );
      const info = await text(dpkgDeb(), ["-I", path]);
      expect(info).toContain(
        ` new Debian package, version ${layout.format_version ?? "?"}.\n`,
      );
      expect(info).toContain(
        ` size ${String(bytes.length)} bytes: control archive=${String(control.size)} bytes.\n`,
      );
    },
  );
});

/** dpkg's own rendering of a parsed relation field (varbufdependency). */
const renderRelations = (
  groups: readonly (readonly DebianRelation[])[],
): string =>
  groups
    .map((group) =>
      group
        .map(
          (relation) =>
            `${relation.name}${relation.arch_qualifier === null ? "" : `:${relation.arch_qualifier}`}${
              relation.version === null
                ? ""
                : ` (${relation.version.operator} ${relation.version.version})`
            }`,
        )
        .join(" | "),
    )
    .join(", ");

const RELATION_SET = new Set(
  RELATION_FIELDS.map((field) => field.toLowerCase()),
);

/** Compare every field with dpkg-deb -f: names and order from the raw text, values from dpkg's parse. */
const expectFieldsMatchDpkg = async (
  path: string,
  controlText: string,
): Promise<void> => {
  const control = parseControl(controlText);
  expect(control.problems).toEqual([]);
  const raw = await text(dpkgDeb(), ["-f", path]);
  expect(control.fields.map((field) => field.name)).toEqual(
    raw
      .split("\n")
      .flatMap((line) =>
        /^[^\s#][^:]*:/u.test(line) ? [line.slice(0, line.indexOf(":"))] : [],
      ),
  );
  for (const field of control.fields) {
    const dpkg = (await text(dpkgDeb(), ["-f", path, field.name])).replace(
      /\n$/u,
      "",
    );
    if (RELATION_SET.has(field.name.toLowerCase())) {
      const relations = parseRelations(field.value, field.name);
      expect(relations.problems, field.name).toEqual([]);
      expect(renderRelations(relations.groups), field.name).toBe(dpkg);
    } else expect(field.value, field.name).toBe(dpkg);
  }
};

const extractControl = async (path: string, name: string): Promise<string> => {
  const directory = join(root, `ctrl-${name}`);
  await mkdir(directory, { recursive: true });
  await pipe(
    BSDTAR ?? "bsdtar",
    ["-xf", "-", "-C", directory],
    await pipe(dpkgDeb(), ["--ctrl-tarfile", path]),
  );
  return directory;
};

const extractData = async (path: string, name: string): Promise<string> => {
  const directory = join(root, `data-${name}`);
  await mkdir(directory, { recursive: true });
  await pipe(
    BSDTAR ?? "bsdtar",
    ["-xf", "-", "-C", directory],
    await pipe(dpkgDeb(), ["--fsys-tarfile", path]),
  );
  return directory;
};

describe.skipIf(!READY)("control fields against dpkg-deb -f", () => {
  it.each(COMPRESSIONS)(
    "reads every field of the %s package as dpkg does",
    async (compression) => {
      const { path } = await load(compression);
      const directory = await extractControl(path, compression);
      const controlText = await readFile(join(directory, "control"), "utf8");
      await expectFieldsMatchDpkg(path, controlText);
      const control = parseControl(controlText);
      const value = (name: string): string =>
        control.fields.find((field) => field.name === name)?.value ?? "";
      // The multiline Description keeps its continuation lines, " ." paragraph line included.
      expect(value("Description").split("\n")).toEqual([
        "Oops demo package",
        " A fixture for the package reader.",
        " .",
        " It has scripts, a conffile, a symlink and a setuid helper.",
      ]);
      const depends = parseRelations(value("Depends"), "Depends").groups;
      expect(
        depends.map((group) => group.map((relation) => relation.name)),
      ).toEqual([["libc6"], ["bash", "dash"], ["libssl3"]]);
      expect(depends[2]?.[0]).toMatchObject({
        arch_qualifier: "amd64",
        version: { operator: ">>", version: "3.0.0~" },
      });
      expect(
        parseRelations(value("Conflicts")).groups[0]?.[0]?.version,
      ).toEqual({ operator: "<<", version: "1.0" });
    },
  );

  it("normalizes oddly formatted relations the way dpkg-deb does", async () => {
    const tree = join(root, "odd-control");
    await mkdir(join(tree, "DEBIAN"), { recursive: true });
    await mkdir(join(tree, "usr"), { recursive: true });
    await writeFile(join(tree, "usr", "x"), "x\n");
    const controlText = [
      "Package: odd",
      "Version: 1:2.0~rc1+dfsg-3",
      "Architecture: all",
      "Maintainer: Odd <odd@example.invalid>",
      "Depends: a(>=1),b|c,",
      "   d:any (<< 2),",
      "\te",
      "Recommends: f (<= 3) | g:native",
      "Built-Using: gcc-14 (= 14.2.0-1)",
      "X-Custom-Field: hello   ",
      "Description: short",
      " line one",
      " .",
      "   indented",
      "",
    ].join("\n");
    await writeFile(join(tree, "DEBIAN", "control"), controlText);
    const output = join(root, "odd.deb");
    await pipe(dpkgDeb(), [
      "--root-owner-group",
      "-Zgzip",
      "--build",
      tree,
      output,
    ]);
    await expectFieldsMatchDpkg(output, controlText);
  });
});

describe.skipIf(!READY)(
  "conffiles, md5sums and triggers against the extracted archives",
  () => {
    it.each(COMPRESSIONS)(
      "matches the %s package's control files and data",
      async (compression) => {
        const { path } = await load(compression);
        const control = await extractControl(path, `files-${compression}`);
        const data = await extractData(path, compression);
        const conffilesText = await readFile(
          join(control, "conffiles"),
          "utf8",
        );
        const conffiles = parseConffiles(conffilesText);
        expect(conffiles.problems).toEqual([]);
        expect(conffiles.paths.map((entry) => entry.path)).toEqual(
          conffilesText.trimEnd().split("\n"),
        );
        for (const entry of conffiles.paths)
          await expect(
            readFile(join(data, entry.path)),
          ).resolves.toBeInstanceOf(Buffer);
        const md5sums = parseMd5sums(
          await readFile(join(control, "md5sums"), "utf8"),
        );
        expect(md5sums.problems).toEqual([]);
        const regular = (
          await readdir(data, { recursive: true, withFileTypes: true })
        )
          .filter((entry) => entry.isFile())
          .map((entry) =>
            join(entry.parentPath, entry.name).slice(data.length + 1),
          )
          .sort();
        expect(md5sums.entries.map((entry) => entry.path).sort()).toEqual(
          regular,
        );
        for (const entry of md5sums.entries)
          expect(
            createHash("md5")
              .update(await readFile(join(data, entry.path)))
              .digest("hex"),
            entry.path,
          ).toBe(entry.md5);
        const triggersText = await readFile(join(control, "triggers"), "utf8");
        const triggers = parseTriggers(triggersText);
        expect(triggers.problems).toEqual([]);
        expect(
          triggers.triggers.map(
            ({ directive, name }) => `${directive} ${name}`,
          ),
        ).toEqual(triggersText.trim().split("\n"));
      },
    );
  },
);

/** Build a package whose control text dpkg-deb either accepts (stdout) or rejects (null). */
const dpkgAccepts = async (
  name: string,
  controlText: string,
): Promise<boolean> => {
  const tree = join(root, `verdict-${name}`);
  await mkdir(join(tree, "DEBIAN"), { recursive: true });
  await writeFile(join(tree, "DEBIAN", "control"), controlText);
  await chmod(join(tree, "DEBIAN"), 0o755);
  try {
    await pipe(dpkgDeb(), [
      "--root-owner-group",
      "--build",
      tree,
      join(root, `verdict-${name}.deb`),
    ]);
    return true;
  } catch {
    return false;
  }
};

const BASE =
  "Package: verdict\nVersion: 1.0\nArchitecture: all\nMaintainer: V <v@example.invalid>\nDescription: v\n";

describe.skipIf(!READY)(
  "control text dpkg-deb rejects is a problem here",
  () => {
    it.each([
      ["operator", "Depends: a (=> 1)\n"],
      ["empty-entry", "Depends: a, , b\n"],
      ["alternatives-in-conflicts", "Conflicts: a | b\n"],
      ["name-start", "Depends: -bad\n"],
      ["empty-version", "Depends: a (>= )\n"],
      ["epoch", "Depends: a (>= x:1)\n"],
      ["empty-revision", "Depends: a (>= 1.0-)\n"],
      ["duplicate-field", "Depends: a\nDepends: b\n"],
      ["field-name", "Bad Name: x\n"],
    ])("%s", async (name, extra) => {
      const controlText = BASE + extra;
      expect(await dpkgAccepts(name, controlText)).toBe(false);
      const control = parseControl(controlText);
      const relationProblems = control.fields.flatMap((field) =>
        RELATION_SET.has(field.name.toLowerCase())
          ? parseRelations(field.value, field.name).problems
          : [],
      );
      expect(
        [...control.problems, ...relationProblems].length,
        controlText,
      ).toBeGreaterThan(0);
    });

    it.each([
      ["obsolete-less", "Depends: a (< 1)\n", "<="],
      ["obsolete-greater", "Depends: a (> 1)\n", ">="],
    ])(
      "%s operator is accepted by dpkg, read as it reads it and named",
      async (name, extra, operator) => {
        expect(await dpkgAccepts(name, BASE + extra)).toBe(true);
        const field = parseControl(BASE + extra).fields.find(
          (entry) => entry.name === "Depends",
        );
        const relations = parseRelations(field?.value ?? "", "Depends");
        expect(relations.groups[0]?.[0]?.version?.operator).toBe(operator);
        expect(relations.problems).toHaveLength(1);
      },
    );
  },
);

describe("control text oddities without an oracle verdict", () => {
  it("names comments, continuation lines without a field, extra stanzas and folded simple fields", () => {
    const control = parseControl(
      "# note\n continued\nPackage: a\n b\nVersion: 1\n\nPackage: c\n",
    );
    expect(control.fields.map((field) => [field.name, field.value])).toEqual([
      ["Package", "a b"],
      ["Version", "1"],
    ]);
    expect(control.problems).toHaveLength(4);
  });

  it("parses architecture restrictions and build profiles of source-style relations", () => {
    const relations = parseRelations(
      "a [amd64 !i386] <!nocheck> <stage1 cross>, b [!amd64 !i386]",
    );
    expect(relations.groups[1]?.[0]?.architectures).toEqual([
      "!amd64",
      "!i386",
    ]);
    expect(relations.groups[0]?.[0]).toMatchObject({
      architectures: ["amd64", "!i386"],
      profiles: ["!nocheck", "stage1 cross"],
    });
    expect(relations.problems).toHaveLength(1);
  });

  it("reads conffile flags and rejects relative paths and empty lines", () => {
    const conffiles = parseConffiles(
      "/etc/a\nremove-on-upgrade /etc/b\nunknown /etc/c\nrelative\n\n",
    );
    expect(conffiles.paths).toEqual([
      { path: "/etc/a", flags: [] },
      { path: "/etc/b", flags: ["remove-on-upgrade"] },
      { path: "/etc/c", flags: ["unknown"] },
    ]);
    expect(conffiles.problems).toHaveLength(3);
    expect(
      parseMd5sums("d41d8cd98f00b204e9800998ecf8427e  ok\nnot a line\n")
        .problems,
    ).toHaveLength(1);
    expect(
      parseTriggers("interest foo # comment\n\nbogus bar\nactivate\n").problems,
    ).toHaveLength(2);
  });
});

/** A member slice of a real archive: header, data and its even padding. */
const memberSlice = (bytes: Uint8Array, member: ArMember): Uint8Array =>
  bytes.subarray(
    member.header_offset,
    member.data_offset + member.size + ((member.data_offset + member.size) % 2),
  );

/** A hand-built 60-byte member header around `data`, as dpkg-deb writes one. */
const arMember = (name: string, data: Uint8Array): Buffer =>
  Buffer.concat([
    Buffer.from(
      `${name.padEnd(16)}${"0".padEnd(12)}${"0".padEnd(6)}${"0".padEnd(6)}${"100644".padEnd(8)}${String(data.length).padEnd(10)}\`\n`,
      "latin1",
    ),
    data,
    data.length % 2 === 1 ? Buffer.from("\n") : Buffer.alloc(0),
  ]);

const archive = (...parts: Uint8Array[]): Buffer =>
  Buffer.concat([Buffer.from("!<arch>\n"), ...parts]);

const layoutOf = async (bytes: Uint8Array) => {
  const { members } = await readArMembers(positional(bytes), bytes.length);
  const first = members[0];
  return debLayout(
    members,
    first?.name === "debian-binary" ? memberBytes(bytes, first) : null,
  );
};

const rejection = async (bytes: Uint8Array): Promise<ArFormatError> => {
  const error = await readArMembers(positional(bytes), bytes.length).then(
    () => null,
    (caught: unknown) => caught,
  );
  if (!(error instanceof ArFormatError))
    throw new Error(`expected an ArFormatError, got ${String(error)}`);
  return error;
};

describe.skipIf(!READY)("malformed ar archives from real package bytes", () => {
  it("names the offset of each structural fault", async () => {
    const { bytes, members } = await load("xz");
    const data = members[2];
    if (data === undefined) throw new Error("members");
    // Byte 0 of the global magic changed to NUL.
    const badMagic = Buffer.from(bytes);
    badMagic[0] = 0;
    expect((await rejection(badMagic)).offset).toBe(0);
    // data.tar.xz's size field rewritten to 9999999999.
    const tooLong = Buffer.from(bytes);
    tooLong.write("9999999999", data.header_offset + 48, "latin1");
    expect((await rejection(tooLong)).offset).toBe(data.header_offset + 48);
    // The same size field rewritten to "12a".
    const notDecimal = Buffer.from(bytes);
    notDecimal.write("12a       ", data.header_offset + 48, "latin1");
    expect((await rejection(notDecimal)).offset).toBe(data.header_offset + 48);
    // The "`\n" terminator of data.tar.xz's header replaced by "xx".
    const badTerminator = Buffer.from(bytes);
    badTerminator.write("xx", data.header_offset + 58, "latin1");
    expect((await rejection(badTerminator)).offset).toBe(
      data.header_offset + 58,
    );
    // The file cut 100 bytes into data.tar.xz.
    expect(
      (await rejection(bytes.subarray(0, data.data_offset + 100))).offset,
    ).toBe(data.header_offset + 48);
    // 30 junk bytes appended: too short for a header, reported and not read.
    const trailing = Buffer.concat([bytes, Buffer.alloc(30, 0x41)]);
    expect(
      (await readArMembers(positional(trailing), trailing.length))
        .trailing_bytes,
    ).toBe(30);
  });

  it("reports a missing debian-binary, a wrong order and stray members", async () => {
    const { bytes, members } = await load("xz");
    const [binary, control, data] = members.map((member) =>
      memberSlice(bytes, member),
    );
    if (binary === undefined || control === undefined || data === undefined)
      throw new Error("members");
    const missing = await layoutOf(archive(control, data));
    expect(missing.format_version).toBeNull();
    expect(missing.problems).toEqual([
      'First member is "control.tar.xz", not "debian-binary".',
    ]);
    const swapped = await layoutOf(archive(binary, data, control));
    expect(swapped.problems).toEqual([
      'Data member "data.tar.xz" comes before any control member.',
      'Control member "control.tar.xz" comes after the data member.',
      "No control.tar member.",
    ]);
    const stray = await layoutOf(
      archive(
        binary,
        arMember("_gpgorigin", Buffer.from("sig")),
        control,
        arMember("junk", Buffer.from("x")),
        data,
        arMember("later", Buffer.from("y")),
      ),
    );
    expect(stray.signatures.map((member) => member.name)).toEqual([
      "_gpgorigin",
    ]);
    expect(stray.other.map((member) => member.name)).toEqual(["junk", "later"]);
    expect(stray.problems).toEqual([
      `Member "junk" comes before data.tar; dpkg-deb only skips such members when their names start with "_".`,
    ]);
    const future = await layoutOf(
      archive(arMember("debian-binary", Buffer.from("3.0\n")), control, data),
    );
    expect(future.format_version).toBe("3.0");
    expect(future.problems).toEqual([
      "debian-binary declares format 3.0; dpkg reads major version 2 only.",
    ]);
  });
});

describe.skipIf(!READY || LLVM_AR === null)(
  "GNU and BSD long member names against llvm-ar",
  () => {
    it.each(["gnu", "bsd"])(
      "reads the %s format llvm-ar writes",
      async (format) => {
        const directory = join(root, `ar-${format}`);
        await mkdir(directory, { recursive: true });
        const files: [string, string][] = [
          ["short.txt", "abc"],
          ["a-very-long-member-name-for-ar.txt", "long name data\n"],
          ["odd.bin", "odd"],
        ];
        for (const [name, content] of files)
          await writeFile(join(directory, name), content);
        const output = join(directory, `${format}.a`);
        await pipe(LLVM_AR ?? "llvm-ar", [
          "rcS",
          `--format=${format}`,
          output,
          ...files.map(([name]) => join(directory, name)),
        ]);
        const bytes = await readFile(output);
        const { members, trailing_bytes } = await readArMembers(
          positional(bytes),
          bytes.length,
        );
        expect(trailing_bytes).toBe(0);
        expect(ours(members, true)).toEqual(
          arListing(await text(LLVM_AR ?? "llvm-ar", ["tv", output])),
        );
        const named = members.filter((member) => member.name !== "//");
        expect(
          named.map((member) =>
            Buffer.from(memberBytes(bytes, member)).toString(),
          ),
        ).toEqual(files.map(([, content]) => content));
        // An odd-sized last member's "\n" pad byte replaced by "x".
        const last = named.at(-1);
        if (last === undefined) throw new Error("members");
        const badPad = Buffer.from(bytes);
        badPad[last.data_offset + last.size] = 0x78;
        if (last.data_offset + last.size < bytes.length)
          expect((await rejection(badPad)).offset).toBe(
            last.data_offset + last.size,
          );
      },
    );
  },
);
