import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ArtifactEntry } from "../../../src/artifacts/ArtifactReader.js";
import { ContainerImageArtifactReader } from "../../../src/artifacts/ContainerImageArtifactReader.js";
import { extractArtifact } from "../../../src/artifacts/extraction/ArtifactExtraction.js";
import { identifyTargetFormat } from "../../fixtures/containerImageGraph.js";
import {
  inventoryArtifact,
  withArtifactResourceScope,
} from "../../fixtures/artifactInventory.js";
import {
  archiveOf,
  buildImage,
  dockerSaveFiles,
  ociLayoutFiles,
  tarBytes,
  writeLayout,
  type ImageSpec,
} from "../../fixtures/containerImageProducers.js";
import { removeTestWorkspace } from "../../support/workspace/workspaceFixture.js";

const sha256 = (bytes: Buffer | string): string =>
  createHash("sha256").update(bytes).digest("hex");

const IMAGE: ImageSpec = {
  layers: [
    {
      compression: "gzip",
      entries: [
        { name: "bin/", type: "dir" },
        { name: "bin/app", data: "#!app\n", mode: 0o755 },
        { name: "bin/sh", type: "symlink", link: "app" },
        { name: "etc/", type: "dir" },
        { name: "etc/passwd", data: "root:x:0:0\n" },
        { name: "etc/hosts", data: "127.0.0.1 localhost\n" },
        { name: "var/cache/a", data: "a" },
        { name: "data/old", data: "old" },
        { name: "dev/null", type: "char" },
      ],
    },
    {
      compression: "zstd",
      entries: [
        { name: "etc/.wh.hosts" },
        { name: "etc/passwd", data: "root:x:0:0\napp:x:1:1\n" },
        { name: "var/cache/.wh..wh..opq" },
        { name: "var/cache/c", data: "c" },
        { name: "data", data: "now a file" },
        { name: "bin/app2", type: "hardlink", link: "bin/app" },
      ],
    },
  ],
};

const EXPECTED: Record<string, string> = {
  "bin/app": "#!app\n",
  "bin/app2": "#!app\n",
  data: "now a file",
  "etc/passwd": "root:x:0:0\napp:x:1:1\n",
  "var/cache/c": "c",
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
    else
      result[relative] = entry.isFile()
        ? await readFile(join(root, relative), "utf8")
        : "<non-regular>";
  }
  return result;
};

let root: string;
let layout: string;
let docker: string;
let oci: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "rea-image-graph-"));
  layout = join(root, "layout");
  await writeLayout(layout, ociLayoutFiles([buildImage(IMAGE)]));
  oci = join(root, "oci.tar");
  await writeFile(oci, archiveOf(ociLayoutFiles([buildImage(IMAGE)])));
  docker = join(root, "docker.tar");
  await writeFile(docker, archiveOf(dockerSaveFiles(IMAGE)));
});

afterAll(async () => {
  await removeTestWorkspace(root);
});

const inventory = (path: string) =>
  inventoryArtifact(path, { environment: {}, integrity: { mode: "fail" } });

const extract = (path: string, format: string, output: string) =>
  withArtifactResourceScope((resourceScope) =>
    extractArtifact({
      inputPath: path,
      inputFormat: format as never,
      outputRoot: output,
      environment: {},
      integrityPolicy: "fail",
      resourceScope,
    }),
  );

describe("container images in the artifact graph", () => {
  it.each([
    ["an OCI layout directory", () => layout, "oci-image-layout"],
    ["an OCI archive", () => oci, "oci-image-archive"],
    ["a Docker save archive", () => docker, "docker-save-archive"],
  ])("lists the composed filesystem of %s", async (_name, path, format) => {
    const result = await inventory(path());
    expect(result.manifest.root_format).toBe(format);
    const files = new Map(
      result.occurrences
        .filter(
          (occurrence) =>
            occurrence.entry_kind === "file" && occurrence.logical_path !== ".",
        )
        .map((occurrence) => [
          occurrence.logical_path,
          result.nodes.find(
            (node) => node.artifact_id === occurrence.artifact_id,
          )?.sha256,
        ]),
    );
    expect([...files.keys()].sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const [name, text] of Object.entries(EXPECTED))
      expect(files.get(name)).toBe(sha256(text));
    // The char device is reported, so the listing is not claimed complete.
    expect(result.coverage.status).toBe("unknown");
    expect(result.limitations.join("\n")).toContain(
      "/dev/null".replace("/", ""),
    );
  });

  it("names the target format of an image archive", async () => {
    expect(await identifyTargetFormat(oci)).toBe("oci-image-archive");
    expect(await identifyTargetFormat(docker)).toBe("docker-save-archive");
  });

  it("keeps a plain tar a tar", async () => {
    const plain = join(root, "plain.tar");
    await writeFile(
      plain,
      tarBytes([
        { name: "bin/", type: "dir" },
        { name: "bin/sh", data: "x" },
      ]),
    );
    expect((await inventory(plain)).manifest.root_format).toBe("tar");
    expect(await identifyTargetFormat(plain)).toBe("tar");
  });

  it("does not take a browser extension's manifest.json for an image", async () => {
    const extension = join(root, "extension.tar");
    await writeFile(
      extension,
      tarBytes([
        {
          name: "manifest.json",
          data: JSON.stringify({
            manifest_version: 3,
            name: "x",
            version: "1",
          }),
        },
        { name: "background.js", data: "//" },
      ]),
    );
    expect((await inventory(extension)).manifest.root_format).toBe("tar");
    expect(await identifyTargetFormat(extension)).toBe("tar");
  });

  it("refuses to extract while the listing is incomplete, then extracts a complete image", async () => {
    await expect(
      extract(oci, "oci-image-archive", join(root, "refused")),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/cannot be extracted completely/u),
    });
    const spec: ImageSpec = {
      layers: IMAGE.layers.map((layer) => ({
        ...layer,
        entries: layer.entries.filter((entry) => entry.type !== "char"),
      })),
    };
    const clean = join(root, "clean.tar");
    await writeFile(clean, archiveOf(ociLayoutFiles([buildImage(spec)])));
    const output = join(root, "out-clean");
    await mkdir(output);
    await extract(clean, "oci-image-archive", join(output, "tree"));
    expect(await readTree(join(output, "tree"))).toMatchObject(EXPECTED);
  });

  it("extracts the composed filesystem of a layout directory and a Docker archive", async () => {
    const spec: ImageSpec = {
      layers: IMAGE.layers.map((layer) => ({
        ...layer,
        entries: layer.entries.filter((entry) => entry.type !== "char"),
      })),
    };
    const layoutPath = join(root, "layout-clean");
    await writeLayout(layoutPath, ociLayoutFiles([buildImage(spec)]));
    const dockerPath = join(root, "docker-clean.tar");
    await writeFile(dockerPath, archiveOf(dockerSaveFiles(spec)));
    for (const [path, format] of [
      [layoutPath, "oci-image-layout"],
      [dockerPath, "docker-save-archive"],
    ] as const) {
      const output = join(root, `out-${format}`);
      await extract(path, format, output);
      const tree = await readTree(output);
      expect(
        Object.keys(tree)
          .filter((name) => name in EXPECTED)
          .sort(),
      ).toEqual(Object.keys(EXPECTED).sort());
      for (const [name, text] of Object.entries(EXPECTED))
        expect(tree[name]).toBe(text);
      expect(tree["etc/hosts"]).toBeUndefined();
      expect(tree["var/cache/a"]).toBeUndefined();
      expect(tree["data/old"]).toBeUndefined();
    }
  });

  it("does not list a layer whose digest does not match", async () => {
    const image = buildImage(IMAGE);
    const files = ociLayoutFiles([image]);
    const key = `blobs/sha256/${image.layerDigests[1]?.slice(7)}`;
    const blob = Buffer.from(files.get(key) as Buffer);
    blob[blob.length - 3] = (blob[blob.length - 3] ?? 0) ^ 0xff;
    files.set(key, blob);
    const path = join(root, "corrupt-graph.tar");
    await writeFile(path, archiveOf(files));
    const result = await inventory(path);
    expect(result.limitations.join("\n")).toMatch(
      /Layer 1 was not fully applied/u,
    );
    expect(result.coverage.status).toBe("unknown");
  });

  it("asks for a platform when an archive holds several images", async () => {
    const amd = buildImage({
      layers: [{ entries: [{ name: "a", data: "1" }] }],
    });
    const arm = buildImage({
      layers: [{ entries: [{ name: "b", data: "2" }] }],
      platform: { os: "linux", architecture: "arm64" },
    });
    const path = join(root, "multi-graph.tar");
    await writeFile(path, archiveOf(ociLayoutFiles([amd, arm])));
    await expect(inventory(path)).rejects.toThrow(
      /inspect_container_image with platform or manifest/u,
    );
  });
});

describe("container image graph edge cases", () => {
  it("extracts a hard link with the bytes of its own layer", async () => {
    const spec: ImageSpec = {
      layers: [
        { entries: [{ name: "a", data: "old" }] },
        { entries: [{ name: "b", type: "hardlink", link: "a" }] },
        { entries: [{ name: "a", data: "NEW-CONTENT" }] },
      ],
    };
    const path = join(root, "hardlink-layers.tar");
    await writeFile(path, archiveOf(ociLayoutFiles([buildImage(spec)])));
    const output = join(root, "out-hardlink");
    await extract(path, "oci-image-archive", output);
    expect(await readTree(output)).toEqual({ a: "NEW-CONTENT", b: "old" });
  });

  it("lists around an entry below a symbolic link instead of failing", async () => {
    const spec: ImageSpec = {
      layers: [
        {
          entries: [
            { name: "s", type: "symlink", link: "/etc" },
            { name: "s/pwn", data: "x" },
            { name: "fine", data: "f" },
          ],
        },
      ],
    };
    const path = join(root, "under-symlink.tar");
    await writeFile(path, archiveOf(ociLayoutFiles([buildImage(spec)])));
    const result = await inventory(path);
    expect(
      result.occurrences.map((occurrence) => occurrence.logical_path).sort(),
    ).toEqual([".", "fine", "s"]);
    expect(result.limitations.join("\n")).toContain("below a symbolic link");
  });

  it("refuses a layer that was swapped after it was listed", async () => {
    const image = buildImage({
      layers: [
        { compression: "none", entries: [{ name: "f", data: "original" }] },
      ],
    });
    const dir = join(root, "swap-layout");
    await writeLayout(dir, ociLayoutFiles([image]));
    const reader = new ContainerImageArtifactReader(dir, "oci-image-layout");
    const listed: ArtifactEntry[] = [];
    for await (const entry of reader.entries()) listed.push(entry);
    const file = listed.find((entry) => entry.path === "f");
    expect(file).toBeDefined();
    const blob = join(
      dir,
      "blobs",
      "sha256",
      image.layerDigests[0]?.slice(7) ?? "",
    );
    const swapped = Buffer.from(image.layerBlobs[0] as Buffer);
    swapped.fill(0x41, 600, 608);
    await writeFile(blob, swapped);
    await expect(
      (async () => {
        for await (const chunk of await reader.open(file as ArtifactEntry))
          void chunk;
      })(),
    ).rejects.toThrow(/changed after it was listed/u);
    await reader.close();
  });

  it("still sees an image whose manifest.json sits behind a pax header and a stale hardlink size", async () => {
    const files = dockerSaveFiles({
      layers: [{ entries: [{ name: "x", data: "x" }] }],
    });
    const entries = [
      {
        name: "link",
        type: "hardlink" as const,
        link: "later",
        sizeField: 4096,
      },
      ...[...files]
        .filter(([name]) => name !== "manifest.json")
        .map(([name, data]) => ({ name, data })),
      {
        name: "PLACEHOLDER",
        data: files.get("manifest.json") as Buffer,
        pax: { path: "manifest.json" },
      },
    ];
    const path = join(root, "pax-docker.tar");
    await writeFile(path, tarBytes(entries));
    expect(await identifyTargetFormat(path)).toBe("docker-save-archive");
  });
});
