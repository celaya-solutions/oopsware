import { execFile } from "node:child_process";
import {
  access,
  copyFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

import { verifyPackedBridge } from "../../../scripts/verify-packed-bridge.mjs";
import {
  PrivateRuntimeRoot,
  privateRuntimeRootCapability,
} from "../../../src/process/PrivateRuntimeRoot.js";
import { GHIDRA_BRIDGE_SOURCES } from "../../../src/ghidra/GhidraBridgeSources.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const exec = promisify(execFile);
const packedFiles = [
  "package/bridge/hopper_bridge.py",
  "package/bridge/cutter/rea_bridge.py",
  ...Object.values(GHIDRA_BRIDGE_SOURCES).map(
    (name) => `package/bridge/ghidra/${name}`,
  ),
];
const hopper = packedFiles[0]!;
const validSource =
  '# Unicode source: 雨\nraise RuntimeError("Packed source must never execute")\n';

async function fixture(source: string = validSource, omitHopper = false) {
  const directory = await createTestTempDirectory("rea-packed-bridge-");
  const staging = join(directory, "source");
  const workspace = join(directory, "workspace");
  await mkdir(workspace);
  for (const member of packedFiles) {
    if (omitHopper && member === hopper) continue;
    const path = join(staging, member);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, member === hopper ? source : "fixture\n");
  }
  const tarball = join(directory, "packed bridges.tgz");
  await exec("tar", ["-czf", tarball, "-C", staging, "package"]);
  return { workspace, tarball, packedFiles };
}

it("parses packed Python without executing it or extracting archive members", async () => {
  const input = await fixture();
  const sentinel = join(input.workspace, "caller-owned.txt");
  await writeFile(sentinel, "preserved\n");
  await verifyPackedBridge(input);
  expect(await readdir(input.workspace)).toEqual(["caller-owned.txt"]);
  expect(await readFile(sentinel, "utf8")).toBe("preserved\n");
});

it.each(packedFiles)(
  "rejects an unadvertised required member: %s",
  async (member) => {
    const input = await fixture();
    await expect(
      verifyPackedBridge({
        ...input,
        packedFiles: packedFiles.filter((path) => path !== member),
      }),
    ).rejects.toThrow(`package omitted ${member}`);
    expect(await readdir(input.workspace)).toEqual([]);
  },
);

it("rejects a missing actual Python member even when the listing advertises it", async () => {
  const input = await fixture(validSource, true);
  await expect(verifyPackedBridge(input)).rejects.toMatchObject({
    stderr: expect.stringContaining(hopper),
  });
  expect(await readdir(input.workspace)).toEqual([]);
});

it("reports invalid packed Python syntax with the member filename", async () => {
  const input = await fixture("def broken(:\n");
  await expect(verifyPackedBridge(input)).rejects.toMatchObject({
    stderr: expect.stringMatching(/hopper_bridge\.py[\s\S]*SyntaxError/u),
  });
  expect(await readdir(input.workspace)).toEqual([]);
});

it.each(["valid", "invalid"] as const)(
  "parses %s source under an owned private root and preserves owner cleanup",
  async (kind) => {
    expect(privateRuntimeRootCapability().available).toBe(true);
    const input = await fixture(
      kind === "valid" ? validSource : "def broken(:\n",
    );
    const root = await PrivateRuntimeRoot.create({
      prefix: "rea-packed-bridge-lease-",
    });
    try {
      const pack = join(root.path, "pack");
      await mkdir(pack);
      const tarball = join(pack, "packed bridges.tgz");
      await copyFile(input.tarball, tarball);
      const parsed = verifyPackedBridge({ tarball, packedFiles });
      if (kind === "valid") await parsed;
      else
        await expect(parsed).rejects.toMatchObject({
          stderr: expect.stringContaining("SyntaxError"),
        });
      expect(await readdir(root.path)).toEqual(["pack"]);
      expect(await readFile(tarball)).toEqual(await readFile(input.tarball));
    } finally {
      await root.close();
    }
    await expect(access(root.path)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it.each(["symlink", "hardlink", "directory"])(
  "rejects a %s Python member without following it or extracting files",
  async (kind) => {
    const input = await fixture();
    await exec("python3", [
      "-c",
      [
        "import io, sys, tarfile",
        "with tarfile.open(sys.argv[1], 'w:gz') as archive:",
        "    target = tarfile.TarInfo('package/bridge/target.py')",
        "    target.size = 5",
        "    archive.addfile(target, io.BytesIO(b'pass\\n'))",
        "    member = tarfile.TarInfo(sys.argv[2])",
        "    member.type = {'symlink': tarfile.SYMTYPE, 'hardlink': tarfile.LNKTYPE, 'directory': tarfile.DIRTYPE}[sys.argv[3]]",
        "    member.linkname = 'target.py' if sys.argv[3] == 'symlink' else target.name",
        "    archive.addfile(member)",
      ].join("\n"),
      input.tarball,
      hopper,
      kind,
    ]);
    await expect(verifyPackedBridge(input)).rejects.toMatchObject({
      stderr: expect.stringContaining(`${hopper} is not a regular file`),
    });
    expect(await readdir(input.workspace)).toEqual([]);
  },
);

it("rejects malformed archives without writing to the caller's workspace", async () => {
  const input = await fixture();
  await writeFile(input.tarball, "not a tar archive\n");
  await expect(verifyPackedBridge(input)).rejects.toMatchObject({
    stderr: expect.stringContaining("ReadError"),
  });
  expect(await readdir(input.workspace)).toEqual([]);
});
