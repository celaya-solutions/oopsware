```text
Document:    Oopsware
Version:     v1.23.4
Author:      Celaya Solutions
Contact:     hello@celayasolutions.com
Date:        2026-10-22
SHA256:      43a9da388b097a3c3feb23bd4abdee7be702fe4bceaf01f1a14e1ba4aca2f9c9
Chain:       solana-mainnet
Tx:          63KqqKDEd2JG1q1i5q6KEpEVgjWdeZnW9xdwYWcu3PWA9nbxRwuHpy3uxkQdNCdPp2KgrHpS516cvv51ysmCjFND
License:     All Rights Reserved / Celaya Solutions
```

# Oopsware

**A local reverse-engineering workbench. Bring an app, a binary, a package, a
bytecode file, or a strange archive. Find out what is inside without running it.**

Oopsware is maintained by Celaya Solutions (CSR). It brings CLI and MCP analysis,
a local browser workbench, model connections, and file readers into one place.
See [CREDITS.md](CREDITS.md) for the original REA authors and retained notices.

Every result says what was **observed**, what was **derived**, what was
**inferred**, and what is still **unknown**. Nothing is executed, installed or
uploaded unless a tool says so up front.

## Install with Claude Code or Codex

Paste this prompt into Claude Code or Codex on your computer. It installs
Oopsware from the source repository.

```text
Set up Oopsware from https://github.com/celaya-solutions/oopsware.git on this
computer. Use an existing checkout if I have one; otherwise clone it into
a new oopsware folder. Read its AGENTS.md and README.md first. Preserve my
files, saved runs, and existing settings. Check the Node.js and npm
versions pinned in .nvmrc and package.json; if missing, tell me what I need before continuing. Do not install
or upgrade unrelated software.

Run npm ci, npm run build:cached, and npm run dashboard:build. Run
node scripts/oopsware.mjs setup, help me choose my agent, show the planned
changes, and get my approval before applying them. Keep configuration
backups. Start node scripts/oopsware.mjs web --port 4097. If that port is
in use, check what owns it and choose a free port without stopping it.

Open the local workspace, run its sample inspection, and check the result.
Run node scripts/oopsware.mjs doctor and report any missing optional tools
without treating them as required for the basic workspace. Tell me the
working URL, how to stop the server, and which agent needs a restart.
Only call setup complete after the workspace and sample run work.
```

- [Workbench and readers](#workbench-and-readers)
- [Every file type it reads](#every-file-type-it-reads)
- [Quick start](#quick-start)
- [Roadmap](docs/roadmap.md)

## Workbench and readers

### A workbench in your browser

```sh
node scripts/oopsware.mjs web --port 4097
```

Open <http://127.0.0.1:4097/>. The sidebar has **Workspace**, **Tools**,
**Runs**, **Evidence**, **Compare**, **Connections** and **Settings**.

- **Open anything.** Upload a file (up to 128 MiB), open a path, browse your
  computer, or pick an installed Mac app. Text, hex and string views page
  through the bytes. Nothing is executed.
- **Every tool, as a form.** The full tool catalog is there with complete input
  schemas, plus a JSON mode. Unavailable providers stay visible and say why.
- **Runs you can come back to.** Each browser workspace keeps its own MCP
  session and a paged run history. Stop cancels work and waits for cleanup.
- **An assistant beside the evidence.** It explains what you are looking at
  and only sends the context you leave checked. It does not run tools or edit
  files on its own.
- **Locked down.** Binds to `127.0.0.1` only, checks Host and Origin, uses a
  per-run session token and a strict content security policy. Keys stay in
  `~/.config/rea/web/` with owner-only permissions.

Details: [web workspace guide](docs/web-workspace.md).

### New file formats

Each family below is read in process, bounded by size and time budgets, and
tested against the real tool that made the file.

| Family                  | Tools (MCP name, CLI uses hyphens)                                                                 | Checked against                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| WebAssembly             | `inspect_wasm_module`, `inspect_wasm_function`, `convert_wasm_to_text`, `convert_wasm_to_c`        | modules built by `rustc`; wabt.js validation; C checked by clang                                 |
| JVM classes, JARs, AARs | `inspect_jvm_artifact`, `inspect_jvm_class`, `inspect_jvm_method`, `decompile_jvm_class`           | 13,637 real classes, 2.78 million instructions match `javap`                                     |
| Python                  | `inspect_python_artifact`, `inspect_python_module`, `inspect_python_code`, `decompile_python_code` | whole standard libraries of six releases, ~19 million instructions match `dis`; pip-built wheels |
| Archives                | `inspect_artifact`, `extract_artifact`                                                             | fixtures made by the real tar, gzip, xz and 7zz; hostile names built by hand                     |
| Structured text         | `inspect_document`                                                                                 | hostile Markdown links and HTML, duplicate JSON keys, YAML alias bombs, XML entities             |

Some things these readers refuse on purpose: they never call an interpreter's
`marshal.loads`, never instantiate a WebAssembly module, never load a Java
class, never try a password on an encrypted archive, and never create links
when extracting. Decompiled Java is labelled **inferred**, and methods our own
decoder rejects are flagged rather than trusted.

Guides: [WebAssembly](docs/webassembly.md) · [JVM](docs/jvm.md) ·
[Python](docs/python.md) · [structured text](docs/structured-text.md) ·
[file identification](docs/identification.md).

### Compare two builds of a native app

`compare_native_versions` (also under **Tools → Compare native versions**)
opens each binary in its own analysis session, proposes function pairs with
the signals behind each match, and compares the exact or chosen pairs.
Ambiguous matches stay visible. A similarity score does not prove equal
behavior. Current scope: thin Mach-O arm64 pairs and ELF x86-64 pairs with an
available provider. Neither binary is run.

### Public library mode

The same code can serve a public, read-only file library: anonymous uploads,
a card catalog with filters, direct downloads, safe Markdown reading, module
views for `.wasm` and parsed views for text files. Uploads auto-delete after
24 hours unless the uploader turns that off. It sends HSTS and isolation
headers, limits each network address, and has an operator takedown route that
is off until a secret is set. The hosted site is **paused** while work stays
local. See the [hosting guide](docs/public-hosting.md).

## Every file type it reads

This is the full list, as of 2026-10-20. "Read" means the bytes are parsed
and reported; "identified" means Oopsware can name the format but does not
look inside yet. A name or extension is only a hint: formats are confirmed
from the bytes. Nothing in this list is run, installed, mounted or loaded.
Rows marked **needs** use a tool you install yourself; without it, the result
says the provider is unavailable. Not sure what you have? `identify_artifact`
(the dashboard's **What is this?** button) detects the type, runs the right
reader below and opens nested archives for you; see the
[identification guide](docs/identification.md).

<details open>
<summary><strong>Native programs and debug data</strong></summary>

| File type                   | Names                                           | Tools                                                                                              | Notes                                                                                                                 |
| --------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Mach-O (thin and universal) | apps, `.dylib`, bundles                         | `open_binary` and the native tools, `inspect_macho`, `inspect_signature`, `trace_dylib_resolution` | Decompile, functions, strings, references. **Needs** Hopper, Ghidra or IDA; signatures and dyld paths need no engine  |
| ELF                         | `.so`, executables, objects                     | `open_binary` and the native tools                                                                 | x86-64, AArch64, ARM; Ghidra also takes MIPS32, 32-bit big-endian PowerPC and RISC-V executables. **Needs** an engine |
| Windows PE                  | `.exe`, `.dll`                                  | `open_binary`, `inspect_pe_resources`                                                              | x86, x64, ARM, ARM64. The resource tree and icons need no engine                                                      |
| DOS programs                | MZ `.exe`, `.com`                               | `open_binary`                                                                                      | 16-bit code through Ghidra 12.1. NE, LE and LX are not supported                                                      |
| Raw binary                  | any headerless image, such as `ecu.bin`         | `open_binary` with `raw-binary`                                                                    | You give the architecture (x86, x86-64, ARM, ARM64, 6502, m68k) and entry point. **Needs** Ghidra                     |
| PSP executable              | static ELF32                                    | `open_binary`                                                                                      | **Needs** Ghidra with the Allegrex extension, Linux x64. PRX, PBP and ISO are not supported                           |
| ELF layout                  | ELF64 x86-64                                    | `inspect_binary_layout`                                                                            | Sections, segments, symbols, relocations, mitigations. **Needs** Python with pwntools                                 |
| Linux core dump             | ELF64 core (x86-64, AArch64)                    | `inspect_recorded_crash`                                                                           | Segments, notes, registers, signal info. **Needs** pwntools. `.ips`, `.crash`, minidumps and tombstones are not read  |
| Go programs                 | ELF, PE, thin Mach-O                            | `inspect_go_binary`                                                                                | Go version, modules, replacements, build settings                                                                     |
| Rust programs               | ELF, PE, thin Mach-O built with cargo-auditable | `inspect_rust_binary`                                                                              | Crates, versions and dependency edges                                                                                 |
| Analysis databases          | IDA `.i64` / `.idb`, Hopper `.hop`              | through IDA or Hopper                                                                              | Read-only; Oopsware never saves them. A `.pdb` is only reported as referenced by its PE                               |

</details>

<details open>
<summary><strong>Apple</strong></summary>

| File type                  | Names                                      | Tools                                                                             | Notes                                                                                    |
| -------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| iOS and Mac apps           | `.ipa`, `.app` folders                     | `inspect_artifact`, `extract_artifact`, `project_apple_application_graph`         | Bundle layout, frameworks, executables. `embedded.mobileprovision` is listed, not opened |
| Disk images                | `.dmg` (UDIF)                              | `inspect_artifact`                                                                | Contents listed; not extracted                                                           |
| Installer packages         | `.pkg`, `.xar`                             | `inspect_artifact`                                                                | Identified only                                                                          |
| Property lists             | `.plist` (XML and binary), `.entitlements` | `inspect_plist`                                                                   | Every key and value                                                                      |
| Keyed archives             | NSKeyedArchiver plists                     | `inspect_keyed_archive`                                                           | Object table, classes, links; nothing is instantiated                                    |
| Compiled Interface Builder | compiled `.nib` and `.storyboardc`         | `decode_interface_builder`                                                        | Objects, view tree, outlets and actions                                                  |
| Asset catalogs             | `Assets.car`                               | `inspect_asset_catalog`                                                           | Catalog and image metadata (uses macOS `assetutil`); image bytes are not exported        |
| Swift and Objective-C      | inside Mach-O                              | `analyze_swift_types`, `demangle_swift`, `get_objc_classes`, `get_objc_protocols` | Types, classes and protocols                                                             |

</details>

<details open>
<summary><strong>Android, HarmonyOS and Flutter</strong></summary>

| File type          | Names                                     | Tools                                                                 | Notes                                                                                  |
| ------------------ | ----------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Android packages   | `.apk`, `.aab`, `.apks`, `.xapk`          | `inspect_android_artifact`, `inspect_artifact`, `extract_artifact`    | Manifest, resources, splits, signature blocks (listed, not verified)                   |
| Dalvik bytecode    | `.dex`                                    | `inspect_android_artifact`, `inspect_dex_class`, `inspect_dex_method` | Classes and instructions, matching `dexdump`                                           |
| Decompiled Java    | one class of any of the above             | `decompile_dex_class`                                                 | **Needs** a pinned dex2jar 2.4 and Vineflower; checked against the DEX method list     |
| Decompiled Java    | one `.apk`                                | `inspect_android_package`, `inspect_android_class` and related        | **Needs** JADX. Resources through `decode_android_resources` **need** Apktool and Java |
| Android libraries  | `.aar`                                    | `inspect_jvm_artifact`                                                | Classes, manifest and JNI libraries                                                    |
| Flutter apps       | `libapp.so` and `libflutter.so` in an APK | `identify_flutter_build`, `inspect_dart_aot`                          | Build IDs, snapshot hash, Dart symbols and strings; no class recovery                  |
| HarmonyOS packages | `.hap`, `.hsp`, `.app`                    | `inspect_artifact`, `project_harmony_application_graph`               | Package layout only; `.abc` bytecode and `.har` are not read                           |
| Anything JEB opens | JEB inputs, `.jdb2` projects              | `open_jeb_project`, `decompile_jeb_item`                              | **Needs** a running JEB with its MCP server                                            |

</details>

<details open>
<summary><strong>Windows and .NET</strong></summary>

| File type         | Names                                          | Tools                                                                                        | Notes                                                                                                                                             |
| ----------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| .NET assemblies   | `.exe`, `.dll` with a CLI header               | `inspect_managed_artifact`, `inspect_managed_members`, `compare_managed_members` and related | Metadata, IL, P/Invoke calls into native code. Single-file hosts are not unpacked. `decompile_managed_type` **needs** a pinned ilspycmd           |
| ReadyToRun        | R2R assemblies                                 | same                                                                                         | Marked as R2R; native bodies are not mapped                                                                                                       |
| NativeAOT         | PE, ELF or Mach-O                              | native tools                                                                                 | Built-in reader for x64 PE32+ only; others through Ghidra                                                                                         |
| Windows Installer | `.msi`                                         | `inspect_windows_installer`, `inspect_artifact`, `extract_artifact`                          | Tables, custom actions (never run), stored and MSZIP cabinets; external cabinets only when given. LZX and Quantum, `.msp` and `.mst` are not read |
| MSIX and AppX     | `.msix`, `.appx`, `.msixbundle`, `.appxbundle` | `inspect_msix_package`, `inspect_artifact`, `extract_artifact`                               | Manifests, capabilities as declarations, block maps rechecked, bundle packages. Signatures are not verified                                       |

</details>

<details open>
<summary><strong>Java, Python, WebAssembly and JavaScript</strong></summary>

| File type     | Names                          | Tools                                                                                | Notes                                                                                                                                 |
| ------------- | ------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| JVM           | `.class`, `.jar`               | `inspect_jvm_artifact`, `inspect_jvm_class`, `inspect_jvm_method`                    | Every method, matching `javap`. `decompile_jvm_class` **needs** a pinned Vineflower                                                   |
| Python        | `.py`, `.pyc`, `.whl`, `.pyz`  | `inspect_python_artifact`, `inspect_python_module`, `inspect_python_code`            | Bytecode for 3.9 and 3.11–3.15; source needs an installed CPython for its parser. `decompile_python_code` **needs** a pinned pycdc    |
| WebAssembly   | `.wasm`, `.wat`                | `inspect_wasm_module`, `inspect_wasm_function`, `convert_wasm_to_text`               | In process. `inspect_wasm_artifact` and `compare_wasm_interfaces` **need** WABT 1.0.42; `convert_wasm_to_c` **needs** a pinned wasm2c |
| JavaScript    | `.js`, `.mjs`, `.cjs`, bundles | `analyze_javascript_application`, `analyze_web_bundle`, `trace_javascript_semantics` | Modules, imports, features                                                                                                            |
| Source maps   | `.map`                         | `recover_javascript_sources`                                                         | Original sources rebuilt from the map                                                                                                 |
| Electron apps | `.asar`, Electron executables  | `inspect_artifact`, `extract_artifact`, `inspect_electron_fuses`                     | Archive contents and fuse settings                                                                                                    |

</details>

<details open>
<summary><strong>Archives, Linux packages and game files</strong></summary>

| File type            | Names                                                                        | Tools                                                             | Notes                                                                                                                                                                                                                                                                                                               |
| -------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ZIP                  | `.zip` and ZIP-based packages                                                | `inspect_artifact`, `extract_artifact`                            | Listed and extracted                                                                                                                                                                                                                                                                                                |
| Tar, gzip, xz, 7-Zip | `.tar`, `.gz`, `.tgz`, `.xz`, `.txz`, `.7z`                                  | `inspect_artifact`, `extract_artifact`                            | Streamed; links recorded, never created; no passwords tried. xz and 7z use the installed `xz` and `bsdtar`                                                                                                                                                                                                          |
| RAR                  | `.rar`                                                                       | `inspect_artifact`                                                | Identified only. bzip2 and zstd are not read yet                                                                                                                                                                                                                                                                    |
| Linux packages       | `.deb`, `.rpm`, `.AppImage`, `.squashfs`, `.sqsh`                            | `inspect_linux_package`, `inspect_artifact`, `extract_artifact`   | Metadata, scripts (never run), digests rechecked. SquashFS: gzip, zstd and lz4 only                                                                                                                                                                                                                                 |
| Container images     | OCI layout folder, OCI archive `.tar`, `docker save` `.tar`                  | `inspect_container_image`, `inspect_artifact`, `extract_artifact` | Layer digests and diff ids rechecked; whiteouts applied. A plain tar or `docker export` is not an image                                                                                                                                                                                                             |
| Debug symbols        | ELF `.debug` files and binaries, Mach-O, `.dSYM` bundles                     | `inspect_debug_symbols`                                           | DWARF 2–5 units, functions and line tables; paired to a binary by UUID or build id. PDB is not read yet                                                                                                                                                                                                             |
| Office documents     | `.docx`, `.xlsx`, `.pptx`, `.docm`, `.xlsm`, `.pptm`, `.doc`, `.xls`, `.ppt` | `inspect_office_document`                                         | Properties, macro/OLE/link inventory (hashed, never run), paragraphs, worksheet cells with formulas apart from cached values, slides. Legacy 97-2003 files read the same way; encrypted files are refused                                                                                                           |
| PDF documents        | `.pdf`                                                                       | `inspect_pdf_document`                                            | Cross-reference state (rebuilt when wrong), encryption declared (refused, no password tried), attachments with hashes, scripts and links as written, signature reach, per-page kinds (image-only = scanned), text and word boxes from an admitted Poppler. Nothing rendered, decrypted, run or fetched; OCR not run |
| Unix ar              | `.a`, `.ar`                                                                  | `inspect_artifact`                                                | Identified only                                                                                                                                                                                                                                                                                                     |
| Godot                | `.pck`                                                                       | `inspect_artifact`, `extract_artifact`                            | Listed and extracted                                                                                                                                                                                                                                                                                                |
| Unity IL2CPP         | `global-metadata.dat`, with `GameAssembly` or `libil2cpp.so`                 | `inspect_il2cpp_metadata`                                         | Types, methods, strings and method addresses (metadata v24–v39)                                                                                                                                                                                                                                                     |
| Game and app folders | install folders                                                              | `inspect_desktop_application`                                     | Names the runtime: .NET, Unity, Unreal, Godot, GameMaker, Electron. Identifies only                                                                                                                                                                                                                                 |
| Any folder           | a directory                                                                  | `inspect_artifact`                                                | Full inventory                                                                                                                                                                                                                                                                                                      |

</details>

<details open>
<summary><strong>Data, models, captures and firmware</strong></summary>

| File type          | Names                                                                              | Tools                                                                     | Notes                                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Structured text    | `.md`, `.json`, `.jsonl`, `.yaml`, `.yml`, `.toml`, `.xml`, `.csv`, `.tsv`, `.txt` | `inspect_document`                                                        | Parsed with line and column locations; nothing fetched or expanded                                     |
| SQLite             | `.sqlite`, `.db`, with its `-wal` file                                             | `inspect_sqlite_database`, `query_database_readonly`                      | Schema and sample rows, or one read-only SQL statement of yours, up to 256 MiB                         |
| AI models          | `.gguf`, `.safetensors`                                                            | `inspect_model_artifact`                                                  | Metadata, tensors, parameter counts. PyTorch, ONNX, TFLite and Core ML are not read                    |
| Packet captures    | `.pcap`, `.pcapng`                                                                 | `inspect_pcap_capture`, `inspect_packet_capture`, `inspect_packet_fields` | Endpoints, DNS, TLS names, protocol fields. **Needs** tshark; Linux or Windows (fields: Linux only)    |
| Web traffic        | `.har`, `.saz`, mitmproxy flows, `.qlog`                                           | `inspect_web_network_capture`                                             | Requests, bodies, protobuf and gRPC with a `.pb` descriptor set. mitmproxy **needs** mitmdump on Linux |
| Logic recordings   | `.vcd` and other sigrok inputs                                                     | `decode_signal_recording`                                                 | Protocol decoder output. **Needs** sigrok-cli, Linux                                                   |
| Firmware           | flash dumps and firmware images                                                    | `inspect_firmware_regions`, `extract_firmware`                            | Regions and recursive extraction. **Needs** Binwalk and Unblob, Linux x64                              |
| Ethereum contracts | bytecode as `.hex` or `.bin`                                                       | `inspect_evm_interface`                                                   | Function selectors and interface guesses                                                               |
| Saved evidence     | Oopsware evidence bundles                                                          | `import_evidence_bundle`, `inspect_analysis_view`                         | Reopens earlier results                                                                                |

</details>

Not files, but also read: live browser pages and Electron windows, Node.js
processes, native app windows, Android devices over ADB, and Frida, GDB and
Rizin debug sessions.

**Not read yet** (see the [roadmap](#roadmap)): PDB debug
files, bzip2 and
zstd streams, ISO and VHD disk images, fonts, images, audio and video,
certificates, and email files.

## Quick start

Use Node.js 24.18.0 and npm 11.16.0, as pinned in `.nvmrc` and `package.json`.

```sh
git clone https://github.com/celaya-solutions/oopsware.git oopsware
cd oopsware
npm ci
npm run build:cached
npm run dashboard:build
node scripts/oopsware.mjs web --port 4097
```

Open <http://127.0.0.1:4097/> and press **Try a sample**.

From the terminal:

```sh
node scripts/oopsware.mjs --help
node scripts/oopsware.mjs doctor
node scripts/oopsware.mjs inspect-artifact /absolute/path/to/file --json
node scripts/oopsware.mjs inspect-jvm-artifact /absolute/path/to/app.jar --json
node scripts/oopsware.mjs inspect-python-artifact /absolute/path/to/pkg.whl --json
node scripts/oopsware.mjs inspect-wasm-module /absolute/path/to/module.wasm --json
```

`npm link` adds an `oopsware` command to your shell.

### Bring an agent along

```sh
node scripts/oopsware.mjs setup
```

Setup shows its plan before it changes any agent settings, keeps backups and
uses this local build. Restart the agent afterward. Then ask something like:

> Where does this app turn my notes into a CSV? Show me the path and the evidence.

Or point any MCP client at `node` with the absolute path to
`scripts/oopsware.mjs` and `mcp` as its arguments. See
[supported agents](docs/installation.md#supported-agents),
[MCP configuration](docs/installation.md#mcp-registry) and the
[tool catalog](docs/mcp-contracts.md#generated-catalog).

<details>
<summary><strong>Prompts that let your agent do the setup</strong></summary>

**Existing install:**

```text
Finish setting up my existing Oopsware checkout. Read its AGENTS.md and
README.md. Check the pinned Node.js and npm versions, install the locked
dependencies, and build the runtime and dashboard using the README commands.
Preserve my changes, saved data, model connections, and running services.

Run node scripts/oopsware.mjs setup. Help me select my agent, show the plan,
and get my approval before applying it. Keep backups; do not install or
upgrade unrelated software. Run node scripts/oopsware.mjs doctor. Separate
required fixes from optional analysis providers. Reuse a working local
workspace or start one on a free port, then verify a sample inspection.
Tell me the URL and any restart needed. After I restart my agent, check
that it can reach Oopsware through MCP before claiming that connection works.
```

**Models:**

```text
Connect models to my Oopsware workspace. Read its AGENTS.md and README.md.
Start the workspace (node scripts/oopsware.mjs web --port 4097, or a free
port) and open Connections. Look at "Models on this Mac" and tell me which
models it found in Ollama, LM Studio, the LM Studio folder, and the Hugging
Face cache. Do not delete, move, or re-download anything I already have.

If Ollama is not running, tell me how to start it. If LM Studio's server is
off, tell me to start it (Developer tab, or lms server start). Ask me before
downloading any model, say how big it is, and prefer a small one for a first
test. For Hugging Face, OpenRouter, Claude, and OpenAI, ask me to paste the
key or sign in myself; never read, print, or copy my keys. Then open the
assistant, pick each connected provider, send one short message, and tell
me which ones replied. Only call a provider working after a real reply.
```

</details>

### Choosing a deep-analysis provider

JavaScript, WebAssembly, JVM, Python, archive and text inspection need no
decompiler. Native targets use your own Hopper, Ghidra or IDA. Oopsware does
not install or upgrade Node.js, Java, Ghidra or other unrelated tools.
`decompile_jvm_class` runs only an owner-installed Vineflower whose jar digest
is on the admitted list.

Read [installation and setup](docs/installation.md), the
[CLI guide](docs/cli.md)
and the provider guides before a native investigation. A tool being listed
does not prove every provider, host and format combination works.

## Roadmap

See the [roadmap](docs/roadmap.md) for priorities and the evidence required to
add new capabilities.

## Compatibility

Existing `rea` commands, `REA_*` environment variables, `rea.json` files,
saved workspace data and the `rea` MCP registration key still work. The app,
help text and new commands use Oopsware. Re-run setup from this checkout when
moving an agent from the original package to this build.

Some guides show the scoped package name `@celaya-solutions/oopsware`. That is
the name for future releases; no package has been published yet. Use the
local launcher where a guide shows an npm command.

## Free to explore

New CSR contributions are free to use, study, change and share for
**noncommercial purposes** under PolyForm Noncommercial 1.0.0. The original
code and earlier MIT-covered work keep their MIT terms, including commercial
use; this fork cannot take those rights away. Third-party components keep
their own licenses. See [LICENSE](LICENSE) for the exact split.

You must legally own or be authorized to use commercial tools such as IDA,
Hopper and JEB, and to examine the software you analyze.

## The people who opened it first

Oopsware builds on **[REA](https://github.com/morluto/rea)** by **morluto and
the REA contributors**. CSR maintains this fork as an independent project; the
original authors do not endorse it. The original copyright and MIT license are
preserved in full. [Credits and provenance](CREDITS.md) list every source and
retained notice.

## Leave the bench a little better

Found a weird edge case? A clear reproduction is a lovely gift. Start with
[contributing](CONTRIBUTING.md) and the [testing guide](docs/testing.md).
Keep the evidence, name the unknowns, and resist turning a hunch into a fact.
