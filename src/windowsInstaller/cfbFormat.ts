/** [MS-CFB] constants, the public entry and error types, and byte helpers. */

export type CfbRead = (offset: number, length: number) => Promise<Uint8Array>;

/** A structural problem at an exact byte offset of the compound file. */
export class CfbFormatError extends Error {
  constructor(
    readonly offset: number,
    message: string,
  ) {
    super(message);
    this.name = "CfbFormatError";
  }
}

export interface CfbEntry {
  /** Names from below the root to this entry; the root's path is empty. */
  readonly path: readonly string[];
  /** The stored UTF-16 name, code unit for code unit. */
  readonly name: string;
  readonly type: "storage" | "stream" | "root";
  /** Stream bytes; the root's is the mini stream's; storages are 0. */
  readonly size: number;
  readonly clsid: string | null;
  /** Directory entry number (stream ID). */
  readonly id: number;
}

export const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
export const MAXREGSECT = 0xfffffffa;
export const DIFSECT = 0xfffffffc;
export const FATSECT = 0xfffffffd;
export const ENDOFCHAIN = 0xfffffffe;
export const FREESECT = 0xffffffff;
export const NOSTREAM = 0xffffffff;
export const HEADER_BYTES = 512;
export const HEADER_DIFAT = 109;
export const ENTRY_BYTES = 128;
export const MINI_SECTOR = 64;
export const MINI_CUTOFF = 4096;
/** More directory entries than any real container holds; a bound, not a format rule. */
export const CFB_MAX_ENTRIES = 1 << 20;

export const u16 = (bytes: Uint8Array, at: number): number =>
  (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);

export const u32 = (bytes: Uint8Array, at: number): number =>
  ((bytes[at] ?? 0) |
    ((bytes[at + 1] ?? 0) << 8) |
    ((bytes[at + 2] ?? 0) << 16) |
    ((bytes[at + 3] ?? 0) << 24)) >>>
  0;

const hexByte = (value: number): string =>
  value.toString(16).padStart(2, "0").toUpperCase();

/** A GUID in registry form ({8-4-4-4-12}, first three fields little-endian); null when all zero. */
export const formatGuid = (bytes: Uint8Array, at = 0): string | null => {
  const raw = bytes.subarray(at, at + 16);
  if (raw.length < 16 || raw.every((byte) => byte === 0)) return null;
  const order = [3, 2, 1, 0, -1, 5, 4, -1, 7, 6, -1, 8, 9, -1];
  let text = "";
  for (const index of order) text += index < 0 ? "-" : hexByte(raw[index] ?? 0);
  for (let index = 10; index < 16; index += 1) text += hexByte(raw[index] ?? 0);
  return `{${text}}`;
};

const SPECIAL: Readonly<Record<number, string>> = {
  [FREESECT]: "FREESECT",
  [ENDOFCHAIN]: "ENDOFCHAIN",
  [FATSECT]: "FATSECT",
  [DIFSECT]: "DIFSECT",
};

export const describeSector = (sector: number): string =>
  SPECIAL[sector] ?? `sector ${String(sector)}`;
