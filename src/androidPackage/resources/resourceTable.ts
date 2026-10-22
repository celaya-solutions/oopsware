import { ProtobufFormatError, ProtobufMessage } from "../protobuf.js";
import {
  hex8,
  isReference,
  resValue,
  RES_VALUE,
  type AndroidXmlProblem,
} from "../xml/androidXml.js";
import {
  CHUNK,
  NO_INDEX,
  ResStringPool,
  readChunk,
  u16,
  u32,
  type ResChunk,
} from "../xml/binaryXml.js";
import { protoItemValue } from "../xml/protoXml.js";

/**
 * Resource tables: binary resources.arsc (ResTable chunks, ResourceTypes.h)
 * and aapt2's proto resources.pb (Resources.proto `ResourceTable`). Configs
 * render as libandroidfw's ResTable_config::toString(), which is what
 * `aapt2 dump resources` prints; values render as aapt2's dump headline.
 */

export interface ResourceTableSummary {
  readonly encoding: "arsc" | "proto";
  readonly string_count: number | null;
  readonly packages: readonly {
    readonly id: number | null;
    readonly name: string;
    readonly types: readonly {
      readonly id: number | null;
      readonly name: string;
      readonly entry_count: number;
      readonly configs: readonly string[];
    }[];
  }[];
  readonly problems: readonly {
    readonly offset: number | null;
    readonly message: string;
  }[];
}

export interface ResolvedResource {
  readonly package: string;
  readonly type: string;
  readonly name: string;
  readonly values: readonly {
    readonly config: string;
    readonly text: string;
  }[];
}

export interface ResourceTable {
  readonly summary: ResourceTableSummary;
  resolve(id: number): ResolvedResource | null;
}

/** A resource table without a readable root, at an exact byte offset. */
export class ResourceTableFormatError extends Error {
  constructor(
    readonly offset: number,
    message: string,
  ) {
    super(message);
    this.name = "ResourceTableFormatError";
  }
}

// ---- ResTable_config ----

/** The ResTable_config fields toString() reads, with language and region unpacked. */
interface ConfigFields {
  mcc: number;
  mnc: number;
  language: string;
  region: string;
  script: string;
  scriptComputed: boolean;
  variant: string;
  numbering: string;
  orientation: number;
  touchscreen: number;
  density: number;
  keyboard: number;
  navigation: number;
  inputFlags: number;
  gender: number;
  screenWidth: number;
  screenHeight: number;
  sdkVersion: number;
  minorVersion: number;
  screenLayout: number;
  uiMode: number;
  smallestScreenWidthDp: number;
  screenWidthDp: number;
  screenHeightDp: number;
  screenLayout2: number;
  colorMode: number;
}

const emptyConfig = (): ConfigFields => ({
  mcc: 0,
  mnc: 0,
  language: "",
  region: "",
  script: "",
  scriptComputed: false,
  variant: "",
  numbering: "",
  orientation: 0,
  touchscreen: 0,
  density: 0,
  keyboard: 0,
  navigation: 0,
  inputFlags: 0,
  gender: 0,
  screenWidth: 0,
  screenHeight: 0,
  sdkVersion: 0,
  minorVersion: 0,
  screenLayout: 0,
  uiMode: 0,
  smallestScreenWidthDp: 0,
  screenWidthDp: 0,
  screenHeightDp: 0,
  screenLayout2: 0,
  colorMode: 0,
});

/** unpackLanguageOrRegion: two ASCII bytes, or three 5-bit letters when the high bit is set. */
const unpackCode = (first: number, second: number, base: number): string => {
  if ((first & 0x80) !== 0)
    return String.fromCharCode(
      (second & 0x1f) + base,
      ((second & 0xe0) >> 5) + ((first & 0x03) << 3) + base,
      ((first & 0x7c) >> 2) + base,
    );
  if (first === 0) return "";
  return second === 0
    ? String.fromCharCode(first)
    : String.fromCharCode(first, second);
};

const ascii = (bytes: Uint8Array, at: number, length: number): string => {
  let text = "";
  for (let index = 0; index < length; index += 1) {
    const code = bytes[at + index] ?? 0;
    if (code === 0) break;
    text += String.fromCharCode(code);
  }
  return text;
};

/** A binary ResTable_config of `size` bytes at `at`; fields beyond `size` read as zero. */
const binaryConfig = (
  source: Uint8Array,
  at: number,
  size: number,
): ConfigFields => {
  const bytes = new Uint8Array(64);
  bytes.set(source.subarray(at, at + Math.min(size, 64)));
  return {
    mcc: u16(bytes, 4),
    mnc: u16(bytes, 6),
    language: unpackCode(bytes[8] ?? 0, bytes[9] ?? 0, 0x61),
    region: unpackCode(bytes[10] ?? 0, bytes[11] ?? 0, 0x30),
    orientation: bytes[12] ?? 0,
    touchscreen: bytes[13] ?? 0,
    density: u16(bytes, 14),
    keyboard: bytes[16] ?? 0,
    navigation: bytes[17] ?? 0,
    inputFlags: bytes[18] ?? 0,
    gender: (bytes[19] ?? 0) & 0x3,
    screenWidth: u16(bytes, 20),
    screenHeight: u16(bytes, 22),
    sdkVersion: u16(bytes, 24),
    minorVersion: u16(bytes, 26),
    screenLayout: bytes[28] ?? 0,
    uiMode: bytes[29] ?? 0,
    smallestScreenWidthDp: u16(bytes, 30),
    screenWidthDp: u16(bytes, 32),
    screenHeightDp: u16(bytes, 34),
    script: ascii(bytes, 36, 4),
    variant: ascii(bytes, 40, 8),
    screenLayout2: bytes[48] ?? 0,
    colorMode: bytes[49] ?? 0,
    scriptComputed: (bytes[52] ?? 0) !== 0,
    numbering: ascii(bytes, 53, 8),
  };
};

const pick = (
  table: Readonly<Record<number, string>>,
  value: number,
  label: string,
): string => table[value] ?? `${label}=${String(value)}`;

const DENSITIES: Readonly<Record<number, string>> = {
  120: "ldpi",
  160: "mdpi",
  213: "tvdpi",
  240: "hdpi",
  320: "xhdpi",
  480: "xxhdpi",
  640: "xxxhdpi",
  0xfffe: "anydpi",
  0xffff: "nodpi",
};
const UI_MODE_TYPES: Readonly<Record<number, string>> = {
  2: "desk",
  3: "car",
  4: "television",
  5: "appliance",
  6: "watch",
  7: "vrheadset",
};

/** appendDirLocale: the legacy "es-rMX" form, or "b+" BCP 47 when script, variant or numbering is set. */
const localeText = (config: ConfigFields): string | null => {
  if (config.language === "") return null;
  const script =
    config.script !== "" && !config.scriptComputed ? config.script : "";
  if (script === "" && config.variant === "" && config.numbering === "")
    return config.region === ""
      ? config.language
      : `${config.language}-r${config.region}`;
  return [
    `b+${config.language}`,
    script,
    config.region,
    config.variant,
    config.numbering === "" ? "" : `u+nu+${config.numbering}`,
  ]
    .filter((part) => part !== "")
    .join("+");
};

const screenParts = (c: ConfigFields): (string | null)[] => [
  c.smallestScreenWidthDp === 0
    ? null
    : `sw${String(c.smallestScreenWidthDp)}dp`,
  c.screenWidthDp === 0 ? null : `w${String(c.screenWidthDp)}dp`,
  c.screenHeightDp === 0 ? null : `h${String(c.screenHeightDp)}dp`,
  (c.screenLayout & 0x0f) === 0
    ? null
    : pick(
        { 1: "small", 2: "normal", 3: "large", 4: "xlarge" },
        c.screenLayout & 0x0f,
        "screenLayoutSize",
      ),
  (c.screenLayout & 0x30) === 0
    ? null
    : pick(
        { 0x10: "notlong", 0x20: "long" },
        c.screenLayout & 0x30,
        "screenLayoutLong",
      ),
  (c.screenLayout2 & 0x03) === 0
    ? null
    : pick(
        { 1: "notround", 2: "round" },
        c.screenLayout2 & 0x03,
        "screenRound",
      ),
  (c.colorMode & 0x03) === 0
    ? null
    : pick(
        { 1: "nowidecg", 2: "widecg" },
        c.colorMode & 0x03,
        "wideColorGamut",
      ),
  (c.colorMode & 0x0c) === 0
    ? null
    : pick({ 4: "lowdr", 8: "highdr" }, c.colorMode & 0x0c, "hdr"),
  c.orientation === 0
    ? null
    : pick({ 1: "port", 2: "land", 3: "square" }, c.orientation, "orientation"),
  (c.uiMode & 0x0f) === 0
    ? null
    : pick(UI_MODE_TYPES, c.uiMode & 0x0f, "uiModeType"),
  (c.uiMode & 0x30) === 0
    ? null
    : pick({ 0x10: "notnight", 0x20: "night" }, c.uiMode & 0x30, "uiModeNight"),
];

const inputParts = (c: ConfigFields): (string | null)[] => [
  c.density === 0 ? null : (DENSITIES[c.density] ?? `${String(c.density)}dpi`),
  c.touchscreen === 0
    ? null
    : pick(
        { 1: "notouch", 2: "stylus", 3: "finger" },
        c.touchscreen,
        "touchscreen",
      ),
  { 1: "keysexposed", 2: "keyshidden", 3: "keyssoft" }[c.inputFlags & 0x03] ??
    null,
  c.keyboard === 0
    ? null
    : pick({ 1: "nokeys", 2: "qwerty", 3: "12key" }, c.keyboard, "keyboard"),
  (c.inputFlags & 0x0c) === 0
    ? null
    : pick(
        { 4: "navexposed", 8: "navhidden" },
        c.inputFlags & 0x0c,
        "inputFlagsNavHidden",
      ),
  c.navigation === 0
    ? null
    : pick(
        { 1: "nonav", 2: "dpad", 3: "trackball", 4: "wheel" },
        c.navigation,
        "navigation",
      ),
  c.screenWidth === 0 && c.screenHeight === 0
    ? null
    : `${String(c.screenWidth)}x${String(c.screenHeight)}`,
  c.sdkVersion === 0 && c.minorVersion === 0
    ? null
    : `v${String(c.sdkVersion)}${c.minorVersion === 0 ? "" : `.${String(c.minorVersion)}`}`,
];

/** ResTable_config::toString(): qualifiers joined by "-", "" for the default config. */
const configText = (c: ConfigFields): string =>
  [
    c.mcc === 0 ? null : `mcc${String(c.mcc)}`,
    c.mnc === 0 ? null : `mnc${String(c.mnc)}`,
    localeText(c),
    { 1: "neuter", 2: "feminine", 3: "masculine" }[c.gender] ?? null,
    (c.screenLayout & 0xc0) === 0
      ? null
      : pick(
          { 0x40: "ldltr", 0x80: "ldrtl" },
          c.screenLayout & 0xc0,
          "layoutDir",
        ),
    ...screenParts(c),
    ...inputParts(c),
  ]
    .filter((part): part is string => part !== null)
    .join("-");

/** LocaleValue::InitFromBcp47Tag, as aapt2 reads a proto Configuration's locale. */
const applyBcp47 = (config: ConfigFields, tag: string): void => {
  const [base = "", numbering = ""] = tag.toLowerCase().split("-u-nu-");
  const parts = base.split("-");
  const [language = "", second, third, fourth] = parts;
  config.language = language;
  config.numbering = numbering;
  const script = (value: string) =>
    `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
  if (parts.length === 2 && second !== undefined) {
    if (second.length <= 3) config.region = second.toUpperCase();
    else if (second.length === 4 && !/^\d/u.test(second))
      config.script = script(second);
    else config.variant = second;
  } else if (
    parts.length === 3 &&
    second !== undefined &&
    third !== undefined
  ) {
    if (second.length === 4) config.script = script(second);
    else config.region = second.toUpperCase();
    if (third.length >= 4) config.variant = third;
    else config.region = third.toUpperCase();
  } else if (parts.length === 4) {
    config.script = script(second ?? "");
    config.region = (third ?? "").toUpperCase();
    config.variant = fourth ?? "";
  }
};

/** Proto enum → ResTable_config bits, as aapt2's DeserializeConfig maps them. */
const PROTO_ENUMS: readonly [
  number,
  keyof ConfigFields,
  number,
  Readonly<Record<number, number>>,
][] = [
  [4, "screenLayout", 0xc0, { 1: 0x40, 2: 0x80 }],
  [10, "screenLayout", 0x0f, { 1: 1, 2: 2, 3: 3, 4: 4 }],
  [11, "screenLayout", 0x30, { 1: 0x20, 2: 0x10 }],
  [12, "screenLayout2", 0x03, { 1: 2, 2: 1 }],
  [13, "colorMode", 0x03, { 1: 2, 2: 1 }],
  [14, "colorMode", 0x0c, { 1: 8, 2: 4 }],
  [15, "orientation", 0xff, { 1: 1, 2: 2, 3: 3 }],
  [16, "uiMode", 0x0f, { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7 }],
  [17, "uiMode", 0x30, { 1: 0x20, 2: 0x10 }],
  [19, "touchscreen", 0xff, { 1: 1, 2: 2, 3: 3 }],
  [20, "inputFlags", 0x03, { 1: 1, 2: 2, 3: 3 }],
  [21, "keyboard", 0xff, { 1: 1, 2: 2, 3: 3 }],
  [22, "inputFlags", 0x0c, { 1: 4, 2: 8 }],
  [23, "navigation", 0xff, { 1: 1, 2: 2, 3: 3, 4: 4 }],
  // Field 26 (grammatical gender) is newer than bundletool's Configuration.proto; aapt2 37 writes it.
  [26, "gender", 0x03, { 1: 1, 2: 2, 3: 3 }],
];

/** A proto `Configuration` (Configuration.proto) as ResTable_config fields. */
const protoConfig = (message: ProtobufMessage): ConfigFields => {
  const config = emptyConfig();
  config.mcc = message.uint32(1);
  config.mnc = message.uint32(2);
  const locale = message.string(3);
  if (locale !== "") applyBcp47(config, locale);
  config.screenWidth = message.uint32(5);
  config.screenHeight = message.uint32(6);
  config.screenWidthDp = message.uint32(7);
  config.screenHeightDp = message.uint32(8);
  config.smallestScreenWidthDp = message.uint32(9);
  config.density = message.uint32(18);
  config.sdkVersion = message.uint32(24);
  for (const [field, key, mask, values] of PROTO_ENUMS) {
    const bits = values[message.uint32(field)];
    const current = config[key];
    if (bits !== undefined && typeof current === "number")
      Object.assign(config, { [key]: (current & ~mask) | bits });
  }
  return config;
};

// ---- Value rendering ----

const MASK_NAMES: readonly [number, string][] = [
  [0x01, "reference"],
  [0x02, "string"],
  [0x04, "integer"],
  [0x08, "boolean"],
  [0x10, "color"],
  [0x20, "float"],
  [0x40, "dimension"],
  [0x80, "fraction"],
  [0x10000, "enum"],
  [0x20000, "flags"],
];

/** Attribute::MaskString. */
const maskText = (mask: number): string =>
  mask === 0xffff
    ? "any"
    : MASK_NAMES.filter(([bit]) => (mask & bit) !== 0)
        .map(([, name]) => name)
        .join("|");

/** ResTable_map keys ATTR_TYPE..ATTR_L10N describe an attr; other keys are its symbols. */
const ATTR_TYPE = 0x01000000;
const ATTR_L10N = 0x01000003;

const attrText = (mask: number, symbols: number): string =>
  `(attr) type=${maskText(mask)}${symbols > 0 ? ` size=${String(symbols)}` : ""}`;

const styleText = (count: number, parent: string | null): string =>
  `(style) size=${String(count)}${parent === null ? "" : ` parent=${parent}`}`;

/** Text of an entry whose value is a bag, by its type's name (aapt2 BinaryResourceParser::ParseMapEntry). */
const bagText = (
  typeName: string,
  parent: number,
  map: readonly { readonly key: number; readonly data: number }[],
  name: (id: number) => string | null,
): string => {
  if (typeName === "style") {
    const known = parent === 0 ? null : name(parent);
    return styleText(
      map.length,
      parent === 0
        ? null
        : known === null
          ? hex8(parent)
          : `${known} (${hex8(parent)})`,
    );
  }
  if (typeName === "attr" || typeName === "^attr-private")
    return attrText(
      map.find((entry) => entry.key === ATTR_TYPE)?.data ?? 0,
      map.filter((entry) => entry.key < ATTR_TYPE || entry.key > ATTR_L10N)
        .length,
    );
  if (typeName === "array") return `(array) size=${String(map.length)}`;
  if (typeName === "plurals") return `(plurals) size=${String(map.length)}`;
  if (typeName === "id") return "(id)";
  return `(bag) size=${String(map.length)}`;
};

const fileType = (typeName: string, path: string): string => {
  if (typeName === "raw") return "";
  if (path.endsWith(".xml")) return " type=XML";
  return path.endsWith(".png") ? " type=PNG" : "";
};

// ---- Binary resources.arsc ----

interface TypeChunk {
  readonly config: string;
  /** Entry index → absolute offset of a validated ResTable_entry. */
  readonly entries: Map<number, number>;
}

interface ArscType {
  readonly id: number;
  readonly name: string;
  readonly chunks: TypeChunk[];
}

interface ArscPackage {
  readonly id: number;
  readonly name: string;
  readonly keys: ResStringPool | null;
  readonly types: Map<number, ArscType>;
}

class ArscReader {
  readonly problems: AndroidXmlProblem[] = [];
  readonly packages = new Map<number, ArscPackage>();
  strings: ResStringPool | null = null;

  constructor(readonly bytes: Uint8Array) {}

  problem(offset: number, message: string): void {
    this.problems.push({ offset, message });
  }

  /**
   * Chunks directly inside `parent` after its header. A chunk whose header
   * is readable but whose size runs past its parent (a cut file) is recorded,
   * clamped to what is present and yielded last, so the entries before the
   * cut stay readable.
   */
  *chunks(parent: ResChunk): Generator<ResChunk> {
    const end = parent.offset + parent.size;
    let at = parent.offset + parent.headerSize;
    while (at < end) {
      const chunk = readChunk(this.bytes, at, end);
      if (!("message" in chunk)) {
        yield chunk;
        at += chunk.size;
        continue;
      }
      this.problems.push(chunk);
      const headerSize = end - at >= 8 ? u16(this.bytes, at + 2) : 0;
      if (
        headerSize >= 8 &&
        headerSize <= end - at &&
        u32(this.bytes, at + 4) > end - at
      )
        yield {
          offset: at,
          type: u16(this.bytes, at),
          headerSize,
          size: end - at,
        };
      return;
    }
  }

  pool(chunk: ResChunk): ResStringPool | null {
    const pool = ResStringPool.read(this.bytes, chunk);
    if ("message" in pool) {
      this.problems.push(pool);
      return null;
    }
    return pool;
  }

  table(root: ResChunk): void {
    for (const chunk of this.chunks(root)) {
      if (chunk.type === CHUNK.stringPool && this.strings === null)
        this.strings = this.pool(chunk);
      else if (chunk.type === CHUNK.tablePackage) this.package(chunk);
      else
        this.problem(
          chunk.offset,
          `Table chunk type 0x${chunk.type.toString(16)} was skipped.`,
        );
    }
  }

  package(chunk: ResChunk): void {
    const bytes = this.bytes;
    const at = chunk.offset;
    if (chunk.headerSize < 284) {
      this.problem(
        at,
        `Package header of ${String(chunk.headerSize)} bytes is too small.`,
      );
      return;
    }
    const id = u32(bytes, at + 8);
    let name = "";
    for (let index = 0; index < 128; index += 1) {
      const code = u16(bytes, at + 12 + index * 2);
      if (code === 0) break;
      name += String.fromCharCode(code);
    }
    const typeStrings = u32(bytes, at + 268);
    const keyStrings = u32(bytes, at + 276);
    const typeIdOffset = chunk.headerSize >= 288 ? u32(bytes, at + 284) : 0;
    let types: ResStringPool | null = null;
    let keys: ResStringPool | null = null;
    const chunks: ResChunk[] = [];
    for (const child of this.chunks(chunk)) {
      if (child.type === CHUNK.stringPool && child.offset === at + typeStrings)
        types = this.pool(child);
      else if (
        child.type === CHUNK.stringPool &&
        child.offset === at + keyStrings
      )
        keys = this.pool(child);
      else chunks.push(child);
    }
    if (types === null)
      this.problem(
        at + 268,
        "Package has no readable type string pool; types are named by id.",
      );
    if (keys === null)
      this.problem(
        at + 276,
        "Package has no readable key string pool; entries have no names.",
      );
    if (this.packages.has(id))
      this.problem(
        at,
        `Package 0x${id.toString(16)} appears twice; the second was skipped.`,
      );
    const entry: ArscPackage = { id, name, keys, types: new Map() };
    if (!this.packages.has(id)) this.packages.set(id, entry);
    for (const child of chunks)
      this.packageChild(entry, child, types, typeIdOffset);
  }

  packageChild(
    owner: ArscPackage,
    chunk: ResChunk,
    types: ResStringPool | null,
    typeIdOffset: number,
  ): void {
    if (chunk.type !== CHUNK.tableTypeSpec && chunk.type !== CHUNK.tableType) {
      if (
        chunk.type < CHUNK.tableLibrary ||
        chunk.type > CHUNK.tableStagedAlias
      )
        this.problem(
          chunk.offset,
          `Package chunk type 0x${chunk.type.toString(16)} was skipped.`,
        );
      return;
    }
    const id = this.bytes[chunk.offset + 8] ?? 0;
    if (id === 0 || chunk.headerSize < 16) {
      this.problem(chunk.offset, `Type chunk declares type id ${String(id)}.`);
      return;
    }
    let type = owner.types.get(id);
    if (type === undefined) {
      type = {
        id,
        name: types?.get(id - 1 - typeIdOffset) ?? `type${String(id)}`,
        chunks: [],
      };
      owner.types.set(id, type);
    }
    if (chunk.type === CHUNK.tableType) {
      const parsed = this.typeChunk(chunk);
      if (parsed !== null) type.chunks.push(parsed);
    }
  }

  /** Entry offsets of one ResTable_type, honouring FLAG_SPARSE and FLAG_OFFSET16. */
  typeChunk(chunk: ResChunk): TypeChunk | null {
    const bytes = this.bytes;
    const at = chunk.offset;
    const flags = bytes[at + 9] ?? 0;
    const count = u32(bytes, at + 12);
    const entriesStart = u32(bytes, at + 16);
    const configSize = chunk.headerSize >= 24 ? u32(bytes, at + 20) : 0;
    if (configSize < 4 || 20 + configSize > chunk.headerSize) {
      this.problem(
        at + 20,
        `Config of ${String(configSize)} bytes does not fit a ${String(chunk.headerSize)}-byte type header.`,
      );
      return null;
    }
    // Sparse entries are (u16 index, u16 offset/4) pairs; FLAG_OFFSET16 offsets are u16 offset/4.
    const width = (flags & 0x01) === 0 && (flags & 0x02) !== 0 ? 2 : 4;
    if (
      entriesStart > chunk.size ||
      count > (entriesStart - chunk.headerSize) / width
    ) {
      this.problem(
        at + 12,
        `${String(count)} entry offsets do not fit before entries at ${String(entriesStart)}.`,
      );
      return null;
    }
    const entries = new Map<number, number>();
    for (let index = 0; index < count; index += 1) {
      const slot = at + chunk.headerSize + index * width;
      let entry = index;
      let offset: number;
      if ((flags & 0x01) !== 0) {
        entry = u16(bytes, slot);
        offset = u16(bytes, slot + 2) * 4;
      } else if ((flags & 0x02) !== 0) {
        const value = u16(bytes, slot);
        if (value === 0xffff) continue;
        offset = value * 4;
      } else {
        offset = u32(bytes, slot);
        if (offset === NO_INDEX) continue;
      }
      const absolute = at + entriesStart + offset;
      if (this.validEntry(absolute, at + chunk.size))
        entries.set(entry, absolute);
    }
    return {
      config: configText(binaryConfig(bytes, at + 20, configSize)),
      entries,
    };
  }

  validEntry(at: number, end: number): boolean {
    const bytes = this.bytes;
    if (at + 8 > end) {
      this.problem(at, "Entry header lies past its type chunk.");
      return false;
    }
    const flags = u16(bytes, at + 2);
    if ((flags & 0x08) !== 0) return true;
    const size = u16(bytes, at);
    if ((flags & 0x01) !== 0) {
      const count = size >= 16 ? u32(bytes, at + 12) : 0;
      if (size >= 16 && at + size <= end && count <= (end - at - size) / 12)
        return true;
    } else if (size >= 8 && at + size + 8 <= end) return true;
    this.problem(at, "Entry and its value do not fit in their type chunk.");
    return false;
  }

  /** "type/name" for a resource id in this table, else null. */
  name(id: number): string | null {
    const owner = this.packages.get(id >>> 24);
    const type = owner?.types.get((id >>> 16) & 0xff);
    if (owner === undefined || type === undefined) return null;
    for (const chunk of type.chunks) {
      const at = chunk.entries.get(id & 0xffff);
      if (at !== undefined) return `${type.name}/${this.key(owner, at) ?? ""}`;
    }
    return null;
  }

  key(owner: ArscPackage, at: number): string | null {
    const compact = (u16(this.bytes, at + 2) & 0x08) !== 0;
    return (
      owner.keys?.get(
        compact ? u16(this.bytes, at) : u32(this.bytes, at + 4),
      ) ?? null
    );
  }

  stringValue(typeName: string, index: number): string {
    const text = this.strings?.get(index) ?? null;
    if (text === null) return `(string #${String(index)} missing)`;
    const spans = this.strings?.spans(index) ?? [];
    if (spans.length > 0)
      return `(styled string) "${text}"${spans.map((span) => ` ${span.tag}:${String(span.first)},${String(span.last)}`).join("")}`;
    if (typeName !== "string" && text.startsWith("res/"))
      return `(file) ${text}${fileType(typeName, text)}`;
    return `"${text}"`;
  }

  referenceText(owner: ArscPackage, dataType: number, data: number): string {
    const known = data === 0 ? null : this.name(data);
    if (known === null) return resValue(dataType, data, () => null).text;
    const prefix =
      dataType === RES_VALUE.attribute ||
      dataType === RES_VALUE.dynamicAttribute
        ? "?"
        : "@";
    const other =
      data >>> 24 !== owner.id
        ? `${this.packages.get(data >>> 24)?.name ?? ""}:`
        : "";
    return `${prefix}${other}${known}`;
  }

  valueText(owner: ArscPackage, typeName: string, at: number): string {
    const bytes = this.bytes;
    const flags = u16(bytes, at + 2);
    if ((flags & 0x01) !== 0 && (flags & 0x08) === 0) {
      const start = at + u16(bytes, at);
      const map = Array.from({ length: u32(bytes, at + 12) }, (_, index) => ({
        key: u32(bytes, start + index * 12),
        data: u32(bytes, start + index * 12 + 8),
      }));
      return bagText(typeName, u32(bytes, at + 8), map, (id) => this.name(id));
    }
    const compact = (flags & 0x08) !== 0;
    const value = compact ? at : at + u16(bytes, at);
    const dataType = compact ? flags >>> 8 : (bytes[value + 3] ?? 0);
    const data = u32(bytes, value + 4);
    // aapt2 encodes plain id entries as a false boolean; only references are values.
    if (
      typeName === "id" &&
      dataType !== RES_VALUE.reference &&
      dataType !== RES_VALUE.dynamicReference
    )
      return "(id)";
    if (dataType === RES_VALUE.string) return this.stringValue(typeName, data);
    if (isReference(resValue(dataType, data, () => null)))
      return this.referenceText(owner, dataType, data);
    return resValue(dataType, data, () => null).text;
  }

  resolve(id: number): ResolvedResource | null {
    const owner = this.packages.get(id >>> 24);
    const type = owner?.types.get((id >>> 16) & 0xff);
    if (owner === undefined || type === undefined) return null;
    let name: string | null = null;
    const values: { config: string; text: string }[] = [];
    for (const chunk of type.chunks) {
      const at = chunk.entries.get(id & 0xffff);
      if (at === undefined) continue;
      name ??= this.key(owner, at);
      values.push({
        config: chunk.config,
        text: this.valueText(owner, type.name, at),
      });
    }
    return name === null && values.length === 0
      ? null
      : { package: owner.name, type: type.name, name: name ?? "", values };
  }
}

const unique = (values: readonly string[]): string[] => [...new Set(values)];

/** The RES_TABLE_TYPE root; a root that runs past the bytes is clamped and recorded. */
const tableRoot = (bytes: Uint8Array, reader: ArscReader): ResChunk => {
  if (bytes.length < 12)
    throw new ResourceTableFormatError(
      0,
      `Table needs a 12-byte header but has ${String(bytes.length)} bytes.`,
    );
  const type = u16(bytes, 0);
  const headerSize = u16(bytes, 2);
  const size = u32(bytes, 4);
  if (type !== CHUNK.table)
    throw new ResourceTableFormatError(
      0,
      `Chunk type 0x${type.toString(16)} is not a resource table.`,
    );
  if (headerSize < 12 || headerSize > size || headerSize > bytes.length)
    throw new ResourceTableFormatError(
      2,
      `Table header size ${String(headerSize)} does not fit its size ${String(size)}.`,
    );
  if (size > bytes.length) {
    reader.problem(
      4,
      `Table declares ${String(size)} bytes but only ${String(bytes.length)} are present.`,
    );
    return { offset: 0, type, headerSize, size: bytes.length };
  }
  if (size < bytes.length)
    reader.problem(
      size,
      `${String(bytes.length - size)} bytes follow the table and were not read.`,
    );
  return { offset: 0, type, headerSize, size };
};

/** Read a binary resources.arsc. A damaged chunk is recorded and skipped; an unreadable root throws. */
export const readArscTable = (bytes: Uint8Array): ResourceTable => {
  const reader = new ArscReader(bytes);
  reader.table(tableRoot(bytes, reader));
  const declared = u32(bytes, 8);
  if (declared !== reader.packages.size)
    reader.problem(
      8,
      `Table declares ${String(declared)} packages; ${String(reader.packages.size)} were read.`,
    );
  return {
    summary: {
      encoding: "arsc",
      string_count: reader.strings?.count ?? null,
      packages: [...reader.packages.values()].map((owner) => ({
        id: owner.id,
        name: owner.name,
        types: [...owner.types.values()].map((type) => ({
          id: type.id,
          name: type.name,
          entry_count: new Set(
            type.chunks.flatMap((chunk) => [...chunk.entries.keys()]),
          ).size,
          configs: unique(
            type.chunks
              .filter((chunk) => chunk.entries.size > 0)
              .map((chunk) => chunk.config),
          ),
        })),
      })),
      problems: reader.problems,
    },
    resolve: (id) => reader.resolve(id >>> 0),
  };
};

// ---- Proto resources.pb ----

/** Headline of a proto `CompoundValue` (Resources.proto). */
const compoundText = (compound: ProtobufMessage): string => {
  const attr = compound.message(1);
  if (attr !== null) return attrText(attr.uint32(1), attr.messages(4).length);
  const style = compound.message(2);
  if (style !== null) {
    const parent = style.message(1);
    const parentName = parent?.string(3) ?? "";
    const parentId = parent?.uint32(2) ?? 0;
    const text =
      parent === null
        ? null
        : parentName === ""
          ? parentId === 0
            ? "???"
            : hex8(parentId)
          : `${parent.bool(4) ? "*" : ""}${parentName}${parentId === 0 ? "" : ` (${hex8(parentId)})`}`;
    return styleText(style.messages(3).length, text);
  }
  // Styleable, Array and Plural keep their entries in field 1.
  for (const [field, label] of [
    [3, "styleable"],
    [4, "array"],
    [5, "plurals"],
  ] as const) {
    const message = compound.message(field);
    if (message !== null)
      return `(${label}) size=${String(message.messages(1).length)}`;
  }
  return compound.has(6) ? "(macro)" : "(compound)";
};

/** Headline of a proto `Value`. */
const protoValueText = (value: ProtobufMessage | null): string => {
  const item = value?.message(4) ?? null;
  if (item !== null) return protoItemValue(item).text;
  const compound = value?.message(5) ?? null;
  return compound === null ? "(empty)" : compoundText(compound);
};

const protoConfigText = (config: ProtobufMessage | null): string =>
  config === null ? "" : configText(protoConfig(config));

/** A ConfigValue resolved on demand; damage inside it reads as text, not a throw. */
const safeValue = (
  value: ProtobufMessage,
): { config: string; text: string } => {
  try {
    return {
      config: protoConfigText(value.message(1)),
      text: protoValueText(value.message(2)),
    };
  } catch (error) {
    if (!(error instanceof ProtobufFormatError)) throw error;
    return {
      config: "",
      text: `(unreadable value at byte ${String(error.offset)}: ${error.message})`,
    };
  }
};

interface ProtoEntry {
  readonly name: string;
  readonly values: readonly ProtobufMessage[];
}

/** Read an aapt2 proto resources.pb. Malformed protobuf throws ResourceTableFormatError. */
export const readProtoTable = (bytes: Uint8Array): ResourceTable => {
  try {
    const table = new ProtobufMessage(bytes);
    const index = new Map<
      number,
      { package: string; type: string; entry: ProtoEntry }
    >();
    const problems: AndroidXmlProblem[] = [];
    const packages = table.messages(2).map((owner) => {
      const packageId = owner.message(1)?.uint32(1) ?? null;
      const packageName = owner.string(2);
      return {
        id: packageId,
        name: packageName,
        types: owner.messages(3).map((type) => {
          const typeId = type.message(1)?.uint32(1) ?? null;
          const typeName = type.string(2);
          const entries = type.messages(3);
          const configs: string[] = [];
          for (const entry of entries) {
            const values = entry.messages(6);
            for (const value of values)
              configs.push(protoConfigText(value.message(1)));
            const entryId = entry.message(1)?.uint32(1) ?? null;
            if (packageId === null || typeId === null || entryId === null)
              continue;
            if (packageId > 0xff || typeId > 0xff || entryId > 0xffff) {
              problems.push({
                offset: entry.offset,
                message: `Entry ids ${String(packageId)}/${String(typeId)}/${String(entryId)} do not form a resource id.`,
              });
              continue;
            }
            const id = ((packageId << 24) | (typeId << 16) | entryId) >>> 0;
            if (index.has(id))
              problems.push({
                offset: entry.offset,
                message: `Resource ${hex8(id)} appears twice; the first is kept.`,
              });
            else
              index.set(id, {
                package: packageName,
                type: typeName,
                entry: { name: entry.string(2), values },
              });
          }
          return {
            id: typeId,
            name: typeName,
            entry_count: entries.length,
            configs: unique(configs),
          };
        }),
      };
    });
    return {
      summary: { encoding: "proto", string_count: null, packages, problems },
      resolve: (id) => {
        const found = index.get(id >>> 0);
        if (found === undefined) return null;
        return {
          package: found.package,
          type: found.type,
          name: found.entry.name,
          values: found.entry.values.map(safeValue),
        };
      },
    };
  } catch (error) {
    if (error instanceof ProtobufFormatError)
      throw new ResourceTableFormatError(error.offset, error.message);
    throw error;
  }
};
