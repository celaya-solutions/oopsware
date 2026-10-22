/**
 * Windows code pages named by legacy Office files, as WHATWG labels. A code
 * page this table does not name is not guessed: `decodeCodepage` returns null
 * and the caller decides what to report.
 */
const LABELS: ReadonlyMap<number, string> = new Map([
  [874, "windows-874"],
  [932, "shift_jis"],
  [936, "gbk"],
  [949, "euc-kr"],
  [950, "big5"],
  [1200, "utf-16le"],
  [1250, "windows-1250"],
  [1251, "windows-1251"],
  [1252, "windows-1252"],
  [1253, "windows-1253"],
  [1254, "windows-1254"],
  [1255, "windows-1255"],
  [1256, "windows-1256"],
  [1257, "windows-1257"],
  [1258, "windows-1258"],
  [10000, "macintosh"],
  [10002, "big5"],
  [10003, "euc-kr"],
  [10007, "x-mac-cyrillic"],
  [10008, "gb18030"],
  [20866, "koi8-r"],
  [21866, "koi8-u"],
  [20932, "euc-jp"],
  [51932, "euc-jp"],
  [20936, "gbk"],
  [51936, "gbk"],
  [50220, "iso-2022-jp"],
  [50221, "iso-2022-jp"],
  [50222, "iso-2022-jp"],
  [28593, "iso-8859-3"],
  [28594, "iso-8859-4"],
  [28596, "iso-8859-6"],
  [28598, "iso-8859-8"],
  [28603, "iso-8859-13"],
  [28605, "iso-8859-15"],
  [20127, "windows-1252"],
  [28591, "iso-8859-1"],
  [28592, "iso-8859-2"],
  [28595, "iso-8859-5"],
  [28597, "iso-8859-7"],
  [28599, "iso-8859-9"],
  [65001, "utf-8"],
]);

const decoders = new Map<number, TextDecoder | null>();

const decoderFor = (codepage: number): TextDecoder | null => {
  if (decoders.has(codepage)) return decoders.get(codepage) ?? null;
  const label = LABELS.get(codepage);
  let decoder: TextDecoder | null = null;
  if (label !== undefined) {
    try {
      decoder = new TextDecoder(label);
    } catch {
      decoder = null;
    }
  }
  decoders.set(codepage, decoder);
  return decoder;
};

/** Decode bytes written in a Windows code page; null when the code page is not one this reader knows. */
export const decodeCodepage = (
  codepage: number,
  bytes: Uint8Array,
): string | null => decoderFor(codepage)?.decode(bytes) ?? null;

export const knownCodepage = (codepage: number): boolean =>
  decoderFor(codepage) !== null;
