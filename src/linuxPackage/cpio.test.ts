import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  constants,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, zstdDecompressSync } from "node:zlib";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { ByteSource } from "../artifacts/archives/ByteSource.js";
import {
  CpioStream,
  rpmStrippedFiles,
  type CpioMember,
  type CpioStrippedLookup,
} from "./cpio.js";
import { rpmFacts } from "./rpm/facts.js";
import { readRpm } from "./rpm/header.js";
import {
  buildLinuxFixtures,
  LINUX_TOOLS,
} from "../../tests/fixtures/linuxProducers.js";
import { removeTestWorkspace } from "../../tests/support/workspace/workspaceFixture.js";

/**
 * The cpio parser over real producers: every RPM payload rpmbuild 6.1.0
 * writes (rpm 6 format: stripped 07070X headers; rpm 4 format: newc)
 * member by member against `rpm -qp --dump`, and bsdtar's newc archives
 * against `bsdtar -tvf`. crc (070702) archives are bsdtar newc archives
 * with the magic and checksum fields rewritten, since no installed tool
 * writes crc; malformed inputs are real archives with the edits each test
 * names.
 */

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const XZ = (await exists("/opt/homebrew/bin/xz"))
  ? "/opt/homebrew/bin/xz"
  : (await exists("/usr/bin/xz"))
    ? "/usr/bin/xz"
    : null;
const BSDTAR = (await exists("/usr/bin/bsdtar"))
  ? "/usr/bin/bsdtar"
  : (await exists("/opt/homebrew/bin/bsdtar"))
    ? "/opt/homebrew/bin/bsdtar"
    : null;

const pipe = (
  command: string,
  args: readonly string[],
  input?: Uint8Array,
  cwd?: string,
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      env: {
        PATH: "/opt/homebrew/bin:/usr/bin:/bin",
        HOME: process.env.HOME ?? "/tmp",
        LC_ALL: "C",
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
              `${command} exited ${String(code)}: ${Buffer.concat(err).toString()}`,
            ),
          ),
    );
    child.stdin.end(input ?? Buffer.alloc(0));
  });

/** Feed the archive in 7-byte pieces so headers, names and data straddle chunk boundaries. */
const source = (bytes: Uint8Array): ByteSource =>
  new ByteSource(
    (async function* () {
      for (let at = 0; at < bytes.length; at += 7)
        yield bytes.subarray(at, at + 7);
    })(),
  );

interface Read {
  readonly member: CpioMember;
  readonly data: Buffer;
}

const readAll = async (
  bytes: Uint8Array,
  stripped?: CpioStrippedLookup,
): Promise<{ members: Read[]; cpio: CpioStream }> => {
  const cpio = new CpioStream(source(bytes), stripped);
  const members: Read[] = [];
  for (
    let member = await cpio.next();
    member !== null;
    member = await cpio.next()
  ) {
    const pieces: Buffer[] = [];
    for await (const piece of cpio.data()) pieces.push(piece);
    members.push({ member, data: Buffer.concat(pieces) });
  }
  return { members, cpio };
};

const failure = async (
  bytes: Uint8Array,
  stripped?: CpioStrippedLookup,
): Promise<ArtifactReaderFailure> => {
  const error = await readAll(bytes, stripped).then(
    () => null,
    (caught: unknown) => caught,
  );
  if (!(error instanceof ArtifactReaderFailure))
    throw new Error(`expected an ArtifactReaderFailure, got ${String(error)}`);
  return error;
};

let root = "";
const packages = new Map<string, string>();

const COVERAGE_SPEC = `Name: cov-cpio
Version: 1
Release: 1
Summary: cpio coverage
License: MIT
AutoReqProv: no

%description
cpio coverage.

%install
mkdir -p %{buildroot}/usr/share/cov %{buildroot}/usr/bin
printf 'a\\n' > %{buildroot}/usr/share/cov/a.txt
ln %{buildroot}/usr/share/cov/a.txt %{buildroot}/usr/share/cov/a-hard.txt
ln %{buildroot}/usr/share/cov/a.txt %{buildroot}/usr/share/cov/a-hard2.txt
printf 'odd' > %{buildroot}/usr/share/cov/odd
printf '#!/bin/sh\\n' > %{buildroot}/usr/bin/tool
ln -s tool %{buildroot}/usr/bin/tool-link

%files
/usr/share/cov
/usr/bin/tool
/usr/bin/tool-link
%ghost /etc/cov.conf
`;

const buildCoverage = async (format: 4 | 6): Promise<string> => {
  const top = join(root, `cpio-v${String(format)}`);
  await mkdir(join(top, "SPECS"), { recursive: true });
  await writeFile(join(top, "SPECS", "cov.spec"), COVERAGE_SPEC);
  await pipe(LINUX_TOOLS?.rpmbuild ?? "rpmbuild", [
    "-bb",
    "--target",
    "x86_64-linux",
    "--define",
    `_topdir ${top}`,
    "--define",
    `_rpmformat ${String(format)}`,
    join(top, "SPECS", "cov.spec"),
  ]);
  return join(top, "RPMS", "x86_64", "cov-cpio-1-1.x86_64.rpm");
};

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "oops-cpio-")));
  if (LINUX_TOOLS === null || XZ === null) return;
  const fixtures = await buildLinuxFixtures(root);
  for (const [compression, path] of Object.entries(fixtures.rpm))
    packages.set(`oops-v6-${compression}`, path);
  packages.set("cov-v4", await buildCoverage(4));
  packages.set("cov-v6", await buildCoverage(6));
}, 180_000);

afterAll(async () => {
  if (root !== "") await removeTestWorkspace(root);
});

const PACKAGES = [
  "oops-v6-zstd",
  "oops-v6-xz",
  "oops-v6-gzip",
  "cov-v4",
  "cov-v6",
] as const;

const payload = async (
  bytes: Uint8Array,
  offset: number,
  compressor: string | null,
): Promise<Buffer> => {
  const compressed = bytes.subarray(offset);
  if (compressor === "zstd") return zstdDecompressSync(compressed);
  if (compressor === "gzip") return gunzipSync(compressed);
  if (compressor === "xz") return pipe(XZ ?? "xz", ["-dc"], compressed);
  throw new Error(`no decompressor for ${String(compressor)}`);
};

interface DumpLine {
  readonly path: string;
  readonly size: number;
  readonly mtime: number;
  readonly digest: string;
  readonly mode: number;
  readonly link: string;
}

const dump = async (path: string): Promise<DumpLine[]> =>
  (await pipe(LINUX_TOOLS?.rpm ?? "rpm", ["-qp", "--dump", path]))
    .toString()
    .trimEnd()
    .split("\n")
    .map((line) => {
      const fields = line.split(" ");
      // Paths may hold spaces; the ten fields after the path never do.
      const tail = fields.slice(-10);
      return {
        path: fields.slice(0, -10).join(" "),
        size: Number(tail[0]),
        mtime: Number(tail[1]),
        digest: tail[2] ?? "",
        mode: Number.parseInt(tail[3] ?? "", 8),
        link: tail[9] ?? "",
      };
    });

describe.skipIf(LINUX_TOOLS === null || XZ === null)(
  "RPM payloads against rpm -qp --dump",
  () => {
    it.each(PACKAGES)("%s", async (label) => {
      const path = packages.get(label) ?? "";
      const bytes = await readFile(path);
      const file = await readRpm(
        async (offset, length) => bytes.subarray(offset, offset + length),
        bytes.length,
      );
      const facts = rpmFacts(file);
      const archive = await payload(
        bytes,
        file.payload_offset,
        facts.payload.compressor,
      );
      const { members, cpio } = await readAll(
        archive,
        rpmStrippedFiles(facts.files),
      );
      expect(cpio.end).toEqual({ trailingBytes: 0, trailingNonZeroBytes: 0 });
      const lines = await dump(path);
      // %ghost files have no payload member; rpm writes a hard-link set after the other files.
      const present = lines.filter(
        (line) =>
          !(
            facts.files
              .find((entry) => entry.path === line.path)
              ?.flags.includes("ghost") ?? false
          ),
      );
      const pathOf = (member: CpioMember): string =>
        member.format === "stripped"
          ? (member.name ?? "")
          : (member.name ?? "").replace(/^\./u, "");
      expect(members.map(({ member }) => pathOf(member)).sort()).toEqual(
        present.map((line) => line.path).sort(),
      );
      const stripped = facts.rpm_format === 6;
      expect(new Set(members.map(({ member }) => member.format))).toEqual(
        new Set([stripped ? "stripped" : "newc"]),
      );
      const lastLink = new Map<number, number>();
      for (const [index, { member }] of members.entries())
        if (((member.mode ?? 0) & 0o170000) === 0o100000)
          lastLink.set(member.inode ?? -1, index);
      for (const [index, { member, data }] of members.entries()) {
        const line = present.find(
          (candidate) => candidate.path === pathOf(member),
        );
        if (line === undefined) throw new Error("dump");
        const entry = facts.files.find(
          (candidate) => candidate.path === line.path,
        );
        expect(
          [member.mode, member.mtime, member.inode, member.nlink],
          line.path,
        ).toEqual([line.mode, line.mtime, entry?.inode, entry?.links]);
        if (stripped)
          expect(member.fileIndex).toBe(
            facts.files.findIndex((candidate) => candidate.path === line.path),
          );
        const type = line.mode & 0o170000;
        if (type === 0o120000)
          expect(data.toString(), line.path).toBe(line.link);
        else if (type !== 0o100000) expect(data.length, line.path).toBe(0);
        else if (lastLink.get(member.inode ?? -1) !== index) {
          // Earlier links of a hard-link set carry no data; the last one carries it.
          expect(data.length, line.path).toBe(0);
          expect((entry?.links ?? 0) > 1, line.path).toBe(true);
        } else {
          expect(data.length, line.path).toBe(line.size);
          expect(
            createHash("sha256").update(data).digest("hex"),
            line.path,
          ).toBe(line.digest);
        }
      }
    });
  },
);

const tree = async (name: string): Promise<string> => {
  const directory = join(root, name);
  await mkdir(join(directory, "d"), { recursive: true });
  await writeFile(join(directory, "d", "a"), "one\n");
  await link(join(directory, "d", "a"), join(directory, "d", "b"));
  await symlink("a", join(directory, "d", "l"));
  await writeFile(join(directory, "odd"), "x");
  await writeFile(join(directory, "ünïcode name.txt"), "uni\n");
  return directory;
};

const archives = new Map<string, Promise<Buffer>>();

const bsdtarArchive = (format: "newc" | "odc"): Promise<Buffer> => {
  const cached =
    archives.get(format) ??
    tree(`tree-${format}`).then((directory) =>
      pipe(
        BSDTAR ?? "bsdtar",
        ["-cf", "-", "--format", format, "."],
        undefined,
        directory,
      ),
    );
  archives.set(format, cached);
  return cached;
};

/** bsdtar -tv under LC_ALL=C writes non-ASCII name bytes as \ooo escapes. */
const unescape = (line: string): string =>
  Buffer.from(
    line.replace(/\\([0-7]{3})/gu, (_, octal: string) =>
      String.fromCharCode(Number.parseInt(octal, 8)),
    ),
    "latin1",
  ).toString("utf8");

/** Rewrite a newc archive as crc: magic 070702 and each check field the byte sum of its data. */
const asCrc = (newc: Buffer, members: readonly Read[]): Buffer => {
  const crc = Buffer.from(newc);
  for (const { member, data } of members) {
    crc.write("070702", member.headerOffset, "latin1");
    const sum = data.reduce((total, byte) => (total + byte) >>> 0, 0);
    crc.write(
      sum.toString(16).padStart(8, "0"),
      member.headerOffset + 102,
      "latin1",
    );
  }
  return crc;
};

describe.skipIf(BSDTAR === null)(
  "bsdtar newc and crc archives against bsdtar -tvf",
  () => {
    it("lists every member, hard links and symlinks as stored", async () => {
      const newc = await bsdtarArchive("newc");
      const { members, cpio } = await readAll(newc);
      expect(cpio.end?.trailingNonZeroBytes).toBe(0);
      const listing = (await pipe(BSDTAR ?? "bsdtar", ["-tvf", "-"], newc))
        .toString("latin1")
        .trimEnd()
        .split("\n")
        .map(unescape);
      expect(members.length).toBe(listing.length);
      for (const [index, { member }] of members.entries()) {
        const fields = (listing[index] ?? "").split(/\s+/u);
        expect([fields[1], fields[2], fields[4]]).toEqual([
          String(member.nlink),
          String(member.uid),
          String(member.size),
        ]);
        expect(listing[index]).toContain(` ${member.name ?? ""}`);
      }
      const byName = new Map(
        members.map((entry) => [entry.member.name, entry]),
      );
      // bsdtar stores the hard-linked bytes with the last link; the first has size 0.
      expect([
        byName.get("./d/a")?.data.toString(),
        byName.get("./d/b")?.data.toString(),
      ]).toEqual(["", "one\n"]);
      expect(byName.get("./d/l")?.data.toString()).toBe("a");
      expect(byName.get("./ünïcode name.txt")?.data.toString()).toBe("uni\n");
      expect(
        members.every(
          ({ member }) => member.format === "newc" && member.checksum === null,
        ),
      ).toBe(true);
      const crc = asCrc(newc, members);
      const checked = await readAll(crc);
      expect(
        checked.members.map(({ member }) => [member.format, member.checksum]),
      ).toEqual(
        members.map(({ data }) => [
          "crc",
          data.reduce((total, byte) => (total + byte) >>> 0, 0),
        ]),
      );
      // One data byte of ./odd changed from "x" to "y": the sum no longer matches.
      const odd = byName.get("./odd")?.member;
      if (odd === undefined) throw new Error("odd");
      crc[odd.dataOffset] = 0x79;
      expect((await failure(crc)).reason).toBe("integrity");
    });

    it("refuses odc archives with a clear message", async () => {
      expect((await failure(await bsdtarArchive("odc"))).message).toContain(
        "odc (070707) format",
      );
    });

    it("names malformed headers, names, data and a missing trailer", async () => {
      const newc = await bsdtarArchive("newc");
      const { members } = await readAll(newc);
      const second = members[1]?.member;
      if (second === undefined) throw new Error("members");
      const edit = (change: (copy: Buffer) => void): Buffer => {
        const copy = Buffer.from(newc);
        change(copy);
        return copy;
      };
      const message = async (bytes: Uint8Array): Promise<string> =>
        (await failure(bytes)).message;
      // Second header's magic set to "070799".
      expect(
        await message(
          edit((copy) => copy.write("070799", second.headerOffset, "latin1")),
        ),
      ).toContain('magic "070799"');
      // Second header's mode field set to "zzzzzzzz".
      expect(
        await message(
          edit((copy) =>
            copy.write("zzzzzzzz", second.headerOffset + 14, "latin1"),
          ),
        ),
      ).toContain("field mode");
      // Second member name's NUL terminator replaced by "x".
      const nameEnd =
        second.headerOffset +
        110 +
        Buffer.from(second.rawNameHex, "hex").length;
      expect(
        await message(edit((copy) => void (copy[nameEnd] = 0x78))),
      ).toContain("does not end with a NUL");
      // A NUL written over the second member name's first byte.
      expect(
        await message(
          edit((copy) => void (copy[second.headerOffset + 110] = 0)),
        ),
      ).toContain("NUL byte before its end");
      // The archive cut one byte into the last data-carrying member.
      const last = members.filter(({ data }) => data.length > 1).at(-1)?.member;
      if (last === undefined) throw new Error("members");
      expect(await message(newc.subarray(0, last.dataOffset + 1))).toContain(
        "truncated in member data",
      );
      // The archive cut right before the TRAILER!!! header.
      const trailer = newc.indexOf("TRAILER!!!") - 110;
      expect(await message(newc.subarray(0, trailer))).toContain(
        "without a TRAILER!!!",
      );
    });
  },
);

describe.skipIf(LINUX_TOOLS === null || XZ === null)(
  "stripped headers need the RPM file list",
  () => {
    it("refuses a stripped header without a lookup or with an unknown index", async () => {
      const bytes = await readFile(packages.get("oops-v6-zstd") ?? "");
      const file = await readRpm(
        async (offset, length) => bytes.subarray(offset, offset + length),
        bytes.length,
      );
      const archive = await payload(bytes, file.payload_offset, "zstd");
      expect((await failure(archive)).message).toContain(
        "needs the RPM header's file list",
      );
      expect((await failure(archive, () => null)).message).toContain(
        "which the RPM header does not list",
      );
    });
  },
);
