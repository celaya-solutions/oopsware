---
name: reverse-engineer-anything
description: Reverse engineer native, managed, Electron/JavaScript, packaged, firmware, and browser targets with Oopsware. Use shipped-artifact or requested runtime evidence to explain features, compare versions, decompile code, or guide a reconstruction. Skip Oopsware for ordinary source-repository architecture analysis.
metadata:
  version: "57"
---

```text
Document:    Oopsware Agent Skill
Version:     v1.20.1
Author:      Celaya Solutions
Contact:     hello@celayasolutions.com
Date:        2026-10-22
SHA256:      2f91d37c8f6977b7ca87871415fad5b642f6d2bee41f32793323bb569f9677fb
Chain:       solana-mainnet
Tx:          2LvEUpbqD7zTkju3vzTkkd7QJ5Ah96LGLSgwEds5cTin32AGG1KSnQTg9r8ADPLxvqmBpEvDz1PkGoiTJ7QHAjQc
License:     All Rights Reserved / Celaya Solutions
```

# Oopsware

Use Oopsware when a claim depends on a shipped binary or package, decompilation,
passive application runtime evidence, or comparison with
behavior not established by available source. For ordinary analysis of a
complete source repository, use normal repository tools and do not run Oopsware
readiness or provider commands.

## Connect only when needed

Installing this skill supplies instructions; it does not register the Oopsware MCP
server, install analysis engines, or add tools to an already-running agent.

If Oopsware tools are available and their registration is not known to be stale,
proceed directly to the target. Do not run diagnostics or setup before every
investigation. Use the connected server's actual tool list and input schemas;
a skill installed from repository main may describe capabilities absent from
an older npm release. Keep complete inline Evidence when that server does not
advertise retained references.

If tools are absent, a call is blocked by the client, or a required provider is
unavailable, read [connection and recovery](references/connection-and-recovery.md).
Diagnose the observed blocker, continue useful supported work, and resume the
original task after repair. Client approval, shell PATH, registration and engine
availability have different remedies; avoid repeating setup for all of them.
If the host times out without an Oopsware result, do not repeat the unchanged call or
assume work stopped. Read the recovery guide's deadline distinction before retrying.

Prefer an existing `oopsware` CLI. The `rea` alias remains compatible.
Oopsware currently builds from source: use `node scripts/oopsware.mjs` from
the CSR checkout after `npm ci` and `npm run build:cached`. Do not assume
that the scoped npm package has been published.

1. Diagnose without changing Oopsware or client configuration. For Codex, run
   `node scripts/oopsware.mjs doctor --client codex --json`. Substitute the current
   supported client: `claude_code`, `claude_desktop`, `codex`, `cursor`,
   `gemini_cli`, `windsurf`, `devin`, `opencode`, `antigravity`, `copilot_cli`,
   `commandcode`, `vscode`, `grok_build`, `omp`, or `grok_bot`. `grok_bot` has no local
   file registration: doctor reports the Grok Bot chat step, and setup does not
   write `mcp.json`. If the client is unknown, use `doctor --json` and
   inspect its registration results before choosing a setup scope.
2. Distinguish the reason. Missing, malformed, or stale registration needs a
   scoped configuration repair. An aligned registration with no tools in the
   active session needs a restart/reconnection; doctor cannot prove that the
   current agent has connected. A missing provider affects only tasks requiring
   that provider: static JavaScript inspection needs neither Hopper nor Ghidra,
   and Android inspection has separate bring-your-own JADX/Java prerequisites.
3. For a configuration repair, prepare the read-only plan:
   `node scripts/oopsware.mjs setup --client codex --dry-run --json`.
   Use the current client's ID, show its exact proposed paths, backups, and
   changes, and obtain approval before setup writes configuration or installs
   Hopper. Setup normally installs the matching bundled skill too; include that
   replacement in the reviewed plan. After approval, apply the same scope with
   `node scripts/oopsware.mjs setup --client codex --yes`. Add `--install-hopper`
   only if that separate installation was needed and explicitly approved.
4. Restart/reconnect the affected agent. Verify that Oopsware tools actually appear
   in the session, then resume the original investigation. If they remain
   absent, inspect the client's MCP launch error rather than repeating setup.

Oopsware setup never installs or upgrades Node.js, npm, Homebrew, Java, Ghidra, IDA,
JADX, Kuna, Binwalk, or Unblob. Use existing prerequisites; do not install unrelated
software to repair
MCP registration. For an unsupported client, use manual stdio registration
running `node` with the absolute path to `scripts/oopsware.mjs` and the `mcp`
argument, or continue through the CLI.

A concrete CLI fallback for an operator-supplied JavaScript tree or ASAR is:

```bash
node scripts/oopsware.mjs analyze-javascript-application /absolute/path/to/app --json
```

No MCP registration or native engine is required. Read the returned Evidence,
graph, limitations, and unknowns with the same care as an MCP result; the CLI
returns the Evidence record directly. This fallback does not establish that
MCP is configured. Native CLI tasks still require their selected engine.
Configuration repair starts with a read-only setup plan; show paths, backups and
skill replacement before applying authorized changes. Preserve existing approval
and target-execution boundaries. Oopsware setup never installs or upgrades unrelated
software, including Node.js, npm, Homebrew, Java, Ghidra, IDA, JADX, Kuna, Binwalk or Unblob.

## Route the target first

Choose the first tool from the target the user supplied. Use `open_binary` for
active-target native or archive workflows; target-free tools take their own
explicit path or endpoint and do not need it.

- Unknown local file, download, folder or drive ("what is this?"):
  `identify_artifact` with the path. One call detects the format from bytes,
  runs the built-in reader that owns it for a headline, opens nested archives
  (depth 3 by default for a file, 0 for a folder) and tallies a folder by
  format; its `next_steps` give the exact deeper calls, with `open_first` when
  the file must be opened with `open_binary` first. Readers run on one piece of
  each format within `max_readers`. See the
  [identification guide](https://github.com/celaya-solutions/oopsware/blob/main/docs/identification.md).
- Package inventory and licenses: `generate_sbom` on an explicit file or
  directory. `check_vulnerabilities` reads its saved Evidence or CycloneDX
  JSON against an explicitly supplied offline OSV snapshot. Missing coverage
  stays unknown. `verify_artifact_signature` checks local JAR, Authenticode,
  Apple-file or wheel integrity separately from caller-selected trust; offline
  revocation and notarization remain unchecked. See
  [supply-chain checks](https://github.com/celaya-solutions/oopsware/blob/main/docs/supply-chain.md).
- ASAR or extracted JavaScript/Electron tree:
  `analyze_javascript_application`.
- Archive/package member inventory (ZIP/APK/IPA/MSIX/AppX, DEB/RPM/AppImage, MSI or DMG):
  `open_binary` with the supplied local path; use `inspect_artifact` when its
  graph and findings help answer the question.
- Android APK code, classes, methods, or incoming references:
  `inspect_android_package`, then focused Android tools when advertised.
  Archive member inventory still uses the archive route above. For DEX
  files, App Bundles, split APK sets and XAPKs, or exact DEX descriptors and
  Dalvik bytecode, use `inspect_android_artifact` and the DEX tools below.
- Managed PE/CLI assembly: `inspect_managed_artifact`; inferred C# for one
  type (`Outer+Inner` for nested) with `decompile_managed_type` from the
  installed, pinned ilspycmd (pass dependency folders as `reference_paths`;
  read its `checks`).
- Firmware image: `inspect_firmware_regions` when advertised. Use
  `extract_firmware` when extraction is requested, with a caller-selected new
  absolute output directory. These tools use caller-supplied Binwalk/Unblob on
  Linux; see the [firmware guide](https://github.com/celaya-solutions/oopsware/blob/main/docs/firmware-analysis.md).
- .NET NativeAOT PE/ELF: native Ghidra analysis. Native code can yield pseudocode;
  consult the NativeAOT workflow in `references/native-and-artifacts.md` for
  optional metadata recovery and its supported host/layout boundary.
- User-owned browser page already open: `list_browser_targets`.
- Browser action the agent must perform (click, type, navigate):
  `capture_browser_scenario` with declared actions. See
  [runtime observation](references/runtime-observation.md) for connect/launch
  and the focused follow-up browser tools.
- Fiddler Everywhere traffic or a native `.saz` capture: read the
  [Fiddler workflow](references/runtime-observation.md#fiddler-everywhere-traffic-debugging).
  Inspect saved SAZ with `inspect_web_network_capture` and `format: "saz"`;
  connect Everywhere's separate MCP server for live traffic.
- Retained HAR/SAZ/native mitmproxy/aioquic qlog capture: `inspect_web_network_capture`. Select
  original record ordinals when useful; inspect producer fields and byte/number
  sidecars without fetching recorded URLs or claiming live attribution. See
  [historical captures](https://github.com/celaya-solutions/oopsware/blob/main/docs/web-network-captures.md) for the exact upstream
  profile and credential exclusions. Qlog support starts with aioquic 1.5.0
  JSON 0.3; stream coverage and endpoint loss declarations do not recover bodies
  or establish network loss. Prefer detail summary, then kind qlog trace/stream
  pages; select one trace, stream ID and direction for contribution/range pages.
  Facts retain all-recorded-events-before-selection scope. Other qlog layouts
  and PCAP correlation are unsupported.
- User-owned Electron runtime already open: `list_electron_targets`. Before an electron-main Inspector attempt, check packaged fuses with `inspect_electron_fuses`; disabled `EnableNodeCliInspectArguments` means the app ignores `--inspect`.
- Packet-field discovery: `inspect_packet_fields` searches installed protocols
  and field names/types before choosing fields for `inspect_packet_capture`.
  Query/page the relevant records; registrations do not establish observed traffic.
- Recorded packet captures: `inspect_packet_capture` with selected TShark fields,
  display filters and decode-as rules. Requires Linux, util-linux prlimit and `REA_TSHARK_COMMAND`; see
  [capture guide](https://github.com/celaya-solutions/oopsware/blob/main/docs/packet-captures.md).
  Packet limits count input packets before filtering. Output defaults to 50 matching
  frames; use `match_offset` / `match_limit` for later pages, or explicit null
  limit for complete matching output. Preserve the source digest across pages.
  This does not perform live capture.
  For address/DNS/SNI/protocol summaries use `inspect_pcap_capture` with MCP
  detail summary, then retained kind pcap pages. Requires Wireshark 4.x tshark
  and capinfos, with Linux prlimit or Windows Job Objects; see
  [packet summaries](https://github.com/celaya-solutions/oopsware/blob/main/docs/pcap-analysis.md).
  Select an exact DNS question for address pages; page exhaustion does not prove
  network completeness. This reads recordings and does not acquire traffic.
- Decoder discovery: `inspect_signal_decoders` searches installed decoder IDs
  or selected decoder help, including channels and options. Query and page the
  relevant details before choosing settings; this does not scan hardware.
- Recorded logic/signal traces: `decode_signal_recording` with explicit decoder,
  channel and protocol settings. On Linux with util-linux prlimit, supply sigrok-cli 0.7.2 through
  `REA_SIGROK_COMMAND`; see [recording guide](https://github.com/celaya-solutions/oopsware/blob/main/docs/signal-recordings.md).
  Output defaults to 50 literal lines; select annotation classes and page with
  `line_offset` / `line_limit`, or explicit null for all remaining output.
  Window counts are display lines, not annotations or samples. Preserve source digests across pages.
  This reads existing files; it does not acquire hardware signals.
- Explicit local WebAssembly artifact: `inspect_wasm_artifact`. Supply WABT 1.0.42
  through `REA_WABT_BIN_DIRECTORY`; retain exact byte/tool identity and decoded WAT.
  Select JavaScript glue and candidate paths explicitly and preserve URL/path
  ambiguity. No implicit fetch or target execution; WAT is not original source.
  See the [WASM guide](https://github.com/celaya-solutions/oopsware/blob/main/docs/wasm-artifacts.md).
- Explicit local EVM bytecode carrier: `inspect_evm_interface` with caller-selected
  `raw` or `hex` encoding. Preserve carrier/decoded digests and treat selectors,
  argument strings and mutability as inferred candidates; this performs no chain
  lookup or target execution. For the complete inferred interface without hex or
  duplicate stdout, discover support and select `detail: "summary"`; complete
  Evidence stays retained under its original identity. Use the returned
  `parent_evidence_id` for exact function or `bytecode_hex`/stdout/stderr pages.
  Candidate coverage does not establish interface completeness. See the
  [EVM bytecode guide](https://github.com/celaya-solutions/oopsware/blob/main/docs/evm-bytecode.md).
- Embedded Go compiler, module or build-setting metadata: `inspect_go_binary`
  with the explicit local file. This built-in target-free inspection requires no
  Go installation or disassembler. Preserve raw module bytes and source ranges;
  absent metadata does not prove a binary is not Go, and unparsed text records
  remain explicit. See the
  [Go binary guide](https://github.com/celaya-solutions/oopsware/blob/main/docs/go-binaries.md).
- Bundled GGUF or safetensors model declarations: `inspect_model_artifact`
  with the explicit local file. Default header hashing leaves full-file identity
  unknown; `hash: "full"` additionally reads all weights for SHA-256. MCP returns
  retained summaries; optional `view` selects one page in the initial call. Use
  `inspect_analysis_view` kind `model-artifact` for
  batched metadata keys, tensor names or type totals, selected fields and pages.
  Preserve header-scoped indices and array preview omissions; do not infer model
  behavior from declared architecture or tensor types. See the
  [model file guide](https://github.com/celaya-solutions/oopsware/blob/main/docs/model-artifacts.md).
- Unity IL2CPP names, member owners and string literals from `global-metadata.dat`:
  `inspect_il2cpp_metadata` with the explicit local file; MCP defaults to compact
  counts. Query sections, images, types, methods, fields, properties, events,
  parameters or string_literals through `inspect_analysis_view`
  with the returned `parent_evidence_id`, using exact filters, batch indices and
  selected fields. Parameters accept `method_indices`, avoiding a scan of all
  parameter pages. Missing collections in historical Evidence remain unknown.
  Versions 24, 27, 29, 31 and 39; no Unity, IL2CPP
  binary or disassembler is run. Unrecognized magic (possibly encrypted) and
  other versions are unsupported. Optional matching `binary_path` enables static native addresses and type references; query `method_addresses` with indices or addresses/states, preserving every shared-body method and both artifact identities. Without a linked binary native counts remain unknown. Byte-pattern fallback is inferred; no runtime behavior or same-build pairing is proved. See the
  [IL2CPP metadata guide](https://github.com/celaya-solutions/oopsware/blob/main/docs/il2cpp-metadata.md).
- Embedded cargo-auditable Rust dependency metadata: `inspect_rust_binary`
  with the explicit local ELF, PE, or thin Mach-O file. This built-in
  target-free inspection requires no Rust installation or disassembler. Preserve
  package order, dependency indices, and the section file range. A missing
  `.dep-v0` section is null metadata, not proof the binary has no dependencies.
  A rustc commit hash is an inference from a read-only `/rustc/<40-hex>/` path.
  See the
  [Rust binary guide](https://github.com/celaya-solutions/oopsware/blob/main/docs/rust-binaries.md).

- Explicit local SQLite database snapshot: `inspect_sqlite_database`. Inspect
  with Node.js 24.x >=24.15 or 26+ providing native SQLite limits. Read schema
  first (compact inventory by default), or select an exact ordinary table
  and `columns` when rows are needed. Defaults are selected-table schema and
  20 rows; request `schema_scope: "database"` for the complete stored schema. Preserve both database and existing sibling WAL identity; row samples
  report truncation and come in rowid (or primary-key) order, so `offset` with
  the previous `next_offset` reads the next page of the same snapshot. For a
  join, count or filter the table view cannot express, `query_database_readonly`
  runs one `SELECT`/`WITH`/`VALUES` statement of yours on the frozen copy (local
  only; SQLite's authorizer refuses writes, `ATTACH`, `PRAGMA`, `VACUUM` and
  extensions); bind values with `parameters` (positional `?`/`?NNN` only), add
  `ORDER BY` when order matters and read `truncated`. Ask for `csv: "escaped"`
  when the rows will be opened in a spreadsheet. Use a
  quiescent snapshot rather
  than assuming a live database/WAL pair was copied atomically. See the
  [SQLite guide](https://github.com/celaya-solutions/oopsware/blob/main/docs/sqlite-databases.md).
- Explicit local structured-text document (Markdown, JSON, JSON Lines, YAML,
  TOML, XML, CSV/TSV or plain text): `inspect_document`. It returns paged
  structural nodes with line, column and byte locations, plus parse and
  encoding diagnostics; pass `format`, `encoding` or `delimiter` when the name
  misleads. Nothing is fetched, expanded, executed or rewritten. See the
  [structured-text guide](https://github.com/celaya-solutions/oopsware/blob/main/docs/structured-text.md).
- Explicit local WebAssembly module (`.wasm`) or text (`.wat`):
  `inspect_wasm_module` for validation, sections, imports, exports, data and a
  page of functions with call edges; `inspect_wasm_function` for one
  function's instructions, direct calls and `call_indirect` candidates
  (`static`, `partial` or `unknown`, never invented); `convert_wasm_to_text`
  to write derived WAT to a new file; `convert_wasm_to_c` for the C and header
  a pinned wabt `wasm2c` translates (derived, not source; read its `checks`:
  clang syntax check and exported functions). Nothing is instantiated. See the
  [WebAssembly guide](https://github.com/celaya-solutions/oopsware/blob/main/docs/webassembly.md).
- Explicit local JVM class file, JAR or AAR: `inspect_jvm_artifact` for the
  manifest, services, modules, signature files (not verified), entry digests,
  multi-release variants, embedded JARs, AAR manifest and JNI libraries and a
  page of classes; `inspect_jvm_class` for one class's members, annotations
  and attributes; `inspect_jvm_method` for one method's bytecode and
  references; `decompile_jvm_class` for inferred Java source from the
  installed Vineflower (check `untrusted_methods` and `decompiler_notes`
  before relying on it). Pass `release` for a multi-release JAR; the host JDK
  never chooses. No target class runs. See the
  [JVM guide](https://github.com/celaya-solutions/oopsware/blob/main/docs/jvm.md).
- Explicit local Python source, `.pyc`, wheel or zip application:
  `inspect_python_artifact` for the `.pyc` header, wheel metadata, entry
  points, RECORD digests (recomputed), licenses, native extensions, zipapp
  shebang and `__main__.py`, and a page of modules; `inspect_python_module`
  for one module's imports, definitions, calls and dynamic imports (source,
  parsed by an installed CPython's `ast` in an isolated process; pick the
  grammar with `python`) or its code objects (bytecode);
  `inspect_python_code` for one code object's instructions as its release's
  `dis` shows them; `decompile_python_code` for inferred source of a 2.7 or
  3.5-3.13 `.pyc` from the installed pycdc (read its `checks`: pycdc is weak
  on 3.9 and later, so the text is often incomplete). Bytecode decodes only
  for 3.9 and 3.11-3.15; other releases keep the header. Nothing is
  imported, installed or run. See the
  [Python guide](https://github.com/celaya-solutions/oopsware/blob/main/docs/python.md).
- Explicit local DEX, APK, App Bundle (`.aab`), split APK set (`.apks`) or
  XAPK: `inspect_android_artifact` for manifests (binary and proto),
  resource tables, bundle modules and delivery, `toc.pb` or `manifest.json`
  roles, missing or undeclared splits, signature material (never verified),
  DEX checksums and signatures recomputed, native libraries with their ELF
  machine, and a page of classes; pass `container` for one APK of a set.
  `inspect_dex_class` for one class's fields, values, methods and
  annotations with exact DEX descriptors; `inspect_dex_method` for one
  method's Dalvik instructions as `dexdump` renders them, handlers, lines,
  locals and references. A class defined in byte-different DEX files needs
  `container`/`entry`. `decompile_dex_class` for inferred Java source of one
  class without JADX: an owner-installed, digest-pinned dex2jar 2.4 converts
  its DEX file and the pinned Vineflower decompiles it (unavailable without
  both); check `checks` (`dex2jar_translated`, `vineflower_clean`,
  `methods_present`) and `untrusted_methods` before trusting a body, and
  confirm suspect methods with `inspect_dex_method`. Nothing is installed or
  run; manifest permissions are declarations. See the
  [Android packages guide](https://github.com/celaya-solutions/oopsware/blob/main/docs/android-packages.md).
- Explicit local container image (OCI layout folder, OCI archive or `docker save`
  tar): `inspect_container_image` lists the images the index names (pass
  `platform` such as `linux/arm64`, or `manifest`, when there are several),
  the configuration as declarations (entrypoint, user, environment, ports,
  labels, history mapped to layers), each layer with its blob digest and diff
  id rechecked, and a page of the composed filesystem with whiteouts and
  replacements applied; `layer` lists one layer's own entries with its
  whiteouts. A layer whose digests do not match is read but not applied.
  `inspect_artifact`/`extract_artifact` list and materialize a single-image
  archive. Nothing is pulled, started, mounted or run; foreign layers are named,
  never fetched; a plain tar or `docker export` is not an image. See the
  [container images guide](https://github.com/celaya-solutions/oopsware/blob/main/docs/container-images.md).
- Explicit local Word, Excel or PowerPoint file (`.docx`, `.xlsx`, `.pptx`,
  templates, add-ins and the macro-enabled `.docm`, `.xlsm`, `.pptm`, or the
  legacy 97-2003 `.doc`, `.xls`, `.ppt`): `inspect_office_document` decides the
  kind from the main part's content type, or for a legacy compound file from its
  `WordDocument`, `Workbook` or `PowerPoint Document` stream (a disagreeing file
  name is reported), lists properties, macro projects, OLE
  objects, ActiveX, signatures (listed and hashed, never run or verified) and
  every external relationship (linked templates, links, linked objects, never
  followed), then `view=content` pages typed items of the part you pick with
  `part` (Word paragraphs and tables, worksheet rows with each formula kept
  apart from its cached value and dates derived from number formats, slides
  with notes) and `view=text` returns Markdown. Read `omissions` before
  trusting a gap: pictures, charts, text boxes and equation structure are
  counted, not described. A password-protected or encrypted file, Word 6/95 and
  Excel 5/95 files, `.xlsb` and PDF are not read by this tool (use
  `inspect_pdf_document` for PDF). An Excel formula the reader cannot decode
  keeps its cached value and is counted as `undecoded-formulas`. See the
  [Office documents guide](https://github.com/celaya-solutions/oopsware/blob/main/docs/office-documents.md).
- Explicit local PDF: `inspect_pdf_document` `view=package` gives the
  cross-reference state (`rebuilt` means the file's own offsets were wrong and
  the objects were found by scanning), revisions, the encryption declaration
  (an encrypted file is described and refused for content; no password is
  tried), Info and XMP, attachments with the SHA-256 of their decoded bytes,
  actions as written and never run or followed (JavaScript with its start and
  hash, Launch, URI, GoToR, SubmitForm, media), and signatures with how far
  their byte ranges reach (`earlier-revision` means bytes were added after
  signing, `gap-mismatch` that the ranges skip more than the signature itself;
  nothing is verified). `view=pages` classifies every page from its
  content stream: `image-only` is a scanned page, `image-with-hidden-text` an
  OCR layer. `view=objects` lists indirect objects. `view=text` and
  `view=layout` (bounding boxes) run an admitted Poppler `pdftotext` on a
  private copy, paged by page; the order is Poppler's, not guaranteed reading
  order, and OCR is not run. See the
  [PDF guide](https://github.com/celaya-solutions/oopsware/blob/main/docs/pdf-documents.md).
- Explicit local debug symbols (ELF `.debug` file or binary carrying DWARF,
  Mach-O file, or `.dSYM` bundle): `inspect_debug_symbols` reads identifiers
  (Mach-O UUID, ELF build id, debug link CRC-32) and whether DWARF 2 to 5 is
  readable (object files, split DWARF and stripped files are named, not read
  as empty), then one view: `units`, `functions` (name through specification
  and abstract-origin DIEs, address ranges, declaration site) or `lines`
  (needs `unit`). Pass `binary` to pair a debug file with a binary by
  identifier only; use names from a debug file only when
  `pairing.enrichment_allowed` is true, because a same-named file is not a
  match. Pass `architecture` for a universal file. Nothing is run and no
  symbol server is contacted; PDB is not read yet. See the
  [debug symbols guide](https://github.com/celaya-solutions/oopsware/blob/main/docs/debug-symbols.md).
- Explicit local Debian package, RPM, AppImage or SquashFS image:
  `inspect_linux_package` for identity, every dependency declaration (rich
  RPM dependencies as written), maintainer scripts and scriptlets as text,
  triggers, conffiles, md5sums or RPM header/payload/file digests rechecked,
  signature material (never verified), the AppImage runtime, desktop entry
  and AppRun, and a page of files with modes and setuid bits as declared.
  `inspect_artifact`/`extract_artifact` list and materialize the contents
  (no install, no scripts, nothing mounted or run; xz/lzma/lzo SquashFS and
  Type 1 AppImages are identified only). See the
  [Linux packages guide](https://github.com/celaya-solutions/oopsware/blob/main/docs/linux-packages.md).
- Explicit local Windows Installer package (.msi): `inspect_windows_installer`
  for summary information, product, every table, features, components,
  resolved directories, registry, services, shortcuts, environment and INI
  changes, custom actions decoded by type with their sequences and conditions
  (as written, never evaluated), and a page of files with `MsiFileHash`
  rechecked. Pass external cabinets with `cabinets`; nothing is searched for.
  MSIX/AppX package or bundle: `inspect_msix_package` for manifests,
  capabilities and extensions as declarations, block maps recomputed and
  bundle packages; name one with `container`. Nothing is installed or run and
  signatures are never verified. See the
  [Windows installers guide](https://github.com/celaya-solutions/oopsware/blob/main/docs/windows-installers.md).
- Explicit Linux ELF file for offline layout, symbols, relocations or static
  mitigation evidence: `inspect_binary_layout`. This target-free operation uses
  caller-supplied pwntools without opening a disassembler database. Preserve its
  raw locations and inference/coverage limits; see the
  [offline binary guide](https://github.com/celaya-solutions/oopsware/blob/main/docs/binary-diagnostics.md).
- Supplied Linux x86-64 ELF core: `inspect_recorded_crash`. Read every recorded
  thread, raw note and source-bound register without opening a live target.
  Historical PIDs do not select live processes. Request `include_debugger_context`
  only when core-only mapping candidates help; see the
  [recorded crash guide](https://github.com/celaya-solutions/oopsware/blob/main/docs/recorded-crashes.md).
- PE resource type/name/language trees and static icon group references:
  `inspect_pe_resources` with an explicit path. This portable operation requires
  no active target or engine; opaque payloads retain file ranges and SHA-256.
- Native executable, library, or analysis database: `open_binary`, then
  use focused analysis tools directly; call `binary_overview` when metadata or
  inventory context is useful and available from the selected provider.

For an existing IDA MCP configuration, use `open_binary` with the original
input binary and `provider_id: "ida"`; do not pass an `.idb` or `.i64` database.
The legacy attached profile binds the already-open GUI input by SHA-256 and
leaves its database open. The modern headless profile creates and closes an
owned private database without saving. Installation and registration reuse
[mrexodia/ida-pro-mcp](https://github.com/mrexodia/ida-pro-mcp); see the
[IDA provider guide](https://github.com/celaya-solutions/oopsware/blob/main/docs/ida-provider.md).
Proceed directly to `analyze_function`, pseudocode, or function/string searches
after opening; IDA does not supply `binary_overview`. Consult session availability
when composing broader workflows. Modern direct callers and unsupported dossier
facets remain unknown; live IDA results are not replayed from snapshots.

With `REA_KUNA_COMMAND` configured, `provider_id: "kuna"` answers procedure
lists, lookups, pseudocode, assembly and `analyze_function` from Kuna's cached
whole-program export. Callers/callees use a separate body-free graph shared by
the session; `xrefs` returns exact-address incoming sites and filters forwarding
aliases. These queries and inventory lookups do not trigger a C export. Indirect
targets remain unknown and can make relationship coverage partial. Reference
caches expire on close; a fresh CLI process repeats the native reference walk.
Typed references, CFG, raw-memory tools and annotations remain unsupported. A cold first
answer can come from a single-function run (its limitations say so); assembly
waits for the export. For pseudocode and assembly, `raw_result.source` names the
cached `.c`/`.asm` file and byte span, which you may search directly instead of
calling per function. See the
[Kuna provider guide](https://github.com/celaya-solutions/oopsware/blob/main/docs/kuna-provider.md).

If the user says only "my app" without a name, path, or target already selected
for this task, ask which app before searching for artifacts. Paths in unrelated
saved reports and nearby test fixtures do not select the user's target. Resolve
an actual human-readable app name to one clear installed artifact when possible;
ask when matches are ambiguous. Never choose an example app on the user's behalf.

In a target-free session, use `open_binary` to bind any archive/package or
native target whose analysis tool operates on the active target. Do not call an
unadvertised tool; inspect `binary_session` with `{}` and its
`result.tool_availability` for availability reasons and remediation. Expand each
group's `names` into entries, inheriting the inventory-level client requirements
unless the group overrides them. In its closed effect and annotation vocabularies,
listed flags are true and omitted known flags are false. The grouped name union
is the complete tool inventory; use `tools/list` for canonical tool schemas.
Provider candidate facts describe possible providers, while top-level session
capabilities describe the current route and `analysis_provider_binding` names the
selected provider. Do not treat those scopes as interchangeable.

For a Ghidra startup timeout on a large native target, follow
[deadline recovery](references/native-and-artifacts.md#ghidra-startup-deadline-recovery)
before abandoning deep analysis or repeating the same cold import. The default
330 seconds is configurable; changing the server's environment requires a new
Oopsware process.

## Work summary-first

Start with the default result and use its inline Evidence and graph context.
For a JavaScript application or ELF layout whose size is unknown or large,
call `analyze_javascript_application` or `inspect_binary_layout` with
`"detail": "summary"`, then inspect the retained `parent_evidence_id` with
`inspect_analysis_view`.
Page module identities and select the returned `node_id` before requesting an
item; a single file path can represent several graph roles. Do not repeat an
identical analysis or rejected call without a changed input or resolved blocker.
Recheck session state when a lifecycle change makes that status useful.
Make a focused follow-up only when the
returned result leaves a specific question unanswered.

If MCP reports `resource_constraint` with `details.resource: "transport"`, call
`inspect_analysis_view` with its reported same-session Evidence reference for a
summary, one section/module, or a stable page. Use `trace_application_feature`
once a seed is known, or call `export_evidence_bundle` to write the complete
session to a selected path. The analysis remains complete in the ledger; avoid
repeating it merely to request the same oversized response. Complete CLI JSON
output also streams without a single MCP frame.

When the retained parent ID is unknown, use `get_evidence_bundle` with
`detail: "summary"` and exact filters for operation, target SHA-256,
analysis-profile digest or canonical procedure address. Select its returned
Evidence ID for the next view instead of requesting the complete bundle.
`retention: "complete-record"` means the whole record is stored; native
value-flow truncation and unknown metadata remain separate. For an exported
portable bundle, use `oopsware inspect-evidence-bundle` with JSON containing `path`,
`detail: "summary"` and the same `filters`. Reading that file still requires
validating its full contents within the local memory budget.

A client can also truncate a successful tool result without a Oopsware transport
error. Treat that preview as incomplete; use the retained parent ID for smaller
views or export when the full record is needed. Do not parse the preview as
canonical JSON or repeat the producer. For JavaScript, read the
[module-view and trace recipes](references/javascript-applications.md) before
drilling into a large graph; a broad bidirectional trace can expand unrelated
containment relationships even after summary analysis.

Every conclusion must distinguish observations, inferences, and unknowns. Cite
Evidence IDs, preserve limitations and incomplete coverage, and never imply
that static analysis observed execution. Runtime requests execute the declared
target and lifecycle; do not broaden the target or action beyond those fields.

Within the user's requested investigation, call available analysis tools
directly. Oopsware does not require permission grants or per-call approval flags.
The agent client can independently require approval. Follow the declared request
scope and the host's actual access requirements; use the recovery guide for an
observed client-policy rejection.

## Plan broader investigations

For requests that span multiple features or subsystems, use a staged workflow:

1. Turn the request into a checklist of questions and the evidence each answer
   needs. Resolve target identity and constraints from the conversation and
   workspace before asking for information again.
2. Inspect the current Oopsware session, artifact identity, saved analysis database,
   bookmarks, and prior evidence. Reuse matching state; do not open duplicate
   sessions or repeat identical analysis.
3. Start with the smallest useful overview or inventory. Follow each question
   from its entry point through relevant data and state changes to its result.
   Batch related operations around a specific hypothesis, then expand only when
   the returned evidence leaves a concrete gap.
4. Inspect relevant packaged resources and configuration alongside code when
   they affect the question. Use format-aware inventory and parsers; do not
   infer behavior from filenames, strings, or layout alone.
5. Corroborate a conclusion with the evidence type it requires. Use runtime
   observation only when static evidence cannot answer the question and the
   required host runtime and OS access are available. For JavaScript behavior,
   run probes against the actual app through the available browser, Electron,
   or process capture workflow.
6. Decompose work into independent questions. When parallel workers are
   available and the questions do not depend on one another, assign distinct
   scopes, point workers to existing evidence, and ask them to return sources,
   conclusions, and unresolved gaps. Otherwise, work sequentially.
7. Keep a concise finding ledger linking each conclusion to Evidence IDs,
   confidence/evidence type, search boundary, and remaining unknowns. Update
   the shared index or investigation report so later passes can reuse results.

Before finishing, revisit the original checklist. Mark each question as
answered, partially answered, or unresolved based on its evidence; keep
bounded negative searches bounded, and do not describe a broad investigation
as complete while required questions remain open.

## Read only the relevant guide

- Two native versions, candidate function pairs, and exact comparisons:

  [references/native-versions.md](references/native-versions.md)

- Native binaries, managed assemblies, archives, and extraction:
  [references/native-and-artifacts.md](references/native-and-artifacts.md)
- ASARs, extracted JavaScript, feature tracing, and version comparison:
  [references/javascript-applications.md](references/javascript-applications.md)
- Android APK declarations, classes, methods, and static references:
  [references/android-applications.md](references/android-applications.md)
- Browser/Electron observation (passive and scenario) and static/runtime
  reconciliation:
  [references/runtime-observation.md](references/runtime-observation.md)
- Evidence paging, comparisons, residual unknowns, and verification:
  [references/evidence-workflows.md](references/evidence-workflows.md)

## Finish the task

Explain findings in plain language and tie them to returned evidence. When the
user asks to build something, use normal coding tools and separate observed
behavior from design choices. Close an opened native session with
`close_binary` when the investigation is complete.
