import { ByteReader, DebugFormatError } from "./byteReader.js";
import { DW_FORM } from "./dwarfConstants.js";
import type { UnitHeader, UnitReader } from "./dwarfUnits.js";

export interface AddressRange {
  readonly low: bigint;
  readonly high: bigint;
}

/** Most ranges one DIE lists; longer lists are cut and reported by the caller. */
export const MAX_RANGES = 4_096;

/**
 * The address ranges a DW_AT_ranges value names. `form` and `value` are the attribute's own;
 * `base` is the unit's base address (its low_pc, or zero).
 */
export const readRanges = (
  reader: UnitReader,
  unit: UnitHeader,
  form: number,
  value: number,
  base: bigint,
): RangeList => {
  // Functions often share a list; read each (list, base) once.
  const key = `${unit.version}:${unit.offsetSize}:${form}:${value}:${base}`;
  const known = reader.rangeCache.get(key);
  if (known !== undefined) return known as RangeList;
  const list = decodeRanges(reader, unit, form, value, base);
  if (reader.rangeCache.size >= MAX_CACHED_LISTS) reader.rangeCache.clear();
  reader.rangeCache.set(key, list);
  return list;
};

export interface RangeList {
  readonly ranges: AddressRange[];
  readonly truncated: boolean;
}

const MAX_CACHED_LISTS = 50_000;

const decodeRanges = (
  reader: UnitReader,
  unit: UnitHeader,
  form: number,
  value: number,
  base: bigint,
): RangeList => {
  const littleEndian = reader.littleEndian;
  const ranges: AddressRange[] = [];
  let truncated = false;
  const add = (low: bigint, high: bigint): boolean => {
    if (ranges.length >= MAX_RANGES) {
      truncated = true;
      return false;
    }
    if (high > low) ranges.push({ low, high });
    return true;
  };
  if (unit.version >= 5) {
    const data = reader.sections.get(".debug_rnglists");
    if (data === undefined)
      throw new DebugFormatError(
        "The image has no readable .debug_rnglists section.",
      );
    let at = value;
    if (form === DW_FORM.rnglistx) {
      const tableBase =
        reader.bases(unit).rnglists ?? (unit.offsetSize === 8 ? 20 : 12);
      const slot = tableBase + value * unit.offsetSize;
      if (slot + unit.offsetSize > data.length)
        throw new DebugFormatError(
          "A range list index is past .debug_rnglists.",
        );
      at =
        tableBase +
        new ByteReader(data, littleEndian, slot).offset(unit.offsetSize);
    }
    if (at >= data.length)
      throw new DebugFormatError(
        "A range list offset is past .debug_rnglists.",
      );
    const list = new ByteReader(data, littleEndian, at);
    let current = base;
    const indexed = (index: number): bigint => {
      const address = reader.addressAt(unit, index);
      if (address === null)
        throw new DebugFormatError(
          "A range list names an address index the image cannot resolve.",
        );
      return address;
    };
    for (;;) {
      reader.step(1);
      const kind = list.u8();
      if (kind === 0) break;
      let keepGoing = true;
      switch (kind) {
        case 1:
          current = indexed(list.uleb());
          break;
        case 2:
          keepGoing = add(indexed(list.uleb()), indexed(list.uleb()));
          break;
        case 3: {
          const start = indexed(list.uleb());
          keepGoing = add(start, start + BigInt(list.uleb()));
          break;
        }
        case 4:
          keepGoing = add(
            current + BigInt(list.uleb()),
            current + BigInt(list.uleb()),
          );
          break;
        case 5:
          current = list.unsignedBig(unit.addressSize);
          break;
        case 6:
          keepGoing = add(
            list.unsignedBig(unit.addressSize),
            list.unsignedBig(unit.addressSize),
          );
          break;
        case 7: {
          const start = list.unsignedBig(unit.addressSize);
          keepGoing = add(start, start + BigInt(list.uleb()));
          break;
        }
        default:
          throw new DebugFormatError(
            `Range list entry kind ${kind} is not supported.`,
          );
      }
      if (!keepGoing) break;
    }
    return { ranges, truncated };
  }
  const data = reader.sections.get(".debug_ranges");
  if (data === undefined)
    throw new DebugFormatError(
      "The image has no readable .debug_ranges section.",
    );
  if (value >= data.length)
    throw new DebugFormatError("A range list offset is past .debug_ranges.");
  const list = new ByteReader(data, littleEndian, value);
  const all = (1n << BigInt(unit.addressSize * 8)) - 1n;
  let current = base;
  for (;;) {
    reader.step(1);
    const first = list.unsignedBig(unit.addressSize);
    const second = list.unsignedBig(unit.addressSize);
    if (first === 0n && second === 0n) break;
    if (first === all) {
      current = second;
      continue;
    }
    if (!add(current + first, current + second)) break;
  }
  return { ranges, truncated };
};
