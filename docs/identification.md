```text
Document:    "What is this?" identification
Version:     v1.1.0
Author:      Celaya Solutions
Contact:     hello@celayasolutions.com
Date:        2026-10-21
SHA256:      a7a3d8e4e469495ded5d77194791a59ee36ee3d7432f258d06fb7df01d94935d
Chain:       solana-mainnet
Tx:          2nU6mnGGTyWCdDdrx99rKEgDhG1KWv7T5M1V9rH9JBuwrt6iLyZQ1x9D3aHAKi6gAC7QpJNzjipfqdc3fH2fAH6y
License:     All Rights Reserved / Celaya Solutions
```

# "What is this?" identification

`identify_artifact` answers "what is this, what is inside, and what should I run next?" for one local file or folder in one call (roadmap item 3). No file is run, installed or fetched. It reuses the format detector, the format registry, the artifact readers and the reader tools that already own each format; nested containers are read with the existing readers, which may use installed decoders (xz, bsdtar) and, on macOS, mount a disk image read-only, exactly as `inspect_artifact` does. The dashboard's **What is this?** button runs it for the selected target.

| Tool (MCP / CLI)                          | Answers                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `identify_artifact` / `identify-artifact` | One summary sentence that names every stop; the root's byte detection; a tally of files by format; unrecognized files by extension; the ten largest files; a page of pieces with format, container state, reader state and headline; and next steps with exact tool calls, needs and the file to open first. |

```sh
oopsware identify-artifact ./download.tar.gz --json
oopsware identify-artifact ~/Downloads --depth 1 --limit 200 --json
```

MCP input: `path` (absolute file or folder); `depth` (nested container levels to open, 0–6; 3 for a file and 0 for a folder when omitted); `max_entries` (folder entries, skipped special files and container members examined, default 100,000); `max_readers` (built-in readers run for headlines, default 8); `max_spool_bytes` (bytes copied out to open nested pieces, default 1 GiB); `max_decoded_bytes` (bytes decoded from one gzip, xz or 7z stream, default 4 GiB); `start`/`limit` page the pieces (default 20; the dashboard asks for 200).

## How a piece gets its format

1. The leading 8 KiB (and the final 512 bytes of files on disk) go to the format detector.
2. A byte-established package role wins, then a semantic profile, then a role the name names on storage the bytes show (labelled "from the name"), then the storage itself.
3. Only formats bytes can neither establish nor refute (Markdown, JSON, YAML, CSV and other text profiles) may come from the name alone, and only when no byte candidate exists and nothing contradicts the name.
4. When the reader that owns a name-based format refutes it (a `.json` that does not parse, a plain ZIP named `.jar`), the piece falls back to what the bytes prove (`zip`, or unrecognized) and keeps the reason as its name conflict. A reader that fails for a budget, a missing program or an I/O error refutes nothing: the format stays and the reader state is `failed`. When the reader confirms a name, the basis becomes `reader`.

A name the bytes contradict is kept as `name_conflict` and never suggests a reader.

## Readers and headlines

Each piece's first automatic route runs in its cheapest mode through that reader's own service, so its input checks, limits and output checks apply unchanged. Readers run on one piece of each format within `max_readers`: the root first, then pieces in walk order (members of a container right after it). The other pieces say why they were skipped and the next steps name the call. When a chosen read fails, another piece of that format may be read instead.

| Format                                                      | Reader run for the headline   |
| ----------------------------------------------------------- | ----------------------------- |
| `.deb`, `.rpm`, AppImage, SquashFS                          | `inspect_linux_package`       |
| `.msi`                                                      | `inspect_windows_installer`   |
| MSIX, AppX and their bundles                                | `inspect_msix_package`        |
| APK, App Bundle, APK set, XAPK, DEX                         | `inspect_android_artifact`    |
| JAR, AAR, class file                                        | `inspect_jvm_artifact`        |
| Wheel, zip application, `.pyc`                              | `inspect_python_artifact`     |
| WebAssembly module or text                                  | `inspect_wasm_module`         |
| PDF                                                         | `inspect_pdf_document`        |
| Word, Excel, PowerPoint (Open XML, macro-enabled, 97-2003)  | `inspect_office_document`     |
| Markdown, JSON, JSON Lines, YAML, TOML, XML, CSV, TSV, text | `inspect_document`            |
| PE                                                          | `inspect_managed_artifact`    |
| ELF, thin Mach-O                                            | `inspect_go_binary`           |
| Folder (the root)                                           | `inspect_desktop_application` |

Readers that need an engine, an interpreter or an opened target, or that do heavy work, are next steps only: `open_binary` (Hopper, Ghidra or IDA), `inspect_macho` (opened target, Apple tools), `inspect_binary_layout` (Linux x64 with pwntools), `inspect_android_package` (JADX), `inspect_python_artifact` on `.py` source (an installed CPython), `analyze_javascript_application` and `inspect_sqlite_database`.

A PDF is known by its `%PDF-` header. An Open XML file is a ZIP, so its name (`.docx`, `.xlsm`, ...) proposes the format and `inspect_office_document` settles it from the main part's content type: a plain archive named `.docx` is refuted by that reader and stays a ZIP, with the conflict recorded on its piece. The headline shows the document kind, title and author where the file has them, macros, embedded objects, external references and signatures for Office files, and page count, title, encryption, active content, attachments, signatures and scanned pages for PDFs. Nothing is rendered, opened in an application, decrypted or run.

## Nested containers

A piece opens when the registry declares a complete or partial local inventory facet for one of its formats (ZIP and its package roles, tar, gzip, xz, 7z, `.deb`, `.rpm`, SquashFS, AppImage, MSI, ASAR, Godot PCK, and universal Mach-O and DMG on macOS). Formats that hold files but cannot be listed here (RAR, XAR, bzip2, zstd) say why. Within `depth`, a nested container is copied out to a private scratch directory, classified exactly as the artifact inventory classifies a root, and opened with the same reader. Members are read once, in order; only the first 8 KiB of a member is read unless it is a container to open or a piece a reader will run on. A member that cannot be read is counted unreadable and the walk goes on; a container that stops midway keeps its members and says why, in its piece and in the summary. Each copy is removed as soon as nothing reads it, and the scratch directory is removed before the answer returns; messages name logical paths, never scratch ones.

Pieces inside a container share one next step: `extract_artifact` on the on-disk file that holds them, with `open_first` naming the path to open with `open_binary` first, and the inner paths with the reader for each. Pieces more than one container deep need each inner container extracted in turn.

## Folders and drives

A folder is walked with the artifact directory reader: symlinks are listed, never followed; FIFOs, sockets and devices are counted and named; an entry the host refuses or that vanishes while the walk runs is named in diagnostics and the walk continues; any other failure keeps the partial walk and says so. The subject digest covers the sorted listing (kind, size, path), not file contents. Containers in a folder are opened only when `depth` is above 0, and the summary counts their files apart from the files on disk. Unrecognized files are tallied by extension, a fact about names only.

## Limits

- Detection examines prefixes, not whole structures; a candidate is not proof the file is valid.
- `max_entries`, `max_spool_bytes`, `max_decoded_bytes` and `max_readers` stop work early and say so in the summary and `coverage`.
- At most 200 diagnostics are listed; `coverage.diagnostics_omitted` counts the rest. At most 16 next steps are listed; `next_steps_omitted` counts the rest.
- Formats the registry does not detect yet (debug symbols, source languages without a profile) stay unrecognized or name-hinted. A disk image inside another container is identified by bytes only, so it stays unrecognized unless its leading bytes say otherwise.
- Readers run on copied members see a scratch path; next steps never name scratch paths.
