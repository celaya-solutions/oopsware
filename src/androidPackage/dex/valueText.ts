import type { DexFile, DexValue } from "./dexFile.js";

/**
 * Text of DEX values as dexdump prints them: `%g` numbers, its string
 * escaping, and encoded values for static field `value :` lines and `-a`
 * annotations.
 */

/** Characters dexdump writes as a backslash escape (its `kEscapedLength` == 2). */
const SHORT_ESCAPES: Readonly<Record<number, string>> = {
  0x08: "\\b",
  0x09: "\\t",
  0x0a: "\\n",
  0x0c: "\\f",
  0x0d: "\\r",
  0x22: '\\"',
  0x5c: "\\\\",
};

/**
 * A string as dexdump quotes it (`needsEscape`/`escapeString`): the escapes
 * above, other C0 controls and DEL as three octal digits, everything else
 * (including U+0000, which MUTF-8 stores as C0 80) unchanged. The table works
 * on MUTF-8 bytes, where every byte of a non-ASCII character is >= 0x80 and
 * passes through, so mapping UTF-16 units is equivalent.
 */
export const escapeDexString = (value: string): string => {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0x20 && unit < 0x7f && unit !== 0x22 && unit !== 0x5c)
      result += value[index] ?? "";
    else if (unit === 0 || unit >= 0x80) result += value[index] ?? "";
    else
      result += SHORT_ESCAPES[unit] ?? `\\${unit.toString(8).padStart(3, "0")}`;
  }
  return result;
};

const FIVE = new Map<number, bigint>();
const powerOfFive = (exponent: number): bigint => {
  let value = FIVE.get(exponent);
  if (value === undefined) {
    value = 5n ** BigInt(exponent);
    FIVE.set(exponent, value);
  }
  return value;
};

/** The exact decimal digits of a positive finite double and the power of ten of the last digit. */
const exactDecimal = (
  value: number,
): { readonly digits: string; readonly scale: number } => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const biased = Number((bits >> 52n) & 0x7ffn);
  let mantissa = bits & ((1n << 52n) - 1n);
  let exponent = -1074;
  if (biased !== 0) {
    mantissa |= 1n << 52n;
    exponent = biased - 1075;
  }
  // mantissa * 2^e == mantissa * 5^-e * 10^e for negative e.
  return exponent >= 0
    ? { digits: (mantissa << BigInt(exponent)).toString(), scale: 0 }
    : {
        digits: (mantissa * powerOfFive(-exponent)).toString(),
        scale: exponent,
      };
};

const trimFraction = (text: string): string =>
  text.includes(".") ? text.replace(/0+$/u, "").replace(/\.$/u, "") : text;

/**
 * C `printf("%g")` (precision 6) of a double, rounding the exact binary
 * value half to even as Apple's and glibc's printf do. NaN prints as "nan"
 * whatever its sign, as on macOS where build-tools' dexdump runs.
 */
export const printfG = (value: number): string => {
  if (Number.isNaN(value)) return "nan";
  if (!Number.isFinite(value)) return value < 0 ? "-inf" : "inf";
  if (value === 0) return Object.is(value, -0) ? "-0" : "0";
  const { digits: all, scale } = exactDecimal(Math.abs(value));
  let exponent = all.length - 1 + scale;
  let digits = all.slice(0, 6).padEnd(6, "0");
  const rest = all.slice(6);
  const first = rest.charCodeAt(0) - 0x30;
  const tie = first === 5 && !/[1-9]/u.test(rest.slice(1));
  const odd = (digits.charCodeAt(5) - 0x30) % 2 === 1;
  if (first > 5 || (first === 5 && (!tie || odd))) {
    digits = (BigInt(digits) + 1n).toString();
    if (digits.length > 6) {
      digits = digits.slice(0, 6);
      exponent += 1;
    }
  }
  let body: string;
  if (exponent < -4 || exponent >= 6)
    body = `${trimFraction(`${digits[0] ?? ""}.${digits.slice(1)}`)}e${exponent < 0 ? "-" : "+"}${String(Math.abs(exponent)).padStart(2, "0")}`;
  else if (exponent >= 0)
    body = trimFraction(
      `${digits.slice(0, exponent + 1)}.${digits.slice(exponent + 1)}`,
    );
  else body = trimFraction(`0.${"0".repeat(-exponent - 1)}${digits}`);
  return value < 0 ? `-${body}` : body;
};

/** A quoted string literal as dexdump prints one. */
export const quotedDexString = (value: string): string =>
  `"${escapeDexString(value)}"`;

/** Numbers, null and booleans as dexdump prints them (byte/short/int sign-extended, char unsigned). */
const scalarText = (value: DexValue): string | null => {
  switch (value.kind) {
    case "byte":
      return String((value.value << 24) >> 24);
    case "short":
      return String((value.value << 16) >> 16);
    case "char":
      return String(value.value & 0xffff);
    case "int":
      return String(value.value | 0);
    case "long":
      return BigInt.asIntN(64, value.value).toString();
    case "float":
    case "double":
      return printfG(value.value);
    case "null":
      return "null";
    case "boolean":
      return value.value ? "true" : "false";
    default:
      return null;
  }
};

/** Index-valued kinds: fields, enums and methods print only their name. */
const indexedText = (
  value: Extract<DexValue, { readonly index: number }>,
  dex: DexFile,
): string => {
  switch (value.kind) {
    case "method_type":
      return dex.protoDescriptor(value.index) ?? "<proto?>";
    case "method_handle":
      return `method_handle@${String(value.index)}`;
    case "string": {
      const text = dex.string(value.index);
      return text === null ? "<string?>" : quotedDexString(text);
    }
    case "type":
      return dex.type(value.index) ?? "<type?>";
    case "field":
    case "enum": {
      const field = dex.field(value.index);
      return field === null ? "<field?>" : (field.name ?? "?");
    }
    case "method": {
      const method = dex.method(value.index);
      return method === null ? "<method?>" : (method.name ?? "?");
    }
  }
};

/**
 * One encoded value as dexdump's `dumpEncodedValue` prints it. Indices that
 * dexdump's verifier would refuse render as `<string?>`-style placeholders.
 */
export const dexValueText = (value: DexValue, dex: DexFile): string => {
  if ("index" in value) return indexedText(value, dex);
  if (value.kind === "array")
    return `{${value.values.map((entry) => ` ${dexValueText(entry, dex)}`).join("")} }`;
  if (value.kind === "annotation")
    return `${dex.type(value.annotation.type_idx) ?? "<type?>"}${value.annotation.elements
      .map(
        (element) =>
          ` ${dex.string(element.name_idx) ?? "<string?>"}=${dexValueText(element.value, dex)}`,
      )
      .join("")}`;
  return scalarText(value) ?? "????";
};
