import {
  DebugFormatError,
  hexAddress,
  optionalHexAddress,
} from "./byteReader.js";
import {
  DW_AT,
  DW_FORM,
  DW_TAG,
  LANGUAGES,
  TYPE_TAGS,
  isAddressIndexForm,
} from "./dwarfConstants.js";
import {
  readLineHeader,
  runLineProgram,
  type LineFile,
  type LineHeader,
  type LineRow,
} from "./dwarfLines.js";
import { readRanges, type AddressRange } from "./dwarfRanges.js";
import {
  SUPPORTED_VERSIONS,
  attr,
  numberAttr,
  stringAttr,
  type Die,
  type UnitHeader,
  type UnitReader,
} from "./dwarfUnits.js";

export interface UnitSummary {
  readonly index: number;
  readonly offset: number;
  readonly version: number;
  readonly unitType: string;
  readonly addressSize: number;
  readonly offsetSize: number;
  readonly name: string | null;
  readonly compDir: string | null;
  readonly producer: string | null;
  readonly language: {
    readonly code: number;
    readonly name: string | null;
  } | null;
  readonly lowPc: string | null;
  readonly highPc: string | null;
  readonly hasRanges: boolean;
  readonly stmtList: number | null;
  readonly dwoName: string | null;
  readonly dwoId: string | null;
  readonly counts: {
    readonly dies: number;
    readonly functions: number;
    readonly declarations: number;
    readonly inlined: number;
    readonly variables: number;
    readonly types: number;
  };
  /** Why the unit's DIEs could not be read in full, or null. */
  readonly problem: string | null;
}

export interface FunctionRow {
  readonly unit: number;
  /** Offset of the function's DIE in .debug_info. */
  readonly offset: number;
  readonly name: string | null;
  readonly linkageName: string | null;
  readonly lowPc: string | null;
  readonly highPc: string | null;
  readonly ranges: readonly { readonly low: string; readonly high: string }[];
  readonly rangeCount: number;
  /** More ranges exist than rangeCount counts. */
  readonly rangesTruncated: boolean;
  readonly declFile: number | null;
  readonly declFileName: string | null;
  readonly declLine: number | null;
  readonly external: boolean;
  /** The name came from a specification or abstract-origin DIE, not this DIE. */
  readonly nameFromOrigin: boolean;
}

const isAddressForm = (form: number): boolean =>
  form === DW_FORM.addr || isAddressIndexForm(form);

const bigintAttr = (die: Die, at: number): bigint | null => {
  const value = attr(die, at)?.value;
  return typeof value === "bigint" ? value : null;
};

/** The unit's own DIE facts, taken from the first DIE. */
interface UnitDie {
  readonly die: Die;
  readonly baseAddress: bigint;
}

const unitDie = (reader: UnitReader, unit: UnitHeader): UnitDie | null => {
  let found: Die | null = null;
  reader.walk(unit, (die) => {
    found = die;
    return true;
  });
  if (found === null) return null;
  const die: Die = found;
  return { die, baseAddress: bigintAttr(die, DW_AT.low_pc) ?? 0n };
};

const highPcOf = (die: Die, low: bigint | null): bigint | null => {
  const high = attr(die, DW_AT.high_pc);
  if (high === undefined || low === null) return null;
  if (isAddressForm(high.form))
    return typeof high.value === "bigint" ? high.value : null;
  if (typeof high.value === "bigint") return low + high.value;
  if (typeof high.value === "number") return low + BigInt(high.value);
  return null;
};

export const summarizeUnit = (
  reader: UnitReader,
  unit: UnitHeader,
): UnitSummary => {
  const base = {
    index: unit.index,
    offset: unit.offset,
    version: unit.version,
    unitType: unit.unitTypeName,
    addressSize: unit.addressSize,
    offsetSize: unit.offsetSize,
    dwoId: unit.dwoId === null ? null : `0x${unit.dwoId.toString(16)}`,
  };
  const empty = {
    name: null,
    compDir: null,
    producer: null,
    language: null,
    lowPc: null,
    highPc: null,
    hasRanges: false,
    stmtList: null,
    dwoName: null,
    counts: {
      dies: 0,
      functions: 0,
      declarations: 0,
      inlined: 0,
      variables: 0,
      types: 0,
    },
  };
  if (!SUPPORTED_VERSIONS.has(unit.version))
    return {
      ...base,
      ...empty,
      problem: `DWARF version ${unit.version} is not supported.`,
    };
  const counts = { ...empty.counts };
  let root: Die | null = null;
  let problem: string | null = null;
  try {
    reader.walk(unit, (die) => {
      counts.dies += 1;
      if (root === null) {
        root = die;
        return;
      }
      if (die.tag === DW_TAG.subprogram) {
        if (attr(die, DW_AT.declaration) !== undefined)
          counts.declarations += 1;
        else if (
          attr(die, DW_AT.low_pc) !== undefined ||
          attr(die, DW_AT.ranges) !== undefined
        )
          counts.functions += 1;
      } else if (die.tag === DW_TAG.inlined_subroutine) counts.inlined += 1;
      else if (die.tag === DW_TAG.variable) counts.variables += 1;
      else if (TYPE_TAGS.has(die.tag)) counts.types += 1;
    });
  } catch (cause) {
    if (!(cause instanceof DebugFormatError)) throw cause;
    problem = cause.message;
  }
  if (root === null) return { ...base, ...empty, counts, problem };
  const die: Die = root;
  const low = bigintAttr(die, DW_AT.low_pc);
  const high = highPcOf(die, low);
  const language = countAttr(die, DW_AT.language);
  return {
    ...base,
    name: stringAttr(die, DW_AT.name),
    compDir: stringAttr(die, DW_AT.comp_dir),
    producer: stringAttr(die, DW_AT.producer),
    language:
      language === null
        ? null
        : { code: language, name: LANGUAGES[language] ?? null },
    lowPc: low === null ? null : hexAddress(low),
    highPc: high === null ? null : hexAddress(high),
    hasRanges: attr(die, DW_AT.ranges) !== undefined,
    stmtList: countAttr(die, DW_AT.stmt_list),
    dwoName:
      stringAttr(die, DW_AT.dwo_name) ?? stringAttr(die, DW_AT.GNU_dwo_name),
    counts,
    problem,
  };
};

interface Candidate {
  readonly offset: number;
  readonly die: Die;
  /** The unit holding the DIE: file indices and references are relative to it. */
  readonly unit: UnitHeader;
}

/** A non-negative integer attribute (a line, a file index); negative or huge values are not facts. */
const countAttr = (die: Die, at: number): number | null => {
  const value = numberAttr(die, at);
  return value !== null && Number.isInteger(value) && value >= 0 ? value : null;
};

/** The subprogram DIEs of one unit by offset, for name resolution through references. */
interface UnitFunctions {
  readonly unit: UnitHeader;
  readonly baseAddress: bigint;
  readonly all: ReadonlyMap<number, Candidate>;
  readonly order: readonly Candidate[];
}

const UNIT_CACHE_SIZE = 64;

export class FunctionIndex {
  readonly #cache = new Map<number, UnitFunctions>();
  readonly #fileMaps = new Map<number, ReadonlyMap<number, LineFile>>();
  readonly #lineHeaders = new Map<
    string,
    { readonly header: LineHeader } | { readonly problem: string }
  >();

  constructor(
    readonly reader: UnitReader,
    readonly units: readonly UnitHeader[],
  ) {}

  #load(unit: UnitHeader): UnitFunctions {
    const known = this.#cache.get(unit.index);
    if (known !== undefined) return known;
    const all = new Map<number, Candidate>();
    const order: Candidate[] = [];
    let root: Die | null = null;
    this.reader.walk(unit, (die) => {
      if (root === null) root = die;
      if (die.tag !== DW_TAG.subprogram) return;
      const candidate = { offset: die.offset, die, unit };
      all.set(die.offset, candidate);
      order.push(candidate);
    });
    const rootDie: Die | null = root;
    const loaded: UnitFunctions = {
      unit,
      baseAddress:
        rootDie === null ? 0n : (bigintAttr(rootDie, DW_AT.low_pc) ?? 0n),
      all,
      order,
    };
    // Keep recent units: references inside one unit are the common case.
    if (this.#cache.size >= UNIT_CACHE_SIZE) {
      const oldest = this.#cache.keys().next().value;
      if (oldest !== undefined) this.#cache.delete(oldest);
    }
    this.#cache.set(unit.index, loaded);
    return loaded;
  }

  /** The unit containing a .debug_info offset; units are listed in offset order. */
  #unitAt(offset: number): UnitHeader | undefined {
    let low = 0;
    let high = this.units.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const unit = this.units[middle]!;
      if (offset < unit.offset) high = middle - 1;
      else if (offset >= unit.end) low = middle + 1;
      else return unit;
    }
    return undefined;
  }

  #target(offset: number): Candidate | undefined {
    const unit = this.#unitAt(offset);
    if (unit === undefined) return undefined;
    try {
      return this.#load(unit).all.get(offset);
    } catch (cause) {
      if (!(cause instanceof DebugFormatError)) throw cause;
      return undefined;
    }
  }

  /** The first value of an attribute along the specification / abstract-origin chain. */
  #chain<T>(
    start: Candidate,
    pick: (die: Die) => T | null,
  ): {
    readonly value: T | null;
    readonly viaOrigin: boolean;
    readonly source: Candidate;
  } {
    let current: Candidate | undefined = start;
    for (let depth = 0; current !== undefined && depth < 8; depth += 1) {
      const value = pick(current.die);
      if (value !== null)
        return { value, viaOrigin: depth > 0, source: current };
      const next: number | null =
        numberAttr(current.die, DW_AT.specification) ??
        numberAttr(current.die, DW_AT.abstract_origin);
      current = next === null ? undefined : this.#target(next);
    }
    return { value: null, viaOrigin: false, source: start };
  }

  #lineHeader(
    unit: UnitHeader,
    stmtList: number,
    compDir: string | null,
  ): { readonly header: LineHeader } | { readonly problem: string } {
    const key = `${unit.index}:${stmtList}`;
    const known = this.#lineHeaders.get(key);
    if (known !== undefined) return known;
    let result: { readonly header: LineHeader } | { readonly problem: string };
    try {
      result = {
        header: readLineHeader(
          this.reader.sections,
          stmtList,
          compDir,
          unit.addressSize,
        ),
      };
    } catch (cause) {
      if (!(cause instanceof DebugFormatError)) throw cause;
      result = { problem: cause.message };
    }
    this.#lineHeaders.set(key, result);
    return result;
  }

  /** File index to path for one unit; file numbers are only meaningful inside their own unit. */
  #fileNames(unit: UnitHeader): ReadonlyMap<number, LineFile> {
    const known = this.#fileMaps.get(unit.index);
    if (known !== undefined) return known;
    const files = new Map<number, LineFile>();
    const table = this.lineTable(unit);
    if (table !== null && "header" in table)
      for (const file of table.header.files) files.set(file.index, file);
    this.#fileMaps.set(unit.index, files);
    return files;
  }

  /** Address ranges of one function DIE: DW_AT_ranges, else low_pc/high_pc. */
  #rangesOf(
    die: Die,
    unit: UnitHeader,
    baseAddress: bigint,
  ): {
    readonly ranges: AddressRange[];
    readonly total: number;
    readonly truncated: boolean;
  } {
    const list = attr(die, DW_AT.ranges);
    if (list !== undefined && typeof list.value === "number") {
      const read = readRanges(
        this.reader,
        unit,
        list.form,
        list.value,
        baseAddress,
      );
      return {
        ranges: read.ranges,
        total: read.ranges.length,
        truncated: read.truncated,
      };
    }
    const low = bigintAttr(die, DW_AT.low_pc);
    const high = low === null ? null : highPcOf(die, low);
    return low !== null && high !== null && high > low
      ? { ranges: [{ low, high }], total: 1, truncated: false }
      : { ranges: [], total: 0, truncated: false };
  }

  /** The functions of one unit that have code, in DIE order. */
  functions(unit: UnitHeader): FunctionRow[] {
    const loaded = this.#load(unit);
    const rows: FunctionRow[] = [];
    for (const candidate of loaded.order) {
      const { die } = candidate;
      if (attr(die, DW_AT.declaration) !== undefined) continue;
      const low = bigintAttr(die, DW_AT.low_pc);
      if (low === null && attr(die, DW_AT.ranges) === undefined) continue;
      const found = this.#rangesOf(die, unit, loaded.baseAddress);
      const name = this.#chain(candidate, (item) =>
        stringAttr(item, DW_AT.name),
      );
      const linkage = this.#chain(
        candidate,
        (item) =>
          stringAttr(item, DW_AT.linkage_name) ??
          stringAttr(item, DW_AT.MIPS_linkage_name),
      );
      const declFile = this.#chain(candidate, (item) =>
        countAttr(item, DW_AT.decl_file),
      );
      const declLine = this.#chain(candidate, (item) =>
        countAttr(item, DW_AT.decl_line),
      );
      const external = this.#chain(candidate, (item) =>
        attr(item, DW_AT.external)?.value === true ? true : null,
      );
      const first = found.ranges[0];
      const high = low === null ? null : highPcOf(die, low);
      rows.push({
        unit: unit.index,
        offset: candidate.offset,
        name: name.value,
        linkageName: linkage.value,
        lowPc: optionalHexAddress(low ?? first?.low),
        highPc: optionalHexAddress(high ?? first?.high),
        ranges: found.ranges.slice(0, 16).map((range) => ({
          low: hexAddress(range.low),
          high: hexAddress(range.high),
        })),
        rangeCount: found.total,
        rangesTruncated: found.truncated,
        declFile: declFile.value,
        // The file number belongs to the unit that declared it, which may not be this one.
        declFileName:
          declFile.value === null
            ? null
            : (this.#fileNames(declFile.source.unit).get(declFile.value)
                ?.path ?? null),
        declLine: declLine.value,
        external: external.value === true,
        nameFromOrigin: name.value !== null && name.viaOrigin,
      });
    }
    return rows;
  }

  /** The unit's line table header, a problem, or null when the unit declares no line table. */
  lineTable(
    unit: UnitHeader,
  ): { readonly header: LineHeader } | { readonly problem: string } | null {
    const summary = unitDie(this.reader, unit);
    if (summary === null) return null;
    const stmtList = countAttr(summary.die, DW_AT.stmt_list);
    if (stmtList === null) return null;
    return this.#lineHeader(
      unit,
      stmtList,
      stringAttr(summary.die, DW_AT.comp_dir),
    );
  }
}

export const runUnitLines = (
  reader: UnitReader,
  header: LineHeader,
  visit: (row: LineRow) => boolean | void,
): void => runLineProgram(reader.sections, header, visit);
