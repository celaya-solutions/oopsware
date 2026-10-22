import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  containerImageReportSchema,
  inspectContainerImageInputSchema,
  type ContainerImageReport,
} from "../domain/containerImage/containerImage.js";
import {
  archiveOf,
  buildImage,
  dockerSaveFiles,
  ociLayoutFiles,
  sha256Of,
  tarBytes,
  writeLayout,
  type BuiltImage,
  type ImageSpec,
  type TarEntry,
} from "../../tests/fixtures/containerImageProducers.js";
import { removeTestWorkspace } from "../../tests/support/workspace/workspaceFixture.js";
import { ContainerImageProvider } from "./ContainerImageProvider.js";

const provider = new ContainerImageProvider();

const inspect = async (
  input: Record<string, unknown>,
): Promise<ContainerImageReport> => {
  const result = await provider.inspectImage(
    inspectContainerImageInputSchema.parse(input),
  );
  if (!result.ok) throw result.error;
  return containerImageReportSchema.parse(result.value);
};

let workspace: string;
let counter = 0;

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "oopsware-image-hostile-"));
});

afterAll(async () => {
  await removeTestWorkspace(workspace);
});

const blobKey = (digest: string): string =>
  `blobs/sha256/${digest.replace("sha256:", "")}`;

/** Write the image as an OCI archive after `mutate` has changed its files. */
const archive = async (
  spec: ImageSpec,
  mutate: (files: Map<string, Buffer>, image: BuiltImage) => void = () =>
    undefined,
): Promise<string> => {
  const image = buildImage(spec);
  const files = ociLayoutFiles([image]);
  mutate(files, image);
  counter += 1;
  const path = join(workspace, `image-${String(counter)}.tar`);
  await writeFile(path, archiveOf(files));
  return path;
};

const one = (entries: readonly TarEntry[]): ImageSpec => ({
  layers: [{ entries }],
});

const paths = (report: ContainerImageReport): string[] =>
  report.files.map((file) => file.path);

const coverage = (report: ContainerImageReport, facet: string) =>
  report.coverage.find((item) => item.facet === facet)?.state;

describe("names, depth and volume", () => {
  it("drops names and paths over the limits and marks the layer partial", async () => {
    const path = await archive(
      one([
        { name: "ok", data: "1" },
        { name: `long/${"n".repeat(5000)}`, data: "x", gnuLongName: true },
        { name: `${"d/".repeat(600)}file`, data: "x", gnuLongName: true },
        { name: "link", type: "symlink", link: "t".repeat(100) },
      ]),
    );
    const report = await inspect({ path });
    expect(paths(report)).toEqual(["link", "ok"]);
    expect(report.layers[0]?.read).toBe("partial");
    const text = report.diagnostics.map((item) => item.message).join("\n");
    expect(text).toContain("over 4096 bytes");
    expect(text).toContain("deeper than 512");
    expect(coverage(report, "inventory")).toBe("partial");
  });

  it("survives a layer of 130,000 unusable entries with a bounded report", async () => {
    const entries: TarEntry[] = Array.from({ length: 130_000 }, () => ({
      name: "../x",
    }));
    const path = await archive(one([{ name: "keep", data: "k" }, ...entries]));
    const report = await inspect({ path });
    expect(paths(report)).toEqual(["keep"]);
    expect(report.layers[0]?.read).toBe("partial");
    expect(report.diagnostics.length).toBeLessThanOrEqual(102);
    expect(
      report.diagnostics.some((d) => d.message.includes("more problems")),
    ).toBe(true);
  }, 60_000);

  it("drops a pax sparse member instead of listing its stored bytes", async () => {
    const path = await archive(
      one([
        {
          name: "GNUSparseFile.0/file.bin",
          data: "map-and-data",
          pax: {
            "GNU.sparse.major": "1",
            "GNU.sparse.minor": "0",
            "GNU.sparse.name": "file.bin",
            "GNU.sparse.realsize": "100000",
          },
        },
        { name: "plain", data: "p" },
      ]),
    );
    const report = await inspect({ path });
    expect(paths(report)).toEqual(["plain"]);
    expect(report.layers[0]?.read).toBe("partial");
    expect(report.diagnostics.some((d) => d.message.includes("sparse"))).toBe(
      true,
    );
  });

  it("does not keep the member a layer was cut inside of", async () => {
    const tar = tarBytes([
      { name: "a", data: "aaa" },
      { name: "b", data: "x".repeat(3000) },
    ]);
    const cut = tar.subarray(0, 512 + 512 + 512 + 700);
    const path = await archive(
      one([{ name: "a", data: "aaa" }]),
      (files, image) => {
        files.set(blobKey(image.layerDigests[0] as string), Buffer.from(cut));
      },
    );
    // The layer blob is gzip in the descriptor; the cut bytes are raw tar, which is fine to read.
    const report = await inspect({ path, layer: 0 });
    expect(report.files.map((file) => file.path)).toEqual(["a"]);
    expect(report.layers[0]?.read).toBe("partial");
    expect(coverage(report, "inventory")).toBe("partial");
  });
});

describe("what vouches for a layer", () => {
  const SPEC: ImageSpec = {
    layers: [
      { entries: [{ name: "one", data: "1" }] },
      { entries: [{ name: "two", data: "2" }] },
    ],
  };

  it("applies no layer when the manifest does not match its digest", async () => {
    const path = await archive(SPEC, (files, image) => {
      const manifest = JSON.parse(
        String(files.get(blobKey(image.manifestDigest))),
      ) as { layers: unknown[] };
      manifest.layers = manifest.layers.slice(0, 1);
      files.set(
        blobKey(image.manifestDigest),
        Buffer.from(JSON.stringify(manifest)),
      );
    });
    const report = await inspect({ path });
    expect(report.manifests[0]?.blob.state).toBe("digest_mismatch");
    expect(report.files).toEqual([]);
    expect(coverage(report, "inventory")).toBe("partial");
    expect(coverage(report, "inspect")).toBe("partial");
    expect(
      report.diagnostics.some((d) =>
        d.message.includes("manifest does not match"),
      ),
    ).toBe(true);
  });

  it("keeps a tampered configuration from vouching for diff ids", async () => {
    const path = await archive(SPEC, (files, image) => {
      const config = JSON.parse(
        String(files.get(blobKey(image.configDigest))),
      ) as { author: string };
      config.author = "someone else";
      files.set(
        blobKey(image.configDigest),
        Buffer.from(JSON.stringify(config)),
      );
    });
    const report = await inspect({ path });
    expect(report.config?.blob.state).toBe("digest_mismatch");
    expect(coverage(report, "inventory")).toBe("partial");
    expect(coverage(report, "inspect")).toBe("partial");
  });

  it("does not apply a Docker layer nothing vouches for", async () => {
    const files = dockerSaveFiles(SPEC);
    const manifest = JSON.parse(String(files.get("manifest.json"))) as {
      Config: string;
    }[];
    const configName = manifest[0]?.Config as string;
    const config = JSON.parse(String(files.get(configName))) as {
      rootfs: { diff_ids: string[] };
    };
    config.rootfs.diff_ids = config.rootfs.diff_ids.slice(0, 1);
    const bytes = Buffer.from(JSON.stringify(config));
    files.delete(configName);
    const renamed = `${sha256Of(bytes)}.json`;
    files.set(renamed, bytes);
    files.set(
      "manifest.json",
      Buffer.from(JSON.stringify([{ ...manifest[0], Config: renamed }])),
    );
    counter += 1;
    const path = join(workspace, `docker-${String(counter)}.tar`);
    await writeFile(path, archiveOf(files));
    const report = await inspect({ path });
    expect(report.layers[1]?.blob.state).toBe("unverifiable");
    expect(report.layers[1]?.diff_id.valid).toBeNull();
    expect(paths(report)).toEqual(["one"]);
    expect(coverage(report, "inventory")).toBe("partial");
  });

  it("judges a single layer's listing by that layer's own checks", async () => {
    const flipped = await archive(SPEC, (files, image) => {
      const key = blobKey(image.layerDigests[0] as string);
      const blob = Buffer.from(files.get(key) as Buffer);
      blob[blob.length - 3] = (blob[blob.length - 3] ?? 0) ^ 0xff;
      files.set(key, blob);
    });
    const report = await inspect({ path: flipped, layer: 0 });
    expect(report.layers[0]?.blob.state).toBe("digest_mismatch");
    expect(coverage(report, "inventory")).toBe("partial");
    const clean = await inspect({ path: await archive(SPEC), layer: 0 });
    expect(coverage(clean, "inventory")).toBe("complete");
  });

  it("reads at most 1,024 layers and bounds the diagnostics", async () => {
    const path = await archive(SPEC, (files, image) => {
      const manifest = JSON.parse(
        String(files.get(blobKey(image.manifestDigest))),
      ) as { layers: Record<string, unknown>[] };
      const layers = Array.from({ length: 1100 }, (_, index) => ({
        mediaType: "application/vnd.oci.image.layer.v1.tar",
        digest: `sha256:${sha256Of(String(index))}`,
        size: 1,
      }));
      const bytes = Buffer.from(JSON.stringify({ ...manifest, layers }));
      const digest = sha256Of(bytes);
      files.set(`blobs/sha256/${digest}`, bytes);
      files.set(
        "index.json",
        Buffer.from(
          JSON.stringify({
            schemaVersion: 2,
            manifests: [
              {
                mediaType: "application/vnd.oci.image.manifest.v1+json",
                digest: `sha256:${digest}`,
                size: bytes.length,
              },
            ],
          }),
        ),
      );
    });
    const report = await inspect({ path });
    expect(report.layers).toHaveLength(1024);
    expect(report.diagnostics.length).toBeLessThanOrEqual(1001);
    expect(coverage(report, "inventory")).toBe("partial");
  });
});

describe("hard links keep the bytes of their own layer", () => {
  it("does not follow a later replacement or deletion of the target", async () => {
    const replaced = await archive({
      layers: [
        { entries: [{ name: "a", data: "old" }] },
        { entries: [{ name: "b", type: "hardlink", link: "a" }] },
        { entries: [{ name: "a", data: "NEW-CONTENT" }] },
      ],
    });
    const report = await inspect({ path: replaced });
    const links = new Map(report.files.map((file) => [file.path, file]));
    expect(links.get("b")).toMatchObject({
      link_status: "resolved",
      size: 3,
    });
    expect(links.get("a")?.size).toBe(11);
    const deleted = await archive({
      layers: [
        { entries: [{ name: "a", data: "old" }] },
        { entries: [{ name: "b", type: "hardlink", link: "a" }] },
        { entries: [{ name: ".wh.a" }] },
      ],
    });
    const gone = await inspect({ path: deleted });
    expect(paths(gone)).toEqual(["b"]);
    expect(gone.files[0]).toMatchObject({ link_status: "resolved", size: 3 });
  });

  it("marks a link to nothing as dangling at its own layer", async () => {
    const path = await archive({
      layers: [
        { entries: [{ name: "b", type: "hardlink", link: "a" }] },
        { entries: [{ name: "a", data: "later" }] },
      ],
    });
    const report = await inspect({ path });
    expect(report.files.find((file) => file.path === "b")?.link_status).toBe(
      "dangling",
    );
  });
});

describe("layout directories", () => {
  it("does not read a blob through a linked directory", async () => {
    const real = join(workspace, "real-layout");
    await writeLayout(
      real,
      ociLayoutFiles([buildImage(one([{ name: "x", data: "x" }]))]),
    );
    const linked = join(workspace, "linked-layout");
    await mkdir(linked);
    await writeFile(
      join(linked, "oci-layout"),
      '{"imageLayoutVersion":"1.0.0"}',
    );
    await writeFile(
      join(linked, "index.json"),
      await readFile(join(real, "index.json")),
    );
    await symlink(join(real, "blobs"), join(linked, "blobs"));
    const report = await inspect({ path: linked });
    expect(report.manifests[0]?.blob.state).toBe("missing");
    expect(report.files).toEqual([]);
  });
});
