import { createHash, randomBytes } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { extractArtifact } from "../../../src/artifacts/extraction/ArtifactExtraction.js";
import {
  inventoryArtifact,
  withArtifactResourceScope,
} from "../../fixtures/artifactInventory.js";
import type { ArtifactInventoryResult } from "../../../src/domain/artifactGraph.js";
import {
  BSDTAR,
  createArchiveSourceTree,
  LONG_NAME,
  appendTar,
  produce7z,
  produceGzip,
  produceTar,
  produceXz,
  SEVEN_ZIP,
  UNICODE_NAME,
  XZ,
  type TarDialect,
} from "../../fixtures/archiveProducers.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const sha256 = (bytes: Buffer | string): string =>
  createHash("sha256").update(bytes).digest("hex");

const MEMBERS = [
  "a.txt",
  "dir",
  UNICODE_NAME,
  LONG_NAME.split("/")[0] ?? "",
  "tool.sh",
];

const fileOccurrences = (inventory: ArtifactInventoryResult) =>
  new Map(
    inventory.occurrences
      .filter(
        (occurrence) =>
          occurrence.entry_kind === "file" && occurrence.logical_path !== ".",
      )
      .map((occurrence) => {
        const node = inventory.nodes.find(
          ({ artifact_id }) => artifact_id === occurrence.artifact_id,
        );
        return [
          occurrence.logical_path,
          { occurrence, sha256: node?.sha256 },
        ] as const;
      }),
  );

const expectMembers = (
  inventory: ArtifactInventoryResult,
  files: Readonly<Record<string, string>>,
): void => {
  const found = fileOccurrences(inventory);
  expect([...found.keys()].sort()).toEqual(Object.keys(files).sort());
  for (const [name, text] of Object.entries(files)) {
    expect(found.get(name)?.sha256).toBe(sha256(text));
    expect(found.get(name)?.occurrence.hash_status).toBe("verified");
  }
};

const readTree = async (
  root: string,
  prefix = "",
): Promise<Record<string, string>> => {
  const result: Record<string, string> = {};
  for (const entry of await readdir(join(root, prefix), {
    withFileTypes: true,
  })) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory())
      Object.assign(result, await readTree(root, relative));
    else if (entry.isFile())
      result[relative] = await readFile(join(root, relative), "utf8");
    else result[relative] = "<non-regular>";
  }
  return result;
};

const extract = async (input: string, format: string, output: string) =>
  withArtifactResourceScope((resourceScope) =>
    extractArtifact({
      inputPath: input,
      inputFormat: format as never,
      outputRoot: output,
      environment: {},
      integrityPolicy: "fail",
      resourceScope,
    }),
  );

const workspace = async (label: string) => {
  const root = await createTestTempDirectory(`rea-archive-${label}-`);
  const source = join(root, "source");
  await mkdir(source);
  return { root, source };
};

describe("tar archives from the system tar", () => {
  it.each<TarDialect>(["ustar", "pax", "gnu"])(
    "inventories and extracts a %s archive with exact names and bytes",
    async (dialect) => {
      const { root, source } = await workspace(`tar-${dialect}`);
      const { files } = await createArchiveSourceTree(source);
      const archive = join(root, `fixture-${dialect}.tar`);
      await produceTar(source, archive, MEMBERS, dialect);

      const inventory = await inventoryArtifact(archive);
      expect(inventory.manifest.root_format).toBe("tar");
      expect(
        inventory.occurrences.find(({ logical_path }) => logical_path === ".")
          ?.artifact_kind,
      ).toBe("container");
      expectMembers(inventory, files);
      expect(
        fileOccurrences(inventory).get("tool.sh")?.occurrence.executable,
      ).toBe(true);
      expect(
        fileOccurrences(inventory).get("a.txt")?.occurrence.source_location,
      ).not.toBeNull();

      const output = join(root, "out");
      const extraction = await extract(archive, "tar", output);
      expect(extraction.artifacts).toHaveLength(Object.keys(files).length);
      expect(await readTree(output)).toEqual(files);
    },
    30_000,
  );

  it("records links without following or materializing them", async () => {
    const { root, source } = await workspace("tar-links");
    const { files } = await createArchiveSourceTree(source, { links: true });
    const archive = join(root, "links.tar");
    await produceTar(
      source,
      archive,
      ["a.txt", "hard.txt", "escape-link"],
      "pax",
    );

    const inventory = await inventoryArtifact(archive);
    const links = inventory.occurrences.filter(
      ({ entry_kind }) => entry_kind === "symlink",
    );
    expect(links.map(({ logical_path }) => logical_path).sort()).toEqual(
      ["escape-link", "hard.txt"].sort(),
    );
    expect(links.flatMap(({ limitations }) => limitations).join(" ")).toMatch(
      /symbolic link to "\.\.\/outside\/secret"/u,
    );
    expect(links.flatMap(({ limitations }) => limitations).join(" ")).toMatch(
      /hard link to "a\.txt"/u,
    );

    const output = join(root, "out");
    await extract(archive, "tar", output);
    expect(await readTree(output)).toEqual({ "a.txt": files["a.txt"] });
  });

  it("retains duplicate member names and refuses to extract either", async () => {
    const { root, source } = await workspace("tar-duplicate");
    await createArchiveSourceTree(source);
    const archive = join(root, "duplicate.tar");
    await produceTar(source, archive, ["a.txt"], "pax");
    await writeFile(join(source, "a.txt"), "second spelling\n");
    await appendTar(source, archive, ["a.txt"]);

    // The shared path registry keeps repeated same-kind members as distinct
    // occurrences; extraction refuses to materialize the collision.
    const inventory = await inventoryArtifact(archive);
    expect(
      inventory.occurrences
        .filter(({ logical_path }) => logical_path === "a.txt")
        .map(({ entry_kind }) => entry_kind),
    ).toEqual(["file", "file"]);
    await expect(
      extract(archive, "tar", join(root, "out")),
    ).rejects.toMatchObject({
      reason: "path",
    });
    await expect(stat(join(root, "out"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses a corrupted header checksum and a truncated member", async () => {
    const { root, source } = await workspace("tar-damaged");
    await createArchiveSourceTree(source);
    const archive = join(root, "fixture.tar");
    await produceTar(source, archive, ["a.txt", "dir"], "ustar");
    const bytes = await readFile(archive);

    const corrupted = join(root, "corrupted.tar");
    const flipped = Buffer.from(bytes);
    flipped[0] = (flipped[0] ?? 0) ^ 0x01;
    await writeFile(corrupted, flipped);
    // The first header no longer verifies, so the bytes are not recognized as tar.
    expect((await inventoryArtifact(corrupted)).manifest.root_format).not.toBe(
      "tar",
    );

    const second = join(root, "second-corrupted.tar");
    const damagedLater = Buffer.from(bytes);
    damagedLater[1024] = (damagedLater[1024] ?? 0) ^ 0x01;
    await writeFile(second, damagedLater);
    await expect(inventoryArtifact(second)).rejects.toMatchObject({
      reason: "integrity",
      message: expect.stringMatching(/checksum/u),
    });

    const truncated = join(root, "truncated.tar");
    await writeFile(truncated, bytes.subarray(0, 512 + 3));
    await expect(inventoryArtifact(truncated)).rejects.toMatchObject({
      reason: "format",
      message: expect.stringMatching(/truncated/u),
    });
  });
});

/** A ustar header built by hand for hostile names no real producer writes. */
const ustarMember = (name: string, body: string, typeflag = "0"): Buffer => {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, "latin1");
  header.write("0000000\0", 108, "latin1");
  header.write("0000000\0", 116, "latin1");
  header.write(
    `${Buffer.byteLength(body).toString(8).padStart(11, "0")}\0`,
    124,
    "latin1",
  );
  header.write("00000000000\0", 136, "latin1");
  header.write(typeflag, 156, "latin1");
  header.write("ustar\0", 257, "latin1");
  header.write("00", 263, "latin1");
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
  const data = Buffer.alloc(Math.ceil(Buffer.byteLength(body) / 512) * 512);
  data.write(body, 0, "utf8");
  return Buffer.concat([header, data]);
};

const handBuiltTar = (...members: Buffer[]): Buffer =>
  Buffer.concat([...members, Buffer.alloc(1024)]);

describe("hostile tar member names", () => {
  it.each([
    ["parent traversal", "../escape.txt"],
    ["nested traversal", "dir/../../escape.txt"],
    ["absolute path", "/etc/escape.txt"],
    ["drive letter", "C:/escape.txt"],
  ])("rejects %s before anything is written", async (_label, name) => {
    const { root } = await workspace("tar-hostile");
    const archive = join(root, "hostile.tar");
    await writeFile(
      archive,
      handBuiltTar(
        ustarMember("ok.txt", "fine\n"),
        ustarMember(name, "escape\n"),
      ),
    );
    await expect(inventoryArtifact(archive)).rejects.toMatchObject({
      reason: "path",
    });
    await expect(
      extract(archive, "tar", join(root, "out")),
    ).rejects.toMatchObject({
      reason: "path",
    });
    await expect(stat(join(root, "out"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(join(root, "escape.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps a backslash as a literal name character, not a separator", async () => {
    const { root } = await workspace("tar-backslash");
    const archive = join(root, "backslash.tar");
    await writeFile(
      archive,
      handBuiltTar(
        ustarMember("ok.txt", "fine\n"),
        ustarMember("dir\\escape.txt", "literal\n"),
      ),
    );
    expectMembers(await inventoryArtifact(archive), {
      "ok.txt": "fine\n",
      "dir\\escape.txt": "literal\n",
    });
  });

  it("refuses a regular file beneath a symbolic link member", async () => {
    const { root } = await workspace("tar-link-parent");
    const archive = join(root, "through-link.tar");
    const link = ustarMember("link", "", "2");
    link.write("/tmp", 157, "utf8");
    // Recompute the checksum after setting the link name.
    link.fill(0x20, 148, 156);
    let sum = 0;
    for (const byte of link.subarray(0, 512)) sum += byte;
    link.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
    await writeFile(
      archive,
      handBuiltTar(link, ustarMember("link/escape.txt", "x\n")),
    );
    await expect(inventoryArtifact(archive)).rejects.toMatchObject({
      reason: "path",
      message: expect.stringMatching(/prefix conflict/u),
    });
  });

  it("reports special members and refuses incomplete extraction", async () => {
    const { root } = await workspace("tar-special");
    const archive = join(root, "special.tar");
    await writeFile(
      archive,
      handBuiltTar(
        ustarMember("ok.txt", "fine\n"),
        ustarMember("pipe", "", "6"),
      ),
    );
    const inventory = await inventoryArtifact(archive);
    expect(inventory.limitations.join(" ")).toMatch(/"pipe" is a FIFO/u);
    await expect(
      extract(archive, "tar", join(root, "out")),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/cannot be extracted completely/u),
    });
    await expect(stat(join(root, "out"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("never hides a regular file that names the archive root", async () => {
    const { root } = await workspace("tar-root-file");
    const archive = join(root, "root-file.tar");
    await writeFile(
      archive,
      handBuiltTar(
        ustarMember("./", "", "5"),
        ustarMember(".", "hidden bytes\n"),
        ustarMember("ok.txt", "fine\n"),
      ),
    );
    const inventory = await inventoryArtifact(archive);
    expect([...fileOccurrences(inventory).keys()]).toEqual(["ok.txt"]);
    expect(inventory.limitations.join(" ")).toMatch(
      /names the archive root itself \(".?"\) but is not a directory/u,
    );
    await expect(
      extract(archive, "tar", join(root, "out")),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/cannot be extracted completely/u),
    });
  });

  it("treats an empty pax path as deleted, so the header name applies", async () => {
    const { root } = await workspace("tar-pax-empty");
    const archive = join(root, "pax-empty.tar");
    await writeFile(
      archive,
      handBuiltTar(
        ustarMember("PaxHeaders/ok.txt", "8 path=\n", "x"),
        ustarMember("ok.txt", "fine\n"),
      ),
    );
    expectMembers(await inventoryArtifact(archive), { "ok.txt": "fine\n" });
  });

  it("accepts a header whose checksum sums signed bytes", async () => {
    const { root } = await workspace("tar-signed-sum");
    const archive = join(root, "signed.tar");
    const member = ustarMember("café.txt", "fine\n");
    member.fill(0x20, 148, 156);
    let signed = 0;
    for (const byte of member.subarray(0, 512))
      signed += byte >= 0x80 ? byte - 0x100 : byte;
    member.write(`${signed.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
    await writeFile(archive, handBuiltTar(member));
    expectMembers(await inventoryArtifact(archive), {
      "café.txt": "fine\n",
    });
  });
});

describe("compression streams", () => {
  it("decodes a gzip-wrapped tar and records the decoded digest", async () => {
    const { root, source } = await workspace("tgz");
    const { files } = await createArchiveSourceTree(source);
    const tar = join(root, "fixture.tar");
    await produceTar(source, tar, MEMBERS, "pax");
    const plain = await readFile(tar);
    const archive = await produceGzip(tar);

    const inventory = await inventoryArtifact(archive);
    expect(inventory.manifest.root_format).toBe("gzip");
    expectMembers(inventory, files);
    expect(inventory.limitations.join(" ")).toContain(
      `Gzip input was decoded to ${String(plain.length)} bytes with SHA-256 ${sha256(plain)}.`,
    );
    expect(inventory.provenance).toEqual([
      expect.objectContaining({ tool: "node:zlib", effects: ["read"] }),
    ]);
    const output = join(root, "out");
    const extraction = await extract(archive, "gzip", output);
    expect(extraction.provenance).toHaveLength(1);
    expect(await readTree(output)).toEqual(files);
  });

  it("exposes one arbitrary gzip payload under its stored name", async () => {
    const { root } = await workspace("gz-payload");
    const payload = join(root, "notes.json");
    await writeFile(payload, '{"kind":"not a tar"}\n');
    const compressed = await produceGzip(payload);
    const renamed = join(root, "renamed.gz");
    await writeFile(renamed, await readFile(compressed));

    const inventory = await inventoryArtifact(renamed);
    expect([...fileOccurrences(inventory).keys()]).toEqual(["notes.json"]);
    expect(inventory.limitations.join(" ")).toMatch(/original file name/u);
    const output = join(root, "out");
    await extract(renamed, "gzip", output);
    expect(await readTree(output)).toEqual({
      "notes.json": '{"kind":"not a tar"}\n',
    });
  });

  it("joins concatenated gzip members and names an unnamed payload from its suffix", async () => {
    const { root } = await workspace("gz-concat");
    const first = join(root, "first.txt");
    const second = join(root, "second.txt");
    await writeFile(first, "first member\n");
    await writeFile(second, "second member\n");
    const firstGz = await produceGzip(first, { storeName: false });
    const secondGz = await produceGzip(second, { storeName: false });
    const joined = join(root, "joined.log.gz");
    const bytes = Buffer.concat([
      await readFile(firstGz),
      await readFile(secondGz),
    ]);
    await writeFile(joined, bytes);
    expect(gunzipSync(bytes).toString()).toBe("first member\nsecond member\n");

    const inventory = await inventoryArtifact(joined);
    const found = fileOccurrences(inventory);
    expect([...found.keys()]).toEqual(["joined.log"]);
    expect(found.get("joined.log")?.sha256).toBe(
      sha256("first member\nsecond member\n"),
    );
  });

  it("reads a gzip stream padded with zeros and names the padding", async () => {
    const { root } = await workspace("gz-padded");
    const payload = join(root, "data.txt");
    await writeFile(payload, "padded payload\n");
    const compressed = await produceGzip(payload, { storeName: false });
    const padded = join(root, "padded.txt.gz");
    await writeFile(
      padded,
      Buffer.concat([await readFile(compressed), Buffer.alloc(512)]),
    );

    const inventory = await inventoryArtifact(padded);
    expect(fileOccurrences(inventory).get("padded.txt")?.sha256).toBe(
      sha256("padded payload\n"),
    );
    expect(inventory.limitations.join(" ")).toContain(
      "512 bytes follow the last gzip member, 0 of them non-zero",
    );
    const output = join(root, "out");
    await extract(padded, "gzip", output);
    expect(await readTree(output)).toEqual({
      "padded.txt": "padded payload\n",
    });
  });

  it("stops at the decoded byte budget with a limit failure", async () => {
    const { root } = await workspace("gz-budget");
    const payload = join(root, "zeros.bin");
    await writeFile(payload, Buffer.alloc(4 * 1024 * 1024));
    const compressed = await produceGzip(payload);
    expect((await stat(compressed)).size).toBeLessThan(64 * 1024);
    await expect(
      inventoryArtifact(compressed, {
        archive: { externalDecoders: "deny", maximumDecodedBytes: 1024 * 1024 },
      }),
    ).rejects.toMatchObject({ reason: "limit" });
  });

  it("refuses a truncated gzip stream", async () => {
    const { root } = await workspace("gz-truncated");
    const payload = join(root, "data.txt");
    await writeFile(payload, "x".repeat(100_000) + "tail");
    const compressed = await produceGzip(payload);
    const bytes = await readFile(compressed);
    const truncated = join(root, "truncated.gz");
    await writeFile(truncated, bytes.subarray(0, bytes.length - 12));
    await expect(inventoryArtifact(truncated)).rejects.toMatchObject({
      reason: "format",
    });
  });

  it("stops when cancelled", async () => {
    const { root, source } = await workspace("tar-cancel");
    await createArchiveSourceTree(source);
    const archive = join(root, "fixture.tar");
    await produceTar(source, archive, MEMBERS, "pax");
    const controller = new AbortController();
    controller.abort();
    await expect(
      inventoryArtifact(archive, { signal: controller.signal }),
    ).rejects.toMatchObject({ reason: "cancelled" });
  });
});

describe.runIf(XZ !== null)("xz streams through the installed xz", () => {
  it("decodes an xz-wrapped tar and records the decoder", async () => {
    const { root, source } = await workspace("txz");
    const { files } = await createArchiveSourceTree(source);
    const tar = join(root, "fixture.tar");
    await produceTar(source, tar, MEMBERS, "gnu");
    const archive = await produceXz(tar);

    const inventory = await inventoryArtifact(archive);
    expect(inventory.manifest.root_format).toBe("xz");
    expectMembers(inventory, files);
    expect(inventory.provenance).toEqual([
      expect.objectContaining({
        tool: "xz",
        arguments: ["--decompress", "--stdout"],
        exit_code: 0,
        executable_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
    ]);
    const output = join(root, "out");
    await extract(archive, "xz", output);
    expect(await readTree(output)).toEqual(files);
  });

  it("exposes one xz payload and refuses a corrupted stream", async () => {
    const { root } = await workspace("xz-payload");
    const payload = join(root, "report.txt");
    await writeFile(payload, "plain xz payload\n");
    const compressed = await produceXz(payload);
    const inventory = await inventoryArtifact(compressed);
    expect([...fileOccurrences(inventory).keys()]).toEqual(["report.txt"]);

    const bytes = await readFile(compressed);
    bytes[bytes.length - 20] = (bytes[bytes.length - 20] ?? 0) ^ 0xff;
    const corrupted = join(root, "corrupted.xz");
    await writeFile(corrupted, bytes);
    await expect(inventoryArtifact(corrupted)).rejects.toMatchObject({
      reason: "format",
    });
  });

  it("reports xz members as not read when external decoders are denied", async () => {
    const { root } = await workspace("xz-deny");
    const payload = join(root, "report.txt");
    await writeFile(payload, "plain xz payload\n");
    const compressed = await produceXz(payload);
    const policy = {
      externalDecoders: "deny",
      maximumDecodedBytes: 1024 ** 3,
    } as const;
    const inventory = await inventoryArtifact(compressed, { archive: policy });
    expect(fileOccurrences(inventory).size).toBe(0);
    expect(inventory.limitations.join(" ")).toMatch(/external xz program/u);
    await expect(
      withArtifactResourceScope((resourceScope) =>
        extractArtifact({
          inputPath: compressed,
          inputFormat: "xz",
          outputRoot: join(root, "out"),
          environment: {},
          integrityPolicy: "fail",
          archive: policy,
          resourceScope,
        }),
      ),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/cannot be extracted completely/u),
    });
  });
});

describe.runIf(SEVEN_ZIP !== null && BSDTAR !== null)(
  "7z archives through libarchive",
  () => {
    it("inventories and extracts a plain 7z archive", async () => {
      const { root, source } = await workspace("7z");
      const { files } = await createArchiveSourceTree(source);
      const archive = join(root, "fixture.7z");
      await produce7z(source, archive, MEMBERS);

      const inventory = await inventoryArtifact(archive);
      expect(inventory.manifest.root_format).toBe("7z");
      expectMembers(inventory, files);
      expect(inventory.provenance).toEqual([
        expect.objectContaining({ tool: "bsdtar", exit_code: 0 }),
      ]);
      const output = join(root, "out");
      await extract(archive, "7z", output);
      expect(await readTree(output)).toEqual(files);
    });

    it("reports encrypted headers without listing or guessing", async () => {
      const { root, source } = await workspace("7z-headers");
      await createArchiveSourceTree(source);
      const archive = join(root, "headers.7z");
      await produce7z(source, archive, ["a.txt"], {
        password: "not-guessed",
        encryptHeaders: true,
      });

      const inventory = await inventoryArtifact(archive);
      expect(inventory.manifest.root_format).toBe("7z");
      expect(fileOccurrences(inventory).size).toBe(0);
      expect(inventory.limitations.join(" ")).toMatch(
        /headers are encrypted .*06f10701/u,
      );
      expect(inventory.provenance).toEqual([]);
      await expect(
        extract(archive, "7z", join(root, "out")),
      ).rejects.toMatchObject({
        message: expect.stringMatching(/cannot be extracted completely/u),
      });
    });

    it("names a missing volume instead of guessing at later parts", async () => {
      const { root, source } = await workspace("7z-volume");
      // Incompressible bytes force 7-Zip to write several volumes.
      await writeFile(join(source, "big.bin"), randomBytes(64 * 1024));
      await produce7z(source, join(root, "split.7z"), ["big.bin"], {
        volumeBytes: "8k",
      });
      const first = join(root, "split.7z.001");
      const firstVolume = join(root, "first-volume.7z");
      await writeFile(firstVolume, await readFile(first));
      await expect(inventoryArtifact(firstVolume)).rejects.toMatchObject({
        reason: "format",
        message: expect.stringMatching(/a volume may be missing/u),
      });
    });

    it("names encrypted member data as unreadable", async () => {
      const { root, source } = await workspace("7z-data");
      await createArchiveSourceTree(source);
      const archive = join(root, "data.7z");
      await produce7z(source, archive, ["a.txt"], { password: "not-guessed" });
      await expect(inventoryArtifact(archive)).rejects.toMatchObject({
        reason: "unavailable",
        message: expect.stringMatching(/no password was attempted/u),
      });
    });
  },
);

it("identifies RAR by its marker block and lists nothing", async () => {
  const { root } = await workspace("rar");
  const archive = join(root, "marker.rar");
  // RAR 5 marker block followed by bytes no reader interprets.
  await writeFile(
    archive,
    Buffer.concat([
      Buffer.from("Rar!\x1a\x07\x01\x00", "latin1"),
      Buffer.alloc(32),
    ]),
  );
  const inventory = await inventoryArtifact(archive);
  expect(inventory.manifest.root_format).toBe("rar");
  expect(inventory.limitations.join(" ")).toMatch(/No RAR reader is admitted/u);
  await expect(
    extract(archive, "rar", join(root, "out")),
  ).rejects.toMatchObject({
    message: expect.stringMatching(/no extraction reader: rar/u),
  });
  await rm(root, { recursive: true, force: true });
});
