/**
 * Shared tree for compiled Android XML (binary ResXMLTree and aapt2's proto
 * XmlNode) plus Res_value rendering as `aapt2 dump` prints it. Nothing here
 * resolves resources or infers platform defaults.
 */

export interface AndroidXmlValue {
  /** Res_value type as aapt2 names it: "reference", "attribute", "string", "float", "dimension", "fraction", "dynamic-reference", "dynamic-attribute", "int-dec", "int-hex", "boolean", "color-argb8", "color-rgb8", "color-argb4", "color-rgb4", "null", or "unknown-0xNN". */
  readonly type: string;
  /** Raw 32-bit data; null for proto string items. */
  readonly data: number | null;
  /** aapt2-style rendering of the value. */
  readonly text: string;
}

export interface AndroidXmlAttribute {
  readonly namespace: string | null;
  readonly name: string;
  readonly resource_id: number | null;
  readonly raw: string | null;
  readonly value: AndroidXmlValue | null;
}

export interface AndroidXmlElement {
  readonly kind: "element";
  readonly namespace: string | null;
  readonly name: string;
  readonly line: number | null;
  readonly namespaces: readonly {
    readonly prefix: string;
    readonly uri: string;
  }[];
  readonly attributes: readonly AndroidXmlAttribute[];
  readonly children: readonly AndroidXmlNode[];
}

export interface AndroidXmlText {
  readonly kind: "text";
  readonly text: string;
  readonly line: number | null;
}

export type AndroidXmlNode = AndroidXmlElement | AndroidXmlText;

export interface AndroidXmlProblem {
  readonly offset: number | null;
  readonly message: string;
}

export interface AndroidXmlDocument {
  readonly encoding: "binary-xml" | "proto-xml";
  readonly root: AndroidXmlElement;
  readonly node_count: number;
  readonly problems: readonly AndroidXmlProblem[];
}

/** A compiled XML document that has no readable root, at an exact byte offset. */
export class AndroidXmlFormatError extends Error {
  constructor(
    readonly offset: number,
    message: string,
  ) {
    super(message);
    this.name = "AndroidXmlFormatError";
  }
}

/** Elements plus text nodes one document may hold before decoding stops. */
export const MAX_XML_NODES = 200_000;
/** Element nesting one document may reach before decoding stops. */
export const MAX_XML_DEPTH = 256;

export const ANDROID_NAMESPACE = "http://schemas.android.com/apk/res/android";
export const DISTRIBUTION_NAMESPACE =
  "http://schemas.android.com/apk/distribution";

const TYPE_NAMES: Readonly<Record<number, string>> = {
  0x00: "null",
  0x01: "reference",
  0x02: "attribute",
  0x03: "string",
  0x04: "float",
  0x05: "dimension",
  0x06: "fraction",
  0x07: "dynamic-reference",
  0x08: "dynamic-attribute",
  0x10: "int-dec",
  0x11: "int-hex",
  0x12: "boolean",
  0x1c: "color-argb8",
  0x1d: "color-rgb8",
  0x1e: "color-argb4",
  0x1f: "color-rgb4",
};

/** Res_value data types this module renders (ResourceTypes.h). */
export const RES_VALUE = {
  null: 0x00,
  reference: 0x01,
  attribute: 0x02,
  string: 0x03,
  float: 0x04,
  dimension: 0x05,
  fraction: 0x06,
  dynamicReference: 0x07,
  dynamicAttribute: 0x08,
  intDec: 0x10,
  intHex: 0x11,
  boolean: 0x12,
} as const;

export const hex8 = (value: number): string =>
  `0x${(value >>> 0).toString(16).padStart(8, "0")}`;

/** The aapt2 name of a Res_value data type. */
export const resValueTypeName = (dataType: number): string =>
  TYPE_NAMES[dataType] ?? `unknown-0x${dataType.toString(16).padStart(2, "0")}`;

// ---- C printf formatting of a double, exact with round-half-even ties ----

/** The exact value of a finite double as digits × 10^-scale. */
const exactDecimal = (value: number): { digits: bigint; scale: number } => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(value));
  const high = view.getUint32(0);
  const low = view.getUint32(4);
  const biased = (high >>> 20) & 0x7ff;
  let mantissa = (BigInt(high & 0xfffff) << 32n) | BigInt(low);
  if (biased !== 0) mantissa |= 1n << 52n;
  const exponent = (biased === 0 ? 1 : biased) - 1075;
  if (exponent >= 0) return { digits: mantissa << BigInt(exponent), scale: 0 };
  return { digits: mantissa * 5n ** BigInt(-exponent), scale: -exponent };
};

const roundHalfEven = (digits: bigint, drop: number): bigint => {
  if (drop <= 0) return digits * 10n ** BigInt(-drop);
  const unit = 10n ** BigInt(drop);
  const quotient = digits / unit;
  const twice = (digits % unit) * 2n;
  if (twice > unit || (twice === unit && quotient % 2n === 1n))
    return quotient + 1n;
  return quotient;
};

const signOf = (value: number): string =>
  value < 0 || Object.is(value, -0) ? "-" : "";

const nonFinite = (value: number): string | null =>
  Number.isNaN(value)
    ? "nan"
    : Number.isFinite(value)
      ? null
      : `${signOf(value)}inf`;

/** C `%.<precision>f`. */
export const printfF = (value: number, precision: number): string => {
  const special = nonFinite(value);
  if (special !== null) return special;
  const { digits, scale } = exactDecimal(value);
  const text = roundHalfEven(digits, scale - precision)
    .toString()
    .padStart(precision + 1, "0");
  const whole = text.slice(0, text.length - precision);
  return `${signOf(value)}${precision === 0 ? whole : `${whole}.${text.slice(whole.length)}`}`;
};

const exponentParts = (
  value: number,
  precision: number,
): { mantissa: string; exponent: number } => {
  if (value === 0) return { mantissa: "0".repeat(precision + 1), exponent: 0 };
  const { digits, scale } = exactDecimal(value);
  const length = digits.toString().length;
  let exponent = length - 1 - scale;
  let rounded = roundHalfEven(digits, length - (precision + 1)).toString();
  if (rounded.length > precision + 1) {
    rounded = rounded.slice(0, precision + 1);
    exponent += 1;
  }
  return { mantissa: rounded, exponent };
};

const exponentText = (mantissa: string, exponent: number): string =>
  `${mantissa}e${exponent < 0 ? "-" : "+"}${String(Math.abs(exponent)).padStart(2, "0")}`;

/** C `%.<precision>e`. */
export const printfE = (value: number, precision: number): string => {
  const special = nonFinite(value);
  if (special !== null) return special;
  const { mantissa, exponent } = exponentParts(value, precision);
  const point =
    precision === 0 ? mantissa : `${mantissa[0] ?? "0"}.${mantissa.slice(1)}`;
  return `${signOf(value)}${exponentText(point, exponent)}`;
};

const trimZeros = (text: string): string =>
  text.includes(".") ? text.replace(/\.?0+$/u, "") : text;

/** C `%g` (precision 6). */
export const printfG = (value: number, precision = 6): string => {
  const special = nonFinite(value);
  if (special !== null) return special;
  const digits = precision === 0 ? 1 : precision;
  const { exponent } = exponentParts(value, digits - 1);
  if (exponent >= -4 && exponent < digits)
    return trimZeros(printfF(value, digits - 1 - exponent));
  const [mantissa = "", power = ""] = printfE(value, digits - 1).split("e");
  return `${trimZeros(mantissa)}e${power}`;
};

// ---- Res_value rendering ----

const float32 = (bits: number): number => {
  const view = new DataView(new ArrayBuffer(4));
  view.setUint32(0, bits >>> 0);
  return view.getFloat32(0);
};

/**
 * A float as aapt2 37 prints it: "%.0f" for normal whole numbers within
 * int64, "%g" for other normal numbers and "%e" for zero, subnormals and
 * whole numbers beyond int64 (observed against `aapt2 dump resources`).
 */
export const renderFloat = (bits: number): string => {
  const value = float32(bits);
  if (!Number.isFinite(value) || value === 0 || Math.abs(value) < 2 ** -126)
    return printfE(value, 6);
  if (Number.isInteger(value))
    return value >= -(2 ** 63) && value < 2 ** 63
      ? printfF(value, 0)
      : printfE(value, 6);
  return printfG(value);
};

const RADIX_SHIFTS = [23, 16, 8, 0] as const;
const DIMENSION_UNITS = ["px", "dp", "sp", "pt", "in", "mm"] as const;
const FRACTION_UNITS = ["%", "%p"] as const;

/**
 * A complex (dimension or fraction) value with its signed 24-bit mantissa,
 * as the Android runtime reads it. aapt2's dump treats the mantissa as
 * unsigned, so it prints negative values as large positive ones.
 */
export const renderComplex = (data: number, fraction: boolean): string => {
  const mantissa = (data | 0) >> 8;
  const shift = RADIX_SHIFTS[(data >>> 4) & 0x3] ?? 23;
  const value = mantissa * 2 ** (shift - 23);
  const unit = data & 0xf;
  const suffix = fraction ? FRACTION_UNITS[unit] : DIMENSION_UNITS[unit];
  return `${printfF(value, 6)}${suffix ?? " (unknown unit)"}`;
};

const REFERENCE_TYPES: ReadonlySet<number> = new Set([
  RES_VALUE.reference,
  RES_VALUE.attribute,
  RES_VALUE.dynamicReference,
  RES_VALUE.dynamicAttribute,
]);

const colorText = (data: number): string =>
  `#${(data >>> 0).toString(16).padStart(8, "0")}`;

const referenceText = (dataType: number, data: number): string => {
  if (data === 0) return "@null";
  const attribute =
    dataType === RES_VALUE.attribute || dataType === RES_VALUE.dynamicAttribute;
  return `${attribute ? "?" : "@"}${hex8(data)}`;
};

const primitiveText = (dataType: number, data: number): string => {
  switch (dataType) {
    case RES_VALUE.null:
      return data === 1 ? "@empty" : "@null";
    case RES_VALUE.float:
      return renderFloat(data);
    case RES_VALUE.dimension:
      return renderComplex(data, false);
    case RES_VALUE.fraction:
      return renderComplex(data, true);
    case RES_VALUE.intDec:
      return String(data | 0);
    case RES_VALUE.intHex:
      return hex8(data);
    case RES_VALUE.boolean:
      return data === 0 ? "false" : "true";
    default:
      if (dataType >= 0x1c && dataType <= 0x1f) return colorText(data);
      return `(unknown 0x${dataType.toString(16).padStart(2, "0")}) ${hex8(data)}`;
  }
};

/**
 * One Res_value rendered as aapt2 prints it. `string` returns the pool string
 * for a TYPE_STRING index (null when the index does not resolve).
 */
export const resValue = (
  dataType: number,
  rawData: number,
  string: (index: number) => string | null,
): AndroidXmlValue => {
  const data = rawData >>> 0;
  const type = resValueTypeName(dataType);
  if (dataType === RES_VALUE.string) {
    const text = string(data);
    return {
      type,
      data,
      text: text === null ? `(string #${String(data)} missing)` : `"${text}"`,
    };
  }
  if (REFERENCE_TYPES.has(dataType))
    return { type, data, text: referenceText(dataType, data) };
  return { type, data, text: primitiveText(dataType, data) };
};

/** Whether a value names another resource or theme attribute by id. */
export const isReference = (value: AndroidXmlValue | null): boolean =>
  value !== null &&
  (value.type === "reference" ||
    value.type === "attribute" ||
    value.type === "dynamic-reference" ||
    value.type === "dynamic-attribute");

/**
 * The attribute's literal text: the raw value, else the unquoted string
 * value, else null (typed primitives and references have no literal text).
 */
export const attributeText = (
  attribute: AndroidXmlAttribute,
): string | null => {
  if (attribute.raw !== null) return attribute.raw;
  const value = attribute.value;
  if (value?.type === "string" && value.text.startsWith('"'))
    return value.text.slice(1, -1);
  return null;
};
