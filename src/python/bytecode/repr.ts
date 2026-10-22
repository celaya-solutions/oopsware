import type { PyValue } from "./marshal.js";

/**
 * Python's repr() of marshal constants, so instruction arguments read as
 * `dis` prints them. Two differences are deliberate: a code object has no
 * memory address here (`<code object f, file "m.py", line 3>`), and sets keep
 * their stored order (a live set iterates in hash order, which can differ).
 * Which characters print as themselves comes from the producing release's
 * own str.isprintable ranges, recorded in its profile.
 */

/** Sorted [start, end) ranges; binary search. */
const inRanges = (
  ranges: readonly (readonly [number, number])[],
  point: number,
): boolean => {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const [start, end] = ranges[middle] ?? [0, 0];
    if (point < start) high = middle - 1;
    else if (point >= end) low = middle + 1;
    else return true;
  }
  return false;
};

export type Printable = readonly (readonly [number, number])[];

const hex = (value: number, width: number) =>
  value.toString(16).padStart(width, "0");

export const reprString = (
  printable: Printable,
  text: string,
  points: readonly number[] = Array.from(
    text,
    (char) => char.codePointAt(0) ?? 0,
  ),
): string => {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = quote;
  for (const point of points) {
    // A surrogate code point stays one unit, so it is tested alone.
    const char = String.fromCodePoint(point);
    if (char === quote || char === "\\") out += `\\${char}`;
    else if (char === "\t") out += "\\t";
    else if (char === "\n") out += "\\n";
    else if (char === "\r") out += "\\r";
    else if (point < 0x20 || point === 0x7f) out += `\\x${hex(point, 2)}`;
    else if (point < 0x7f) out += char;
    else if (!inRanges(printable, point))
      out +=
        point < 0x100
          ? `\\x${hex(point, 2)}`
          : point < 0x10000
            ? `\\u${hex(point, 4)}`
            : `\\U${hex(point, 8)}`;
    else out += char;
  }
  return out + quote;
};

export const reprBytes = (bytes: Uint8Array): string => {
  const hasSingle = bytes.includes(0x27);
  const quote = hasSingle && !bytes.includes(0x22) ? '"' : "'";
  let out = `b${quote}`;
  for (const byte of bytes) {
    if (byte === quote.charCodeAt(0) || byte === 0x5c)
      out += `\\${String.fromCharCode(byte)}`;
    else if (byte === 0x09) out += "\\t";
    else if (byte === 0x0a) out += "\\n";
    else if (byte === 0x0d) out += "\\r";
    else if (byte < 0x20 || byte >= 0x7f) out += `\\x${hex(byte, 2)}`;
    else out += String.fromCharCode(byte);
  }
  return out + quote;
};

/** float.__repr__: shortest round-trip digits, exponent form outside 1e-4 <= |x| < 1e16. */
export const reprFloat = (value: number): string => {
  if (Number.isNaN(value)) return "nan";
  if (!Number.isFinite(value)) return value < 0 ? "-inf" : "inf";
  if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0";
  const [mantissa = "", exponentText = "0"] = Math.abs(value)
    .toExponential()
    .split("e");
  const digits = mantissa.replace(".", "");
  const exponent = Number(exponentText);
  const sign = value < 0 ? "-" : "";
  // decpt is the position of the decimal point relative to the digits.
  const decpt = exponent + 1;
  if (decpt > -4 && decpt <= 16) {
    if (decpt <= 0) return `${sign}0.${"0".repeat(-decpt)}${digits}`;
    if (decpt >= digits.length)
      return `${sign}${digits}${"0".repeat(decpt - digits.length)}.0`;
    return `${sign}${digits.slice(0, decpt)}.${digits.slice(decpt)}`;
  }
  const head =
    digits.length === 1 ? digits : `${digits[0] ?? ""}.${digits.slice(1)}`;
  const magnitude = Math.abs(exponent);
  return `${sign}${head}e${exponent < 0 ? "-" : "+"}${magnitude < 10 ? "0" : ""}${String(magnitude)}`;
};

/** complex.__repr__: parts use repr() without a forced ".0"; a bare imaginary when real is +0. */
const reprComplexPart = (value: number): string => {
  const text = reprFloat(value);
  return text.endsWith(".0") ? text.slice(0, -2) : text;
};

export const reprComplex = (real: number, imag: number): string => {
  const imagText = reprComplexPart(imag);
  if (real === 0 && !Object.is(real, -0)) return `${imagText}j`;
  const sign = imagText.startsWith("-") || Number.isNaN(imag) ? "" : "+";
  // CPython prints a NaN imaginary part as "+nan".
  return `(${reprComplexPart(real)}${Number.isNaN(imag) ? "+" : sign}${imagText}j)`;
};

export const reprValue = (printable: Printable, value: PyValue): string => {
  const nested = (item: PyValue) => reprValue(printable, item);
  switch (value.t) {
    case "none":
      return "None";
    case "null":
      return "<NULL>";
    case "ellipsis":
      return "Ellipsis";
    case "stop-iteration":
      return "<class 'StopIteration'>";
    case "bool":
      return value.v ? "True" : "False";
    case "int":
      return value.v.toString();
    case "float":
      return reprFloat(value.v);
    case "complex":
      return reprComplex(value.real, value.imag);
    case "bytes":
      return reprBytes(value.v);
    case "str":
      return reprString(printable, value.v, value.points);
    case "tuple":
      return value.items.length === 1
        ? `(${nested(value.items[0] ?? { t: "none" })},)`
        : `(${value.items.map(nested).join(", ")})`;
    case "list":
      return `[${value.items.map(nested).join(", ")}]`;
    case "set":
      return value.items.length === 0
        ? "set()"
        : `{${value.items.map(nested).join(", ")}}`;
    case "frozenset":
      return value.items.length === 0
        ? "frozenset()"
        : `frozenset({${value.items.map(nested).join(", ")}})`;
    case "dict":
    case "frozendict": {
      const body = value.entries
        .map(([key, entry]) => `${nested(key)}: ${nested(entry)}`)
        .join(", ");
      return value.t === "dict" ? `{${body}}` : `frozendict({${body}})`;
    }
    case "slice":
      return `slice(${nested(value.start)}, ${nested(value.stop)}, ${nested(value.step)})`;
    case "code":
      return `<code object ${value.code.name}, file "${value.code.filename}", line ${String(value.code.firstlineno)}>`;
  }
};
