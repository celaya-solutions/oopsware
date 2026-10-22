```text
Document:    JEB instrumentation and analysis
Version:     v1.0.4
Author:      Celaya Solutions
Contact:     hello@celayasolutions.com
Date:        2026-10-22
SHA256:      4bc0d80de38ef7d8ba0a7179e3a0cf6def028760a262485629fb7c3ecefdb3f8
Chain:       solana-mainnet
Tx:          xBtqXanMccZEorYCtsg76xRzMTxAQBTgT8LQDx6Fx1dczcdnvaCK8fyV1HjLFxi26QyqXx6fX8G16jux7UkCF4W
License:     All Rights Reserved / Celaya Solutions
```

# JEB instrumentation and analysis

Oopsware exposes JEB-backed project, unit, and decompilation inspection through the CLI and MCP, served by JEB's own MCP interface. JEB is a bring-your-own engine: Oopsware never installs it, launches it, or opens its project databases itself.

## Bring-your-own engine

Start a JEB client that serves MCP and point Oopsware at it:

- Default endpoint: `http://127.0.0.1:8425/mcp`. Override with `REA_JEB_MCP_URL` (absolute `http`/`https` URL with literal host `127.0.0.1` or `[::1]`; redirects, remote hosts, credentials, query strings, and fragments are rejected rather than silently dropped).
- In the JEB GUI client, start the MCP server from the _File_ menu (or via the VIBRE assistant).
- Headless, the official Linux CE build `5.48.0.202610071539` supports `-c --mcp`. From the JEB installation directory, select JDK 21 or newer through `JAVA_HOME`, choose your target and bind explicitly to loopback:

  ```sh
  "$JAVA_HOME/bin/java" -jar bin/app/jeb.jar -c --mcp --interface=127.0.0.1 \
    --port=8425 --infile=/absolute/path/to/target
  ```

  Complete the vendor's first-use EULA and license-key activation when prompted. The Linux audit used an isolated installation, a 1536 MiB Java heap and one active processor inside a separately bounded process family; JVM heap limits alone do not bound the whole family.

- JEB's documented programmatic route (`JebMcpServerInstance` from the JEB API) remains an alternative. The earlier licensed 5.48 headless verification used that route because its CLI did not accept `--mcp`. Check your installed build's `-c --help` and live tool catalog; the version number alone does not establish the launcher options or supported operations.

For setup registration, set `REA_JEB_MCP_URL` in the REA process environment
before running `rea setup`. The approved setup plan preserves the exact selected
URL after validating its syntax. That validation does not establish that the
JEB service is reachable or that a project is open; use the existing
`inspect-jeb-client` command for a read-only service query.

MCP `binary_session` probes the live JEB service and its advertised tool catalog.
Availability is reported per operation: a reachable headless client can support
inspection and decompilation while refusing `open_jeb_project`. Catalog discovery
uses one 60-second deadline across connection and pagination; a responsive server
cannot keep discovery running indefinitely by returning more pages.

Each upstream tool call has an absolute 60-second request deadline by default.
Set `REA_JEB_MCP_TIMEOUT_MS` to a positive decimal number of milliseconds to
select a different per-request budget, for example `REA_JEB_MCP_TIMEOUT_MS=300000`
for a five-minute decompilation. This budget starts after discovery and applies
to each individual `tools/call`; it does not extend the separate catalog deadline
or establish one end-to-end deadline across a whole CLI or MCP operation. A
request that reaches its budget returns a typed timeout, while caller
cancellation remains a cancellation.

Earlier verification used JEB 5.48.0 (Linux x64, licensed build) serving `jeb-mcp-server` 1.3.0 over streamable HTTP. CE verification does not establish licensed/Demo Android decompilation or GUI
behavior. See the [testing guide](testing.md) for provider verification scope.

## Operations

| MCP tool / CLI command                      | Purpose                                                                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `inspect_jeb_client` / `inspect-jeb-client` | Engine version, GUI or headless mode, startup time                                                                              |
| `open_jeb_project` / `open-jeb-project`     | Open or create a project from an artifact or `.jdb2` on the engine host; returns input-file SHA-256 digests and top-level units |
| `list_jeb_units` / `list-jeb-units`         | Page units by stable path and type (`filter`, `parent-unit-path`, `index`, `count`)                                             |
| `decompile_jeb_item` / `decompile-jeb-item` | Decompile one type or method to engine pseudo-code                                                                              |

All four preserve target-file bytes. `open_jeb_project` selects or creates an engine-side project; analysis queries can populate computed analysis within it. Evidence records the endpoint, caller-selected parameters, and available engine-reported digests. Mutation workflows the engine also offers (renames, comments, `save_project`, `close_project`) are intentionally not exposed yet.

**Engine coverage note:** The earlier licensed 5.48.0 headless verification did not advertise `open_project`; it selected the target when the engine client started. For that build, use `--infile` on the programmatic launcher or open the file in the GUI. The audited CE headless catalog also omitted `open_project`; the verified CLI route above selects its input at startup. Use `binary_session` to inspect the current engine's advertised operations. Oopsware preserves an unavailable tool's refusal; `open_jeb_project` requires an engine that advertises `open_project`. The CE audit does not establish GUI project-opening support.

## Semantics

- Paths in `open_jeb_project` are resolved by the JEB process, not by Oopsware; Oopsware does not require the artifact to exist locally.
- The engine caps `list_units` pages at 100; a full page is reported as `coverage: "partial"` because more units may exist. An empty remainder is `complete` only when fewer units than requested were returned.
- When `decompile_jeb_item` omits `unit_path`, the engine implicitly selects the project's first code unit; Oopsware reports `unit_path: null` and a limitation instead of guessing the effective unit.
- `item_address` is a JEB code-item reference, such as a value returned by the engine's `list_code_items`. Preserve that representation and select its code unit explicitly. For the audited CE SQLite unit, the exported method reference was `sqlite3_libversion_number`; using its raw ELF symbol address did not produce a successful decompilation. File offsets, ELF virtual addresses and engine item references have different semantics. Oopsware currently exposes unit listing, while code-item discovery remains an upstream JEB operation.
- Engine refusals (`success: false` envelopes) are preserved as unsupported-target errors carrying the engine's own message, for example a nonexistent item address.
- Successfully parsed client information is reused for the lifetime of the MCP connection, including when the engine omits its version. Explicit client inspection and availability probes refresh it.
- An unreachable endpoint is a provider-availability failure with recovery guidance; Oopsware does not retry or spawn the engine.

Real-engine verification lives in the JEB lane described in [testing.md](testing.md); mock transport tests do not establish real-engine compatibility.
