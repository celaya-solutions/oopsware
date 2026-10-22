```text
Document:    Electron file-page observation
Version:     v1.0.1
Author:      Celaya Solutions
Contact:     hello@celayasolutions.com
Date:        2026-10-13
SHA256:      88887e6474e51bccb5bc0e783a9e632faf863b2cddf80e93db62b2618dc6c410
Chain:       solana-mainnet
Tx:          3CQEP68nUcT6DegMjoHmMYPTDkyLkSPj5APy4BmLHnrL7vrer9df7o5JZwgA14Kxc7v75hckceqjA9gURZc8zvQb
License:     All Rights Reserved / Celaya Solutions
```

# Electron file-page observation

Oopsware can attach to an Electron/Chromium CDP endpoint and inspect existing `file://` renderer pages without evaluating JavaScript or invoking Electron APIs. The request supplies the endpoint directly; Oopsware accepts only literal-port loopback HTTP endpoints. Selecting an endpoint exposes every Electron target it serves, including local file paths and page metadata.

Disconnecting the inspection's page session can clear caller-owned
`navigator.platform` emulation inside Chromium. REA cannot restore another
client's complete user-agent/client-hint configuration. Use a disposable target
or let the owning client reapply its configuration; see the shared
[CDP state limitation](browser-observation.md#provider-authorities).

This passive runtime surface is distinct from the target-free static
[`analyze_javascript_application`](javascript-artifact-reconstruction.md)
workflow. Static analysis reads a local ASAR or extracted directory without
executing application code. Passive observation inspects an existing Electron
page. The results keep static inferences and runtime observations distinct.
Packaged fuse state is a separate static read:
[`inspect_electron_fuses`](electron-fuses.md) reports whether this binary will
honor Inspector flags, `ELECTRON_RUN_AS_NODE`, embedded ASAR integrity, and
`app.asar`-only loading.
Use the separate
[`reconcile_javascript_runtime`](javascript-runtime-reconciliation.md) workflow
when both Evidence sets already exist.

## Target boundary

The request supplies a literal-port loopback endpoint and, for inspection, a
target ID. Oopsware accepts local hostless `file://` URLs that resolve to regular
files, including pages a packaged application serves from inside `app.asar`.
For those, the first `.asar` path component that is a regular file is the
archive, the remainder must name a regular file in its header, and the reported
path is the canonical archive path joined with that member. Remote hosts,
encoded path separators, ASAR directories or links, and nonexistent paths are
rejected. The endpoint exposes every eligible target and its local path
metadata.

Cancellation stops further file authorization after an already-started filesystem
operation settles. ASAR descriptor-close failures remain typed incomplete cleanup
with an exact retryable owner; they are not treated as a missing or unauthorized
page. A later authorization and provider shutdown retry retained descriptors
before reporting their release.

## Workflow

`list_electron_targets` returns every eligible target served by the supplied endpoint in one inline array.

For the MCP follow-up call, pass the same literal-loopback endpoint and the selected target ID to `inspect_electron_page`. Oopsware rediscovers targets and validates the ID against the live endpoint before inspection.

```bash
oopsware list-electron-targets http://127.0.0.1:9223 --json
oopsware inspect-electron-page http://127.0.0.1:9223 TARGET_ID \
  --observation-ms 100 --json
```

Script content is excluded by default. Setting `include_script_sources` in the
request returns the selected target's script sources:

```bash
oopsware inspect-electron-page http://127.0.0.1:9223 TARGET_ID \
  --include-script-sources \
  --json
```

The normalized result contains canonical local paths, frame and DOM
structure, resource metadata, stable script/resource identities, explicit
completeness, and content-addressed script artifacts. Resource sizes are unknown
when omitted or invalid; supplied invalid sizes also produce an explicit
completeness diagnostic.

DOM node indices retain their snapshot positions. Invalid rows are omitted with
completeness diagnostics, so `total_nodes` can exceed the retained node count
and a parent index can refer to an omitted source node.

Script metadata retains its execution-context frame ID when CDP supplies one. The capture also
inventories worker, service-worker, and shared-worker targets with
validated opener-target and parent-frame IDs. Worker discovery uses passive
target metadata; Oopsware does not attach to or execute code in those targets.
Script-source collection retains at most 32 MiB of UTF-8 text across scripts
and shares a 20-second collection deadline. Omitted sources retain their script
metadata and an explicit reason; later smaller sources may still fit after an
oversized source is omitted. The separate 64 MiB CDP response limit bounds one
wire message before retention admission, rather than total transient memory.
The source budget adds no script-count cap. Like every
target, frame, script, and resource, a worker URL must resolve to a local
file before it is retained. Relationship IDs improve
attribution but do not prove which static module started a worker or that its
work completed.

Inspection does not retain DOM values, execute renderer code, navigate, click,
invoke Electron IPC, close a target, or terminate the application.

## Active Electron scenarios

The scenario request supplies the Electron executable and application entry
point, plus any arguments and actions. The application root defaults to the
entry point's parent directory and can be supplied when the app uses a different
root. Oopsware launches that executable through
the official Playwright Electron API and owns its lifetime. It accepts click/wait actions,
window-targeted renderer reload/crash actions, and synthetic `open-url` or
`second-instance` deep-link delivery. It records capture-scoped window and
WebContents identities, process metrics, and IPC channel and value-shape metadata.
Payload values are not retained.

Run the real fixture verifier with an operator-provided Electron runtime:

```bash
REA_ELECTRON_EXECUTABLE=/absolute/path/to/electron npm run verify:electron
```

This operation actively launches and interacts with the selected target. It is
not a passive CDP observation. The owned process keeps normal host filesystem
and network privileges, so lifecycle ownership does not make it a sandbox.

The CLI and MCP surfaces accept the same schema. For a JSON request file:

```bash
oopsware capture-electron-scenario scenario.json --json
```

The result records action status and targets, correlated app/window/WebContents,
preload, session, navigation, shell, permission, popup, download, protocol,
native-addon, process, and IPC timeline events. IPC channels and argument-shape
metadata retain their observed lengths; payload values are never retained.
Renderer crash/restart and deep-link actions are synthetic
scenario controls; their attempted and observed outcomes remain in the
timeline. The active hook blocks and records external shell/navigation,
permission, download, popup, updater, and OS-integration effects. The timeline
is explicitly partial when attachment starts after application activity. The
startup, including the initial state snapshot, has a 60-second deadline.
Actions wait until completion or request cancellation; a click whose target
never appears, or a `wait` without `window_index` in an app that opens no
window, remains pending until cancelled. After cancellation, the final state
read has 5 seconds before REA keeps the initial snapshot instead; the
cancellation keeps the caller's reason and records that expiry in its
diagnostics.
Blocked synchronous shell APIs keep their return contracts:
`showItemInFolder` returns `undefined` and `writeShortcutLink` returns `false`.
Their `shell-attempt` events record the blocked phase and argument shapes;
neither result means the requested host operation occurred. The existing
`openExternal` and `openPath` blocks continue to reject their promises.
CLI SIGINT/SIGTERM requests cancellation and awaits owned-process cleanup.
Window IDs, URLs, and cached titles come from one main-process Electron snapshot,
so a crashed renderer does not require a successful renderer-side title query.
Window instrumentation uses Electron's window-created event, including runtimes
with a read-only `BrowserWindow` export. Preload configuration comes from the
window's runtime metadata, including Electron's optional internal preload
descriptor when web preferences omit it. This descriptor is verified on
Electron 44.7.0; runtimes that expose neither representation retain an unavailable
path. A configured path or working IPC handler does not prove preload execution.
If cleanup cannot be verified, the error retains collected observations in
`details.partial_observation` and marks their application cleanup `unverified`.
Cleanup uncertainty does not authorize signaling unrelated processes.

Main-process IPC recording keeps original-function removal for `on` and `once`
registrations and records a fired `once` callback once. Native Node.js owns
`once` registration, firing and callable dispatch as well as removal order and
traversal, including listeners registered by removal observers;
the hook translates only its own recording wrappers at the removal boundary.
Wrapper metadata uses weak keys and does not retain removed registrations.
Wrapper metadata operations, private collection methods and traversal constructors are captured
before target startup; later replacement of their global bindings does not
change listener registration or removal.

Native runtimes differ in whether `once` consults callback `.call` or `.apply`.
The hook observes actual callback entry without imposing another runtime's
property reads or argument-list representation. Application methods selected by
native dispatch keep their original receiver and argument-list object; opaque
methods produce a `custom-call` or `custom-apply` observation gap when callback
execution cannot be established.

If native wrapper creation or registration-method lookup could expose private
instrumentation through an application getter, setter or Proxy, registration
stays native and unwrapped. The `once-metadata` observation gap identifies that
unobserved registration attempt; it does not prove registration or delivery. The original callback,
metadata writes and native method receivers are preserved, including when
registration fails. Later registrations resume normal observation. Non-callable
`call`/`apply` properties produce failed observation gaps when native dispatch reads
them; callback entry is not fabricated.

An `on` listener's application-defined `.apply` receives the original argument-list
object unchanged. Borrowing the exposed method preserves its dynamic receiver.
Because that method owns argument interpretation and may not
invoke the callback, the hook records a bounded `ipc-observation-gap` timeline
entry with the registered channel rather than an IPC invocation. Its empty
`argument_shapes` means unobserved arguments, not a zero-argument callback;
callback execution and result remain unknown. Coverage and retention include
these gaps even when their individual records are dropped. Normal native
dispatch continues to record actual invocation frames. Evidence snapshots copy
retained arrays and counters without invoking application iterators or Array
species.

Listener-chain recognition distinguishes owned, unowned and unknown metadata.
Data links may be inherited; absence is established only after completing the
bounded prototype lookup. Exhausting either walk, encountering a getter or seeing a Proxy leaves
ownership unknown. The hook preserves native registration without adding another
recording wrapper and retains a `listener-chain` observation gap after successful
registration. This gap does not prove IPC delivery. An existing inner recording
wrapper can still report its actual invocation; otherwise callback activity
remains unobserved. Setter-only properties have a known undefined read.
Data-descriptor parsing is shared with removal normalization.

This does not establish complete JavaScript function introspection equivalence.
Caller-defined `.listener` properties can change the identity exposed by
`listeners()` and meta-events; accessors and Proxy metadata are not followed for
wrapper recognition. Re-registering a raw recording wrapper on another channel
retains the original registration's channel attribution.
Mutating `.listener` on a raw recording wrapper can also prevent removal through
application decorators that bypass the hook's removal methods. When a removal
request reaches the hook's methods and its registration order is known, private
callback ownership preserves removal by the original function and the newest
matching registration when public metadata is changed or deleted. Native removal
still determines getter execution, exceptions and removal meta-events.

If registration or removal methods differ from the Node methods captured at hook
initialization, the hook leaves listener callbacks unwrapped and records a
`listener-registration` observation gap. The application keeps its original
callback and receiver; callback execution remains unobserved. This comparison
assumes Node's EventEmitter prototype has not itself been globally decorated
before hook initialization. The provider loads the hook before the application
and excludes `NODE_OPTIONS` from the child environment.

An opaque later listener or unsupported emitter state can prevent proof of
removal order. The hook then delegates removal
to the native method and records a `listener-removal` gap rather than claiming
which registration was removed. These gaps are distinct from dropped records
and do not establish IPC delivery or successful removal.

### Target fuse prerequisites

Active scenario capture requires that the target Electron executable honors Node CLI inspector flags (`--inspect` or `--remote-debugging-port`) so that Playwright can establish its DevTools protocol session.

When an Electron executable explicitly disables the `EnableNodeCliInspectArguments` fuse (or removes the capability), `capture-electron-scenario` fails immediately before process launch with an `AnalysisUnsupportedTargetError` ("unsupported_target") rather than waiting for the startup deadline. For targets with disabled inspector fuses, use passive CDP inspection via `inspect_electron_page` or run against an unrestricted development binary with the extracted `app.asar`.

The real verifier exercises compiled CLI and stdio MCP discovery, page/script
inspection, static/runtime reconciliation, active observation, and CLI SIGTERM
cleanup before checking the IPC, renderer crash/reload, utility/child-process,
deep-link, and blocked-effect fixture. A cleanup error keeps the full lane failed
even when the retained capture contains useful observations.

Active Electron Evidence can also be supplied to
[`reconcile_javascript_runtime`](javascript-runtime-reconciliation.md). That
projection is intentionally target-only and partial: it binds the selected
application path and capture outcome to the static graph, while frames, scripts,
workers, and execution claims remain unavailable until a separate passive runtime
capture provides them.

ASAR observation reads the header through one open file handle, validates its declared lengths against the archive size, and limits encoded JSON headers to 16 MiB before parsing. The header cache also retains at most 16 MiB of encoded headers across eight archives. Oversized headers produce a scope refusal.
