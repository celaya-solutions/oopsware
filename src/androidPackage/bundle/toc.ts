import { ProtobufMessage } from "../protobuf.js";
import { Undecoded, enumName, splitDimensionName } from "./bundleConfig.js";

/**
 * toc.pb of a bundletool APK set (.apks): commands.proto `BuildApksResult`
 * with targeting from targeting.proto. Enum values render by their proto
 * names ("ARM64_V8A", "XXHDPI", "ON_DEMAND"); fields this reader does not
 * decode are counted. Malformed protobuf throws ProtobufFormatError.
 */

/** One targeting dimension: the values an APK or variant serves and the alternatives it was split from. */
export interface ApksTargetingDimension {
  /** e.g. "sdk_version", "abi", "multi_abi", "screen_density", "language", "texture_compression_format", "device_feature". */
  readonly dimension: string;
  readonly values: readonly string[];
  readonly alternatives: readonly string[];
}

export interface ApksApkDescription {
  readonly path: string;
  /** Which `apk_metadata_oneof_value` member is set. */
  readonly kind:
    | "split"
    | "standalone"
    | "instant"
    | "system"
    | "asset_slice"
    | "apex"
    | "archived"
    | "unknown";
  readonly split_id: string | null;
  readonly is_master_split: boolean | null;
  /** Modules fused into a standalone or system APK. */
  readonly fused_modules: readonly string[];
  readonly targeting: readonly ApksTargetingDimension[];
  readonly signed_with_rotated_key: boolean;
}

export interface ApksModuleMetadata {
  readonly name: string;
  /** FeatureModuleType name, e.g. "FEATURE_MODULE". */
  readonly module_type: string;
  /** DeliveryType name, e.g. "INSTALL_TIME", "ON_DEMAND". */
  readonly delivery_type: string;
  readonly is_instant: boolean;
  readonly dependencies: readonly string[];
  readonly targeting: readonly ApksTargetingDimension[];
}

export interface ApksVariant {
  readonly variant_number: number;
  readonly targeting: readonly ApksTargetingDimension[];
  readonly properties: {
    readonly uncompressed_dex: boolean;
    readonly uncompressed_native_libraries: boolean;
    readonly sparse_encoding: boolean;
  } | null;
  readonly apk_sets: readonly {
    readonly module: ApksModuleMetadata;
    readonly apks: readonly ApksApkDescription[];
  }[];
}

export interface ApksAssetSliceSet {
  readonly module: {
    readonly name: string;
    readonly delivery_type: string;
    readonly is_instant: boolean;
    /** AssetModuleType name, e.g. "DEFAULT_ASSET_TYPE". */
    readonly asset_module_type: string;
    readonly targeting: readonly ApksTargetingDimension[];
  };
  readonly apks: readonly ApksApkDescription[];
}

export interface ApksToc {
  readonly bundletool_version: string | null;
  readonly package_name: string | null;
  readonly variants: readonly ApksVariant[];
  readonly asset_slice_sets: readonly ApksAssetSliceSet[];
  readonly local_testing: {
    readonly enabled: boolean;
    readonly local_testing_path: string;
  } | null;
  readonly default_targeting_values: readonly {
    readonly dimension: string;
    readonly default_value: string;
  }[];
  readonly permanently_fused_modules: readonly string[];
  /** Wire fields present that this reader does not decode. */
  readonly undecoded_field_count: number;
}

const ABIS = [
  "UNSPECIFIED_CPU_ARCHITECTURE",
  "ARMEABI",
  "ARMEABI_V7A",
  "ARM64_V8A",
  "X86",
  "X86_64",
  "MIPS",
  "MIPS64",
  "RISCV64",
];
const DENSITIES = [
  "DENSITY_UNSPECIFIED",
  "NODPI",
  "LDPI",
  "MDPI",
  "TVDPI",
  "HDPI",
  "XHDPI",
  "XXHDPI",
  "XXXHDPI",
];
const TEXTURES = [
  "UNSPECIFIED_TEXTURE_COMPRESSION_FORMAT",
  "ETC1_RGB8",
  "PALETTED",
  "THREE_DC",
  "ATC",
  "LATC",
  "DXT1",
  "S3TC",
  "PVRTC",
  "ASTC",
  "ETC2",
];
const DELIVERY = [
  "UNKNOWN_DELIVERY_TYPE",
  "INSTALL_TIME",
  "ON_DEMAND",
  "FAST_FOLLOW",
];
const MODULE_TYPES = [
  "UNKNOWN_MODULE_TYPE",
  "FEATURE_MODULE",
  "ML_MODULE",
  "SDK_MODULE",
];
const ASSET_TYPES = [
  "UNKNOWN_ASSET_TYPE",
  "DEFAULT_ASSET_TYPE",
  "AI_PACK_TYPE",
];

type Render = (message: ProtobufMessage, undecoded: Undecoded) => string;

const abi: Render = (message, undecoded) =>
  enumName(ABIS, undecoded.note(message, [1]).uint32(1));

/** google.protobuf.Int32Value: field 1. */
const int32Value: Render = (message, undecoded) =>
  String(undecoded.note(message, [1]).int32(1));

const RENDERERS: Readonly<Record<string, Render>> = {
  abi,
  multi_abi: (message, undecoded) =>
    undecoded
      .note(message, [1])
      .messages(1)
      .map((entry) => abi(entry, undecoded))
      .join("+"),
  screen_density: (message, undecoded) => {
    undecoded.note(message, [1, 2]);
    return message.has(2)
      ? `${String(message.int32(2))}dpi`
      : enumName(DENSITIES, message.uint32(1));
  },
  sdk_version: (message, undecoded) => {
    const min = undecoded.note(message, [1]).message(1);
    return min === null ? "" : int32Value(min, undecoded);
  },
  texture_compression_format: (message, undecoded) =>
    enumName(TEXTURES, undecoded.note(message, [1]).uint32(1)),
  sanitizer: (message, undecoded) =>
    enumName(["NONE", "HWADDRESS"], undecoded.note(message, [1]).uint32(1)),
  device_tier: int32Value,
};

/** A `*Targeting { repeated value = v; repeated alternatives = a }` message. */
const dimension = (
  name: string,
  message: ProtobufMessage,
  undecoded: Undecoded,
  fields: readonly [number, number] = [1, 2],
): ApksTargetingDimension => {
  undecoded.note(message, fields);
  const render = RENDERERS[name];
  const read = (field: number) =>
    render === undefined
      ? message.strings(field)
      : message.messages(field).map((entry) => render(entry, undecoded));
  return {
    dimension: name,
    values: read(fields[0]),
    alternatives: read(fields[1]),
  };
};

/** Field number → dimension name, per targeting message. */
const VARIANT_TARGETING: readonly [number, string][] = [
  [1, "sdk_version"],
  [2, "abi"],
  [3, "screen_density"],
  [4, "multi_abi"],
  [5, "texture_compression_format"],
];
const APK_TARGETING: readonly [number, string][] = [
  [1, "abi"],
  [3, "language"],
  [4, "screen_density"],
  [5, "sdk_version"],
  [6, "texture_compression_format"],
  [7, "multi_abi"],
  [8, "sanitizer"],
  [9, "device_tier"],
  [10, "country_set"],
  [11, "device_group"],
];

const targeting = (
  message: ProtobufMessage | null,
  layout: readonly [number, string][],
  undecoded: Undecoded,
  extra: readonly number[] = [],
): ApksTargetingDimension[] => {
  if (message === null) return [];
  undecoded.note(message, [...layout.map(([field]) => field), ...extra]);
  return layout.flatMap(([field, name]) => {
    const inner = message.message(field);
    if (inner === null) return [];
    // DeviceTierTargeting keeps value/alternatives in fields 3 and 4.
    return [
      dimension(
        name,
        inner,
        undecoded,
        name === "device_tier" ? [3, 4] : [1, 2],
      ),
    ];
  });
};

/** VariantTargeting (targeting.proto), including SdkRuntimeTargeting. */
const variantTargeting = (
  message: ProtobufMessage | null,
  undecoded: Undecoded,
): ApksTargetingDimension[] => {
  const found = targeting(message, VARIANT_TARGETING, undecoded, [6]);
  const runtime = message?.message(6) ?? null;
  if (runtime !== null && undecoded.note(runtime, [1]).bool(1))
    found.push({
      dimension: "sdk_runtime",
      values: ["REQUIRES_SDK_RUNTIME"],
      alternatives: [],
    });
  return found;
};

/** ModuleTargeting / AssetModuleTargeting: sdk version, device features, user countries, device groups. */
const moduleTargeting = (
  message: ProtobufMessage | null,
  undecoded: Undecoded,
  fields: {
    sdk?: number;
    features?: number;
    countries: number;
    groups: number;
  },
): ApksTargetingDimension[] => {
  if (message === null) return [];
  undecoded.note(
    message,
    [fields.sdk, fields.features, fields.countries, fields.groups].filter(
      (field): field is number => field !== undefined,
    ),
  );
  const found: ApksTargetingDimension[] = [];
  const sdk = fields.sdk === undefined ? null : message.message(fields.sdk);
  if (sdk !== null) found.push(dimension("sdk_version", sdk, undecoded));
  const features =
    fields.features === undefined ? [] : message.messages(fields.features);
  if (features.length > 0)
    found.push({
      dimension: "device_feature",
      values: features.map((feature) => {
        const required = undecoded.note(feature, [1]).message(1);
        if (required === null) return "";
        undecoded.note(required, [1, 2]);
        const version = required.int32(2);
        return `${required.string(1)}${version === 0 ? "" : ` version ${String(version)}`}`;
      }),
      alternatives: [],
    });
  const countries = message.message(fields.countries);
  if (countries !== null) {
    undecoded.note(countries, [1, 2]);
    found.push({
      dimension: countries.bool(2)
        ? "user_countries_excluded"
        : "user_countries",
      values: countries.strings(1),
      alternatives: [],
    });
  }
  const groups = message.message(fields.groups);
  if (groups !== null)
    found.push({
      dimension: "device_group",
      values: undecoded.note(groups, [1]).strings(1),
      alternatives: [],
    });
  return found;
};

const EMPTY = new ProtobufMessage(new Uint8Array(0));

/** apk_metadata_oneof_value members: field, kind, and the metadata fields read. */
const KINDS: readonly [
  number,
  ApksApkDescription["kind"],
  readonly number[],
][] = [
  [3, "split", [1, 2]],
  [4, "standalone", [1, 3]],
  [5, "instant", [1, 2]],
  [6, "system", [1]],
  [7, "asset_slice", [1, 2]],
  [8, "apex", []],
  [9, "archived", []],
];

/** ApkDescription (commands.proto). */
const apkDescription = (
  message: ProtobufMessage,
  undecoded: Undecoded,
): ApksApkDescription => {
  undecoded.note(message, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  // The last oneof member on the wire is the one that is set.
  const set = message.fields
    .filter((field) => field.field >= 3 && field.field <= 9)
    .at(-1);
  const [, kind, known] = KINDS.find(([field]) => field === set?.field) ?? [
    0,
    "unknown" as const,
    [],
  ];
  const metadata = undecoded.note(
    set === undefined ? EMPTY : (message.message(set.field) ?? EMPTY),
    known,
  );
  const split = known.includes(2);
  const fused = kind === "standalone" || kind === "system";
  const standaloneId = kind === "standalone" ? metadata.string(3) : "";
  const signing = message.message(10);
  return {
    path: message.string(2),
    kind,
    split_id: split
      ? metadata.string(1)
      : standaloneId === ""
        ? null
        : standaloneId,
    is_master_split: split ? metadata.bool(2) : null,
    fused_modules: fused ? metadata.strings(1) : [],
    targeting: targeting(message.message(1), APK_TARGETING, undecoded),
    signed_with_rotated_key:
      signing === null ? false : undecoded.note(signing, [1]).bool(1),
  };
};

/** ModuleMetadata (commands.proto). */
const moduleMetadata = (
  message: ProtobufMessage | null,
  undecoded: Undecoded,
): ApksModuleMetadata => {
  const module = undecoded.note(message ?? EMPTY, [1, 2, 3, 4, 5, 6, 7]);
  return {
    name: module.string(1),
    module_type: enumName(MODULE_TYPES, module.uint32(7)),
    delivery_type: module.has(6)
      ? enumName(DELIVERY, module.uint32(6))
      : module.bool(2)
        ? "ON_DEMAND (deprecated on_demand)"
        : enumName(DELIVERY, 0),
    is_instant: module.bool(3),
    dependencies: module.strings(4),
    targeting: moduleTargeting(module.message(5), undecoded, {
      sdk: 1,
      features: 2,
      countries: 3,
      groups: 5,
    }),
  };
};

const variant = (
  message: ProtobufMessage,
  undecoded: Undecoded,
): ApksVariant => {
  undecoded.note(message, [1, 2, 3, 4]);
  const properties = message.message(4);
  return {
    variant_number: message.uint32(3),
    targeting: variantTargeting(message.message(1), undecoded),
    properties:
      properties === null
        ? null
        : {
            uncompressed_dex: undecoded.note(properties, [1, 2, 3]).bool(1),
            uncompressed_native_libraries: properties.bool(2),
            sparse_encoding: properties.bool(3),
          },
    apk_sets: message.messages(2).map((set) => ({
      module: moduleMetadata(undecoded.note(set, [1, 2]).message(1), undecoded),
      apks: set.messages(2).map((apk) => apkDescription(apk, undecoded)),
    })),
  };
};

const assetSliceSet = (
  message: ProtobufMessage,
  undecoded: Undecoded,
): ApksAssetSliceSet => {
  undecoded.note(message, [1, 2]);
  const module = undecoded.note(
    message.message(1) ?? EMPTY,
    [1, 2, 3, 4, 5, 6],
  );
  const instant = module.message(3);
  return {
    module: {
      name: module.string(1),
      delivery_type: enumName(DELIVERY, module.uint32(4)),
      is_instant:
        instant === null ? false : undecoded.note(instant, [1, 2, 3]).bool(1),
      asset_module_type: enumName(ASSET_TYPES, module.uint32(5)),
      targeting: moduleTargeting(module.message(6), undecoded, {
        countries: 1,
        groups: 2,
      }),
    },
    apks: message.messages(2).map((apk) => apkDescription(apk, undecoded)),
  };
};

/** Read an APK set's toc.pb. */
export const readApksToc = (bytes: Uint8Array): ApksToc => {
  const undecoded = new Undecoded();
  const toc = undecoded.note(new ProtobufMessage(bytes), [1, 2, 3, 4, 5, 7, 8]);
  const bundletool = toc.message(2);
  const version =
    bundletool === null ? "" : undecoded.note(bundletool, [2]).string(2);
  const testing = toc.message(5);
  const packageName = toc.string(4);
  return {
    bundletool_version: version === "" ? null : version,
    package_name: packageName === "" ? null : packageName,
    variants: toc.messages(1).map((entry) => variant(entry, undecoded)),
    asset_slice_sets: toc
      .messages(3)
      .map((entry) => assetSliceSet(entry, undecoded)),
    local_testing:
      testing === null
        ? null
        : {
            enabled: undecoded.note(testing, [1, 2]).bool(1),
            local_testing_path: testing.string(2),
          },
    default_targeting_values: toc.messages(7).map((entry) => ({
      dimension: splitDimensionName(undecoded.note(entry, [1, 2]).uint32(1)),
      default_value: entry.string(2),
    })),
    permanently_fused_modules: toc
      .messages(8)
      .map((entry) => undecoded.note(entry, [1]).string(1)),
    undecoded_field_count: undecoded.count,
  };
};
