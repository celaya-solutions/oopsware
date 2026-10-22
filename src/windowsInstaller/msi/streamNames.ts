/**
 * Windows Installer's compressed stream names: each character of
 * [0-9A-Za-z._] is a 6-bit value; a pair is packed into one code unit in
 * 0x3800-0x47FF (first character in the low six bits), a lone one into
 * 0x4800-0x483F, and table streams start with 0x4840. Other code units are
 * kept, so "\u0005SummaryInformation" decodes to itself.
 */

export interface MsiStreamName {
  /** The decoded name, without the table marker. */
  readonly name: string;
  /** Whether the stored name starts with 0x4840 (a table's data stream). */
  readonly table: boolean;
}

const ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz._";
const PAIR_FIRST = 0x3800;
const SINGLE_FIRST = 0x4800;
const TABLE_MARKER = 0x4840;

const character = (value: number): string => ALPHABET[value & 0x3f] ?? "_";

export const decodeMsiStreamName = (stored: string): MsiStreamName => {
  const table = stored.charCodeAt(0) === TABLE_MARKER;
  let name = "";
  for (let index = table ? 1 : 0; index < stored.length; index += 1) {
    const unit = stored.charCodeAt(index);
    if (unit >= PAIR_FIRST && unit < SINGLE_FIRST) {
      const packed = unit - PAIR_FIRST;
      name += character(packed) + character(packed >> 6);
    } else if (unit >= SINGLE_FIRST && unit < TABLE_MARKER)
      name += character(unit - SINGLE_FIRST);
    else name += stored[index] ?? "";
  }
  return { name, table };
};

/** The stored form of a name, as Windows Installer and msitools write it. */
export const encodeMsiStreamName = (name: string, table: boolean): string => {
  let stored = table ? String.fromCharCode(TABLE_MARKER) : "";
  for (let index = 0; index < name.length; index += 1) {
    const first = ALPHABET.indexOf(name[index] ?? "");
    if (first < 0) {
      stored += name[index] ?? "";
      continue;
    }
    const second =
      index + 1 < name.length ? ALPHABET.indexOf(name[index + 1] ?? "") : -1;
    if (second < 0) stored += String.fromCharCode(SINGLE_FIRST + first);
    else {
      stored += String.fromCharCode(PAIR_FIRST + first + (second << 6));
      index += 1;
    }
  }
  return stored;
};
