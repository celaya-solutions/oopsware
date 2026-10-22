import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
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
  type ImageSpec,
} from "../../tests/fixtures/containerImageProducers.js";
import { removeTestWorkspace } from "../../tests/support/workspace/workspaceFixture.js";
import { ContainerImageProvider } from "./ContainerImageProvider.js";

const provider = new ContainerImageProvider();

const run = async (input: Record<string, unknown>) =>
  provider.inspectImage(inspectContainerImageInputSchema.parse(input));

const inspect = async (
  input: Record<string, unknown>,
): Promise<ContainerImageReport> => {
  const result = await run(input);
  if (!result.ok) throw result.error;
  return containerImageReportSchema.parse(result.value);
};

const THREE_LAYERS: ImageSpec = {
  tag: "app:1",
  layers: [
    {
      compression: "gzip",
      entries: [
        { name: "bin/", type: "dir" },
        { name: "bin/app", data: "#!app\n", mode: 0o4755 },
        { name: "bin/sh", type: "symlink", link: "app" },
        { name: "etc/", type: "dir" },
        { name: "etc/passwd", data: "root:x:0:0\n" },
        { name: "etc/hosts", data: "127.0.0.1 localhost\n" },
        { name: "var/", type: "dir" },
        { name: "var/cache/", type: "dir" },
        { name: "var/cache/a", data: "a" },
        { name: "var/cache/b", data: "b" },
        { name: "data/", type: "dir" },
        { name: "data/old", data: "old" },
      ],
    },
    {
      compression: "zstd",
      entries: [
        { name: "etc/.wh.hosts", data: "" },
        { name: "etc/passwd", data: "root:x:0:0\napp:x:1000:1000\n" },
        { name: "var/cache/.wh..wh..opq", data: "" },
        { name: "var/cache/c", data: "c" },
        { name: "data", data: "now a file" },
        { name: "bin/app2", type: "hardlink", link: "bin/app" },
      ],
    },
    {
      compression: "none",
      entries: [
        { name: "etc/hosts", data: "10.0.0.1 db\n" },
        { name: "opt/x", data: "x" },
        { name: "/srv/deep/file", data: "deep" },
        { name: "./", type: "dir" },
      ],
    },
  ],
};

const COMPOSED = [
  "bin",
  "bin/app",
  "bin/app2",
  "bin/sh",
  "data",
  "etc",
  "etc/hosts",
  "etc/passwd",
  "opt",
  "opt/x",
  "srv",
  "srv/deep",
  "srv/deep/file",
  "var",
  "var/cache",
  "var/cache/c",
];

let workspace: string;
let layoutDirectory: string;
let ociArchive: string;
let dockerArchive: string;
const built = buildImage(THREE_LAYERS);

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "oopsware-image-test-"));
  layoutDirectory = join(workspace, "layout");
  await writeLayout(layoutDirectory, ociLayoutFiles([built]));
  ociArchive = join(workspace, "oci.tar");
  await writeFile(ociArchive, archiveOf(ociLayoutFiles([built])));
  dockerArchive = join(workspace, "docker.tar");
  await writeFile(dockerArchive, archiveOf(dockerSaveFiles(THREE_LAYERS)));
});

afterAll(async () => {
  await removeTestWorkspace(workspace);
});

const pathsOf = (report: ContainerImageReport): string[] =>
  report.files.map((file) => file.path);

describe("OCI layout directory", () => {
  it("verifies every blob and composes the layers in order", async () => {
    const report = await inspect({ path: layoutDirectory });
    expect(report.image.format).toBe("oci-image-layout");
    expect(report.image.layout_version).toBe("1.0.0");
    expect(report.artifact).toMatchObject({
      kind: "directory",
      sha256_of: "index.json",
    });
    expect(report.manifests).toHaveLength(1);
    expect(report.selection).toMatchObject({
      state: "selected",
      by: "only",
      id: built.manifestDigest,
    });
    expect(report.manifests[0]?.blob.state).toBe("verified");
    expect(report.manifests[0]?.ref_names).toEqual(["app:1"]);
    expect(report.config?.blob.state).toBe("verified");
    expect(report.layers.map((layer) => layer.blob.state)).toEqual([
      "verified",
      "verified",
      "verified",
    ]);
    expect(report.layers.map((layer) => layer.compression)).toEqual([
      "gzip",
      "zstd",
      "none",
    ]);
    expect(report.layers.map((layer) => layer.diff_id.valid)).toEqual([
      true,
      true,
      true,
    ]);
    expect(report.layers.map((layer) => layer.diff_id.computed)).toEqual(
      built.diffIds,
    );
    expect(report.view).toBe("composed");
    expect(pathsOf(report)).toEqual(COMPOSED);
    expect(report.coverage.find((c) => c.facet === "inventory")?.state).toBe(
      "complete",
    );
    expect(report.diagnostics).toEqual([]);
  });

  it("shows which layer each composed entry comes from", async () => {
    const report = await inspect({ path: layoutDirectory });
    const byPath = new Map(report.files.map((file) => [file.path, file]));
    expect(byPath.get("etc/passwd")?.layer).toBe(1);
    expect(byPath.get("etc/hosts")?.layer).toBe(2);
    expect(byPath.get("bin/app")?.layer).toBe(0);
    expect(byPath.get("data")).toMatchObject({
      type: "file",
      layer: 1,
      size: 10,
    });
    expect(byPath.get("var/cache/c")?.layer).toBe(1);
    expect(byPath.get("srv")).toMatchObject({ implicit: true, layer: 2 });
    expect(byPath.has("var/cache/a")).toBe(false);
    expect(byPath.has("data/old")).toBe(false);
  });

  it("states modes and special bits without applying them", async () => {
    const report = await inspect({ path: layoutDirectory });
    const app = report.files.find((file) => file.path === "bin/app");
    expect(app).toMatchObject({ mode: "4755", special: ["setuid"], size: 6 });
  });

  it("resolves links inside the view", async () => {
    const report = await inspect({ path: layoutDirectory });
    const byPath = new Map(report.files.map((file) => [file.path, file]));
    expect(byPath.get("bin/sh")).toMatchObject({
      type: "symlink",
      link_target: "app",
      link_status: "resolved",
    });
    expect(byPath.get("bin/app2")).toMatchObject({
      type: "hardlink",
      link_target: "bin/app",
      link_status: "resolved",
      size: 6,
    });
  });

  it("counts what each layer hid or replaced", async () => {
    const report = await inspect({ path: layoutDirectory });
    const [base, middle, top] = report.layers;
    expect(base?.removed_from_lower).toBe(0);
    // hosts (whiteout) + a, b (opaque) + passwd (replaced) + data and data/old (dir to file).
    expect(middle).toMatchObject({
      whiteouts: 1,
      opaque_directories: 1,
      removed_from_lower: 6,
    });
    expect(top?.removed_from_lower).toBe(0);
  });

  it("reads the configuration as declarations and maps history to layers", async () => {
    const report = await inspect({ path: layoutDirectory });
    expect(report.config).toMatchObject({
      architecture: "amd64",
      os: "linux",
      user: "app",
      working_dir: "/srv",
      entrypoint: ["/bin/app"],
      cmd: ["--serve"],
      exposed_ports: ["8080/tcp"],
      env: ["PATH=/usr/local/bin:/usr/bin", "MODE=test"],
      labels: [{ key: "org.example.role", value: "fixture" }],
    });
    expect(report.config?.history.map((step) => step.layer_index)).toEqual([
      0, 1, 2,
    ]);
    expect(report.layers.map((layer) => layer.created_by)).toEqual([
      "RUN step 0",
      "RUN step 1",
      "RUN step 2",
    ]);
  });

  it("pages the composed view with a stable order", async () => {
    const first = await inspect({ path: layoutDirectory, limit: 5 });
    expect(first.page).toMatchObject({ start: 0, returned: 5, next: 5 });
    expect(first.file_count).toBe(COMPOSED.length);
    const second = await inspect({
      path: layoutDirectory,
      start: 5,
      limit: 100,
    });
    expect(second.page.next).toBeNull();
    expect([...pathsOf(first), ...pathsOf(second)]).toEqual(COMPOSED);
    const beyond = await inspect({ path: layoutDirectory, start: 500 });
    expect(beyond.files).toEqual([]);
    expect(beyond.page.next).toBeNull();
  });

  it("lists one layer's own entries, whiteouts and opaque markers included", async () => {
    const report = await inspect({ path: layoutDirectory, layer: 1 });
    expect(report.view).toBe("layer");
    expect(
      report.files.map((file) => [file.path, file.type, file.hides]),
    ).toEqual([
      ["etc/.wh.hosts", "whiteout", "etc/hosts"],
      ["etc/passwd", "file", null],
      ["var/cache/.wh..wh..opq", "opaque-marker", "var/cache"],
      ["var/cache/c", "file", null],
      ["data", "file", null],
      ["bin/app2", "hardlink", null],
    ]);
    expect(report.files.every((file) => file.layer === 1)).toBe(true);
  });

  it("refuses a layer index that does not exist", async () => {
    const result = await run({ path: layoutDirectory, layer: 9 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error._tag).toBe("AnalysisInputError");
  });
});

describe("OCI image archive and Docker save archive", () => {
  it("reads the same image from an OCI archive", async () => {
    const report = await inspect({ path: ociArchive });
    expect(report.image.format).toBe("oci-image-archive");
    expect(report.artifact).toMatchObject({
      kind: "file",
      sha256_of: "content",
    });
    expect(pathsOf(report)).toEqual(COMPOSED);
    expect(
      report.layers.every((layer) => layer.blob.state === "verified"),
    ).toBe(true);
  });

  it("reads a legacy Docker save archive and checks diff ids", async () => {
    const report = await inspect({ path: dockerArchive });
    expect(report.image.format).toBe("docker-save-archive");
    expect(report.image.has_oci_index).toBe(false);
    expect(report.manifests[0]?.ref_names).toEqual(["fixture:latest"]);
    expect(report.manifests[0]?.id).toBe(built.configDigest);
    expect(report.config?.blob.state).toBe("verified");
    // Legacy layers declare no blob digest, so only the diff id can vouch for them.
    expect(report.layers.map((layer) => layer.blob.state)).toEqual([
      "unverifiable",
      "unverifiable",
      "unverifiable",
    ]);
    expect(report.layers.map((layer) => layer.diff_id.valid)).toEqual([
      true,
      true,
      true,
    ]);
    expect(pathsOf(report)).toEqual(COMPOSED);
  });

  it("follows a symlinked layer.tar shared between images", async () => {
    const files = dockerSaveFiles(THREE_LAYERS);
    const manifest = JSON.parse(String(files.get("manifest.json"))) as {
      Layers: string[];
    }[];
    const real = manifest[0]?.Layers[0] as string;
    const alias = "alias/layer.tar";
    const entries = [
      ...[...files].map(([name, data]) => ({ name, data })),
      { name: alias, type: "symlink" as const, link: `../${real}` },
    ];
    manifest[0] = {
      ...manifest[0],
      Layers: [alias, ...manifest[0]!.Layers.slice(1)],
    } as never;
    const index = entries.findIndex((entry) => entry.name === "manifest.json");
    entries[index] = {
      name: "manifest.json",
      data: Buffer.from(JSON.stringify(manifest)),
    };
    const path = join(workspace, "docker-alias.tar");
    await writeFile(path, tarBytes(entries));
    const report = await inspect({ path });
    expect(report.layers[0]?.diff_id.valid).toBe(true);
    expect(pathsOf(report)).toEqual(COMPOSED);
  });

  it("refuses a plain root filesystem tar", async () => {
    const path = join(workspace, "rootfs.tar");
    await writeFile(
      path,
      tarBytes([
        { name: "bin/", type: "dir" },
        { name: "bin/sh", data: "x" },
        { name: "etc/passwd", data: "root" },
      ]),
    );
    const result = await run({ path });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error._tag).toBe("AnalysisUnsupportedTargetError");
      expect(result.error.message).toContain("not an image");
    }
  });

  it("refuses gzip data, non-tar files and directories that are not layouts", async () => {
    const gz = join(workspace, "image.tar.gz");
    await writeFile(gz, Buffer.from([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 3]));
    const junk = join(workspace, "junk.bin");
    await writeFile(junk, Buffer.alloc(2048, 7));
    const empty = join(workspace, "empty-dir");
    await mkdir(empty);
    for (const path of [gz, junk, empty]) {
      const result = await run({ path });
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.error._tag).toBe("AnalysisUnsupportedTargetError");
    }
  });
});

describe("multi-platform indexes", () => {
  const amd = buildImage({
    layers: [{ entries: [{ name: "amd", data: "1" }] }],
    platform: { os: "linux", architecture: "amd64" },
  });
  const arm = buildImage({
    layers: [{ entries: [{ name: "arm", data: "2" }] }],
    platform: { os: "linux", architecture: "arm64", variant: "v8" },
  });
  const attestation = {
    ...buildImage({ layers: [{ entries: [{ name: "att", data: "3" }] }] }),
  };
  let path: string;

  beforeAll(async () => {
    const files = ociLayoutFiles([amd, arm, attestation]);
    const index = JSON.parse(String(files.get("index.json"))) as {
      manifests: Record<string, unknown>[];
    };
    index.manifests[2] = {
      ...index.manifests[2],
      platform: { os: "unknown", architecture: "unknown" },
      annotations: { "vnd.docker.reference.type": "attestation-manifest" },
    };
    files.set("index.json", Buffer.from(JSON.stringify(index)));
    path = join(workspace, "multi.tar");
    await writeFile(path, archiveOf(files));
  });

  it("asks for a selection and still lists every image", async () => {
    const report = await inspect({ path });
    expect(report.selection.state).toBe("ambiguous");
    expect(report.selection.reason).toContain("platform or manifest");
    expect(report.manifests.map((m) => m.kind)).toEqual([
      "image",
      "image",
      "attestation",
    ]);
    expect(report.manifests.map((m) => m.platform?.architecture)).toEqual([
      "amd64",
      "arm64",
      "unknown",
    ]);
    expect(report.view).toBe("none");
    expect(report.layers).toEqual([]);
    expect(report.coverage.find((c) => c.facet === "inventory")?.state).toBe(
      "partial",
    );
  });

  it("selects by platform, with and without a variant", async () => {
    const byArch = await inspect({ path, platform: "linux/arm64" });
    expect(byArch.selection).toMatchObject({
      state: "selected",
      by: "platform",
      id: arm.manifestDigest,
    });
    expect(pathsOf(byArch)).toEqual(["arm"]);
    const withVariant = await inspect({ path, platform: "linux/arm64/v8" });
    expect(withVariant.selection.id).toBe(arm.manifestDigest);
    const wrongVariant = await inspect({ path, platform: "linux/arm64/v7" });
    expect(wrongVariant.selection.state).toBe("none");
  });

  it("selects by manifest id and reports a platform nothing matches", async () => {
    const byId = await inspect({ path, manifest: amd.manifestDigest });
    expect(byId.selection).toMatchObject({ state: "selected", by: "manifest" });
    expect(pathsOf(byId)).toEqual(["amd"]);
    const none = await inspect({ path, platform: "windows/amd64" });
    expect(none.selection.state).toBe("none");
    expect(none.selection.reason).toContain(
      "Available: linux/amd64, linux/arm64/v8",
    );
  });

  it("rejects platform together with manifest", () => {
    expect(
      inspectContainerImageInputSchema.safeParse({
        path: "/x",
        platform: "linux/amd64",
        manifest: amd.manifestDigest,
      }).success,
    ).toBe(false);
  });
});

const writeArchive = async (
  name: string,
  mutate: (files: Map<string, Buffer>) => void,
  spec: ImageSpec = THREE_LAYERS,
): Promise<string> => {
  const image = buildImage(spec);
  const files = ociLayoutFiles([image]);
  mutate(files);
  const path = join(workspace, name);
  await writeFile(path, archiveOf(files));
  return path;
};

describe("damaged and foreign content", () => {
  it("does not apply a layer whose blob does not match its digest", async () => {
    const path = await writeArchive("corrupt.tar", (files) => {
      const key = `blobs/sha256/${built.layerDigests[1]?.slice(7)}`;
      const blob = Buffer.from(files.get(key) as Buffer);
      blob[blob.length - 3] = (blob[blob.length - 3] ?? 0) ^ 0xff;
      files.set(key, blob);
    });
    const report = await inspect({ path });
    expect(report.layers[1]?.blob.state).toBe("digest_mismatch");
    expect(
      report.diagnostics.some((d) => d.message.includes("not applied")),
    ).toBe(true);
    expect(report.coverage.find((c) => c.facet === "inventory")?.state).toBe(
      "partial",
    );
    expect(report.coverage.find((c) => c.facet === "inspect")?.state).toBe(
      "partial",
    );
    // Layer 1 never reached the view, so layer 0's content shows through.
    expect(pathsOf(report)).toContain("var/cache/a");
  });

  it("reports a missing layer blob and keeps going", async () => {
    const path = await writeArchive("missing.tar", (files) => {
      files.delete(`blobs/sha256/${built.layerDigests[2]?.slice(7)}`);
    });
    const report = await inspect({ path });
    expect(report.layers[2]).toMatchObject({ read: "not_read" });
    expect(report.layers[2]?.blob.state).toBe("missing");
    expect(report.coverage.find((c) => c.facet === "inventory")?.state).toBe(
      "partial",
    );
    expect(report.layers[0]?.read).toBe("complete");
  });

  it("names a foreign layer and its URL without fetching it", async () => {
    const spec: ImageSpec = {
      layers: [
        { entries: [{ name: "base", data: "b" }] },
        {
          entries: [{ name: "windows", data: "w" }],
          foreign: "https://example.invalid/layer.tar.gz",
          mediaType:
            "application/vnd.docker.image.rootfs.foreign.diff.tar.gzip",
        },
      ],
    };
    const path = await writeArchive("foreign.tar", () => undefined, spec);
    const report = await inspect({ path });
    expect(report.layers[1]).toMatchObject({
      read: "not_read",
      urls: ["https://example.invalid/layer.tar.gz"],
    });
    expect(report.layers[1]?.blob.state).toBe("foreign");
    expect(pathsOf(report)).toEqual(["base"]);
    expect(report.coverage.find((c) => c.facet === "inventory")?.state).toBe(
      "partial",
    );
  });

  it("does not apply a layer whose diff id disagrees with the configuration", async () => {
    const path = await writeArchive("diffid.tar", () => undefined, {
      ...THREE_LAYERS,
      wrongDiffIds: [2],
    });
    const report = await inspect({ path });
    expect(report.layers[2]?.diff_id.valid).toBe(false);
    expect(report.layers[2]?.blob.state).toBe("verified");
    expect(pathsOf(report)).not.toContain("opt/x");
  });
});

describe("damaged layers and unusual content", () => {
  it("keeps entries read before a damaged tar and says so", async () => {
    const spec: ImageSpec = {
      layers: [
        {
          compression: "none",
          entries: [
            { name: "a", data: "a" },
            { name: "b", data: "b" },
          ],
        },
      ],
    };
    const image = buildImage(spec);
    const damaged = Buffer.from(image.layerBlobs[0] as Buffer);
    // Break the second header's checksum field.
    damaged[1024 + 148] = 0x39;
    const files = ociLayoutFiles([image]);
    files.set(`blobs/sha256/${image.layerDigests[0]?.slice(7)}`, damaged);
    const path = join(workspace, "damaged-tar.tar");
    await writeFile(path, archiveOf(files));
    const report = await inspect({ path });
    expect(report.layers[0]?.read).toBe("partial");
    expect(report.layers[0]?.blob.state).toBe("digest_mismatch");
    expect(report.diagnostics.some((d) => d.message.includes("damaged"))).toBe(
      true,
    );
  });

  it("lets the bytes decide when the media type names another compression", async () => {
    const spec: ImageSpec = {
      layers: [
        {
          compression: "none",
          mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
          entries: [{ name: "plain", data: "p" }],
        },
      ],
    };
    const path = await writeArchive("mediatype.tar", () => undefined, spec);
    const report = await inspect({ path });
    expect(report.layers[0]?.compression).toBe("none");
    expect(pathsOf(report)).toEqual(["plain"]);
    expect(
      report.diagnostics.some((d) => d.message.includes("the bytes decide")),
    ).toBe(true);
  });

  it("skips unsafe names and records escaping links", async () => {
    const spec: ImageSpec = {
      layers: [
        {
          entries: [
            { name: "ok", data: "ok" },
            { name: "../../escape", data: "x" },
            { name: "a/../../b", data: "x" },
            { name: "link", type: "symlink", link: "../../outside" },
            { name: "abs", type: "symlink", link: "/etc/hosts" },
            { name: "hard", type: "hardlink", link: "nowhere" },
          ],
        },
      ],
    };
    const path = await writeArchive("unsafe.tar", () => undefined, spec);
    const report = await inspect({ path });
    expect(pathsOf(report)).toEqual(["abs", "hard", "link", "ok"]);
    expect(
      report.diagnostics.filter((d) => d.message.includes("skipped")),
    ).toHaveLength(2);
    const byPath = new Map(report.files.map((file) => [file.path, file]));
    expect(byPath.get("link")?.link_status).toBe("escapes_root");
    expect(byPath.get("abs")?.link_status).toBe("dangling");
    expect(byPath.get("hard")?.link_status).toBe("dangling");
  });

  it("stops at the decoded-byte budget with a typed error", async () => {
    const spec: ImageSpec = {
      layers: [
        { entries: [{ name: "big", data: Buffer.alloc(2_000_000, 1) }] },
      ],
    };
    const path = await writeArchive("budget.tar", () => undefined, spec);
    const result = await run({ path, max_decoded_bytes: 100_000 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error._tag).toBe("AnalysisResourceConstraintError");
    }
  });

  it("reports a manifest whose JSON cannot be read without failing", async () => {
    const path = await writeArchive("badmanifest.tar", (files) => {
      files.set(
        `blobs/sha256/${built.manifestDigest.slice(7)}`,
        Buffer.from("not json"),
      );
    });
    const report = await inspect({ path });
    expect(report.manifests[0]?.blob.state).toBe("digest_mismatch");
    expect(report.selection.state).toBe("selected");
    expect(report.layers).toEqual([]);
    expect(
      report.diagnostics.some((d) =>
        d.message.includes("manifest could not be read"),
      ),
    ).toBe(true);
  });
});

describe("identity", () => {
  it("lists the same entries as the host tar and shasum", async () => {
    const report = await inspect({ path: layoutDirectory, layer: 1 });
    for (const [index, tar] of built.layerTars.entries()) {
      const path = join(workspace, `layer-${String(index)}.tar`);
      await writeFile(path, tar);
      const hostNames = execFileSync("/usr/bin/tar", ["-tf", path], {
        encoding: "utf8",
      })
        .split("\n")
        .filter((name) => name !== "" && name !== "./")
        .map((name) => name.replace(/^\.?\//u, "").replace(/\/$/u, ""))
        .sort();
      const own = await inspect({
        path: layoutDirectory,
        layer: index,
        limit: 100,
      });
      expect(own.files.map((file) => file.path).sort()).toEqual(hostNames);
      const hostDigest = execFileSync("/usr/bin/shasum", ["-a", "256", path], {
        encoding: "utf8",
      }).split(" ")[0];
      expect(`sha256:${hostDigest}`).toBe(report.config?.diff_ids[index]);
    }
  });

  it("hashes an archive whole and a layout by its index", async () => {
    const archive = await inspect({ path: ociArchive });
    const index = await inspect({ path: layoutDirectory });
    const files = ociLayoutFiles([built]);
    expect(index.artifact.sha256).toBe(
      sha256Of(files.get("index.json") as Buffer),
    );
    expect(archive.artifact.bytes).toBe(archiveOf(files).length);
    expect(archive.artifact.sha256).toBe(sha256Of(archiveOf(files)));
  });
});
