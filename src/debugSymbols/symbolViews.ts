import {
  AnalysisCancelledError,
  AnalysisInputError,
} from "../domain/analysisErrorCore.js";
import type {
  DebugSymbolsReport,
  InspectDebugSymbolsInput,
  SymbolDiagnostic,
} from "../domain/debugSymbols/debugSymbols.js";
import { DebugFormatError, hexAddress } from "./byteReader.js";
import {
  FunctionIndex,
  runUnitLines,
  summarizeUnit,
  type FunctionRow,
  type UnitSummary,
} from "./dwarfSymbols.js";
import type { LineRow } from "./dwarfLines.js";
import type { UnitHeader, UnitReader } from "./dwarfUnits.js";
import { OPERATION } from "./source.js";

export interface ViewPage {
  readonly total: number;
  readonly returned: number;
  readonly next: number | null;
  readonly units: DebugSymbolsReport["units"];
  readonly functions: DebugSymbolsReport["functions"];
  readonly lineFiles: DebugSymbolsReport["line_files"];
  readonly lines: DebugSymbolsReport["lines"];
}

const empty = (): Pick<
  ViewPage,
  "units" | "functions" | "lineFiles" | "lines"
> => ({
  units: [],
  functions: [],
  lineFiles: [],
  lines: [],
});

const next = (start: number, returned: number, total: number): number | null =>
  start + returned < total ? start + returned : null;

const unitRow = (unit: UnitSummary): DebugSymbolsReport["units"][number] => ({
  index: unit.index,
  offset: unit.offset,
  version: unit.version,
  unit_type: unit.unitType,
  address_size: unit.addressSize,
  offset_size: unit.offsetSize,
  name: unit.name,
  comp_dir: unit.compDir,
  producer: unit.producer,
  language: unit.language,
  low_pc: unit.lowPc,
  high_pc: unit.highPc,
  has_ranges: unit.hasRanges,
  stmt_list: unit.stmtList,
  dwo_name: unit.dwoName,
  dwo_id: unit.dwoId,
  counts: unit.counts,
  problem: unit.problem,
});

const functionRow = (
  row: FunctionRow,
): DebugSymbolsReport["functions"][number] => ({
  unit: row.unit,
  offset: row.offset,
  name: row.name,
  linkage_name: row.linkageName,
  low_pc: row.lowPc,
  high_pc: row.highPc,
  ranges: [...row.ranges],
  range_count: row.rangeCount,
  ranges_truncated: row.rangesTruncated,
  decl_file: row.declFile,
  decl_file_name: row.declFileName,
  decl_line: row.declLine,
  external: row.external,
  name_from_origin: row.nameFromOrigin,
});

const unitInput = (
  index: number | undefined,
  units: readonly UnitHeader[],
): UnitHeader => {
  const unit = index === undefined ? undefined : units[index];
  if (unit === undefined)
    throw new AnalysisInputError(OPERATION, undefined, [
      {
        path: ["unit"],
        reason: "out_of_range",
        message: `The image has ${units.length} compilation units, numbered from 0.`,
      },
    ]);
  return unit;
};

/** Rows of the requested view for one image whose DWARF was read. */
export const readView = (
  reader: UnitReader,
  units: readonly UnitHeader[],
  input: InspectDebugSymbolsInput,
  diagnostics: SymbolDiagnostic[],
  signal: AbortSignal | undefined,
): ViewPage => {
  const alive = () => {
    if (signal?.aborted === true) throw new AnalysisCancelledError(OPERATION);
  };
  const { start, limit } = input;
  if (input.view === "units") {
    const rows = units.slice(start, start + limit).map((unit) => {
      alive();
      return unitRow(summarizeUnit(reader, unit));
    });
    for (const row of rows)
      if (row.problem !== null)
        diagnostics.push({
          location: `unit ${row.index}`,
          message: row.problem,
        });
    return {
      ...empty(),
      total: units.length,
      returned: rows.length,
      next: next(start, rows.length, units.length),
      units: rows,
    };
  }
  const index = new FunctionIndex(reader, units);
  if (input.view === "functions") {
    const targets =
      input.unit === undefined ? units : [unitInput(input.unit, units)];
    const rows: DebugSymbolsReport["functions"] = [];
    let seen = 0;
    for (const unit of targets) {
      alive();
      let found: FunctionRow[];
      try {
        found = index.functions(unit);
      } catch (cause) {
        if (!(cause instanceof DebugFormatError)) throw cause;
        diagnostics.push({
          location: `unit ${unit.index}`,
          message: cause.message,
        });
        continue;
      }
      for (const row of found) {
        if (seen >= start && rows.length < limit) rows.push(functionRow(row));
        seen += 1;
      }
    }
    return {
      ...empty(),
      total: seen,
      returned: rows.length,
      next: next(start, rows.length, seen),
      functions: rows,
    };
  }
  const unit = unitInput(input.unit, units);
  let table: ReturnType<FunctionIndex["lineTable"]>;
  try {
    table = index.lineTable(unit);
  } catch (cause) {
    if (!(cause instanceof DebugFormatError)) throw cause;
    table = { problem: cause.message };
  }
  if (table === null || "problem" in table) {
    diagnostics.push({
      location: `unit ${unit.index}`,
      message:
        table === null
          ? "The unit declares no line table."
          : `The line table could not be read: ${table.problem}`,
    });
    return { ...empty(), total: 0, returned: 0, next: null };
  }
  const names = new Map(table.header.files.map((file) => [file.index, file]));
  const rows: DebugSymbolsReport["lines"] = [];
  const used = new Set<number>();
  let seen = 0;
  const collect = (row: LineRow): void => {
    if (seen >= start && rows.length < limit) {
      used.add(row.file);
      rows.push({
        address: hexAddress(row.address),
        op_index: row.opIndex,
        file: row.file,
        file_path: names.get(row.file)?.path ?? null,
        line: row.line,
        column: row.column,
        is_stmt: row.isStmt,
        basic_block: row.basicBlock,
        end_sequence: row.endSequence,
        prologue_end: row.prologueEnd,
        epilogue_begin: row.epilogueBegin,
        isa: row.isa,
        discriminator: row.discriminator,
      });
    }
    seen += 1;
  };
  try {
    runUnitLines(reader, table.header, collect);
  } catch (cause) {
    if (!(cause instanceof DebugFormatError)) throw cause;
    diagnostics.push({
      location: `unit ${unit.index}`,
      message: `The line program stopped early: ${cause.message}`,
    });
  }
  return {
    ...empty(),
    total: seen,
    returned: rows.length,
    next: next(start, rows.length, seen),
    lineFiles: [...used]
      .sort((a, b) => a - b)
      .flatMap((fileIndex) => {
        const file = names.get(fileIndex);
        return file === undefined
          ? []
          : [{ index: file.index, path: file.path, md5: file.md5 }];
      }),
    lines: rows,
  };
};
