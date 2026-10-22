```text
Document:    WebAssembly inspection (format expansion F01)
Version:     v1.1.1
Author:      Celaya Solutions
Contact:     hello@celayasolutions.com
Date:        2026-10-21
SHA256:      03d3187a48198514c8ad30353021c4704e351781eb8348aac23b39faa60ee62e
Chain:       solana-mainnet
Tx:          kCQkix2xSuiVcQCWixuKwEyibrJfLCtyckEne1T38VH5fYHHCsarPYhKpiDyir8YyuJJt4Utn3eGMWf7f2ZxDMH
License:     All Rights Reserved / Celaya Solutions
```

# WebAssembly inspection

Four tools cover format expansion F01 (milestone P2). They read one explicitly
selected local file and never instantiate it: no start function runs, no import
is resolved, nothing is fetched.

| Tool (MCP / CLI)                                  | Answers                                                                                                                                                                                                                              |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `inspect_wasm_module` / `inspect-wasm-module`     | What is in this module: validation, sections with byte ranges, types, imports, tables, memories, globals, exports, start function, element and data segments, module name, producers, and a page of functions with their call edges. |
| `inspect_wasm_function` / `inspect-wasm-function` | What one function does: params and locals, a page of instructions with offsets and nesting depth, every direct call, and every `call_indirect` with its candidate targets.                                                           |
| `convert_wasm_to_text` / `convert-wasm-to-text`   | The WebAssembly text (WAT) of a module, written to a new file as a labelled derived output.                                                                                                                                          |
| `convert_wasm_to_c` / `convert-wasm-to-c`         | The C translation of a core module by an installed, digest-pinned wabt `wasm2c`, returned inline with its header and three checks.                                                                                                   |

```sh
oopsware inspect-wasm-module ./app.wasm --json
oopsware inspect-wasm-module ./app.wasm --start 200 --limit 200 --json
oopsware inspect-wasm-function ./app.wasm 12 --json
oopsware inspect-wasm-module ./module.txt --read-as text --json
oopsware convert-wasm-to-text ./app.wasm ./app.derived.wat --json
oopsware convert-wasm-to-c ./app.wasm --module-name app --json
```

MCP input: `path` (absolute), optional `format` (`binary` or `text`; the CLI
spells it `--read-as` because `--format` selects the CLI output format),
`start`, `limit` (functions: 1–2000, default 200; instructions: 1–10,000,
default 1000), `function_index` for the function tool, `output_path` (absolute,
must not exist) for the conversion, and `max_file_bytes` (default 64 MiB, at
most 256 MiB).

## How a file is read

- **Binary or text.** Bytes that start with `\0asm` are a binary; otherwise a
  `.wat` or `.wast` name means text; otherwise pass `format`. A text file is
  assembled by wabt.js into a separate derived module. Its digest is reported
  in `source.derived_binary` and every offset refers to that derived module,
  not to lines of the text. The original text is never rewritten.
- **Core module or component.** The preamble decides. Components
  (`version 0x0d`, layer 1) are identified and named, not decoded.
- **Validation.** wabt.js validates against WebAssembly 2.0 (including SIMD)
  plus tail calls. A module that only validates with a newer proposal enabled
  is reported as `requires-proposal`, not `invalid`.
- **Sections.** Every section boundary is walked. LEB128 values and lengths are
  bounded by the section they sit in; a malformed section is recorded with its
  exact offset and the next boundary is still read. A section header that
  cannot be read stops decoding, and the facet says what was not examined.
- **Instructions.** Decoded for WebAssembly 2.0 without SIMD, plus tail calls
  (MVP, sign extension, non-trapping conversions, bulk memory, reference
  types, multi-value). A body that uses SIMD, exception handling, GC, threads,
  typed function references or multi-memory stops at its first such
  instruction with the proposal's name; the rest of the module is still read.
  Mnemonics are checked against WABT's own rendering in the tests.
- **Names.** Function names come from the module's `name` section. When it has
  none, an export or import name is used and labelled as borrowed
  (`name_source`); otherwise the function stays unnamed. Names are never
  generated. DWARF custom sections are listed with their ranges but not read.

## Indirect calls

`call_indirect` sites list the functions that can be reached through that
table with a matching signature: the function entries that element segments
place in the table. The `state` says how far to trust the list:

- `static`: the table is neither imported, exported nor written by code, and
  every element offset and item is a constant. The list is complete.
- `partial`: the listed candidates are real, but the host (an exported table)
  or code in the module (`table.set`, `grow`, `fill`, `init`, `copy`) can add
  others, or an element offset is only known at instantiation. `reasons`
  names each cause.
- `unknown`: the table is imported, so its contents come from the host.

Targets are never invented: an empty `static` list means the call traps if
executed.

## Derived text

`convert_wasm_to_text` renders WAT with wabt.js and creates the output file
exclusively; an existing path is refused and a failed write leaves no file.
The result records the output's SHA-256 next to the original's
(`derived_from`), whether names came from the name section or items print as
indices, and the validation outcome. WAT is a rendering of the binary, not
recovered source.

## Translating a module to C

`convert_wasm_to_c` hands one core module to wabt's `wasm2c` and returns the C
file and its header inline. It is a mechanical translation: the C keeps the
module's control flow, locals and linear memory and calls wabt's runtime
(`wasm-rt.h`). It is labelled `derived` (Evidence confidence and each file's
`confidence`), with `derived_from` the SHA-256 of the module handed to wasm2c;
it is not recovered source.

- **Bring your own, pinned by digest.** wasm2c is looked for only at
  `/opt/homebrew/bin`, `/usr/local/bin` and `/usr/bin`, never on `PATH`. It
  runs only when the SHA-256 of the resolved file is admitted
  (`src/wasm/wasm2c.ts`): Homebrew wabt 1.0.42_1 for macOS arm64. Any other
  build is reported as unavailable with its path and digest. `brew install
  wabt` installs it; `convert_wasm_to_text` still gives the WAT without it.
- **Input.** `path`, optional `format` (a `.wat` file is assembled by wabt.js
  first and that derived module is translated; `source.derived_binary` names
  it), `module_name` (the C identifier wasm2c prefixes to every symbol, `-n`;
  default the module's own name, else the file name, else `module`), `check`
  (default true), `timeout_ms` (default 60 s, also used for the compile
  check), `max_source_bytes` (C plus header, default 8 MiB, at most 64 MiB;
  larger output is refused, not cut) and `max_file_bytes`.
- **Isolation.** The module is copied to a private `oopsware-wasm2c-*`
  scratch directory, wasm2c runs there with an empty environment and a
  timeout in its own process group, and the scratch is removed afterwards.
  Its path is removed from every message. Nothing is instantiated, linked or
  run.
- **Refusals.** Components and non-modules are refused before wasm2c runs. A
  module wasm2c rejects (threads, GC, typed function references and other
  proposals it does not enable by default, or invalid code) is an
  unsupported target carrying wasm2c's message.
- **Checks.** `wasm2c_succeeded`: wasm2c exited 0 without printing anything
  (printed lines are kept in `messages`). `compiles`: clang
  `-fsyntax-only -I <wabt include>` on the output, with an empty environment;
  clang comes from Homebrew LLVM (`/opt/homebrew/opt/llvm`,
  `/usr/local/opt/llvm`) or `/usr/bin/clang` (on macOS only when the Command
  Line Tools or Xcode are installed). Clang errors are listed in
  `compile_errors`; no clang, or a clang that stops without a compiler error,
  is `not_checked`. `exports_match`: every function export of the module (from
  this reader's own decoder) against the exported functions the header
  declares. wasm2c escapes every byte it cannot keep as `0xHH` (and a literal
  `0x` before a hex digit), but names such as `00x41` are ambiguous in
  wasm2c 1.0.42. The conservative decoding can report a false mismatch.
  Names are compared as a multiset; missing and extra names are listed. Coverage
  `reconstruct` is `complete` only when all three pass. A check that fails or
  cannot run never hides the text.

Missing required headers, including `simde/wasm/simd128.h` for SIMD output,
make `compiles` `not_checked` and name the missing header. Real C syntax
errors remain `failed`. `max_source_bytes` is checked after wasm2c exits;
it bounds returned source, not the temporary output written to disk while
wasm2c runs.

A passed `compiles` check means clang accepts the syntax against wabt's
runtime header; it does not link the runtime or prove the C behaves like the
module.

## Public library

Uploaded originals that start with the WebAssembly magic bytes are decoded once
by the analysis worker in a separate process (384 MiB heap, 3 minutes), up to
32 MiB. The page shows a Module tab (facts, imports, exports, memories, data
segments, sections), a Functions tab (first 20,000 functions, 500 per page),
Problems and Bytes, plus a "Download derived text (.wat)" link next to the
original download. Routes, all by fixed IDs:

- `GET /api/submissions/<id>/wasm` — the stored module report (the upload
  name stands in for any storage path).
- `GET /api/submissions/<id>/wasm/functions/<page>` — one page of functions.
- `GET /api/submissions/<id>/outputs/module.wat` — the derived WAT, as an
  attachment named `<name>.derived.wat`.

WebAssembly text uploads, modules inside archives and modules over 32 MiB keep
the byte preview. Instruction pages and indirect-call candidates are available
in the CLI and MCP tools, not on the public page.

## Verification

- `src/wasm/webAssemblyReports.test.ts`: WABT-built modules (imports, exports,
  memory, data, direct and indirect calls), mnemonics against WABT's
  rendering, a truncated module, overlong and overflowing LEB128, an
  exception-handling module, a SIMD body, a module without names, an empty
  component, exported and written tables, paging.
- `tests/acceptance/applications/webAssembly.test.ts`: the compiled CLI and
  real stdio MCP return identical Evidence; advertised schemas validate; WAT
  input; derived WAT digest and refusal to overwrite; `convert_wasm_to_c`
  when an admitted wasm2c is installed; explicit errors.
- `src/wasm/wasmToC.test.ts`: real wasm2c and clang on wabt-assembled modules
  (escaped export names, all checks passed, WAT input, `check: false`, a
  checker that fails, clang errors, a threads module wasm2c refuses,
  `max_source_bytes`); the name decoding against names observed in real
  wasm2c headers. Skipped without an admitted wasm2c.
- `tests/boundary/web/hosted.test.ts`: upload to report, function pages,
  derived WAT download bound to the original digest, a truncated module, a
  component, and no view for non-WebAssembly uploads.
- `scripts/verify-hosted-catalog.mjs`: the page in a real browser, including a
  hostile string in a data segment that stays text and is never executed.
- `npm run verify:formats:wasm`: a module compiled by the installed Rust
  toolchain (`wasm32-unknown-unknown`) with a trait-object call, through the
  CLI. Reports `unavailable` when rustc or the target is missing. It also
  translates the `-O` and `opt-level=0` builds to C and reports the check
  counts (both passed all three checks on 2026-10-21); it fails only when a
  result disagrees with itself, never on wasm2c's or clang's verdict.

Not covered: SIMD and newer-proposal instruction decoding, component
decoding, DWARF, source-like decompilation (`wasm-decompile`), `.wast` script
commands beyond a single module, WebAssembly text on the public site, C
translation on the public site, wasm2c builds other than the admitted one
(Linux, Intel macOS), and linking or running the generated C.
