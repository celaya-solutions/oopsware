import { LegacyEncryptedError, LegacyFormatError } from "./legacy.js";

/**
 * The File Information Block at the start of a Word 97-2003 `WordDocument`
 * stream ([MS-DOC] 2.5): the version, the flags that matter before anything
 * else is read (encryption, template, which table stream), the character
 * counts of each story and the table-stream offsets of the structures the
 * reader uses. Every section is read by its declared count, as 2.5.15
 * specifies; entries past `cbRgFcLcb` are absent, never guessed.
 */

const W_IDENT = 0xa5ec;
const NFIB_WORD97 = 0x00c1;
const KNOWN_NFIB: ReadonlySet<number> = new Set([
  0x00c1, 0x00d9, 0x0101, 0x010c, 0x0112,
]);
const FIB_BASE = 32;

/** FibRgFcLcb entries by index ([MS-DOC] 2.5.6, 2.5.7, 2.5.8). */
export const FC = {
  stshf: 1,
  plcffndRef: 2,
  plcffndTxt: 3,
  plcfandRef: 4,
  plcfandTxt: 5,
  plcfSed: 6,
  plcfHdd: 11,
  plcfBteChpx: 12,
  plcfBtePapx: 13,
  sttbfAssoc: 32,
  clx: 33,
  grpXstAtnOwners: 36,
  plcfendRef: 46,
  plcfendTxt: 47,
  plcftxbxTxt: 56,
  plcfHdrtxbxTxt: 58,
  atrdExtra: 112,
} as const;

export interface StoryCounts {
  readonly text: number;
  readonly ftn: number;
  readonly hdd: number;
  readonly atn: number;
  readonly edn: number;
  readonly txbx: number;
  readonly hdrTxbx: number;
}

export interface DocFib {
  /** FibRgCswNew.nFibNew when present, else FibBase.nFib. */
  readonly nFib: number;
  readonly template: boolean;
  readonly tableName: "0Table" | "1Table";
  readonly ccp: StoryCounts;
  /** Problems that leave the FIB readable. */
  readonly problems: readonly string[];
  /** The table-stream offset and size of entry `index`, or null when the FIB does not have it or its size is zero. */
  fcLcb(index: number): { fc: number; lcb: number } | null;
}

const hex = (value: number): string =>
  `0x${value.toString(16).toUpperCase().padStart(4, "0")}`;

const olderFormat = (nFib: number): string =>
  nFib >= 0x0065
    ? `a Word 6.0 or Word 95 document (nFib ${hex(nFib)})`
    : `a Word 2.x or earlier document (nFib ${hex(nFib)})`;

export const readFib = (word: Uint8Array): DocFib => {
  if (word.length < FIB_BASE + 2)
    throw new LegacyFormatError(
      `The WordDocument stream is ${String(word.length)} bytes, too short to hold a file information block.`,
    );
  const view = new DataView(word.buffer, word.byteOffset, word.byteLength);
  const ident = view.getUint16(0, true);
  if (ident !== W_IDENT)
    throw new LegacyFormatError(
      `The WordDocument stream does not start with a Word file information block (wIdent ${hex(ident)}, expected 0xA5EC).`,
    );
  const baseNFib = view.getUint16(2, true);
  if (baseNFib < NFIB_WORD97)
    throw new LegacyFormatError(
      `The file is ${olderFormat(baseNFib)}, an older binary format than Word 97-2003; it is named and not read.`,
    );
  const flags = view.getUint16(10, true);
  // fEncrypted (bit 8); fObfuscated (bit 15) only has meaning when fEncrypted is set.
  if ((flags & 0x0100) !== 0)
    throw new LegacyEncryptedError(
      `The document is password-protected (${(flags & 0x8000) !== 0 ? "XOR obfuscation" : "RC4 encryption"} is declared in its file information block). No password is tried and nothing is decrypted.`,
    );

  const problems: string[] = [];
  const need = (end: number, what: string): void => {
    if (end > word.length)
      throw new LegacyFormatError(
        `The file information block is cut off: its ${what} ends at byte ${String(end)} of a ${String(word.length)}-byte WordDocument stream.`,
      );
  };
  const csw = view.getUint16(FIB_BASE, true);
  const cslwAt = FIB_BASE + 2 + csw * 2;
  need(cslwAt + 2, "FibRgW97");
  const cslw = view.getUint16(cslwAt, true);
  const lwAt = cslwAt + 2;
  const cbAt = lwAt + cslw * 4;
  need(cbAt + 2, "FibRgLw97");
  // A count the FIB does not carry reads as zero ([MS-DOC] 2.5.15 step 1).
  const lw = (index: number): number => {
    if (index >= cslw) return 0;
    const value = view.getInt32(lwAt + index * 4, true);
    if (value < 0) {
      problems.push(
        `FibRgLw97 entry ${String(index)} is negative (${String(value)}); it is read as zero.`,
      );
      return 0;
    }
    return value;
  };
  const ccp: StoryCounts = {
    text: lw(3),
    ftn: lw(4),
    hdd: lw(5),
    atn: lw(7),
    edn: lw(8),
    txbx: lw(9),
    hdrTxbx: lw(10),
  };
  const cbRgFcLcb = view.getUint16(cbAt, true);
  const blobAt = cbAt + 2;
  need(blobAt + cbRgFcLcb * 8, "FibRgFcLcb");
  const cswNewAt = blobAt + cbRgFcLcb * 8;
  let nFib = baseNFib;
  if (cswNewAt + 4 <= word.length && view.getUint16(cswNewAt, true) > 0)
    nFib = view.getUint16(cswNewAt + 2, true);
  if (!KNOWN_NFIB.has(nFib))
    problems.push(
      `The file information block declares nFib ${hex(nFib)}, which this reader does not know; it is read by its declared sizes.`,
    );

  return {
    nFib,
    template: (flags & 0x0001) !== 0,
    tableName: (flags & 0x0200) !== 0 ? "1Table" : "0Table",
    ccp,
    problems,
    fcLcb: (index) => {
      if (index >= cbRgFcLcb) return null;
      const fc = view.getUint32(blobAt + index * 8, true);
      const lcb = view.getUint32(blobAt + index * 8 + 4, true);
      return lcb === 0 ? null : { fc, lcb };
    },
  };
};
