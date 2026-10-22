/**
 * Windows code pages named by an MSI string pool or summary information
 * property set, mapped to WHATWG TextDecoder labels. Code page 0 is
 * "neutral": Windows uses the machine's ANSI page; it is read as
 * windows-1252, the page msitools falls back to.
 */

const LABELS: Readonly<Record<number, string>> = {
  0: "windows-1252",
  866: "ibm866",
  874: "windows-874",
  932: "shift_jis",
  936: "gbk",
  949: "euc-kr",
  950: "big5",
  1250: "windows-1250",
  1251: "windows-1251",
  1252: "windows-1252",
  1253: "windows-1253",
  1254: "windows-1254",
  1255: "windows-1255",
  1256: "windows-1256",
  1257: "windows-1257",
  1258: "windows-1258",
  10000: "macintosh",
  10007: "x-mac-cyrillic",
  20127: "windows-1252",
  20866: "koi8-r",
  20932: "euc-jp",
  21866: "koi8-u",
  28591: "windows-1252",
  28592: "iso-8859-2",
  28593: "iso-8859-3",
  28594: "iso-8859-4",
  28595: "iso-8859-5",
  28596: "iso-8859-6",
  28597: "iso-8859-7",
  28598: "iso-8859-8",
  28599: "windows-1254",
  28603: "iso-8859-13",
  28605: "iso-8859-15",
  54936: "gb18030",
  65001: "utf-8",
};

/** Decodes byte strings in one code page; `exact` is false when the page had no decoder. */
export interface CodepageDecoder {
  readonly codepage: number;
  readonly label: string;
  readonly exact: boolean;
  decode(bytes: Uint8Array): string;
}

export const codepageDecoder = (codepage: number): CodepageDecoder => {
  const known = LABELS[codepage];
  const label = known ?? "windows-1252";
  const decoder = new TextDecoder(label);
  return {
    codepage,
    label,
    exact: known !== undefined,
    decode: (bytes) => decoder.decode(bytes),
  };
};
