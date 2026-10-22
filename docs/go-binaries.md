```text
Document:    Go binary build metadata
Version:     v1.0.2
Author:      Celaya Solutions
Contact:     hello@celayasolutions.com
Date:        2026-10-22
SHA256:      eb94a6412a83412226032597d7de47afada42c33109a53e226b979d0a166e7c2
Chain:       solana-mainnet
Tx:          3ng9nto5c72LytNeNbwVS9oEBRF6DXhJtGuwm897n8NTU4ju1qJVdfxrZHLvzFocPB3YoiP7KUvCdCG9cgZTBLgJ
License:     All Rights Reserved / Celaya Solutions
```

# Go binary build metadata

`inspect_go_binary` / `inspect-go-binary` answers which Go compiler version,
modules, replacements and build settings are embedded in one selected local
executable or library. It reads the file without running it and requires no
Go installation, active binary target, Hopper, Ghidra or IDA.

```bash
rea inspect-go-binary /absolute/path/to/application --json
```

The CLI resolves relative paths against the caller's working directory. MCP
requires an absolute filesystem path and preserves that exact selection:

```json
{
  "name": "inspect_go_binary",
  "arguments": { "path": "/artifacts/application" }
}
```

For build identity and counts, select `detail: "summary"`. MCP retains the same
complete Evidence and returns `normalized_result.parent_evidence_id`. Read
selected dependency versions without reopening the file:

```json
{
  "name": "inspect_analysis_view",
  "arguments": {
    "source": {
      "kind": "retained-evidence",
      "evidence_id": "ev_<parent digest>"
    },
    "view": {
      "kind": "go",
      "collection": "dependencies",
      "paths": ["golang.org/x/crypto"],
      "fields": ["path", "version", "replacement"],
      "offset": 0,
      "limit": 10
    }
  }
}
```

Go views support `dependencies` (exact `paths`) and `settings` (exact `keys`),
optional original `indices`, field selection, and pagination. Filters intersect;
empty filter arrays select no rows and `fields: []` returns only row identity.
Each row keeps its original `index`, scoped to the parent Evidence and collection;
duplicate module paths and setting keys keep distinct indices. Page offsets
count matching records. Exhausting retained rows does not establish complete
runtime dependencies. Original bytes, unknown lines and all complete metadata
remain in the parent and can be exported as an Evidence bundle.

One-shot CLI summaries save complete Evidence before returning the projection:

```bash
rea inspect-go-binary ./application --detail summary --evidence_output ./go-evidence.json --json
```

`--evidence_output` is required for CLI summary delivery and never overwrites an
existing file. The default CLI/MCP reply remains complete.

Choose complete delivery when the first question needs multiple facts. Retained
views support later selected reads without repeating the inspection. Include
catalog discovery and extra calls when measuring the cost of either workflow.

## Observations

The inline Evidence result contains the artifact path, SHA-256, byte length,
container format, architecture, word size and byte order. A recognized
`build_info` record contains:

- `go_version`, preserved as embedded UTF-8 text rather than forced into a
  semantic version, or `null` when the embedded bytes are not UTF-8;
- `go_version_bytes_base64`, preserving the exact compiler-string bytes;
- exact file offsets and byte lengths for the header, compiler string and module
  string;
- `module_text`, the decoded module-information body, or `null` when the complete
  body cannot be represented as UTF-8;
- `module_bytes_base64`, the original module-string bytes including Go framing;
- `module.path`, the embedded package path;
- `module.main`, the main module's path, version, checksum and optional
  replacement;
- `module.dependencies`, with the same fields and their original order;
- `module.settings`, retaining ordered key/value entries and duplicate keys;
- `module.unparsed_lines`, `module.unparsed_line_bytes_base64` and
  `module.complete`, which says whether every present module-text line was
  parsed. It does not establish that the dependency inventory is complete.

Missing checksums are `null`; empty fields and development/local replacement
versions remain unchanged. Build settings such as `GOOS`, `GOARCH` or `vcs.revision`
are reported when present. Their absence does not establish a build choice.
Go strings may contain arbitrary bytes. Non-UTF-8 records remain available as
base64 while other decodable module records are still reported; the reader does
not insert replacement characters or reject the entire artifact for those
strings.

When no main-module (`mod`) record was decoded, `module.main` is `null` and
dependency coverage is unknown. Successfully decoded dependency records remain
visible. GOPATH-mode builds may contain only a package `path` and build settings;
their empty dependency array does not establish the absence of dependencies.
The result's limitations state this explicitly. A module-mode build with a main
module record and no dependency records has an observed empty dependency list.

## Supported boundary

The built-in TypeScript reader supports ELF, PE and thin Mach-O images with Go's
inline or historical pointer build-info encoding. Source ranges refer to the
original stable file snapshot, including pointer-backed strings. It does not
scan arbitrary byte strings as compiler metadata or interpret a fat Mach-O
container as one selected architecture.

For ELF images without a named build-info section, discovery checks each
nonempty writable, non-executable load segment in program-header order. This
includes sectionless PIE images with metadata in a later data segment. Named
sections retain priority, and alignment, file mapping and record validation
remain required.

Historical moduleless Go binaries can store their empty module-string header in
declared zero-initialized virtual memory rather than file-backed bytes. The reader
recognizes this only when the complete optional module header lies in that memory
without a conflicting file mapping. Its module contents are empty and
`module_location` has zero bytes, anchored at the build-info field containing the
module-header pointer. Compiler strings and other unmapped pointers remain strict
file-backed reads.

`build_info: null` means no recognized record was found in the inspected image.
It does not prove that the binary is not Go. Stripping, old builds, deliberate
removal and obfuscation can limit metadata. A malformed supported container or
recognized build-info record returns an input-format failure. Unsupported
containers receive a separate unsupported-target failure.

Symlinks and nonregular files are rejected. The shared stable reader detects
replacement and observed in-place changes during acquisition. Missing files,
host permission denial, changed artifacts and cancellation retain distinct
errors. The selected file is never modified; this inspection creates no
temporary files, starts no subprocesses and accesses no network endpoint.

An input above 256 MiB returns `resource_constraint` with resource `file-size`
and `reported_limits.maximum_input_bytes`. Select a suitable input within that
fixed allowance; changing an output-write or transport budget does not admit it.

Resource guards bound the selected file and cumulative header searches to 256 MiB
each, aggregate embedded strings
to 1 MiB, structural table decoding to 16 MiB and the complete normalized metadata
report to 8 MiB. Identical search spans with the same virtual alignment are
searched once; partially overlapping spans consume the cumulative search budget
and fail with a CPU resource constraint when it is exhausted. Oversized results
fail without partial success. MCP also applies
its [response transport budget](mcp-contracts.md), which counts both text and
structured content; a report within the metadata limit can still require export
from retained Evidence. These limits are not operating-system memory or CPU
isolation.

Embedded metadata is evidence of file content. It does not authenticate a
compiler, dependency, commit or supply chain, and it does not establish runtime
behavior. Function names, source mappings, types and decompiled code are outside
this tool's coverage. Use the [native workflow](native-investigation.md) when
those questions require a disassembler.

## Real producer verification

`npm run verify:go:binary` exercises compiler-built fixtures through the public
CLI and MCP, comparing their metadata with Go's standard `debug/buildinfo`
reader. The verification lane requires Go; normal inspection does not.
