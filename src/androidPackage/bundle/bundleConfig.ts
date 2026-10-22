import { ProtobufMessage } from "../protobuf.js";

/**
 * BundleConfig.pb of an Android App Bundle (bundletool config.proto
 * `BundleConfig`). Enum values render by their proto names; fields this
 * reader does not decode are counted, not guessed. Malformed protobuf
 * throws ProtobufFormatError with its byte offset.
 */

export interface BundleSplitDimension {
  /** SplitDimension.Value name, e.g. "ABI", "LANGUAGE". */
  readonly value: string;
  readonly negate: boolean;
  readonly suffix_stripping: {
    readonly enabled: boolean;
    readonly default_suffix: string;
  } | null;
}

export interface BundleConfigFacts {
  readonly bundletool_version: string | null;
  /** BundleType name: "REGULAR", "APEX" or "ASSET_ONLY". */
  readonly bundle_type: string;
  readonly optimizations: {
    readonly split_dimensions: readonly BundleSplitDimension[];
    readonly uncompress_native_libraries: {
      readonly enabled: boolean;
      readonly alignment: string;
    } | null;
    readonly uncompress_dex_files: {
      readonly enabled: boolean;
      readonly uncompressed_dex_target_sdk: string;
    } | null;
    readonly standalone_config: {
      readonly split_dimensions: readonly BundleSplitDimension[];
      readonly strip_64_bit_libraries: boolean;
      readonly dex_merging_strategy: string;
      readonly feature_modules_mode: string;
    } | null;
    readonly resource_optimizations: {
      readonly sparse_encoding: string;
      readonly collapse_resource_names: boolean;
      readonly deduplicate_resource_entries: boolean;
      readonly no_collapse_resources: readonly string[];
      readonly no_collapse_resource_types: readonly string[];
    } | null;
    readonly store_archive: boolean | null;
    readonly inject_min_sdk: string;
  } | null;
  readonly compression: {
    readonly uncompressed_globs: readonly string[];
    readonly install_time_asset_module_default_compression: string;
    readonly apk_compression_algorithm: string;
  } | null;
  readonly master_resources: {
    readonly resource_ids: readonly number[];
    readonly resource_names: readonly string[];
  } | null;
  readonly asset_modules: {
    readonly app_versions: readonly string[];
    readonly asset_version_tag: string;
  } | null;
  readonly unsigned_embedded_apks: readonly string[];
  readonly inject_locale_config: boolean | null;
  /** Wire fields present that this reader does not decode (APEX config among them). */
  readonly undecoded_field_count: number;
}

/** A proto enum value by name; unknown numbers stay visible. */
export const enumName = (
  names: Readonly<Record<number, string>>,
  value: number,
): string => names[value] ?? `UNKNOWN(${String(value)})`;

const SPLIT_DIMENSIONS: Readonly<Record<number, string>> = {
  0: "UNSPECIFIED_VALUE",
  1: "ABI",
  2: "SCREEN_DENSITY",
  3: "LANGUAGE",
  4: "TEXTURE_COMPRESSION_FORMAT",
  6: "DEVICE_TIER",
  7: "COUNTRY_SET",
  8: "AI_MODEL_VERSION",
  9: "DEVICE_GROUP",
};

/** SplitDimension.Value names (config.proto), shared with toc.pb's default targeting values. */
export const splitDimensionName = (value: number): string =>
  enumName(SPLIT_DIMENSIONS, value);

/** Counts fields of `message` whose numbers are not in `known`. */
export class Undecoded {
  count = 0;

  /** Returns `message` after counting its unknown fields. */
  note(message: ProtobufMessage, known: readonly number[]): ProtobufMessage {
    this.count += message.fields.filter(
      (field) => !known.includes(field.field),
    ).length;
    return message;
  }
}

const dimension = (
  message: ProtobufMessage,
  undecoded: Undecoded,
): BundleSplitDimension => {
  undecoded.note(message, [1, 2, 3]);
  const stripping = message.message(3);
  return {
    value: splitDimensionName(message.uint32(1)),
    negate: message.bool(2),
    suffix_stripping:
      stripping === null
        ? null
        : {
            enabled: undecoded.note(stripping, [1, 2]).bool(1),
            default_suffix: stripping.string(2),
          },
  };
};

const optional = <T>(
  message: ProtobufMessage | null,
  known: readonly number[],
  undecoded: Undecoded,
  read: (message: ProtobufMessage) => T,
): T | null => (message === null ? null : read(undecoded.note(message, known)));

/** Optimizations (config.proto). */
const optimizations = (
  message: ProtobufMessage,
  undecoded: Undecoded,
): NonNullable<BundleConfigFacts["optimizations"]> => ({
  split_dimensions:
    optional(message.message(1), [1], undecoded, (splits) =>
      splits.messages(1).map((entry) => dimension(entry, undecoded)),
    ) ?? [],
  uncompress_native_libraries: optional(
    message.message(2),
    [1, 2],
    undecoded,
    (native) => ({
      enabled: native.bool(1),
      alignment: enumName(
        [
          "PAGE_ALIGNMENT_UNSPECIFIED",
          "PAGE_ALIGNMENT_4K",
          "PAGE_ALIGNMENT_16K",
          "PAGE_ALIGNMENT_64K",
        ],
        native.uint32(2),
      ),
    }),
  ),
  uncompress_dex_files: optional(
    message.message(3),
    [1, 2],
    undecoded,
    (dex) => ({
      enabled: dex.bool(1),
      uncompressed_dex_target_sdk: enumName(
        { 0: "UNSPECIFIED", 1: "SDK_31", 3: "SDK_33" },
        dex.uint32(2),
      ),
    }),
  ),
  standalone_config: optional(
    message.message(4),
    [1, 2, 3, 4],
    undecoded,
    (standalone) => ({
      split_dimensions: standalone
        .messages(1)
        .map((entry) => dimension(entry, undecoded)),
      strip_64_bit_libraries: standalone.bool(2),
      dex_merging_strategy: enumName(
        ["MERGE_IF_NEEDED", "NEVER_MERGE"],
        standalone.uint32(3),
      ),
      feature_modules_mode: enumName(
        ["FUSED_FEATURE_MODULES", "SEPARATE_FEATURE_MODULES"],
        standalone.uint32(4),
      ),
    }),
  ),
  resource_optimizations: optional(
    message.message(5),
    [1, 2],
    undecoded,
    (resources) => {
      const collapsed = optional(
        resources.message(2),
        [1, 2, 3, 4],
        undecoded,
        (value) => value,
      );
      return {
        sparse_encoding: enumName(
          { 0: "UNSPECIFIED", 2: "VARIANT_FOR_SDK_32", 3: "DISABLED" },
          resources.uint32(1),
        ),
        collapse_resource_names: collapsed?.bool(1) ?? false,
        deduplicate_resource_entries: collapsed?.bool(3) ?? false,
        no_collapse_resources: (collapsed?.messages(2) ?? []).map(
          (entry) =>
            `${undecoded.note(entry, [1, 2]).string(1)}/${entry.string(2)}`,
        ),
        no_collapse_resource_types: collapsed?.strings(4) ?? [],
      };
    },
  ),
  store_archive: optional(message.message(6), [1], undecoded, (archive) =>
    archive.bool(1),
  ),
  inject_min_sdk: message.has(8)
    ? enumName(["UNSPECIFIED", "DISABLED", "ENABLED"], message.uint32(8))
    : message.bool(7)
      ? "ENABLED (deprecated inject_min_sdk)"
      : "UNSPECIFIED",
});

/** Read BundleConfig.pb. */
export const readBundleConfig = (bytes: Uint8Array): BundleConfigFacts => {
  const undecoded = new Undecoded();
  const config = undecoded.note(
    new ProtobufMessage(bytes),
    [1, 2, 3, 4, 6, 7, 8, 9],
  );
  const bundletool = optional(config.message(1), [2], undecoded, (tool) =>
    tool.string(2),
  );
  return {
    bundletool_version: bundletool === "" ? null : bundletool,
    bundle_type: enumName(["REGULAR", "APEX", "ASSET_ONLY"], config.uint32(8)),
    optimizations: optional(
      config.message(2),
      [1, 2, 3, 4, 5, 6, 7, 8],
      undecoded,
      (message) => optimizations(message, undecoded),
    ),
    compression: optional(
      config.message(3),
      [1, 2, 3],
      undecoded,
      (compression) => ({
        uncompressed_globs: compression.strings(1),
        install_time_asset_module_default_compression: enumName(
          ["UNSPECIFIED", "UNCOMPRESSED", "COMPRESSED"],
          compression.uint32(2),
        ),
        apk_compression_algorithm: enumName(
          ["DEFAULT_APK_COMPRESSION_ALGORITHM", "P7ZIP"],
          compression.uint32(3),
        ),
      }),
    ),
    master_resources: optional(
      config.message(4),
      [1, 2],
      undecoded,
      (master) => ({
        resource_ids: master
          .varints(1)
          .map((id) => Number(BigInt.asIntN(32, id))),
        resource_names: master.strings(2),
      }),
    ),
    asset_modules: optional(config.message(7), [1, 2], undecoded, (assets) => ({
      app_versions: assets
        .varints(1)
        .map((version) => String(BigInt.asIntN(64, version))),
      asset_version_tag: assets.string(2),
    })),
    unsigned_embedded_apks: config
      .messages(6)
      .map((entry) => undecoded.note(entry, [1]).string(1)),
    inject_locale_config: optional(
      config.message(9),
      [1],
      undecoded,
      (locales) => locales.bool(1),
    ),
    undecoded_field_count: undecoded.count,
  };
};
