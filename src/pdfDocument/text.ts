import type { PdfString } from "./syntax.js";

/** PDFDocEncoding differs from Latin-1 at 0x18-0x1F and 0x80-0xA0 (ISO 32000-1 annex D). */
const PDF_DOC_HIGH = [
  "•",
  "†",
  "‡",
  "…",
  "—",
  "–",
  "ƒ",
  "⁄",
  "‹",
  "›",
  "−",
  "‰",
  "„",
  "“",
  "”",
  "‘",
  "’",
  "‚",
  "™",
  "ﬁ",
  "ﬂ",
  "Ł",
  "Œ",
  "Š",
  "Ÿ",
  "Ž",
  "ı",
  "ł",
  "œ",
  "š",
  "ž",
  "�",
  "€",
];
const PDF_DOC_LOW = ["˘", "ˇ", "ˆ", "˙", "˝", "˛", "˚", "˜"];

/** A PDF text string: UTF-16 with a byte order mark, UTF-8 with a mark, or PDFDocEncoding. */
export const textString = (value: PdfString): string => {
  const { bytes } = value;
  if (bytes[0] === 0xfe && bytes[1] === 0xff)
    return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  if (bytes[0] === 0xff && bytes[1] === 0xfe)
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  let out = "";
  for (const code of bytes) {
    if (code >= 0x18 && code <= 0x1f) out += PDF_DOC_LOW[code - 0x18];
    else if (code >= 0x80 && code <= 0xa0)
      out += PDF_DOC_HIGH[code - 0x80] ?? "�";
    else out += String.fromCharCode(code);
  }
  return out;
};

/** Control characters other than tab and line breaks cannot be shown; they are replaced, never dropped silently. */
export const printable = (text: string): string =>
  // eslint-disable-next-line no-control-regex
  text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "�");

export const clip = (
  text: string,
  limit: number,
): { text: string; truncated: boolean } =>
  text.length > limit
    ? { text: `${text.slice(0, limit)}…`, truncated: true }
    : { text, truncated: false };
