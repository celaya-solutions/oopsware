import { createHash } from "node:crypto";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { encodeNibArchiveFixture } from "./NibArchive.fixture.js";
import type { analyzeInterfaceBuilderBundle } from "./InterfaceBuilderAnalysis.js";
import { ArtifactReaderFailure } from "../ArtifactReader.js";
import {
  analyzeAppleAssetCatalogs,
  collectInterfaceBuilderResourceKeys,
} from "./AppleAssetCatalogAnalysis.js";

describe("Apple asset catalog application workflow", () => {
  it("joins only explicit resource-key fields with archive provenance", () => {
    expect(
      collectInterfaceBuilderResourceKeys([
        {
          id: "ib:Main.nib:object:2",
          kind: "resource",
          name: "Decorative image",
          attributes: {
            imageName: "Toolbar",
            title: "not-an-asset-key",
            image: 42,
            nibValues: {
              title: "not-an-asset-key",
              imageName: { value: "not-a-scalar" },
              image: 42,
              assetName: "",
              nested: { NSImageName: "not-a-direct-field" },
            },
          },
          evidence: [
            {
              artifact_path: "Contents/Resources/Main.nib",
              artifact_sha256: "d".repeat(64),
            },
          ],
        },
        {
          id: "ib:Main.nib:object:3",
          kind: "control",
          name: "Toolbar",
          attributes: { NSImageName: "Toolbar", imageName: "Toolbar" },
          evidence: [
            {
              artifact_path: "Contents/Resources/Main.nib",
              artifact_sha256: "d".repeat(64),
            },
          ],
        },
      ]),
    ).toEqual([
      {
        sourceNodeId: "ib:Main.nib:object:2",
        sourcePath: "Contents/Resources/Main.nib",
        sourceArchiveSha256: "d".repeat(64),
        field: "imageName",
        key: "Toolbar",
      },
    ]);
  });

  it.each([0, 1, 5])(
    "reports an app without compiled catalogs as empty at offset %i",
    async (offset) => {
      const bundle = await createTestTempDirectory("rea-asset-catalog-absent-");
      await mkdir(join(bundle, "Contents", "Resources"), { recursive: true });
      await writeFile(join(bundle, "Contents", "Resources", "icon.icns"), "");
      // Names that merely end in Assets.car are ordinary resources.
      await mkdir(join(bundle, "Contents", "Resources", "NotAssets.car"));
      await writeFile(
        join(bundle, "Contents", "Resources", "OldAssets.car"),
        "",
      );
      const result = await analyzeAppleAssetCatalogs({
        environment: {},
        bundlePath: bundle,
        targetSha256: "a".repeat(64),
        page: { offset },
        runAssetUtil: () => {
          throw new Error("assetutil must not run without a catalog");
        },
      });
      expect(result).toMatchObject({
        catalogs: [],
        total_records: 0,
        offset,
        limit: 1_000,
        records: [],
        resource_key_matches: [],
        next_offset: null,
        truncated: false,
      });
      expect(result.limitations).toContain(
        "No compiled Assets.car catalog was found among the app bundle's regular files (symlinks are not followed); any resource keys are reported as unmatched.",
      );
    },
  );

  it("does not report absence when the only catalog entry is a symlink", async () => {
    const bundle = await createTestTempDirectory("rea-asset-catalog-link-");
    const resources = join(bundle, "Contents", "Resources");
    await mkdir(resources, { recursive: true });
    await writeFile(join(bundle, "outside.car"), "catalog");
    await symlink("../../outside.car", join(resources, "Assets.car"));
    const rejected = await analyzeAppleAssetCatalogs({
      environment: {},
      bundlePath: bundle,
      targetSha256: "a".repeat(64),
      runAssetUtil: () => Promise.resolve("[]"),
    }).catch((cause: unknown) => cause);
    expect(rejected).toBeInstanceOf(ArtifactReaderFailure);
    expect(rejected).toMatchObject({
      reason: "path",
      message: expect.stringContaining(
        "Contents/Resources/Assets.car (symlink)",
      ),
    });
  });

  it("discloses skipped catalog entries beside inspected catalogs", async () => {
    const bundle = await createTestTempDirectory("rea-asset-catalog-mixed-");
    const resources = join(bundle, "Contents", "Resources");
    await mkdir(join(resources, "Nested"), { recursive: true });
    await writeFile(join(resources, "Assets.car"), "catalog");
    await symlink("../Assets.car", join(resources, "Nested", "Assets.car"));
    const result = await analyzeAppleAssetCatalogs({
      environment: {},
      bundlePath: bundle,
      targetSha256: "a".repeat(64),
      runAssetUtil: () => Promise.resolve("[]"),
    });
    expect(result.catalogs.map(({ path }) => path)).toEqual([
      "Contents/Resources/Assets.car",
    ]);
    expect(result.limitations).toContainEqual(
      expect.stringContaining("Contents/Resources/Nested/Assets.car (symlink)"),
    );
    expect(result.limitations).not.toContainEqual(
      expect.stringContaining("No compiled Assets.car catalog"),
    );
  });
});

it.each([0, 1, 5])(
  "keeps an empty assetutil inventory complete at offset %i",
  async (offset) => {
    const bundle = await createTestTempDirectory("rea-asset-catalog-empty-");
    const resources = join(bundle, "Contents", "Resources");
    await mkdir(resources, { recursive: true });
    await writeFile(join(resources, "Assets.car"), "inert catalog fixture");
    const result = await analyzeAppleAssetCatalogs({
      environment: {},
      bundlePath: bundle,
      targetSha256: "a".repeat(64),
      page: { offset, limit: 2 },
      runAssetUtil: () => Promise.resolve("[]"),
    });
    expect(result).toMatchObject({
      total_records: 0,
      offset,
      limit: 2,
      records: [],
      next_offset: null,
      truncated: false,
    });
  },
);

it.each([1, 2])(
  "joins NIBArchive keys against %i supplied assetutil renditions",
  async (count) => {
    const bundle = await createTestTempDirectory("rea-asset-nib-join-");
    const resources = join(bundle, "Contents", "Resources");
    await mkdir(resources, { recursive: true });
    const archive = encodeNibArchiveFixture({
      classes: ["NSIBObjectData", "NSImageView", "NSImage", "NSString"],
      objects: [
        { classIndex: 0, values: { NSRoot: { ref: 1 } } },
        { classIndex: 1, values: { image: { ref: 2 } } },
        { classIndex: 2, values: { NSImageName: { ref: 3 } } },
        { classIndex: 3, values: { "NS.bytes": "Toolbar" } },
      ],
    });
    await writeFile(join(resources, "Panel.nib"), archive);
    await writeFile(join(resources, "Assets.car"), "inert catalog fixture");
    // Supplied metadata tests the post-engine join; it does not establish native catalog validity.
    const result = await analyzeAppleAssetCatalogs({
      environment: {},
      bundlePath: bundle,
      targetSha256: "a".repeat(64),
      runAssetUtil: () =>
        Promise.resolve(
          JSON.stringify(
            Array.from({ length: count }, (_, index) => ({
              Name: "Toolbar",
              RenditionName: `toolbar-${String(index)}.png`,
            })),
          ),
        ),
    });
    expect(result.resource_key_matches).toHaveLength(1);
    expect(result.resource_key_matches[0]).toMatchObject({
      field: "NSImageName",
      key: "Toolbar",
      status: count === 1 ? "matched" : "ambiguous",
      source_path: "Contents/Resources/Panel.nib",
      source_archive_sha256: createHash("sha256").update(archive).digest("hex"),
      renditions: Array.from({ length: count }, (_, index) =>
        expect.objectContaining({
          record_index: index,
          rendition_name: `toolbar-${String(index)}.png`,
        }),
      ),
    });
  },
);

it("keeps recognized image fields on NIBArchive controls out of resource joins", async () => {
  const bundle = await createTestTempDirectory("rea-asset-nib-control-");
  const resources = join(bundle, "Contents", "Resources");
  await mkdir(resources, { recursive: true });
  await writeFile(
    join(resources, "Panel.nib"),
    encodeNibArchiveFixture({
      classes: ["NSIBObjectData", "NSButton", "NSString"],
      objects: [
        { classIndex: 0, values: { NSRoot: { ref: 1 } } },
        { classIndex: 1, values: { NSImageName: { ref: 2 } } },
        { classIndex: 2, values: { "NS.bytes": "Toolbar" } },
      ],
    }),
  );
  await writeFile(join(resources, "Assets.car"), "inert catalog fixture");
  const result = await analyzeAppleAssetCatalogs({
    environment: {},
    bundlePath: bundle,
    targetSha256: "a".repeat(64),
    runAssetUtil: () => Promise.resolve(JSON.stringify([{ Name: "Toolbar" }])),
  });
  expect(result.resource_key_matches).toEqual([]);
});

describe("Apple asset catalog and Interface Builder concurrency", () => {
  const catalogBundle = async () => {
    const bundle = await createTestTempDirectory("rea-asset-catalog-ib-");
    const resources = join(bundle, "Contents", "Resources");
    await mkdir(resources, { recursive: true });
    await writeFile(join(resources, "Assets.car"), "catalog");
    return bundle;
  };
  const emptyGraph = {
    graph: { nodes: [], truncated: false },
  } as unknown as Awaited<ReturnType<typeof analyzeInterfaceBuilderBundle>>;

  it("keeps the Interface Builder analysis running while catalogs are inspected", async () => {
    // The Interface Builder analysis can finish only after catalog inspection
    // starts, so a sequential implementation would never complete.
    let catalogStarted!: () => void;
    const catalogStart = new Promise<void>((resolve) => {
      catalogStarted = resolve;
    });
    const result = await analyzeAppleAssetCatalogs({
      environment: {},
      bundlePath: await catalogBundle(),
      targetSha256: "a".repeat(64),
      analyzeInterfaceBuilder: async () => {
        await catalogStart;
        return emptyGraph;
      },
      runAssetUtil: async () => {
        catalogStarted();
        return "[]";
      },
    });
    expect(result.catalogs).toHaveLength(1);
  }, 5_000);

  it("cancels the Interface Builder analysis and reports a catalog failure", async () => {
    let cancelled = false;
    let settled = false;
    const rejected = await analyzeAppleAssetCatalogs({
      environment: {},
      bundlePath: await catalogBundle(),
      targetSha256: "a".repeat(64),
      analyzeInterfaceBuilder: ({ signal }) =>
        new Promise((_, reject) => {
          signal?.addEventListener("abort", () => {
            cancelled = true;
            setImmediate(() => {
              settled = true;
              reject(new Error("interface builder cancelled"));
            });
          });
        }),
      runAssetUtil: () => Promise.reject(new Error("assetutil failed")),
    }).catch((cause: unknown) => cause);
    expect(rejected).toMatchObject({ message: "assetutil failed" });
    expect(cancelled).toBe(true);
    expect(settled).toBe(true);
  });

  it("reports an early Interface Builder failure only after catalogs are inspected", async () => {
    let finishCatalog!: (output: string) => void;
    let catalogStarted = false;
    let settled = false;
    const analysis = analyzeAppleAssetCatalogs({
      environment: {},
      bundlePath: await catalogBundle(),
      targetSha256: "a".repeat(64),
      analyzeInterfaceBuilder: () =>
        Promise.reject(new Error("interface builder failed")),
      runAssetUtil: () => {
        catalogStarted = true;
        return new Promise((resolve) => {
          finishCatalog = resolve;
        });
      },
    }).finally(() => {
      settled = true;
    });
    analysis.catch(() => undefined);
    await vi.waitFor(() => expect(catalogStarted).toBe(true));
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    finishCatalog("[]");
    await expect(analysis).rejects.toThrow("interface builder failed");
  });
});
