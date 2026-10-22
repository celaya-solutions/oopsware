import { ByteReader, DebugFormatError, stringAt } from "./byteReader.js";
import {
  DW_AT,
  DW_FORM,
  UNIT_TYPES,
  isAddressIndexForm,
  isReferenceForm,
  isStringIndexForm,
} from "./dwarfConstants.js";
import {
  DecodeBudgetExceeded,
  readSection,
  sectionNamed,
  type DebugImage,
  type DecodeBudget,
} from "./image.js";

/** Most declarations one abbreviation table and most attributes one declaration may hold. */
const MAX_ABBREVS = 1_000_000;
const MAX_ABBREV_ATTRIBUTES = 4_096;
/** Decoding steps (DIEs, abbreviation declarations and attributes) one call will take. */
export const MAX_DECODE_STEPS = 50_000_000;
/** Compilation units one image may list; each costs a header record in memory. */
export const MAX_UNITS = 500_000;
/** Abbreviation tables kept; overlapping tables must not accumulate. */
const ABBREV_CACHE_SIZE = 64;
/** Nested DW_FORM_indirect forms followed for one attribute. */
const MAX_INDIRECT_HOPS = 4;

/** An attribute value; which kind it is follows from the form. */
export type AttrValue = number | bigint | string | boolean | Uint8Array | null;

export interface Attr {
  readonly at: number;
  readonly form: number;
  readonly value: AttrValue;
}

export interface Die {
  /** Offset in .debug_info. */
  readonly offset: number;
  readonly tag: number;
  readonly depth: number;
  readonly hasChildren: boolean;
  readonly attrs: readonly Attr[];
}

export interface UnitHeader {
  readonly index: number;
  /** Offset of the unit's length field in .debug_info. */
  readonly offset: number;
  /** Offset one past the unit's last byte. */
  readonly end: number;
  readonly version: number;
  readonly unitType: number;
  readonly unitTypeName: string;
  readonly addressSize: number;
  /** 4 for 32-bit DWARF, 8 for 64-bit DWARF. */
  readonly offsetSize: 4 | 8;
  readonly abbrevOffset: number;
  /** Offset of the unit's first DIE. */
  readonly dieOffset: number;
  readonly dwoId: bigint | null;
  readonly typeSignature: bigint | null;
}

interface AbbrevAttribute {
  readonly at: number;
  readonly form: number;
  readonly implicit: number;
}

interface Abbrev {
  readonly tag: number;
  readonly hasChildren: boolean;
  readonly attrs: readonly AbbrevAttribute[];
}

/** Index bases a unit's CU DIE declares for its strx, addrx and list forms. */
export interface UnitBases {
  readonly strOffsets: number | null;
  readonly addr: number | null;
  readonly rnglists: number | null;
}

const NO_BASES: UnitBases = { strOffsets: null, addr: null, rnglists: null };

export const SUPPORTED_VERSIONS: ReadonlySet<number> = new Set([2, 3, 4, 5]);

/** The decompressed sections of one image, read at most once each. */
export class DwarfSections {
  readonly #cache = new Map<string, Uint8Array | null>();
  readonly problems = new Set<string>();
  /** A section could not be decoded because the decode budget ran out. */
  budgetExceeded = false;

  constructor(
    readonly image: DebugImage,
    readonly budget: DecodeBudget,
  ) {}

  get(name: string): Uint8Array | undefined {
    const cached = this.#cache.get(name);
    if (cached !== undefined) return cached ?? undefined;
    const section = sectionNamed(this.image, name);
    if (section === undefined || section.noBits) {
      this.#cache.set(name, null);
      return undefined;
    }
    try {
      const bytes = readSection(this.image, section, this.budget);
      this.#cache.set(name, bytes);
      return bytes;
    } catch (cause) {
      if (!(cause instanceof DebugFormatError)) throw cause;
      if (cause instanceof DecodeBudgetExceeded) this.budgetExceeded = true;
      this.problems.add(cause.message);
      this.#cache.set(name, null);
      return undefined;
    }
  }
}

/** Read every unit header in .debug_info. A bad header ends the walk with a problem. */
export const readUnitHeaders = (
  sections: DwarfSections,
): { readonly units: UnitHeader[]; readonly problems: string[] } => {
  const info = sections.get(".debug_info");
  const units: UnitHeader[] = [];
  const problems: string[] = [];
  if (info === undefined) return { units, problems };
  const littleEndian = sections.image.littleEndian;
  let at = 0;
  while (at < info.length) {
    if (info.length - at < 4) {
      problems.push(`${info.length - at} trailing bytes follow the last unit.`);
      break;
    }
    if (units.length >= MAX_UNITS) {
      problems.push(`More than ${MAX_UNITS} units; the rest were not listed.`);
      break;
    }
    try {
      const reader = new ByteReader(info, littleEndian, at);
      let length = reader.u32();
      let offsetSize: 4 | 8 = 4;
      if (length === 0xffffffff) {
        offsetSize = 8;
        length = Number(reader.u64());
      } else if (length >= 0xfffffff0) {
        problems.push(`Unit at ${at} has the reserved length ${length}.`);
        break;
      }
      const end = reader.pos + length;
      if (end > info.length) {
        problems.push(`Unit at ${at} extends past the end of .debug_info.`);
        break;
      }
      const version = reader.u16();
      let unitType = 1;
      let addressSize: number;
      let abbrevOffset: number;
      let dwoId: bigint | null = null;
      let typeSignature: bigint | null = null;
      if (version >= 5) {
        unitType = reader.u8();
        addressSize = reader.u8();
        abbrevOffset = reader.offset(offsetSize);
        if (unitType === 4 || unitType === 5) dwoId = reader.u64();
        if (unitType === 2 || unitType === 6) {
          typeSignature = reader.u64();
          reader.offset(offsetSize);
        }
      } else {
        abbrevOffset = reader.offset(offsetSize);
        addressSize = reader.u8();
      }
      units.push({
        index: units.length,
        offset: at,
        end,
        version,
        unitType,
        unitTypeName: UNIT_TYPES[unitType] ?? `unit-type-${unitType}`,
        addressSize,
        offsetSize,
        abbrevOffset,
        dieOffset: reader.pos,
        dwoId,
        typeSignature,
      });
      if (end === at) break;
      at = end;
    } catch (cause) {
      if (!(cause instanceof DebugFormatError)) throw cause;
      problems.push(`Unit at ${at}: ${cause.message}`);
      break;
    }
  }
  return { units, problems };
};

const readAbbrevTable = (
  data: Uint8Array,
  offset: number,
  littleEndian: boolean,
  step: (count: number) => void,
): Map<number, Abbrev> => {
  const table = new Map<number, Abbrev>();
  if (offset > data.length)
    throw new DebugFormatError(
      "The abbreviation table offset is past .debug_abbrev.",
    );
  const reader = new ByteReader(data, littleEndian, offset);
  while (!reader.atEnd) {
    const code = reader.uleb();
    if (code === 0) return table;
    if (table.size >= MAX_ABBREVS)
      throw new DebugFormatError("The abbreviation table is too large.");
    const tag = reader.uleb();
    const hasChildren = reader.u8() !== 0;
    const attrs: AbbrevAttribute[] = [];
    step(1);
    for (;;) {
      const at = reader.uleb();
      const form = reader.uleb();
      let implicit = 0;
      if (form === DW_FORM.implicit_const) implicit = reader.sleb();
      if (at === 0 && form === 0) break;
      if (attrs.length >= MAX_ABBREV_ATTRIBUTES)
        throw new DebugFormatError(
          "An abbreviation declares too many attributes.",
        );
      step(1);
      attrs.push({ at, form, implicit });
    }
    table.set(code, { tag, hasChildren, attrs });
  }
  // A table that ends without its terminating zero is still usable.
  return table;
};

/** Decoder for the DIEs of the units of one image. */
export class UnitReader {
  readonly #abbrevs = new Map<number, Map<number, Abbrev>>();
  readonly #bases = new Map<number, UnitBases>();
  /** Decoding steps taken so far; the call stops at MAX_DECODE_STEPS. */
  steps = 0;
  /** Range lists already read, by form, value and base address. */
  readonly rangeCache = new Map<string, unknown>();

  constructor(readonly sections: DwarfSections) {}

  get littleEndian(): boolean {
    return this.sections.image.littleEndian;
  }

  /** Count decoding work; a hostile file cannot make one call run without bound. */
  step(count: number): void {
    this.steps += count;
    if (this.steps > MAX_DECODE_STEPS)
      throw new DebugFormatError(
        `More than ${MAX_DECODE_STEPS} decoding steps; decoding stopped.`,
      );
  }

  #table(unit: UnitHeader): Map<number, Abbrev> {
    const cached = this.#abbrevs.get(unit.abbrevOffset);
    if (cached !== undefined) {
      // Re-insert to keep the most recently used tables.
      this.#abbrevs.delete(unit.abbrevOffset);
      this.#abbrevs.set(unit.abbrevOffset, cached);
      return cached;
    }
    const data = this.sections.get(".debug_abbrev");
    if (data === undefined)
      throw new DebugFormatError(
        "The image has no readable .debug_abbrev section.",
      );
    const table = readAbbrevTable(
      data,
      unit.abbrevOffset,
      this.littleEndian,
      (count) => this.step(count),
    );
    if (this.#abbrevs.size >= ABBREV_CACHE_SIZE) {
      const oldest = this.#abbrevs.keys().next().value;
      if (oldest !== undefined) this.#abbrevs.delete(oldest);
    }
    this.#abbrevs.set(unit.abbrevOffset, table);
    return table;
  }

  /** The unit's index bases, taken from its first DIE (decoded once with no bases applied). */
  bases(unit: UnitHeader): UnitBases {
    const known = this.#bases.get(unit.index);
    if (known !== undefined) return known;
    let found: UnitBases = NO_BASES;
    this.#walk(unit, NO_BASES, (die) => {
      const number = (at: number): number | null => {
        const value = die.attrs.find((attr) => attr.at === at)?.value;
        return typeof value === "number" ? value : null;
      };
      found = {
        strOffsets: number(DW_AT.str_offsets_base),
        addr: number(DW_AT.addr_base) ?? number(DW_AT.GNU_addr_base),
        rnglists: number(DW_AT.rnglists_base) ?? number(DW_AT.GNU_ranges_base),
      };
      return true;
    });
    this.#bases.set(unit.index, found);
    return found;
  }

  /** Decode a unit's DIEs in order; `visit` returns true to stop. */
  walk(unit: UnitHeader, visit: (die: Die) => boolean | void): void {
    this.#walk(unit, this.bases(unit), visit);
  }

  #walk(
    unit: UnitHeader,
    bases: UnitBases,
    visit: (die: Die) => boolean | void,
  ): void {
    if (!SUPPORTED_VERSIONS.has(unit.version))
      throw new DebugFormatError(
        `DWARF version ${unit.version} is not supported.`,
      );
    const info = this.sections.get(".debug_info");
    if (info === undefined)
      throw new DebugFormatError(
        "The image has no readable .debug_info section.",
      );
    const table = this.#table(unit);
    const reader = new ByteReader(
      info,
      this.littleEndian,
      unit.dieOffset,
      unit.end,
    );
    let depth = 0;
    while (!reader.atEnd) {
      const offset = reader.pos;
      const code = reader.uleb();
      if (code === 0) {
        depth -= 1;
        if (depth <= 0) return;
        continue;
      }
      const abbrev = table.get(code);
      if (abbrev === undefined)
        throw new DebugFormatError(
          `DIE at ${offset} uses abbreviation ${code}, which the table does not declare.`,
        );
      this.step(1);
      const attrs: Attr[] = [];
      for (const spec of abbrev.attrs)
        attrs.push({
          at: spec.at,
          form: spec.form,
          value: this.#value(reader, spec.form, spec.implicit, unit, bases),
        });
      const die: Die = {
        offset,
        tag: abbrev.tag,
        depth,
        hasChildren: abbrev.hasChildren,
        attrs,
      };
      if (visit(die) === true) return;
      if (abbrev.hasChildren) depth += 1;
      else if (depth === 0) return;
    }
  }

  #strings(): Uint8Array | undefined {
    return this.sections.get(".debug_str");
  }

  #indexedString(
    index: number,
    unit: UnitHeader,
    bases: UnitBases,
  ): string | null {
    const table = this.sections.get(".debug_str_offsets");
    if (table === undefined) return null;
    const first = bases.strOffsets ?? (unit.offsetSize === 8 ? 16 : 8);
    const at = first + index * unit.offsetSize;
    if (at + unit.offsetSize > table.length) return null;
    const offset = new ByteReader(table, this.littleEndian, at).offset(
      unit.offsetSize,
    );
    return stringAt(this.#strings(), offset);
  }

  /** An entry of .debug_addr by index, for list forms; null when the table or base is missing. */
  addressAt(unit: UnitHeader, index: number): bigint | null {
    return this.#indexedAddress(index, unit, this.bases(unit));
  }

  #indexedAddress(
    index: number,
    unit: UnitHeader,
    bases: UnitBases,
  ): bigint | null {
    const table = this.sections.get(".debug_addr");
    if (table === undefined || bases.addr === null) return null;
    const at = bases.addr + index * unit.addressSize;
    if (at + unit.addressSize > table.length) return null;
    return new ByteReader(table, this.littleEndian, at).unsignedBig(
      unit.addressSize,
    );
  }

  #value(
    reader: ByteReader,
    form: number,
    implicit: number,
    unit: UnitHeader,
    bases: UnitBases,
  ): AttrValue {
    switch (form) {
      case DW_FORM.addr:
        return reader.unsignedBig(unit.addressSize);
      case DW_FORM.block2:
        return reader.block(reader.u16());
      case DW_FORM.block4:
        return reader.block(reader.u32());
      case DW_FORM.data2:
        return reader.u16();
      case DW_FORM.data4:
        return reader.u32();
      case DW_FORM.data8:
        return reader.u64();
      case DW_FORM.string:
        return reader.cString();
      case DW_FORM.block:
      case DW_FORM.exprloc:
        return reader.block(reader.uleb());
      case DW_FORM.block1:
        return reader.block(reader.u8());
      case DW_FORM.data1:
        return reader.u8();
      case DW_FORM.flag:
        return reader.u8() !== 0;
      case DW_FORM.sdata:
        return reader.slebValue();
      case DW_FORM.udata:
        return reader.ulebValue();
      case DW_FORM.strp:
        return stringAt(this.#strings(), reader.offset(unit.offsetSize));
      case DW_FORM.line_strp:
        return stringAt(
          this.sections.get(".debug_line_str"),
          reader.offset(unit.offsetSize),
        );
      case DW_FORM.strp_sup:
      case DW_FORM.GNU_strp_alt:
        reader.offset(unit.offsetSize);
        this.sections.problems.add(
          "A string lives in a supplementary object file, which is not read.",
        );
        return null;
      case DW_FORM.ref_addr:
        return reader.offset(
          unit.version <= 2 ? unit.addressSize : unit.offsetSize,
        );
      case DW_FORM.ref1:
        return unit.offset + reader.u8();
      case DW_FORM.ref2:
        return unit.offset + reader.u16();
      case DW_FORM.ref4:
        return unit.offset + reader.u32();
      case DW_FORM.ref8:
        return unit.offset + Number(reader.u64());
      case DW_FORM.ref_udata:
        return unit.offset + reader.uleb();
      case DW_FORM.indirect: {
        let actual: number = form;
        for (let hops = 0; actual === DW_FORM.indirect; hops += 1) {
          if (hops >= MAX_INDIRECT_HOPS)
            throw new DebugFormatError("DW_FORM_indirect nests too deeply.");
          actual = reader.uleb();
        }
        return this.#value(reader, actual, implicit, unit, bases);
      }
      case DW_FORM.sec_offset:
        return reader.offset(unit.offsetSize);
      case DW_FORM.flag_present:
        return true;
      case DW_FORM.strx:
      case DW_FORM.GNU_str_index:
        return this.#indexedString(reader.uleb(), unit, bases);
      case DW_FORM.strx1:
        return this.#indexedString(reader.u8(), unit, bases);
      case DW_FORM.strx2:
        return this.#indexedString(reader.u16(), unit, bases);
      case DW_FORM.strx3:
        return this.#indexedString(reader.u24(), unit, bases);
      case DW_FORM.strx4:
        return this.#indexedString(reader.u32(), unit, bases);
      case DW_FORM.addrx:
      case DW_FORM.GNU_addr_index:
        return this.#indexedAddress(reader.uleb(), unit, bases);
      case DW_FORM.addrx1:
        return this.#indexedAddress(reader.u8(), unit, bases);
      case DW_FORM.addrx2:
        return this.#indexedAddress(reader.u16(), unit, bases);
      case DW_FORM.addrx3:
        return this.#indexedAddress(reader.u24(), unit, bases);
      case DW_FORM.addrx4:
        return this.#indexedAddress(reader.u32(), unit, bases);
      case DW_FORM.ref_sup4:
        return reader.u32();
      case DW_FORM.ref_sup8:
        return reader.u64();
      case DW_FORM.data16:
        return reader.block(16);
      case DW_FORM.ref_sig8:
        return reader.u64();
      case DW_FORM.implicit_const:
        return implicit;
      case DW_FORM.loclistx:
      case DW_FORM.rnglistx:
        return reader.uleb();
      case DW_FORM.GNU_ref_alt:
        return reader.offset(unit.offsetSize);
      default:
        throw new DebugFormatError(
          `Attribute form 0x${form.toString(16)} is not supported.`,
        );
    }
  }
}

export const attr = (die: Die, at: number): Attr | undefined =>
  die.attrs.find((item) => item.at === at);

export const stringAttr = (die: Die, at: number): string | null => {
  const value = attr(die, at)?.value;
  return typeof value === "string" ? value : null;
};

export const numberAttr = (die: Die, at: number): number | null => {
  const value = attr(die, at)?.value;
  return typeof value === "number" ? value : null;
};

export { isAddressIndexForm, isReferenceForm, isStringIndexForm };
