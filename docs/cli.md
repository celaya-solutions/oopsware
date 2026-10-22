```text
Document:    CLI and Evidence
Version:     v1.0.1
Author:      Celaya Solutions
Contact:     hello@celayasolutions.com
Date:        2026-10-13
SHA256:      7b7372a2bb3a33ef22d910d833a7ec15ac80066329e929b647df79b2a5c239cb
Chain:       solana-mainnet
Tx:          5WgeJoDjbabz1bnasantTvMowDVoCc9N8ZKQQ7v7vziF9FsgsefdJWZfseV44f5cuFLv75877Sh6SLPpvHaPbjBJ
License:     All Rights Reserved / Celaya Solutions
```

# CLI and Evidence

Use the CLI for a direct inspection or a script. It uses the same application
workflows and evidence contracts as Oopsware's MCP server. Each CLI invocation is a
separate process; save results when you want to use them in a later command.

## Run a command

After [installing Oopsware](installation.md), use `rea`. You can also run a command
without a global installation:

```bash
npx -y @celaya-solutions/oopsware@latest analyze-javascript-application /absolute/path/to/app --json
```

Use an extracted application directory or an ASAR as the target. Static
JavaScript analysis returns the application graph and Evidence directly.
Generic `rea analyze PATH` selects this workflow for directories and `.asar`
files when neither `--provider` nor `--snapshot` is supplied. See
[JavaScript artifact reconstruction](javascript-artifact-reconstruction.md)
for results, integrity checks and coverage.

The complete application Evidence can be hundreds of megabytes for a real
application. When an agent or a person reads the result, save it to a file and
project a summary, a module page or one module from the saved Evidence:

```bash
oopsware analyze-javascript-application /absolute/path/to/app --json > app-evidence.json
jq -c '{source: {kind: "inline", evidence: .}, view: {kind: "summary"}}' app-evidence.json > app-view.json
oopsware inspect-analysis-view app-view.json
```

The request can also name the saved file instead of embedding it:
`{"source": {"kind": "evidence-file", "path": "app-evidence.json"}, "view": {"kind": "summary"}}`.
The CLI resolves a relative path against the working directory; MCP clients
pass an absolute path. REA reads and authenticates the file, then projects it
like retained Evidence, so a large file is bounded by the file reader rather
than charged as inline input.

For example, a 334 MB Obsidian application Evidence file yields a summary view
of about 10 KB. Replace the view with
`{"kind": "page", "collection": "modules", "offset": 0, "limit": 32}` for a
module page. See
[JavaScript application workflows](javascript-application-workflows.md) for
views, feature traces and comparisons that take the same saved Evidence.

## Managed assemblies (.NET)

For a .NET PE/CLI assembly, inspect its identity and deployment form before
inspecting members. These commands read metadata and Common Intermediate
Language (CIL) without loading or executing the assembly and require no native
analysis engine:

```bash
rea inspect-managed-artifact /absolute/path/Assembly.dll --json
rea inspect-managed-members /absolute/path/Assembly.dll --json
rea inspect-managed-members /absolute/path/Assembly.dll --type Example.Parser --json
```

Replace `Example.Parser` with an exact `full_name` from the member inspection,
or a declaring type name you already know. Omit `--type` to inspect all members,
or repeat it to select several types.
Selection limits decoding to the selected types; member references remain an
assembly-wide inventory, so the output can still be large.

Choose the workflow from the artifact's contents rather than its `.exe` or
`.dll` extension. The managed parser requires PE/CLI metadata; it does not
unpack .NET single-file hosts or decode IL2CPP. For the image, type and method
names in a Unity `global-metadata.dat`, use
[IL2CPP metadata](il2cpp-metadata.md). NativeAOT method bodies require native
analysis. See the [managed-code guide](managed-code-analysis.md)
for supported deployment forms, selection semantics, and coverage limits.

## SQLite snapshots

For a local database snapshot, use `rea inspect-sqlite-database PATH --json`.
Add `--table NAME --row-limit 20` to read a bounded sample from an ordinary
table. This command does not require a native analysis provider. See
[SQLite database snapshots](sqlite-databases.md) for database/WAL identity,
source-file handling and row-value semantics.

## Native analysis

Inspect embedded Go build metadata without installing Go or configuring a
disassembler:

```bash
rea inspect-go-binary /absolute/path/to/program --json
```

The shared CLI/MCP workflow reports compiler version, modules, replacements,
build settings, original bytes and SHA-256. See [Go binaries](go-binaries.md)
for supported containers and absent or malformed metadata.

Inspect a Godot PCK without running the game:

```sh
rea inspect-artifact game.pck --detail summary --evidence_output evidence.json --json
rea extract-artifact game.pck --json
```

Formats 2, 3 and 4 retain header, directory and integrity facts. Compact delivery
keeps complete Evidence in the requested bundle. See [Godot PCK](godot-pck.md)
for embedded packs, batch queries and unknown encrypted coverage.

Inspect local model declarations without loading weights:

```bash
rea inspect-model-artifact /absolute/path/model.gguf --json
rea inspect-model-artifact /absolute/path/model.safetensors --hash full --json
```

Default hashing reads only headers and leaves full-file identity unknown.
`--hash full` streams the complete file for SHA-256. Both return typed metadata,
original tensor declarations and derived totals. MCP summaries retain complete
Evidence for filtered metadata, tensor and type-total pages; CLI compact delivery
uses `--detail summary --evidence_output FILE`. See [model files](model-artifacts.md).

Inspect Unity IL2CPP metadata names without Unity or a disassembler:

```bash
rea inspect-il2cpp-metadata /absolute/path/global-metadata.dat --json
```

The command decodes a version 24, 27, 29, 31 or 39 `global-metadata.dat` and reports assembly
images, type, method and member names, string literals, index ranges, header
sections and SHA-256. With `--binary PATH` it also reads the matching
`GameAssembly.dylib`, `GameAssembly.dll` or `libil2cpp.so` (never runs it) and
links each method to its code address; `--ghidra-seeds PATH` then writes Ghidra
function seeds. It does not decrypt metadata. MCP defaults to compact counts
with retained Evidence; query indexed rows with filters, batch indices and
selected fields. The CLI defaults to complete Evidence;
`--detail summary --evidence_output FILE` exports the full result to a new file
and returns a compact overview. See [IL2CPP metadata](il2cpp-metadata.md).

Inspect an embedded cargo-auditable Rust dependency list without installing
Rust or configuring a disassembler:

```bash
rea inspect-rust-binary /absolute/path/to/program --json
```

The same workflow reports package names, versions, sources, the root package,
dependency edges, and the section's file range. A missing `.dep-v0` section is
null metadata, not proof that the binary has no dependencies. See
[Rust binaries](rust-binaries.md).

Configure [Hopper or Ghidra](installation.md#hopper), the
[IDA adapter](ida-provider.md), or [Kuna](kuna-provider.md) before analyzing a
native target. Substitute
your target, search text and function name or address in these examples:

```bash
rea analyze /absolute/path/to/program --provider ghidra --json
rea search /absolute/path/to/program "search" --provider ghidra --json
rea function /absolute/path/to/program main --provider ghidra --json
rea decompile /absolute/path/to/program 0x1000 --provider ghidra --json
rea xrefs /absolute/path/to/program 0x1000 --provider ghidra --json
rea trace /absolute/path/to/program "search" --provider ghidra --json
```

`analyze` and `inspect` share the native overview workflow. `function` returns
a function dossier; `decompile` returns pseudocode. For assembly instructions
alone, use `rea instructions`. A macOS `.app` bundle can be supplied directly.

Run `oopsware --help` or a command's `--help` for arguments and output options.
The [generated catalog](mcp-contracts.md#generated-catalog) lists all CLI commands and MCP
tools. Provider-specific target support is described in the
[native guide](native-investigation.md), [DOS guide](ghidra-dos.md),
[raw binary guide](raw-binary.md), and
[Windows Ghidra guide](windows-ghidra-p0.md).

## Choose a provider

List the available providers and their supported operations:

```bash
rea providers --json
rea capabilities --json
```

These commands describe binary-session providers and auxiliary capabilities.
For the complete MCP surface, use the connected server's tool list and the
session's advertised availability; individual guides describe prerequisites.

With automatic selection, Oopsware uses the single available provider that supports
the target. When several providers support it, select one explicitly:

```bash
rea analyze /absolute/path/to/program --provider hopper
```

Set `REA_ANALYSIS_PROVIDER` for a standing preference. An explicit `--provider`
overrides it. In MCP, pass `provider_id` to `open_binary`:

```json
{
  "path": "/absolute/path/to/program",
  "provider_id": "hopper"
}
```

The selected provider remains bound to the session until an explicit switch
or close. Provider failures are returned with their original reason. For an
`ambiguous` selection error, choose from `details.candidate_ids`; for
`provider_unavailable`, follow `message`, `remediation.action`, and the original
reasons in `details.rejections`. For Hopper, Ghidra, IDA, and JADX, run
`oopsware doctor --provider ID --json` to diagnose the selected engine. Other adapters,
such as `pwntools-elf`, report their configuration requirements directly and are
not accepted by `doctor --provider`. See
[task readiness](installation.md#check-readiness-for-your-task) and
[provider selection](mcp-contracts.md#identity-and-discovery).

The session reports work still in progress through `analysis_activity`.
A client timeout can end its wait while the provider continues analyzing.
`cleanup_incomplete` identifies resources whose shutdown or removal could not
be verified. See [MCP contracts](mcp-contracts.md) for session lifecycle and
[Ghidra first-query deadlines](mcp-contracts.md#ghidra-first-query-deadlines-and-recovery)
for import, client timeouts and recovery.

If one-shot analysis fails and closing its session also fails, the original
error details remain inline and `details.cleanup_error` describes the later
close failure. Each diagnostic retains its own reported resources; the later
failure does not establish whether an earlier resource was released. Captured
output and partial observations remain in the original details.

## Save and reuse analysis snapshots

A snapshot retains successful analysis results for later queries. Oopsware reuses
an exact result when the target bytes, operation, parameters, provider and
settings match. Mutations and cursor-dependent calls are excluded from the
cache. Snapshot files are local and use owner-only permissions.

Dispatching a metadata write invalidates the active session's snapshot cache,
even if its reply fails: the provider may already have applied the write.
Close and reopen the target before importing or saving another snapshot.

Snapshots retain eligible target-scoped question histories in full, including
mutation Evidence recorded while another target was active. Observations and
related questions must still belong to the saved target. If those dependencies
cannot be retained, the entire history is excluded instead of reverting the
question to an earlier revision or disposition.

```bash
rea analyze /absolute/path/to/program --provider ghidra --snapshot /absolute/path/to/analysis/program.json
# Repeat the same query to reuse its saved result.
rea analyze /absolute/path/to/program --provider ghidra --snapshot /absolute/path/to/analysis/program.json
```

An exact CLI cache hit is normally read before starting a provider process.
On Windows, Ghidra first admits the selected source through its native snapshot
owner, so replay can start that provider.
In MCP, `open_binary` accepts `snapshot_path` to import a snapshot atomically
for its matching target; an MCP provider may still start before returning a
cached result. `close_binary` accepts `snapshot_path` and optional
`overwrite: true` to save before releasing provider resources. A failed save
leaves the session open so the caller can resolve the output failure.

The MCP save receipt reports `primitive_entries`, `workflow_entries`, and
`evidence_records` separately. Zero primitive bindings can still accompany retained workflow
results and Evidence. These are cached observations, not a saved provider
database: only eligible exact queries can reuse a result, and new or live
queries can still require provider startup. The CLI uses the same snapshot
format and preserves these records when loading and updating it.

## Import, export and compare Evidence

Evidence records retain artifact identity, source locations, observations,
inferences and unresolved findings. Validate an existing bundle, export its
canonical form, or compare two supplied bundles:

```bash
oopsware evidence-import /absolute/path/to/evidence/bundle.json
oopsware evidence-export /absolute/path/to/evidence/bundle.json /absolute/path/to/evidence/canonical.json
rea compare /absolute/path/to/evidence/left.json /absolute/path/to/evidence/right.json
```

Exports preserve an existing destination unless `--overwrite` is explicit.
For application traces and version comparisons, see
[JavaScript application workflows](javascript-application-workflows.md).
MCP [retained Evidence references](mcp-contracts.md#retained-application-evidence-inputs)
belong to one connection. Separate CLI calls consume full saved records.

## Import historical source

Import an older source tree to compare with the current artifact:

```bash
oopsware import-reference-source /absolute/path/to/source
oopsware import-reference-source /absolute/path/to/source --detail summary --outline-depth 2 --json
```

The default (`--detail full`) returns the complete `HistoricalSourceGraph`.
Choose `--detail summary` for a `HistoricalSourceSummary` of that same committed
inventory: its `HistoricalSourceManifest` contains the full graph and root
digests, with provenance, VCS facts, languages, manifest paths, entry and
relationship counts, parse-failure counts, file/directory states, exclusions
and limitations. The summary is a presentation view, not a graph accepted by
source-to-bundle comparison; keep the full output for that workflow.

`--outline-depth` requires `--detail summary` and accepts a nonnegative safe
integer. Depth 1 shows root children, depth 2 (the default) also shows their
children, and depth 0 omits all outline entries. Paths retain canonical Unicode
code-point order. `outline.omitted_entry_count` counts only inventoried entries
hidden by the chosen depth; it does not count unexamined children of excluded or
unreadable directories, or change `inventory_state`. Exclusions and source
limitations remain separate from this presentation omission.

`file_sizes.known_bytes` is the exact sum of known inventoried file sizes as
decimal text, so large sums cannot lose integer precision. Unknown sizes count
in `file_sizes.unknown_file_count`; excluded or unexamined paths are not included
in that total. A zero known-byte sum therefore does not establish an empty source
tree. Full output retains individual file hashes, relationships and parse-failure
diagnostics. Summary mode performs the same import and cleanup, then projects
the committed result without rereading source files. It reduces the selected
output, not the amount of source examined. A shallow tree or many exclusions can
still produce a large summary; depth 0 removes the outline but preserves the
other facts. No fixed output-size or runtime improvement is promised.

The import records hashes and metadata for the supplied files, separately
from observations of the current app. For a directory inside a Git checkout,
it records the HEAD of the nearest enclosing repository; whether the working
tree matches that commit remains unknown. It honors the source tree's `.gitignore`
and applies default exclusions for common generated and dependency paths such
as `node_modules/`, `dist/`, and `*.log`. Pattern-based exclusions record the
matched pattern and whether it came from project, default, caller, or sensitive
path policy. Links into excluded paths retain their internal target metadata;
the exclusion explains why the target has no inventory entry, and the inventory
remains partial. Exclusions record `entry_kind` when the importer observed it;
older saved exclusions without that field have unknown kind. An excluded
ancestor proves an internal descendant only when its kind is `directory`.
Set `REA_REFERENCE_SECRET_PATTERNS_JSON` to a JSON array of ignore
patterns when you want to mark selected paths as sensitive; those patterns are
reported separately as configured-secret exclusions.

Re-import saved graphs whose pattern-based exclusions lack `pattern` before
using them in source-to-bundle comparisons.

Entries that change during an import retain an unavailable-entry diagnostic
alongside readable siblings. If enumeration of an already admitted root fails,
the graph keeps its observed children and records the root failure as a
top-level limitation. That partial inventory does not establish absence among
unexamined children.

JavaScript and TypeScript import parsing requires valid UTF-8. Malformed source
bytes retain their original hashes and sizes with a decoding diagnostic; Oopsware
does not infer module targets from replacement characters.

Historical-source import requires safe no-follow file opens on Linux or
macOS. Native Windows returns `unsupported_host`; use Linux Oopsware inside WSL
or another supported host. See
[source-to-bundle comparison](javascript-application-workflows.md#historical-source-to-bundle-comparison)
for mapping identities, inferences and unknowns.

## Capture runtime behavior

Choose the guide for the target and intended interaction:

- [Browser observation](browser-observation.md): inspect a selected page through CDP.
- [Browser scenarios](browser-scenario-contract.md): run declared interactions and capture their results.
- [Electron observation](electron-observation.md): inspect an Electron renderer or capture an application scenario.
- [Electron fuses](electron-fuses.md): read packaged fuse bytes before expecting `--inspect` to reach an Electron main process.
- [Node/Electron Inspector](javascript-runtime-observation.md): record script locations and execution contexts.
- [Process capture](process-capture.md): run an executable and compare terminal, exit and filesystem observations.

Runtime requests name the target and actions. Launched targets run with your
user permissions; consult the chosen guide for host requirements and effects.

## Serve MCP over streamable HTTP

`rea mcp` speaks stdio to the client that launched it. To serve the same MCP
catalog over streamable HTTP for one local client, such as an agent environment
runtime, start the dispatcher entry with `--http`:

```sh
rea mcp --http --port 8765
```

`--host` and `--port` default to `MCP_HOST` and `MCP_PORT` from the environment,
then to `127.0.0.1` and an ephemeral port. The bound URL is written to stderr as
one JSON log line (`"msg":"MCP transport listening"`) whatever `REA_LOG_LEVEL`
is set to; nothing is written to stdout. `rea mcp --http --help` lists the accepted options. The listener serves
one client at a time: a session ends with the client's `DELETE`, and a client
that connects while another session is open takes it over, so a client that
exited without ending its session needs no restart. The listener runs until
SIGINT or SIGTERM and does not stop when stdin closes. See
[transports](mcp-contracts.md#transports) for the session, `Host` header and
shutdown contract. Client registrations written by setup and the MCP registry
entry keep stdio.

## Serve an environment manifest

`rea environment-serve <manifest.json> --evidence <capture.json> [--host H]
[--port N]` serves an environment manifest projected by `inspect-analysis-view`
as an agent environment: an MCP server at `/mcp` with one tool per manifest
tool, each replaying the retained capture records it cites, the environment
card at `/.well-known/agent-env.json`, and a `/agentenv` data plane that
answers every method with JSON-RPC `-32601`. The manifest's
`parent_evidence_id` must equal the evidence file's `evidence_id`; otherwise
the command refuses with `invalid_request` before binding.

```sh
rea environment-serve manifest.json --evidence capture.json --port 8765
```

`--host` and `--port` resolve like `rea mcp --http`: flags, then `MCP_HOST` and
`MCP_PORT`, then `127.0.0.1` and an ephemeral port. `ENVIRONMENT_NAME` renames
the served environment; set but blank, it is refused as `configuration_invalid`
like a blank `MCP_HOST`. The bound URL is written to stderr as one JSON log line
(`"msg":"MCP transport listening"`). See
[agent environments](agent-environments.md) for what replay returns and does
not establish.

## Export an environment bundle

`rea environment-export <manifest.json> --evidence <capture.json> <dir>
[--package-tarball <path>] [--name <override>]` writes the same manifest and
capture pair as a bundle folder the agentenv framework runs with
`agent-env run <dir>`. It reads each file once, authenticates and cross-checks
the pair with the same checks as `environment-serve`, copies the bytes it
authenticated, refuses to write into a directory that exists and is not empty,
and never overwrites a file.

```sh
rea environment-export manifest.json --evidence capture.json ./grafana-example --json
```

The folder holds a `README.md` with the bundle's provenance, an env folder
`envs/<name>/` with a `Dockerfile` that installs this exact `rea-agents`
version and serves the copied `manifest.json` and `evidence.json` (written
with mode `0600` on POSIX; Windows retains inherited ACLs) with
`environment-serve`, a Python verifier under `artifacts/check_<name>/` and the
smoke task `tasks/smoke.json`. `--package-tarball` copies a packed `rea-agents`
tarball into the env folder and installs it instead of the registry package,
which is how the hosted lane proves a checkout rather than a release. `--name`
replaces the manifest's kebab-case name as the env folder and env id; a device
name Windows reserves (`con`, `nul`, `com1` and the like) is refused. The
command prints one JSON document listing the written files with their sizes
and the pinned package source. See
[agent environments](agent-environments.md#export-a-bundle) for the folder
layout and what the smoke task checks.

## Output and exit status

`rea mcp doctor --json` checks production MCP startup and reports child logs in
`diagnostics`. It drains stderr while retaining at most its first 64 KiB of raw
bytes as text, omitting a final UTF-8 code point if it crosses that byte limit.
`stderr_bytes` counts all observed bytes, including omitted output;
`stderr_truncated` indicates that output exceeded the retention limit. The same
diagnostics appear inside the report when `--full-output` is selected. Log
truncation alone does not change the diagnostic health or exit status.

The default terminal format is TOON. Use `--json` when saving results for a
JSON consumer. Valued output flags (`--format`, `--filter-output`,
`--token-limit`, `--token-offset`) accept `--flag value` or `--flag=value`; a
missing value fails with `MISSING_OUTPUT_VALUE` before the command runs. `--json` is indented on a terminal and compact when piped or
redirected, which keeps large results smaller for agents and scripts; pipe
through `jq .` for indented files. Output selection and formatting do not change
operation status.

`--filter-output` selects fields from successful command data. Classified failures
retain their complete typed diagnostic projection even when the selector matches
a field such as `code` or `message`, or names a missing field. `--full-output`
controls whether the outer `{ok, error, meta}` envelope is included.

For `cutter-command`, `--json-output` requests command-specific JSON from
Cutter when available. This is separate from `--format json`, which selects the
CLI result representation; the global `--json` flag selects that same CLI
representation.

Cutter still accepts deprecated `--json=true` and `--json=false` compatibility
values. When both forms are present, `--json-output` takes precedence in either
argument order. Bare `--json` retains its global meaning of selecting JSON CLI
output formatting.

| Status    | Meaning                                                                                                                                                                                                                                                                                                                                                                                |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`       | The operation completed. Its result may include partial evidence, warnings or unresolved questions.                                                                                                                                                                                                                                                                                    |
| `1`       | The operation could not complete. Structured output identifies invalid input, permissions, cancellation, timeouts or another failure when available.                                                                                                                                                                                                                                   |
| `128 + N` | Signal-derived status. An unhandled signal may have ended the process, with the shell or runtime preserving the conventional status; a command may instead have handled the signal, waited for its operation and cleanup to settle, and assigned the same status (`130` for SIGINT, `143` for SIGTERM). In the handled case, it may also have printed a structured `cancelled` result. |

`rea mcp --http` is long-running and prints no structured result. It exits
`130` on SIGINT or `143` on SIGTERM after closing the listener, the session and
its providers, and `1` when that cleanup fails.

`rea environment-serve` is also long-running: it serves until SIGINT or
SIGTERM, closes the listener, then prints one structured
`{"status":"stopped", …}` document naming the URL, environment and tool count
and exits `130` or `143` through the shared cancellation handler below.
Refusals before binding (unreadable files, non-Evidence JSON, capture Evidence
in a format other than HAR, a manifest whose parent is not the supplied
evidence, an unbindable port) print a structured
error and exit `1`, as does a listener that fails after binding.
`rea environment-export` is one-shot: it prints the written files and exits
`0`, or prints a structured `invalid_request` error and exits `1` for the same
pair refusals, a non-empty or file-occupied directory, a missing package
tarball or a name that is not a kebab-case label or is a Windows device name,
writing nothing in each case.
A write that fails after the first file (a permission or disk-space failure
on a later path) propagates as the host's failure and leaves the partial
folder in place for inspection; remove it before retrying, since the next
attempt refuses the non-empty directory.

A `cancelled` result does not by itself determine the exit status; it depends on
the command's signal handling. Commands routed through the shared
`withCommandCancellation` handler in the CLI set status `130` for SIGINT or
`143` for SIGTERM after their operation settles. Current source registrations
use that handler for process capture and comparison (`capture-process`,
`compare-process-captures`), JavaScript application analysis (`analyze` when it
selects the JavaScript lane, and `analyze-javascript-application`), selected
browser, web and Electron commands (including `analyze-web-bundle`,
`observe-web-execution`, `capture-browser-scenario` and
`capture-electron-scenario`), and the platform and provider command families
for Android/ADB, Apktool/JEB/Flutter, firmware, PCAP and signal analysis,
WASM/EVM, Go/Rust and binary diagnostics, Frida instrumentation, the Cutter
command, objdump, Rizin and GDB, and the agent environment server
(`environment-serve`). In these paths, a returned structured
`cancelled` result can be printed before the wrapper assigns the
signal-derived status. This describes the current source routing; it is not a
claim that every command or provider runtime has been independently exercised.

When the reader of piped output closes early, as `rea ... | head` does, the
CLI stops writing, prints no error and exits `141` (`128 + 13`, the status of a
SIGPIPE-terminated writer). The operation itself may have completed; only its
output was declined.

`inspect-artifact` also returns a structured cancelled result, but its direct
analysis cancellation path does not set a signal-derived exit status, so it
exits `1`. Setup has its own contract: cancellation exits `0`. Treat the
structured result and process status as separate signals when scripting
cancellation.

`setup --dry-run` returns `planned` and exits `0`; a cancelled setup also exits
`0`. Setup returns `1` for `needs_confirmation` or `needs_human`.
`doctor` returns `1` when required checks in its selected readiness scope fail;
unavailable optional providers remain informational for unrelated tasks.

Enable `pipefail` in a supporting shell so a downstream formatter preserves
Oopsware's failure status:

```bash
set -o pipefail
oopsware inspect-artifact ./app.asar --json | jq . > inspection.json
```
