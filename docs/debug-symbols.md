```text
Document:    Debug symbols inspection (format expansion F10, part 1)
Version:     v1.0.0
Author:      Celaya Solutions
Contact:     hello@celayasolutions.com
Date:        2026-10-21
SHA256:      5b7f86e1edbaac9abc43618904cb5989f870c4c5a7ee9db67807c6eb43587208
Chain:       solana-mainnet
Tx:          4hMoKKRbY7wK1BKrZuZ5J8c6J7a9Cp2rzdYHhVcyMAUeiUvmhBCKJ93UQx3xob4sy4CVJekzkrgbCkNVDR2S2n2T
License:     All Rights Reserved / Celaya Solutions
```

# Debug symbols inspection

Format expansion F10 reads debug symbols from their bytes. Part 1 covers **DWARF 2 to 5 in ELF files and Mach-O files (thin or universal) and `.dSYM` bundles**. PDB is part 2 and is not read yet. Nothing is run, no symbol server, debuginfod server, source server or source file is contacted or read, and a binary is never modified.

| Tool (MCP / CLI)                                  | Answers                                                                                                                                                                                                                                              |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inspect_debug_symbols` / `inspect-debug-symbols` | Which images a debug file holds, their identifiers, whether DWARF is readable, whether the file pairs with an explicitly supplied binary, and one view of the selected image: compilation units, functions with code, or one unit's line table rows. |

```sh
oopsware inspect-debug-symbols ./App.app.dSYM --json
oopsware inspect-debug-symbols ./app.debug --binary ./app --view functions --json
oopsware inspect-debug-symbols ./App.app.dSYM --view lines --unit 0 --json
oopsware inspect-debug-symbols ./Universal.dSYM --architecture arm64 --json
```

## What it reads

- **ELF**: a `.debug` file made by `objcopy --only-keep-debug`, a binary that still carries DWARF, shared objects. 32- and 64-bit, either byte order. Sections stored `SHF_COMPRESSED` (zlib or zstd) and GNU `.zdebug_*` sections are decompressed in process.
- **Mach-O**: the DWARF file inside a `.dSYM` bundle (`Contents/Resources/DWARF/<name>`), a thin file or a universal file (each architecture is one image). Mach-O `__DWARF` sections are read as they are stored.
- **`.dSYM` bundle directory**: every regular file under `Contents/Resources/DWARF` (up to 64) is read. `Contents`, `Resources` and `DWARF` must be real folders (a link is refused, never followed), and a hidden file (Finder's `._name`, `.DS_Store`) or a file that is not ELF or Mach-O is left out and listed in `diagnostics` instead of failing the bundle. `Info.plist` is not read.

## Identifiers and pairing

Each image reports the identifiers it carries:

| Format | Identifier                                               | Strength                         |
| ------ | -------------------------------------------------------- | -------------------------------- |
| Mach-O | `LC_UUID`                                                | strong                           |
| ELF    | `NT_GNU_BUILD_ID` note                                   | strong                           |
| ELF    | `.gnu_debuglink` name and the CRC-32 of the debug file   | weak (a CRC-32 can collide)      |
| ELF    | `.gnu_debugaltlink` (dwz supplementary file name and id) | reported; the file is never read |

With `binary`, each debug image is compared with the binary image of **the same architecture** (a single-image binary is used when no architecture matches, so a wrong-architecture binary is reported as a mismatch rather than skipped). The checks are listed in the report with what each side holds. The verdict:

- `matched` / `strong`: the UUID or build id is the same in both files.
- `matched` / `weak`: no unique identifier could be compared, and only the debug link CRC-32 matches the debug file's bytes.
- `mismatched`: the format, the architecture, the UUID or the build id differ, or the only identifier available (the CRC-32) differs.
- `unverified`: no identifier is carried by both files. A same-named file is not a match.

`enrichment_allowed` is true only for `matched`. A mismatched or unverified file is still inspected on its own; nothing in the report says its names belong to the binary. If a build id matches but the debug link CRC-32 does not (for example after recompression), the CRC check is listed as mismatched and the strong match still decides; the note says why.

## DWARF state

`dwarf.state` says what could be read, so an empty result is never mistaken for an empty file:

- `dwarf`: units were read.
- `none`: no `.debug_info` (a stripped binary; if it has a `.gnu_debuglink`, the reason names the separate debug file) or its bytes were removed from the file.
- `relocatable-object`: an object file's DWARF depends on relocations that this reader does not apply, so addresses and references would be wrong. Link the program, or read the linked image or its dSYM.
- `split-dwarf`: the DWARF is in `.dwo` or `.dwp` files that are not read.
- `unreadable`: a section could not be decompressed or read (the reason says which, and a decode budget names `max_decoded_bytes`).

## Coverage

`coverage` states which view and which rows the call read (for example `units` rows 0 to 100 of 483) and, when more exist, `continuation` gives the `start` to pass. A call that returns the `units` view has not read functions or line tables.

## Views

- `units`: one row per compilation unit: offset, DWARF version, unit type, address and offset sizes (8-byte offsets mean 64-bit DWARF), name, `comp_dir`, producer, language, `low_pc`/`high_pc`, whether it uses ranges, the line table offset, and counts of DIEs, functions, declarations, inlined calls, variables and types. A unit whose DIEs fail to decode carries the reason.
- `functions`: every function that has code (subprograms with `low_pc` or ranges; declarations are counted in the unit row and not listed). The name is resolved through `DW_AT_specification` and `DW_AT_abstract_origin` (C++ methods, inlined functions; `name_from_origin` says so), with the linkage name, address ranges (`ranges` lists up to 16; `range_count` counts non-empty ranges up to 4,096 and `ranges_truncated` says more existed), declaration file and line. A file number belongs to the unit that declared it, so a name taken from another unit's DIE takes its file from that unit's line table. `unit` limits the list to one unit.
- `lines`: one unit's line table (`unit` is required): address, file index and path, line, column, `is_stmt`, `basic_block`, `end_sequence`, `prologue_end`, `epilogue_begin`, ISA, discriminator, VLIW op index. `line_files` lists the files the returned rows use. Rows follow the DWARF line program exactly, checked against `llvm-dwarfdump --debug-line`.

All three page with `start` and `limit`; `total` is the full count and `page.next` continues.

## Limits

- A file is read into memory (`max_file_bytes`, default 256 MiB, up to 1 GiB; a dSYM bundle shares one budget). Compressed sections are decompressed against `max_decoded_bytes` (default 512 MiB, up to 2 GiB); when it runs out the image is `unreadable` with coverage `partial` and a continuation naming the limit.
- Decoding is synchronous and bounded by work, not by time: a call takes at most 50 million decoding steps (DIEs, abbreviation declarations and attributes, range list entries) and lists at most 500,000 units; past either, the rest is named in `diagnostics` and the unit rows. Abbreviation tables are not retained beyond the last 64, and range lists shared by many functions are read once. A report lists at most 200 diagnostics.
- Constants wider than a double stay exact (bigint) and are never reported as counts; a negative or oversized declaration line or file number is dropped to `null`, and line-program line numbers wrap to 32 bits as `llvm-dwarfdump` shows them. `DW_LNE_define_file` entries (DWARF 2 to 4) are not added to `line_files`.
- DWARF versions 2 to 5 in 32- and 64-bit formats. Types (`.debug_types`) and type units, location lists and expressions, macro tables, `.debug_names` and Apple accelerator tables are not decoded. `DW_FORM_strp_sup`, `GNU_strp_alt` and `.gnu_debugaltlink` files are not read.
- Types, variables, scopes, inlined call sites and location expressions are counted, not described. ELF `.symtab` and Mach-O `nlist` symbols are not listed (`has_symbol_table` says one exists); the native tools read them.
- A Mach-O debug map (object files named by `N_OSO` entries) is not followed, and an executable linked without `dsymutil` has no DWARF of its own to read.
- The hosted service does not read debug symbols.
- Fixtures: Apple clang and `dsymutil` (Mach-O and dSYM; DWARF 2, 3, 4 and 5; universal), the Go linker (linked ELF with zlib-compressed DWARF 5 and a chosen GNU build id) and `llvm-objcopy` (split `.debug` file, stripped binary, debug link). 64-bit DWARF, big-endian images, zstd and GNU `.zdebug` compression, range lists and unusual line programs are hand-assembled. No Windows or Linux-native producer exists on this host, so no ELF file made by GCC or by `ld` and no PDB has been read.

## Checks

- `src/debugSymbols/debugSymbols.test.ts`: units, functions (offset, low and high address, name) and every line row compared with `llvm-dwarfdump` for DWARF 2, 3, 4 and 5 dSYMs and for the Go ELF (59 units); the dSYM UUID against `llvm-dwarfdump --uuid`; universal dSYMs; pairing by UUID, build id and debug link CRC-32, mismatches, a same-named file with other bytes, a wrong architecture, a missing build id, a stripped binary, an object file, a PDB, budgets, truncated and damaged files, and mutated bytes (a seeded fuzz that allows only typed failures).
- `src/debugSymbols/syntheticDwarf.test.ts`: 64-bit DWARF, big-endian 32-bit ELF, zlib, zstd and GNU compression, range lists (v4 and v5, every entry kind), constants larger than a double, unknown forms and versions, a DWARF 2 line program, and build ids from sections and program headers.
- `tests/acceptance/applications/debugSymbols.test.ts`: the compiled CLI and the real stdio MCP return identical Evidence.
