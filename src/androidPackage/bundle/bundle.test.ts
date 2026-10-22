import { execFile, spawn } from "node:child_process";
import {
  access,
  constants,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from "@zip.js/zip.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ANDROID_TOOLS,
  buildAndroidFixtures,
  writeZip,
  type AndroidFixtures,
} from "../../../tests/fixtures/androidProducers.js";
import { removeTestWorkspace } from "../../../tests/support/workspace/workspaceFixture.js";
import { ProtobufFormatError } from "../protobuf.js";
import {
  readBundleConfig,
  type BundleConfigFacts,
  type BundleSplitDimension,
} from "./bundleConfig.js";
import {
  readApksToc,
  type ApksApkDescription,
  type ApksTargetingDimension,
  type ApksToc,
} from "./toc.js";

const run = promisify(execFile);

const PROTOC = await (async () => {
  for (const candidate of ["/opt/homebrew/bin/protoc", "/usr/local/bin/protoc"])
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not installed here.
    }
  return null;
})();

const zipMembers = async (path: string): Promise<Map<string, Uint8Array>> => {
  const reader = new ZipReader(new Uint8ArrayReader(await readFile(path)));
  const members = new Map<string, Uint8Array>();
  for (const entry of await reader.getEntries())
    if (!entry.directory)
      members.set(entry.filename, await entry.getData(new Uint8ArrayWriter()));
  await reader.close();
  return members;
};

const member = (members: Map<string, Uint8Array>, name: string): Uint8Array => {
  const bytes = members.get(name);
  if (bytes === undefined) throw new Error(`${name} is missing`);
  return bytes;
};

const bundletool = async (args: readonly string[]): Promise<string> => {
  if (ANDROID_TOOLS === null) throw new Error("bundletool is missing");
  const { stdout } = await run(
    join(ANDROID_TOOLS.javaHome, "bin", "java"),
    ["-jar", ANDROID_TOOLS.bundletool, ...args],
    { encoding: "utf8", maxBuffer: 64 * 1024 ** 2 },
  );
  return stdout;
};

// ---- bundletool's JSON config dump in our shape ----

type Json = { readonly [key: string]: unknown };
const object = (value: unknown): Json | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined;
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown, fallback: string): string =>
  typeof value === "string" ? value : fallback;
const flag = (value: unknown): boolean => value === true;

const jsonDimension = (value: unknown): BundleSplitDimension => {
  const dimension = object(value);
  const stripping = object(dimension?.suffixStripping);
  return {
    value: text(dimension?.value, "UNSPECIFIED_VALUE"),
    negate: flag(dimension?.negate),
    suffix_stripping:
      stripping === undefined
        ? null
        : {
            enabled: flag(stripping.enabled),
            default_suffix: text(stripping.defaultSuffix, ""),
          },
  };
};

/** proto3 JSON (absent = default) mapped field by field onto BundleConfigFacts. */
const configFromJson = (json: Json): BundleConfigFacts => {
  const optimizations = object(json.optimizations);
  const present = <T>(value: unknown, read: (inner: Json) => T): T | null => {
    const inner = object(value);
    return inner === undefined ? null : read(inner);
  };
  return {
    bundletool_version: present(json.bundletool, (tool) =>
      text(tool.version, ""),
    ),
    bundle_type: text(json.type, "REGULAR"),
    optimizations:
      optimizations === undefined
        ? null
        : {
            split_dimensions: list(
              object(optimizations.splitsConfig)?.splitDimension,
            ).map(jsonDimension),
            uncompress_native_libraries: present(
              optimizations.uncompressNativeLibraries,
              (native) => ({
                enabled: flag(native.enabled),
                alignment: text(native.alignment, "PAGE_ALIGNMENT_UNSPECIFIED"),
              }),
            ),
            uncompress_dex_files: present(
              optimizations.uncompressDexFiles,
              (dex) => ({
                enabled: flag(dex.enabled),
                uncompressed_dex_target_sdk: text(
                  dex.uncompressedDexTargetSdk,
                  "UNSPECIFIED",
                ),
              }),
            ),
            standalone_config: present(
              optimizations.standaloneConfig,
              (standalone) => ({
                split_dimensions: list(standalone.splitDimension).map(
                  jsonDimension,
                ),
                strip_64_bit_libraries: flag(standalone.strip64BitLibraries),
                dex_merging_strategy: text(
                  standalone.dexMergingStrategy,
                  "MERGE_IF_NEEDED",
                ),
                feature_modules_mode: text(
                  standalone.featureModulesMode,
                  "FUSED_FEATURE_MODULES",
                ),
              }),
            ),
            resource_optimizations: present(
              optimizations.resourceOptimizations,
              (resources) => {
                const collapsed = object(resources.collapsedResourceNames);
                return {
                  sparse_encoding: text(
                    resources.sparseEncoding,
                    "UNSPECIFIED",
                  ),
                  collapse_resource_names: flag(
                    collapsed?.collapseResourceNames,
                  ),
                  deduplicate_resource_entries: flag(
                    collapsed?.deduplicateResourceEntries,
                  ),
                  no_collapse_resources: list(
                    collapsed?.noCollapseResources,
                  ).map(
                    (entry) =>
                      `${text(object(entry)?.type, "")}/${text(object(entry)?.name, "")}`,
                  ),
                  no_collapse_resource_types: list(
                    collapsed?.noCollapseResourceTypes,
                  ).map((type) => text(type, "")),
                };
              },
            ),
            store_archive: present(optimizations.storeArchive, (archive) =>
              flag(archive.enabled),
            ),
            inject_min_sdk: text(
              optimizations.injectMinSdkSetting,
              "UNSPECIFIED",
            ),
          },
    compression: present(json.compression, (compression) => ({
      uncompressed_globs: list(compression.uncompressedGlob).map((glob) =>
        text(glob, ""),
      ),
      install_time_asset_module_default_compression: text(
        compression.installTimeAssetModuleDefaultCompression,
        "UNSPECIFIED",
      ),
      apk_compression_algorithm: text(
        compression.apkCompressionAlgorithm,
        "DEFAULT_APK_COMPRESSION_ALGORITHM",
      ),
    })),
    master_resources: present(json.masterResources, (master) => ({
      resource_ids: list(master.resourceIds).map(Number),
      resource_names: list(master.resourceNames).map((name) => text(name, "")),
    })),
    asset_modules: present(json.assetModulesConfig, (assets) => ({
      app_versions: list(assets.appVersion).map(String),
      asset_version_tag: text(assets.assetVersionTag, ""),
    })),
    unsigned_embedded_apks: list(json.unsignedEmbeddedApkConfig).map((entry) =>
      text(object(entry)?.path, ""),
    ),
    inject_locale_config: present(json.locales, (locales) =>
      flag(locales.injectLocaleConfig),
    ),
    undecoded_field_count: 0,
  };
};

const RICH_CONFIG = {
  optimizations: {
    splitsConfig: {
      splitDimension: [
        { value: "ABI" },
        { value: "SCREEN_DENSITY", negate: true },
        { value: "LANGUAGE" },
        {
          value: "TEXTURE_COMPRESSION_FORMAT",
          suffixStripping: { enabled: true, defaultSuffix: "etc2" },
        },
      ],
    },
    uncompressNativeLibraries: {
      enabled: true,
      alignment: "PAGE_ALIGNMENT_16K",
    },
    uncompressDexFiles: { enabled: true, uncompressedDexTargetSdk: "SDK_31" },
    standaloneConfig: {
      splitDimension: [{ value: "ABI" }],
      strip64BitLibraries: true,
      dexMergingStrategy: "NEVER_MERGE",
    },
    resourceOptimizations: {
      sparseEncoding: "VARIANT_FOR_SDK_32",
      collapsedResourceNames: {
        collapseResourceNames: true,
        noCollapseResources: [{ type: "string", name: "app_name" }],
        noCollapseResourceTypes: ["id"],
        deduplicateResourceEntries: true,
      },
    },
    storeArchive: { enabled: false },
    injectMinSdkSetting: "ENABLED",
  },
  compression: {
    uncompressedGlob: ["assets/**", "res/raw/*.bin"],
    installTimeAssetModuleDefaultCompression: "COMPRESSED",
  },
  masterResources: {
    resourceIds: [2130968576, 2130968577],
    resourceNames: ["string/app_name"],
  },
  locales: { injectLocaleConfig: true },
};

// ---- protoc text format in ApksToc's shape ----

type TextValue = string | TextMessage;
interface TextMessage {
  readonly [field: string]: TextValue[];
}

const protocDecode = (
  protoc: string,
  includes: string,
  type: string,
  bytes: Uint8Array,
): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn(protoc, [
      `--decode=${type}`,
      "-I",
      includes,
      "commands.proto",
    ]);
    const out: Buffer[] = [];
    const errors: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out).toString("utf8"));
      else reject(new Error(Buffer.concat(errors).toString("utf8")));
    });
    child.stdin.end(Buffer.from(bytes));
  });

/** protoc --decode output: `name: value` scalars and `name { ... }` messages, all repeated as arrays. */
const parseTextFormat = (source: string): TextMessage => {
  const stack: Record<string, TextValue[]>[] = [{}];
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    const top = stack.at(-1) ?? {};
    if (line === "") continue;
    if (line === "}") stack.pop();
    else if (line.endsWith(" {")) {
      const child: Record<string, TextValue[]> = {};
      (top[line.slice(0, -2)] ??= []).push(child);
      stack.push(child);
    } else {
      const cut = line.indexOf(": ");
      const value = line.slice(cut + 2);
      (top[line.slice(0, cut)] ??= []).push(
        value.startsWith('"') ? value.slice(1, -1) : value,
      );
    }
  }
  return stack[0] ?? {};
};

const messages = (
  message: TextMessage | undefined,
  field: string,
): TextMessage[] =>
  (message?.[field] ?? []).filter(
    (value): value is TextMessage => typeof value !== "string",
  );
const first = (
  message: TextMessage | undefined,
  field: string,
): TextMessage | undefined => messages(message, field)[0];
const strings = (message: TextMessage | undefined, field: string): string[] =>
  (message?.[field] ?? []).filter(
    (value): value is string => typeof value === "string",
  );
const scalar = (
  message: TextMessage | undefined,
  field: string,
  fallback: string,
): string => strings(message, field)[0] ?? fallback;

/** One targeting value as protoc names it. */
const textValue = (dimension: string, value: TextValue): string => {
  if (typeof value === "string") return value;
  switch (dimension) {
    case "sdk_version":
      return scalar(first(value, "min"), "value", "0");
    case "screen_density":
      return value.density_dpi === undefined
        ? scalar(value, "density_alias", "DENSITY_UNSPECIFIED")
        : `${scalar(value, "density_dpi", "0")}dpi`;
    case "multi_abi":
      return messages(value, "abi")
        .map((abi) => scalar(abi, "alias", "UNSPECIFIED_CPU_ARCHITECTURE"))
        .join("+");
    case "abi":
      return scalar(value, "alias", "UNSPECIFIED_CPU_ARCHITECTURE");
    case "device_tier":
      return scalar(value, "value", "0");
    default:
      return scalar(value, "alias", "?");
  }
};

/** `*_targeting` children of a targeting message, in protoc's (field-number) order. */
const textTargeting = (
  targeting: TextMessage | undefined,
): ApksTargetingDimension[] =>
  Object.entries(targeting ?? {}).flatMap(([field, values]) => {
    const name = field.replace(/_targeting$/u, "");
    const inner = values[0];
    if (typeof inner === "string" || inner === undefined) return [];
    if (name === "sdk_runtime")
      return scalar(inner, "requires_sdk_runtime", "false") === "true"
        ? [
            {
              dimension: "sdk_runtime",
              values: ["REQUIRES_SDK_RUNTIME"],
              alternatives: [],
            },
          ]
        : [];
    return [
      {
        dimension: name,
        values: (inner.value ?? []).map((value) => textValue(name, value)),
        alternatives: (inner.alternatives ?? []).map((value) =>
          textValue(name, value),
        ),
      },
    ];
  });

const METADATA: readonly [string, ApksApkDescription["kind"]][] = [
  ["split_apk_metadata", "split"],
  ["standalone_apk_metadata", "standalone"],
  ["instant_apk_metadata", "instant"],
  ["system_apk_metadata", "system"],
  ["asset_slice_metadata", "asset_slice"],
  ["apex_apk_metadata", "apex"],
  ["archived_apk_metadata", "archived"],
];

const textApk = (apk: TextMessage): ApksApkDescription => {
  const [key, kind] = METADATA.find(([field]) => apk[field] !== undefined) ?? [
    "",
    "unknown" as const,
  ];
  const metadata = first(apk, key);
  const split =
    kind === "split" || kind === "instant" || kind === "asset_slice";
  const standaloneId =
    kind === "standalone" ? scalar(metadata, "split_id", "") : "";
  return {
    path: scalar(apk, "path", ""),
    kind,
    split_id: split
      ? scalar(metadata, "split_id", "")
      : standaloneId === ""
        ? null
        : standaloneId,
    is_master_split: split
      ? scalar(metadata, "is_master_split", "false") === "true"
      : null,
    fused_modules: strings(metadata, "fused_module_name"),
    targeting: textTargeting(first(apk, "targeting")),
    signed_with_rotated_key:
      scalar(
        first(apk, "signing_description"),
        "signed_with_rotated_key",
        "false",
      ) === "true",
  };
};

/** The protoc view of BuildApksResult, mapped onto ApksToc. */
const tocFromText = (toc: TextMessage): ApksToc => {
  const testing = first(toc, "local_testing_info");
  return {
    bundletool_version: scalar(first(toc, "bundletool"), "version", "") || null,
    package_name: scalar(toc, "package_name", "") || null,
    variants: messages(toc, "variant").map((variant) => {
      const properties = first(variant, "variant_properties");
      const property = (name: string) =>
        scalar(properties, name, "false") === "true";
      return {
        variant_number: Number(scalar(variant, "variant_number", "0")),
        targeting: textTargeting(first(variant, "targeting")),
        properties:
          properties === undefined
            ? null
            : {
                uncompressed_dex: property("uncompressed_dex"),
                uncompressed_native_libraries: property(
                  "uncompressed_native_libraries",
                ),
                sparse_encoding: property("sparse_encoding"),
              },
        apk_sets: messages(variant, "apk_set").map((set) => {
          const module = first(set, "module_metadata");
          return {
            module: {
              name: scalar(module, "name", ""),
              module_type: scalar(module, "module_type", "UNKNOWN_MODULE_TYPE"),
              delivery_type: scalar(
                module,
                "delivery_type",
                "UNKNOWN_DELIVERY_TYPE",
              ),
              is_instant: scalar(module, "is_instant", "false") === "true",
              dependencies: strings(module, "dependencies"),
              targeting: textTargeting(first(module, "targeting")),
            },
            apks: messages(set, "apk_description").map(textApk),
          };
        }),
      };
    }),
    asset_slice_sets: [],
    local_testing:
      testing === undefined
        ? null
        : {
            enabled: scalar(testing, "enabled", "false") === "true",
            local_testing_path: scalar(testing, "local_testing_path", ""),
          },
    default_targeting_values: messages(toc, "default_targeting_value").map(
      (entry) => ({
        dimension: scalar(entry, "dimension", "UNSPECIFIED_VALUE"),
        default_value: scalar(entry, "default_value", ""),
      }),
    ),
    permanently_fused_modules: messages(toc, "permanently_fused_modules").map(
      (entry) => scalar(entry, "name", ""),
    ),
    undecoded_field_count: 0,
  };
};

const describeAndroid = describe.skipIf(ANDROID_TOOLS === null);

describeAndroid("bundle metadata against bundletool and protoc", () => {
  let root: string | undefined;
  let fixtures: AndroidFixtures;
  let protos: string;
  let richBundle: string;
  const sets: Record<string, string> = {};

  beforeAll(async () => {
    if (ANDROID_TOOLS === null) return;
    root = await realpath(
      await mkdtemp(join(await realpath(tmpdir()), "rea-android-bundle-")),
    );
    fixtures = await buildAndroidFixtures(root);
    // The .proto files bundletool ships are the field-exact schema protoc decodes with.
    protos = join(root, "protos");
    for (const [name, bytes] of await zipMembers(ANDROID_TOOLS.bundletool))
      if (name.endsWith(".proto")) {
        await mkdir(join(protos, name, ".."), { recursive: true });
        await writeFile(join(protos, name), bytes);
      }
    // The base module again, as a module zip, with a config that sets every decoded BundleConfig field.
    const base = [...(await zipMembers(fixtures.aab))]
      .filter(([name]) => name.startsWith("base/"))
      .map(([name, bytes]) => [name.slice("base/".length), bytes] as const);
    await writeZip(join(root, "base-module.zip"), base);
    await writeFile(join(root, "config.json"), JSON.stringify(RICH_CONFIG));
    richBundle = join(root, "rich.aab");
    await bundletool([
      "build-bundle",
      `--modules=${join(root, "base-module.zip")}`,
      `--config=${join(root, "config.json")}`,
      `--output=${richBundle}`,
    ]);
    const signing = [
      `--ks=${fixtures.keystore.path}`,
      `--ks-pass=pass:${fixtures.keystore.password}`,
      `--ks-key-alias=${fixtures.keystore.alias}`,
      `--key-pass=pass:${fixtures.keystore.password}`,
      `--aapt2=${join(ANDROID_TOOLS.buildTools, "aapt2")}`,
    ];
    sets.split = fixtures.apks;
    for (const [name, extra] of [
      ["universal", ["--mode=universal"]],
      ["local", ["--local-testing"]],
    ] as const) {
      sets[name] = join(root, `${name}.apks`);
      await bundletool([
        "build-apks",
        `--bundle=${fixtures.aab}`,
        `--output=${sets[name]}`,
        ...signing,
        ...extra,
      ]);
    }
  }, 240_000);

  afterAll(async () => {
    if (root !== undefined) await removeTestWorkspace(root);
  });

  it("reads BundleConfig.pb exactly as bundletool dump config reports it", async () => {
    for (const bundle of [fixtures.aab, richBundle]) {
      const facts = readBundleConfig(
        member(await zipMembers(bundle), "BundleConfig.pb"),
      );
      const json =
        object(
          JSON.parse(
            await bundletool(["dump", "config", `--bundle=${bundle}`]),
          ),
        ) ?? {};
      expect(facts).toEqual(configFromJson(json));
    }
    const rich = readBundleConfig(
      member(await zipMembers(richBundle), "BundleConfig.pb"),
    );
    expect(rich.optimizations?.split_dimensions).toHaveLength(4);
    expect(rich.optimizations?.split_dimensions[3]?.suffix_stripping).toEqual({
      enabled: true,
      default_suffix: "etc2",
    });
    expect(rich.compression?.uncompressed_globs).toEqual([
      "assets/**",
      "res/raw/*.bin",
    ]);
  });

  it.skipIf(PROTOC === null)(
    "reads every variant, module and APK of toc.pb as protoc decodes it",
    async () => {
      let apks = 0;
      for (const [name, path] of Object.entries(sets)) {
        const bytes = member(await zipMembers(path), "toc.pb");
        const toc = readApksToc(bytes);
        const oracle = tocFromText(
          parseTextFormat(
            await protocDecode(
              PROTOC ?? "",
              protos,
              "android.bundle.BuildApksResult",
              bytes,
            ),
          ),
        );
        expect(toc, name).toEqual(oracle);
        apks += toc.variants.flatMap((variant) =>
          variant.apk_sets.flatMap((set) => set.apks),
        ).length;
      }
      expect(apks).toBe(36 + 1 + 36);
      const split = readApksToc(
        member(await zipMembers(fixtures.apks), "toc.pb"),
      );
      expect(
        split.variants.map((variant) => variant.targeting[0]?.values),
      ).toEqual([["24"], ["29"], ["32"]]);
      const camera = split.variants[0]?.apk_sets.find(
        (set) => set.module.name === "camera",
      );
      expect(camera?.module.delivery_type).toBe("ON_DEMAND");
      expect(camera?.apks[0]).toMatchObject({
        kind: "split",
        split_id: "camera",
        is_master_split: true,
      });
      const universal = readApksToc(
        member(await zipMembers(sets.universal ?? ""), "toc.pb"),
      );
      expect(universal.variants[0]?.apk_sets[0]?.apks[0]).toMatchObject({
        kind: "standalone",
        fused_modules: ["base", "camera"],
      });
    },
  );
});

describeAndroid(
  "damaged bundle metadata derived from real bundletool output",
  () => {
    let root: string | undefined;
    let toc: Uint8Array;
    let config: Uint8Array;

    beforeAll(async () => {
      root = await realpath(
        await mkdtemp(
          join(await realpath(tmpdir()), "rea-android-bundle-bad-"),
        ),
      );
      const fixtures = await buildAndroidFixtures(root);
      toc = member(await zipMembers(fixtures.apks), "toc.pb");
      config = member(await zipMembers(fixtures.aab), "BundleConfig.pb");
    }, 180_000);

    afterAll(async () => {
      if (root !== undefined) await removeTestWorkspace(root);
    });

    it("reports a truncated varint at its byte offset", () => {
      // Append a field-3 varint key (0x18) and a continuation byte (0x80) that nothing follows.
      for (const [bytes, read] of [
        [toc, readApksToc],
        [config, readBundleConfig],
      ] as const) {
        const damaged = new Uint8Array([...bytes, 0x18, 0x80]);
        expect(() => read(damaged)).toThrow(ProtobufFormatError);
        try {
          read(damaged);
        } catch (error) {
          expect((error as ProtobufFormatError).offset).toBe(bytes.length + 1);
        }
      }
    });

    it("reports a field whose length runs past its message", () => {
      // Cut the toc 3 bytes short: the last length-delimited field now claims bytes that are gone.
      expect(() => readApksToc(toc.slice(0, toc.length - 3))).toThrow(
        /declares \d+ bytes but only \d+ remain/u,
      );
    });

    it("counts fields it does not decode and reads the rest unchanged", () => {
      // Append unknown top-level field 99 (varint 1) and BuildApksResult.device_group_config (field 9, empty).
      const extended = new Uint8Array([...toc, 0x98, 0x06, 0x01, 0x4a, 0x00]);
      const plain = readApksToc(toc);
      expect(readApksToc(extended)).toEqual({
        ...plain,
        undecoded_field_count: plain.undecoded_field_count + 2,
      });
      const configExtended = new Uint8Array([...config, 0x2a, 0x00]);
      expect(readBundleConfig(configExtended).undecoded_field_count).toBe(1);
    });

    it("refuses a known field sent with the wrong wire type", () => {
      // package_name (field 4) as a varint instead of a string.
      expect(() => readApksToc(new Uint8Array([0x20, 0x01]))).toThrow(
        /Field 4 is not length-delimited/u,
      );
    });
  },
);
