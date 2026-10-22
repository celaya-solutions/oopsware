import {
  debugSymbolsReportSchema,
  inspectDebugSymbolsInputSchema,
} from "../../domain/debugSymbols/debugSymbols.js";
import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";

/** ELF and Mach-O debug files with DWARF (format expansion F10, part 1), read in process. */
export const DEBUG_SYMBOLS_TOOL_CONTRACTS = [
  {
    name: "inspect_debug_symbols",
    ...toolContractMetadata("inspect_debug_symbols"),
    kind: "artifact-provider",
    description:
      "Read one explicit local debug file from its bytes: an ELF file (a .debug file or a binary carrying DWARF), a Mach-O file (thin or universal) or a .dSYM bundle directory, without running a binary, contacting a symbol server or debuginfod, or reading any source file. Returns each image (ELF file or Mach-O architecture slice) with its identifiers (Mach-O LC_UUID, ELF GNU build id, .gnu_debuglink name and CRC-32, .gnu_debugaltlink), whether DWARF is readable (object files, split DWARF and stripped files are named, not guessed at) and its debug sections with compressed and decompressed sizes. With binary, each debug image is paired with the binary image of the same architecture by identifier only: a unique identifier match is strong, a debug link CRC-32 match alone is weak, a mismatch or a missing identifier never enriches, and a same-named file is not a match. Then one view of the selected image: units (compilation units with producer, language, address range, line table reference and counts of functions, inlined calls, variables and types), functions (every function with code: name resolved through specification and abstract-origin DIEs, linkage name, address ranges, declaration file and line), or lines (one unit's line table rows with file paths). DWARF 2 to 5, 32- and 64-bit DWARF, zlib and zstd compressed sections. Types, variables and location expressions are counted but not described; PDB files are not read yet.",
    inputSchema: inspectDebugSymbolsInputSchema,
    outputSchema: evidenceResultOf(debugSymbolsReportSchema),
    examples: [
      {
        title: "List the compilation units of a dSYM bundle",
        input: { path: "/artifacts/App.app.dSYM" },
      },
      {
        title: "Check an ELF debug file against the binary it should describe",
        input: {
          path: "/artifacts/app.debug",
          binary: "/artifacts/app",
          view: "functions",
        },
      },
      {
        title: "Read one unit's line table",
        input: {
          path: "/artifacts/App.app.dSYM",
          view: "lines",
          unit: 0,
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
